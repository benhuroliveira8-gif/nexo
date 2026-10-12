// Boas-vindas (cargo automático + mensagem) e moderação automática
// (filtro de palavras e anti-spam com castigo automático).
const db = require('./db');
const events = require('./events');
const voice = require('./voice');
const { audit } = require('./audit');
const { P, channelAccess } = require('./permissions');

// ---------------------------------------------------------------- Configurações

const DEFAULT_AUTOMOD = {
  words: [],              // palavras bloqueadas
  wordsTimeout: 0,        // minutos de castigo ao usar palavra bloqueada (0 = só bloqueia)
  spam: false,            // anti-spam ligado?
  spamCount: 5,           // N mensagens...
  spamSeconds: 10,        // ...em X segundos
  spamDuplicates: 3,      // mesma mensagem repetida N vezes (em 60 s)
  spamMentions: 6,        // menções numa mensagem só
  spamTimeout: 5,         // minutos de castigo
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function cleanAutomod(b = {}) {
  const words = (Array.isArray(b.words) ? b.words : String(b.words || '').split(/[\n,]/))
    .map((w) => norm(w).replace(/\s+/g, ' ').trim()).filter((w) => w.length >= 2 && w.length <= 40);
  const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  return {
    words: [...new Set(words)].slice(0, 200),
    wordsTimeout: int(b.wordsTimeout, 0, 1440, 0),
    spam: !!b.spam,
    spamCount: int(b.spamCount, 3, 30, DEFAULT_AUTOMOD.spamCount),
    spamSeconds: int(b.spamSeconds, 3, 120, DEFAULT_AUTOMOD.spamSeconds),
    spamDuplicates: int(b.spamDuplicates, 2, 20, DEFAULT_AUTOMOD.spamDuplicates),
    spamMentions: int(b.spamMentions, 2, 50, DEFAULT_AUTOMOD.spamMentions),
    spamTimeout: int(b.spamTimeout, 1, 1440, DEFAULT_AUTOMOD.spamTimeout),
  };
}

function cleanWelcome(b = {}) {
  const message = String(b.message || '').replace(/\r\n/g, '\n').trim().slice(0, 500);
  const id = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  return { enabled: !!b.enabled, channelId: id(b.channelId), message: message || 'Boas-vindas, {usuario}! 👋', roleId: id(b.roleId) };
}

// Cache curto (a configuração muda pouco e é lida a cada mensagem).
const cache = new Map(); // serverId -> { at, automod }
async function automodOf(serverId) {
  const c = cache.get(serverId);
  if (c && Date.now() - c.at < 30000) return c.automod;
  const { rows } = await db.query('SELECT automod FROM servers WHERE id = $1', [serverId]);
  const automod = rows[0] && rows[0].automod ? { ...DEFAULT_AUTOMOD, ...rows[0].automod } : null;
  cache.set(serverId, { at: Date.now(), automod });
  return automod;
}
const forget = (serverId) => cache.delete(serverId);

// ---------------------------------------------------------------- Filtro e anti-spam

const recent = new Map(); // `${serverId}:${userId}` -> [{ t, content }]
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of recent) if (list.every((m) => now - m.t > 120000)) recent.delete(k);
}, 60000).unref();

function hasBlockedWord(content, words) {
  if (!words.length) return null;
  const text = ` ${norm(content).replace(/[^a-z0-9]+/g, ' ')} `;
  for (const w of words) {
    const ww = ` ${w.replace(/[^a-z0-9]+/g, ' ').trim()} `;
    if (ww.trim() && text.includes(ww)) return w;
  }
  return null;
}

async function punish(access, userId, minutes, why) {
  await db.query(
    `UPDATE server_members SET timeout_until = now() + make_interval(mins => $3)
     WHERE server_id = $1 AND user_id = $2`,
    [access.serverId, userId, minutes],
  );
  voice.leaveServer(userId, access.serverId);
  const { rows } = await db.query('SELECT display_name FROM users WHERE id = $1', [userId]);
  audit(access.serverId, null, 'automod_timeout', { targetId: userId, targetName: rows[0] && rows[0].display_name, details: { minutes, reason: why } });
  events.serverChanged(access.serverId);
  return rows[0] ? rows[0].display_name : 'Alguém';
}

