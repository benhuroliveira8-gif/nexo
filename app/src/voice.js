// Canais de voz: quem está em qual canal (em memória) e tokens do LiveKit.
//
// O áudio/vídeo em si não passa pelo Nexo: o navegador conversa direto com o
// LiveKit. O Nexo só (1) diz se a pessoa pode entrar, gerando um token assinado,
// e (2) mostra para todo mundo quem está em cada canal.
const jwt = require('jsonwebtoken');
const events = require('./events');
const { P } = require('./permissions');

const LIVEKIT_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_INTERNAL_URL = (process.env.LIVEKIT_INTERNAL_URL || 'http://livekit:7880').replace(/\/$/, '');
const LIVEKIT_SECRET = process.env.LIVEKIT_API_SECRET || '';
const TOKEN_HOURS = 6;

const configured = () => LIVEKIT_KEY.length > 0 && LIVEKIT_SECRET.length >= 32;
const roomName = (channelId) => `nexo-canal-${channelId}`;

// Token de acesso do LiveKit (é um JWT assinado com o segredo da API).
function livekitToken({ user, channelId, canSpeak, canVideo }) {
  const now = Math.floor(Date.now() / 1000);
  const sources = [];
  if (canSpeak) sources.push('microphone');
  if (canVideo) sources.push('camera', 'screen_share', 'screen_share_audio');
  return jwt.sign({
    iss: LIVEKIT_KEY,
    sub: `u${user.id}`,
    jti: `u${user.id}-${now}`,
    nbf: now - 10,
    exp: now + TOKEN_HOURS * 3600,
    name: user.displayName,
    metadata: JSON.stringify({ userId: user.id }),
    video: {
      room: roomName(channelId),
      roomJoin: true,
      canSubscribe: true,
      canPublish: sources.length > 0,
      canPublishData: false,
      canPublishSources: sources,
    },
  }, LIVEKIT_SECRET, { algorithm: 'HS256' });
}

// ---------- Quem está em cada canal
// channelId -> Map(userId -> { userId, serverId, socketId, rooms, muted, deafened, video, screen })
// serverId = null nas chamadas de mensagem direta. "rooms" = quem deve saber quem está na chamada.
const channels = new Map();
const userChannel = new Map(); // userId -> channelId

function statesOf(channelId) {
  return [...(channels.get(channelId) || new Map()).values()].map(({ socketId, rooms, ...s }) => s);
}

const roomsOf = new Map(); // channelId -> salas avisadas (as da última entrada)
function broadcast(serverId, channelId) {
  const rooms = roomsOf.get(channelId) || (serverId ? [`server:${serverId}`] : []);
  events.emitTo(rooms, 'voice:update', { serverId, channelId, states: statesOf(channelId) });
  if (!channels.has(channelId)) roomsOf.delete(channelId);
}

// Estados de voz de vários canais (para a tela do servidor).
function statesForChannels(channelIds) {
  const out = {};
  for (const id of channelIds) {
    const list = statesOf(id);
    if (list.length) out[id] = list;
  }
  return out;
}

function leave(userId) {
  const channelId = userChannel.get(userId);
  if (channelId === undefined) return;
  const map = channels.get(channelId);
  const state = map && map.get(userId);
  userChannel.delete(userId);
  if (map) {
    map.delete(userId);
    if (map.size === 0) { channels.delete(channelId); stageSpeakers.delete(channelId); }
  }
  if (state) broadcast(state.serverId, channelId);
}

function join({ userId, serverId, channelId, socketId, flags, rooms }) {
  if (userChannel.get(userId) !== channelId) leave(userId); // trocou de canal
  const firstHere = !channels.has(channelId) || channels.get(channelId).size === 0;
  if (rooms) roomsOf.set(channelId, rooms);
  if (!channels.has(channelId)) channels.set(channelId, new Map());
  channels.get(channelId).set(userId, {
    userId, serverId, socketId,
    muted: !!flags.muted, deafened: !!flags.deafened, video: !!flags.video, screen: !!flags.screen,
    recording: !!flags.recording, hand: false,
    ...(flags.stage ? { speaker: isStageSpeaker(channelId, userId) } : {}),
  });
  userChannel.set(userId, channelId);
  broadcast(serverId, channelId);
  return { firstHere };
}

