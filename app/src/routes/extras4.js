// Primeiros passos (regras + interesses), mensagens que somem, pastas de servidores,
// link do calendário (Google Agenda) e denúncias de mensagens.
const crypto = require('crypto');
const db = require('../db');
const S = require('../serializers');
const events = require('../events');
const M = require('../messages');
const { audit } = require('../audit');
const { P, channelAccess, memberContext } = require('../permissions');
const { humansOnly } = require('../auth');
const { wrap, fail, parseId, parseBigId } = require('./util');

const DISAPPEAR = [0, 86400, 604800]; // desligado, 24 horas, 7 dias
const REASONS = { spam: 'Spam ou propaganda', ofensa: 'Ofensa ou assédio', impróprio: 'Conteúdo impróprio', golpe: 'Golpe ou link perigoso', outro: 'Outro motivo' };

const cleanText = (v, max) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, max);

async function managed(req, perm) {
  const serverId = parseId(req.params.id);
  const ctx = serverId && await memberContext(serverId, req.userId);
  if (!ctx) fail(404, 'Servidor não encontrado.');
  if (perm && !ctx.can(perm)) fail(403, 'Você não tem permissão para isso.');
  return ctx;
}

// Roles que quem configura pode dar (abaixo do cargo mais alto dele).
async function checkRoles(ctx, roleIds) {
  if (!roleIds.length) return;
  const { rows } = await db.query('SELECT id, position, is_default FROM roles WHERE server_id = $1 AND id = ANY($2::int[])', [ctx.serverId, roleIds]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of roleIds) {
    const r = byId.get(id);
    if (!r || r.is_default) fail(400, 'Algum cargo escolhido não existe mais.');
    if (!ctx.isOwner && r.position >= ctx.top) fail(403, 'Você só pode usar cargos abaixo do seu.');
  }
}

