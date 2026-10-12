// Mensagens agendadas, lembretes, mensagens salvas, figurinhas/sons (editar e apagar),
// boas-vindas, moderação automática, estatísticas e exportação de canal.
const db = require('../db');
const S = require('../serializers');
const events = require('../events');
const push = require('../push');
const presence = require('../presence');
const assets = require('../assets');
const automod = require('../automod');
const M = require('../messages');
const { audit } = require('../audit');
const { P, channelAccess, memberContext, visibleChannelIds } = require('../permissions');
const { wrap, fail, parseId, parseBigId } = require('./util');

const MAX_SCHEDULED = 25;
const MAX_REMINDERS = 50;
const MAX_SAVED = 500;

function futureDate(value, { maxDays = 366, what = 'horário' } = {}) {
  const d = new Date(String(value || ''));
  if (Number.isNaN(d.getTime())) fail(400, `Escolha o ${what}.`);
  if (d.getTime() < Date.now() + 30 * 1000) fail(400, `Escolha um ${what} no futuro.`);
  if (d.getTime() > Date.now() + maxDays * 86400000) fail(400, `O ${what} pode ser de no máximo ${maxDays} dias para a frente.`);
  return d.toISOString();
}

async function messageAccess(req) {
  const id = parseBigId(req.params.messageId);
  const { rows } = id ? await db.query('SELECT * FROM messages WHERE id = $1', [id]) : { rows: [] };
  const access = rows[0] && await channelAccess(rows[0].channel_id, req.userId);
  if (!access) fail(404, 'Mensagem não encontrada.');
  return { row: rows[0], access };
}

