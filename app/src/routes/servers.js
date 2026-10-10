// Servidores, canais, cargos, membros e convites.
const crypto = require('crypto');
const db = require('../db');
const S = require('../serializers');
const presence = require('../presence');
const events = require('../events');
const files = require('../files');
const voice = require('../voice');
const { humansOnly, checkPassword } = require('../auth');
const { P, ALL, DEFAULT_EVERYONE, memberContext } = require('../permissions');
const { wrap, fail, parseId, channelStates, markServerRead } = require('./util');

const M = require('../messages');

const newInviteCode = () => crypto.randomBytes(6).toString('base64url'); // 8 caracteres
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Nome de canal no estilo "meu-canal": minúsculo, sem espaços.
function normalizeChannelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// Nome de thread: texto livre (com espaços e maiúsculas), uma linha.
const cleanThreadName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 100);

// Carrega o contexto do usuário no servidor da URL e exige uma permissão (opcional).
async function requireMember(req, flag) {
  const serverId = parseId(req.params.id);
  const ctx = serverId && await memberContext(serverId, req.userId);
  if (!ctx) fail(404, 'Servidor não encontrado.');
  if (flag && !ctx.can(flag)) fail(403, 'Você não tem permissão para isso.');
  return ctx;
}

async function getRole(serverId, roleId) {
  const { rows } = await db.query('SELECT * FROM roles WHERE id = $1 AND server_id = $2', [roleId, serverId]);
  if (!rows[0]) fail(404, 'Cargo não encontrado.');
  return rows[0];
}

// Só dá para mexer em cargos abaixo do seu cargo mais alto (o dono pode tudo).
function assertCanManageRole(ctx, role) {
  if (!ctx.can(P.MANAGE_ROLES)) fail(403, 'Você não tem permissão para gerenciar cargos.');
  if (!role.is_default && role.position >= ctx.top) fail(403, 'Esse cargo está acima (ou no mesmo nível) do seu cargo mais alto.');
}

// Ninguém pode dar uma permissão que não tem (a não ser dono/administrador).
function assertPermsAllowed(ctx, perms) {
  if (ctx.isOwner || (ctx.perms & P.ADMINISTRATOR)) return;
  if ((perms & ~ctx.perms) !== 0) fail(403, 'Você não pode dar permissões que você mesmo não tem.');
}

function parsePerms(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(400, 'Permissões inválidas.');
  return n & ALL;
}

async function serverDetail(serverId, userId) {
  const ctx = await memberContext(serverId, userId);
  if (!ctx) return null;
  const [server, channels, members, roles, memberRoles] = await Promise.all([
    db.query('SELECT * FROM servers WHERE id = $1', [serverId]),
    db.query(
      `SELECT c.*, (SELECT max(created_at) FROM messages WHERE channel_id = c.id) AS last_message_at
       FROM channels c WHERE c.server_id = $1 ORDER BY c.position, c.id`,
      [serverId],
    ),
    db.query(
      `SELECT u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text FROM users u
       JOIN server_members m ON m.user_id = u.id
       WHERE m.server_id = $1 ORDER BY lower(u.display_name)`,
      [serverId],
    ),
    db.query('SELECT * FROM roles WHERE server_id = $1 ORDER BY position DESC, id', [serverId]),
    db.query('SELECT user_id, role_id FROM member_roles WHERE server_id = $1', [serverId]),
  ]);
  const states = await channelStates(userId, channels.rows.map((c) => c.id));
  const rolesByUser = new Map();
  memberRoles.rows.forEach((r) => {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r.role_id);
  });
  return {
    server: S.server(server.rows[0], { showInvite: ctx.can(P.CREATE_INVITE) }),
    channels: channels.rows.map((c) => ({
      ...S.channel(c),
      ...(c.kind === 'thread' ? { lastMessageAt: c.last_message_at || c.created_at } : {}),
      ...(states.get(c.id) || { unread: false, mentions: 0 }),
    })),
    members: members.rows.map((m) => ({ ...S.user(m), ...presence.publicPresence(m), roleIds: rolesByUser.get(m.id) || [] })),
    roles: roles.rows.map(S.role),
    voice: voice.statesForChannels(channels.rows.filter((c) => c.kind === 'voice').map((c) => c.id)),
    me: { permissions: ctx.perms, isOwner: ctx.isOwner, top: ctx.isOwner ? null : ctx.top },
  };
}

