// Tudo sobre mensagens que é usado tanto pela API quanto pelo tempo real:
// carregar com anexos/reações/menções, criar, editar e apagar.
const db = require('./db');
const S = require('./serializers');
const files = require('./files');
const events = require('./events');
const push = require('./push');
const presence = require('./presence');
const previews = require('./linkpreview');
const emojis = require('./emojis');
const gifs = require('./gifs');
const assets = require('./assets');
const automod = require('./automod');
const levels = require('./levels');
const transcribe = require('./transcribe');
const { P, roomsForChannel } = require('./permissions');

const MAX_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;
const MAX_PINS = 50;
const POLL_MAX_OPTIONS = 10;

// Canais onde há conversa de servidor (para @everyone, apagar dos outros, fixar...).
const isServerText = (kind) => kind === 'text' || kind === 'thread';

// Colunas dos anexos (sem o texto inteiro dos PDFs, que só serve para a busca).
const ATT_COLS = 'id, message_id, uploader_id, filename, content_type, size, is_voice, duration, waveform, transcript, purged_at, created_at, (text_content IS NOT NULL) AS has_text';

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
  const [att, reac, ment, replies, threads, polls, votes] = await Promise.all([
    db.query(`SELECT ${ATT_COLS} FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, id`, [ids]),
    db.query('SELECT message_id, emoji, user_id FROM reactions WHERE message_id = ANY($1::bigint[]) ORDER BY created_at, emoji', [ids]),
    db.query('SELECT message_id, user_id FROM message_mentions WHERE message_id = ANY($1::bigint[])', [ids]),
    replyIds.length
      ? db.query(
        `SELECT m.id, CASE WHEN m.content = '' AND m.gif IS NOT NULL THEN '🎞️ GIF' WHEN m.content = '' AND m.sticker IS NOT NULL THEN '🏷️ ' || (m.sticker->>'name') ELSE left(m.content, 120) END AS content, m.author_id, u.username, u.display_name, u.is_bot, u.avatar_id,
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
    db.query('SELECT * FROM polls WHERE message_id = ANY($1::bigint[])', [ids]),
    db.query('SELECT message_id, option_index, user_id FROM poll_votes WHERE message_id = ANY($1::bigint[]) ORDER BY created_at', [ids]),
  ]);
  const V = new Map();
  for (const v of votes.rows) {
    const k = String(v.message_id);
    if (!V.has(k)) V.set(k, []);
    V.get(k).push(v);
  }
  const pollMap = new Map(polls.rows.map((p) => [String(p.message_id), serializePoll(p, V.get(String(p.message_id)) || [])]));
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
    poll: pollMap.get(String(row.id)) || null,
    embeds: (row.embeds || []).map((e) => ({ ...e, image: previews.proxyUrl(e.image) })),
  }));
}

// Enquete no formato do navegador: cada opção com os votos e quem votou.
function serializePoll(p, votes) {
  const options = (p.options || []).map((text) => ({ text, votes: 0, voters: [] }));
  const voters = new Set();
  for (const v of votes) {
    const o = options[v.option_index];
    if (!o) continue;
    o.votes++;
    o.voters.push(v.user_id);
    voters.add(v.user_id);
  }
  return {
    question: p.question,
    options,
    multiple: p.multiple,
    endsAt: p.ends_at || null,
    closed: !!(p.ends_at && new Date(p.ends_at) <= new Date()),
    totalVoters: voters.size,
  };
}

async function pollOf(messageId) {
  const [p, v] = await Promise.all([
    db.query('SELECT * FROM polls WHERE message_id = $1', [messageId]),
    db.query('SELECT message_id, option_index, user_id FROM poll_votes WHERE message_id = $1 ORDER BY created_at', [messageId]),
  ]);
  return p.rows[0] ? serializePoll(p.rows[0], v.rows) : null;
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
  const visible = access.viewerIds ? new Set(access.viewerIds) : null;
  return { userIds: rows.map((r) => r.id).filter((id) => !visible || visible.has(id)), everyone };
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
// Confere e arruma os dados de uma enquete nova.
function cleanPoll(poll) {
  const question = String(poll.question || '').replace(/\s+/g, ' ').trim();
  if (!question) throw new MessageError('Escreva a pergunta da enquete.');
  if (question.length > 300) throw new MessageError('A pergunta pode ter no máximo 300 caracteres.');
  const options = (Array.isArray(poll.options) ? poll.options : [])
    .map((o) => String(o || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (options.length < 2) throw new MessageError('A enquete precisa de pelo menos 2 opções.');
  if (options.length > POLL_MAX_OPTIONS) throw new MessageError(`No máximo ${POLL_MAX_OPTIONS} opções.`);
  if (options.some((o) => o.length > 80)) throw new MessageError('Cada opção pode ter no máximo 80 caracteres.');
  const hours = Number(poll.hours ?? 24);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30) throw new MessageError('Duração da enquete inválida.');
  return { question, options, multiple: !!poll.multiple, hours };
}

async function createMessage({ access, userId, content, attachmentIds, replyToId, poll, gif, stickerId, command = null, skipAutomod = false }) {
  if (!['text', 'thread', 'dm'].includes(access.kind)) throw new MessageError('Este canal não tem mensagens de texto.');
  if (!access.can(P.SEND_MESSAGES)) {
    throw new MessageError(access.timeoutUntil ? 'Você está de castigo e não pode enviar mensagens agora.' : 'Você não tem permissão para enviar mensagens aqui.');
  }
  // Canal de anúncios: só a moderação escreve (os outros reagem e comentam em threads).
  if (access.kind === 'text' && access.channel.announce && !access.isAdmin && !access.can(P.MANAGE_MESSAGES)) {
    throw new MessageError('Este é um canal de anúncios: só a moderação escreve aqui. Você pode reagir ou comentar numa thread 🧵.');
  }
  content = String(content || '').trim();
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map(String))];
  if (ids.length > MAX_ATTACHMENTS) throw new MessageError(`No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
  if (ids.length && !access.can(P.ATTACH_FILES)) throw new MessageError('Você não pode enviar arquivos aqui.');
  content = await emojis.expand(content, { serverId: access.serverId, userId });
  const pollData = poll && typeof poll === 'object' ? cleanPoll(poll) : null;
  if (pollData && ids.length) throw new MessageError('Enquetes não podem ter anexos.');
  const gifData = gif ? gifs.clean(gif, MessageError) : null;
  if (gifData && (ids.length || pollData)) throw new MessageError('O GIF vai sozinho (sem anexos ou enquete).');
  let stickerData = null;
  if (stickerId !== undefined && stickerId !== null && stickerId !== '') {
    if (ids.length || pollData || gifData) throw new MessageError('A figurinha vai sozinha.');
    const st = /^\d{1,9}$/.test(String(stickerId)) ? await assets.get('sticker', Number(stickerId)) : null;
    let ok = !!st;
    if (st && access.serverId) ok = st.server_id === access.serverId;
    else if (st) ok = (await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [st.server_id, userId])).rowCount > 0;
    if (!ok) throw new MessageError('Essa figurinha não está disponível aqui.');
    stickerData = { id: st.id, name: st.name, serverId: st.server_id };
    content = '';
  }
  validateContent(content, ids.length > 0 || !!pollData || !!gifData || !!stickerData);
  // Moderação automática do servidor (palavras bloqueadas e anti-spam).
  if (access.serverId && !skipAutomod) {
    const mentionCount = (content.match(/(^|[^\w@])@[a-z0-9_.]{3,32}/gi) || []).length;
    const verdict = await automod.check(access, userId, content, { mentions: mentionCount });
    if (verdict) {
      if (verdict.punished) {
        createSystemMessage(access, userId, `🤖 ${verdict.punished} ficou de castigo por ${verdict.minutes} min (moderação automática${verdict.why ? `: ${verdict.why}` : ''}).`).catch(() => {});
      }
      throw new MessageError(verdict.error);
    }
  }
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
      `INSERT INTO messages (channel_id, author_id, content, mention_everyone, reply_to_id, gif, sticker, command)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [access.channel.id, userId, content, mentions.everyone, replyTo, gifData ? JSON.stringify(gifData) : null, stickerData ? JSON.stringify(stickerData) : null, command ? JSON.stringify(command) : null],
    );
    // Responder alguém já avisa essa pessoa (como uma menção), se ela vê o canal.
    if (replyTo) {
      const orig = await c.query('SELECT author_id FROM messages WHERE id = $1', [replyTo]);
      const authorId = orig.rows[0]?.author_id;
      const canSee = !access.viewerIds || access.viewerIds.includes(authorId);
      if (authorId && authorId !== userId && canSee && !mentions.userIds.includes(authorId)) mentions.userIds.push(authorId);
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
    if (pollData) {
      await c.query(
        `INSERT INTO polls (message_id, question, options, multiple, ends_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::real > 0 THEN now() + make_interval(secs => $5::real * 3600) END)`,
        [messageId, pollData.question, JSON.stringify(pollData.options), pollData.multiple, pollData.hours],
      );
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
  content = await emojis.expand(String(content || '').trim(), { serverId: access.serverId, userId: messageRow.author_id });
  const att = await db.query(
    `SELECT (SELECT count(*)::int FROM attachments WHERE message_id = $1)
          + (SELECT count(*)::int FROM polls WHERE message_id = $1)
          + (SELECT count(*)::int FROM messages WHERE id = $1 AND (gif IS NOT NULL OR sticker IS NOT NULL)) AS n`,
    [messageRow.id],
  );
  validateContent(content, att.rows[0].n > 0);
  if (access.serverId) {
    const verdict = await automod.check(access, messageRow.author_id, content, { editing: true });
    if (verdict) throw new MessageError(verdict.error);
  }

  await db.transaction(async (c) => {
    const mentions = await parseMentions(c, content, access);
    await c.query(
      'UPDATE messages SET content = $2, edited_at = now(), mention_everyone = $3, embeds = NULL WHERE id = $1',
      [messageRow.id, content, mentions.everyone],
    );
    await c.query('DELETE FROM message_mentions WHERE message_id = $1', [messageRow.id]);
    for (const uid of mentions.userIds) {
      await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageRow.id, uid]);
    }
  });
  scheduleEmbeds(messageRow.id, content, access.rooms);
  return getMessage(messageRow.id);
}

// Prévias de link: busca em segundo plano e atualiza a mensagem quando chegar.
function scheduleEmbeds(messageId, content, rooms) {
  if (!previews.ENABLED || previews.linksIn(content).length === 0) return;
  previews.buildEmbeds(content).then(async (embeds) => {
    if (!embeds.length) return;
    const { rowCount } = await db.query(
      'UPDATE messages SET embeds = $2 WHERE id = $1 AND content = $3',
      [messageId, JSON.stringify(embeds), content],
    );
    if (!rowCount) return; // foi editada ou apagada nesse meio tempo
    const message = await getMessage(messageId);
    if (message) events.emitTo(rooms, 'message:updated', message);
  }).catch((err) => console.error('Erro nas prévias de link:', err.message));
}

// Avisa todos que algo mudou numa mensagem (ex.: a thread dela ganhou resposta).
async function emitUpdated(messageId) {
  const message = messageId && await getMessage(messageId);
  if (!message) return;
  const ch = await db.query('SELECT * FROM channels WHERE id = $1', [message.channelId]);
  if (!ch.rows[0]) return;
  const rooms = ch.rows[0].kind === 'dm'
    ? (await db.query('SELECT user_id FROM dm_members WHERE channel_id = $1', [message.channelId])).rows.map((r) => `user:${r.user_id}`)
    : (await roomsForChannel(ch.rows[0])).rooms;
  events.emitTo(rooms, 'message:updated', message);
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
  if (message.kind === 'default') scheduleEmbeds(message.id, message.content, access.rooms);
  notifyPush(access, message).catch((err) => console.error('Erro ao preparar push:', err.message));
  // Áudio sem transcrição: o Whisper (se estiver ligado) transcreve e a mensagem atualiza.
  if (message.attachments.some((a) => a.isVoice && !a.transcript)) transcribe.enqueue(message, emitUpdated);
  if (access.serverId && message.kind === 'default' && message.author && message.author.id) {
    levels.award(access, message.author.id).catch((err) => console.error('Erro no XP:', err.message));
  }
}

// Texto curto da notificação (sem a formatação **negrito**, ||spoiler|| etc.).
function previewText(message) {
  let text = String(message.content || '')
    .replace(/<a?:([a-z0-9_]{2,32}):\d{1,10}>/g, ':$1:')
    .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒▒')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/(\*\*|__|~~|`|\*|_)/g, '')
    .replace(/^> /gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text && message.gif) text = '🎞️ GIF';
  if (!text && message.sticker) text = `🏷️ Figurinha: ${message.sticker.name}`;
  if (!text && message.poll) text = `📊 Enquete: ${message.poll.question}`;
  if (!text && message.attachments.some((a) => a.isVoice)) text = '🎤 Mensagem de voz';
  if (!text && message.attachments.length) text = '📎 Anexo';
  return text.slice(0, 200);
}

