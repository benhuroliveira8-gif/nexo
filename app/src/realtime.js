const db = require('./db');
const auth = require('./auth');
const presence = require('./presence');
const S = require('./serializers');

const MAX_LENGTH = 4000;
// Anti-spam simples: no máximo 5 mensagens a cada 5 segundos por conexão.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;

async function serverIdsOf(userId) {
  const { rows } = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.server_id);
}

// Devolve o server_id do canal se o usuário for membro; senão null.
async function channelServerFor(channelId, userId) {
  const { rows } = await db.query(
    `SELECT c.server_id FROM channels c
     JOIN server_members m ON m.server_id = c.server_id AND m.user_id = $2
     WHERE c.id = $1`,
    [channelId, userId],
  );
  return rows[0] ? rows[0].server_id : null;
}

module.exports = function setupRealtime(io) {
  // Só aceita conexões com token válido.
  io.use(async (socket, next) => {
    const userId = auth.verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!userId) return next(new Error('unauthorized'));
    const { rows } = await db.query('SELECT id, username, display_name FROM users WHERE id = $1', [userId])
      .catch(() => ({ rows: [] }));
    if (!rows[0]) return next(new Error('unauthorized'));
    socket.data.user = S.user(rows[0]);
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.sent = [];
    const becameOnline = presence.connect(user.id);

    // Cada usuário tem uma sala própria e entra na sala de cada servidor seu.
    socket.join(`user:${user.id}`);
    serverIdsOf(user.id)
      .then((serverIds) => {
        if (!socket.connected) return;
        serverIds.forEach((id) => socket.join(`server:${id}`));
        if (becameOnline) {
          serverIds.forEach((id) => socket.to(`server:${id}`).emit('presence', { userId: user.id, online: true }));
        }
      })
      .catch((err) => console.error('Erro ao carregar servidores do usuário:', err));

    socket.on('message:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const channelId = Number(payload && payload.channelId);
        const content = String((payload && payload.content) || '').trim();
        if (!Number.isInteger(channelId) || channelId <= 0) return reply({ ok: false, error: 'Canal inválido.' });
        if (!content) return reply({ ok: false, error: 'Mensagem vazia.' });
        if (content.length > MAX_LENGTH) {
          return reply({ ok: false, error: `Máximo de ${MAX_LENGTH} caracteres.` });
        }

        const now = Date.now();
        socket.data.sent = socket.data.sent.filter((t) => now - t < RATE_WINDOW_MS);
        if (socket.data.sent.length >= RATE_MAX) {
          return reply({ ok: false, error: 'Calma! Você está enviando rápido demais.' });
        }
        socket.data.sent.push(now);

        const serverId = await channelServerFor(channelId, user.id);
        if (!serverId) return reply({ ok: false, error: 'Canal não encontrado.' });

        const { rows } = await db.query(
          'INSERT INTO messages (channel_id, author_id, content) VALUES ($1, $2, $3) RETURNING *',
          [channelId, user.id, content],
        );
        const message = S.message(
          { ...rows[0], author_username: user.username, author_display_name: user.displayName },
          serverId,
        );
        io.to(`server:${serverId}`).emit('message:new', message);
        reply({ ok: true, message });
      } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        reply({ ok: false, error: 'Não foi possível enviar.' });
      }
    });

    // "Fulano está digitando..."
    socket.on('typing', async (payload) => {
      const channelId = Number(payload && payload.channelId);
      if (!Number.isInteger(channelId) || channelId <= 0) return;
      const serverId = await channelServerFor(channelId, user.id).catch(() => null);
      if (!serverId) return;
      socket.to(`server:${serverId}`).emit('typing', { channelId, user });
    });

    socket.on('disconnect', async () => {
      if (!presence.disconnect(user.id)) return;
      const ids = await serverIdsOf(user.id).catch(() => []);
      ids.forEach((id) => io.to(`server:${id}`).emit('presence', { userId: user.id, online: false }));
    });
  });
};
