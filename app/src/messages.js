// Tudo sobre mensagens que é usado tanto pela API quanto pelo tempo real:
// carregar com anexos/reações/menções, criar, editar e apagar.
const db = require('./db');
const S = require('./serializers');
const files = require('./files');
const { P } = require('./permissions');

const MAX_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;

const SELECT_MESSAGE = `
  SELECT msg.*, c.server_id, u.username AS author_username, u.display_name AS author_display_name,
         u.is_bot AS author_is_bot
  FROM messages msg
  JOIN channels c ON c.id = msg.channel_id
  LEFT JOIN users u ON u.id = msg.author_id`;

// Resume reações: [{ emoji, count, users: [ids] }] na ordem em que apareceram.
function summarizeReactions(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, { emoji: r.emoji, count: 0, users: [] });
    const e = map.get(r.emoji);
    e.count++;
    e.users.push(r.user_id);
  }
  return [...map.values()];
}

// Carrega anexos, reações e menções de várias mensagens de uma vez.
async function hydrate(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));
  const [att, reac, ment] = await Promise.all([
    db.query('SELECT * FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, id', [ids]),
    db.query('SELECT message_id, emoji, user_id FROM reactions WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, emoji', [ids]),
    db.query('SELECT message_id, user_id FROM message_mentions WHERE message_id = ANY($1::bigint[])', [ids]),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = String(r.message_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const A = group(att.rows);
  const R = group(reac.rows);
  const M = group(ment.rows);
  return rows.map((row) => S.message(row, {
    attachments: A.get(String(row.id)) || [],
    reactions: summarizeReactions(R.get(String(row.id)) || []),
    mentions: (M.get(String(row.id)) || []).map((x) => x.user_id),
  }));
}

async function getMessage(id) {
  const { rows } = await db.query(`${SELECT_MESSAGE} WHERE msg.id = $1`, [id]);
  if (!rows[0]) return null;
  return (await hydrate(rows))[0];
}

async function reactionsOf(messageId) {
  const { rows } = await db.query(
    'SELECT emoji, user_id FROM reactions WHERE message_id = $1 ORDER BY created_at, emoji',
    [messageId],
  );
  return summarizeReactions(rows);
}

// Encontra @usuario e @everyone no texto. Só conta quem pode ver o canal.
async function parseMentions(client, content, access) {
  const names = new Set();
  const re = /(^|[^\w@])@([a-z0-9_.]{3,32})/gi;
  let m;
  while ((m = re.exec(content))) names.add(m[2].toLowerCase().replace(/\.+$/, ''));

  const everyone = names.has('everyone') && access.can(P.MENTION_EVERYONE) && access.kind === 'text';
  names.delete('everyone');
  if (names.size === 0) return { userIds: [], everyone };

  const { rows } = access.kind === 'dm'
    ? await client.query(
      `SELECT u.id FROM users u JOIN dm_members d ON d.user_id = u.id AND d.channel_id = $2
       WHERE u.username = ANY($1::text[])`,
      [[...names], access.channel.id],
    )
    : await client.query(
      `SELECT u.id FROM users u JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2
       WHERE u.username = ANY($1::text[])`,
      [[...names], access.serverId],
    );
  return { userIds: rows.map((r) => r.id), everyone };
}

class MessageError extends Error {}

// Anti-spam: no máximo 5 mensagens a cada 5 segundos por usuário (pessoa ou bot).
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;
const recent = new Map(); // userId -> [timestamps]

function checkRate(userId) {
  const now = Date.now();
  const list = (recent.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    recent.set(userId, list);
    throw new MessageError('Calma! Você está enviando rápido demais.');
  }
  list.push(now);
  recent.set(userId, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of recent) if (list.every((t) => now - t >= RATE_WINDOW_MS)) recent.delete(k);
}, 60 * 1000).unref();

function validateContent(content, hasAttachments) {
  if (!content && !hasAttachments) throw new MessageError('Mensagem vazia.');
  if (content.length > MAX_LENGTH) throw new MessageError(`Máximo de ${MAX_LENGTH} caracteres.`);
}

// Cria uma mensagem (com anexos já enviados por /api/uploads) numa transação.
async function createMessage({ access, userId, content, attachmentIds }) {
  if (access.kind === 'voice') throw new MessageError('Canais de voz não têm mensagens de texto.');
  if (!access.can(P.SEND_MESSAGES)) throw new MessageError('Você não tem permissão para enviar mensagens aqui.');
  content = String(content || '').trim();
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map(String))];
  if (ids.length > MAX_ATTACHMENTS) throw new MessageError(`No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
  if (ids.length && !access.can(P.ATTACH_FILES)) throw new MessageError('Você não pode enviar arquivos aqui.');
  validateContent(content, ids.length > 0);
  checkRate(userId);

  const id = await db.transaction(async (c) => {
    const mentions = await parseMentions(c, content, access);
    const { rows } = await c.query(
      `INSERT INTO messages (channel_id, author_id, content, mention_everyone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [access.channel.id, userId, content, mentions.everyone],
    );
    const messageId = rows[0].id;
    if (ids.length) {
      const upd = await c.query(
        `UPDATE attachments SET message_id = $1
         WHERE id = ANY($2::text[]) AND uploader_id = $3 AND message_id IS NULL`,
        [messageId, ids, userId],
      );
      if (upd.rowCount !== ids.length) throw new MessageError('Algum anexo é inválido ou já foi usado. Envie de novo.');
    }
    for (const uid of mentions.userIds) {
      await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, uid]);
    }
    // Quem envia já leu até aqui.
    await c.query(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(channel_reads.last_read_id, EXCLUDED.last_read_id)`,
      [userId, access.channel.id, messageId],
    );
    return messageId;
  });
  return getMessage(id);
}

async function editMessage({ access, messageRow, content }) {
  content = String(content || '').trim();
  const att = await db.query('SELECT count(*)::int AS n FROM attachments WHERE message_id = $1', [messageRow.id]);
  validateContent(content, att.rows[0].n > 0);

  await db.transaction(async (c) => {
    const mentions = await parseMentions(c, content, access);
    await c.query(
      'UPDATE messages SET content = $2, edited_at = now(), mention_everyone = $3 WHERE id = $1',
      [messageRow.id, content, mentions.everyone],
    );
    await c.query('DELETE FROM message_mentions WHERE message_id = $1', [messageRow.id]);
    for (const uid of mentions.userIds) {
      await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageRow.id, uid]);
    }
  });
  return getMessage(messageRow.id);
}

async function deleteMessage(messageId) {
  const att = await db.query('SELECT id FROM attachments WHERE message_id = $1', [messageId]);
  await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
  att.rows.forEach((a) => files.removeFile(a.id));
}

module.exports = {
  SELECT_MESSAGE, MAX_LENGTH, MessageError, checkRate,
  hydrate, getMessage, reactionsOf, createMessage, editMessage, deleteMessage,
};
