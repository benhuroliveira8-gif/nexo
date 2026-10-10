// Amigos e mensagens diretas (DMs).
const db = require('../db');
const S = require('../serializers');
const presence = require('../presence');
const events = require('../events');
const { humansOnly } = require('../auth');
const { wrap, fail, parseId, channelStates } = require('./util');

const withPresence = (row) => ({ ...S.user(row), ...presence.publicPresence(row) });

async function findFriendship(a, b) {
  const { rows } = await db.query(
    `SELECT * FROM friendships
     WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [a, b],
  );
  return rows[0] || null;
}

// Pode mandar DM para quem é amigo ou divide algum servidor.
async function canDm(a, b) {
  const f = await findFriendship(a, b);
  if (f && f.status === 'accepted') return true;
  const { rowCount } = await db.query(
    `SELECT 1 FROM server_members x JOIN server_members y ON y.server_id = x.server_id
     WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1`,
    [a, b],
  );
  return rowCount > 0;
}

module.exports = function socialRoutes(r) {
  // ---------- Amigos (só pessoas)
  r.use('/friends', humansOnly);
  r.post('/dms', humansOnly);

  r.get('/friends', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT f.status AS friendship_status, f.requester_id, u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.requester_id = $1 OR f.addressee_id = $1
       ORDER BY lower(u.display_name)`,
      [req.userId],
    );
    res.json({
      friends: rows.filter((x) => x.friendship_status === 'accepted').map(withPresence),
      incoming: rows.filter((x) => x.friendship_status === 'pending' && x.requester_id !== req.userId).map(withPresence),
      outgoing: rows.filter((x) => x.friendship_status === 'pending' && x.requester_id === req.userId).map(withPresence),
    });
  }));

  // Enviar pedido por nome de usuário. Se a outra pessoa já tinha pedido, vira amizade.
  r.post('/friends', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    const { rows } = await db.query('SELECT id, is_bot FROM users WHERE username = $1', [username]);
    const other = rows[0];
    if (!other) fail(404, 'Não encontramos ninguém com esse nome de usuário.');
    if (other.is_bot) fail(400, 'Bots não podem ser adicionados como amigos.');
    if (other.id === req.userId) fail(400, 'Você não pode adicionar a si mesmo.');

    const f = await findFriendship(req.userId, other.id);
    let status = 'pending';
    if (f && f.status === 'accepted') fail(409, 'Vocês já são amigos.');
    if (f && f.requester_id === req.userId) fail(409, 'Você já enviou um pedido para essa pessoa.');
    if (f) {
      await db.query(
        "UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2",
        [other.id, req.userId],
      );
      status = 'accepted';
    } else {
      await db.query('INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)', [req.userId, other.id]);
    }
    events.friendsChanged(req.userId, other.id);
    res.status(201).json({ status });
  }));

  r.post('/friends/:userId/accept', wrap(async (req, res) => {
    const otherId = parseId(req.params.userId);
    const { rowCount } = await db.query(
      `UPDATE friendships SET status = 'accepted'
       WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [otherId, req.userId],
    );
    if (rowCount === 0) fail(404, 'Pedido de amizade não encontrado.');
    events.friendsChanged(req.userId, otherId);
    res.json({ ok: true });
  }));

  // Recusar, cancelar pedido ou desfazer amizade.
  r.delete('/friends/:userId', wrap(async (req, res) => {
    const otherId = parseId(req.params.userId);
    const { rowCount } = await db.query(
      `DELETE FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.userId, otherId],
    );
    if (rowCount === 0) fail(404, 'Amizade não encontrada.');
    events.friendsChanged(req.userId, otherId);
    res.json({ ok: true });
  }));

  // ---------- Mensagens diretas

  r.get('/dms', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id AS channel_id, u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text,
              (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
       FROM dm_members me
       JOIN channels c ON c.id = me.channel_id AND c.kind = 'dm'
       JOIN dm_members other ON other.channel_id = c.id AND other.user_id <> me.user_id
       JOIN users u ON u.id = other.user_id
       WHERE me.user_id = $1
       ORDER BY last_at DESC NULLS LAST, c.id DESC`,
      [req.userId],
    );
    const states = await channelStates(req.userId, rows.map((x) => x.channel_id));
    res.json({
      dms: rows.map((x) => ({
        channelId: x.channel_id,
        user: withPresence(x),
        lastMessageAt: x.last_at,
        ...(states.get(x.channel_id) || { unread: false, mentions: 0 }),
      })),
    });
  }));

  // Abre (ou cria) a conversa com alguém.
  r.post('/dms', wrap(async (req, res) => {
    const otherId = parseId(req.body.userId);
    if (!otherId || otherId === req.userId) fail(400, 'Escolha outra pessoa.');
    const { rows: users } = await db.query('SELECT id, username, display_name, is_bot, avatar_id, status, status_text FROM users WHERE id = $1', [otherId]);
    if (!users[0]) fail(404, 'Usuário não encontrado.');

    const key = [req.userId, otherId].sort((a, b) => a - b).join(':');
    let { rows } = await db.query("SELECT id FROM channels WHERE dm_key = $1 AND kind = 'dm'", [key]);
    if (!rows[0]) {
      if (!(await canDm(req.userId, otherId))) {
        fail(403, 'Vocês precisam ser amigos ou estar no mesmo servidor para conversar.');
      }
      rows = await db.transaction(async (c) => {
        const created = await c.query(
          `INSERT INTO channels (server_id, name, kind, dm_key) VALUES (NULL, 'dm', 'dm', $1)
           ON CONFLICT (dm_key) DO NOTHING RETURNING id`,
          [key],
        );
        if (!created.rows[0]) return (await c.query('SELECT id FROM channels WHERE dm_key = $1', [key])).rows;
        const id = created.rows[0].id;
        await c.query('INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [id, req.userId, otherId]);
        return created.rows;
      });
    }
    res.json({ channelId: rows[0].id, user: withPresence(users[0]) });
  }));
};
