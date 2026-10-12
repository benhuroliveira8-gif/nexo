// Níveis e XP por participação (opcional por servidor).
// Cada mensagem dá de 15 a 25 XP, no máximo uma vez por minuto (para não premiar spam).
// Para passar do nível n para o n+1 são precisos 5n² + 50n + 100 XP.
const db = require('./db');
const events = require('./events');
const { channelAccess } = require('./permissions');

const DEFAULT_LEVELS = {
  enabled: false,
  announce: 'same',     // 'same' (no canal da mensagem) | 'channel' (num canal fixo) | 'off'
  channelId: null,
  message: '🎉 {usuario} subiu para o nível {nivel}!',
  cooldown: 60,         // segundos entre mensagens que dão XP
  rewards: [],          // [{ level, roleId }]
};

const toNext = (n) => 5 * n * n + 50 * n + 100;

function levelFromXp(xp) {
  let level = 0;
  let rest = xp;
  while (rest >= toNext(level)) { rest -= toNext(level); level++; }
  return { level, current: rest, needed: toNext(level) };
}

// Confere a configuração (cargos e canal são conferidos na rota, que conhece o servidor).
function cleanLevels(b = {}) {
  const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const id = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const rewards = (Array.isArray(b.rewards) ? b.rewards : [])
    .map((r) => ({ level: int(r && r.level, 1, 500, 0), roleId: id(r && r.roleId) }))
    .filter((r) => r.level > 0 && r.roleId);
  const seen = new Set();
  const unique = rewards.filter((r) => { const k = `${r.level}:${r.roleId}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b2) => a.level - b2.level).slice(0, 25);
  const message = String(b.message || '').replace(/\r\n/g, '\n').trim().slice(0, 300);
  return {
    enabled: !!b.enabled,
    announce: ['same', 'channel', 'off'].includes(b.announce) ? b.announce : 'same',
    channelId: id(b.channelId),
    message: message || DEFAULT_LEVELS.message,
    cooldown: int(b.cooldown, 0, 3600, DEFAULT_LEVELS.cooldown),
    rewards: unique,
  };
}

const cache = new Map(); // serverId -> { at, cfg }
async function configOf(serverId) {
  const c = cache.get(serverId);
  if (c && Date.now() - c.at < 30000) return c.cfg;
  const { rows } = await db.query('SELECT levels FROM servers WHERE id = $1', [serverId]);
  const cfg = rows[0] && rows[0].levels ? { ...DEFAULT_LEVELS, ...rows[0].levels } : null;
  cache.set(serverId, { at: Date.now(), cfg });
  return cfg;
}
const forget = (serverId) => cache.delete(serverId);

// Depois de uma mensagem nova num servidor: dá XP e, se subiu de nível, avisa e dá os cargos.
async function award(access, userId) {
  if (!access.serverId || !userId) return null;
  const cfg = await configOf(access.serverId);
  if (!cfg || !cfg.enabled) return null;
  const bot = await db.query('SELECT is_bot FROM users WHERE id = $1', [userId]);
  if (!bot.rows[0] || bot.rows[0].is_bot) return null;
  const gain = 15 + Math.floor(Math.random() * 11);
  const { rows } = await db.query(
    `INSERT INTO nexo_xp (server_id, user_id, xp, level, messages, last_at) VALUES ($1, $2, $3, 0, 1, now())
     ON CONFLICT (server_id, user_id) DO UPDATE SET
       messages = nexo_xp.messages + 1,
       xp = CASE WHEN nexo_xp.last_at IS NULL OR nexo_xp.last_at <= now() - make_interval(secs => $4) THEN nexo_xp.xp + $3 ELSE nexo_xp.xp END,
       last_at = CASE WHEN nexo_xp.last_at IS NULL OR nexo_xp.last_at <= now() - make_interval(secs => $4) THEN now() ELSE nexo_xp.last_at END
     RETURNING xp, level`,
    [access.serverId, userId, gain, cfg.cooldown],
  );
  const { xp, level: oldLevel } = rows[0];
  const { level } = levelFromXp(xp);
  if (level <= oldLevel) return null;
  // Só um processo "ganha" a subida (evita anunciar duas vezes).
  const up = await db.query(
    'UPDATE nexo_xp SET level = $3 WHERE server_id = $1 AND user_id = $2 AND level < $3 RETURNING level',
    [access.serverId, userId, level],
  );
  if (!up.rowCount) return null;
  await onLevelUp(access, userId, level, cfg).catch((err) => console.error('Erro ao subir de nível:', err.message));
  return level;
}

async function giveRewards(serverId, userId, level, cfg) {
  const roleIds = cfg.rewards.filter((r) => r.level <= level).map((r) => r.roleId);
  if (!roleIds.length) return [];
  const { rows } = await db.query(
    `INSERT INTO member_roles (server_id, user_id, role_id)
     SELECT $1, $2, r.id FROM roles r WHERE r.id = ANY($3::int[]) AND r.server_id = $1 AND NOT r.is_default
     ON CONFLICT DO NOTHING RETURNING role_id`,
    [serverId, userId, roleIds],
  );
  if (rows.length) events.serverChanged(serverId);
  return rows.map((r) => r.role_id);
}

async function onLevelUp(access, userId, level, cfg) {
  const newRoles = await giveRewards(access.serverId, userId, level, cfg);
  if (cfg.announce === 'off') return;
  let target = access;
  if (cfg.announce === 'channel' && cfg.channelId) {
    const a = await channelAccess(cfg.channelId, userId).catch(() => null);
    if (a && a.kind === 'text' && a.serverId === access.serverId) target = a;
  }
  if (!['text', 'thread'].includes(target.kind)) return;
  const { rows: u } = await db.query('SELECT username, display_name FROM users WHERE id = $1', [userId]);
  if (!u[0]) return;
  let names = [];
  if (newRoles.length) names = (await db.query('SELECT name FROM roles WHERE id = ANY($1::int[]) ORDER BY position DESC', [newRoles])).rows.map((r) => r.name);
  let text = String(cfg.message || DEFAULT_LEVELS.message)
    .replace(/\{usuario\}/gi, `@${u[0].username}`)
    .replace(/\{nome\}/gi, u[0].display_name)
    .replace(/\{nivel\}/gi, String(level));
  if (names.length) text += ` Ganhou o cargo ${names.map((n) => `**${n}**`).join(', ')}.`;
  // eslint-disable-next-line global-require
  const M = require('./messages');
  await M.createSystemMessage(target, userId, `⭐ ${text}`);
}

async function progressOf(serverId, userId) {
  const { rows } = await db.query(
    `SELECT x.xp, x.messages,
            (SELECT count(*)::int + 1 FROM nexo_xp y WHERE y.server_id = $1 AND y.xp > x.xp) AS rank
     FROM nexo_xp x WHERE x.server_id = $1 AND x.user_id = $2`,
    [serverId, userId],
  );
  const xp = rows[0] ? rows[0].xp : 0;
  return { xp, ...levelFromXp(xp), messages: rows[0] ? rows[0].messages : 0, rank: rows[0] && xp > 0 ? rows[0].rank : null };
}

async function ranking(serverId, limit = 10) {
  const { rows } = await db.query(
    `SELECT x.user_id, x.xp, x.messages, u.username, u.display_name, u.avatar_id
     FROM nexo_xp x JOIN users u ON u.id = x.user_id
     JOIN server_members m ON m.server_id = x.server_id AND m.user_id = x.user_id
     WHERE x.server_id = $1 AND x.xp > 0 ORDER BY x.xp DESC, x.user_id LIMIT $2`,
    [serverId, limit],
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    user: { id: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_id ? `/avatars/${r.avatar_id}` : null },
    xp: r.xp,
    messages: r.messages,
    ...levelFromXp(r.xp),
  }));
}

// Ao mudar as recompensas: dá os cargos para quem já tinha chegado no nível.
async function syncRewards(serverId, cfg) {
  if (!cfg.enabled || !cfg.rewards.length) return;
  const { rows } = await db.query('SELECT user_id, level FROM nexo_xp WHERE server_id = $1 AND level > 0', [serverId]);
  for (const r of rows) await giveRewards(serverId, r.user_id, r.level, cfg);
}

module.exports = { DEFAULT_LEVELS, cleanLevels, award, progressOf, ranking, levelFromXp, toNext, forget, syncRewards };