function update(userId, socketId, flags) {
  const channelId = userChannel.get(userId);
  const state = channelId !== undefined && channels.get(channelId).get(userId);
  if (!state || state.socketId !== socketId) return false;
  for (const k of ['muted', 'deafened', 'video', 'screen', 'recording', 'hand']) if (k in flags) state[k] = !!flags[k];
  if (state.speaker) state.hand = false;
  broadcast(state.serverId, channelId);
  return true;
}

// Quando a conexão cai: só sai da voz se era essa conexão que estava na voz.
function disconnect(userId, socketId) {
  const channelId = userChannel.get(userId);
  const state = channelId !== undefined && channels.get(channelId).get(userId);
  if (state && state.socketId === socketId) leave(userId);
}

// Alguém saiu/foi expulso do servidor: tira da voz desse servidor.
function leaveServer(userId, serverId) {
  const channelId = userChannel.get(userId);
  const state = channelId !== undefined && channels.get(channelId).get(userId);
  if (state && state.serverId === serverId) leave(userId);
}

// Canal apagado: todo mundo sai.
function clearChannel(channelId) {
  for (const userId of [...(channels.get(channelId) || new Map()).keys()]) leave(userId);
}

const currentChannelOf = (userId) => userChannel.get(userId);
const stateOf = (userId) => {
  const channelId = userChannel.get(userId);
  const st = channelId !== undefined && channels.get(channelId) && channels.get(channelId).get(userId);
  return st ? { ...st, channelId } : null;
};

// ---------- Modo palco: quem pode falar (além de quem modera)
const stageSpeakers = new Map(); // channelId -> Set(userId)
function isStageSpeaker(channelId, userId) {
  return !!(stageSpeakers.get(channelId) && stageSpeakers.get(channelId).has(userId));
}
function setStageSpeaker(channelId, userId, on) {
  if (!stageSpeakers.has(channelId)) stageSpeakers.set(channelId, new Set());
  if (on) stageSpeakers.get(channelId).add(userId); else stageSpeakers.get(channelId).delete(userId);
  const st = channels.get(channelId) && channels.get(channelId).get(userId);
  if (st) {
    st.speaker = !!on;
    st.hand = false;
    if (!on) { st.video = false; st.screen = false; }
    broadcast(st.serverId, channelId);
  }
}

// Muda na hora o que a pessoa pode publicar no LiveKit (API do servidor LiveKit).
async function updateLivekitPermission(channelId, userId, { canSpeak, canVideo }) {
  if (!configured()) return false;
  const now = Math.floor(Date.now() / 1000);
  const admin = jwt.sign({
    iss: LIVEKIT_KEY, sub: 'nexo-servidor', nbf: now - 10, exp: now + 60,
    video: { room: roomName(channelId), roomAdmin: true },
  }, LIVEKIT_SECRET, { algorithm: 'HS256' });
  const sources = [];
  if (canSpeak) sources.push('MICROPHONE');
  if (canVideo) sources.push('CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO');
  try {
    const res = await fetch(`${LIVEKIT_INTERNAL_URL}/twirp/livekit.RoomService/UpdateParticipant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      body: JSON.stringify({
        room: roomName(channelId),
        identity: `u${userId}`,
        permission: { can_subscribe: true, can_publish: sources.length > 0, can_publish_data: false, can_publish_sources: sources },
      }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const peopleIn = (channelId) => statesOf(channelId).map((s) => s.userId);

module.exports = {
  P, configured, livekitToken, roomName,
  statesForChannels, join, update, leave, disconnect, leaveServer, clearChannel, currentChannelOf, peopleIn,
  stateOf, isStageSpeaker, setStageSpeaker, updateLivekitPermission,
};
