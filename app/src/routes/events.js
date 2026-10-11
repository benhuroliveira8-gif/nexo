// Eventos do servidor: "Jogatina sexta às 21h", com lista de quem vai e lembrete.
const db = require('../db');
const events = require('../events');
const push = require('../push');
const presence = require('../presence');
const { P, memberContext, visibleChannelIds } = require('../permissions');
const { wrap, fail, parseId } = require('./util');

const MAX_UPCOMING = 50;
const REMIND_MINUTES = 15;

async function loadEvents(where, params) {
  const { rows } = await db.query(
    `SELECT e.*, u.display_name AS creator_name, u.username AS creator_username,
            COALESCE((SELECT json_agg(json_build_object('userId', r.user_id, 'status', r.status) ORDER BY r.created_at)
                      FROM nexo_event_rsvps r WHERE r.event_id = e.id), '[]') AS rsvps
     FROM nexo_events e LEFT JOIN users u ON u.id = e.created_by
     WHERE ${where} ORDER BY e.starts_at, e.id`,
    params,
  );
  return rows;
}

function serialize(row, visible) {
  const rsvps = Array.isArray(row.rsvps) ? row.rsvps : [];
  return {
    id: row.id,
    serverId: row.server_id,
    // Canal privado que a pessoa não vê: não mostra.
    channelId: row.channel_id && (!visible || visible.has(row.channel_id)) ? row.channel_id : null,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    createdAt: row.created_at,
    createdBy: row.created_by ? { id: row.created_by, displayName: row.creator_name, username: row.creator_username } : null,
    going: rsvps.filter((r) => r.status === 'going').map((r) => r.userId),
    maybe: rsvps.filter((r) => r.status === 'maybe').map((r) => r.userId),
  };
}

// Manda o evento atualizado para todos do servidor (cada um filtra o que vê).
async function broadcast(eventId) {
  const rows = await loadEvents('e.id = $1', [eventId]);
  if (!rows[0]) return null;
  const ev = serialize(rows[0], null);
  events.emitTo([`server:${ev.serverId}`], 'event:changed', { event: ev });
  return ev;
}

function cleanFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').replace(/\s+/g, ' ').trim();
    if (!title) fail(400, 'Dê um nome para o evento.');
    if (title.length > 100) fail(400, 'O nome pode ter no máximo 100 caracteres.');
    out.title = title;
  }
  if (!partial || body.description !== undefined) {
    const description = String(body.description || '').trim();
    if (description.length > 1000) fail(400, 'A descrição pode ter no máximo 1000 caracteres.');
    out.description = description;
  }
  if (!partial || body.startsAt !== undefined) {
    const d = new Date(String(body.startsAt || ''));
    if (Number.isNaN(d.getTime())) fail(400, 'Escolha a data e o horário do evento.');
    if (d.getTime() < Date.now() - 5 * 60 * 1000) fail(400, 'Esse horário já passou.');
    if (d.getTime() > Date.now() + 366 * 24 * 3600 * 1000) fail(400, 'Marque para no máximo daqui a um ano.');
    out.startsAt = d.toISOString();
  }
  if (!partial || body.channelId !== undefined) {
    out.channelId = body.channelId === null || body.channelId === '' || body.channelId === undefined ? null : parseId(body.channelId);
    if (body.channelId && !out.channelId) fail(400, 'Canal inválido.');
  }
  return out;
}

async function checkChannel(serverId, channelId, userId, isAdmin) {
  if (!channelId) return;
  const { rows } = await db.query("SELECT id FROM channels WHERE id = $1 AND server_id = $2 AND kind IN ('text', 'voice')", [channelId, serverId]);
  if (!rows[0]) fail(400, 'Esse canal não existe neste servidor.');
  const visible = await visibleChannelIds(serverId, userId, isAdmin);
  if (!visible.includes(channelId)) fail(400, 'Esse canal não existe neste servidor.');
}

async function eventWithAccess(req) {
  const eventId = parseId(req.params.eventId);
  const { rows } = eventId ? await db.query('SELECT * FROM nexo_events WHERE id = $1', [eventId]) : { rows: [] };
  if (!rows[0]) fail(404, 'Evento não encontrado.');
  const ctx = await memberContext(rows[0].server_id, req.userId);
  if (!ctx) fail(404, 'Evento não encontrado.');
  return { ev: rows[0], ctx };
}

const canEdit = (ev, ctx) => ctx.can(P.MANAGE_EVENTS) || (ev.created_by === ctx.userId && ctx.can(P.CREATE_EVENTS));

