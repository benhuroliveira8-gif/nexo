const db = require('../db');
const auth = require('../auth');
const S = require('../serializers');
const events = require('../events');
const files = require('../files');
const presence = require('../presence');
const { wrap, fail } = require('./util');

const USER_COLS = 'id, username, display_name, is_bot, avatar_id, status, status_text';

// Código de convite para criar conta (opcional). Útil quando o Nexo fica
// aberto na internet: sem o código, ninguém de fora consegue se cadastrar.
const REGISTRATION_CODE = String(process.env.REGISTRATION_CODE || '').trim();

// Proteção contra quem tenta adivinhar senha: 10 erros em 15 min por IP+usuário.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // chave -> [timestamps]

function clientIp(req) {
  return String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}
function recentFails(key) {
  const now = Date.now();
  const list = (loginFails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFails.set(key, list); else loginFails.delete(key);
  return list;
}
setInterval(() => { for (const k of [...loginFails.keys()]) recentFails(k); }, 5 * 60 * 1000).unref();

// Nome, foto ou status mudou: todo mundo que vê essa pessoa precisa atualizar.
async function profileChanged(userId) {
  const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [userId]);
  servers.rows.forEach((s) => events.serverChanged(s.server_id));
  events.friendsChanged(userId, ...(await events.friendIdsOf(userId)));
  events.presenceChanged(userId);
}
files.onAvatarChanged((userId) => profileChanged(userId).catch(() => {}));

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
const RESERVED = new Set(['everyone', 'here']);

function cleanDisplayName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length > 32) fail(400, 'Nome de exibição pode ter no máximo 32 caracteres.');
  return name || fallback;
}

// Rotas públicas (sem login).
function publicRoutes(r) {
  r.get('/config', (req, res) => res.json({ registrationRequiresCode: !!REGISTRATION_CODE }));

  r.post('/auth/register', wrap(async (req, res) => {
    if (REGISTRATION_CODE && String(req.body.inviteCode || '').trim() !== REGISTRATION_CODE) {
      fail(403, 'Código de cadastro incorreto. Peça o código para quem administra o Nexo.');
    }
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!USERNAME_RE.test(username) || RESERVED.has(username)) {
      fail(400, 'Usuário deve ter 3 a 32 caracteres: letras minúsculas, números, _ ou .');
    }
    const displayName = cleanDisplayName(req.body.displayName, username);
    if (password.length < 6 || password.length > 128) fail(400, 'A senha precisa ter entre 6 e 128 caracteres.');

    try {
      const hash = await auth.hashPassword(password);
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username, display_name, is_bot, avatar_id, status, status_text`,
        [username, displayName, hash],
      );
      res.status(201).json({ token: auth.signToken(rows[0]), user: S.me(rows[0]) });
    } catch (err) {
      if (err.code === '23505') fail(409, 'Esse nome de usuário já existe.');
      throw err;
    }
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = `${clientIp(req)}|${username}`;
    if (recentFails(key).length >= LOGIN_MAX_FAILS) {
      fail(429, 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.');
    }
    const { rows } = await db.query(
      `SELECT ${USER_COLS}, password_hash FROM users WHERE username = $1 AND NOT is_bot`,
      [username],
    );
    const user = rows[0];
    if (!user || !(await auth.checkPassword(password, user.password_hash))) {
      loginFails.set(key, [...recentFails(key), Date.now()]);
      fail(401, 'Usuário ou senha incorretos.');
    }
    loginFails.delete(key);
    res.json({ token: auth.signToken(user), user: S.me(user) });
  }));
}

// Rotas do usuário logado.
function meRoutes(r) {
  r.get('/me', wrap(async (req, res) => {
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.userId]);
    if (!rows[0]) fail(401, 'Usuário não encontrado.');
    res.json({ user: S.me(rows[0]) });
  }));

  // Trocar nome de exibição, status (online/ausente/não perturbe/invisível)
  // e o texto do status ("Jogando Minecraft"). Só muda o que vier no corpo.
  r.patch('/me', wrap(async (req, res) => {
    const { rows: cur } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.userId]);
    const u = cur[0];
    if (!u) fail(401, 'Usuário não encontrado.');
    const b = req.body || {};
    const displayName = b.displayName !== undefined ? cleanDisplayName(b.displayName, u.username) : u.display_name;
    let status = u.status;
    if (b.status !== undefined) {
      if (!presence.STATUSES.includes(b.status)) fail(400, 'Status inválido.');
      status = b.status;
    }
    let statusText = u.status_text;
    if (b.statusText !== undefined) {
      statusText = String(b.statusText || '').replace(/\s+/g, ' ').trim();
      if (statusText.length > 80) fail(400, 'O texto do status pode ter no máximo 80 caracteres.');
      statusText = statusText || null;
    }
    const { rows } = await db.query(
      `UPDATE users SET display_name = $2, status = $3, status_text = $4 WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, displayName, status, statusText],
    );
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));

  r.delete('/me/avatar', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE users u SET avatar_id = NULL FROM users old WHERE u.id = $1 AND old.id = u.id
       RETURNING old.avatar_id AS previous, u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text`,
      [req.userId],
    );
    if (rows[0]?.previous) files.removeAvatar(rows[0].previous);
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));
}

module.exports = { publicRoutes, meRoutes, profileChanged };
