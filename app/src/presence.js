// Quem está online agora. Conta conexões por usuário, porque a mesma
// pessoa pode estar com várias abas abertas.
const connections = new Map();

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

const isOnline = (userId) => connections.has(userId);

module.exports = { connect, disconnect, isOnline };
