// Painel de saúde (Administração do Nexo): há quanto tempo está no ar, reinícios e quedas,
// CPU e memória da VM, banco, servidor de voz e idade do último backup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');

const VERSION = require('../package.json').version;
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const LIVEKIT_URL = (process.env.LIVEKIT_INTERNAL_URL || 'http://livekit:7880').replace(/\/$/, '');
const BEAT_MS = Number(process.env.HEALTH_BEAT_MS) || 60 * 1000;

let runId = null;
let beat = null;

// Ao ligar: se a vez anterior não desligou direitinho, foi uma queda (falta de luz, travou...).
async function startRun() {
  await db.query('UPDATE nexo_runs SET clean = false WHERE stopped_at IS NULL AND clean IS NULL');
  const { rows } = await db.query('INSERT INTO nexo_runs (version) VALUES ($1) RETURNING id', [VERSION]);
  runId = rows[0].id;
  await db.query('DELETE FROM nexo_runs WHERE id < $1 - 200', [runId]);
  beat = setInterval(() => {
    db.query('UPDATE nexo_runs SET last_beat = now() WHERE id = $1', [runId]).catch(() => {});
  }, BEAT_MS);
  beat.unref();
}

// Desligou certinho (atualização, reinício pelo Docker).
async function stopRun() {
  if (!runId) return;
  clearInterval(beat);
  await db.query('UPDATE nexo_runs SET stopped_at = now(), last_beat = now(), clean = true WHERE id = $1', [runId]).catch(() => {});
}

function cpuTimes() {
  return os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
}

async function cpuPercent(ms = 400) {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 100) : 0;
}

async function backups() {
  let names = [];
  try { names = await fs.promises.readdir(BACKUP_DIR); } catch { return { available: false, list: [] }; }
  const list = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const dir = path.join(BACKUP_DIR, n);
    try {
      const ok = await fs.promises.stat(path.join(dir, 'OK'));
      let size = 0;
      for (const f of ['banco.dump', 'anexos.tar.gz']) size += (await fs.promises.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
      list.push({ name: n, at: ok.mtime.toISOString(), size });
    } catch { /* incompleto ou não é backup */ }
  }
  list.sort((x, y) => (x.at < y.at ? 1 : -1));
  const last = list[0] || null;
  const ageHours = last ? Math.round((Date.now() - new Date(last.at)) / 360000) / 10 : null;
  return { available: true, count: list.length, last, ageHours, old: ageHours === null || ageHours > 36, list: list.slice(0, 5) };
}

async function timed(fn) {
  const t = Date.now();
  try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (err) { return { ok: false, ms: Date.now() - t, error: err.message }; }
}

async function health() {
  const [cpu, bk, dbCheck, voiceCheck, runs] = await Promise.all([
    cpuPercent(),
    backups(),
    timed(() => db.query('SELECT 1')),
    timed(async () => {
      // Qualquer resposta HTTP serve: quer dizer que o LiveKit está de pé.
      await fetch(LIVEKIT_URL, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    }),
    db.query('SELECT id, started_at, last_beat, stopped_at, clean, version FROM nexo_runs ORDER BY id DESC LIMIT 11'),
  ]);
  // Para cada vez que ligou: ficou fora do ar quanto tempo antes de ligar?
  const r = runs.rows;
  const restarts = r.slice(0, 10).map((run, i) => {
    const prev = r[i + 1];
    const downSeconds = prev ? Math.max(0, Math.round((new Date(run.started_at) - new Date(prev.stopped_at || prev.last_beat)) / 1000)) : null;
    return {
      startedAt: run.started_at,
      version: run.version,
      current: run.id === runId,
      // Como a vez anterior terminou: atualização/reinício (true) ou queda (false).
      previousClean: prev ? prev.clean !== false : null,
      downSeconds,
    };
  });
  const mem = process.memoryUsage();
  return {
    app: { version: VERSION, uptimeSeconds: Math.round(process.uptime()), memoryBytes: mem.rss, node: process.version },
    system: {
      cpuPercent: cpu,
      cpus: os.cpus().length,
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      memPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      uptimeSeconds: Math.round(os.uptime()),
    },
    services: { database: dbCheck, voice: voiceCheck },
    restarts,
    crashes: restarts.filter((x) => x.previousClean === false).length,
    backups: bk,
  };
}

module.exports = { startRun, stopRun, health };
