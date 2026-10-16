const express = require('express');
const auth = require('../auth');
const files = require('../files');
const authRoutes = require('./auth');
const serverRoutes = require('./servers');
const messageRoutes = require('./messages');
const socialRoutes = require('./social');
const botRoutes = require('./bots');
const voiceRoutes = require('./voice');
const eventRoutes = require('./events');
const extraRoutes = require('./extras');
const communityRoutes = require('./community');
const adminRoutes = require('./admin');
const extras3Routes = require('./extras3');
const extras4Routes = require('./extras4');
const extras5Routes = require('./extras5');
const { wrap } = require('./util');
const assets = require('../assets');

// Corpo em texto puro (para webhooks: curl -d "mensagem"), até 64 KB.
function readText(req, res, next) {
  if (!/^text\//i.test(String(req.headers['content-type'] || '')) || typeof req.body === 'string') return next();
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { req.body = Buffer.concat(chunks).toString('utf8'); next(); });
  req.on('error', next);
}

// Monta toda a API em /api.
module.exports = function buildApi() {
  const r = express.Router();

  // Upload vem antes do express.json (o corpo é o arquivo cru).
  r.use(files.uploadRouter(auth.requireAuth));
  r.use(assets.uploadRouter(auth.requireAuth));
  r.use(express.json({ limit: '64kb' }));

  authRoutes.publicRoutes(r);
  // Webhook: outros sistemas postam num canal com o link secreto (JSON ou texto puro).
  r.post('/webhooks/:webhookId/:token', readText, wrap(extras5Routes.receiveWebhook));

  r.use(auth.requireAuth); // tudo abaixo exige login
  authRoutes.meRoutes(r);
  serverRoutes(r);
  messageRoutes(r);
  socialRoutes(r);
  botRoutes(r);
  voiceRoutes(r);
  eventRoutes(r);
  extraRoutes(r);
  communityRoutes(r);
  adminRoutes(r);
  extras3Routes(r);
  extras4Routes(r);
  extras5Routes(r);

  r.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  return r;
};
