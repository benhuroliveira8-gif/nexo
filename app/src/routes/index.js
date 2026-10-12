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
const assets = require('../assets');

// Monta toda a API em /api.
module.exports = function buildApi() {
  const r = express.Router();

  // Upload vem antes do express.json (o corpo é o arquivo cru).
  r.use(files.uploadRouter(auth.requireAuth));
  r.use(assets.uploadRouter(auth.requireAuth));
  r.use(express.json({ limit: '64kb' }));

  authRoutes.publicRoutes(r);

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

  r.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  return r;
};
