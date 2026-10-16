// Permissões no estilo "bits": cada permissão é um bit de um número.
// Um membro tem a soma (OR) das permissões do @everyone + dos cargos dele.
const db = require('./db');

const P = {
  ADMINISTRATOR:    1 << 0,  // tudo liberado
  MANAGE_SERVER:    1 << 1,  // renomear servidor, ícone, convites dos outros
  MANAGE_ROLES:     1 << 2,  // criar/editar cargos e dar cargos a membros
  MANAGE_CHANNELS:  1 << 3,  // criar/renomear/apagar/reordenar canais
  KICK_MEMBERS:     1 << 4,  // expulsar membros
  CREATE_INVITE:    1 << 5,  // criar convites
  SEND_MESSAGES:    1 << 6,
  ATTACH_FILES:     1 << 7,
  ADD_REACTIONS:    1 << 8,
  MENTION_EVERYONE: 1 << 9,  // usar @everyone
  MANAGE_MESSAGES:  1 << 10, // apagar/fixar mensagens dos outros
  CONNECT:          1 << 11, // entrar em canais de voz
  SPEAK:            1 << 12, // falar nos canais de voz
  VIDEO:            1 << 13, // câmera e compartilhar tela
  BAN_MEMBERS:      1 << 14, // banir (expulsar e impedir de voltar)
  MODERATE_MEMBERS: 1 << 15, // castigar (só ler por um tempo)
  VIEW_AUDIT_LOG:   1 << 16, // ver o registro de auditoria
  MANAGE_EMOJIS:    1 << 17, // enviar, renomear e apagar emojis do servidor
  CREATE_EVENTS:    1 << 18, // criar eventos (e editar os próprios)
  MANAGE_EVENTS:    1 << 19, // editar e apagar eventos dos outros
  MANAGE_STAGE:     1 << 20, // moderar o palco: chamar para falar e mandar de volta à plateia
};

const ALL = Object.values(P).reduce((a, b) => a | b, 0);
const DEFAULT_EVERYONE = P.CREATE_INVITE | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS
  | P.CONNECT | P.SPEAK | P.VIDEO | P.CREATE_EVENTS;
// Em DM: mensagens, anexos, reações e chamadas de voz/vídeo.
const DM_PERMS = P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.VIDEO;
// O que alguém de castigo deixa de poder fazer (continua lendo).
const TIMEOUT_BLOCKED = P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.MENTION_EVERYONE
  | P.CONNECT | P.SPEAK | P.VIDEO | P.CREATE_INVITE | P.CREATE_EVENTS;

const has = (perms, flag) => (perms & P.ADMINISTRATOR) !== 0 || (perms & flag) === flag;

// Situação de um usuário dentro de um servidor. null = não é membro.
// top = posição do cargo mais alto (dono = Infinity). Só dá para mexer em quem/o que está abaixo.
async function memberContext(serverId, userId) {
  const { rows } = await db.query(
    `SELECT s.owner_id, m.timeout_until,
            COALESCE(bit_or(r.permissions), 0) AS perms,
            COALESCE(max(r.position) FILTER (WHERE NOT r.is_default), 0) AS top
     FROM servers s
     JOIN server_members m ON m.server_id = s.id AND m.user_id = $2
     LEFT JOIN roles r ON r.server_id = s.id AND (
       r.is_default OR r.id IN (SELECT role_id FROM member_roles WHERE server_id = s.id AND user_id = $2)
     )
     WHERE s.id = $1
     GROUP BY s.owner_id, m.timeout_until`,
    [serverId, userId],
  );
  if (!rows[0]) return null;
  const isOwner = rows[0].owner_id === userId;
  let perms = Number(rows[0].perms);
  const isAdmin = isOwner || (perms & P.ADMINISTRATOR) !== 0;
  if (isAdmin) perms = ALL;
  const timeoutUntil = rows[0].timeout_until && new Date(rows[0].timeout_until) > new Date() ? rows[0].timeout_until : null;
  if (timeoutUntil && !isAdmin) perms &= ~TIMEOUT_BLOCKED;
  return {
    serverId,
    userId,
    isOwner,
    isAdmin,
    perms,
    timeoutUntil,
    top: isOwner ? Infinity : Number(rows[0].top),
    can: (flag) => has(perms, flag),
  };
}

