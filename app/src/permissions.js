// Permissões no estilo "bits": cada permissão é um bit de um número.
// Um membro tem a soma (OR) das permissões do @everyone + dos cargos dele.
const db = require('./db');

const P = {
  ADMINISTRATOR:    1 << 0,  // tudo liberado
  MANAGE_SERVER:    1 << 1,  // renomear servidor, trocar convite
  MANAGE_ROLES:     1 << 2,  // criar/editar cargos e dar cargos a membros
  MANAGE_CHANNELS:  1 << 3,  // criar/renomear/apagar canais
  KICK_MEMBERS:     1 << 4,  // expulsar membros
  CREATE_INVITE:    1 << 5,  // ver e compartilhar o convite
  SEND_MESSAGES:    1 << 6,
  ATTACH_FILES:     1 << 7,
  ADD_REACTIONS:    1 << 8,
  MENTION_EVERYONE: 1 << 9,  // usar @everyone
  MANAGE_MESSAGES:  1 << 10, // apagar mensagens dos outros
  CONNECT:          1 << 11, // entrar em canais de voz
  SPEAK:            1 << 12, // falar nos canais de voz
  VIDEO:            1 << 13, // câmera e compartilhar tela
};

const ALL = Object.values(P).reduce((a, b) => a | b, 0);
const DEFAULT_EVERYONE = P.CREATE_INVITE | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS
  | P.CONNECT | P.SPEAK | P.VIDEO;
const DM_PERMS = P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS;

const has = (perms, flag) => (perms & P.ADMINISTRATOR) !== 0 || (perms & flag) === flag;

// Situação de um usuário dentro de um servidor. null = não é membro.
// top = posição do cargo mais alto (dono = Infinity). Só dá para mexer em quem/o que está abaixo.
async function memberContext(serverId, userId) {
  const { rows } = await db.query(
    `SELECT s.owner_id,
            COALESCE(bit_or(r.permissions), 0) AS perms,
            COALESCE(max(r.position) FILTER (WHERE NOT r.is_default), 0) AS top
     FROM servers s
     JOIN server_members m ON m.server_id = s.id AND m.user_id = $2
     LEFT JOIN roles r ON r.server_id = s.id AND (
       r.is_default OR r.id IN (SELECT role_id FROM member_roles WHERE server_id = s.id AND user_id = $2)
     )
     WHERE s.id = $1
     GROUP BY s.owner_id`,
    [serverId, userId],
  );
  if (!rows[0]) return null;
  const isOwner = rows[0].owner_id === userId;
  let perms = Number(rows[0].perms);
  if (isOwner || (perms & P.ADMINISTRATOR)) perms = ALL;
  return {
    serverId,
    userId,
    isOwner,
    perms,
    top: isOwner ? Infinity : Number(rows[0].top),
    can: (flag) => has(perms, flag),
  };
}

// Acesso a um canal (de servidor ou DM). null = sem acesso.
async function channelAccess(channelId, userId) {
  const { rows } = await db.query('SELECT id, server_id, kind, name FROM channels WHERE id = $1', [channelId]);
  const channel = rows[0];
  if (!channel) return null;

  if (channel.kind === 'dm') {
    const m = await db.query('SELECT user_id FROM dm_members WHERE channel_id = $1', [channelId]);
    const memberIds = m.rows.map((r) => r.user_id);
    if (!memberIds.includes(userId)) return null;
    return {
      channel, kind: 'dm', serverId: null, memberIds, perms: DM_PERMS,
      rooms: memberIds.map((id) => `user:${id}`),
      can: (flag) => has(DM_PERMS, flag),
    };
  }

  const ctx = await memberContext(channel.server_id, userId);
  if (!ctx) return null;
  return { ...ctx, channel, kind: channel.kind, serverId: channel.server_id, rooms: [`server:${channel.server_id}`] };
}

module.exports = { P, ALL, DEFAULT_EVERYONE, DM_PERMS, has, memberContext, channelAccess };
