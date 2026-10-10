const db = require('../db');

// IDs da URL precisam ser inteiros positivos; senão devolve null.
function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

// IDs de mensagem são BIGINT: aceitamos como texto só com dígitos.
const parseBigId = (value) => (/^\d{1,18}$/.test(String(value)) ? String(value) : null);

// Erro com status HTTP. Lançar um destes dentro de wrap() vira resposta JSON.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Envolve handlers async para que erros caiam no tratador de erros do Express.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Estado de leitura de vários canais: { unread: bool, mentions: número }.
// Em DM, toda mensagem nova conta como "menção" (gera notificação).
async function channelStates(userId, channelIds) {
  const map = new Map();
  if (channelIds.length === 0) return map;
  const { rows } = await db.query(
    `SELECT c.id,
       EXISTS (SELECT 1 FROM messages m
               WHERE m.channel_id = c.id AND m.id > COALESCE(cr.last_read_id, 0)
                 AND m.author_id IS DISTINCT FROM $1) AS unread,
       (SELECT count(*) FROM messages m
        WHERE m.channel_id = c.id AND m.id > COALESCE(cr.last_read_id, 0)
          AND m.author_id IS DISTINCT FROM $1
          AND (c.kind = 'dm' OR m.mention_everyone OR EXISTS (
                SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $1)))::int AS mentions
     FROM channels c
     LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $1
     WHERE c.id = ANY($2::int[])`,
    [userId, channelIds],
  );
  rows.forEach((r) => map.set(r.id, { unread: r.unread, mentions: r.mentions }));
  return map;
}

// Marca como lido tudo o que existe hoje nos canais de um servidor (usado ao entrar).
async function markServerRead(client, serverId, userId) {
  await client.query(
    `INSERT INTO channel_reads (user_id, channel_id, last_read_id)
     SELECT $2, c.id, COALESCE((SELECT max(id) FROM messages WHERE channel_id = c.id), 0)
     FROM channels c WHERE c.server_id = $1
     ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(channel_reads.last_read_id, EXCLUDED.last_read_id)`,
    [serverId, userId],
  );
}

module.exports = { parseId, parseBigId, HttpError, fail, wrap, channelStates, markServerRead };