// ---------- Canais privados
// Uma thread segue a privacidade do canal onde ela nasceu.
// Trecho SQL: "o usuário $u vê o canal c?" (p = canal pai da thread, $a = é admin/dono).
const VISIBLE_SQL = (c, p, u, a) => `(${a} OR NOT COALESCE(${p}.private, ${c}.private) OR EXISTS (
  SELECT 1 FROM channel_roles cr JOIN member_roles mr ON mr.role_id = cr.role_id AND mr.user_id = ${u}
  WHERE cr.channel_id = COALESCE(${p}.id, ${c}.id)))`;

// IDs dos canais (de um servidor) que o usuário consegue ver.
async function visibleChannelIds(serverId, userId, isAdmin) {
  const { rows } = await db.query(
    `SELECT c.id FROM channels c LEFT JOIN channels p ON p.id = c.parent_channel_id
     WHERE c.server_id = $1 AND ${VISIBLE_SQL('c', 'p', '$2', '$3')}`,
    [serverId, userId, !!isAdmin],
  );
  return rows.map((r) => r.id);
}

// O canal (ou o pai, se for thread) é privado? Devolve o id que define a privacidade, ou null.
async function privacyRoot(channel) {
  if (channel.kind === 'thread' && channel.parent_channel_id) {
    const { rows } = await db.query('SELECT id, private FROM channels WHERE id = $1', [channel.parent_channel_id]);
    return rows[0] && rows[0].private ? rows[0].id : null;
  }
  return channel.private ? channel.id : null;
}

// Quem enxerga um canal privado: dono, administradores e quem tem um dos cargos liberados.
async function privateViewerIds(serverId, rootChannelId) {
  const { rows } = await db.query(
    `SELECT m.user_id FROM server_members m JOIN servers s ON s.id = m.server_id
     WHERE m.server_id = $1 AND (
       m.user_id = s.owner_id
       OR EXISTS (SELECT 1 FROM roles r WHERE r.server_id = $1 AND r.is_default AND (r.permissions & 1) = 1)
       OR EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                  WHERE mr.server_id = $1 AND mr.user_id = m.user_id AND (r.permissions & 1) = 1)
       OR EXISTS (SELECT 1 FROM channel_roles cr JOIN member_roles mr ON mr.role_id = cr.role_id
                  WHERE cr.channel_id = $2 AND mr.server_id = $1 AND mr.user_id = m.user_id))`,
    [serverId, rootChannelId],
  );
  return rows.map((r) => r.user_id);
}

// Salas do socket que devem receber os eventos de um canal de servidor.
// Canal público: a sala do servidor. Canal privado: só a sala de quem vê.
async function roomsForChannel(channel) {
  const root = await privacyRoot(channel);
  if (!root) return { rooms: [`server:${channel.server_id}`], viewerIds: null };
  const viewerIds = await privateViewerIds(channel.server_id, root);
  return { rooms: viewerIds.map((id) => `user:${id}`), viewerIds };
}

const CHANNEL_COLS = 'id, server_id, kind, name, dm_key, private, stage, announce, waiting_room, disappearing_seconds, is_clips, slowmode_seconds, category_id, parent_channel_id, parent_message_id, created_by';

// Acesso a um canal (de servidor ou DM). null = sem acesso.
async function channelAccess(channelId, userId) {
  const { rows } = await db.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1`, [channelId]);
  const channel = rows[0];
  if (!channel || channel.kind === 'category') return null;

  if (channel.kind === 'dm') {
    const m = await db.query('SELECT user_id FROM dm_members WHERE channel_id = $1', [channelId]);
    const memberIds = m.rows.map((r) => r.user_id);
    if (!memberIds.includes(userId)) return null;
    return {
      channel, kind: 'dm', serverId: null, memberIds, perms: DM_PERMS, viewerIds: memberIds,
      isGroup: !channel.dm_key,
      rooms: memberIds.map((id) => `user:${id}`),
      can: (flag) => has(DM_PERMS, flag),
    };
  }

  const ctx = await memberContext(channel.server_id, userId);
  if (!ctx) return null;
  const { rooms, viewerIds } = await roomsForChannel(channel);
  if (viewerIds && !ctx.isAdmin && !viewerIds.includes(userId)) return null;
  return { ...ctx, channel, kind: channel.kind, serverId: channel.server_id, rooms, viewerIds };
}

module.exports = {
  P, ALL, DEFAULT_EVERYONE, DM_PERMS, TIMEOUT_BLOCKED, has, memberContext, channelAccess,
  visibleChannelIds, roomsForChannel, VISIBLE_SQL, CHANNEL_COLS,
};
