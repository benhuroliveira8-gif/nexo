// Converte linhas do banco no formato JSON que o navegador recebe.

const user = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
});

const server = (row, { showInvite = true } = {}) => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  inviteCode: showInvite ? row.invite_code : null,
});

const channel = (row) => ({
  id: row.id,
  serverId: row.server_id,
  name: row.name,
  position: row.position,
  kind: row.kind || 'text',
});

const role = (row) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  permissions: Number(row.permissions),
  position: row.position,
  isDefault: row.is_default,
});

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm']);

const attachment = (row) => ({
  id: row.id,
  filename: row.filename,
  contentType: row.content_type,
  size: row.size,
  url: `/files/${row.id}/${encodeURIComponent(row.filename)}`,
  kind: IMAGE_TYPES.has(row.content_type) ? 'image'
    : row.content_type.startsWith('video/') && MEDIA_TYPES.has(row.content_type) ? 'video'
    : row.content_type.startsWith('audio/') && MEDIA_TYPES.has(row.content_type) ? 'audio'
    : 'file',
});

// Espera colunas da mensagem + author_username/author_display_name (via JOIN).
// "extras" traz anexos, reações e menções já carregados (ver messages.js).
const message = (row, extras = {}) => ({
  id: String(row.id),
  channelId: row.channel_id,
  serverId: row.server_id ?? null,
  content: row.content,
  createdAt: row.created_at,
  editedAt: row.edited_at || null,
  mentionEveryone: !!row.mention_everyone,
  mentions: extras.mentions || [],
  attachments: (extras.attachments || []).map(attachment),
  reactions: extras.reactions || [],
  author: row.author_id
    ? { id: row.author_id, username: row.author_username, displayName: row.author_display_name }
    : { id: null, username: 'deletado', displayName: 'Usuário removido' },
});

module.exports = { user, server, channel, role, attachment, message, MEDIA_TYPES };