// Remove alguém do servidor (expulsão ou saída) e avisa todo mundo.
async function removeMember(serverId, userId, reason) {
  await db.transaction(async (c) => {
    await c.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
    await c.query(
      'DELETE FROM channel_reads WHERE user_id = $1 AND channel_id IN (SELECT id FROM channels WHERE server_id = $2)',
      [userId, serverId],
    );
  });
  voice.leaveServer(userId, serverId);
  const io = events.getIo();
  if (io) io.in(`user:${userId}`).socketsLeave(`server:${serverId}`);
  events.emitTo([`user:${userId}`], 'server:removed', { serverId, reason });
  events.serverChanged(serverId);
}

module.exports = function serverRoutes(r) {
  // ---------- Servidores

  r.get('/servers', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.* FROM servers s
       JOIN server_members m ON m.server_id = s.id
       WHERE m.user_id = $1
       ORDER BY m.joined_at`,
      [req.userId],
    );
    const ch = await db.query(
      'SELECT id, server_id FROM channels WHERE server_id = ANY($1::int[])',
      [rows.map((s) => s.id)],
    );
    const states = await channelStates(req.userId, ch.rows.map((c) => c.id));
    const agg = new Map();
    ch.rows.forEach((c) => {
      const st = states.get(c.id);
      const a = agg.get(c.server_id) || { unread: false, mentions: 0 };
      if (st) { a.unread = a.unread || st.unread; a.mentions += st.mentions; }
      agg.set(c.server_id, a);
    });
    res.json({
      servers: rows.map((s) => ({ ...S.server(s, { showInvite: false }), ...(agg.get(s.id) || { unread: false, mentions: 0 }) })),
    });
  }));

  r.post('/servers', humansOnly, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) fail(400, 'Dê um nome ao servidor.');

    const server = await db.transaction(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO servers (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING *',
        [name, req.userId, newInviteCode()],
      );
      const s = rows[0];
      await c.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [s.id, req.userId]);
      await c.query(
        "INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES ($1, '@everyone', $2, 0, true)",
        [s.id, DEFAULT_EVERYONE],
      );
      await c.query("INSERT INTO channels (server_id, name, position) VALUES ($1, 'geral', 0)", [s.id]);
      return s;
    });

    events.getIo().in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);
    res.status(201).json({ server: S.server(server) });
  }));

  r.get('/servers/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const detail = id && await serverDetail(id, req.userId);
    if (!detail) fail(404, 'Servidor não encontrado.');
    res.json(detail);
  }));

  r.patch('/servers/:id', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_SERVER);
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) fail(400, 'Dê um nome ao servidor.');
    await db.query('UPDATE servers SET name = $2 WHERE id = $1', [ctx.serverId, name]);
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  r.delete('/servers/:id', wrap(async (req, res) => {
    const ctx = await requireMember(req);
    if (!ctx.isOwner) fail(403, 'Só o dono pode apagar o servidor.');
    const att = await db.query(
      `SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
       JOIN channels c ON c.id = m.channel_id WHERE c.server_id = $1`,
      [ctx.serverId],
    );
    const vc = await db.query("SELECT id FROM channels WHERE server_id = $1 AND kind = 'voice'", [ctx.serverId]);
    vc.rows.forEach((c) => voice.clearChannel(c.id));
    await db.query('DELETE FROM servers WHERE id = $1', [ctx.serverId]);
    att.rows.forEach((a) => files.removeFile(a.id));
    events.emitTo([`server:${ctx.serverId}`], 'server:removed', { serverId: ctx.serverId, reason: 'deleted' });
    events.getIo().in(`server:${ctx.serverId}`).socketsLeave(`server:${ctx.serverId}`);
    res.json({ ok: true });
  }));

  // Passar o servidor para outra pessoa (o dono vira membro comum).
  r.post('/servers/:id/transfer', humansOnly, wrap(async (req, res) => {
    const ctx = await requireMember(req);
    if (!ctx.isOwner) fail(403, 'Só o dono pode transferir o servidor.');
    const me = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!(await checkPassword(String(req.body.password || ''), me.rows[0].password_hash))) fail(403, 'Senha incorreta.');
    const userId = parseId(req.body.userId);
    const { rows } = userId ? await db.query(
      `SELECT u.id, u.is_bot FROM users u JOIN server_members m ON m.user_id = u.id AND m.server_id = $1 WHERE u.id = $2`,
      [ctx.serverId, userId],
    ) : { rows: [] };
    if (!rows[0] || rows[0].id === req.userId) fail(400, 'Escolha outro membro do servidor.');
    if (rows[0].is_bot) fail(400, 'Um bot não pode ser dono de servidor.');
    await db.query('UPDATE servers SET owner_id = $2 WHERE id = $1', [ctx.serverId, userId]);
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  // Gera um código de convite novo (o antigo para de funcionar).
  r.post('/servers/:id/invite', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_SERVER);
    const { rows } = await db.query(
      'UPDATE servers SET invite_code = $2 WHERE id = $1 RETURNING invite_code',
      [ctx.serverId, newInviteCode()],
    );
    events.serverChanged(ctx.serverId);
    res.json({ inviteCode: rows[0].invite_code });
  }));

  // ---------- Convites

  const codeFrom = (raw) => String(raw || '').trim().split('/').filter(Boolean).pop() || '';

  r.get('/invites/:code', humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.id, s.name,
         (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count,
         EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2) AS is_member
       FROM servers s WHERE s.invite_code = $1`,
      [codeFrom(req.params.code), req.userId],
    );
    if (!rows[0]) fail(404, 'Convite inválido ou expirado.');
    res.json({ server: { id: rows[0].id, name: rows[0].name }, memberCount: rows[0].member_count, isMember: rows[0].is_member });
  }));

  r.post('/servers/join', humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM servers WHERE invite_code = $1', [codeFrom(req.body.code)]);
    const server = rows[0];
    if (!server) fail(404, 'Convite inválido ou expirado.');

    const joined = await db.transaction(async (c) => {
      const ins = await c.query(
        'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [server.id, req.userId],
      );
      if (ins.rowCount > 0) await markServerRead(c, server.id, req.userId);
      return ins.rowCount > 0;
    });

    events.getIo().in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);
    if (joined) events.serverChanged(server.id);
    res.json({ server: S.server(server, { showInvite: false }) });
  }));

  // ---------- Canais

  r.post('/servers/:id/channels', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_CHANNELS);
    const name = normalizeChannelName(req.body.name);
    if (!name) fail(400, 'Dê um nome ao canal.');
    const kind = req.body.kind === 'voice' ? 'voice' : 'text';
    const { rows } = await db.query(
      `INSERT INTO channels (server_id, name, kind, position)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE server_id = $1))
       RETURNING *`,
      [ctx.serverId, name, kind],
    );
    events.serverChanged(ctx.serverId);
    res.status(201).json({ channel: S.channel(rows[0]) });
  }));

  async function channelForManage(req) {
    const channelId = parseId(req.params.channelId);
    const { rows } = channelId
      ? await db.query("SELECT * FROM channels WHERE id = $1 AND kind <> 'dm'", [channelId])
      : { rows: [] };
    if (!rows[0]) fail(404, 'Canal não encontrado.');
    const ctx = await memberContext(rows[0].server_id, req.userId);
    if (!ctx) fail(404, 'Canal não encontrado.');
    // Quem criou a thread também pode renomear/apagar a própria thread.
    const ownThread = rows[0].kind === 'thread' && rows[0].created_by === req.userId;
    if (!ownThread && !ctx.can(P.MANAGE_CHANNELS)) fail(403, 'Você não tem permissão para gerenciar canais.');
    return { channel: rows[0], ctx };
  }

  r.patch('/channels/:channelId', wrap(async (req, res) => {
    const { channel } = await channelForManage(req);
    const name = channel.kind === 'thread' ? cleanThreadName(req.body.name) : normalizeChannelName(req.body.name);
    if (!name) fail(400, 'Dê um nome ao canal.');
    const { rows } = await db.query('UPDATE channels SET name = $2 WHERE id = $1 RETURNING *', [channel.id, name]);
    events.serverChanged(channel.server_id);
    if (channel.kind === 'thread') M.refreshThreadParent(channel).catch(() => {});
    res.json({ channel: S.channel(rows[0]) });
  }));

  r.delete('/channels/:channelId', wrap(async (req, res) => {
    const { channel } = await channelForManage(req);
    if (channel.kind === 'text') {
      const count = await db.query("SELECT count(*)::int AS n FROM channels WHERE server_id = $1 AND kind = 'text'", [channel.server_id]);
      if (count.rows[0].n <= 1) fail(400, 'O servidor precisa ter pelo menos um canal de texto.');
    }
    voice.clearChannel(channel.id);
    // Apaga junto os anexos das threads penduradas neste canal.
    const att = await db.query(
      `SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.channel_id IN (SELECT id FROM channels WHERE id = $1 OR parent_channel_id = $1)`,
      [channel.id],
    );
    await db.query('DELETE FROM channels WHERE id = $1', [channel.id]);
    att.rows.forEach((a) => files.removeFile(a.id));
    events.serverChanged(channel.server_id);
    if (channel.kind === 'thread') M.refreshThreadParent(channel).catch(() => {});
    res.json({ ok: true });
  }));

  // ---------- Cargos

  r.post('/servers/:id/roles', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const name = String(req.body.name || 'novo cargo').trim().slice(0, 32) || 'novo cargo';
    const color = COLOR_RE.test(req.body.color || '') ? req.body.color.toLowerCase() : null;
    const perms = parsePerms(req.body.permissions ?? 0);
    assertPermsAllowed(ctx, perms);

    // Cargo novo entra logo acima do @everyone (posição 1); os outros sobem um degrau.
    const role = await db.transaction(async (c) => {
      await c.query('UPDATE roles SET position = position + 1 WHERE server_id = $1 AND NOT is_default', [ctx.serverId]);
      const { rows } = await c.query(
        'INSERT INTO roles (server_id, name, color, permissions, position) VALUES ($1, $2, $3, $4, 1) RETURNING *',
        [ctx.serverId, name, color, perms],
      );
      return rows[0];
    });
    events.serverChanged(ctx.serverId);
    res.status(201).json({ role: S.role(role) });
  }));

  r.patch('/servers/:id/roles/:roleId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const role = await getRole(ctx.serverId, parseId(req.params.roleId));
    assertCanManageRole(ctx, role);

    const sets = [];
    const vals = [role.id];
    if (req.body.name !== undefined && !role.is_default) {
      const name = String(req.body.name).trim().slice(0, 32);
      if (!name) fail(400, 'Dê um nome ao cargo.');
      vals.push(name); sets.push(`name = $${vals.length}`);
    }
    if (req.body.color !== undefined && !role.is_default) {
      const color = req.body.color && COLOR_RE.test(req.body.color) ? req.body.color.toLowerCase() : null;
      vals.push(color); sets.push(`color = $${vals.length}`);
    }
    if (req.body.permissions !== undefined) {
      const perms = parsePerms(req.body.permissions);
      // Só valida os bits que estão mudando.
      assertPermsAllowed(ctx, perms ^ Number(role.permissions));
      vals.push(perms); sets.push(`permissions = $${vals.length}`);
    }
    if (sets.length) await db.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = $1`, vals);

    // Subir/descer o cargo na hierarquia (troca de lugar com o vizinho).
    if ((req.body.move === 'up' || req.body.move === 'down') && !role.is_default) {
      const neighbor = await db.query(
        req.body.move === 'up'
          ? 'SELECT * FROM roles WHERE server_id = $1 AND NOT is_default AND position > $2 ORDER BY position ASC LIMIT 1'
          : 'SELECT * FROM roles WHERE server_id = $1 AND NOT is_default AND position < $2 ORDER BY position DESC LIMIT 1',
        [ctx.serverId, role.position],
      );
      const other = neighbor.rows[0];
      if (other) {
        if (other.position >= ctx.top) fail(403, 'Você não pode colocar um cargo acima do seu.');
        await db.transaction(async (c) => {
          await c.query('UPDATE roles SET position = $2 WHERE id = $1', [role.id, other.position]);
          await c.query('UPDATE roles SET position = $2 WHERE id = $1', [other.id, role.position]);
        });
      }
    }

    events.serverChanged(ctx.serverId);
    res.json({ role: S.role(await getRole(ctx.serverId, role.id)) });
  }));

  r.delete('/servers/:id/roles/:roleId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const role = await getRole(ctx.serverId, parseId(req.params.roleId));
    if (role.is_default) fail(400, 'O cargo @everyone não pode ser apagado.');
    assertCanManageRole(ctx, role);
    await db.transaction(async (c) => {
      await c.query('DELETE FROM roles WHERE id = $1', [role.id]);
      await c.query('UPDATE roles SET position = position - 1 WHERE server_id = $1 AND NOT is_default AND position > $2', [ctx.serverId, role.position]);
    });
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  // ---------- Bots no servidor (quem pode gerenciar o servidor adiciona)
  r.post('/servers/:id/bots', humansOnly, wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_SERVER);
    const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    const { rows } = await db.query('SELECT id, username, display_name, is_bot, avatar_id, status, status_text FROM users WHERE username = $1 AND is_bot', [username]);
    const bot = rows[0];
    if (!bot) fail(404, 'Não existe bot com esse nome de usuário.');
    const added = await db.transaction(async (c) => {
      const ins = await c.query(
        'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ctx.serverId, bot.id],
      );
      if (ins.rowCount > 0) await markServerRead(c, ctx.serverId, bot.id);
      return ins.rowCount > 0;
    });
    if (!added) fail(409, 'Esse bot já está no servidor.');
    events.getIo().in(`user:${bot.id}`).socketsJoin(`server:${ctx.serverId}`);
    events.serverChanged(ctx.serverId);
    res.status(201).json({ bot: S.user(bot) });
  }));

  // ---------- Membros

  // Define a lista completa de cargos de um membro.
  r.put('/servers/:id/members/:userId/roles', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const targetId = parseId(req.params.userId);
    const target = targetId && await memberContext(ctx.serverId, targetId);
    if (!target) fail(404, 'Membro não encontrado.');
    if (targetId !== req.userId && !ctx.isOwner && target.top >= ctx.top) {
      fail(403, 'Esse membro tem um cargo igual ou acima do seu.');
    }

    const wanted = new Set((Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number));
    const { rows: roles } = await db.query('SELECT * FROM roles WHERE server_id = $1 AND NOT is_default', [ctx.serverId]);
    const { rows: current } = await db.query(
      'SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2',
      [ctx.serverId, targetId],
    );
    const have = new Set(current.map((x) => x.role_id));
    const byId = new Map(roles.map((x) => [x.id, x]));
    for (const id of wanted) if (!byId.has(id)) fail(400, 'Cargo inválido.');

    const add = [...wanted].filter((id) => !have.has(id));
    const remove = [...have].filter((id) => !wanted.has(id));
    for (const id of [...add, ...remove]) assertCanManageRole(ctx, byId.get(id));

    await db.transaction(async (c) => {
      for (const id of remove) await c.query('DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3', [ctx.serverId, targetId, id]);
      for (const id of add) await c.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ctx.serverId, targetId, id]);
    });
    events.serverChanged(ctx.serverId);
    res.json({ roleIds: [...wanted] });
  }));

  // Expulsar alguém, ou sair do servidor (quando o id é o seu).
  r.delete('/servers/:id/members/:userId', wrap(async (req, res) => {
    const ctx = await requireMember(req);
    const targetId = req.params.userId === 'me' ? req.userId : parseId(req.params.userId);
    if (!targetId) fail(404, 'Membro não encontrado.');

    if (targetId === req.userId) {
      if (ctx.isOwner) fail(400, 'O dono não pode sair. Apague o servidor nas configurações.');
      await removeMember(ctx.serverId, targetId, 'left');
      return res.json({ ok: true });
    }

    if (!ctx.can(P.KICK_MEMBERS)) fail(403, 'Você não tem permissão para expulsar membros.');
    const target = await memberContext(ctx.serverId, targetId);
    if (!target) fail(404, 'Membro não encontrado.');
    if (target.isOwner) fail(403, 'O dono do servidor não pode ser expulso.');
    if (!ctx.isOwner && target.top >= ctx.top) fail(403, 'Esse membro tem um cargo igual ou acima do seu.');
    await removeMember(ctx.serverId, targetId, 'kicked');
    res.json({ ok: true });
  }));
};
