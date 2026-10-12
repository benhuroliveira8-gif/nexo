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

// O que os OUTROS veem: invisível aparece como offline, e o texto
// de status só aparece para quem está online.
function publicPresence(row) {
  const status = !isConnected(row.id) || row.status === 'invisible'
    ? 'offline'
    : (STATUSES.includes(row.status) ? row.status : 'online');
  return {
    online: status !== 'offline',
    status,
    statusText: status === 'offline' ? null : (row.status_text || null),
    activity: status === 'offline' ? null : (row.activity || null),
  };
}

module.exports = { STATUSES, connect, disconnect, isConnected, publicPresence, setVisible, isActive };
