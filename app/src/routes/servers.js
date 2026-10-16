// Servidores, categorias, canais, cargos, membros, convites e moderação.
const crypto = require('crypto');
const db = require('../db');
const notify = require('../notify');
const S = require('../serializers');
const presence = require('../presence');
const events = require('../events');
const files = require('../files');
const voice = require('../voice');
const { humansOnly } = require('../auth');
const { audit } = require('../audit');
const emojis = require('../emojis');
const assets = require('../assets');
const automod = require('../automod');
const {
  P, ALL, DEFAULT_EVERYONE, memberContext, visibleChannelIds, VISIBLE_SQL,
} = require('../permissions');
const { wrap, fail, parseId, channelStates, markServerRead } = require('./util');

const M = require('../messages');

const newInviteCode = () => crypto.randomBytes(6).toString('base64url'); // 8 caracteres
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_CHANNELS = 200;

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

// Descrição/regras de um fórum (aparece no topo da lista de posts).
const cleanTopic = (v) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, 500) || null;

// Nome livre (threads e categorias): com espaços e maiúsculas, uma linha.
const cleanFreeName = (name, max = 100) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, max);

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
  if (ctx.isAdmin) return;
  if ((perms & ~ctx.perms) !== 0) fail(403, 'Você não pode dar permissões que você mesmo não tem.');
}

function parsePerms(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(400, 'Permissões inválidas.');
  return n & ALL;
}

// Moderar alguém (expulsar, banir, castigar): precisa estar acima da pessoa.
async function assertCanModerate(ctx, targetId) {
  if (targetId === ctx.userId) fail(400, 'Você não pode fazer isso com você mesmo.');
  const target = await memberContext(ctx.serverId, targetId);
  if (!target) return null;
  if (target.isOwner) fail(403, 'O dono do servidor não pode ser moderado.');
  if (!ctx.isOwner && target.top >= ctx.top) fail(403, 'Esse membro tem um cargo igual ou acima do seu.');
  return target;
}

// Primeiros passos: o que todo mundo vê (regras e interesses, sem nada secreto).
function onboardingPublic(o) {
  if (!o || !o.enabled) return null;
  return { enabled: true, rules: o.rules || '', interests: (o.interests || []).map(({ id, emoji, label, roleId }) => ({ id, emoji, label, roleId })) };
}
async function onboardingPending(serverId, userId, o, ctx) {
  if (!o || !o.enabled || ctx.isOwner) return false;
  const { rows } = await db.query('SELECT onboarded_at FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  return !!rows[0] && !rows[0].onboarded_at;
}

// Emoji do cargo: 1 emoji (ou até 2 caracteres comuns). Nada = sem ícone.
const SLOWMODE = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const graphemes = new Intl.Segmenter('pt', { granularity: 'grapheme' });
function cleanRoleIcon(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const parts = [...graphemes.segment(t)];
  if (parts.length > 2 || t.length > 16 || /[<>]/.test(t)) fail(400, 'O ícone do cargo pode ser 1 emoji.');
  return t;
}

async function userName(userId) {
  const { rows } = await db.query('SELECT display_name, username FROM users WHERE id = $1', [userId]);
  return rows[0] ? rows[0].display_name : null;
}

async function serverDetail(serverId, userId) {
  const ctx = await memberContext(serverId, userId);
  if (!ctx) return null;
  const visible = new Set(await visibleChannelIds(serverId, userId, ctx.isAdmin));
  const manageChannels = ctx.can(P.MANAGE_CHANNELS);
  const [server, channels, members, roles, memberRoles, channelRoles] = await Promise.all([
    db.query('SELECT * FROM servers WHERE id = $1', [serverId]),
    db.query(
      `SELECT c.*, (SELECT max(created_at) FROM messages WHERE channel_id = c.id) AS last_message_at
       FROM channels c WHERE c.server_id = $1 ORDER BY c.position, c.id`,
      [serverId],
    ),
    db.query(
      `SELECT u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text, u.activity, u.profile_color, m.timeout_until FROM users u
       JOIN server_members m ON m.user_id = u.id
       WHERE m.server_id = $1 ORDER BY lower(u.display_name)`,
      [serverId],
    ),
    db.query('SELECT * FROM roles WHERE server_id = $1 ORDER BY position DESC, id', [serverId]),
    db.query('SELECT user_id, role_id, expires_at FROM member_roles WHERE server_id = $1', [serverId]),
    manageChannels
      ? db.query('SELECT cr.channel_id, cr.role_id FROM channel_roles cr JOIN channels c ON c.id = cr.channel_id WHERE c.server_id = $1', [serverId])
      : { rows: [] },
  ]);
  const shown = channels.rows.filter((c) => visible.has(c.id));
  // Categoria vazia (para quem não vê nada dentro) só aparece para quem gerencia canais.
  const usedCategories = new Set(shown.filter((c) => c.category_id && c.kind !== 'category').map((c) => c.category_id));
  const list = shown.filter((c) => c.kind !== 'category' || manageChannels || usedCategories.has(c.id));
  const states = await channelStates(userId, list.filter((c) => c.kind !== 'category').map((c) => c.id));
  const rolesByUser = new Map();
  const expiryByUser = new Map(); // cargos temporários: { roleId: quando vence }
  memberRoles.rows.forEach((r) => {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r.role_id);
    if (r.expires_at) {
      if (!expiryByUser.has(r.user_id)) expiryByUser.set(r.user_id, {});
      expiryByUser.get(r.user_id)[r.role_id] = r.expires_at;
    }
  });
  const allowed = new Map();
  channelRoles.rows.forEach((r) => {
    if (!allowed.has(r.channel_id)) allowed.set(r.channel_id, []);
    allowed.get(r.channel_id).push(r.role_id);
  });
  const now = new Date();
  return {
    server: S.server(server.rows[0]),
    channels: list.map((c) => ({
      ...S.channel(c),
      ...(c.kind === 'thread' ? { lastMessageAt: c.last_message_at || c.created_at } : {}),
      ...(c.kind === 'category' ? {} : (states.get(c.id) || { unread: false, mentions: 0 })),
      ...(manageChannels && c.private ? { allowedRoleIds: allowed.get(c.id) || [] } : {}),
    })),
    members: members.rows.map((m) => ({
      ...S.user(m),
      ...presence.publicPresence(m),
      roleIds: rolesByUser.get(m.id) || [],
      ...(expiryByUser.has(m.id) ? { roleExpiry: expiryByUser.get(m.id) } : {}),
      timeoutUntil: m.timeout_until && new Date(m.timeout_until) > now ? m.timeout_until : null,
      profileColor: m.profile_color || null,
    })),
    roles: roles.rows.map(S.role),
    emojis: await emojis.listForServer(serverId),
    stickers: await assets.list('sticker', serverId),
    sounds: await assets.list('sound', serverId),
    ...(ctx.can(P.MANAGE_SERVER) ? { settings: { welcome: server.rows[0].welcome || null, automod: server.rows[0].automod || null } } : {}),
    levelsEnabled: !!(server.rows[0].levels && server.rows[0].levels.enabled),
    onboarding: onboardingPublic(server.rows[0].onboarding),
    voice: voice.statesForChannels(list.filter((c) => c.kind === 'voice').map((c) => c.id)),
    voiceWaiting: require('../waiting').forChannels(list.filter((c) => c.kind === 'voice' && c.waiting_room).map((c) => c.id)), // eslint-disable-line global-require
    me: {
      permissions: ctx.perms,
      isOwner: ctx.isOwner,
      isAdmin: ctx.isAdmin,
      top: ctx.isOwner ? null : ctx.top,
      timeoutUntil: ctx.timeoutUntil,
      // Precisa aceitar as regras (primeiros passos)?
      onboardingPending: await onboardingPending(serverId, userId, server.rows[0].onboarding, ctx),
    },
  };
}

