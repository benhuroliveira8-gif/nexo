// Registro de auditoria: guarda quem fez o quê no servidor (expulsões, bans, cargos, canais...).
const db = require('./db');

async function audit(serverId, actorId, action, { targetId = null, targetName = null, details = {} } = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (server_id, actor_id, action, target_id, target_name, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [serverId, actorId, action, targetId, targetName ? String(targetName).slice(0, 120) : null, JSON.stringify(details || {})],
    );
    // Guarda só os 2000 registros mais recentes de cada servidor.
    await db.query(
      `DELETE FROM audit_log WHERE server_id = $1 AND id < (
         SELECT id FROM audit_log WHERE server_id = $1 ORDER BY id DESC OFFSET 2000 LIMIT 1)`,
      [serverId],
    );
  } catch (err) {
    console.error('Falha ao gravar auditoria:', err.message);
  }
}

module.exports = { audit };
