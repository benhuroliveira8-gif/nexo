// Quem está online agora. Conta conexões por usuário, porque a mesma
// pessoa pode estar com várias abas abertas.
const connections = new Map();

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];

function connect(userId) {
  const count = (connections.get(userId) || 0) + 1;
  connections.set(userId, count);
  return count === 1; // true = acabou de ficar online
}

function disconnect(userId) {
  const count = (connections.get(userId) || 0) - 1;
  if (count <= 0) {
    connections.delete(userId);
    return true; // true = acabou de ficar offline
  }
  connections.set(userId, count);
  return false;
}

const isConnected = (userId) => connections.has(userId);

// Abas/apps com o Nexo aparecendo na tela agora (para não mandar push à toa).
const visible = new Map(); // userId -> Set(socketId)
function setVisible(userId, socketId, on) {
  const set = visible.get(userId) || new Set();
  if (on) set.add(socketId); else set.delete(socketId);
  if (set.size) visible.set(userId, set); else visible.delete(userId);
}
const isActive = (userId) => visible.has(userId);

// Ausente automático: cada aba/app avisa quando ficou X minutos sem mexer.
// A pessoa só aparece "ausente" se TODAS as conexões dela estiverem paradas.
const idle = new Map(); // userId -> Set(socketId)
function setIdle(userId, socketId, on) {
  const before = isAutoIdle(userId);
  const set = idle.get(userId) || new Set();
  if (on) set.add(socketId); else set.delete(socketId);
  if (set.size) idle.set(userId, set); else idle.delete(userId);
  return before !== isAutoIdle(userId); // true = mudou
}
function isAutoIdle(userId) {
  const n = connections.get(userId) || 0;
  const set = idle.get(userId);
  return n > 0 && !!set && set.size >= n;
}

// O que os OUTROS veem: invisível aparece como offline, e o texto
// de status só aparece para quem está online.
function publicPresence(row) {
  let status = !isConnected(row.id) || row.status === 'invisible'
    ? 'offline'
    : (STATUSES.includes(row.status) ? row.status : 'online');
  const autoIdle = status === 'online' && isAutoIdle(row.id);
  if (autoIdle) status = 'idle';
  return {
    online: status !== 'offline',
    status,
    statusText: status === 'offline' ? null : (row.status_text || null),
    activity: status === 'offline' ? null : (row.activity || null),
    ...(autoIdle ? { autoIdle: true } : {}),
  };
}

module.exports = { STATUSES, connect, disconnect, isConnected, publicPresence, setVisible, isActive, setIdle, isAutoIdle };
