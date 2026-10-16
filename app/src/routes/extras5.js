// Silenciar servidor/canal, caixa de menções, troca rápida (Ctrl+K), galeria do canal,
// modo lento, webhooks e confirmação de e-mail.
const crypto = require('crypto');
const db = require('../db');
const S = require('../serializers');
const events = require('../events');
const M = require('../messages');
const notify = require('../notify');
const mailer = require('../mailer');
const emailcodes = require('../emailcodes');
const auth = require('../auth');
const { audit } = require('../audit');
const { P, channelAccess, memberContext, visibleChannelIds, roomsForChannel, CHANNEL_COLS } = require('../permissions');
const { wrap, fail, parseId, parseBigId } = require('./util');

const MUTE_MINUTES = [15, 60, 480, 1440, 10080];
const SLOWMODE = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const MAX_WEBHOOKS_PER_CHANNEL = 10;

const origin = (req) => `${String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()}://${req.get('host')}`;
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------------------------------------------------------------- Caixa de menções

// Mensagens que mencionam a pessoa (ou responderam a ela, ou @everyone), que ela ainda vê.
async function mentionCandidates(userId, { before = null, after = null, limit = 30 } = {}) {
  const { rows: ids } = await db.query(
    `SELECT id FROM (
       SELECT message_id AS id FROM message_mentions WHERE user_id = $1
       UNION
       SELECT m.id FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
       WHERE m.mention_everyone AND m.created_at >= sm.joined_at
     ) x
     WHERE ($2::bigint IS NULL OR id < $2::bigint) AND ($3::bigint IS NULL OR id > $3::bigint)
     ORDER BY id DESC LIMIT 200`,
    [userId, before, after],
  );
  if (!ids.length) return [];
  const { rows } = await db.query(
    `${M.SELECT_MESSAGE}
     WHERE msg.id = ANY($1::bigint[]) AND msg.kind = 'default' AND msg.author_id IS DISTINCT FROM $2
       AND (msg.expires_at IS NULL OR msg.expires_at > now())
     ORDER BY msg.id DESC`,
    [ids.map((r) => r.id), userId],
  );
  // Visibilidade: ainda é membro e ainda vê o canal (canais privados mudam).
  const visible = new Map(); // serverId -> Set(canais) | null
  const dmIn = new Set((await db.query('SELECT channel_id FROM dm_members WHERE user_id = $1', [userId])).rows.map((r) => r.channel_id));
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (row.server_id) {
      if (!visible.has(row.server_id)) {
        const ctx = await memberContext(row.server_id, userId);
        visible.set(row.server_id, ctx ? new Set(await visibleChannelIds(row.server_id, userId, ctx.isAdmin)) : null);
      }
      const set = visible.get(row.server_id);
      if (!set || !set.has(row.channel_id)) continue;
    } else if (!dmIn.has(row.channel_id)) continue;
    out.push(row);
  }
  return out;
}

