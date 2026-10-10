const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');
const files = require('./files');
const events = require('./events');
const buildApi = require('./routes');
const setupRealtime = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
events.setIo(io);

app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', buildApi());

// Anexos (imagens, vídeos, arquivos).
app.get('/files/:id', files.serveFile);
app.get('/files/:id/:name', files.serveFile);

// Frontend (arquivos estáticos). Qualquer outra rota devolve o index.html
// (assim links como /convite/abc123 funcionam).
const publicDir = path.join(__dirname, '..', 'public');
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
    server.listen(PORT, () => console.log(`Nexo rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error('Falha ao preparar o banco de dados:', err);
    process.exit(1);
  });

// Desliga com calma quando o Docker manda parar.
process.on('SIGTERM', () => {
  io.close();
  server.close(() => db.pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
});