// Confere a mensagem antes de salvar. Devolve null (ok) ou { error, punished }.
// "mentions" = quantas pessoas foram mencionadas.
async function check(access, userId, content, { editing = false, mentions = 0 } = {}) {
  if (!access.serverId || access.isAdmin || access.can(P.MANAGE_MESSAGES)) return null;
  const am = await automodOf(access.serverId);
  if (!am) return null;
  const bad = hasBlockedWord(content, am.words || []);
  if (bad) {
    if (am.wordsTimeout > 0 && !editing) {
      const name = await punish(access, userId, am.wordsTimeout, 'palavra bloqueada');
      return { error: `Sua mensagem tem uma palavra bloqueada neste servidor. Você ficou de castigo por ${am.wordsTimeout} min.`, punished: name, minutes: am.wordsTimeout };
    }
    return { error: 'Sua mensagem tem uma palavra bloqueada neste servidor.' };
  }
  if (!am.spam || editing) return null;
  const key = `${access.serverId}:${userId}`;
  const now = Date.now();
  const list = (recent.get(key) || []).filter((m) => now - m.t < 60000);
  list.push({ t: now, content: norm(content).trim() });
  recent.set(key, list);
  const inWindow = list.filter((m) => now - m.t < am.spamSeconds * 1000).length;
  const dup = content.trim() ? list.filter((m) => m.content === norm(content).trim()).length : 0;
  let why = null;
  if (inWindow > am.spamCount) why = `mais de ${am.spamCount} mensagens em ${am.spamSeconds} s`;
  else if (dup >= am.spamDuplicates) why = `a mesma mensagem ${dup} vezes`;
  else if (mentions > am.spamMentions) why = `${mentions} menções numa mensagem`;
  if (!why) return null;
  recent.delete(key);
  const name = await punish(access, userId, am.spamTimeout, `spam: ${why}`);
  return { error: `Calma! O anti-spam te deixou de castigo por ${am.spamTimeout} min (${why}).`, punished: name, minutes: am.spamTimeout, why };
}

// ---------------------------------------------------------------- Boas-vindas

async function onMemberJoined(serverId, userId) {
  const { rows } = await db.query('SELECT welcome FROM servers WHERE id = $1', [serverId]);
  const w = rows[0] && rows[0].welcome;
  if (!w) return;
  if (w.roleId) {
    await db.query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       SELECT $1, $2, r.id FROM roles r WHERE r.id = $3 AND r.server_id = $1 AND NOT r.is_default
       ON CONFLICT DO NOTHING`,
      [serverId, userId, w.roleId],
    ).catch((err) => console.error('Erro no cargo automático:', err.message));
  }
  if (w.enabled && w.channelId) {
    const access = await channelAccess(w.channelId, userId).catch(() => null);
    if (!access || access.kind !== 'text') return;
    const { rows: u } = await db.query('SELECT username, display_name FROM users WHERE id = $1', [userId]);
    const { rows: s } = await db.query('SELECT name FROM servers WHERE id = $1', [serverId]);
    if (!u[0]) return;
    const text = String(w.message || 'Boas-vindas, {usuario}! 👋')
      .replace(/\{usuario\}/gi, `@${u[0].username}`)
      .replace(/\{nome\}/gi, u[0].display_name)
      .replace(/\{servidor\}/gi, s[0] ? s[0].name : '');
    // eslint-disable-next-line global-require
    const M = require('./messages');
    await M.createSystemMessage(access, userId, `👋 ${text}`);
  }
}

module.exports = { DEFAULT_AUTOMOD, cleanAutomod, cleanWelcome, check, forget, onMemberJoined, hasBlockedWord };
