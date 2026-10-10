// Contas de bot: criar, listar, gerar token novo e apagar.
// Cada pessoa gerencia os próprios bots. O token aparece só uma vez.
const db = require('../db');
const S = require('../serializers');
const auth = require('../auth');
const events = require('../events');
const { wrap, fail, parseId } = require('./util');

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
const MAX_BOTS = 10;

async function myBot(req) {
  const id = parseId(req.params.id);
  const { rows } = id
    ? await db.query('SELECT id, username, display_name, is_bot FROM users WHERE id = $1 AND is_bot AND bot_owner_id = $2', [id, req.userId])
    : { rows: [] };
  if (!rows[0]) fail(404, 'Bot não encontrado.');
  return rows[0];
}

async function setNewToken(botId) {
  const token = auth.newBotToken(botId);
  await db.query('UPDATE users SET bot_token_hash = $2 WHERE id = $1', [botId, auth.hashBotToken(token)]);
  return token;
}

module.exports = function botRoutes(r) {
  r.use('/bots', auth.humansOnly);

  r.get('/bots', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.display_name, u.is_bot,
              (SELECT count(*)::int FROM server_members m WHERE m.user_id = u.id) AS server_count
       FROM users u WHERE u.is_bot AND u.bot_owner_id = $1 ORDER BY u.id`,
      [req.userId],
    );
    res.json({ bots: rows.map((b) => ({ ...S.user(b), serverCount: b.server_count })) });
  }));

  r.post('/bots', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    if (!USERNAME_RE.test(username) || username === 'everyone' || username === 'here') {
      fail(400, 'Nome de usuário do bot: 3 a 32 caracteres, letras minúsculas, números, _ ou .');
    }
    const displayName = String(req.body.displayName || '').replace(/\s+/g, ' ').trim().slice(0, 32) || username;
    const { rows: count } = await db.query('SELECT count(*)::int AS n FROM users WHERE bot_owner_id = $1 AND is_bot', [req.userId]);
    if (count[0].n >= MAX_BOTS) fail(400, `Você pode ter no máximo ${MAX_BOTS} bots.`);

    let bot;
    try {
      // Bots não têm senha: o "!" nunca bate com nenhuma senha.
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, password_hash, is_bot, bot_owner_id)
         VALUES ($1, $2, '!', true, $3) RETURNING id, username, display_name, is_bot`,
        [username, displayName, req.userId],
      );
      bot = rows[0];
    } catch (err) {
      if (err.code === '23505') fail(409, 'Esse nome de usuário já existe.');
      throw err;
    }
    const token = await setNewToken(bot.id);
    res.status(201).json({ bot: { ...S.user(bot), serverCount: 0 }, token });
  }));

  // Gera um token novo (o antigo para de funcionar e o bot é desconectado).
  r.post('/bots/:id/token', wrap(async (req, res) => {
    const bot = await myBot(req);
    const token = await setNewToken(bot.id);
    const io = events.getIo();
    if (io) io.in(`user:${bot.id}`).disconnectSockets(true);
    res.json({ token });
  }));

  r.patch('/bots/:id', wrap(async (req, res) => {
    const bot = await myBot(req);
    const displayName = String(req.body.displayName || '').replace(/\s+/g, ' ').trim().slice(0, 32) || bot.username;
    const { rows } = await db.query(
      'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, username, display_name, is_bot',
      [bot.id, displayName],
    );
    const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [bot.id]);
    servers.rows.forEach((s) => events.serverChanged(s.server_id));
    res.json({ bot: S.user(rows[0]) });
  }));

  r.delete('/bots/:id', wrap(async (req, res) => {
    const bot = await myBot(req);
    const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [bot.id]);
    const io = events.getIo();
    if (io) io.in(`user:${bot.id}`).disconnectSockets(true);
    await db.query('DELETE FROM users WHERE id = $1', [bot.id]);
    servers.rows.forEach((s) => events.serverChanged(s.server_id));
    res.json({ ok: true });
  }));
};
