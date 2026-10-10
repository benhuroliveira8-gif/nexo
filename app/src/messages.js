// Tudo sobre mensagens que é usado tanto pela API quanto pelo tempo real:
// carregar com anexos/reações/menções, criar, editar e apagar.
const db = require('./db');
const S = require('./serializers');
const files = require('./files');
const events = require('./events');
const presence = require('./presence');
const webpush = require('./webpush');
const linkpreview = require('./linkpreview');
const { P, channelRooms } = require('./permissions');

const MAX_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;
const MAX_PINS = 50;
const POLL_MAX_OPTIONS = 10;
const POLL_DURATIONS = [1, 4, 8, 24, 72, 168]; // horas

// Canais onde há conversa de servidor (para @everyone, apagar dos outros, fixar...).
const isServerText = (kind) => kind === 'text' || kind === 'thread';

const SELECT_MESSAGE = `
  SELECT msg.*, c.server_id, u.username AS author_username, u.display_name AS author_display_name,
         u.is_bot AS author_is_bot, u.avatar_id AS author_avatar_id
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
  const replyIds = [...new Set(rows.filter((r) => r.reply_to_id).map((r) => String(r.reply_to_id)))];
  const [att, reac, ment, replies, threads] = await Promise.all([
    db.query('SELECT * FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, id', [ids]),
    db.query('SELECT message_id, emoji, user_id FROM reactions WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, emoji', [ids]),
    db.query('SELECT message_id, user_id FROM message_mentions WHERE message_id = ANY($1::bigint[])', [ids]),
    replyIds.length
      ? db.query(
        `SELECT m.id, left(m.content, 120) AS content, m.author_id, u.username, u.display_name, u.is_bot, u.avatar_id,
                EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments
         FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = ANY($1::bigint[])`,
        [replyIds],
      )
      : { rows: [] },
    db.query(
      `SELECT c.id, c.name, c.parent_message_id,
              (SELECT count(*)::int FROM messages WHERE channel_id = c.id) AS message_count,
              (SELECT max(created_at) FROM messages WHERE channel_id = c.id) AS last_at
       FROM channels c WHERE c.kind = 'thread' AND c.parent_message_id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);
  const polls = await pollsFor(ids);
  const replyMap = new Map(replies.rows.map((r) => [String(r.id), {
    id: String(r.id),
    content: r.content,
    hasAttachments: r.has_attachments,
    author: r.author_id
      ? { id: r.author_id, username: r.username, displayName: r.display_name, isBot: !!r.is_bot, avatarUrl: S.avatarUrl(r.avatar_id) }
      : { id: null, username: 'deletado', displayName: 'Usuário removido' },
  }]));
  const threadMap = new Map(threads.rows.map((t) => [String(t.parent_message_id), {
    id: t.id, name: t.name, messageCount: t.message_count, lastAt: t.last_at,
  }]));
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
    replyTo: row.reply_to_id ? (replyMap.get(String(row.reply_to_id)) || null) : null,
    thread: threadMap.get(String(row.id)) || null,
    poll: polls.get(String(row.id)) || null,
  }));
}

// ---------------------------------------------------------------- Enquetes

async function pollsFor(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const [polls, options, votes] = await Promise.all([
    db.query('SELECT * FROM polls WHERE message_id = ANY($1::bigint[])', [ids]),
    db.query('SELECT * FROM poll_options WHERE message_id = ANY($1::bigint[]) ORDER BY position', [ids]),
    db.query('SELECT option_id, message_id, user_id FROM poll_votes WHERE message_id = ANY($1::bigint[]) ORDER BY created_at', [ids]),
  ]);
  if (!polls.rows.length) return map;
  const byOption = new Map();
  const voters = new Map();
  for (const v of votes.rows) {
    if (!byOption.has(v.option_id)) byOption.set(v.option_id, []);
    byOption.get(v.option_id).push(v.user_id);
    const k = String(v.message_id);
    if (!voters.has(k)) voters.set(k, new Set());
    voters.get(k).add(v.user_id);
  }
  for (const p of polls.rows) {
    const k = String(p.message_id);
    map.set(k, {
      question: p.question,
      multi: p.multi,
      endsAt: p.ends_at,
      ended: new Date(p.ends_at) <= new Date(),
      totalVoters: (voters.get(k) || new Set()).size,
      options: options.rows.filter((o) => String(o.message_id) === k).map((o) => ({
        id: o.id, text: o.text, users: byOption.get(o.id) || [],
      })),
    });
  }
  return map;
}

