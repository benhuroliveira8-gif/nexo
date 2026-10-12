const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('Defina JWT_SECRET (pelo menos 16 caracteres) no arquivo .env');
  process.exit(1);
}

const hashPassword = (password) => bcrypt.hash(password, 10);
const checkPassword = (password, hash) => bcrypt.compare(password, hash);

// O token de login leva a "versão" da conta: trocar a senha ou "sair de todos os
// aparelhos" aumenta a versão, e os tokens antigos param de valer.
const signToken = (user) =>
  jwt.sign({ sub: user.id, ver: Number(user.token_version) || 0 }, JWT_SECRET, { expiresIn: '7d' });

// Devolve { userId, ver }, ou null se o token for inválido/expirado.
// Tokens com "purpose" são de uso especial (ex.: etapa do 2FA) e não servem para login.
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose) return null;
    const userId = Number(payload.sub) || null;
    return userId ? { userId, ver: Number(payload.ver) || 0 } : null;
  } catch {
    return null;
  }
}

// Ticket curto (5 min) entre "senha certa" e "código do 2FA".
const signTicket = (userId, purpose) => jwt.sign({ sub: userId, purpose }, JWT_SECRET, { expiresIn: '5m' });
function verifyTicket(token, purpose) {
  try {
    const payload = jwt.verify(String(token || ''), JWT_SECRET);
    return payload.purpose === purpose ? Number(payload.sub) || null : null;
  } catch {
    return null;
  }
}

// ---------- Tokens de bot
// Formato: nexo.<id do bot>.<parte aleatória>. No banco guardamos só o hash.
const hashBotToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newBotToken = (botId) => `nexo.${botId}.${crypto.randomBytes(24).toString('base64url')}`;

// Aceita "Bearer <jwt>" (pessoas) ou "Bot <token>" (bots).
// Devolve { userId, isBot } ou null.
async function authenticate(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('Bot ')) {
    const token = raw.slice(4).trim();
    if (!/^nexo\.\d+\.[\w-]{20,}$/.test(token)) return null;
    const { rows } = await db.query(
      'SELECT id FROM users WHERE bot_token_hash = $1 AND is_bot AND blocked_at IS NULL',
      [hashBotToken(token)],
    );
    return rows[0] ? { userId: rows[0].id, isBot: true } : null;
  }
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  const t = token && verifyToken(token);
  if (!t) return null;
  const { rows } = await db.query('SELECT token_version FROM users WHERE id = $1 AND NOT is_bot AND blocked_at IS NULL', [t.userId]);
  if (!rows[0] || Number(rows[0].token_version) !== t.ver) return null;
  return { userId: t.userId, isBot: false };
}

// Middleware do Express: exige login (pessoa ou bot).
function requireAuth(req, res, next) {
  authenticate(req.headers.authorization)
    .then((who) => {
      if (!who) return res.status(401).json({ error: 'Faça login para continuar.' });
      req.userId = who.userId;
      req.isBot = who.isBot;
      next();
    })
    .catch(next);
}

// Middleware: só pessoas (bots não criam servidores, não têm amigos etc.).
function humansOnly(req, res, next) {
  if (req.isBot) return res.status(403).json({ error: 'Bots não podem usar essa função.' });
  next();
}

module.exports = {
  hashPassword, checkPassword, signToken, verifyToken, signTicket, verifyTicket,
  hashBotToken, newBotToken, authenticate, requireAuth, humansOnly,
};