// Notificação push para quem foi mencionado/recebeu DM e não está com o Nexo aberto na tela.
async function notifyPush(access, message) {
  if (!message.author || !message.author.id) return;
  let targets;
  if (access.kind === 'dm') {
    targets = access.memberIds;
  } else {
    targets = [...message.mentions];
    if (message.mentionEveryone) {
      const all = access.viewerIds || (await db.query('SELECT user_id FROM server_members WHERE server_id = $1', [access.serverId])).rows.map((r) => r.user_id);
      targets.push(...all);
    }
  }
  targets = [...new Set(targets)].filter((id) => id !== message.author.id && !presence.isActive(id));
  if (!targets.length) return;
  const { rows } = await db.query(
    "SELECT id FROM users WHERE id = ANY($1::int[]) AND NOT is_bot AND status <> 'dnd'",
    [targets],
  );
  if (!rows.length) return;
  let title = message.author.displayName;
  if (access.kind === 'dm') {
    if (access.isGroup) title += ` • ${access.channel.name || 'Grupo'}`;
  } else {
    const s = await db.query('SELECT name FROM servers WHERE id = $1', [access.serverId]);
    const where = access.kind === 'thread' ? `🧵 ${access.channel.name}` : `#${access.channel.name}`;
    title += ` • ${where} (${s.rows[0] ? s.rows[0].name : ''})`;
  }
  await push.sendToUsers(rows.map((r) => r.id), {
    title,
    body: previewText(message),
    url: `/?${access.serverId ? `servidor=${access.serverId}&` : ''}canal=${message.channelId}&msg=${message.id}`,
    tag: `canal-${message.channelId}`,
    reply: { c: message.channelId, m: message.id },
  });
}

// Aviso automático na conversa (ex.: "Ana adicionou Bia ao grupo").
async function createSystemMessage(access, actorId, text) {
  const { rows } = await db.query(
    "INSERT INTO messages (channel_id, author_id, content, kind) VALUES ($1, $2, $3, 'system') RETURNING id",
    [access.channel.id, actorId, String(text).slice(0, 4000)],
  );
  const message = await getMessage(rows[0].id);
  events.emitTo(access.rooms, 'message:new', message);
  return message;
}

async function deleteMessage(messageId) {
  const att = await db.query('SELECT id FROM attachments WHERE message_id = $1', [messageId]);
  await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
  att.rows.forEach((a) => files.removeFile(a.id));
}

module.exports = {
  SELECT_MESSAGE, MAX_LENGTH, MAX_PINS, MessageError, checkRate, isServerText,
  hydrate, getMessage, reactionsOf, createMessage, editMessage, deleteMessage,
  emitUpdated, refreshThreadParent, announceNew, pollOf, createSystemMessage, previewText,
};
