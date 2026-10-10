// Eventos em tempo real: enviar mensagens, "digitando...", leitura e presença.
const db = require('./db');
const auth = require('./auth');
const presence = require('./presence');
const events = require('./events');
const S = require('./serializers');
const M = require('./messages');
const { P, channelAccess } = require('./permissions');

// Anti-spam simples: no máximo 5 mensagens a cada 5 segundos por conexão.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;

const validId = (v) => Number.isInteger(v) && v > 0 && v < 2 ** 31;

async function serverIdsOf(userId) {
  const { rows } = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.server_id);
}

// Avisa servidores e amigos que alguém ficou online/offline.
async function broadcastPresence(userId, online) {
  const [servers, friends] = await Promise.all([serverIdsOf(userId), events.friendIdsOf(userId)]);
  const rooms = [...servers.map((id) => `server:${id}`), ...friends.map((id) => `user:${id}`)];
  events.emitTo(rooms, 'presence', { userId, online });
}

module.exports = function setupRealtime(io) {
  // Só aceita conexões com token válido.
  io.use(async (socket, next) => {
    try {
      const userId = auth.verifyToken(socket.handshake.auth && socket.handshake.auth.token);
      if (!userId) return next(new Error('unauthorized'));
      const { rows } = await db.query('SELECT id, username, display_name FROM users WHERE id = $1', [userId]);
      if (!rows[0]) return next(new Error('unauthorized'));
      socket.data.user = S.user(rows[0]);
      next();
    } catch (err) {
      next(new Error('server_error'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.sent = [];
    const becameOnline = presence.connect(user.id);

    // Cada usuário tem uma sala própria e entra na sala de cada servidor seu.
    socket.join(`user:${user.id}`);
    serverIdsOf(user.id)
      .then((ids) => {
        if (!socket.connected) return;
        ids.forEach((id) => socket.join(`server:${id}`));
        if (becameOnline) return broadcastPresence(user.id, true);
      })
      .catch((err) => console.error('Erro ao preparar conexão:', err));

    socket.on('message:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const channelId = Number(payload && payload.channelId);
        if (!validId(channelId)) return reply({ ok: false, error: 'Canal inválido.' });

        const now = Date.now();
        socket.data.sent = socket.data.sent.filter((t) => now - t < RATE_WINDOW_MS);
        if (socket.data.sent.length >= RATE_MAX) {
          return reply({ ok: false, error: 'Calma! Você está enviando rápido demais.' });
        }

        const access = await channelAccess(channelId, user.id);
        if (!access) return reply({ ok: false, error: 'Canal não encontrado.' });
        if (!access.can(P.SEND_MESSAGES)) return reply({ ok: false, error: 'Você não tem permissão para enviar mensagens aqui.' });

        socket.data.sent.push(now);
        const message = await M.createMessage({
          access,
          userId: user.id,
          content: payload.content,
          attachmentIds: payload.attachmentIds,
        });
        // "nonce" é um id temporário criado pelo navegador para casar a mensagem
        // "enviando..." com a confirmada.
        const nonce = typeof payload.nonce === 'string' && payload.nonce.length <= 40 ? payload.nonce : undefined;
        events.emitTo(access.rooms, 'message:new', { ...message, nonce });
        reply({ ok: true, message: { ...message, nonce } });
      } catch (err) {
        if (err instanceof M.MessageError) return reply({ ok: false, error: err.message });
        console.error('Erro ao enviar mensagem:', err);
        reply({ ok: false, error: 'Não foi possível enviar.' });
      }
    });

    // "Fulano está digitando..."
    socket.on('typing', async (payload) => {
      const channelId = Number(payload && payload.channelId);
      if (!validId(channelId)) return;
      const access = await channelAccess(channelId, user.id).catch(() => null);
      if (!access || !access.can(P.SEND_MESSAGES)) return;
      const rooms = access.kind === 'dm'
        ? access.memberIds.filter((id) => id !== user.id).map((id) => `user:${id}`)
        : access.rooms;
      const target = rooms.reduce((t, r) => t.to(r), socket);
      if (rooms.length) target.emit('typing', { channelId, user });
    });

    // Marca o canal como lido até uma mensagem (avisa as outras abas do mesmo usuário).
    socket.on('channel:read', async (payload) => {
      try {
        const channelId = Number(payload && payload.channelId);
        const messageId = /^\d{1,18}$/.test(String(payload && payload.messageId)) ? String(payload.messageId) : null;
        if (!validId(channelId) || !messageId) return;
        const access = await channelAccess(channelId, user.id);
        if (!access) return;
        await db.query(
          `INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(channel_reads.last_read_id, EXCLUDED.last_read_id)`,
          [user.id, channelId, messageId],
        );
        events.emitTo([`user:${user.id}`], 'channel:read', { channelId, messageId });
      } catch (err) {
        console.error('Erro ao marcar como lido:', err);
      }
    });

    socket.on('disconnect', () => {
      if (!presence.disconnect(user.id)) return;
      broadcastPresence(user.id, false).catch(() => {});
    });
  });
};