module.exports = function extras4Routes(r) {
  // ================================================================ Primeiros passos
  r.get('/servers/:id/onboarding', wrap(async (req, res) => {
    const ctx = await managed(req);
    const { rows } = await db.query('SELECT onboarding FROM servers WHERE id = $1', [ctx.serverId]);
    const { rows: m } = await db.query('SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2', [ctx.serverId, req.userId]);
    res.json({ onboarding: rows[0].onboarding || { enabled: false, rules: '', interests: [] }, myRoleIds: m.map((x) => x.role_id) });
  }));

  r.put('/servers/:id/onboarding', wrap(async (req, res) => {
    const ctx = await managed(req, P.MANAGE_SERVER);
    const b = req.body || {};
    const interests = (Array.isArray(b.interests) ? b.interests : []).slice(0, 20).map((x, i) => ({
      id: String(x && x.id ? x.id : `i${i}`).replace(/[^\w-]/g, '').slice(0, 20) || `i${i}`,
      emoji: cleanText(x && x.emoji, 16),
      label: cleanText(x && x.label, 40).replace(/\s+/g, ' '),
      roleId: x && x.roleId ? parseId(x.roleId) : null,
    })).filter((x) => x.label);
    const ids = new Set();
    interests.forEach((x, i) => { if (ids.has(x.id)) x.id = `${x.id}-${i}`; ids.add(x.id); });
    await checkRoles(ctx, interests.map((x) => x.roleId).filter(Boolean));
    const ob = { enabled: !!b.enabled, rules: cleanText(b.rules, 3000), interests };
    if (ob.enabled && !ob.rules && !ob.interests.length) fail(400, 'Escreva as regras ou crie pelo menos um interesse.');
    await db.query('UPDATE servers SET onboarding = $2 WHERE id = $1', [ctx.serverId, JSON.stringify(ob)]);
    audit(ctx.serverId, req.userId, 'onboarding_update', { details: { enabled: ob.enabled, interests: interests.length } });
    events.serverChanged(ctx.serverId);
    res.json({ onboarding: ob });
  }));

  // "Li e aceito" (e também para mudar os interesses depois). { interestIds: [...] }
  r.post('/servers/:id/onboarding/accept', wrap(async (req, res) => {
    const ctx = await managed(req);
    const { rows } = await db.query('SELECT onboarding FROM servers WHERE id = $1', [ctx.serverId]);
    const ob = rows[0].onboarding || { interests: [] };
    const chosen = new Set((Array.isArray(req.body.interestIds) ? req.body.interestIds : []).map(String));
    const allRoles = (ob.interests || []).map((x) => x.roleId).filter(Boolean);
    const wanted = (ob.interests || []).filter((x) => chosen.has(x.id) && x.roleId).map((x) => x.roleId);
    await db.transaction(async (c) => {
      // Tira os cargos de interesse que a pessoa desmarcou e dá os que marcou.
      const remove = allRoles.filter((id) => !wanted.includes(id));
      if (remove.length) await c.query('DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = ANY($3::int[])', [ctx.serverId, req.userId, remove]);
      for (const id of wanted) {
        await c.query(
          `INSERT INTO member_roles (server_id, user_id, role_id) SELECT $1, $2, r.id FROM roles r
           WHERE r.id = $3 AND r.server_id = $1 AND NOT r.is_default ON CONFLICT DO NOTHING`,
          [ctx.serverId, req.userId, id],
        );
      }
      await c.query('UPDATE server_members SET onboarded_at = COALESCE(onboarded_at, now()) WHERE server_id = $1 AND user_id = $2', [ctx.serverId, req.userId]);
    });
    events.serverChanged(ctx.serverId);
    res.json({ ok: true, roleIds: wanted });
  }));

  // ================================================================ Mensagens que somem (DM)
  r.put('/dms/:channelId/disappearing', humansOnly, wrap(async (req, res) => {
    const channelId = parseId(req.params.channelId);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || access.kind !== 'dm') fail(404, 'Conversa não encontrada.');
    const seconds = Number(req.body.seconds);
    if (!DISAPPEAR.includes(seconds)) fail(400, 'Escolha: desligado, 24 horas ou 7 dias.');
    if ((access.channel.disappearing_seconds || 0) === seconds) return res.json({ seconds });
    await db.query('UPDATE channels SET disappearing_seconds = $2 WHERE id = $1', [channelId, seconds]);
    const { rows } = await db.query('SELECT display_name FROM users WHERE id = $1', [req.userId]);
    const label = seconds === 86400 ? '24 horas' : '7 dias';
    await M.createSystemMessage(access, req.userId, seconds
      ? `⏳ ${rows[0].display_name} ligou as mensagens temporárias: as novas mensagens somem ${label} depois de enviadas.`
      : `⏳ ${rows[0].display_name} desligou as mensagens temporárias.`);
    events.emitTo(access.rooms, 'dms:changed', {});
    res.json({ seconds });
  }));

  // ================================================================ Pastas de servidores
  // PUT /me/server-folders { folders: [{ id, name, color, serverIds }] }
  r.put('/me/server-folders', humansOnly, wrap(async (req, res) => {
    const list = Array.isArray(req.body.folders) ? req.body.folders.slice(0, 30) : [];
    const { rows } = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [req.userId]);
    const mine = new Set(rows.map((x) => x.server_id));
    const used = new Set();
    const folders = list.map((f, i) => ({
      id: String((f && f.id) || `f${i}`).replace(/[^\w-]/g, '').slice(0, 20) || `f${i}`,
      name: cleanText(f && f.name, 32).replace(/\s+/g, ' ') || 'Pasta',
      color: /^#[0-9a-f]{6}$/i.test((f && f.color) || '') ? f.color.toLowerCase() : null,
      serverIds: (Array.isArray(f && f.serverIds) ? f.serverIds : []).map(Number)
        .filter((id) => mine.has(id) && !used.has(id) && used.add(id)),
    })).filter((f) => f.serverIds.length);
    await db.query('UPDATE users SET server_folders = $2 WHERE id = $1', [req.userId, JSON.stringify(folders)]);
    events.emitTo([`user:${req.userId}`], 'folders:changed', { folders });
    res.json({ folders });
  }));
  r.get('/me/server-folders', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT server_folders FROM users WHERE id = $1', [req.userId]);
    res.json({ folders: (rows[0] && rows[0].server_folders) || [] });
  }));

  // ================================================================ Link do calendário (Google Agenda)
  const calendarUrl = (req, token) => `${String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()}://${req.get('host')}/calendario/${token}.ics`;
  r.get('/me/calendar-link', humansOnly, wrap(async (req, res) => {
    let { rows } = await db.query('SELECT calendar_token FROM users WHERE id = $1', [req.userId]);
    let token = rows[0].calendar_token;
    if (!token) {
      token = crypto.randomBytes(18).toString('base64url');
      await db.query('UPDATE users SET calendar_token = $2 WHERE id = $1', [req.userId, token]);
    }
    res.json({ url: calendarUrl(req, token) });
  }));
  // Gerar outro link (o antigo para de funcionar).
  r.post('/me/calendar-link', humansOnly, wrap(async (req, res) => {
    const token = crypto.randomBytes(18).toString('base64url');
    await db.query('UPDATE users SET calendar_token = $2 WHERE id = $1', [req.userId, token]);
    res.json({ url: calendarUrl(req, token) });
  }));

  // ================================================================ Denúncias
  // POST /messages/:messageId/report { reason, details }
  r.post('/messages/:messageId/report', humansOnly, wrap(async (req, res) => {
    const id = parseBigId(req.params.messageId);
    const { rows } = id ? await db.query(`${M.SELECT_MESSAGE} WHERE msg.id = $1`, [id]) : { rows: [] };
    const row = rows[0];
    const access = row && await channelAccess(row.channel_id, req.userId);
    if (!access) fail(404, 'Mensagem não encontrada.');
    if (!access.serverId) fail(400, 'Só dá para denunciar mensagens de servidores.');
    if (row.author_id === req.userId) fail(400, 'Você não pode denunciar a sua própria mensagem.');
    const reason = Object.hasOwn(REASONS, req.body.reason) ? req.body.reason : null;
    if (!reason) fail(400, 'Escolha o motivo.');
    const [message] = await M.hydrate(rows);
    const snapshot = {
      content: message.content, author: message.author, createdAt: message.createdAt,
      attachments: message.attachments.map((a) => ({ filename: a.filename, url: a.url, kind: a.kind })), gif: message.gif || null,
      channelName: access.channel.name,
    };
    try {
      await db.query(
        `INSERT INTO nexo_reports (server_id, channel_id, message_id, reporter_id, author_id, reason, details, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [access.serverId, row.channel_id, row.id, req.userId, row.author_id, reason, cleanText(req.body.details, 500) || null, JSON.stringify(snapshot)],
      );
    } catch (err) {
      if (err.code === '23505') fail(409, 'Você já denunciou esta mensagem. A moderação vai olhar.');
      throw err;
    }
    reportsChanged(access.serverId);
    res.status(201).json({ ok: true });
  }));

  // Fila da moderação: GET /servers/:id/reports?status=open|closed
  r.get('/servers/:id/reports', wrap(async (req, res) => {
    const ctx = await managed(req, P.MANAGE_MESSAGES);
    const closed = req.query.status === 'closed';
    const { rows } = await db.query(
      `SELECT r.*, ru.display_name AS reporter_name, mu.display_name AS resolver_name,
              EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id) AS message_exists,
              (SELECT count(*)::int FROM nexo_reports o WHERE o.message_id = r.message_id AND o.status = 'open') AS same_count
       FROM nexo_reports r LEFT JOIN users ru ON ru.id = r.reporter_id LEFT JOIN users mu ON mu.id = r.resolved_by
       WHERE r.server_id = $1 AND ${closed ? "r.status <> 'open'" : "r.status = 'open'"}
       ORDER BY r.created_at DESC LIMIT 100`,
      [ctx.serverId],
    );
    res.json({
      reports: rows.map((x) => ({
        id: x.id, status: x.status, reason: x.reason, reasonLabel: REASONS[x.reason] || x.reason, details: x.details,
        createdAt: x.created_at, channelId: x.channel_id, messageId: x.message_id ? String(x.message_id) : null,
        messageExists: x.message_exists, sameCount: x.same_count, snapshot: x.snapshot,
        reporter: x.reporter_id ? { id: x.reporter_id, displayName: x.reporter_name } : null,
        resolvedBy: x.resolved_by ? { id: x.resolved_by, displayName: x.resolver_name } : null,
        resolvedAt: x.resolved_at, note: x.note,
      })),
    });
  }));

  r.get('/servers/:id/reports/count', wrap(async (req, res) => {
    const ctx = await managed(req);
    if (!ctx.can(P.MANAGE_MESSAGES)) return res.json({ open: 0 });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM nexo_reports WHERE server_id = $1 AND status = 'open'", [ctx.serverId]);
    res.json({ open: rows[0].n });
  }));

  // PATCH /reports/:id { status: 'resolved'|'dismissed', note, deleteMessage }
  r.patch('/reports/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const { rows } = id ? await db.query('SELECT * FROM nexo_reports WHERE id = $1', [id]) : { rows: [] };
    const rep = rows[0];
    const ctx = rep && await memberContext(rep.server_id, req.userId);
    if (!ctx) fail(404, 'Denúncia não encontrada.');
    if (!ctx.can(P.MANAGE_MESSAGES)) fail(403, 'Você não tem permissão para isso.');
    const status = ['resolved', 'dismissed'].includes(req.body.status) ? req.body.status : null;
    if (!status) fail(400, 'Diga se foi resolvida ou descartada.');
    const note = cleanText(req.body.note, 300) || null;
    // Resolve junto as outras denúncias abertas da mesma mensagem (antes de apagar,
    // porque apagar a mensagem limpa o message_id das denúncias).
    await db.query(
      `UPDATE nexo_reports SET status = $2, note = $3, resolved_by = $4, resolved_at = now()
       WHERE status = 'open' AND (id = $1 OR (message_id IS NOT NULL AND message_id = $5))`,
      [rep.id, status, note, req.userId, rep.message_id],
    );
    let deleted = false;
    if (req.body.deleteMessage && rep.message_id) {
      const { rows: m } = await db.query('SELECT id, channel_id FROM messages WHERE id = $1', [rep.message_id]);
      if (m[0]) {
        const access = await channelAccess(m[0].channel_id, req.userId);
        await M.deleteMessage(m[0].id);
        if (access) events.emitTo(access.rooms, 'message:deleted', { id: String(m[0].id), channelId: m[0].channel_id });
        deleted = true;
      }
    }
    audit(rep.server_id, req.userId, 'report_close', {
      targetId: rep.author_id, targetName: rep.snapshot && rep.snapshot.author ? rep.snapshot.author.displayName : null,
      details: { status, reason: rep.reason, deleted },
    });
    reportsChanged(rep.server_id);
    res.json({ ok: true, deleted });
  }));
};

function reportsChanged(serverId) {
  events.emitTo([`server:${serverId}`], 'reports:changed', { serverId });
}

// ---------------------------------------------------------------- Mensagens que venceram
async function expireMessages() {
  const { rows } = await db.query(
    `SELECT m.id, m.channel_id FROM messages m WHERE m.expires_at IS NOT NULL AND m.expires_at <= now() ORDER BY m.expires_at LIMIT 500`,
  );
  if (!rows.length) return 0;
  const byChannel = new Map();
  for (const m of rows) {
    await M.deleteMessage(m.id);
    if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
    byChannel.get(m.channel_id).push(String(m.id));
  }
  for (const [channelId, ids] of byChannel) {
    const { rows: mem } = await db.query('SELECT user_id FROM dm_members WHERE channel_id = $1', [channelId]);
    const rooms = mem.map((x) => `user:${x.user_id}`);
    ids.forEach((id) => events.emitTo(rooms, 'message:deleted', { id, channelId }));
  }
  return rows.length;
}

// ---------------------------------------------------------------- Calendário (.ics)
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Linhas de no máximo 75 bytes (regra do formato).
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ` ${ch}`; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

async function calendarFeed(token, baseUrl) {
  if (!/^[\w-]{20,40}$/.test(String(token || ''))) return null;
  const { rows: u } = await db.query('SELECT id, display_name FROM users WHERE calendar_token = $1 AND blocked_at IS NULL AND NOT is_bot', [token]);
  if (!u[0]) return null;
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.description, e.starts_at, e.created_at, s.name AS server_name, s.id AS server_id, c.name AS channel_name
     FROM nexo_events e JOIN servers s ON s.id = e.server_id
     JOIN server_members sm ON sm.server_id = e.server_id AND sm.user_id = $1
     LEFT JOIN channels c ON c.id = e.channel_id
     WHERE e.starts_at > now() - interval '60 days' ORDER BY e.starts_at LIMIT 500`,
    [u[0].id],
  );
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nexo//Eventos//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc('Nexo — eventos')}`, 'X-WR-TIMEZONE:America/Sao_Paulo', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of rows) {
    const start = new Date(e.starts_at);
    lines.push(
      'BEGIN:VEVENT',
      `UID:nexo-evento-${e.id}@nexo`,
      `DTSTAMP:${icsDate(e.created_at)}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(new Date(start.getTime() + 3600000))}`,
      fold(`SUMMARY:${icsEsc(e.title)}`),
      fold(`DESCRIPTION:${icsEsc(`${e.description ? `${e.description}\n\n` : ''}Servidor: ${e.server_name}${e.channel_name ? ` · #${e.channel_name}` : ''}\n${baseUrl}/?servidor=${e.server_id}&eventos=1`)}`),
      fold(`LOCATION:${icsEsc(`Nexo · ${e.server_name}${e.channel_name ? ` · ${e.channel_name}` : ''}`)}`),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

module.exports.expireMessages = expireMessages;
module.exports.calendarFeed = calendarFeed;
module.exports.REASONS = REASONS;
