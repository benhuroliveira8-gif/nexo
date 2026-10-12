// Upload e download de anexos. Os arquivos ficam em UPLOAD_DIR (um volume do Docker),
// e cada um tem um id aleatório e impossível de adivinhar.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const S = require('./serializers');
const events = require('./events');
const { audit } = require('./audit');
const { P, memberContext } = require('./permissions');
const emojis = require('./emojis');
const { extractText } = require('./pdftext');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const MAX_SIZE = (Number(process.env.MAX_UPLOAD_MB) || 8) * 1024 * 1024;
const ORPHAN_AFTER_MIN = 60; // anexos enviados mas nunca usados numa mensagem

const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
// Fotos, capas e ícones (GIF animado costuma ser maior: até 8 MB).
const AVATAR_MAX = 8 * 1024 * 1024;

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const filePath = (id) => path.join(UPLOAD_DIR, id);

function removeFile(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return;
  fs.unlink(filePath(id), () => {});
}

function cleanName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').trim();
  return (base || 'arquivo').slice(0, 120);
}

function cleanType(type) {
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) && t.length <= 100 ? t : 'application/octet-stream';
}

function uploadRouter(requireAuth) {
  const r = express.Router();

  // O navegador manda o arquivo "cru" no corpo; nome e tipo vão nos cabeçalhos.
  r.post('/uploads',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: MAX_SIZE }),
    async (req, res, next) => {
      try {
        const data = req.body;
        if (!Buffer.isBuffer(data) || data.length === 0) {
          return res.status(400).json({ error: 'Arquivo vazio.' });
        }
        let name = req.get('x-file-name') || 'arquivo';
        try { name = decodeURIComponent(name); } catch { /* usa como veio */ }

        const id = crypto.randomBytes(16).toString('hex');
        // Mensagem de voz: o navegador manda a duração e a "onda" (barrinhas) do áudio.
        const type = cleanType(req.get('x-file-type'));
        const duration = Number(req.get('x-voice-duration'));
        const isVoice = type.startsWith('audio/') && Number.isFinite(duration) && duration > 0 && duration <= 20 * 60;
        const waveform = isVoice && /^[A-Za-z0-9_-]{1,200}$/.test(req.get('x-voice-waveform') || '') ? req.get('x-voice-waveform') : null;
        // Transcrição feita no navegador enquanto a pessoa gravava (quando o navegador sabe fazer).
        let transcript = null;
        if (isVoice && req.get('x-voice-transcript')) {
          try { transcript = decodeURIComponent(req.get('x-voice-transcript')).replace(/\s+/g, ' ').trim().slice(0, 4000) || null; } catch { transcript = null; }
        }
        const { rows } = await db.query(
          `INSERT INTO attachments (id, uploader_id, filename, content_type, size, is_voice, duration, waveform, transcript)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [id, req.userId, cleanName(name), type, data.length, isVoice, isVoice ? duration : null, waveform, transcript],
        );
        try {
          await fs.promises.writeFile(filePath(id), data);
        } catch (err) {
          await db.query('DELETE FROM attachments WHERE id = $1', [id]);
          throw err;
        }
        res.status(201).json({ attachment: S.attachment(rows[0]) });
        // PDF/texto: guarda o que está escrito dentro, para a busca achar.
        if (!isVoice && data.length <= 25 * 1024 * 1024) {
          setImmediate(() => {
            const text = extractText(data, type, rows[0].filename);
            if (text) db.query('UPDATE attachments SET text_content = $2 WHERE id = $1', [id, text]).catch(() => {});
          });
        }
      } catch (err) {
        next(err);
      }
    });

  // Foto de perfil: imagem crua (o navegador já recorta e reduz para 256x256).
  r.post('/me/avatar',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: AVATAR_MAX }),
    async (req, res, next) => {
      try {
        if (req.isBot) return res.status(403).json({ error: 'Bots não podem fazer isso.' });
        const data = req.body;
        const ext = Buffer.isBuffer(data) && imageExt(data);
        if (!ext) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, GIF ou WEBP.' });
        const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(AVATAR_DIR, id), data);
        const { rows } = await db.query(
          `UPDATE users u SET avatar_id = $2 FROM users old
           WHERE u.id = $1 AND old.id = u.id
           RETURNING old.avatar_id AS previous, u.*`,
          [req.userId, id],
        );
        if (rows[0]?.previous) removeAvatar(rows[0].previous);
        res.json({ user: S.me(rows[0]) });
        avatarChanged(req.userId);
      } catch (err) {
        next(err);
      }
    });

  // Capa do perfil (banner): imagem crua, o navegador já reduz para 960x384.
  r.post('/me/banner',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: AVATAR_MAX }),
    async (req, res, next) => {
      try {
        if (req.isBot) return res.status(403).json({ error: 'Bots não podem fazer isso.' });
        const data = req.body;
        const ext = Buffer.isBuffer(data) && imageExt(data);
        if (!ext) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, GIF ou WEBP.' });
        const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(AVATAR_DIR, id), data);
        const { rows } = await db.query(
          `UPDATE users u SET banner_id = $2 FROM users old
           WHERE u.id = $1 AND old.id = u.id
           RETURNING old.banner_id AS previous, u.*`,
          [req.userId, id],
        );
        if (rows[0]?.previous) removeAvatar(rows[0].previous);
        res.json({ user: S.me(rows[0]) });
        avatarChanged(req.userId);
      } catch (err) {
        next(err);
      }
    });

  // Ícone do servidor (quem pode gerenciar o servidor). Imagem crua, já reduzida pelo navegador.
  r.post('/servers/:id/icon',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: AVATAR_MAX }),
    async (req, res, next) => {
      try {
        const serverId = Number(req.params.id);
        const ctx = Number.isInteger(serverId) && serverId > 0 && await memberContext(serverId, req.userId);
        if (!ctx) return res.status(404).json({ error: 'Servidor não encontrado.' });
        if (!ctx.can(P.MANAGE_SERVER)) return res.status(403).json({ error: 'Você não tem permissão para isso.' });
        const data = req.body;
        const ext = Buffer.isBuffer(data) && imageExt(data);
        if (!ext) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, GIF ou WEBP.' });
        const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(AVATAR_DIR, id), data);
        const { rows } = await db.query(
          `UPDATE servers s SET icon_id = $2 FROM servers old WHERE s.id = $1 AND old.id = s.id
           RETURNING old.icon_id AS previous, s.*`,
          [serverId, id],
        );
        if (rows[0]?.previous) removeAvatar(rows[0].previous);
        audit(serverId, req.userId, 'server_icon');
        events.serverChanged(serverId);
        res.json({ server: S.server(rows[0]) });
      } catch (err) {
        next(err);
      }
    });

  // Capa do servidor (banner), quem pode gerenciar o servidor. Imagem crua (GIF animado vale).
  r.post('/servers/:id/banner',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: AVATAR_MAX }),
    async (req, res, next) => {
      try {
        const serverId = Number(req.params.id);
        const ctx = Number.isInteger(serverId) && serverId > 0 && await memberContext(serverId, req.userId);
        if (!ctx) return res.status(404).json({ error: 'Servidor não encontrado.' });
        if (!ctx.can(P.MANAGE_SERVER)) return res.status(403).json({ error: 'Você não tem permissão para isso.' });
        const data = req.body;
        const ext = Buffer.isBuffer(data) && imageExt(data);
        if (!ext) return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, GIF ou WEBP.' });
        const id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(AVATAR_DIR, id), data);
        const { rows } = await db.query(
          `UPDATE servers s SET banner_id = $2 FROM servers old WHERE s.id = $1 AND old.id = s.id
           RETURNING old.banner_id AS previous, s.*`,
          [serverId, id],
        );
        if (rows[0]?.previous) removeAvatar(rows[0].previous);
        audit(serverId, req.userId, 'server_banner');
        events.serverChanged(serverId);
        res.json({ server: S.server(rows[0]) });
      } catch (err) {
        next(err);
      }
    });

  // Emoji personalizado: imagem crua (até 256 KB), nome no cabeçalho X-Emoji-Name.
  r.post('/servers/:id/emojis',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: emojis.MAX_BYTES + 1024 }),
    async (req, res, next) => {
      try {
        if (req.isBot) return res.status(403).json({ error: 'Bots não podem fazer isso.' });
        const serverId = Number(req.params.id);
        const ctx = Number.isInteger(serverId) && serverId > 0 && await memberContext(serverId, req.userId);
        if (!ctx) return res.status(404).json({ error: 'Servidor não encontrado.' });
        if (!ctx.can(P.MANAGE_EMOJIS)) return res.status(403).json({ error: 'Você não tem permissão para gerenciar emojis.' });
        let name = req.get('x-emoji-name') || '';
        try { name = decodeURIComponent(name); } catch { /* usa como veio */ }
        const result = await emojis.create({ serverId, userId: req.userId, name, data: req.body });
        if (result.error) return res.status(400).json({ error: result.error });
        audit(serverId, req.userId, 'emoji_create', { targetId: result.emoji.id, targetName: result.emoji.name });
        events.serverChanged(serverId);
        res.status(201).json({ emoji: result.emoji });
      } catch (err) {
        next(err);
      }
    });

  return r;
}

// Reconhece a imagem pelos primeiros bytes (não confia no que o navegador diz).
function imageExt(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const AVATAR_RE = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;

function removeAvatar(id) {
  if (AVATAR_RE.test(id)) fs.unlink(path.join(AVATAR_DIR, id), () => {});
}

// Avisar servidores/amigos que a foto mudou (definido pelas rotas, evita import circular).
let avatarChanged = () => {};
const onAvatarChanged = (fn) => { avatarChanged = fn; };

// GET /avatars/:arquivo — público (é só a foto), o nome é aleatório.
function serveAvatar(req, res) {
  const m = AVATAR_RE.exec(req.params.file);
  if (!m) return res.status(404).end();
  res.set({
    'Content-Type': AVATAR_TYPES[m[1]],
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.sendFile(path.join(AVATAR_DIR, req.params.file), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

// GET /files/:id/:nome — imagens/vídeos/áudios abrem no navegador; o resto vira download.
// Nunca servimos HTML/SVG/JS "inline", para ninguém conseguir rodar script pelo anexo.
function serveFile(req, res, next) {
  const id = req.params.id;
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
  db.query('SELECT * FROM attachments WHERE id = $1 AND message_id IS NOT NULL', [id])
    .then(({ rows }) => {
      const a = rows[0];
      if (!a) return res.status(404).end();
      if (a.purged_at) return res.status(410).type('text/plain').send('Arquivo antigo removido pela limpeza automática.');
      const inline = S.MEDIA_TYPES.has(a.content_type);
      const encoded = encodeURIComponent(a.filename);
      res.set({
        'Content-Type': inline ? a.content_type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.sendFile(filePath(id), (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    })
    .catch(next);
}

// Faxina de hora em hora: apaga anexos nunca usados e arquivos sem registro no banco.
async function cleanup() {
  try {
    const old = await db.query(
      `DELETE FROM attachments
       WHERE message_id IS NULL AND created_at < now() - make_interval(mins => $1::int)
       RETURNING id`,
      [ORPHAN_AFTER_MIN],
    );
    old.rows.forEach((r) => removeFile(r.id));

    const names = (await fs.promises.readdir(UPLOAD_DIR)).filter((n) => /^[a-f0-9]{32}$/.test(n));
    for (let i = 0; i < names.length; i += 500) {
      const batch = names.slice(i, i + 500);
      const { rows } = await db.query('SELECT id FROM attachments WHERE id = ANY($1::text[])', [batch]);
      const known = new Set(rows.map((r) => r.id));
      for (const n of batch) {
        if (known.has(n)) continue;
        const st = await fs.promises.stat(filePath(n)).catch(() => null);
        // Só apaga se for antigo (evita pegar um upload que acabou de chegar).
        if (st && Date.now() - st.mtimeMs > 10 * 60 * 1000) removeFile(n);
      }
    }
  } catch (err) {
    console.error('Erro na faxina de anexos:', err.message);
  }
}

function startCleanup() {
  setTimeout(cleanup, 30 * 1000).unref();
  setInterval(cleanup, 60 * 60 * 1000).unref();
}

module.exports = {
  uploadRouter, serveFile, serveAvatar, removeAvatar, onAvatarChanged, removeFile, startCleanup, cleanup, MAX_SIZE,
};
