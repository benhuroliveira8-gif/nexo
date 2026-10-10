// Histórico, edição, exclusão e reações de mensagens.
const db = require('../db');
const events = require('../events');
const M = require('../messages');
const { P, channelAccess } = require('../permissions');
const { wrap, fail, parseId, parseBigId } = require('./util');

const PAGE_SIZE = 50;

// Uma reação é um único emoji (inclui bandeiras, tons de pele e combinações).
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function validEmoji(text) {
  if (!text || text.length > 32) return false;
  if ([...segmenter.segment(text)].length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text);
}

// Carrega a mensagem da URL e o acesso do usuário ao canal dela.
async function messageWithAccess(req) {
  const id = parseBigId(req.params.messageId);
  const { rows } = id ? await db.query('SELECT * FROM messages WHERE id = $1', [id]) : { rows: [] };
  const row = rows[0];
  const access = row && await channelAccess(row.channel_id, req.userId);
  if (!access) fail(404, 'Mensagem não encontrada.');
  return { row, access };
}

module.exports = function messageRoutes(r) {
  // Histórico: 50 mensagens por vez, das mais novas para trás (?before=<id>).
  r.get('/channels/:id/messages', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access) fail(404, 'Canal não encontrado.');

    const before = parseBigId(req.query.before || '');
    const { rows } = await db.query(
      `${M.SELECT_MESSAGE}
       WHERE msg.channel_id = $1 AND ($2::bigint IS NULL OR msg.id < $2::bigint)
       ORDER BY msg.id DESC
       LIMIT $3`,
      [channelId, before, PAGE_SIZE],
    );
    const messages = await M.hydrate(rows.reverse());
    res.json({ messages, hasMore: rows.length === PAGE_SIZE });
  }));

  r.patch('/messages/:messageId', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    if (row.author_id !== req.userId) fail(403, 'Você só pode editar as suas mensagens.');
    try {
      const message = await M.editMessage({ access, messageRow: row, content: req.body.content });
      events.emitTo(access.rooms, 'message:updated', message);
      res.json({ message });
    } catch (err) {
      if (err instanceof M.MessageError) fail(400, err.message);
      throw err;
    }
  }));

  r.delete('/messages/:messageId', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    const mine = row.author_id === req.userId;
    if (!mine && !(access.kind === 'text' && access.can(P.MANAGE_MESSAGES))) {
      fail(403, 'Você não pode apagar essa mensagem.');
    }
    await M.deleteMessage(row.id);
    events.emitTo(access.rooms, 'message:deleted', { id: String(row.id), channelId: row.channel_id });
    res.json({ ok: true });
  }));

  // Reagir: PUT adiciona a sua reação, DELETE tira.
  async function react(req, res, add) {
    const { row, access } = await messageWithAccess(req);
    let emoji = '';
    try { emoji = decodeURIComponent(req.params.emoji); } catch { /* inválido */ }
    if (!validEmoji(emoji)) fail(400, 'Emoji inválido.');

    if (add) {
      if (!access.can(P.ADD_REACTIONS)) fail(403, 'Você não pode reagir aqui.');
      const count = await db.query('SELECT count(DISTINCT emoji)::int AS n FROM reactions WHERE message_id = $1', [row.id]);
      const exists = await db.query('SELECT 1 FROM reactions WHERE message_id = $1 AND emoji = $2 LIMIT 1', [row.id, emoji]);
      if (count.rows[0].n >= 20 && exists.rowCount === 0) fail(400, 'Essa mensagem já tem reações demais.');
      await db.query(
        'INSERT INTO reactions (message_id, emoji, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [row.id, emoji, req.userId],
      );
    } else {
      await db.query('DELETE FROM reactions WHERE message_id = $1 AND emoji = $2 AND user_id = $3', [row.id, emoji, req.userId]);
    }
    const reactions = await M.reactionsOf(row.id);
    events.emitTo(access.rooms, 'message:reactions', { id: String(row.id), channelId: row.channel_id, reactions });
    res.json({ reactions });
  }

  r.put('/messages/:messageId/reactions/:emoji', wrap((req, res) => react(req, res, true)));
  r.delete('/messages/:messageId/reactions/:emoji', wrap((req, res) => react(req, res, false)));
};