module.exports = function extras5Routes(r) {
  // ================================================================ Silenciar
  r.get('/me/notify', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT target, level, muted_until FROM nexo_notify WHERE user_id = $1', [req.userId]);
    res.json({ settings: rows.map((x) => ({ target: x.target, level: x.level, mutedUntil: x.muted_until })) });
  }));

  // PUT /me/notify { serverId | channelId, level?: 'all'|'mentions'|'none'|null, mute?: minutos | -1 (até reativar) | 0 (reativar) }
  r.put('/me/notify', auth.humansOnly, wrap(async (req, res) => {
    const b = req.body || {};
    let target;
    if (b.channelId) {
      const id = parseId(b.channelId);
      const access = id && await channelAccess(id, req.userId);
      if (!access) fail(404, 'Canal não encontrado.');
      target = `c:${id}`;
    } else if (b.serverId) {
      const id = parseId(b.serverId);
      if (!id || !(await memberContext(id, req.userId))) fail(404, 'Servidor não encontrado.');
      target = `s:${id}`;
    } else fail(400, 'Diga qual servidor ou canal.');
    const { rows: cur } = await db.query('SELECT level, muted_until FROM nexo_notify WHERE user_id = $1 AND target = $2', [req.userId, target]);
    let level = cur[0] ? cur[0].level : null;
    let mutedUntil = cur[0] ? cur[0].muted_until : null;
    if (b.level !== undefined) {
      if (b.level !== null && !notify.LEVELS.includes(b.level)) fail(400, 'Escolha: todas, só menções ou nada.');
      level = b.level;
    }
    if (b.mute !== undefined) {
      const m = Number(b.mute);
      if (m === 0) mutedUntil = null;
      else if (m === -1) mutedUntil = new Date('2999-01-01T00:00:00Z');
      else if (MUTE_MINUTES.includes(m)) mutedUntil = new Date(Date.now() + m * 60000);
      else fail(400, 'Tempo inválido.');
    }
    if (!level && !mutedUntil) await db.query('DELETE FROM nexo_notify WHERE user_id = $1 AND target = $2', [req.userId, target]);
    else {
      await db.query(
        `INSERT INTO nexo_notify (user_id, target, level, muted_until) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, target) DO UPDATE SET level = EXCLUDED.level, muted_until = EXCLUDED.muted_until`,
        [req.userId, target, level, mutedUntil],
      );
    }
    const setting = { target, level, mutedUntil };
    events.emitTo([`user:${req.userId}`], 'notify:changed', { setting });
    res.json({ setting });
  }));

  // ================================================================ Caixa de menções
  r.get('/me/mentions', auth.humansOnly, wrap(async (req, res) => {
    const before = req.query.before ? parseBigId(req.query.before) : null;
    const rows = await mentionCandidates(req.userId, { before, limit: 30 });
    const messages = await M.hydrate(rows);
    const chIds = [...new Set(rows.map((x) => x.channel_id))];
    const { rows: chans } = chIds.length ? await db.query(
      `SELECT c.id, c.name, c.kind, c.server_id, s.name AS server_name, p.name AS parent_name, p.kind AS parent_kind
       FROM channels c LEFT JOIN servers s ON s.id = c.server_id LEFT JOIN channels p ON p.id = c.parent_channel_id
       WHERE c.id = ANY($1::int[])`,
      [chIds],
    ) : { rows: [] };
    const byId = new Map(chans.map((c) => [c.id, c]));
    const { rows: me } = await db.query('SELECT mentions_seen_id FROM users WHERE id = $1', [req.userId]);
    const seen = BigInt(me[0].mentions_seen_id || 0);
    res.json({
      items: messages.map((m) => {
        const c = byId.get(m.channelId) || {};
        const direct = m.mentions.includes(req.userId);
        const reason = direct && m.replyTo && m.replyTo.author && m.replyTo.author.id === req.userId ? 'reply' : direct ? 'mention' : 'everyone';
        return {
          message: m, reason, unread: BigInt(m.id) > seen,
          channel: { id: c.id, name: c.name, kind: c.kind, parentName: c.parent_name || null, parentKind: c.parent_kind || null },
          server: c.server_id ? { id: c.server_id, name: c.server_name } : null,
        };
      }),
      hasMore: rows.length === 30,
    });
  }));

  r.get('/me/mentions/count', auth.humansOnly, wrap(async (req, res) => {
    const { rows: me } = await db.query('SELECT mentions_seen_id FROM users WHERE id = $1', [req.userId]);
    const rows = await mentionCandidates(req.userId, { after: String(me[0].mentions_seen_id || 0), limit: 99 });
    res.json({ unread: rows.length });
  }));

  // Marca como vistas (até a mensagem mais nova da lista).
  r.post('/me/mentions/seen', auth.humansOnly, wrap(async (req, res) => {
    const id = parseBigId(req.body.id);
    if (!id) fail(400, 'Mensagem inválida.');
    await db.query('UPDATE users SET mentions_seen_id = GREATEST(mentions_seen_id, $2::bigint) WHERE id = $1', [req.userId, id]);
    events.emitTo([`user:${req.userId}`], 'mentions:seen', { id });
    res.json({ ok: true });
  }));

  // ================================================================ Troca rápida (Ctrl+K)
  r.get('/me/switcher', auth.humansOnly, wrap(async (req, res) => {
    const { rows: servers } = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [req.userId]);
    const out = [];
    for (const { server_id: sid } of servers) {
      const ctx = await memberContext(sid, req.userId);
      if (!ctx) continue;
      const vis = await visibleChannelIds(sid, req.userId, ctx.isAdmin);
      if (!vis.length) continue;
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.kind, c.server_id, c.parent_channel_id, c.stage, c.announce, c.is_clips, c.created_at,
                CASE WHEN c.kind = 'thread' THEN (SELECT max(created_at) FROM messages WHERE channel_id = c.id) END AS last_message_at, p.kind AS parent_kind
         FROM channels c LEFT JOIN channels p ON p.id = c.parent_channel_id
         WHERE c.id = ANY($1::int[]) AND c.kind IN ('text', 'voice', 'forum', 'thread')`,
        [vis],
      );
      for (const c of rows) {
        // Threads: só as ativas na última semana (e posts de fórum).
        if (c.kind === 'thread' && c.parent_kind !== 'forum' && Date.now() - new Date(c.last_message_at || c.created_at) > 7 * 86400000) continue;
        out.push({ id: c.id, name: c.name, kind: c.kind, serverId: c.server_id, parentId: c.parent_channel_id, stage: !!c.stage, announce: !!c.announce, isClips: !!c.is_clips });
      }
    }
    res.json({ channels: out.slice(0, 3000) });
  }));

  // ================================================================ Galeria do canal
  // GET /channels/:id/media?type=media|files&before=<id da mensagem>
  r.get('/channels/:channelId/media', wrap(async (req, res) => {
    const id = parseId(req.params.channelId);
    const access = id && await channelAccess(id, req.userId);
    if (!access) fail(404, 'Canal não encontrado.');
    const media = req.query.type !== 'files';
    const before = req.query.before ? parseBigId(req.query.before) : null;
    const { rows } = await db.query(
      `SELECT a.*, msg.id AS mid, msg.created_at AS mcreated, msg.author_id, u.display_name AS author_name, u.username AS author_username, u.avatar_id AS author_avatar
       FROM attachments a JOIN messages msg ON msg.id = a.message_id LEFT JOIN users u ON u.id = msg.author_id
       WHERE msg.channel_id = $1 AND a.purged_at IS NULL AND NOT COALESCE(a.is_voice, false)
         AND (msg.expires_at IS NULL OR msg.expires_at > now())
         AND ${media ? "(a.content_type LIKE 'image/%' OR a.content_type LIKE 'video/%')" : "NOT (a.content_type LIKE 'image/%' OR a.content_type LIKE 'video/%')"}
         AND ($2::bigint IS NULL OR msg.id < $2::bigint)
       ORDER BY msg.id DESC, a.created_at LIMIT 61`,
      [id, before],
    );
    const items = rows.slice(0, 60).map((x) => ({
      attachment: S.attachment(x), messageId: String(x.mid), createdAt: x.mcreated,
      author: x.author_id ? { id: x.author_id, displayName: x.author_name, username: x.author_username, avatarUrl: S.avatarUrl(x.author_avatar) } : null,
    })).filter((x) => !media || x.attachment.kind === 'image' || x.attachment.kind === 'video');
    res.json({ items, hasMore: rows.length > 60 });
  }));

  // ================================================================ Modo lento (moderação)
  r.put('/channels/:channelId/slowmode', wrap(async (req, res) => {
    const id = parseId(req.params.channelId);
    const access = id && await channelAccess(id, req.userId);
    if (!access || !access.serverId) fail(404, 'Canal não encontrado.');
    if (access.kind !== 'text') fail(400, 'O modo lento é para canais de texto.');
    if (!access.isAdmin && !access.can(P.MANAGE_MESSAGES) && !access.can(P.MANAGE_CHANNELS)) fail(403, 'Só a moderação liga o modo lento.');
    const secs = Number(req.body.seconds);
    if (!SLOWMODE.includes(secs)) fail(400, 'Tempo do modo lento inválido.');
    if (secs !== (access.channel.slowmode_seconds || 0)) {
      await db.query('UPDATE channels SET slowmode_seconds = $2 WHERE id = $1', [id, secs]);
      audit(access.serverId, req.userId, 'channel_update', { targetId: id, targetName: access.channel.name, details: { slowmode: secs } });
      events.serverChanged(access.serverId);
    }
    res.json({ seconds: secs });
  }));

  // ================================================================ Webhooks (gerenciar)
  const manageWebhooks = async (req, serverId) => {
    const ctx = await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_CHANNELS)) fail(403, 'Só quem gerencia canais cuida dos webhooks.');
    return ctx;
  };
  const textChannelOf = async (serverId, channelId) => {
    const id = parseId(channelId);
    const { rows } = id ? await db.query("SELECT id, name FROM channels WHERE id = $1 AND server_id = $2 AND kind = 'text'", [id, serverId]) : { rows: [] };
    if (!rows[0]) fail(400, 'Escolha um canal de texto deste servidor.');
    return rows[0];
  };
  const cleanName = (v) => {
    const n = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!n) fail(400, 'Dê um nome ao webhook (ex.: Jenkins).');
    return n;
  };
  const serializeHook = (x) => ({
    id: x.id, serverId: x.server_id, channelId: x.channel_id, channelName: x.channel_name, name: x.name,
    avatarUrl: S.avatarUrl(x.avatar_id), createdAt: x.created_at, lastUsedAt: x.last_used_at, uses: x.uses,
    createdBy: x.created_by ? { id: x.created_by, displayName: x.creator_name } : null,
  });
  const HOOK_SELECT = `SELECT w.*, u.display_name AS name, u.avatar_id, c.name AS channel_name, cu.display_name AS creator_name
    FROM nexo_webhooks w JOIN users u ON u.id = w.user_id JOIN channels c ON c.id = w.channel_id LEFT JOIN users cu ON cu.id = w.created_by`;

  r.get('/servers/:id/webhooks', auth.humansOnly, wrap(async (req, res) => {
    const ctx = await manageWebhooks(req, parseId(req.params.id));
    const { rows } = await db.query(`${HOOK_SELECT} WHERE w.server_id = $1 ORDER BY w.id`, [ctx.serverId]);
    res.json({ webhooks: rows.map(serializeHook) });
  }));

  r.post('/servers/:id/webhooks', auth.humansOnly, wrap(async (req, res) => {
    const ctx = await manageWebhooks(req, parseId(req.params.id));
    const channel = await textChannelOf(ctx.serverId, req.body.channelId);
    const name = cleanName(req.body.name);
    const { rows: n } = await db.query('SELECT count(*)::int AS n FROM nexo_webhooks WHERE channel_id = $1', [channel.id]);
    if (n[0].n >= MAX_WEBHOOKS_PER_CHANNEL) fail(400, `No máximo ${MAX_WEBHOOKS_PER_CHANNEL} webhooks por canal.`);
    const token = crypto.randomBytes(24).toString('base64url');
    const hook = await db.transaction(async (c) => {
      // Cada webhook tem uma "conta" própria (não faz login; só aparece como autora).
      const { rows: u } = await c.query(
        `INSERT INTO users (username, display_name, password_hash, is_bot, is_webhook)
         VALUES ($1, $2, '!', true, true) RETURNING id`,
        [`webhook_${crypto.randomBytes(6).toString('hex')}`, name],
      );
      const { rows } = await c.query(
        'INSERT INTO nexo_webhooks (server_id, channel_id, user_id, token_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [ctx.serverId, channel.id, u[0].id, tokenHash(token), req.userId],
      );
      return rows[0];
    });
    audit(ctx.serverId, req.userId, 'webhook_create', { targetName: name, details: { channel: channel.name } });
    const { rows } = await db.query(`${HOOK_SELECT} WHERE w.id = $1`, [hook.id]);
    res.status(201).json({ webhook: serializeHook(rows[0]), url: `${origin(req)}/api/webhooks/${hook.id}/${token}` });
  }));

  const loadHook = async (req) => {
    const id = parseId(req.params.webhookId);
    const { rows } = id ? await db.query(`${HOOK_SELECT} WHERE w.id = $1`, [id]) : { rows: [] };
    if (!rows[0]) fail(404, 'Webhook não encontrado.');
    const ctx = await manageWebhooks(req, rows[0].server_id);
    return { hook: rows[0], ctx };
  };

  r.patch('/webhooks/:webhookId', auth.humansOnly, wrap(async (req, res) => {
    const { hook, ctx } = await loadHook(req);
    if (req.body.name !== undefined) await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [hook.user_id, cleanName(req.body.name)]);
    if (req.body.channelId !== undefined) {
      const ch = await textChannelOf(ctx.serverId, req.body.channelId);
      await db.query('UPDATE nexo_webhooks SET channel_id = $2 WHERE id = $1', [hook.id, ch.id]);
    }
    // { rotate: true }: link novo (o antigo para de funcionar).
    let url;
    if (req.body.rotate) {
      const token = crypto.randomBytes(24).toString('base64url');
      await db.query('UPDATE nexo_webhooks SET token_hash = $2 WHERE id = $1', [hook.id, tokenHash(token)]);
      url = `${origin(req)}/api/webhooks/${hook.id}/${token}`;
    }
    const { rows } = await db.query(`${HOOK_SELECT} WHERE w.id = $1`, [hook.id]);
    res.json({ webhook: serializeHook(rows[0]), ...(url ? { url } : {}) });
  }));

  r.delete('/webhooks/:webhookId', auth.humansOnly, wrap(async (req, res) => {
    const { hook, ctx } = await loadHook(req);
    await db.query('DELETE FROM nexo_webhooks WHERE id = $1', [hook.id]);
    audit(ctx.serverId, req.userId, 'webhook_delete', { targetName: hook.name, details: { channel: hook.channel_name } });
    res.json({ ok: true });
  }));

  // ================================================================ E-mail
  r.post('/me/email', auth.humansOnly, wrap(async (req, res) => {
    if (!mailer.enabled()) fail(400, 'O envio de e-mail não está configurado neste Nexo.');
    const email = emailcodes.cleanEmail(req.body.email);
    if (!email) fail(400, 'Digite um e-mail válido.');
    const { rows } = await db.query('SELECT id, username, display_name, password_hash, email, email_required, email_verified_at FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    const pending = u.email_required && !u.email_verified_at;
    // Quem já tem conta liberada confirma a senha antes de trocar o e-mail.
    if (!pending && !(await auth.checkPassword(String(req.body.password || ''), u.password_hash))) fail(403, 'Senha incorreta.');
    if (u.email && u.email === email) fail(400, 'Esse já é o seu e-mail.');
    if (await emailcodes.emailTaken(email, req.userId)) fail(409, 'Esse e-mail já está em outra conta do Nexo.');
    const why = emailcodes.allowSend(`user:${req.userId}`) || emailcodes.allowSend(`addr:${email}`);
    if (why) fail(429, why);
    try { await emailcodes.startVerify(u, email); } catch (err) {
      console.error('Erro ao mandar e-mail:', err.message);
      fail(502, 'Não consegui mandar o e-mail agora. Confira o endereço ou tente mais tarde.');
    }
    res.json({ ok: true, emailNew: email });
  }));

  r.post('/me/email/resend', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT id, username, display_name, email_new FROM users WHERE id = $1', [req.userId]);
    if (!rows[0].email_new) fail(400, 'Não há e-mail esperando confirmação.');
    const why = emailcodes.allowSend(`user:${req.userId}`);
    if (why) fail(429, why);
    try { await emailcodes.startVerify(rows[0], rows[0].email_new); } catch (err) {
      console.error('Erro ao mandar e-mail:', err.message);
      fail(502, 'Não consegui mandar o e-mail agora. Tente mais tarde.');
    }
    res.json({ ok: true });
  }));

  r.post('/me/email/verify', auth.humansOnly, wrap(async (req, res) => {
    const err = await emailcodes.finishVerify(req.userId, req.body.code);
    if (err) fail(400, err);
    const { USER_COLS } = require('./auth'); // eslint-disable-line global-require
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.userId]);
    res.json({ user: S.me(rows[0]) });
  }));

  // Tirar o e-mail (só de contas antigas, que não precisam de e-mail).
  r.delete('/me/email', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT password_hash, email_required FROM users WHERE id = $1', [req.userId]);
    if (rows[0].email_required) fail(400, 'Sua conta precisa de um e-mail. Você pode trocar por outro.');
    if (!(await auth.checkPassword(String(req.body.password || ''), rows[0].password_hash))) fail(403, 'Senha incorreta.');
    await db.query('UPDATE users SET email = NULL, email_new = NULL, email_verified_at = NULL, email_code_hash = NULL WHERE id = $1', [req.userId]);
    res.json({ ok: true });
  }));
};

// ---------------------------------------------------------------- Webhook (público)
// POST /api/webhooks/:id/:token   corpo: {"content": "texto"} (ou {"text": ...}) ou texto puro.
const hookRate = new Map(); // id -> [horários]
async function receiveWebhook(req, res) {
  const id = parseId(req.params.webhookId);
  const token = String(req.params.token || '');
  const { rows } = id ? await db.query('SELECT * FROM nexo_webhooks WHERE id = $1', [id]) : { rows: [] };
  const hook = rows[0];
  const ok = hook && /^[\w-]{20,64}$/.test(token)
    && crypto.timingSafeEqual(Buffer.from(hook.token_hash), Buffer.from(tokenHash(token)));
  if (!ok) return res.status(404).json({ error: 'Webhook não encontrado (o link pode ter sido trocado).' });
  const now = Date.now();
  const list = (hookRate.get(hook.id) || []).filter((t) => now - t < 60000);
  if (list.length >= 30) return res.status(429).json({ error: 'Muitas mensagens: no máximo 30 por minuto.' });
  list.push(now);
  hookRate.set(hook.id, list);

  let content = '';
  if (typeof req.body === 'string') content = req.body;
  else if (req.body && typeof req.body === 'object') content = req.body.content ?? req.body.text ?? '';
  content = String(content || '').trim();
  if (!content) return res.status(400).json({ error: 'Mande o texto em "content" (JSON) ou como texto puro.' });
  if (content.length > M.MAX_LENGTH) content = `${content.slice(0, M.MAX_LENGTH - 1)}…`;

  const { rows: ch } = await db.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1`, [hook.channel_id]);
  const channel = ch[0];
  if (!channel) return res.status(404).json({ error: 'O canal do webhook não existe mais.' });
  const { rooms, viewerIds } = await roomsForChannel(channel);
  // O webhook pode escrever no canal dele (até em canal de anúncios), mas sem @everyone e sem anexos.
  const access = {
    channel, kind: channel.kind, serverId: channel.server_id, rooms, viewerIds,
    isOwner: false, isAdmin: false, timeoutUntil: null,
    can: (flag) => flag !== P.MENTION_EVERYONE && flag !== P.ATTACH_FILES,
  };
  try {
    const message = await M.createMessage({ access, userId: hook.user_id, content, skipAutomod: true });
    M.announceNew(access, message);
    db.query('UPDATE nexo_webhooks SET last_used_at = now(), uses = uses + 1 WHERE id = $1', [hook.id]).catch(() => {});
    res.status(200).json({ ok: true, id: message.id });
  } catch (err) {
    if (err instanceof M.MessageError) return res.status(400).json({ error: err.message });
    throw err;
  }
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hookRate) if (!l.some((t) => now - t < 60000)) hookRate.delete(k); }, 300000).unref();

module.exports.receiveWebhook = receiveWebhook;
module.exports.mentionCandidates = mentionCandidates;
