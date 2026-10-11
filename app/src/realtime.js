// Eventos em tempo real: mensagens, "digitando...", leitura, presença e voz.
const db = require('./db');
const auth = require('./auth');
const presence = require('./presence');
const events = require('./events');
const S = require('./serializers');
const M = require('./messages');
const voice = require('./voice');
const push = require('./push');
const { P, channelAccess } = require('./permissions');

const validId = (v) => Number.isInteger(v) && v > 0 && v < 2 ** 31;

async function serverIdsOf(userId) {
  const { rows } = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.server_id);
}

// Avisa servidores e amigos como a pessoa aparece agora (online, ausente, offline...).
async function broadcastPresence(userId) {
  const [servers, friends, row] = await Promise.all([
    serverIdsOf(userId),
    events.friendIdsOf(userId),
    db.query('SELECT id, status, status_text FROM users WHERE id = $1', [userId]).then((r) => r.rows[0]),
  ]);
  if (!row) return;
  const rooms = [...servers.map((id) => `server:${id}`), ...friends.map((id) => `user:${id}`)];
  events.emitTo(rooms, 'presence', { userId, ...presence.publicPresence(row) });
}

module.exports = function setupRealtime(io) {
  events.setPresenceBroadcaster(broadcastPresence);
  // Só aceita conexões com token válido.
  io.use(async (socket, next) => {
    try {
      // Pessoas mandam o token de login; bots mandam "Bot <token do bot>".
      const who = await auth.authenticate(socket.handshake.auth && socket.handshake.auth.token);
      if (!who) return next(new Error('unauthorized'));
      const { rows } = await db.query('SELECT id, username, display_name, is_bot, avatar_id, status, status_text FROM users WHERE id = $1', [who.userId]);
      if (!rows[0]) return next(new Error('unauthorized'));
      socket.data.user = S.user(rows[0]);
      socket.data.isBot = who.isBot;
      next();
    } catch (err) {
      next(new Error('server_error'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const becameOnline = presence.connect(user.id);

    // Cada usuário tem uma sala própria e entra na sala de cada servidor seu.
    socket.join(`user:${user.id}`);
    serverIdsOf(user.id)
      .then((ids) => {
        if (!socket.connected) return;
        ids.forEach((id) => socket.join(`server:${id}`));
        if (becameOnline) return broadcastPresence(user.id);
      })
      .catch((err) => console.error('Erro ao preparar conexão:', err));

    socket.on('message:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const channelId = Number(payload && payload.channelId);
        if (!validId(channelId)) return reply({ ok: false, error: 'Canal inválido.' });

        const access = await channelAccess(channelId, user.id);
        if (!access) return reply({ ok: false, error: 'Canal não encontrado.' });

        const message = await M.createMessage({
          access,
          userId: user.id,
          content: payload.content,
          attachmentIds: payload.attachmentIds,
          replyToId: payload.replyToId,
          poll: payload.poll,
        });
        // "nonce" é um id temporário criado pelo navegador para casar a mensagem
        // "enviando..." com a confirmada.
        const nonce = typeof payload.nonce === 'string' && payload.nonce.length <= 40 ? payload.nonce : undefined;
        M.announceNew(access, message, nonce);
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

    // ---------- Voz
    // O navegador entra no LiveKit e avisa aqui, para todos verem quem está no canal.
    socket.on('voice:join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const channelId = Number(payload && payload.channelId);
        if (!validId(channelId) || user.isBot) return reply({ ok: false, error: 'Canal inválido.' });
        const access = await channelAccess(channelId, user.id);
        if (!access || (access.kind !== 'voice' && access.kind !== 'dm')) return reply({ ok: false, error: 'Canal de voz não encontrado.' });
        if (!access.can(P.CONNECT)) return reply({ ok: false, error: 'Você não pode entrar neste canal de voz.' });
        const { firstHere } = voice.join({
          userId: user.id, serverId: access.serverId, channelId, socketId: socket.id, flags: payload || {}, rooms: access.rooms,
        });
        reply({ ok: true });
        // Chamada em mensagem direta: quem começou "liga" para os outros.
        if (access.kind === 'dm' && firstHere) {
          const others = access.memberIds.filter((id) => id !== user.id);
          events.emitTo(others.map((id) => `user:${id}`), 'call:ring', { channelId, from: user, video: !!(payload && payload.video) });
          const offline = others.filter((id) => !presence.isActive(id));
          db.query("SELECT id FROM users WHERE id = ANY($1::int[]) AND status <> 'dnd'", [offline])
            .then(({ rows }) => push.sendToUsers(rows.map((r) => r.id), {
              title: `📞 ${user.displayName} está te ligando`,
              body: access.isGroup ? 'Chamada no grupo. Toque para atender.' : 'Toque para atender.',
              url: `/?canal=${channelId}&atender=1`,
              tag: `chamada-${channelId}`,
              kind: 'call',
            }))
            .catch((err) => console.error('Erro no push da chamada:', err.message));
        }
      } catch (err) {
        console.error('Erro ao entrar na voz:', err);
        reply({ ok: false, error: 'Não foi possível entrar na voz.' });
      }
    });

    socket.on('voice:state', (flags) => {
      if (flags && typeof flags === 'object') voice.update(user.id, socket.id, flags);
    });

    socket.on('voice:leave', () => voice.disconnect(user.id, socket.id));

    // Recusar uma chamada: avisa quem está na chamada (e as suas outras abas, para parar de tocar).
    socket.on('call:decline', async (payload) => {
      const channelId = Number(payload && payload.channelId);
      if (!validId(channelId)) return;
      const access = await channelAccess(channelId, user.id).catch(() => null);
      if (!access || access.kind !== 'dm') return;
      const inCall = voice.peopleIn(channelId);
      events.emitTo([...inCall, user.id].map((id) => `user:${id}`), 'call:declined', { channelId, user });
    });

    // A aba está aparecendo na tela? (se nenhuma estiver, mandamos notificação push)
    socket.on('client:visible', (visible) => presence.setVisible(user.id, socket.id, !!visible));

    socket.on('disconnect', () => {
      presence.setVisible(user.id, socket.id, false);
      voice.disconnect(user.id, socket.id);
      if (!presence.disconnect(user.id)) return;
      broadcastPresence(user.id).catch(() => {});
    });
  });
};
