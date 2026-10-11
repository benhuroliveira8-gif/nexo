// Emojis personalizados: cada servidor pode ter os seus (até 50).
// Na mensagem eles ficam como <:nome:id> (ou <a:nome:id> se for animado);
// quem digita só escreve :nome: e o servidor troca sozinho.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const EMOJI_DIR = path.join(UPLOAD_DIR, 'emojis');
fs.mkdirSync(EMOJI_DIR, { recursive: true });

const MAX_PER_SERVER = 50;
const MAX_BYTES = 256 * 1024;
const NAME_RE = /^[a-z0-9_]{2,32}$/;
const TOKEN_RE = /^<(a?):([a-z0-9_]{2,32}):(\d{1,10})>$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const cleanName = (raw) => String(raw || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

const toJson = (row) => ({
  id: row.id,
  name: row.name,
  animated: row.animated,
  url: `/emoji/${row.id}`,
  serverId: row.server_id,
  ...(row.server_name ? { serverName: row.server_name } : {}),
});
const token = (row) => `<${row.animated ? 'a' : ''}:${row.name}:${row.id}>`;

function imageExt(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// GIF com mais de um quadro = animado.
function isAnimatedGif(b) {
  let frames = 0;
  for (let i = 0; i < b.length - 1 && frames < 2; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
  return frames > 1;
}

async function listForServer(serverId) {
  const { rows } = await db.query('SELECT * FROM nexo_emojis WHERE server_id = $1 ORDER BY name', [serverId]);
  return rows.map(toJson);
}

// Todos os emojis dos servidores em que a pessoa está (para usar nas DMs).
async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT e.*, s.name AS server_name FROM nexo_emojis e
     JOIN servers s ON s.id = e.server_id
     JOIN server_members m ON m.server_id = e.server_id AND m.user_id = $1
     ORDER BY m.joined_at, e.name`,
    [userId],
  );
  return rows.map(toJson);
}

// Troca :nome: por <:nome:id> (fora de `código`). Em servidor usa os emojis dele;
// em DM, os de todos os servidores da pessoa (o primeiro com aquele nome).
async function expand(content, { serverId, userId }) {
  if (!content || !/:[a-z0-9_]{2,32}:/.test(content)) return content;
  const { rows } = serverId
    ? await db.query('SELECT id, name, animated FROM nexo_emojis WHERE server_id = $1', [serverId])
    : await db.query(
      `SELECT e.id, e.name, e.animated FROM nexo_emojis e
       JOIN server_members m ON m.server_id = e.server_id AND m.user_id = $1 ORDER BY m.joined_at, e.id`,
      [userId],
    );
  if (!rows.length) return content;
  const byName = new Map();
  rows.forEach((r) => { if (!byName.has(r.name)) byName.set(r.name, r); });
  // Partes que não mexemos: blocos de código, `código` e emojis que já viraram <:nome:id>.
  return content.split(/(```[\s\S]*?```|`[^`\n]*`|<a?:[a-z0-9_]{2,32}:\d{1,10}>)/g).map((part, i) => (i % 2 === 1 ? part
    : part.replace(/:([a-z0-9_]{2,32}):/g, (m, name) => {
      const e = byName.get(name);
      return e ? token(e) : m;
    }))).join('');
}

// Reação com emoji personalizado: <:nome:id> de um servidor em que a pessoa está.
async function validReaction(text, userId) {
  const m = TOKEN_RE.exec(String(text || ''));
  if (!m) return false;
  const { rows } = await db.query(
    `SELECT e.name, e.animated FROM nexo_emojis e
     JOIN server_members sm ON sm.server_id = e.server_id AND sm.user_id = $2
     WHERE e.id = $1`,
    [Number(m[3]), userId],
  );
  return !!(rows[0] && rows[0].name === m[2] && rows[0].animated === (m[1] === 'a'));
}

async function create({ serverId, userId, name, data }) {
  const clean = cleanName(name);
  if (!NAME_RE.test(clean)) return { error: 'O nome do emoji precisa ter de 2 a 32 letras, números ou _.' };
  const ext = imageExt(data);
  if (!ext) return { error: 'Envie uma imagem PNG, JPG, GIF ou WEBP.' };
  if (data.length > MAX_BYTES) return { error: 'O emoji pode ter no máximo 256 KB.' };
  const { rows: count } = await db.query('SELECT count(*)::int AS n FROM nexo_emojis WHERE server_id = $1', [serverId]);
  if (count[0].n >= MAX_PER_SERVER) return { error: `O servidor já tem ${MAX_PER_SERVER} emojis (o máximo).` };
  const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(EMOJI_DIR, file), data);
  try {
    const { rows } = await db.query(
      `INSERT INTO nexo_emojis (server_id, name, file, animated, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [serverId, clean, file, ext === 'gif' && isAnimatedGif(data), userId],
    );
    return { emoji: toJson(rows[0]) };
  } catch (err) {
    fs.unlink(path.join(EMOJI_DIR, file), () => {});
    if (err.code === '23505') return { error: `Já existe um emoji chamado :${clean}: neste servidor.` };
    throw err;
  }
}

function removeFile(file) {
  if (/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(file)) fs.unlink(path.join(EMOJI_DIR, file), () => {});
}

// GET /emoji/:id — público (é só a imagem), com cache longo.
function serve(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2 ** 31) return res.status(404).end();
  db.query('SELECT file FROM nexo_emojis WHERE id = $1', [id]).then(({ rows }) => {
    const f = rows[0] && /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.exec(rows[0].file);
    if (!f) return res.status(404).end();
    res.set({
      'Content-Type': TYPES[f[1]],
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=86400',
    });
    res.sendFile(path.join(EMOJI_DIR, rows[0].file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }).catch(next);
}

module.exports = {
  MAX_BYTES, TOKEN_RE, NAME_RE, cleanName, toJson, listForServer, listForUser, expand, validReaction, create, removeFile, serve,
};