// Remove alguém do servidor (expulsão, ban ou saída) e avisa todo mundo.
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

// Convite no formato do navegador.
const inviteJson = (row) => ({
  code: row.code,
  maxUses: row.max_uses,
  uses: row.uses,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  createdBy: row.created_by ? { id: row.created_by, displayName: row.creator_name || null } : null,
  roleId: row.role_id || null,
});

const VALID_INVITE = '(i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses IS NULL OR i.uses < i.max_uses)';

// Próxima posição livre dentro de uma categoria (ou entre as categorias).
async function nextPosition(client, serverId, categoryId, isCategory) {
  const { rows } = isCategory
    ? await client.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = $1 AND kind = 'category'", [serverId])
    : await client.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels
       WHERE server_id = $1 AND kind IN ('text', 'voice', 'forum') AND category_id IS NOT DISTINCT FROM $2`,
      [serverId, categoryId],
    );
  return rows[0].p;
}

async function categoryOf(serverId, categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const id = parseId(categoryId);
  const { rows } = id
    ? await db.query("SELECT id FROM channels WHERE id = $1 AND server_id = $2 AND kind = 'category'", [id, serverId])
    : { rows: [] };
  if (!rows[0]) fail(400, 'Categoria inválida.');
  return rows[0].id;
}

// Lista de cargos que podem ver um canal privado (só cargos do servidor, sem o @everyone).
async function cleanRoleIds(serverId, value) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT id FROM roles WHERE server_id = $1 AND NOT is_default AND id = ANY($2::int[])', [serverId, ids]);
  if (rows.length !== ids.length) fail(400, 'Cargo inválido.');
  return ids;
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
    // Só conta como "não lido" o que a pessoa consegue ver (canais privados ficam de fora).
    const ch = await db.query(
      `SELECT c.id, c.server_id, c.parent_channel_id FROM channels c
       LEFT JOIN channels p ON p.id = c.parent_channel_id
       JOIN servers s ON s.id = c.server_id
       WHERE c.server_id = ANY($2::int[]) AND c.kind <> 'category'
         AND ${VISIBLE_SQL('c', 'p', '$1', `(s.owner_id = $1 OR EXISTS (
           SELECT 1 FROM roles r WHERE r.server_id = s.id AND (r.permissions & 1) = 1 AND (r.is_default OR r.id IN (
             SELECT role_id FROM member_roles WHERE server_id = s.id AND user_id = $1))))`)}`,
      [req.userId, rows.map((s) => s.id)],
    );
    const states = await channelStates(req.userId, ch.rows.map((c) => c.id));
    // Silenciados não acendem o servidor; "Nada" também não conta menções.
    const prefs = (await notify.loadFor([req.userId])).get(req.userId) || new Map();
    const agg = new Map();
    ch.rows.forEach((c) => {
      const st = states.get(c.id);
      const a = agg.get(c.server_id) || { unread: false, mentions: 0 };
      const e = notify.effective(prefs, c.server_id, c.id, c.parent_channel_id);
      if (st && !e.muted) { a.unread = a.unread || st.unread; if (e.level !== 'none') a.mentions += st.mentions; }
      agg.set(c.server_id, a);
    });
    res.json({
      servers: rows.map((s) => ({ ...S.server(s), ...(agg.get(s.id) || { unread: false, mentions: 0 }) })),
    });
  }));

  r.post('/servers', humansOnly, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) fail(400, 'Dê um nome ao servidor.');
    const { rows: count } = await db.query('SELECT count(*)::int AS n FROM servers WHERE owner_id = $1', [req.userId]);
    if (count[0].n >= 50) fail(400, 'Você já tem servidores demais (máximo 50).');

    const server = await db.transaction(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO servers (name, owner_id) VALUES ($1, $2) RETURNING *',
        [name, req.userId],
      );
      const s = rows[0];
      await c.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [s.id, req.userId]);
      await c.query(
        "INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES ($1, '@everyone', $2, 0, true)",
        [s.id, DEFAULT_EVERYONE],
      );
      const text = await c.query("INSERT INTO channels (server_id, name, kind, position) VALUES ($1, 'Canais de texto', 'category', 0) RETURNING id", [s.id]);
      const vc = await c.query("INSERT INTO channels (server_id, name, kind, position) VALUES ($1, 'Canais de voz', 'category', 1) RETURNING id", [s.id]);
      await c.query("INSERT INTO channels (server_id, name, kind, position, category_id) VALUES ($1, 'geral', 'text', 0, $2)", [s.id, text.rows[0].id]);
      await c.query("INSERT INTO channels (server_id, name, kind, position, category_id) VALUES ($1, 'Geral', 'voice', 0, $2)", [s.id, vc.rows[0].id]);
      await c.query('INSERT INTO invites (code, server_id, created_by) VALUES ($1, $2, $3)', [newInviteCode(), s.id, req.userId]);
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
    const old = await db.query('SELECT name, theme_color FROM servers WHERE id = $1', [ctx.serverId]);
    // Cor do servidor: muda o destaque do visual para quem entra nele.
    if (req.body.themeColor !== undefined) {
      const c = req.body.themeColor;
      if (c !== null && c !== '' && !COLOR_RE.test(String(c))) fail(400, 'Cor inválida.');
      const color = c ? String(c).toLowerCase() : null;
      await db.query('UPDATE servers SET theme_color = $2 WHERE id = $1', [ctx.serverId, color]);
      if (color !== old.rows[0].theme_color) audit(ctx.serverId, req.userId, 'server_theme', { details: { color } });
    }
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 100);
      if (!name) fail(400, 'Dê um nome ao servidor.');
      await db.query('UPDATE servers SET name = $2 WHERE id = $1', [ctx.serverId, name]);
      if (old.rows[0].name !== name) audit(ctx.serverId, req.userId, 'server_update', { details: { from: old.rows[0].name, to: name } });
    }
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  r.delete('/servers/:id/icon', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_SERVER);
    const { rows } = await db.query(
      'UPDATE servers s SET icon_id = NULL FROM servers old WHERE s.id = $1 AND old.id = s.id RETURNING old.icon_id AS previous',
      [ctx.serverId],
    );
    if (rows[0] && rows[0].previous) files.removeAvatar(rows[0].previous);
    audit(ctx.serverId, req.userId, 'server_icon');
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  r.delete('/servers/:id/banner', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_SERVER);
    const { rows } = await db.query(
      'UPDATE servers s SET banner_id = NULL FROM servers old WHERE s.id = $1 AND old.id = s.id RETURNING old.banner_id AS previous',
      [ctx.serverId],
    );
    if (rows[0] && rows[0].previous) files.removeAvatar(rows[0].previous);
    audit(ctx.serverId, req.userId, 'server_banner');
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
    const emojiFiles = await db.query('SELECT file FROM nexo_emojis WHERE server_id = $1', [ctx.serverId]);
    const stickerFiles = await db.query('SELECT file FROM nexo_stickers WHERE server_id = $1', [ctx.serverId]);
    const soundFiles = await db.query('SELECT file FROM nexo_sounds WHERE server_id = $1', [ctx.serverId]);
    const { rows } = await db.query('DELETE FROM servers WHERE id = $1 RETURNING icon_id, banner_id', [ctx.serverId]);
    emojiFiles.rows.forEach((e) => emojis.removeFile(e.file));
    stickerFiles.rows.forEach((e) => assets.removeFile('sticker', e.file));
    soundFiles.rows.forEach((e) => assets.removeFile('sound', e.file));
    if (rows[0] && rows[0].icon_id) files.removeAvatar(rows[0].icon_id);
    if (rows[0] && rows[0].banner_id) files.removeAvatar(rows[0].banner_id);
    att.rows.forEach((a) => files.removeFile(a.id));
    events.emitTo([`server:${ctx.serverId}`], 'server:removed', { serverId: ctx.serverId, reason: 'deleted' });
    events.getIo().in(`server:${ctx.serverId}`).socketsLeave(`server:${ctx.serverId}`);
    res.json({ ok: true });
  }));

  // ---------- Emojis personalizados (enviar fica em files.js)
  r.get('/emojis', wrap(async (req, res) => res.json({ emojis: await emojis.listForUser(req.userId) })));

  r.patch('/servers/:id/emojis/:emojiId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_EMOJIS);
    const name = emojis.cleanName(req.body.name);
    if (!emojis.NAME_RE.test(name)) fail(400, 'O nome do emoji precisa ter de 2 a 32 letras, números ou _.');
    let rows;
    try {
      ({ rows } = await db.query(
        'UPDATE nexo_emojis e SET name = $3 FROM nexo_emojis old WHERE e.id = $1 AND e.server_id = $2 AND old.id = e.id RETURNING e.*, old.name AS old_name',
        [parseId(req.params.emojiId), ctx.serverId, name],
      ));
    } catch (err) {
      if (err.code === '23505') fail(409, `Já existe um emoji chamado :${name}: neste servidor.`);
      throw err;
    }
    if (!rows[0]) fail(404, 'Emoji não encontrado.');
    if (rows[0].old_name !== name) audit(ctx.serverId, req.userId, 'emoji_update', { targetId: rows[0].id, targetName: name, details: { from: rows[0].old_name, to: name } });
    events.serverChanged(ctx.serverId);
    res.json({ emoji: emojis.toJson(rows[0]) });
  }));

  r.delete('/servers/:id/emojis/:emojiId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_EMOJIS);
    const { rows } = await db.query('DELETE FROM nexo_emojis WHERE id = $1 AND server_id = $2 RETURNING *', [parseId(req.params.emojiId), ctx.serverId]);
    if (!rows[0]) fail(404, 'Emoji não encontrado.');
    emojis.removeFile(rows[0].file);
    audit(ctx.serverId, req.userId, 'emoji_delete', { targetId: rows[0].id, targetName: rows[0].name });
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  // ---------- Convites (com validade e limite de usos)

  r.get('/servers/:id/invites', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.CREATE_INVITE);
    const all = ctx.can(P.MANAGE_SERVER);
    const { rows } = await db.query(
      `SELECT i.*, u.display_name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.server_id = $1 AND ${VALID_INVITE} AND ($2 OR i.created_by = $3)
       ORDER BY i.created_at DESC`,
      [ctx.serverId, all, req.userId],
    );
    res.json({ invites: rows.map(inviteJson) });
  }));

  // Corpo: { maxAgeSeconds (0 = nunca expira), maxUses (0 = sem limite), reuse }
  // reuse = true devolve um convite seu igual que ainda vale, em vez de criar outro.
  r.post('/servers/:id/invites', humansOnly, wrap(async (req, res) => {
    const ctx = await requireMember(req, P.CREATE_INVITE);
    const maxAge = Number(req.body.maxAgeSeconds ?? 7 * 24 * 3600);
    const maxUses = Number(req.body.maxUses ?? 0);
    if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 30 * 24 * 3600) fail(400, 'Validade inválida.');
    if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 1000) fail(400, 'Limite de usos inválido.');
    // Convite que já dá um cargo (ex.: "convite de staff"): precisa poder gerenciar cargos.
    let roleId = null;
    if (req.body.roleId) {
      roleId = parseId(req.body.roleId);
      if (!ctx.can(P.MANAGE_ROLES)) fail(403, 'Só quem gerencia cargos pode criar convite com cargo.');
      const { rows: rr } = roleId ? await db.query('SELECT position, is_default FROM roles WHERE id = $1 AND server_id = $2', [roleId, ctx.serverId]) : { rows: [] };
      if (!rr[0] || rr[0].is_default) fail(400, 'Cargo inválido.');
      if (!ctx.isOwner && rr[0].position >= ctx.top) fail(403, 'Você só pode escolher cargos abaixo do seu.');
    }
    if (req.body.reuse && !roleId) {
      const { rows } = await db.query(
        `SELECT i.* FROM invites i WHERE i.server_id = $1 AND i.created_by = $2 AND ${VALID_INVITE}
           AND i.role_id IS NULL AND i.max_uses IS NOT DISTINCT FROM $3 AND (($4 = 0 AND i.expires_at IS NULL)
             OR ($4 > 0 AND i.expires_at > now() + make_interval(secs => $4 * 0.5)))
         ORDER BY i.created_at DESC LIMIT 1`,
        [ctx.serverId, req.userId, maxUses || null, maxAge],
      );
      if (rows[0]) return res.json({ invite: inviteJson(rows[0]) });
    }
    const { rows: n } = await db.query(`SELECT count(*)::int AS n FROM invites i WHERE server_id = $1 AND ${VALID_INVITE}`, [ctx.serverId]);
    if (n[0].n >= 100) fail(400, 'O servidor já tem convites demais. Apague alguns antigos.');
    const { rows } = await db.query(
      `INSERT INTO invites (code, server_id, created_by, max_uses, expires_at, role_id)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int > 0 THEN now() + make_interval(secs => $5::int) END, $6) RETURNING *`,
      [newInviteCode(), ctx.serverId, req.userId, maxUses || null, maxAge, roleId],
    );
    audit(ctx.serverId, req.userId, 'invite_create', { details: { code: rows[0].code, maxUses: maxUses || null, maxAgeSeconds: maxAge || null, roleId } });
    res.status(201).json({ invite: inviteJson(rows[0]) });
  }));

  r.delete('/invites/:code', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM invites WHERE code = $1', [String(req.params.code)]);
    const inv = rows[0];
    const ctx = inv && await memberContext(inv.server_id, req.userId);
    if (!ctx) fail(404, 'Convite não encontrado.');
    if (inv.created_by !== req.userId && !ctx.can(P.MANAGE_SERVER)) fail(403, 'Você não pode apagar esse convite.');
    await db.query('DELETE FROM invites WHERE code = $1', [inv.code]);
    audit(inv.server_id, req.userId, 'invite_delete', { details: { code: inv.code } });
    res.json({ ok: true });
  }));

  const codeFrom = (raw) => String(raw || '').trim().split('/').filter(Boolean).pop() || '';

  r.get('/invites/:code', humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.icon_id, s.banner_id, ${VALID_INVITE} AS valid,
         (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count,
         EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2) AS is_member
       FROM invites i JOIN servers s ON s.id = i.server_id WHERE i.code = $1`,
      [codeFrom(req.params.code), req.userId],
    );
    const row = rows[0];
    if (!row || (!row.valid && !row.is_member)) fail(404, 'Convite inválido ou expirado.');
    res.json({
      server: { id: row.id, name: row.name, iconUrl: S.avatarUrl(row.icon_id), bannerUrl: S.avatarUrl(row.banner_id) },
      memberCount: row.member_count,
      isMember: row.is_member,
    });
  }));

  r.post('/servers/join', humansOnly, wrap(async (req, res) => {
    const code = codeFrom(req.body.code);
    const { rows } = await db.query(
      `SELECT s.* FROM invites i JOIN servers s ON s.id = i.server_id WHERE i.code = $1`,
      [code],
    );
    const server = rows[0];
    if (!server) fail(404, 'Convite inválido ou expirado.');
    const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [server.id, req.userId]);
    if (member.rowCount === 0) {
      const ban = await db.query('SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2', [server.id, req.userId]);
      if (ban.rowCount) fail(403, 'Você foi banido deste servidor.');
    }

    const joined = member.rowCount === 0 && await db.transaction(async (c) => {
      // Conta um uso do convite (e confere validade/limite no mesmo passo).
      const used = await c.query(
        `UPDATE invites i SET uses = uses + 1 WHERE code = $1 AND ${VALID_INVITE} RETURNING code, role_id`,
        [code],
      );
      if (!used.rowCount) fail(404, 'Convite inválido ou expirado.');
      const needsOnboarding = !!(server.onboarding && server.onboarding.enabled);
      const ins = await c.query(
        `INSERT INTO server_members (server_id, user_id, onboarded_at) VALUES ($1, $2, CASE WHEN $3 THEN NULL ELSE now() END)
         ON CONFLICT DO NOTHING`,
        [server.id, req.userId, needsOnboarding],
      );
      if (ins.rowCount === 0) fail(409, 'Você já está nesse servidor.');
      // Convite com cargo: já entra com ele.
      if (used.rows[0].role_id) {
        await c.query(
          `INSERT INTO member_roles (server_id, user_id, role_id)
           SELECT $1, $2, r.id FROM roles r WHERE r.id = $3 AND r.server_id = $1 AND NOT r.is_default ON CONFLICT DO NOTHING`,
          [server.id, req.userId, used.rows[0].role_id],
        );
      }
      await markServerRead(c, server.id, req.userId);
      return true;
    }).catch((err) => {
      if (err.status === 409) return false;
      throw err;
    });

    events.getIo().in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);
    if (joined) await automod.onMemberJoined(server.id, req.userId).catch((err) => console.error('Erro nas boas-vindas:', err.message));
    if (joined) events.serverChanged(server.id);
    res.json({ server: S.server(server) });
  }));

  // ---------- Canais e categorias

  r.post('/servers/:id/channels', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_CHANNELS);
    const kind = ['voice', 'category', 'forum'].includes(req.body.kind) ? req.body.kind : 'text';
    const name = kind === 'category' ? cleanFreeName(req.body.name, 60) : normalizeChannelName(req.body.name);
    if (!name) fail(400, kind === 'category' ? 'Dê um nome à categoria.' : 'Dê um nome ao canal.');
    const { rows: count } = await db.query("SELECT count(*)::int AS n FROM channels WHERE server_id = $1 AND kind <> 'thread'", [ctx.serverId]);
    if (count[0].n >= MAX_CHANNELS) fail(400, `O servidor pode ter no máximo ${MAX_CHANNELS} canais.`);
    const categoryId = kind === 'category' ? null : await categoryOf(ctx.serverId, req.body.categoryId);
    const isPrivate = kind !== 'category' && !!req.body.private;
    const roleIds = isPrivate ? await cleanRoleIds(ctx.serverId, req.body.roleIds) : [];

    const channel = await db.transaction(async (c) => {
      const position = await nextPosition(c, ctx.serverId, categoryId, kind === 'category');
      const { rows } = await c.query(
        `INSERT INTO channels (server_id, name, kind, position, category_id, private, topic, announce, waiting_room, is_clips)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [ctx.serverId, name, kind, position, categoryId, isPrivate, kind === 'forum' ? cleanTopic(req.body.topic) : null, kind === 'text' && !!req.body.announce, kind === 'voice' && !!req.body.waitingRoom, kind === 'text' && !!req.body.isClips],
      );
      for (const roleId of roleIds) await c.query('INSERT INTO channel_roles (channel_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
      return rows[0];
    });
    audit(ctx.serverId, req.userId, kind === 'category' ? 'category_create' : 'channel_create', {
      targetId: channel.id, targetName: name, details: { kind, private: isPrivate },
    });
    events.serverChanged(ctx.serverId);
    res.status(201).json({ channel: S.channel(channel) });
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
    if (!ctx.isAdmin && rows[0].kind !== 'category') {
      const visible = await visibleChannelIds(rows[0].server_id, req.userId, false);
      if (!visible.includes(rows[0].id)) fail(404, 'Canal não encontrado.');
    }
    return { channel: rows[0], ctx };
  }

  // Corpo: { name?, private?, roleIds?, categoryId? }
  r.patch('/channels/:channelId', wrap(async (req, res) => {
    const { channel, ctx } = await channelForManage(req);
    const b = req.body || {};
    const sets = [];
    const vals = [channel.id];
    const changes = {};
    if (b.name !== undefined) {
      const name = channel.kind === 'thread' ? cleanFreeName(b.name)
        : channel.kind === 'category' ? cleanFreeName(b.name, 60) : normalizeChannelName(b.name);
      if (!name) fail(400, 'Dê um nome ao canal.');
      if (name !== channel.name) changes.name = { from: channel.name, to: name };
      vals.push(name); sets.push(`name = $${vals.length}`);
    }
    const canStructure = ctx.can(P.MANAGE_CHANNELS) && ['text', 'voice', 'forum'].includes(channel.kind);
    let roleIds = null;
    if (canStructure && b.private !== undefined) {
      vals.push(!!b.private); sets.push(`private = $${vals.length}`);
      if (!!b.private !== channel.private) changes.private = !!b.private;
    }
    if (canStructure && b.roleIds !== undefined) roleIds = await cleanRoleIds(channel.server_id, b.roleIds);
    if (ctx.can(P.MANAGE_CHANNELS) && channel.kind === 'text' && b.announce !== undefined) {
      vals.push(!!b.announce); sets.push(`announce = $${vals.length}`);
      if (!!b.announce !== channel.announce) changes.announce = !!b.announce;
    }
    if (ctx.can(P.MANAGE_CHANNELS) && channel.kind === 'forum' && b.topic !== undefined) {
      vals.push(cleanTopic(b.topic)); sets.push(`topic = $${vals.length}`);
    }
    if (ctx.can(P.MANAGE_CHANNELS) && channel.kind === 'text' && b.isClips !== undefined) {
      vals.push(!!b.isClips); sets.push(`is_clips = $${vals.length}`);
      if (!!b.isClips !== channel.is_clips) changes.isClips = !!b.isClips;
    }
    // Modo lento: quem modera também pode ligar na hora (MANAGE_MESSAGES), não só quem cria canais.
    if ((ctx.can(P.MANAGE_CHANNELS) || ctx.can(P.MANAGE_MESSAGES)) && channel.kind === 'text' && b.slowmode !== undefined) {
      const secs = Number(b.slowmode);
      if (!SLOWMODE.includes(secs)) fail(400, 'Tempo do modo lento inválido.');
      vals.push(secs); sets.push(`slowmode_seconds = $${vals.length}`);
      if (secs !== (channel.slowmode_seconds || 0)) changes.slowmode = secs;
    }
    if (ctx.can(P.MANAGE_CHANNELS) && channel.kind === 'voice' && b.waitingRoom !== undefined) {
      vals.push(!!b.waitingRoom); sets.push(`waiting_room = $${vals.length}`);
      if (!!b.waitingRoom !== channel.waiting_room) changes.waitingRoom = !!b.waitingRoom;
    }
    if (ctx.can(P.MANAGE_CHANNELS) && channel.kind === 'voice' && b.stage !== undefined) {
      vals.push(!!b.stage); sets.push(`stage = $${vals.length}`);
      if (!!b.stage !== channel.stage) changes.stage = !!b.stage;
    }
    if (canStructure && b.categoryId !== undefined) {
      const categoryId = await categoryOf(channel.server_id, b.categoryId);
      if (categoryId !== channel.category_id) {
        vals.push(categoryId); sets.push(`category_id = $${vals.length}`);
        vals.push(await nextPosition(db, channel.server_id, categoryId, false)); sets.push(`position = $${vals.length}`);
      }
    }
    const updated = await db.transaction(async (c) => {
      const { rows } = sets.length
        ? await c.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)
        : await c.query('SELECT * FROM channels WHERE id = $1', [channel.id]);
      if (roleIds) {
        await c.query('DELETE FROM channel_roles WHERE channel_id = $1', [channel.id]);
        for (const roleId of roleIds) await c.query('INSERT INTO channel_roles (channel_id, role_id) VALUES ($1, $2)', [channel.id, roleId]);
        changes.roles = roleIds.length;
      }
      return rows[0];
    });
    if (Object.keys(changes).length && channel.kind !== 'thread') {
      audit(channel.server_id, req.userId, channel.kind === 'category' ? 'category_update' : 'channel_update', {
        targetId: channel.id, targetName: updated.name, details: changes,
      });
    }
    events.serverChanged(channel.server_id);
    if (channel.kind === 'thread') M.refreshThreadParent(channel).catch(() => {});
    res.json({ channel: S.channel(updated) });
  }));

  // Arrastar e soltar: põe o canal numa categoria, antes de outro canal (ou no fim).
  // Corpo: { categoryId: id ou null, beforeId: id ou null }. Para categorias, só beforeId.
  r.post('/channels/:channelId/move', wrap(async (req, res) => {
    const { channel, ctx } = await channelForManage(req);
    if (!ctx.can(P.MANAGE_CHANNELS) || !['text', 'voice', 'forum', 'category'].includes(channel.kind)) fail(403, 'Você não pode mover esse canal.');
    const isCategory = channel.kind === 'category';
    const categoryId = isCategory ? null : await categoryOf(channel.server_id, req.body.categoryId);
    const beforeId = req.body.beforeId ? parseId(req.body.beforeId) : null;
    await db.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(4243, $1)', [channel.server_id]);
      const { rows } = isCategory
        ? await c.query("SELECT id FROM channels WHERE server_id = $1 AND kind = 'category' ORDER BY position, id", [channel.server_id])
        : await c.query(
          `SELECT id FROM channels WHERE server_id = $1 AND kind IN ('text', 'voice', 'forum')
             AND category_id IS NOT DISTINCT FROM $2 ORDER BY position, id`,
          [channel.server_id, categoryId],
        );
      const order = rows.map((x) => x.id).filter((id) => id !== channel.id);
      const at = beforeId ? order.indexOf(beforeId) : -1;
      if (beforeId && at === -1) fail(400, 'Posição inválida.');
      order.splice(at === -1 ? order.length : at, 0, channel.id);
      if (!isCategory) await c.query('UPDATE channels SET category_id = $2 WHERE id = $1', [channel.id, categoryId]);
      for (let i = 0; i < order.length; i++) await c.query('UPDATE channels SET position = $2 WHERE id = $1', [order[i], i]);
    });
    events.serverChanged(channel.server_id);
    res.json({ ok: true });
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
    if (channel.kind !== 'thread') {
      audit(channel.server_id, req.userId, channel.kind === 'category' ? 'category_delete' : 'channel_delete', {
        targetId: channel.id, targetName: channel.name,
      });
    }
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
    const { rows: count } = await db.query('SELECT count(*)::int AS n FROM roles WHERE server_id = $1', [ctx.serverId]);
    if (count[0].n >= 100) fail(400, 'O servidor pode ter no máximo 100 cargos.');

    // Cargo novo entra logo acima do @everyone (posição 1); os outros sobem um degrau.
    const role = await db.transaction(async (c) => {
      await c.query('UPDATE roles SET position = position + 1 WHERE server_id = $1 AND NOT is_default', [ctx.serverId]);
      const { rows } = await c.query(
        'INSERT INTO roles (server_id, name, color, permissions, position) VALUES ($1, $2, $3, $4, 1) RETURNING *',
        [ctx.serverId, name, color, perms],
      );
      return rows[0];
    });
    audit(ctx.serverId, req.userId, 'role_create', { targetId: role.id, targetName: name });
    events.serverChanged(ctx.serverId);
    res.status(201).json({ role: S.role(role) });
  }));

  // Arrastar e soltar cargos: { roleIds: [do mais alto para o mais baixo] } (sem o @everyone).
  // Cargos acima do seu (ou no seu nível) não podem mudar de lugar.
  r.put('/servers/:id/roles/order', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const wanted = (Array.isArray(req.body.roleIds) ? req.body.roleIds : []).map(Number);
    await db.transaction(async (c) => {
      const { rows } = await c.query('SELECT id, position FROM roles WHERE server_id = $1 AND NOT is_default FOR UPDATE', [ctx.serverId]);
      const current = new Map(rows.map((x) => [x.id, x.position]));
      if (wanted.length !== rows.length || new Set(wanted).size !== wanted.length || wanted.some((id) => !current.has(id))) {
        fail(400, 'Lista de cargos desatualizada. Recarregue e tente de novo.');
      }
      const n = wanted.length;
      wanted.forEach((id, i) => {
        const pos = n - i;
        const old = current.get(id);
        if ((old >= ctx.top || pos >= ctx.top) && old !== pos) fail(403, 'Você só pode reordenar cargos abaixo do seu cargo mais alto.');
      });
      for (let i = 0; i < n; i++) await c.query('UPDATE roles SET position = $2 WHERE id = $1', [wanted[i], n - i]);
    });
    audit(ctx.serverId, req.userId, 'role_reorder');
    events.serverChanged(ctx.serverId);
    res.json({ ok: true });
  }));

  r.patch('/servers/:id/roles/:roleId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MANAGE_ROLES);
    const role = await getRole(ctx.serverId, parseId(req.params.roleId));
    assertCanManageRole(ctx, role);

    const sets = [];
    const vals = [role.id];
    const changes = {};
    if (req.body.name !== undefined && !role.is_default) {
      const name = String(req.body.name).trim().slice(0, 32);
      if (!name) fail(400, 'Dê um nome ao cargo.');
      if (name !== role.name) changes.name = { from: role.name, to: name };
      vals.push(name); sets.push(`name = $${vals.length}`);
    }
    if (req.body.color !== undefined && !role.is_default) {
      const color = req.body.color && COLOR_RE.test(req.body.color) ? req.body.color.toLowerCase() : null;
      if (color !== role.color) changes.color = color;
      vals.push(color); sets.push(`color = $${vals.length}`);
    }
    // Emoji do cargo (aparece do lado do nome).
    if (req.body.icon !== undefined && !role.is_default) {
      const icon = cleanRoleIcon(req.body.icon);
      if (icon !== role.icon) changes.icon = icon;
      vals.push(icon); sets.push(`icon = $${vals.length}`);
    }
    // Segunda cor: o nome aparece em degradê.
    if (req.body.color2 !== undefined && !role.is_default) {
      const color2 = req.body.color2 && COLOR_RE.test(req.body.color2) ? req.body.color2.toLowerCase() : null;
      if (color2 !== role.color2) changes.color2 = color2;
      vals.push(color2); sets.push(`color2 = $${vals.length}`);
    }
    if (req.body.permissions !== undefined) {
      const perms = parsePerms(req.body.permissions);
      // Só valida os bits que estão mudando.
      assertPermsAllowed(ctx, perms ^ Number(role.permissions));
      if (perms !== Number(role.permissions)) changes.permissions = { from: Number(role.permissions), to: perms };
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
    if (Object.keys(changes).length) audit(ctx.serverId, req.userId, 'role_update', { targetId: role.id, targetName: role.name, details: changes });

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
    audit(ctx.serverId, req.userId, 'role_delete', { targetId: role.id, targetName: role.name });
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
    const ban = await db.query('SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2', [ctx.serverId, bot.id]);
    if (ban.rowCount) fail(403, 'Esse bot está banido deste servidor.');
    const added = await db.transaction(async (c) => {
      const ins = await c.query(
        'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ctx.serverId, bot.id],
      );
      if (ins.rowCount > 0) await markServerRead(c, ctx.serverId, bot.id);
      return ins.rowCount > 0;
    });
    if (!added) fail(409, 'Esse bot já está no servidor.');
    audit(ctx.serverId, req.userId, 'bot_add', { targetId: bot.id, targetName: bot.display_name });
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
    if (add.length || remove.length) {
      audit(ctx.serverId, req.userId, 'member_roles', {
        targetId, targetName: await userName(targetId),
        details: { added: add.map((id) => byId.get(id).name), removed: remove.map((id) => byId.get(id).name) },
      });
    }
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
    const target = await assertCanModerate(ctx, targetId);
    if (!target) fail(404, 'Membro não encontrado.');
    await removeMember(ctx.serverId, targetId, 'kicked');
    audit(ctx.serverId, req.userId, 'member_kick', {
      targetId, targetName: await userName(targetId), details: { reason: String(req.body?.reason || '').slice(0, 300) || null },
    });
    res.json({ ok: true });
  }));

  // ---------- Castigo (timeout): { minutes } — 0 tira o castigo.
  r.put('/servers/:id/members/:userId/timeout', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.MODERATE_MEMBERS);
    const targetId = parseId(req.params.userId);
    const target = targetId && await assertCanModerate(ctx, targetId);
    if (!target) fail(404, 'Membro não encontrado.');
    if (target.isAdmin) fail(403, 'Administradores não podem ser castigados.');
    const minutes = Number(req.body.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 28 * 24 * 60) fail(400, 'Duração inválida (máximo 28 dias).');
    const reason = String(req.body.reason || '').slice(0, 300) || null;
    const { rows } = await db.query(
      `UPDATE server_members SET timeout_until = CASE WHEN $3::real > 0 THEN now() + make_interval(secs => $3::real * 60) END
       WHERE server_id = $1 AND user_id = $2 RETURNING timeout_until`,
      [ctx.serverId, targetId, minutes],
    );
    if (minutes > 0) voice.leaveServer(targetId, ctx.serverId);
    audit(ctx.serverId, req.userId, minutes > 0 ? 'member_timeout' : 'member_timeout_remove', {
      targetId, targetName: await userName(targetId), details: minutes > 0 ? { minutes, reason } : {},
    });
    events.serverChanged(ctx.serverId);
    res.json({ timeoutUntil: rows[0].timeout_until });
  }));

  // ---------- Banimentos
  r.get('/servers/:id/bans', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.BAN_MEMBERS);
    const { rows } = await db.query(
      `SELECT b.*, u.username, u.display_name, u.is_bot, u.avatar_id, by.display_name AS banned_by_name
       FROM server_bans b JOIN users u ON u.id = b.user_id LEFT JOIN users by ON by.id = b.banned_by
       WHERE b.server_id = $1 ORDER BY b.created_at DESC`,
      [ctx.serverId],
    );
    res.json({
      bans: rows.map((b) => ({
        user: S.user({ id: b.user_id, username: b.username, display_name: b.display_name, is_bot: b.is_bot, avatar_id: b.avatar_id }),
        reason: b.reason, createdAt: b.created_at, bannedBy: b.banned_by_name || null,
      })),
    });
  }));

  // Corpo: { reason?, deleteMessagesHours? (0, 1, 24 ou 168) }
  r.put('/servers/:id/bans/:userId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.BAN_MEMBERS);
    const targetId = parseId(req.params.userId);
    const exists = targetId && await db.query('SELECT id, display_name FROM users WHERE id = $1', [targetId]);
    if (!exists || !exists.rows[0]) fail(404, 'Usuário não encontrado.');
    const target = await assertCanModerate(ctx, targetId);
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    const hours = [0, 1, 24, 168].includes(Number(req.body.deleteMessagesHours)) ? Number(req.body.deleteMessagesHours) : 0;
    await db.query(
      `INSERT INTO server_bans (server_id, user_id, banned_by, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (server_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by`,
      [ctx.serverId, targetId, req.userId, reason],
    );
    if (target) await removeMember(ctx.serverId, targetId, 'banned');
    if (hours > 0) {
      const { rows } = await db.query(
        `SELECT m.id, m.channel_id FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE c.server_id = $1 AND m.author_id = $2 AND m.created_at > now() - make_interval(hours => $3::int)`,
        [ctx.serverId, targetId, hours],
      );
      for (const m of rows) {
        await M.deleteMessage(m.id);
        events.emitTo([`server:${ctx.serverId}`], 'message:deleted', { id: String(m.id), channelId: m.channel_id });
      }
    }
    audit(ctx.serverId, req.userId, 'member_ban', {
      targetId, targetName: exists.rows[0].display_name, details: { reason, deletedHours: hours || null },
    });
    res.json({ ok: true });
  }));

  r.delete('/servers/:id/bans/:userId', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.BAN_MEMBERS);
    const targetId = parseId(req.params.userId);
    const { rowCount } = await db.query('DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2', [ctx.serverId, targetId]);
    if (!rowCount) fail(404, 'Esse usuário não está banido.');
    audit(ctx.serverId, req.userId, 'member_unban', { targetId, targetName: await userName(targetId) });
    res.json({ ok: true });
  }));

  // ---------- Registro de auditoria (50 por página, ?before=<id>)
  r.get('/servers/:id/audit', wrap(async (req, res) => {
    const ctx = await requireMember(req, P.VIEW_AUDIT_LOG);
    const before = /^\d{1,18}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
    const { rows } = await db.query(
      `SELECT a.*, u.username, u.display_name, u.is_bot, u.avatar_id FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.server_id = $1 AND ($2::bigint IS NULL OR a.id < $2::bigint)
       ORDER BY a.id DESC LIMIT 50`,
      [ctx.serverId, before],
    );
    res.json({
      entries: rows.map((a) => ({
        id: String(a.id),
        action: a.action,
        actor: a.actor_id ? S.user({ id: a.actor_id, username: a.username, display_name: a.display_name, is_bot: a.is_bot, avatar_id: a.avatar_id }) : null,
        targetId: a.target_id,
        targetName: a.target_name,
        details: a.details || {},
        createdAt: a.created_at,
      })),
      hasMore: rows.length === 50,
    });
  }));
};

module.exports.removeMember = removeMember;
