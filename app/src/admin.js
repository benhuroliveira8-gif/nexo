// Administração do Nexo (a instância inteira, não um servidor): uso de disco,
// limpeza automática de anexos antigos, aviso de disco enchendo e códigos para nova senha.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const events = require('./events');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const DEFAULT_STORAGE = { maxAgeDays: 0, warnPercent: 85 }; // 0 = nunca apaga sozinho

// ---------------------------------------------------------------- Quem é administrador

const envAdmins = () => String(process.env.NEXO_ADMINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

async function isAdmin(userId) {
  const { rows } = await db.query('SELECT username, is_admin, is_bot FROM users WHERE id = $1 AND blocked_at IS NULL', [userId]);
  const u = rows[0];
  return !!u && !u.is_bot && (u.is_admin || envAdmins().includes(u.username));
}

// Contas citadas em NEXO_ADMINS viram administradoras ao iniciar.
async function syncEnvAdmins() {
  const list = envAdmins();
  if (list.length) await db.query('UPDATE users SET is_admin = true WHERE username = ANY($1::text[]) AND NOT is_bot', [list]);
}

// ---------------------------------------------------------------- Códigos

// Código fácil de ditar por mensagem: 8 letras/números sem os parecidos (0/O, 1/I).
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHA[crypto.randomInt(ALPHA.length)];
  return out;
}
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (v) => crypto.createHash('sha256').update(`nexo-recovery:${normCode(v)}`).digest('hex');
const group = (c) => c.match(/.{1,4}/g).join('-');

const newRecoveryKey = () => group(code(16)); // a pessoa guarda (vale uma vez)
const newResetCode = () => group(code(8));    // o administrador passa (vale 24 h)

// ---------------------------------------------------------------- Disco

async function dirSize(dir) {
  let total = 0;
  let count = 0;
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return { bytes: 0, count: 0 }; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { total += (await fs.promises.stat(path.join(dir, e.name))).size; count++; } catch { /* sumiu */ }
  }
  return { bytes: total, count };
}