function routes(r) {
  // Próximos eventos (e os que começaram há pouco).
  r.get('/servers/:id/events', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    const visible = new Set(await visibleChannelIds(serverId, req.userId, ctx.isAdmin));
    const rows = await loadEvents("e.server_id = $1 AND e.starts_at > now() - interval '6 hours'", [serverId]);
    res.json({ events: rows.slice(0, MAX_UPCOMING).map((row) => serialize(row, visible)) });
  }));

  r.post('/servers/:id/events', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.CREATE_EVENTS)) fail(403, 'Você não tem permissão para criar eventos.');
    const f = cleanFields(req.body || {});
    await checkChannel(serverId, f.channelId, req.userId, ctx.isAdmin);
    const count = await db.query("SELECT count(*)::int AS n FROM nexo_events WHERE server_id = $1 AND starts_at > now() - interval '6 hours'", [serverId]);
    if (count.rows[0].n >= MAX_UPCOMING) fail(400, `O servidor já tem ${MAX_UPCOMING} eventos marcados.`);
    const { rows } = await db.query(
      `INSERT INTO nexo_events (server_id, channel_id, title, description, starts_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [serverId, f.channelId, f.title, f.description, f.startsAt, req.userId],
    );
    // Quem cria já vai.
    await db.query("INSERT INTO nexo_event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going')", [rows[0].id, req.userId]);
    const ev = await broadcast(rows[0].id);
    res.status(201).json({ event: ev });
  }));

  r.patch('/events/:eventId', wrap(async (req, res) => {
    const { ev, ctx } = await eventWithAccess(req);
    if (!canEdit(ev, ctx)) fail(403, 'Só quem criou (ou quem gerencia eventos) pode editar.');
    const f = cleanFields(req.body || {}, { partial: true });
    if (f.channelId !== undefined) await checkChannel(ev.server_id, f.channelId, req.userId, ctx.isAdmin);
    const timeChanged = f.startsAt && new Date(f.startsAt).getTime() !== new Date(ev.starts_at).getTime();
    await db.query(
      `UPDATE nexo_events SET
         title = COALESCE($2, title), description = COALESCE($3, description),
         starts_at = COALESCE($4::timestamptz, starts_at),
         channel_id = CASE WHEN $5::boolean THEN $6::int ELSE channel_id END,
         reminded_at = CASE WHEN $7::boolean THEN NULL ELSE reminded_at END,
         started_at = CASE WHEN $7::boolean THEN NULL ELSE started_at END
       WHERE id = $1`,
      [ev.id, f.title ?? null, f.description ?? null, f.startsAt ?? null, f.channelId !== undefined, f.channelId ?? null, !!timeChanged],
    );
    res.json({ event: await broadcast(ev.id) });
  }));

  r.delete('/events/:eventId', wrap(async (req, res) => {
    const { ev, ctx } = await eventWithAccess(req);
    if (!canEdit(ev, ctx)) fail(403, 'Só quem criou (ou quem gerencia eventos) pode apagar.');
    await db.query('DELETE FROM nexo_events WHERE id = $1', [ev.id]);
    events.emitTo([`server:${ev.server_id}`], 'event:deleted', { serverId: ev.server_id, id: ev.id });
    res.json({ ok: true });
  }));

  // Confirmar presença: { status: 'going' | 'maybe' | null }
  r.put('/events/:eventId/rsvp', wrap(async (req, res) => {
    const { ev } = await eventWithAccess(req);
    const status = req.body && req.body.status;
    if (status !== null && status !== 'going' && status !== 'maybe') fail(400, 'Resposta inválida.');
    if (status) {
      await db.query(
        `INSERT INTO nexo_event_rsvps (event_id, user_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
        [ev.id, req.userId, status],
      );
    } else {
      await db.query('DELETE FROM nexo_event_rsvps WHERE event_id = $1 AND user_id = $2', [ev.id, req.userId]);
    }
    res.json({ event: await broadcast(ev.id) });
  }));
}

// ---------------------------------------------------------------- Lembretes
// A cada 30 s: avisa quem confirmou 15 min antes e na hora de começar.
async function notify(rows, started) {
  for (const ev of rows) {
    const { rows: rs } = await db.query('SELECT user_id FROM nexo_event_rsvps WHERE event_id = $1', [ev.id]);
    const ids = rs.map((x) => x.user_id);
    if (!ids.length) continue;
    const mins = Math.max(1, Math.round((new Date(ev.starts_at).getTime() - Date.now()) / 60000));
    const body = started ? `📅 ${ev.title} começou!` : `📅 ${ev.title} começa em ${mins} min.`;
    const payload = { serverId: ev.server_id, eventId: ev.id, channelId: ev.channel_id, title: ev.title, started, text: body };
    events.emitTo(ids.map((id) => `user:${id}`), 'event:reminder', payload);
    const away = ids.filter((id) => !presence.isActive(id));
    if (!away.length) continue;
    const { rows: srv } = await db.query('SELECT name FROM servers WHERE id = $1', [ev.server_id]);
    const { rows: ok } = await db.query("SELECT id FROM users WHERE id = ANY($1::int[]) AND NOT is_bot AND status <> 'dnd'", [away]);
    await push.sendToUsers(ok.map((u) => u.id), {
      title: `Evento em ${srv[0] ? srv[0].name : 'Nexo'}`,
      body,
      url: `/?servidor=${ev.server_id}${ev.channel_id ? `&canal=${ev.channel_id}` : ''}&eventos=1`,
      tag: `evento-${ev.id}`,
      kind: 'event',
    });
  }
}

async function tick() {
  const reminded = await db.query(
    `UPDATE nexo_events SET reminded_at = now()
     WHERE id IN (SELECT id FROM nexo_events
                  WHERE reminded_at IS NULL AND started_at IS NULL
                    AND starts_at > now() + interval '1 minute'
                    AND starts_at <= now() + interval '${REMIND_MINUTES} minutes'
                  FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  const started = await db.query(
    `UPDATE nexo_events SET started_at = now(), reminded_at = COALESCE(reminded_at, now())
     WHERE id IN (SELECT id FROM nexo_events
                  WHERE started_at IS NULL AND starts_at <= now() + interval '1 minute' AND starts_at > now() - interval '1 hour'
                  FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  await notify(reminded.rows, false);
  await notify(started.rows, true);
}

let timer = null;
function startReminders() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((err) => console.error('Erro nos lembretes de eventos:', err.message)); }, Number(process.env.EVENT_TICK_MS) || 30 * 1000);
  timer.unref();
}

module.exports = routes;
module.exports.startReminders = startReminders;
module.exports.tick = tick;
