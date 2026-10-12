// Converte linhas do banco no formato JSON que o navegador recebe.

const avatarUrl = (id) => (id ? `/avatars/${id}` : null);

const user = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  isBot: !!row.is_bot,
  avatarUrl: avatarUrl(row.avatar_id),
});

// O próprio usuário vê o status que escolheu (inclusive "invisível").
const me = (row) => ({
  ...user(row),
  status: row.status || 'online',
  statusText: row.status_text || null,
  statusExpiresAt: row.status_expires_at || null,
  about: row.about || null,
  bannerUrl: avatarUrl(row.banner_id),
  profileColor: row.profile_color || null,
  activity: row.activity || null,
  dndSchedule: row.dnd_schedule || null,
  twoFactor: !!row.totp_enabled,
  isAdmin: !!row.is_admin,
  hasRecoveryKey: !!row.recovery_key_hash,
  lastfmUser: row.lastfm_user || null,
});

const server = (row) => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  iconUrl: avatarUrl(row.icon_id),
  bannerUrl: avatarUrl(row.banner_id),
});

const channel = (row) => ({
  id: row.id,
  serverId: row.server_id,
  name: row.name,
  position: row.position,
  kind: row.kind || 'text',
  categoryId: row.category_id || null,
  private: !!row.private,
  stage: !!row.stage,
  ...(row.kind === 'text' ? { announce: !!row.announce } : {}),
  ...(row.kind === 'voice' ? { waitingRoom: !!row.waiting_room } : {}),
  ...(row.kind === 'thread' ? { solved: !!row.solved, pinned: !!row.pinned } : {}),
  ...(row.kind === 'forum' ? { topic: row.topic || null } : {}),
  parentChannelId: row.parent_channel_id || null,
  parentMessageId: row.parent_message_id ? String(row.parent_message_id) : null,
  createdBy: row.created_by || null,
});

const role = (row) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  color2: row.color2 || null,
  icon: row.icon || null,
  permissions: Number(row.permissions),
  position: row.position,
  isDefault: row.is_default,
});

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4']);

const attachment = (row) => ({
  id: row.id,
  filename: row.filename,
  contentType: row.content_type,
  size: row.size,
  url: `/files/${row.id}/${encodeURIComponent(row.filename)}`,
  ...(row.purged_at ? { purged: true } : {}),
  kind: IMAGE_TYPES.has(row.content_type) ? 'image'
    : row.content_type.startsWith('video/') && MEDIA_TYPES.has(row.content_type) ? 'video'
    : row.content_type.startsWith('audio/') && MEDIA_TYPES.has(row.content_type) ? 'audio'
    : 'file',
  ...(row.is_voice ? { isVoice: true, duration: row.duration || 0, waveform: row.waveform || null, transcript: row.transcript || null } : {}),
  ...(row.has_text ? { hasText: true } : {}),
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
  pinnedAt: row.pinned_at || null,
  kind: row.kind || 'default',
  embeds: extras.embeds || [],
  poll: extras.poll || null,
  gif: row.gif || null,
  sticker: row.sticker ? { ...row.sticker, url: `/sticker/${row.sticker.id}` } : null,
  command: row.command || null,
  replyTo: extras.replyTo || null,
  thread: extras.thread || null,
  mentions: extras.mentions || [],
  attachments: (extras.attachments || []).map(attachment),
  reactions: extras.reactions || [],
  author: row.author_id
    ? {
      id: row.author_id,
      username: row.author_username,
      displayName: row.author_display_name,
      isBot: !!row.author_is_bot,
      avatarUrl: avatarUrl(row.author_avatar_id),
    }
    : { id: null, username: 'deletado', displayName: 'Usuário removido' },
});

module.exports = { user, me, server, channel, role, attachment, message, avatarUrl, MEDIA_TYPES };
