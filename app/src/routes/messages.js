// Histórico, edição, exclusão e reações de mensagens.
const db = require('../db');
const events = require('../events');
const M = require('../messages');
const S = require('../serializers');
const { P, channelAccess, memberContext, visibleChannelIds } = require('../permissions');
const { audit } = require('../audit');
const emojis = require('../emojis');
const { wrap, fail, parseId, parseBigId } = require('./util');

const PAGE_SIZE = 50;
const SEARCH_PAGE = 25;
// Filtro "tem:" da busca (trechos fixos, sem nada vindo do usuário).
const HAS_SQL = {
  arquivo: 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = msg.id AND NOT a.is_voice)',
  imagem: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = msg.id AND a.content_type LIKE 'image/%')",
  video: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = msg.id AND a.content_type LIKE 'video/%')",
  audio: 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = msg.id AND a.is_voice)',
  link: "msg.content ~* 'https?://'",
  gif: 'msg.gif IS NOT NULL',
  enquete: 'EXISTS (SELECT 1 FROM polls p WHERE p.message_id = msg.id)',
};

// Escapa % e _ para o ILIKE procurar o texto literalmente.
const likeEscape = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

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
    if (access.kind === 'voice') return res.json({ messages: [], hasMore: false });

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

  // Enviar mensagem pela API (usado principalmente por bots).
  // Corpo: { content, attachmentIds?, replyToId? }
  r.post('/channels/:id/messages', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access) fail(404, 'Canal não encontrado.');
    try {
      const message = await M.createMessage({
        access,
        userId: req.userId,
        content: req.body.content,
        attachmentIds: req.body.attachmentIds,
        replyToId: req.body.replyToId,
        poll: req.body.poll,
        gif: req.body.gif,
        stickerId: req.body.stickerId,
      });
      M.announceNew(access, message);
      res.status(201).json({ message });
    } catch (err) {
      if (err instanceof M.MessageError) fail(/rápido/.test(err.message) ? 429 : 400, err.message);
      throw err;
    }
  }));

  r.patch('/messages/:messageId', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    if (row.author_id !== req.userId || row.kind !== 'default') fail(403, 'Você só pode editar as suas mensagens.');
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
    if (!mine && !(M.isServerText(access.kind) && access.can(P.MANAGE_MESSAGES))) {
      fail(403, 'Você não pode apagar essa mensagem.');
    }
    await M.deleteMessage(row.id);
    if (!mine && access.serverId) {
      const a = await db.query('SELECT display_name FROM users WHERE id = $1', [row.author_id]);
      audit(access.serverId, req.userId, 'message_delete', {
        targetId: row.author_id, targetName: a.rows[0] ? a.rows[0].display_name : null,
        details: { channel: access.channel.name, preview: String(row.content || '').slice(0, 100) },
      });
    }
    events.emitTo(access.rooms, 'message:deleted', { id: String(row.id), channelId: row.channel_id });
    M.refreshThreadParent(access.channel).catch(() => {});
    res.json({ ok: true });
  }));

  // ---------- Mensagens fixadas
  // Em servidor precisa de "Gerenciar mensagens"; em DM qualquer um dos dois pode fixar.
  async function pin(req, res, add) {
    const { row, access } = await messageWithAccess(req);
    if (access.kind !== 'dm' && !access.can(P.MANAGE_MESSAGES)) fail(403, 'Você não tem permissão para fixar mensagens.');
    if (add && !row.pinned_at) {
      const n = await db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL', [row.channel_id]);
      if (n.rows[0].n >= M.MAX_PINS) fail(400, `Este canal já tem ${M.MAX_PINS} mensagens fixadas. Desafixe alguma antes.`);
      await db.query('UPDATE messages SET pinned_at = now(), pinned_by = $2 WHERE id = $1', [row.id, req.userId]);
    } else if (!add) {
      await db.query('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1', [row.id]);
    }
    const message = await M.getMessage(row.id);
    events.emitTo(access.rooms, 'message:updated', message);
    events.emitTo(access.rooms, 'channel:pins', { channelId: row.channel_id });
    res.json({ message });
  }
  r.put('/messages/:messageId/pin', wrap((req, res) => pin(req, res, true)));
  r.delete('/messages/:messageId/pin', wrap((req, res) => pin(req, res, false)));

  r.get('/channels/:id/pins', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access) fail(404, 'Canal não encontrado.');
    const { rows } = await db.query(
      `${M.SELECT_MESSAGE} WHERE msg.channel_id = $1 AND msg.pinned_at IS NOT NULL ORDER BY msg.pinned_at DESC`,
      [channelId],
    );
    res.json({ messages: await M.hydrate(rows) });
  }));

  // ---------- Threads: uma conversa paralela que nasce de uma mensagem.
  r.post('/messages/:messageId/thread', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    if (access.kind !== 'text') fail(400, 'Só dá para criar threads em canais de texto de servidor.');
    if (!access.can(P.SEND_MESSAGES)) fail(403, 'Você não tem permissão para enviar mensagens aqui.');

    const existing = await db.query("SELECT * FROM channels WHERE kind = 'thread' AND parent_message_id = $1", [row.id]);
    if (existing.rows[0]) return res.json({ channel: S.channel(existing.rows[0]), existed: true });

    const fallback = String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Thread';
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || fallback;
    let channel;
    try {
      const { rows } = await db.query(
        `INSERT INTO channels (server_id, name, kind, position, parent_channel_id, parent_message_id, created_by)
         VALUES ($1, $2, 'thread', 0, $3, $4, $5) RETURNING *`,
        [access.serverId, name, row.channel_id, row.id, req.userId],
      );
      channel = rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // duas pessoas criaram ao mesmo tempo
      const again = await db.query("SELECT * FROM channels WHERE kind = 'thread' AND parent_message_id = $1", [row.id]);
      return res.json({ channel: S.channel(again.rows[0]), existed: true });
    }
    events.serverChanged(access.serverId);
    await M.emitUpdated(row.id);
    res.status(201).json({ channel: S.channel(channel) });
  }));

  // ---------- Busca
  // GET /search?q=texto&serverId=1 (ou channelId=5, ou dms=1) &authorId=7 &before=<id da mensagem>
  //   &has=arquivo|imagem|link|gif|audio|enquete  &since=<data ISO>  &until=<data ISO>
  r.get('/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const authorId = req.query.authorId ? parseId(req.query.authorId) : null;
    const has = typeof req.query.has === 'string' && Object.hasOwn(HAS_SQL, req.query.has) ? req.query.has : null;
    if (req.query.has && !has) fail(400, 'Filtro "tem" inválido.');
    const date = (v) => {
      if (!v) return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) fail(400, 'Data inválida.');
      return d.toISOString();
    };
    const since = date(req.query.since);
    const until = date(req.query.until);
    if (!q && !authorId && !has && !since && !until) fail(400, 'Digite algo para buscar.');
    const before = parseBigId(req.query.before || '');

    let channelIds;
    if (req.query.channelId) {
      const channelId = parseId(req.query.channelId);
      const access = channelId && await channelAccess(channelId, req.userId);
      if (!access) fail(404, 'Canal não encontrado.');
      channelIds = [channelId];
    } else if (req.query.serverId) {
      const serverId = parseId(req.query.serverId);
      const ctx = serverId && await memberContext(serverId, req.userId);
      if (!ctx) fail(404, 'Servidor não encontrado.');
      const visible = new Set(await visibleChannelIds(serverId, req.userId, ctx.isAdmin));
      const { rows } = await db.query("SELECT id FROM channels WHERE server_id = $1 AND kind IN ('text', 'thread')", [serverId]);
      channelIds = rows.map((c) => c.id).filter((id) => visible.has(id));
    } else {
      const { rows } = await db.query('SELECT channel_id AS id FROM dm_members WHERE user_id = $1', [req.userId]);
      channelIds = rows.map((c) => c.id);
    }

    const where = `msg.channel_id = ANY($1::int[])
       AND msg.kind = 'default'
       AND ($2::text = '' OR msg.content ILIKE '%' || $2 || '%')
       AND ($3::int IS NULL OR msg.author_id = $3)
       AND ($4::timestamptz IS NULL OR msg.created_at >= $4)
       AND ($5::timestamptz IS NULL OR msg.created_at <= $5)
       ${has ? `AND ${HAS_SQL[has]}` : ''}`;
    const params = [channelIds, likeEscape(q), authorId, since, until];
    const [found, total] = await Promise.all([
      db.query(
        `${M.SELECT_MESSAGE}
         WHERE ${where} AND ($6::bigint IS NULL OR msg.id < $6::bigint)
         ORDER BY msg.id DESC LIMIT ${SEARCH_PAGE}`,
        [...params, before],
      ),
      db.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM messages msg WHERE ${where} LIMIT 1000) x`, params),
    ]);
    const names = await db.query('SELECT id, name, kind FROM channels WHERE id = ANY($1::int[])', [[...new Set(found.rows.map((m) => m.channel_id))]]);
    const channelInfo = new Map(names.rows.map((c) => [c.id, { id: c.id, name: c.name, kind: c.kind }]));
    const messages = (await M.hydrate(found.rows)).map((m) => ({ ...m, channel: channelInfo.get(m.channelId) || null }));
    res.json({ messages, total: total.rows[0].n, hasMore: found.rows.length === SEARCH_PAGE });
  }));

  // ---------- Enquetes: PUT com { options: [índices] } define o seu voto ([] tira o voto).
  r.put('/messages/:messageId/poll', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    const p = await db.query('SELECT * FROM polls WHERE message_id = $1', [row.id]);
    const poll = p.rows[0];
    if (!poll) fail(404, 'Essa mensagem não tem enquete.');
    if (poll.ends_at && new Date(poll.ends_at) <= new Date()) fail(400, 'Essa enquete já terminou.');
    if (access.timeoutUntil && !access.isAdmin) fail(403, 'Você está de castigo e não pode votar agora.');
    const wanted = [...new Set((Array.isArray(req.body.options) ? req.body.options : []).map(Number))];
    if (wanted.some((i) => !Number.isInteger(i) || i < 0 || i >= poll.options.length)) fail(400, 'Opção inválida.');
    if (!poll.multiple && wanted.length > 1) fail(400, 'Essa enquete aceita só uma opção.');
    await db.transaction(async (c) => {
      await c.query('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2', [row.id, req.userId]);
      for (const i of wanted) {
        await c.query('INSERT INTO poll_votes (message_id, option_index, user_id) VALUES ($1, $2, $3)', [row.id, i, req.userId]);
      }
    });
    const result = await M.pollOf(row.id);
    events.emitTo(access.rooms, 'message:poll', { id: String(row.id), channelId: row.channel_id, poll: result });
    res.json({ poll: result });
  }));

  // Encerrar a enquete antes da hora (quem criou ou quem gerencia mensagens).
  r.post('/messages/:messageId/poll/end', wrap(async (req, res) => {
    const { row, access } = await messageWithAccess(req);
    const mine = row.author_id === req.userId;
    if (!mine && !(M.isServerText(access.kind) && access.can(P.MANAGE_MESSAGES))) fail(403, 'Você não pode encerrar essa enquete.');
    const { rowCount } = await db.query(
      'UPDATE polls SET ends_at = now() WHERE message_id = $1 AND (ends_at IS NULL OR ends_at > now())',
      [row.id],
    );
    if (!rowCount) fail(400, 'Essa enquete já terminou.');
    const result = await M.pollOf(row.id);
    events.emitTo(access.rooms, 'message:poll', { id: String(row.id), channelId: row.channel_id, poll: result });
    res.json({ poll: result });
  }));

  // Reagir: PUT adiciona a sua reação, DELETE tira.
  async function react(req, res, add) {
    const { row, access } = await messageWithAccess(req);
    let emoji = '';
    try { emoji = decodeURIComponent(req.params.emoji); } catch { /* inválido */ }
    const custom = emojis.TOKEN_RE.test(emoji);
    if (custom ? (add && !(await emojis.validReaction(emoji, req.userId))) : !validEmoji(emoji)) fail(400, 'Emoji inválido.');

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
