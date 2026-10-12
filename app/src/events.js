// Ajudantes para avisar os navegadores em tempo real.
const db = require('./db');

let io = null;
const setIo = (instance) => { io = instance; };
const getIo = () => io;

// Emite para várias salas de uma vez (cada conexão recebe só uma vez).
function emitTo(rooms, event, data) {
  if (!io || rooms.length === 0) return;
  let target = io.to(rooms[0]);
  for (const r of rooms.slice(1)) target = target.to(r);
  target.emit(event, data);
}

// "Algo mudou na estrutura do servidor" (canais, cargos, membros, nome...):
// os navegadores recarregam os detalhes daquele servidor.
const serverChanged = (serverId) => emitTo([`server:${serverId}`], 'server:changed', { serverId });

async function friendIdsOf(userId) {
  const { rows } = await db.query(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  );
  return rows.map((r) => r.id);
}

const friendsChanged = (...userIds) => emitTo(userIds.map((id) => `user:${id}`), 'friends:changed', {});

// Quem mudou de status avisa os outros (a função vem do realtime.js).
let presenceBroadcaster = async () => {};
const setPresenceBroadcaster = (fn) => { presenceBroadcaster = fn; };
const presenceChanged = (userId) => presenceBroadcaster(userId).catch(() => {});

// Aviso de atualização ("o Nexo vai reiniciar em 20 s"), para quem conectar nesse meio tempo.
let restartAt = null;
function announceRestart(seconds) {
  restartAt = Date.now() + seconds * 1000;
  if (io) io.emit('server:restarting', { in: seconds });
}
const restartNotice = () => (restartAt && restartAt > Date.now() - 60000 ? { in: Math.max(0, Math.round((restartAt - Date.now()) / 1000)) } : null);

module.exports = {
  announceRestart, restartNotice,
  setIo, getIo, emitTo, serverChanged, friendIdsOf, friendsChanged, setPresenceBroadcaster, presenceChanged,
};