// Nome do lugar da mensagem (para listas): "#geral (Servidor)" ou "@Fulano".
async function placeNames(channelIds, userId) {
  if (!channelIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.name, c.server_id, s.name AS server_name FROM channels c
     LEFT JOIN servers s ON s.id = c.server_id WHERE c.id = ANY($1::int[])`,
    [channelIds],
  );
  const out = new Map();
  for (const c of rows) {
    if (c.kind === 'dm') {
      const { rows: others } = await db.query(
        `SELECT u.display_name FROM dm_members d JOIN users u ON u.id = d.user_id
         WHERE d.channel_id = $1 AND d.user_id <> $2 ORDER BY u.display_name LIMIT 3`,
        [c.id, userId],
      );
      out.set(c.id, { id: c.id, kind: 'dm', name: c.name || others.map((o) => o.display_name).join(', ') || 'Mensagem direta', serverId: null });
    } else {
      out.set(c.id, { id: c.id, kind: c.kind, name: c.name, serverId: c.server_id, serverName: c.server_name });
    }
  }
  return out;
}

const SITE_ACTIONS = new Set(['sticker', 'sound']);

module.exports = function extraRoutes(r) {
  // ================================================================ Mensagens agendadas
  r.get('/scheduled', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM nexo_scheduled WHERE user_id = $1 ORDER BY send_at', [req.userId]);
    const places = await placeNames([...new Set(rows.map((x) => x.channel_id))], req.userId);
    res.json({ scheduled: rows.map((x) => ({ id: x.id, channelId: x.channel_id, content: x.content, sendAt: x.send_at, channel: places.get(x.channel_id) || null })) });
  }));

  r.post('/channels/:id/scheduled', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || !['text', 'thread', 'dm'].includes(access.kind)) fail(404, 'Canal não encontrado.');
    if (!access.can(P.SEND_MESSAGES)) fail(403, 'Você não pode enviar mensagens aqui.');
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) fail(400, 'Escreva a mensagem.');
    if (content.length > 4000) fail(400, 'Máximo de 4000 caracteres.');
    const sendAt = futureDate(req.body && req.body.sendAt, { maxDays: 60, what: 'horário de envio' });
    const n = await db.query('SELECT count(*)::int AS n FROM nexo_scheduled WHERE user_id = $1', [req.userId]);
    if (n.rows[0].n >= MAX_SCHEDULED) fail(400, `Você já tem ${MAX_SCHEDULED} mensagens agendadas.`);
    const { rows } = await db.query(
      'INSERT INTO nexo_scheduled (user_id, channel_id, content, send_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.userId, channelId, content, sendAt],
    );
    res.status(201).json({ scheduled: { id: rows[0].id, channelId, content, sendAt: rows[0].send_at } });
  }));

  r.delete('/scheduled/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const { rowCount } = await db.query('DELETE FROM nexo_scheduled WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (!rowCount) fail(404, 'Mensagem agendada não encontrada.');
    res.json({ ok: true });
  }));

  // ================================================================ Lembretes
  r.get('/reminders', wrap(async (req, res) => {
    const { rows } = await db.query(
      `${M.SELECT_MESSAGE.replace('SELECT msg.*', 'SELECT rem.id AS reminder_id, rem.remind_at, msg.*')}
       JOIN nexo_reminders rem ON rem.message_id = msg.id
       WHERE rem.user_id = $1 ORDER BY rem.remind_at`,
      [req.userId],
    );
    const ok = [];
    for (const row of rows) if (await channelAccess(row.channel_id, req.userId)) ok.push(row);
    const msgs = await M.hydrate(ok);
    const places = await placeNames([...new Set(ok.map((x) => x.channel_id))], req.userId);
    res.json({ reminders: ok.map((row, i) => ({ id: row.reminder_id, remindAt: row.remind_at, message: { ...msgs[i], channel: places.get(row.channel_id) || null } })) });
  }));

  r.post('/messages/:messageId/reminders', wrap(async (req, res) => {
    const { row } = await messageAccess(req);
    const remindAt = futureDate(req.body && req.body.remindAt, { maxDays: 366, what: 'horário do lembrete' });
    const n = await db.query('SELECT count(*)::int AS n FROM nexo_reminders WHERE user_id = $1', [req.userId]);
    if (n.rows[0].n >= MAX_REMINDERS) fail(400, `Você já tem ${MAX_REMINDERS} lembretes.`);
    const { rows } = await db.query(
      'INSERT INTO nexo_reminders (user_id, message_id, remind_at) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, row.id, remindAt],
    );
    res.status(201).json({ reminder: { id: rows[0].id, remindAt: rows[0].remind_at, messageId: String(row.id) } });
  }));

  r.delete('/reminders/:id', wrap(async (req, res) => {
    const { rowCount } = await db.query('DELETE FROM nexo_reminders WHERE id = $1 AND user_id = $2', [parseId(req.params.id), req.userId]);
    if (!rowCount) fail(404, 'Lembrete não encontrado.');
    res.json({ ok: true });
  }));

  // ================================================================ Mensagens salvas
  r.get('/saved', wrap(async (req, res) => {
    const { rows } = await db.query(
      `${M.SELECT_MESSAGE.replace('SELECT msg.*', 'SELECT sv.created_at AS saved_at, msg.*')}
       JOIN nexo_saved sv ON sv.message_id = msg.id
       WHERE sv.user_id = $1 ORDER BY sv.created_at DESC LIMIT ${MAX_SAVED}`,
      [req.userId],
    );
    const ok = [];
    for (const row of rows) if (await channelAccess(row.channel_id, req.userId)) ok.push(row);
    const msgs = await M.hydrate(ok);
    const places = await placeNames([...new Set(ok.map((x) => x.channel_id))], req.userId);
    res.json({ saved: msgs.map((m, i) => ({ ...m, savedAt: ok[i].saved_at, channel: places.get(ok[i].channel_id) || null })) });
  }));

  r.get('/saved/ids', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT message_id FROM nexo_saved WHERE user_id = $1', [req.userId]);
    res.json({ ids: rows.map((x) => String(x.message_id)) });
  }));

  r.put('/messages/:messageId/save', wrap(async (req, res) => {
    const { row } = await messageAccess(req);
    const n = await db.query('SELECT count(*)::int AS n FROM nexo_saved WHERE user_id = $1', [req.userId]);
    if (n.rows[0].n >= MAX_SAVED) fail(400, `Você já tem ${MAX_SAVED} mensagens salvas.`);
    await db.query('INSERT INTO nexo_saved (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, row.id]);
    res.json({ saved: true });
  }));

  r.delete('/messages/:messageId/save', wrap(async (req, res) => {
    const id = parseBigId(req.params.messageId);
    await db.query('DELETE FROM nexo_saved WHERE user_id = $1 AND message_id = $2', [req.userId, id]);
    res.json({ saved: false });
  }));

  // ================================================================ Figurinhas e sons: listar, renomear, apagar
  r.get('/stickers', wrap(async (req, res) => res.json({ stickers: await assets.listForUser('sticker', req.userId) })));

  for (const kind of SITE_ACTIONS) {
    r.patch(`/servers/:id/${kind}s/:itemId`, wrap(async (req, res) => {
      const serverId = parseId(req.params.id);
      const ctx = serverId && await memberContext(serverId, req.userId);
      if (!ctx) fail(404, 'Servidor não encontrado.');
      if (!ctx.can(P.MANAGE_EMOJIS)) fail(403, 'Você não tem permissão para isso.');
      const name = assets.cleanName(req.body && req.body.name);
      if (name.length < 2) fail(400, 'O nome precisa ter de 2 a 30 letras.');
      const table = assets.KINDS[kind].table;
      try {
        const { rows } = kind === 'sound' && req.body.emoji !== undefined
          ? await db.query(`UPDATE ${table} SET name = $3, emoji = $4 WHERE id = $1 AND server_id = $2 RETURNING *`, [parseId(req.params.itemId), serverId, name, assets.cleanEmoji(req.body.emoji)])
          : await db.query(`UPDATE ${table} SET name = $3 WHERE id = $1 AND server_id = $2 RETURNING *`, [parseId(req.params.itemId), serverId, name]);
        if (!rows[0]) fail(404, 'Não encontrado.');
        events.serverChanged(serverId);
        res.json({ [kind]: assets.toJson(kind, rows[0]) });
      } catch (err) {
        if (err.code === '23505') fail(400, `Já existe um item chamado "${name}".`);
        throw err;
      }
    }));

    r.delete(`/servers/:id/${kind}s/:itemId`, wrap(async (req, res) => {
      const serverId = parseId(req.params.id);
      const ctx = serverId && await memberContext(serverId, req.userId);
      if (!ctx) fail(404, 'Servidor não encontrado.');
      if (!ctx.can(P.MANAGE_EMOJIS)) fail(403, 'Você não tem permissão para isso.');
      const { rows } = await db.query(`DELETE FROM ${assets.KINDS[kind].table} WHERE id = $1 AND server_id = $2 RETURNING *`, [parseId(req.params.itemId), serverId]);
      if (!rows[0]) fail(404, 'Não encontrado.');
      assets.removeFile(kind, rows[0].file);
      audit(serverId, req.userId, `${kind}_delete`, { targetId: rows[0].id, targetName: rows[0].name });
      events.serverChanged(serverId);
      res.json({ ok: true });
    }));
  }

  // ================================================================ Boas-vindas e moderação automática
  async function manageServer(req) {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_SERVER)) fail(403, 'Você não tem permissão para isso.');
    return ctx;
  }

  r.put('/servers/:id/welcome', wrap(async (req, res) => {
    const ctx = await manageServer(req);
    const w = automod.cleanWelcome(req.body || {});
    if (w.channelId) {
      const { rows } = await db.query("SELECT 1 FROM channels WHERE id = $1 AND server_id = $2 AND kind = 'text'", [w.channelId, ctx.serverId]);
      if (!rows[0]) fail(400, 'Escolha um canal de texto deste servidor.');
    }
    if (w.enabled && !w.channelId) fail(400, 'Escolha o canal da mensagem de boas-vindas.');
    if (w.roleId) {
      const { rows } = await db.query('SELECT position, is_default FROM roles WHERE id = $1 AND server_id = $2', [w.roleId, ctx.serverId]);
      if (!rows[0] || rows[0].is_default) fail(400, 'Cargo inválido.');
      if (!ctx.isOwner && rows[0].position >= ctx.top) fail(403, 'Você só pode escolher cargos abaixo do seu.');
    }
    await db.query('UPDATE servers SET welcome = $2 WHERE id = $1', [ctx.serverId, JSON.stringify(w)]);
    audit(ctx.serverId, req.userId, 'welcome_update', { details: { enabled: w.enabled, roleId: w.roleId } });
    events.serverChanged(ctx.serverId);
    res.json({ welcome: w });
  }));

  r.put('/servers/:id/automod', wrap(async (req, res) => {
    const ctx = await manageServer(req);
    const am = automod.cleanAutomod(req.body || {});
    await db.query('UPDATE servers SET automod = $2 WHERE id = $1', [ctx.serverId, JSON.stringify(am)]);
    automod.forget(ctx.serverId);
    audit(ctx.serverId, req.userId, 'automod_update', { details: { words: am.words.length, spam: am.spam } });
    events.serverChanged(ctx.serverId);
    res.json({ automod: am });
  }));

  // ================================================================ Estatísticas
  // ?days=30&tz=180 (tz = minutos do getTimezoneOffset do navegador)
  r.get('/servers/:id/stats', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_SERVER) && !ctx.can(P.VIEW_AUDIT_LOG)) fail(403, 'Você não tem permissão para ver as estatísticas.');
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const tz = Math.min(840, Math.max(-840, Math.round(Number(req.query.tz) || 0)));
    const visible = await visibleChannelIds(serverId, req.userId, ctx.isAdmin);
    const { rows: chans } = await db.query("SELECT id, name, kind, parent_channel_id FROM channels WHERE id = ANY($1::int[]) AND kind IN ('text', 'thread')", [visible]);
    const ids = chans.map((c) => c.id);
    const local = '(msg.created_at AT TIME ZONE \'UTC\' - make_interval(mins => $3))';
    const base = `FROM messages msg WHERE msg.channel_id = ANY($1::int[]) AND msg.kind = 'default'
                  AND msg.created_at >= now() - make_interval(days => $2)`;
    const [perDay, perHour, perWeekday, top, topChannels, totals, joins] = await Promise.all([
      db.query(`SELECT to_char(date_trunc('day', ${local}), 'YYYY-MM-DD') AS day, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, [ids, days, tz]),
      db.query(`SELECT extract(hour FROM ${local})::int AS h, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, [ids, days, tz]),
      db.query(`SELECT extract(dow FROM ${local})::int AS d, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, [ids, days, tz]),
      db.query(`SELECT msg.author_id AS id, u.display_name, u.username, u.avatar_id, u.is_bot, count(*)::int AS n
                ${base.replace('FROM messages msg', 'FROM messages msg JOIN users u ON u.id = msg.author_id')}
                GROUP BY 1, 2, 3, 4, 5 ORDER BY n DESC LIMIT 10`, [ids, days]),
      db.query(`SELECT msg.channel_id AS id, count(*)::int AS n ${base} GROUP BY 1 ORDER BY n DESC LIMIT 8`, [ids, days]),
      db.query(`SELECT count(*)::int AS messages, count(DISTINCT msg.author_id)::int AS authors ${base}`, [ids, days]),
      db.query("SELECT count(*)::int AS n FROM server_members WHERE server_id = $1 AND joined_at >= now() - make_interval(days => $2)", [serverId, days]),
    ]);
    const members = await db.query('SELECT count(*)::int AS n FROM server_members WHERE server_id = $1', [serverId]);
    const chanName = new Map(chans.map((c) => [c.id, c]));
    res.json({
      days,
      totals: { messages: totals.rows[0].messages, activeMembers: totals.rows[0].authors, members: members.rows[0].n, joined: joins.rows[0].n },
      perDay: perDay.rows,
      perHour: Array.from({ length: 24 }, (_, h) => (perHour.rows.find((x) => x.h === h) || { n: 0 }).n),
      perWeekday: Array.from({ length: 7 }, (_, d) => (perWeekday.rows.find((x) => x.d === d) || { n: 0 }).n),
      topMembers: top.rows.map((x) => ({ ...S.user(x), count: x.n })),
      topChannels: topChannels.rows.map((x) => ({ id: x.id, name: (chanName.get(x.id) || {}).name, kind: (chanName.get(x.id) || {}).kind, count: x.n })),
    });
  }));

  // ================================================================ Exportar conversa
  // ?format=html|txt|json&tz=180
  r.get('/channels/:id/export', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || !['text', 'thread', 'dm'].includes(access.kind)) fail(404, 'Canal não encontrado.');
    const format = ['html', 'txt', 'json'].includes(req.query.format) ? req.query.format : 'html';
    const tz = Math.min(840, Math.max(-840, Math.round(Number(req.query.tz) || 0)));
    const { rows: rowsAll } = await db.query(
      `${M.SELECT_MESSAGE} WHERE msg.channel_id = $1 ORDER BY msg.id DESC LIMIT 20000`,
      [channelId],
    );
    rowsAll.reverse();
    const msgs = [];
    for (let i = 0; i < rowsAll.length; i += 500) msgs.push(...await M.hydrate(rowsAll.slice(i, i + 500)));
    // Endereço do Nexo para os links dos anexos (o navegador manda; só aceita se for este mesmo site).
    let origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
    try {
      const b = new URL(String(req.query.base || ''));
      if (/^https?:$/.test(b.protocol) && b.host === req.get('host')) origin = b.origin;
    } catch { /* usa o padrão */ }
    const place = (await placeNames([channelId], req.userId)).get(channelId) || { name: 'canal' };
    const title = place.kind === 'dm' ? `Conversa com ${place.name}` : `#${place.name}${place.serverName ? ` — ${place.serverName}` : ''}`;
    const when = (d) => {
      const t = new Date(new Date(d).getTime() - tz * 60000);
      return t.toISOString().replace('T', ' ').slice(0, 16);
    };
    const extrasOf = (m) => [
      ...m.attachments.map((a) => `📎 ${a.filename} (${origin}${a.url})`),
      m.gif ? `🎞️ GIF: ${m.gif.url}` : null,
      m.sticker ? `🏷️ Figurinha: ${m.sticker.name}` : null,
      m.poll ? `📊 Enquete: ${m.poll.question} — ${m.poll.options.map((o) => `${o.text} (${o.votes})`).join(', ')}` : null,
    ].filter(Boolean);
    const safeName = String(place.name).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'canal';
    const fileBase = `nexo-${safeName}-${new Date().toISOString().slice(0, 10)}`;
    res.set('Cache-Control', 'no-store');

    if (format === 'json') {
      res.set('Content-Disposition', `attachment; filename="${fileBase}.json"`);
      return res.json({
        exportedAt: new Date().toISOString(), channel: { id: channelId, title }, count: msgs.length,
        messages: msgs.map((m) => ({
          id: m.id, createdAt: m.createdAt, editedAt: m.editedAt, kind: m.kind,
          author: m.author ? { id: m.author.id, username: m.author.username, displayName: m.author.displayName } : null,
          content: m.content, replyTo: m.replyTo ? m.replyTo.id : null,
          attachments: m.attachments.map((a) => ({ filename: a.filename, size: a.size, url: `${origin}${a.url}` })),
          gif: m.gif ? m.gif.url : null, sticker: m.sticker ? m.sticker.name : null, poll: m.poll || null,
          reactions: m.reactions.map((x) => ({ emoji: x.emoji, count: x.count })),
        })),
      });
    }
    if (format === 'txt') {
      const lines = [`${title}`, `Exportado do Nexo em ${when(new Date())} · ${msgs.length} mensagens`, ''];
      for (const m of msgs) {
        lines.push(`[${when(m.createdAt)}] ${m.author ? m.author.displayName : '?'}: ${m.content || ''}`.trimEnd());
        extrasOf(m).forEach((x) => lines.push(`    ${x}`));
      }
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${fileBase}.txt"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    }
    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" rel="noopener noreferrer">${u}</a>`);
    const body = msgs.map((m) => `<div class="m${m.kind === 'system' ? ' sys' : ''}"><span class="t">${esc(when(m.createdAt))}</span> <b>${esc(m.author ? m.author.displayName : '?')}</b>
<div class="c">${linkify(m.content).replace(/\n/g, '<br>')}</div>${extrasOf(m).map((x) => `<div class="x">${linkify(x)}</div>`).join('')}</div>`).join('\n');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${fileBase}.html"`);
    return res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px;background:#fff;color:#1c2029}
h1{font-size:20px;margin:0 0 4px}.sub{color:#6f7686;margin-bottom:20px}
.m{padding:6px 0;border-bottom:1px solid #eef0f3}.t{color:#6f7686;font-size:12px}.c{white-space:normal;overflow-wrap:anywhere}
.x{color:#555;font-size:13px}.sys{color:#6f7686;font-style:italic}a{color:#d9531e}
@media (prefers-color-scheme:dark){body{background:#16181d;color:#e7e9ee}.m{border-color:#262a33}}
</style></head><body><h1>${esc(title)}</h1><div class="sub">Exportado do Nexo em ${esc(when(new Date()))} · ${msgs.length} mensagens</div>
${body}
</body></html>`);
  }));
};

// ================================================================ Tarefas de fundo
async function sendScheduled() {
  const { rows } = await db.query(
    `DELETE FROM nexo_scheduled WHERE id IN (
       SELECT id FROM nexo_scheduled WHERE send_at <= now() ORDER BY send_at LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  for (const s of rows) {
    try {
      const access = await channelAccess(s.channel_id, s.user_id);
      if (!access) throw new M.MessageError('Você não tem mais acesso a esse canal.');
      const message = await M.createMessage({ access, userId: s.user_id, content: s.content });
      M.announceNew(access, message);
      events.emitTo([`user:${s.user_id}`], 'scheduled:sent', { id: s.id, channelId: s.channel_id, messageId: message.id });
    } catch (err) {
      const why = err instanceof M.MessageError ? err.message : 'erro inesperado';
      if (!(err instanceof M.MessageError)) console.error('Erro ao enviar mensagem agendada:', err);
      events.emitTo([`user:${s.user_id}`], 'scheduled:failed', { id: s.id, channelId: s.channel_id, error: why, content: s.content });
    }
  }
}

async function sendReminders() {
  const { rows } = await db.query(
    `DELETE FROM nexo_reminders WHERE id IN (
       SELECT id FROM nexo_reminders WHERE remind_at <= now() ORDER BY remind_at LIMIT 100 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  for (const rem of rows) {
    const { rows: m } = await db.query(`${M.SELECT_MESSAGE} WHERE msg.id = $1`, [rem.message_id]);
    if (!m[0]) continue;
    const access = await channelAccess(m[0].channel_id, rem.user_id);
    if (!access) continue;
    const [message] = await M.hydrate(m);
    const preview = M.previewText(message) || 'Mensagem';
    const from = message.author ? message.author.displayName : '';
    events.emitTo([`user:${rem.user_id}`], 'reminder', {
      id: rem.id, channelId: message.channelId, serverId: message.serverId, messageId: message.id,
      text: `⏰ Lembrete: ${from ? `${from}: ` : ''}${preview}`.slice(0, 200),
    });
    if (!presence.isActive(rem.user_id)) {
      await push.sendToUsers([rem.user_id], {
        title: '⏰ Lembrete do Nexo',
        body: `${from ? `${from}: ` : ''}${preview}`,
        url: `/?${message.serverId ? `servidor=${message.serverId}&` : ''}canal=${message.channelId}&msg=${message.id}`,
        tag: `lembrete-${rem.id}`,
      }).catch(() => {});
    }
  }
}

async function expireStatuses() {
  const { rows } = await db.query(
    `UPDATE users SET status_text = NULL, status_expires_at = NULL
     WHERE status_expires_at IS NOT NULL AND status_expires_at <= now() RETURNING id`,
  );
  if (!rows.length) return;
  // eslint-disable-next-line global-require
  const { profileChanged, USER_COLS } = require('./auth');
  for (const { id } of rows) {
    await profileChanged(id).catch(() => {});
    const { rows: me } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
    if (me[0]) events.emitTo([`user:${id}`], 'me:updated', { user: S.me(me[0]) });
  }
}

let jobsTimer = null;
function startJobs() {
  if (jobsTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendScheduled();
      await sendReminders();
      await expireStatuses();
      // eslint-disable-next-line global-require
      await require('./extras3').expireTempRoles();
    } catch (err) {
      console.error('Erro nas tarefas de fundo:', err.message);
    } finally {
      running = false;
    }
  };
  jobsTimer = setInterval(tick, Number(process.env.JOBS_TICK_MS) || 15000);
  jobsTimer.unref();
}

module.exports.startJobs = startJobs;
