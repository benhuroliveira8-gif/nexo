// Preferências de notificação por servidor/canal (Tudo / Só menções / Nada / Silenciado até…).
const db = require('./db');

const LEVELS = ['all', 'mentions', 'none'];

// Todas as preferências de algumas pessoas: Map userId -> Map target -> { level, mutedUntil }
async function loadFor(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const { rows } = await db.query(
    'SELECT user_id, target, level, muted_until FROM nexo_notify WHERE user_id = ANY($1::int[])',
    [userIds],
  );
  for (const r of rows) {
    if (!out.has(r.user_id)) out.set(r.user_id, new Map());
    out.get(r.user_id).set(r.target, { level: r.level, mutedUntil: r.muted_until });
  }
  return out;
}

const isMuted = (s, now = Date.now()) => !!(s && s.mutedUntil && new Date(s.mutedUntil).getTime() > now);

// O que vale para uma pessoa num canal: { muted, level }.
// Canal manda mais que servidor; padrão: DM = tudo, servidor = só menções.
function effective(map, serverId, channelId, parentId = null) {
  // Thread segue o canal de onde saiu (se ela mesma não tiver preferência).
  const ch = map && (map.get(`c:${channelId}`) || (parentId ? map.get(`c:${parentId}`) : null));
  const sv = serverId && map ? map.get(`s:${serverId}`) : null;
  const muted = isMuted(ch) || isMuted(sv);
  const level = (ch && ch.level) || (sv && sv.level) || (serverId ? 'mentions' : 'all');
  return { muted, level: muted ? 'none' : level };
}

module.exports = { LEVELS, loadFor, effective, isMuted };
