const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');
const buildRoutes = require('./routes');
const setupRealtime = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', buildRoutes(io));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Frontend (arquivos estáticos). Qualquer outra rota devolve o index.html.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Erros não tratados viram 500 com mensagem genérica.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

setupRealtime(io);

db.init()
  .then(() => {
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
});
