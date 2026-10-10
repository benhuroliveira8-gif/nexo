// Canais de voz: quem está em qual canal (em memória) e tokens do LiveKit.
//
// O áudio/vídeo em si não passa pelo Nexo: o navegador conversa direto com o
// LiveKit. O Nexo só (1) diz se a pessoa pode entrar, gerando um token assinado,
// e (2) mostra para todo mundo quem está em cada canal.
const jwt = require('jsonwebtoken');
const events = require('./events');
const { P } = require('./permissions');

const LIVEKIT_KEY = process.env.LIVEKIT_API_KEY || '';
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
// channelId -> Map(userId -> { userId, serverId, socketId, muted, deafened, video, screen })
const channels = new Map();
const userChannel = new Map(); // userId -> channelId

function statesOf(channelId) {
  return [...(channels.get(channelId) || new Map()).values()].map(({ socketId, ...s }) => s);
}

function broadcast(serverId, channelId) {
  events.emitTo([`server:${serverId}`], 'voice:update', { serverId, channelId, states: statesOf(channelId) });
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
    if (map.size === 0) channels.delete(channelId);
  }
  if (state) broadcast(state.serverId, channelId);
}

function join({ userId, serverId, channelId, socketId, flags }) {
  if (userChannel.get(userId) !== channelId) leave(userId); // trocou de canal
  if (!channels.has(channelId)) channels.set(channelId, new Map());
  channels.get(channelId).set(userId, {
    userId, serverId, socketId,
    muted: !!flags.muted, deafened: !!flags.deafened, video: !!flags.video, screen: !!flags.screen,
  });
  userChannel.set(userId, channelId);
  broadcast(serverId, channelId);
}

function update(userId, socketId, flags) {
  const channelId = userChannel.get(userId);
  const state = channelId !== undefined && channels.get(channelId).get(userId);
  if (!state || state.socketId !== socketId) return false;
  for (const k of ['muted', 'deafened', 'video', 'screen']) if (k in flags) state[k] = !!flags[k];
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

module.exports = {
  P, configured, livekitToken, roomName,
  statesForChannels, join, update, leave, disconnect, leaveServer, clearChannel, currentChannelOf,
};