async function pollOf(messageId) {
  return (await pollsFor([String(messageId)])).get(String(messageId)) || null;
}

function validatePoll(poll) {
  if (!poll || typeof poll !== 'object') return null;
  const question = String(poll.question || '').replace(/\s+/g, ' ').trim();
  if (!question) throw new MessageError('Escreva a pergunta da enquete.');
  if (question.length > 300) throw new MessageError('A pergunta pode ter no máximo 300 caracteres.');
  const options = (Array.isArray(poll.options) ? poll.options : []).map((o) => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (options.length < 2) throw new MessageError('A enquete precisa de pelo menos 2 opções.');
  if (options.length > POLL_MAX_OPTIONS) throw new MessageError(`No máximo ${POLL_MAX_OPTIONS} opções.`);
  if (options.some((o) => o.length > 80)) throw new MessageError('Cada opção pode ter no máximo 80 caracteres.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new MessageError('Há opções repetidas.');
  const hours = Number(poll.durationHours) || 24;
  if (!POLL_DURATIONS.includes(hours)) throw new MessageError('Duração inválida.');
  return { question, options, multi: !!poll.multi, hours };
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

  const everyone = names.has('everyone') && access.can(P.MENTION_EVERYONE) && isServerText(access.kind);
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
async function createMessage({ access, userId, content, attachmentIds, replyToId, poll }) {
  if (access.kind === 'voice') throw new MessageError('Canais de voz não têm mensagens de texto.');
  if (!access.can(P.SEND_MESSAGES)) throw new MessageError('Você não tem permissão para enviar mensagens aqui.');
  content = String(content || '').trim();
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map(String))];
  if (ids.length > MAX_ATTACHMENTS) throw new MessageError(`No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
  if (ids.length && !access.can(P.ATTACH_FILES)) throw new MessageError('Você não pode enviar arquivos aqui.');
  const pollData = validatePoll(poll);
  if (pollData && ids.length) throw new MessageError('Enquete não pode ter anexos.');
  validateContent(content, ids.length > 0 || !!pollData);
  let replyTo = null;
  if (replyToId !== undefined && replyToId !== null && replyToId !== '') {
    replyTo = /^\d{1,18}$/.test(String(replyToId)) ? String(replyToId) : null;
    const ok = replyTo && await db.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2', [replyTo, access.channel.id]);
    if (!ok || ok.rowCount === 0) throw new MessageError('A mensagem que você está respondendo não existe mais.');
  }
  checkRate(userId);

  const id = await db.transaction(async (c) => {
    const mentions = await parseMentions(c, content, access);
    const { rows } = await c.query(
      `INSERT INTO messages (channel_id, author_id, content, mention_everyone, reply_to_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [access.channel.id, userId, content, mentions.everyone, replyTo],
    );
    // Responder alguém já avisa essa pessoa (como uma menção), se ela vê o canal.
    if (replyTo) {
      const orig = await c.query('SELECT author_id FROM messages WHERE id = $1', [replyTo]);
      const authorId = orig.rows[0]?.author_id;
      if (authorId && authorId !== userId && !mentions.userIds.includes(authorId)) mentions.userIds.push(authorId);
    }
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
    if (pollData) {
      await c.query(
        `INSERT INTO polls (message_id, question, multi, ends_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4::int))`,
        [messageId, pollData.question, pollData.multi, pollData.hours],
      );
      for (const [i, text] of pollData.options.entries()) {
        await c.query('INSERT INTO poll_options (message_id, position, text) VALUES ($1, $2, $3)', [messageId, i, text]);
      }
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
  // Links mudaram? Refaz as prévias.
  const before = linkpreview.urlsIn(messageRow.content).join(' ');
  if (before !== linkpreview.urlsIn(content).join(' ')) refreshEmbeds(messageRow.id, content);
  return getMessage(messageRow.id);
}

// Avisa todos que algo mudou numa mensagem (ex.: a thread dela ganhou resposta).
async function emitUpdated(messageId) {
  const message = messageId && await getMessage(messageId);
  if (!message) return;
  events.emitTo(await channelRooms(message.channelId), 'message:updated', message);
}

// Uma thread mudou (mensagem nova/apagada, renomeada, apagada): atualiza o "chip"
// da mensagem de origem no canal pai.
async function refreshThreadParent(channel) {
  if (channel && channel.kind === 'thread' && channel.parent_message_id) await emitUpdated(channel.parent_message_id);
}

// Depois de criar: manda a mensagem para todo mundo e atualiza a thread, se for o caso.
function announceNew(access, message, nonce) {
  events.emitTo(access.rooms, 'message:new', nonce ? { ...message, nonce } : message);
  refreshThreadParent(access.channel).catch(() => {});
  if (linkpreview.urlsIn(message.content).length) refreshEmbeds(message.id, message.content);
  pushNotify(access, message).catch((err) => console.warn('push:', err.message));
}

// Gera as prévias de link em segundo plano e atualiza a mensagem para todos.
function refreshEmbeds(messageId, content) {
  linkpreview.embedsFor(content)
    .then(async (embeds) => {
      const r = await db.query(
        `UPDATE messages SET embeds = $2::jsonb
         WHERE id = $1 AND content = $3 AND COALESCE(embeds, '[]'::jsonb) IS DISTINCT FROM $2::jsonb`,
        [messageId, JSON.stringify(embeds), content],
      );
      if (r.rowCount) await emitUpdated(messageId);
    })
    .catch((err) => console.warn('Prévia de link falhou:', err.message));
}

// ---------------------------------------------------------------- Notificações push

function previewText(message) {
  if (message.poll) return `📊 Enquete: ${message.poll.question}`;
  if (message.attachments.some((a) => a.voice)) return '🎤 Mensagem de voz';
  const text = String(message.content || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return message.attachments.length ? '📎 Anexo' : '';
}

// Quem precisa ser avisado: DM = o(s) outro(s); servidor = mencionados (ou todos no @everyone).
// Só recebe push quem não está com o Nexo aberto na tela e não está em "Não perturbe".
async function pushNotify(access, message) {
  const authorId = message.author.id;
  let targets;
  if (access.kind === 'dm') targets = access.memberIds;
  else if (message.mentionEveryone) {
    const m = await db.query('SELECT user_id FROM server_members WHERE server_id = $1', [access.serverId]);
    targets = m.rows.map((r) => r.user_id);
  } else targets = message.mentions;
  targets = [...new Set(targets)].filter((id) => id !== authorId && !presence.isActive(id));
  if (!targets.length) return;
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id = ANY($1::int[]) AND NOT is_bot AND status <> 'dnd'
       AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = users.id)`,
    [targets],
  );
  if (!rows.length) return;
  let title = message.author.displayName;
  if (access.kind !== 'dm') {
    const s = await db.query('SELECT name FROM servers WHERE id = $1', [access.serverId]);
    const where = access.kind === 'thread' ? `🧵 ${access.channel.name}` : `#${access.channel.name}`;
    title = `${message.author.displayName} em ${where} (${s.rows[0] ? s.rows[0].name : 'servidor'})`;
  }
  await webpush.sendToUsers(rows.map((r) => r.id), {
    title,
    body: previewText(message),
    tag: `ch${message.channelId}`,
    url: `/?canal=${message.channelId}${message.serverId ? `&servidor=${message.serverId}` : ''}&msg=${message.id}`,
    icon: message.author.avatarUrl || '/icons/icon-192.png',
  });
}

async function deleteMessage(messageId) {
  const att = await db.query('SELECT id FROM attachments WHERE message_id = $1', [messageId]);
  await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
  att.rows.forEach((a) => files.removeFile(a.id));
}

module.exports = {
  SELECT_MESSAGE, MAX_LENGTH, MAX_PINS, MessageError, checkRate, isServerText, pollOf,
  hydrate, getMessage, reactionsOf, createMessage, editMessage, deleteMessage,
  emitUpdated, refreshThreadParent, announceNew,
};
