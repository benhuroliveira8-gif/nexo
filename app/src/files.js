// Upload e download de anexos. Os arquivos ficam em UPLOAD_DIR (um volume do Docker),
// e cada um tem um id aleatório e impossível de adivinhar.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const S = require('./serializers');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const MAX_SIZE = (Number(process.env.MAX_UPLOAD_MB) || 8) * 1024 * 1024;
const ORPHAN_AFTER_MIN = 60; // anexos enviados mas nunca usados numa mensagem

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
        const { rows } = await db.query(
          `INSERT INTO attachments (id, uploader_id, filename, content_type, size)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [id, req.userId, cleanName(name), cleanType(req.get('x-file-type')), data.length],
        );
        try {
          await fs.promises.writeFile(filePath(id), data);
        } catch (err) {
          await db.query('DELETE FROM attachments WHERE id = $1', [id]);
          throw err;
        }
        res.status(201).json({ attachment: S.attachment(rows[0]) });
      } catch (err) {
        next(err);
      }
    });

  return r;
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

module.exports = { uploadRouter, serveFile, removeFile, startCleanup, cleanup, MAX_SIZE };
