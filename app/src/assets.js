// Figurinhas (stickers) e sons (soundboard) de cada servidor.
// O arquivo fica em uploads/stickers ou uploads/sounds; o banco guarda nome e arquivo.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const events = require('./events');
const { audit } = require('./audit');
const { P, memberContext } = require('./permissions');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

const KINDS = {
  sticker: {
    table: 'nexo_stickers', dir: path.join(UPLOAD_DIR, 'stickers'), url: '/sticker/',
    max: 30, maxBytes: 512 * 1024, label: 'figurinha', labelPlural: 'figurinhas',
    types: { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg' },
    detect(b) {
      if (b.length < 12) return null;
      if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
      if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
      if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
      return null;
    },
    formats: 'PNG, GIF, WEBP ou JPG',
  },
  sound: {
    table: 'nexo_sounds', dir: path.join(UPLOAD_DIR, 'sounds'), url: '/sound/',
    max: 24, maxBytes: 512 * 1024, label: 'som', labelPlural: 'sons',
    types: { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4' },
    detect(b) {
      if (b.length < 12) return null;
      if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
      if (b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
      if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'wav';
      if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
      if (b.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
      return null;
    },
    formats: 'MP3, OGG, WAV, WEBM ou M4A',
  },
};
for (const k of Object.values(KINDS)) fs.mkdirSync(k.dir, { recursive: true });

const FILE_RE = /^[a-f0-9]{24}\.(png|gif|webp|jpg|mp3|ogg|wav|webm|m4a)$/;

function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}
function cleanEmoji(raw) {
  const t = String(raw || '').trim();
  // Um emoji só (até 2 "grafemas" para pegar bandeiras/variações).
  const parts = [...new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(t)].map((x) => x.segment);
  if (!parts.length || parts.length > 2 || t.length > 16) return '🔊';
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t) ? t : '🔊';
}

const toJson = (kind, row) => ({
  id: row.id,
  name: row.name,
  serverId: row.server_id,
  url: `${KINDS[kind].url}${row.id}`,
  ...(kind === 'sound' ? { emoji: row.emoji } : { animated: /\.gif$/.test(row.file) }),
  ...(row.server_name ? { serverName: row.server_name } : {}),
});

async function list(kind, serverId) {
  const { rows } = await db.query(`SELECT * FROM ${KINDS[kind].table} WHERE server_id = $1 ORDER BY name`, [serverId]);
  return rows.map((r) => toJson(kind, r));
}

// Figurinhas de todos os servidores da pessoa (para usar nas DMs).
async function listForUser(kind, userId) {
  const { rows } = await db.query(
    `SELECT a.*, s.name AS server_name FROM ${KINDS[kind].table} a
     JOIN servers s ON s.id = a.server_id
     JOIN server_members m ON m.server_id = a.server_id AND m.user_id = $1
     ORDER BY m.joined_at, a.name`,
    [userId],
  );
  return rows.map((r) => toJson(kind, r));
}

async function get(kind, id) {
  const { rows } = await db.query(`SELECT * FROM ${KINDS[kind].table} WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function create(kind, { serverId, userId, name, emoji, data }) {
  const k = KINDS[kind];
  const clean = cleanName(name);
  if (clean.length < 2) return { error: `Dê um nome à ${k.label} (2 a 30 letras).` };
  const ext = k.detect(data);
  if (!ext) return { error: `Envie um arquivo ${k.formats}.` };
  if (data.length > k.maxBytes) return { error: `O arquivo pode ter no máximo ${Math.round(k.maxBytes / 1024)} KB.` };
  const { rows: count } = await db.query(`SELECT count(*)::int AS n FROM ${k.table} WHERE server_id = $1`, [serverId]);
  if (count[0].n >= k.max) return { error: `O servidor já tem ${k.max} ${k.labelPlural} (o máximo).` };
  const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(k.dir, file), data);
  try {
    const { rows } = kind === 'sound'
      ? await db.query('INSERT INTO nexo_sounds (server_id, name, emoji, file, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [serverId, clean, cleanEmoji(emoji), file, userId])
      : await db.query('INSERT INTO nexo_stickers (server_id, name, file, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [serverId, clean, file, userId]);
    return { item: toJson(kind, rows[0]) };
  } catch (err) {
    fs.unlink(path.join(k.dir, file), () => {});
    if (err.code === '23505') return { error: `Já existe ${kind === 'sound' ? 'um som' : 'uma figurinha'} chamado "${clean}".` };
    throw err;
  }
}

function removeFile(kind, file) {
  if (FILE_RE.test(file)) fs.unlink(path.join(KINDS[kind].dir, file), () => {});
}

// GET /sticker/:id e /sound/:id — públicos (só o arquivo), com cache.
function serve(kind) {
  const k = KINDS[kind];
  return (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 2 ** 31) return res.status(404).end();
    db.query(`SELECT file FROM ${k.table} WHERE id = $1`, [id]).then(({ rows }) => {
      const f = rows[0] && FILE_RE.exec(rows[0].file);
      if (!f || !k.types[f[1]]) return res.status(404).end();
      res.set({
        'Content-Type': k.types[f[1]],
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'public, max-age=86400',
      });
      res.sendFile(path.join(k.dir, rows[0].file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
    }).catch(next);
  };
}

// Envio do arquivo (corpo cru). Cabeçalhos: X-Asset-Name e, para sons, X-Asset-Emoji.
function uploadRouter(requireAuth) {
  const r = express.Router();
  for (const kind of Object.keys(KINDS)) {
    r.post(`/servers/:id/${kind}s`,
      requireAuth,
      express.raw({ type: 'application/octet-stream', limit: KINDS[kind].maxBytes + 1024 }),
      async (req, res, next) => {
        try {
          if (req.isBot) return res.status(403).json({ error: 'Bots não podem fazer isso.' });
          const serverId = Number(req.params.id);
          const ctx = Number.isInteger(serverId) && serverId > 0 && await memberContext(serverId, req.userId);
          if (!ctx) return res.status(404).json({ error: 'Servidor não encontrado.' });
          if (!ctx.can(P.MANAGE_EMOJIS)) return res.status(403).json({ error: 'Você não tem permissão para isso.' });
          const dec = (v) => { try { return decodeURIComponent(v || ''); } catch { return v || ''; } };
          const result = await create(kind, {
            serverId, userId: req.userId, name: dec(req.get('x-asset-name')), emoji: dec(req.get('x-asset-emoji')), data: req.body,
          });
          if (result.error) return res.status(400).json({ error: result.error });
          audit(serverId, req.userId, `${kind}_create`, { targetId: result.item.id, targetName: result.item.name });
          events.serverChanged(serverId);
          res.status(201).json({ [kind]: result.item });
        } catch (err) {
          next(err);
        }
      });
  }
  return r;
}

module.exports = { KINDS, list, listForUser, get, create, removeFile, serve, uploadRouter, toJson, cleanName, cleanEmoji };
