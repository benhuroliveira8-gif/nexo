// Amigos e mensagens diretas (DMs).
const db = require('../db');
const S = require('../serializers');
const presence = require('../presence');
const events = require('../events');
const voice = require('../voice');
const M = require('../messages');
const { humansOnly } = require('../auth');
const { channelAccess } = require('../permissions');
const { wrap, fail, parseId, channelStates } = require('./util');

const MAX_GROUP = 10; // pessoas num grupo (contando você)
const U_COLS = 'u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text, u.activity';

const dmsChanged = (userIds) => events.emitTo(userIds.map((id) => `user:${id}`), 'dms:changed', {});

async function areFriends(a, b) {
  const f = await findFriendship(a, b);
  return !!(f && f.status === 'accepted');
}

// Carrega um grupo em que a pessoa está (ou falha).
async function groupFor(req) {
  const channelId = parseId(req.params.channelId);
  const access = channelId && await channelAccess(channelId, req.userId);
  if (!access || access.kind !== 'dm') fail(404, 'Conversa não encontrada.');
  if (!access.isGroup) fail(400, 'Isso só funciona em grupos.');
  return access;
}

async function displayNameOf(id) {
  const { rows } = await db.query('SELECT display_name FROM users WHERE id = $1', [id]);
  return rows[0] ? rows[0].display_name : 'Alguém';
}

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
      `SELECT f.status AS friendship_status, f.requester_id, u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text, u.activity
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
    const { rows: chans } = await db.query(
      `SELECT c.id, c.name, c.dm_key, c.created_by, c.disappearing_seconds,
              (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
       FROM dm_members me JOIN channels c ON c.id = me.channel_id AND c.kind = 'dm'
       WHERE me.user_id = $1
       ORDER BY last_at DESC NULLS LAST, c.id DESC`,
      [req.userId],
    );
    const ids = chans.map((c) => c.id);
    const { rows: members } = ids.length ? await db.query(
      `SELECT d.channel_id, ${U_COLS} FROM dm_members d JOIN users u ON u.id = d.user_id
       WHERE d.channel_id = ANY($1::int[]) AND d.user_id <> $2 ORDER BY lower(u.display_name)`,
      [ids, req.userId],
    ) : { rows: [] };
    const byChannel = new Map();
    members.forEach((m) => {
      if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
      byChannel.get(m.channel_id).push(withPresence(m));
    });
    const states = await channelStates(req.userId, ids);
    const voiceStates = voice.statesForChannels(ids);
    const dms = [];
    for (const c of chans) {
      const users = byChannel.get(c.id) || [];
      const isGroup = !c.dm_key;
      if (!isGroup && users.length === 0) continue; // a outra pessoa apagou a conta
      dms.push({
        channelId: c.id,
        isGroup,
        name: isGroup ? (c.name && c.name !== 'dm' ? c.name : null) : null,
        ownerId: isGroup ? c.created_by : null,
        user: isGroup ? null : users[0],
        users,
        lastMessageAt: c.last_at,
        disappearingSeconds: c.disappearing_seconds || 0,
        voice: voiceStates[c.id] || [],
        ...(states.get(c.id) || { unread: false, mentions: 0 }),
      });
    }
    res.json({ dms });
  }));

  // Criar um grupo: { userIds: [amigos], name? } — de 2 a 9 amigos.
  r.post('/dms/group', humansOnly, wrap(async (req, res) => {
    const others = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number))].filter((id) => id !== req.userId);
    if (others.length < 2) fail(400, 'Escolha pelo menos 2 amigos para criar um grupo.');
    if (others.length > MAX_GROUP - 1) fail(400, `Um grupo pode ter no máximo ${MAX_GROUP} pessoas.`);
    for (const id of others) {
      if (!parseId(id) || !(await areFriends(req.userId, id))) fail(403, 'Você só pode colocar amigos no grupo.');
    }
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const channelId = await db.transaction(async (c) => {
      const { rows } = await c.query(
        "INSERT INTO channels (server_id, name, kind, created_by) VALUES (NULL, $1, 'dm', $2) RETURNING id",
        [name, req.userId],
      );
      const id = rows[0].id;
      for (const uid of [req.userId, ...others]) await c.query('INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)', [id, uid]);
      return id;
    });
    dmsChanged([req.userId, ...others]);
    res.status(201).json({ channelId });
  }));

  // Renomear o grupo (qualquer pessoa do grupo).
  r.patch('/dms/:channelId', humansOnly, wrap(async (req, res) => {
    const access = await groupFor(req);
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    await db.query('UPDATE channels SET name = $2 WHERE id = $1', [access.channel.id, name]);
    const who = await displayNameOf(req.userId);
    await M.createSystemMessage(access, req.userId, name ? `${who} mudou o nome do grupo para "${name}".` : `${who} tirou o nome do grupo.`);
    dmsChanged(access.memberIds);
    res.json({ ok: true });
  }));

  // Adicionar alguém ao grupo. Numa conversa a dois, cria um grupo novo com os três.
  r.post('/dms/:channelId/members', humansOnly, wrap(async (req, res) => {
    const channelId = parseId(req.params.channelId);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || access.kind !== 'dm') fail(404, 'Conversa não encontrada.');
    const add = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : [req.body.userId]).map(Number))]
      .filter((id) => !access.memberIds.includes(id));
    if (!add.length) fail(400, 'Essas pessoas já estão na conversa.');
    for (const id of add) {
      if (!parseId(id) || !(await areFriends(req.userId, id))) fail(403, 'Você só pode adicionar amigos.');
    }
    if (access.memberIds.length + add.length > MAX_GROUP) fail(400, `Um grupo pode ter no máximo ${MAX_GROUP} pessoas.`);

    if (!access.isGroup) {
      // Conversa a dois continua existindo; o grupo é uma conversa nova.
      const members = [...access.memberIds, ...add];
      const newId = await db.transaction(async (c) => {
        const { rows } = await c.query("INSERT INTO channels (server_id, name, kind, created_by) VALUES (NULL, '', 'dm', $1) RETURNING id", [req.userId]);
        for (const uid of members) await c.query('INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)', [rows[0].id, uid]);
        return rows[0].id;
      });
      dmsChanged(members);
      return res.status(201).json({ channelId: newId, created: true });
    }

    await db.transaction(async (c) => {
      for (const uid of add) {
        await c.query('INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [access.channel.id, uid]);
        // Quem entra não ganha o histórico inteiro como "não lido".
        await c.query(
          `INSERT INTO channel_reads (user_id, channel_id, last_read_id)
           VALUES ($1, $2, COALESCE((SELECT max(id) FROM messages WHERE channel_id = $2), 0))
           ON CONFLICT (user_id, channel_id) DO NOTHING`,
          [uid, access.channel.id],
        );
      }
    });
    const fresh = await channelAccess(access.channel.id, req.userId);
    const who = await displayNameOf(req.userId);
    const names = await Promise.all(add.map(displayNameOf));
    await M.createSystemMessage(fresh, req.userId, `${who} adicionou ${names.join(', ')} ao grupo.`);
    dmsChanged(fresh.memberIds);
    res.json({ channelId: access.channel.id, created: false });
  }));

  // Sair do grupo (id = me) ou tirar alguém (só o dono do grupo).
  r.delete('/dms/:channelId/members/:userId', humansOnly, wrap(async (req, res) => {
    const access = await groupFor(req);
    const targetId = req.params.userId === 'me' ? req.userId : parseId(req.params.userId);
    if (!targetId || !access.memberIds.includes(targetId)) fail(404, 'Essa pessoa não está no grupo.');
    if (targetId !== req.userId && access.channel.created_by !== req.userId) fail(403, 'Só o dono do grupo pode tirar pessoas.');
    const who = await displayNameOf(req.userId);
    const target = await displayNameOf(targetId);
    await db.transaction(async (c) => {
      await c.query('DELETE FROM dm_members WHERE channel_id = $1 AND user_id = $2', [access.channel.id, targetId]);
      await c.query('DELETE FROM channel_reads WHERE channel_id = $1 AND user_id = $2', [access.channel.id, targetId]);
      if (access.channel.created_by === targetId) {
        await c.query(
          'UPDATE channels SET created_by = (SELECT user_id FROM dm_members WHERE channel_id = $1 LIMIT 1) WHERE id = $1',
          [access.channel.id],
        );
      }
    });
    if (voice.currentChannelOf(targetId) === access.channel.id) voice.leave(targetId);
    const rest = access.memberIds.filter((id) => id !== targetId);
    if (rest.length === 0) {
      await db.query('DELETE FROM channels WHERE id = $1', [access.channel.id]);
    } else {
      const fresh = await channelAccess(access.channel.id, rest[0]);
      await M.createSystemMessage(fresh, req.userId, targetId === req.userId ? `${who} saiu do grupo.` : `${who} removeu ${target} do grupo.`);
    }
    dmsChanged(access.memberIds);
    events.emitTo([`user:${targetId}`], 'dm:removed', { channelId: access.channel.id, reason: targetId === req.userId ? 'left' : 'removed' });
    res.json({ ok: true });
  }));

  // Abre (ou cria) a conversa com alguém.
  r.post('/dms', wrap(async (req, res) => {
    const otherId = parseId(req.body.userId);
    if (!otherId || otherId === req.userId) fail(400, 'Escolha outra pessoa.');
    const { rows: users } = await db.query('SELECT id, username, display_name, is_bot, avatar_id, status, status_text, activity FROM users WHERE id = $1', [otherId]);
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
