// Eventos em tempo real: mensagens, "digitando...", leitura, presença e voz.
const db = require('./db');
const auth = require('./auth');
const presence = require('./presence');
const events = require('./events');
const S = require('./serializers');
const M = require('./messages');
const voice = require('./voice');
const push = require('./push');
const waiting = require('./waiting');
const { P, channelAccess } = require('./permissions');

const VERSION = require('../package.json').version;

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
    db.query('SELECT id, status, status_text, activity FROM users WHERE id = $1', [userId]).then((r) => r.rows[0]),
  ]);
  if (!row) return;
  const rooms = [...servers.map((id) => `server:${id}`), ...friends.map((id) => `user:${id}`)];
  events.emitTo(rooms, 'presence', { userId, ...presence.publicPresence(row) });
}

const BUILTIN_SOUNDS = new Set(['buzina', 'aplausos', 'badumtss', 'trombeta', 'sino', 'risada', 'tambor', 'grilos']);

module.exports = function setupRealtime(io) {
  events.setPresenceBroadcaster(broadcastPresence);
  // Só aceita conexões com token válido.
  io.use(async (socket, next) => {
    try {
      // Pessoas mandam o token de login; bots mandam "Bot <token do bot>".
      const who = await auth.authenticate(socket.handshake.auth && socket.handshake.auth.token);
      if (!who) return next(new Error('unauthorized'));
      if (who.emailPending) return next(new Error('email_unverified'));
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

    // Versão do Nexo: o navegador compara para saber se precisa recarregar depois de uma atualização.
    socket.emit('hello', { version: VERSION, restarting: events.restartNotice() });
    db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]).catch(() => {});

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
          gif: payload.gif,
          stickerId: payload.stickerId,
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
        const stage = access.kind === 'voice' && !!access.channel.stage;
        if (stage && access.can(P.MANAGE_STAGE)) voice.setStageSpeaker(channelId, user.id, true);
        const { firstHere } = voice.join({
          userId: user.id, serverId: access.serverId, channelId, socketId: socket.id, flags: { ...(payload || {}), stage }, rooms: access.rooms,
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

    // ---------- Sala de espera da voz
    const waitAccess = async (payload) => {
      const channelId = Number(payload && payload.channelId);
      if (!validId(channelId) || user.isBot) return null;
      const access = await channelAccess(channelId, user.id);
      return access && access.kind === 'voice' && access.channel.waiting_room ? access : null;
    };
    socket.on('voice:wait', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const access = await waitAccess(payload).catch(() => null);
      if (!access || !access.can(P.CONNECT)) return reply({ ok: false, error: 'Canal sem sala de espera.' });
      if (waiting.isAdmitted(access.channel.id, user.id) || waiting.canAdmit(access)) return reply({ ok: true, admitted: true });
      waiting.add(access, user, socket.id);
      reply({ ok: true });
    });
    socket.on('voice:unwait', async (payload) => {
      const access = await waitAccess(payload).catch(() => null);
      if (access) waiting.remove(access.channel.id, user.id, access.rooms);
    });
    // Moderação: { channelId, userId, allow }
    socket.on('voice:admit', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const access = await waitAccess(payload).catch(() => null);
      if (!access || !waiting.canAdmit(access)) return reply({ ok: false, error: 'Você não pode liberar a entrada.' });
      const targetId = Number(payload.userId);
      const channelId = access.channel.id;
      if (!waiting.remove(channelId, targetId, access.rooms)) return reply({ ok: false, error: 'Essa pessoa não está mais esperando.' });
      if (payload.allow) {
        waiting.admit(channelId, targetId);
        events.emitTo([`user:${targetId}`], 'voice:admitted', { channelId, by: user.displayName });
      } else {
        events.emitTo([`user:${targetId}`], 'voice:denied', { channelId, by: user.displayName });
      }
      reply({ ok: true });
    });

    // ---------- Soundboard: um som curto para todo mundo da chamada.
    const lastSound = { t: 0 };
    socket.on('voice:sound', async (payload) => {
      try {
        const st = voice.stateOf(user.id);
        if (!st || st.socketId !== socket.id) return;
        if (Date.now() - lastSound.t < 1500) return; // anti-spam
        const raw = String((payload && payload.sound) || '');
        let sound = null;
        if (/^b:[a-z]{2,20}$/.test(raw) && BUILTIN_SOUNDS.has(raw.slice(2))) sound = { id: raw };
        else if (/^\d{1,9}$/.test(raw) && st.serverId) {
          const { rows } = await db.query('SELECT id, name, emoji FROM nexo_sounds WHERE id = $1 AND server_id = $2', [Number(raw), st.serverId]);
          if (rows[0]) sound = { id: String(rows[0].id), name: rows[0].name, emoji: rows[0].emoji };
        }
        if (!sound) return;
        const access = await channelAccess(st.channelId, user.id);
        if (!access || !access.can(P.SPEAK)) return;
        if (access.kind === 'voice' && access.channel.stage && !st.speaker) return; // plateia não toca som
        lastSound.t = Date.now();
        const people = voice.peopleIn(st.channelId);
        events.emitTo(people.map((id) => `user:${id}`), 'voice:sound', { channelId: st.channelId, userId: user.id, sound });
      } catch (err) {
        console.error('Erro no soundboard:', err.message);
      }
    });

    // ---------- Modo palco
    socket.on('stage:hand', (payload) => {
      const st = voice.stateOf(user.id);
      if (!st || st.socketId !== socket.id || st.speaker) return;
      voice.update(user.id, socket.id, { hand: !!(payload && payload.up) });
    });
    const stageRole = async (payload, on) => {
      const targetId = Number(payload && payload.userId);
      const st = voice.stateOf(user.id);
      if (!st || !validId(targetId)) return;
      const access = await channelAccess(st.channelId, user.id);
      if (!access || access.kind !== 'voice' || !access.channel.stage) return;
      const self = targetId === user.id;
      // Moderador chama/manda de volta qualquer um; qualquer um pode sair do palco sozinho.
      if (!access.can(P.MANAGE_STAGE) && !(self && !on)) return;
      const target = voice.stateOf(targetId);
      if (!target || target.channelId !== st.channelId) return;
      voice.setStageSpeaker(st.channelId, targetId, on);
      const targetAccess = await channelAccess(st.channelId, targetId);
      const canSpeak = on && !!targetAccess && targetAccess.can(P.SPEAK);
      const canVideo = on && !!targetAccess && targetAccess.can(P.VIDEO);
      const applied = await voice.updateLivekitPermission(st.channelId, targetId, { canSpeak, canVideo });
      events.emitTo([`user:${targetId}`], 'stage:role', { channelId: st.channelId, speaker: on, applied, by: user.id });
    };
    socket.on('stage:invite', (payload) => { stageRole(payload, true).catch((err) => console.error('Erro no palco:', err.message)); });
    socket.on('stage:remove', (payload) => { stageRole(payload, false).catch((err) => console.error('Erro no palco:', err.message)); });

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

    // Ausente automático (o navegador avisa depois de X minutos sem mexer).
    socket.on('client:idle', (on) => {
      if (presence.setIdle(user.id, socket.id, !!on)) broadcastPresence(user.id).catch(() => {});
    });

    socket.on('disconnect', () => {
      presence.setVisible(user.id, socket.id, false);
      presence.setIdle(user.id, socket.id, false);
      for (const channelId of waiting.dropSocket(socket.id)) {
        channelAccess(channelId, user.id).then((a) => a && waiting.announce(channelId, a.rooms)).catch(() => {});
      }
      voice.disconnect(user.id, socket.id);
      if (!presence.disconnect(user.id)) return;
      db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]).catch(() => {});
      broadcastPresence(user.id).catch(() => {});
    });
  });
};
