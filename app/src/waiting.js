// Sala de espera da voz: num canal com sala de espera, quem chega fica aguardando
// até alguém da moderação clicar em "Deixar entrar". Tudo em memória.
const events = require('./events');
const { P } = require('./permissions');

const waiting = new Map();  // channelId -> Map(userId -> { user, since, socketId })
const admitted = new Map(); // channelId -> Set(userId)

// Quem pode liberar: castigar membros, gerenciar canais ou moderar o palco.
const canAdmit = (access) => access.isAdmin || access.can(P.MODERATE_MEMBERS) || access.can(P.MANAGE_CHANNELS) || access.can(P.MANAGE_STAGE);

const list = (channelId) => [...(waiting.get(channelId) || new Map()).values()].map(({ user, since }) => ({ user, since }));
const isAdmitted = (channelId, userId) => !!(admitted.get(channelId) && admitted.get(channelId).has(userId));

function announce(channelId, rooms) {
  events.emitTo(rooms, 'voice:waiting', { channelId, waiting: list(channelId) });
}

function add(access, user, socketId) {
  const channelId = access.channel.id;
  if (!waiting.has(channelId)) waiting.set(channelId, new Map());
  const map = waiting.get(channelId);
  if (!map.has(user.id)) map.set(user.id, { user, since: new Date().toISOString(), socketId });
  else map.get(user.id).socketId = socketId;
  announce(channelId, access.rooms);
}

function remove(channelId, userId, rooms) {
  const map = waiting.get(channelId);
  if (!map || !map.delete(userId)) return false;
  if (!map.size) waiting.delete(channelId);
  if (rooms) announce(channelId, rooms);
  return true;
}

function admit(channelId, userId) {
  if (!admitted.has(channelId)) admitted.set(channelId, new Set());
  admitted.get(channelId).add(userId);
}

// Saiu da chamada: na próxima vez espera de novo.
function forget(channelId, userId) {
  const set = admitted.get(channelId);
  if (set) { set.delete(userId); if (!set.size) admitted.delete(channelId); }
}

// A conexão caiu: sai de todas as salas de espera daquela aba.
function dropSocket(socketId) {
  const changed = [];
  for (const [channelId, map] of waiting) {
    for (const [userId, w] of map) if (w.socketId === socketId) { map.delete(userId); changed.push(channelId); }
    if (!map.size) waiting.delete(channelId);
  }
  return changed;
}

// Para a tela do servidor: quem está esperando em cada canal.
function forChannels(ids) {
  const out = {};
  for (const id of ids) { const l = list(id); if (l.length) out[id] = l; }
  return out;
}

module.exports = { canAdmit, list, isAdmitted, add, remove, admit, forget, dropSocket, forChannels, announce };
