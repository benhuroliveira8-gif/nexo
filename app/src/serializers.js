// Converte linhas do banco no formato JSON que o navegador recebe.

const user = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
});

const server = (row) => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  inviteCode: row.invite_code,
});

const channel = (row) => ({
  id: row.id,
  serverId: row.server_id,
  name: row.name,
  position: row.position,
});

// Espera colunas da mensagem + author_username/author_display_name (via JOIN).
const message = (row, serverId) => ({
  id: String(row.id),
  channelId: row.channel_id,
  serverId: serverId ?? row.server_id,
  content: row.content,
  createdAt: row.created_at,
  author: row.author_id
    ? { id: row.author_id, username: row.author_username, displayName: row.author_display_name }
    : { id: null, username: 'deletado', displayName: 'Usuário removido' },
});

module.exports = { user, server, channel, message };
