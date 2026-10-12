// Perfil mais rico: cor, "jogando agora", horário de silêncio ("não perturbe" agendado)
// e insígnias (fundador, mais ativo do mês, pioneiro...).
const db = require('./db');
const levels = require('./levels');

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ACTIVITY_TYPES = ['playing', 'listening', 'watching', 'streaming'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function cleanColor(v, fail) {
  if (v === null || v === '') return null;
  if (!COLOR_RE.test(String(v))) fail(400, 'Cor do perfil inválida.');
  return String(v).toLowerCase();
}

// { type: 'playing', name: 'Minecraft' } -> guarda também desde quando.
function cleanActivity(v, previous, fail) {
  if (!v) return null;
  const type = ACTIVITY_TYPES.includes(v.type) ? v.type : 'playing';
  const name = String(v.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.length > 64) fail(400, 'O nome do jogo/atividade pode ter no máximo 64 caracteres.');
  const same = previous && previous.name === name && previous.type === type;
  return { type, name, since: same && previous.since ? previous.since : new Date().toISOString() };
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

// { enabled, start: '23:00', end: '07:00', tz: 'America/Sao_Paulo' }
function cleanDndSchedule(v, fail) {
  if (!v) return null;
  const start = String(v.start || '');
  const end = String(v.end || '');
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) fail(400, 'Horário inválido (use 23:00).');
  if (start === end) fail(400, 'O começo e o fim do silêncio não podem ser iguais.');
  const tz = String(v.tz || 'America/Sao_Paulo').slice(0, 64);
  if (!validTz(tz)) fail(400, 'Fuso horário inválido.');
  return { enabled: !!v.enabled, start, end, tz };
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Está no horário de silêncio agora?
function quietNow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled || !TIME_RE.test(schedule.start || '') || !TIME_RE.test(schedule.end || '')) return false;
  let hh; let mm;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.tz || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    hh = Number(parts.find((p) => p.type === 'hour').value);
    mm = Number(parts.find((p) => p.type === 'minute').value);
  } catch { return false; }
  const cur = (hh % 24) * 60 + mm;
  const a = toMin(schedule.start);
  const b = toMin(schedule.end);
  return a < b ? cur >= a && cur < b : cur >= a || cur < b; // atravessa a meia-noite
}

// Dos usuários da lista, quem NÃO está em silêncio agora.
async function notQuiet(userIds) {
  if (!userIds.length) return [];
  const { rows } = await db.query('SELECT id, dnd_schedule FROM users WHERE id = ANY($1::int[])', [userIds]);
  const quiet = new Set(rows.filter((r) => quietNow(r.dnd_schedule)).map((r) => r.id));
  return userIds.filter((id) => !quiet.has(id));
}

// ---------------------------------------------------------------- Insígnias

const BADGES = {
  pioneer: { emoji: '🚀', label: 'Pioneiro(a) do Nexo' },
  veteran: { emoji: '🎖️', label: 'Veterano(a): mais de 1 ano no Nexo' },
  dev: { emoji: '🛠️', label: 'Criador(a) de bots' },
  founder: { emoji: '👑', label: 'Fundador(a) do servidor' },
  active: { emoji: '🔥', label: 'Mais ativo(a) do mês' },
  top3: { emoji: '🏆', label: 'Top 3 do ranking de níveis' },
};
const badge = (id) => ({ id, ...BADGES[id] });

async function badgesFor(userRow, serverId, viewerId) {
  const out = [];
  if (userRow.is_bot) return out;
  const { rows: g } = await db.query(
    `SELECT (SELECT count(*)::int FROM users WHERE NOT is_bot AND id < $1) AS before,
            EXISTS (SELECT 1 FROM users WHERE bot_owner_id = $1 AND is_bot) AS dev`,
    [userRow.id],
  );
  if (g[0].before < 10) out.push(badge('pioneer'));
  if (Date.now() - new Date(userRow.created_at) > 365 * 86400000) out.push(badge('veteran'));
  if (g[0].dev) out.push(badge('dev'));
  if (!serverId) return out;
  // Insígnias do servidor: só se quem olha e a pessoa estão nele.
  const { rows: s } = await db.query(
    `SELECT s.owner_id, s.levels FROM servers s
     WHERE s.id = $1 AND EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)
       AND EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $3)`,
    [serverId, userRow.id, viewerId],
  );
  if (!s[0]) return out;
  if (s[0].owner_id === userRow.id) out.push(badge('founder'));
  if (await mostActiveOfMonth(serverId) === userRow.id) out.push(badge('active'));
  if (s[0].levels && s[0].levels.enabled) {
    const { rows: top } = await db.query('SELECT user_id FROM nexo_xp WHERE server_id = $1 AND xp > 0 ORDER BY xp DESC, user_id LIMIT 3', [serverId]);
    if (top.some((r) => r.user_id === userRow.id)) out.push(badge('top3'));
  }
  return out;
}

// Quem mais mandou mensagens no servidor nos últimos 30 dias (mínimo 5). Cache de 10 min.
const activeCache = new Map();
async function mostActiveOfMonth(serverId) {
  const c = activeCache.get(serverId);
  if (c && Date.now() - c.at < 600000) return c.userId;
  const { rows } = await db.query(
    `SELECT m.author_id, count(*)::int AS n FROM messages m JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     WHERE c.server_id = $1 AND m.kind = 'default' AND NOT u.is_bot AND m.created_at > now() - interval '30 days'
     GROUP BY m.author_id ORDER BY n DESC, m.author_id LIMIT 1`,
    [serverId],
  );
  const userId = rows[0] && rows[0].n >= 5 ? rows[0].author_id : null;
  activeCache.set(serverId, { at: Date.now(), userId });
  return userId;
}

async function levelInfo(serverId, userId, viewerId) {
  const { rows } = await db.query(
    `SELECT s.levels FROM servers s WHERE s.id = $1
       AND EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)
       AND EXISTS (SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $3)`,
    [serverId, userId, viewerId],
  );
  if (!rows[0] || !rows[0].levels || !rows[0].levels.enabled) return null;
  return levels.progressOf(serverId, userId);
}

module.exports = {
  cleanColor, cleanActivity, cleanDndSchedule, quietNow, notQuiet, badgesFor, levelInfo, BADGES,
  _clearCache: () => activeCache.clear(),
};
