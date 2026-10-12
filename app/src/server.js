const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');
const files = require('./files');
const events = require('./events');
const buildApi = require('./routes');
const previews = require('./linkpreview');
const emojis = require('./emojis');
const setupRealtime = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
events.setIo(io);

app.disable('x-powered-by');

// Saúde do app: responde 200 só se o banco também estiver respondendo.
// Usado pelo Docker, pelo Jenkins e por monitores externos (ex.: UptimeRobot).
app.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tempo esgotado')), 3000)),
    ]);
    res.json({ ok: true, db: 'ok', uptime: Math.round(process.uptime()), version: require('../package.json').version });
  } catch (err) {
    res.status(503).json({ ok: false, db: err.message });
  }
});
app.use('/api', buildApi());

// Anexos (imagens, vídeos, arquivos).
app.get('/files/:id', files.serveFile);
app.get('/files/:id/:name', files.serveFile);
app.get('/avatars/:file', files.serveAvatar);
app.get('/emoji/:id', emojis.serve);
app.get('/sticker/:id', require('./assets').serve('sticker'));
app.get('/sound/:id', require('./assets').serve('sound'));
// Imagens das prévias de link (passam pelo Nexo; o endereço é assinado).
app.get('/link-image/:sig/:data', previews.serveImage);

// App instalável (PWA): o "service worker" precisa vir da raiz e nunca ficar velho no cache.
app.get('/sw.js', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  res.type('text/javascript');
  res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});

// Biblioteca de voz/vídeo do navegador (livekit-client), servida daqui mesmo.
function findLivekitClient() {
  const dirs = [];
  try { dirs.push(path.dirname(require.resolve('livekit-client/package.json'))); } catch { /* "exports" pode bloquear */ }
  dirs.push(path.join(__dirname, '..', 'node_modules', 'livekit-client'));
  for (const dir of dirs) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const candidates = ['dist/livekit-client.umd.js', pkg.unpkg, pkg.jsdelivr, pkg.main].filter(Boolean);
    for (const rel of candidates) {
      const file = path.join(dir, rel);
      if (/\.c?js$/.test(file) && fs.existsSync(file)) return file;
    }
  }
  return null;
}
const livekitClientFile = findLivekitClient();
if (!livekitClientFile) console.warn('Aviso: livekit-client não encontrado; a voz não vai funcionar no navegador.');
app.get('/vendor/livekit-client.js', (req, res) => {
  if (!livekitClientFile) return res.status(404).type('text/plain').send('livekit-client não instalado');
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('text/javascript');
  res.sendFile(livekitClientFile);
});

// Frontend (arquivos estáticos). Qualquer outra rota devolve o index.html
// (assim links como /convite/abc123 funcionam).
const publicDir = path.join(__dirname, '..', 'public');
// Compartilhar foto da galeria direto para o Nexo (app instalado): quem recebe é o
// service worker. Se ele ainda não estiver ativo, o pedido chega aqui e só volta para o app.
app.post('/compartilhar', (req, res) => res.redirect(303, '/?compartilhar=falhou'));

app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Erros: os "esperados" (validação, permissão...) viram a mensagem certa; o resto vira 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Arquivo grande demais (máximo ${Math.round(files.MAX_SIZE / 1024 / 1024)} MB).` });
  }
  if (err.expose && err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

setupRealtime(io);

db.init()
  .then(() => {
    files.startCleanup();
    previews.startCleanup();
    require('./routes/events').startReminders();
    require('./routes/extras').startJobs();
    require('./admin').startStorageJobs();
    require('./admin').syncEnvAdmins().catch(() => {});
    require('./lastfm').startLastfm();
    require('./health').startRun().catch((err) => console.error('Erro no registro de execução:', err.message));
    server.listen(PORT, () => console.log(`Nexo rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error('Falha ao preparar o banco de dados:', err);
    process.exit(1);
  });

// Atualização sem susto: o Jenkins manda o sinal SIGUSR2 uns segundos antes de trocar o app.
// Todo mundo vê "o Nexo vai atualizar em 20 s" e depois volta sozinho (inclusive na chamada).
process.on('SIGUSR2', () => {
  const seconds = Math.min(120, Math.max(5, Number(process.env.RESTART_NOTICE_S) || 20));
  console.log(`Aviso de atualização enviado (${seconds} s).`);
  events.announceRestart(seconds);
});

// Desliga com calma quando o Docker manda parar.
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  events.announceRestart(0);
  setTimeout(async () => {
    await require('./health').stopRun();
    io.close();
    server.close(() => db.pool.end().then(() => process.exit(0)));
  }, 600);
  setTimeout(() => process.exit(0), 5000).unref();
});
