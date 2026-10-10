const db = require('../db');
const auth = require('../auth');
const S = require('../serializers');
const events = require('../events');
const { wrap, fail } = require('./util');

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
const RESERVED = new Set(['everyone', 'here']);

function cleanDisplayName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length > 32) fail(400, 'Nome de exibição pode ter no máximo 32 caracteres.');
  return name || fallback;
}

// Rotas públicas (sem login).
function publicRoutes(r) {
  r.post('/auth/register', wrap(async (req, res) => {
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
         VALUES ($1, $2, $3) RETURNING id, username, display_name, is_bot`,
        [username, displayName, hash],
      );
      res.status(201).json({ token: auth.signToken(rows[0]), user: S.user(rows[0]) });
    } catch (err) {
      if (err.code === '23505') fail(409, 'Esse nome de usuário já existe.');
      throw err;
    }
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await db.query(
      'SELECT id, username, display_name, password_hash FROM users WHERE username = $1 AND NOT is_bot',
      [username],
    );
    const user = rows[0];
    if (!user || !(await auth.checkPassword(password, user.password_hash))) {
      fail(401, 'Usuário ou senha incorretos.');
    }
    res.json({ token: auth.signToken(user), user: S.user(user) });
  }));
}

// Rotas do usuário logado.
function meRoutes(r) {
  r.get('/me', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT id, username, display_name, is_bot FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) fail(401, 'Usuário não encontrado.');
    res.json({ user: S.user(rows[0]) });
  }));

  // Trocar o nome de exibição.
  r.patch('/me', wrap(async (req, res) => {
    const { rows: cur } = await db.query('SELECT username FROM users WHERE id = $1', [req.userId]);
    const displayName = cleanDisplayName(req.body.displayName, cur[0].username);
    const { rows } = await db.query(
      'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, username, display_name, is_bot',
      [req.userId, displayName],
    );
    const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [req.userId]);
    servers.rows.forEach((s) => events.serverChanged(s.server_id));
    events.friendsChanged(req.userId, ...(await events.friendIdsOf(req.userId)));
    res.json({ user: S.user(rows[0]) });
  }));
}

module.exports = { publicRoutes, meRoutes };
