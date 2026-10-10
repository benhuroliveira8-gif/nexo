const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const presence = require('./presence');
const S = require('./serializers');

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
const PAGE_SIZE = 50;

const newInviteCode = () => crypto.randomBytes(6).toString('base64url'); // 8 caracteres

// Nome de canal no estilo "meu-canal": minúsculo, sem espaços.
function normalizeChannelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

// IDs da URL precisam ser inteiros positivos; senão devolve null.
function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

// Envolve handlers async para que erros caiam no tratador de erros do Express.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function isMember(serverId, userId) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
    [serverId, userId],
  );
  return rowCount > 0;
}

module.exports = function buildRoutes(io) {
  const r = express.Router();

  // ---------- Autenticação ----------

  r.post('/auth/register', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const displayName = String(req.body.displayName || '').trim() || username;
    const password = String(req.body.password || '');

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Usuário deve ter 3 a 32 caracteres: letras minúsculas, números, _ ou .' });
    }
    if (displayName.length > 32) {
      return res.status(400).json({ error: 'Nome de exibição pode ter no máximo 32 caracteres.' });
    }
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: 'A senha precisa ter entre 6 e 128 caracteres.' });
    }

    try {
      const hash = await auth.hashPassword(password);
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username, display_name`,
        [username, displayName, hash],
      );
      const user = rows[0];
      res.status(201).json({ token: auth.signToken(user), user: S.user(user) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Esse nome de usuário já existe.' });
      throw err;
    }
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await db.query(
      'SELECT id, username, display_name, password_hash FROM users WHERE username = $1',
      [username],
    );
    const user = rows[0];
    if (!user || !(await auth.checkPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    res.json({ token: auth.signToken(user), user: S.user(user) });
  }));

  // Tudo abaixo exige login.
  r.use(auth.requireAuth);

  r.get('/me', wrap(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [req.userId],
    );
    if (!rows[0]) return res.status(401).json({ error: 'Usuário não encontrado.' });
    res.json({ user: S.user(rows[0]) });
  }));

  // ---------- Servidores ----------

  r.get('/servers', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.* FROM servers s
       JOIN server_members m ON m.server_id = s.id
       WHERE m.user_id = $1
       ORDER BY m.joined_at`,
      [req.userId],
    );
    res.json({ servers: rows.map(S.server) });
  }));

  r.post('/servers', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Dê um nome ao servidor.' });

    const server = await db.transaction(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO servers (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING *',
        [name, req.userId, newInviteCode()],
      );
      const s = rows[0];
      await c.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [s.id, req.userId]);
      await c.query("INSERT INTO channels (server_id, name, position) VALUES ($1, 'geral', 0)", [s.id]);
      return s;
    });

    // Coloca as conexões abertas do usuário na "sala" do novo servidor.
    io.in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);
    res.status(201).json({ server: S.server(server) });
  }));

  r.post('/servers/join', wrap(async (req, res) => {
    // Aceita o código puro ou um link que termine com o código.
    const raw = String(req.body.code || '').trim();
    const code = raw.split('/').filter(Boolean).pop() || '';
    const { rows } = await db.query('SELECT * FROM servers WHERE invite_code = $1', [code]);
    const server = rows[0];
    if (!server) return res.status(404).json({ error: 'Convite inválido.' });

    const inserted = await db.query(
      `INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [server.id, req.userId],
    );

    io.in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);

    if (inserted.rowCount > 0) {
      const u = await db.query('SELECT id, username, display_name FROM users WHERE id = $1', [req.userId]);
      io.to(`server:${server.id}`).emit('member:joined', {
        serverId: server.id,
        member: { ...S.user(u.rows[0]), online: presence.isOnline(req.userId) },
      });
    }
    res.json({ server: S.server(server) });
  }));

  // Detalhes de um servidor: canais + membros (com status online).
  r.get('/servers/:id', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    if (!serverId) return res.status(404).json({ error: 'Servidor não encontrado.' });
    if (!(await isMember(serverId, req.userId))) {
      return res.status(404).json({ error: 'Servidor não encontrado.' });
    }
    const [server, channels, members] = await Promise.all([
      db.query('SELECT * FROM servers WHERE id = $1', [serverId]),
      db.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY position, id', [serverId]),
      db.query(
        `SELECT u.id, u.username, u.display_name FROM users u
         JOIN server_members m ON m.user_id = u.id
         WHERE m.server_id = $1
         ORDER BY lower(u.display_name)`,
        [serverId],
      ),
    ]);
    res.json({
      server: S.server(server.rows[0]),
      channels: channels.rows.map(S.channel),
      members: members.rows.map((m) => ({ ...S.user(m), online: presence.isOnline(m.id) })),
    });
  }));

  // ---------- Canais ----------

  r.post('/servers/:id/channels', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    if (!serverId) return res.status(404).json({ error: 'Servidor não encontrado.' });
    const { rows } = await db.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
    if (!rows[0] || !(await isMember(serverId, req.userId))) {
      return res.status(404).json({ error: 'Servidor não encontrado.' });
    }
    if (rows[0].owner_id !== req.userId) {
      return res.status(403).json({ error: 'Só o dono do servidor pode criar canais (por enquanto).' });
    }
    const name = normalizeChannelName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Dê um nome ao canal.' });

    const created = await db.query(
      `INSERT INTO channels (server_id, name, position)
       VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE server_id = $1))
       RETURNING *`,
      [serverId, name],
    );
    const channel = S.channel(created.rows[0]);
    io.to(`server:${serverId}`).emit('channel:created', channel);
    res.status(201).json({ channel });
  }));

  // Histórico: 50 mensagens por vez, das mais novas para trás (?before=<id>).
  r.get('/channels/:id/messages', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    if (!channelId) return res.status(404).json({ error: 'Canal não encontrado.' });
    const { rows: ch } = await db.query(
      `SELECT c.server_id FROM channels c
       JOIN server_members m ON m.server_id = c.server_id AND m.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.userId],
    );
    if (!ch[0]) return res.status(404).json({ error: 'Canal não encontrado.' });

    const before = /^\d+$/.test(String(req.query.before || '')) ? req.query.before : null;
    const { rows } = await db.query(
      `SELECT msg.*, u.username AS author_username, u.display_name AS author_display_name
       FROM messages msg
       LEFT JOIN users u ON u.id = msg.author_id
       WHERE msg.channel_id = $1 AND ($2::bigint IS NULL OR msg.id < $2::bigint)
       ORDER BY msg.id DESC
       LIMIT $3`,
      [channelId, before, PAGE_SIZE],
    );
    res.json({
      messages: rows.reverse().map((m) => S.message(m, ch[0].server_id)),
      hasMore: rows.length === PAGE_SIZE,
    });
  }));

  return r;
};