async function diskInfo() {
  try {
    const st = await fs.promises.statfs(UPLOAD_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - free, percent: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch { return null; }
}

async function storageSettings() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'storage'");
  let v = {};
  try { v = rows[0] ? JSON.parse(rows[0].value) : {}; } catch { v = {}; }
  return { ...DEFAULT_STORAGE, ...v };
}

function cleanStorageSettings(b = {}) {
  const int = (x, min, max, def) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  return { maxAgeDays: int(b.maxAgeDays, 0, 3650, 0), warnPercent: int(b.warnPercent, 50, 99, 85) };
}

async function saveStorageSettings(v) {
  await db.query(
    "INSERT INTO app_settings (key, value) VALUES ('storage', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(v)],
  );
}

async function overview() {
  const [counts, att, avatars, disk, dbSize, settings, biggest, kinds] = await Promise.all([
    db.query(`SELECT
      (SELECT count(*)::int FROM users WHERE NOT is_bot) AS people,
      (SELECT count(*)::int FROM users WHERE is_bot) AS bots,
      (SELECT count(*)::int FROM users WHERE blocked_at IS NOT NULL) AS blocked,
      (SELECT count(*)::int FROM servers) AS servers,
      (SELECT count(*)::bigint FROM messages) AS messages`),
    db.query(`SELECT count(*)::int AS n, COALESCE(sum(size), 0)::bigint AS bytes,
                     count(*) FILTER (WHERE purged_at IS NOT NULL)::int AS purged
              FROM attachments WHERE message_id IS NOT NULL`),
    dirSize(path.join(UPLOAD_DIR, 'avatars')),
    diskInfo(),
    db.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
    storageSettings(),
    db.query(`SELECT u.id, u.username, u.display_name, COALESCE(sum(a.size), 0)::bigint AS bytes, count(a.id)::int AS files
              FROM attachments a JOIN users u ON u.id = a.uploader_id
              WHERE a.purged_at IS NULL GROUP BY u.id ORDER BY bytes DESC LIMIT 5`),
    db.query(`SELECT CASE WHEN is_voice THEN 'audio-voz' WHEN content_type LIKE 'image/%' THEN 'imagem'
                          WHEN content_type LIKE 'video/%' THEN 'video' WHEN content_type LIKE 'audio/%' THEN 'audio' ELSE 'outro' END AS kind,
                     COALESCE(sum(size), 0)::bigint AS bytes, count(*)::int AS n
              FROM attachments WHERE purged_at IS NULL GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  const c = counts.rows[0];
  const a = att.rows[0];
  const purgedBytes = await db.query('SELECT COALESCE(sum(size), 0)::bigint AS b FROM attachments WHERE purged_at IS NOT NULL');
  return {
    counts: { people: c.people, bots: c.bots, blocked: c.blocked, servers: c.servers, messages: Number(c.messages) },
    storage: {
      attachments: { count: a.n - a.purged, bytes: Number(a.bytes) - Number(purgedBytes.rows[0].b), purged: a.purged },
      avatars: avatars,
      database: Number(dbSize.rows[0].bytes),
      byKind: kinds.rows.map((k) => ({ kind: k.kind, bytes: Number(k.bytes), count: k.n })),
      topUsers: biggest.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, bytes: Number(u.bytes), files: u.files })),
    },
    disk,
    settings,
    diskWarning: disk && disk.percent >= settings.warnPercent,
  };
}

// ---------------------------------------------------------------- Limpeza de anexos antigos

// Apaga o ARQUIVO dos anexos mais velhos que N dias (a mensagem continua, com o aviso
// "arquivo antigo removido"). Devolve quantos e quantos bytes.
async function purgeOld(maxAgeDays) {
  if (!maxAgeDays || maxAgeDays < 1) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (;;) {
    const { rows } = await db.query(
      `UPDATE attachments SET purged_at = now()
       WHERE id IN (SELECT id FROM attachments WHERE purged_at IS NULL AND message_id IS NOT NULL
                      AND created_at < now() - make_interval(days => $1) LIMIT 500)
       RETURNING id, size`,
      [maxAgeDays],
    );
    if (!rows.length) break;
    for (const r of rows) {
      if (/^[a-f0-9]{32}$/.test(r.id)) await fs.promises.unlink(path.join(UPLOAD_DIR, r.id)).catch(() => {});
      count++;
      bytes += Number(r.size) || 0;
    }
  }
  if (count) console.log(`Limpeza: ${count} anexo(s) antigo(s) removido(s), ${Math.round(bytes / 1048576)} MB liberados.`);
  return { count, bytes };
}

// ---------------------------------------------------------------- Aviso de disco cheio

let lastWarnAt = 0;
async function checkDisk({ force = false } = {}) {
  const [disk, settings] = await Promise.all([diskInfo(), storageSettings()]);
  if (!disk || disk.percent < settings.warnPercent) return null;
  if (!force && Date.now() - lastWarnAt < 12 * 3600 * 1000) return disk;
  lastWarnAt = Date.now();
  const { rows } = await db.query('SELECT id FROM users WHERE is_admin AND NOT is_bot AND blocked_at IS NULL');
  const ids = rows.map((r) => r.id);
  const text = `O disco do Nexo está ${disk.percent}% cheio (sobram ${Math.round(disk.free / 1073741824 * 10) / 10} GB).`;
  events.emitTo(ids.map((id) => `user:${id}`), 'admin:disk', { ...disk, text });
  // eslint-disable-next-line global-require
  require('./push').sendToUsers(ids, { title: '⚠️ Disco do Nexo enchendo', body: `${text} Abra Administração do Nexo para limpar.`, url: '/?admin=1', tag: 'disco' })
    .catch(() => {});
  console.warn(`AVISO: ${text}`);
  return disk;
}

let timer = null;
function startStorageJobs() {
  const tick = async () => {
    try {
      const s = await storageSettings();
      await purgeOld(s.maxAgeDays);
      await checkDisk();
    } catch (err) { console.error('Erro na limpeza/verificação de disco:', err.message); }
  };
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, Number(process.env.STORAGE_TICK_MS) || 6 * 3600 * 1000);
  timer.unref();
}

module.exports = {
  isAdmin, syncEnvAdmins, newRecoveryKey, newResetCode, hashCode, normCode, overview, purgeOld, checkDisk,
  storageSettings, cleanStorageSettings, saveStorageSettings, startStorageJobs, diskInfo,
};
