// Administração do Nexo: contas (bloquear, código para nova senha, tornar admin) e disco.
const db = require('../db');
const S = require('../serializers');
const events = require('../events');
const presence = require('../presence');
const voice = require('../voice');
const admin = require('../admin');
const { wrap, fail, parseId } = require('./util');

function disconnectEverywhere(userId) {
  const io = events.getIo();
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

module.exports = function adminRoutes(r) {
  r.use('/admin', wrap(async (req, res, next) => {
    if (req.isBot || !(await admin.isAdmin(req.userId))) fail(403, 'Só a administração do Nexo pode ver isso.');
    next();
  }));

  r.get('/admin/overview', wrap(async (req, res) => {
    res.json(await admin.overview());
  }));

  // GET /admin/users?q=texto&offset=0
  r.get('/admin/users', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 50).replace(/[\\%_]/g, (c) => `\\${c}`);
    const offset = Math.max(0, Math.min(100000, Number(req.query.offset) || 0));
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.is_admin, u.blocked_at, u.blocked_reason,
              u.created_at, u.last_seen_at, u.status, u.totp_enabled, (u.recovery_key_hash IS NOT NULL) AS has_key,
              o.username AS owner_username,
              (SELECT count(*)::int FROM server_members WHERE user_id = u.id) AS servers,
              (SELECT count(*)::int FROM messages WHERE author_id = u.id) AS messages,
              (SELECT COALESCE(sum(size), 0)::bigint FROM attachments WHERE uploader_id = u.id AND purged_at IS NULL) AS bytes
       FROM users u LEFT JOIN users o ON o.id = u.bot_owner_id
       WHERE ($1 = '' OR lower(u.username) LIKE '%' || $1 || '%' OR lower(u.display_name) LIKE '%' || $1 || '%')
       ORDER BY u.is_bot, u.id LIMIT 51 OFFSET $2`,
      [q, offset],
    );
    res.json({
      users: rows.slice(0, 50).map((u) => ({
        ...S.user(u),
        isAdmin: u.is_admin,
        blockedAt: u.blocked_at,
        blockedReason: u.blocked_reason,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        online: presence.isConnected(u.id),
        twoFactor: u.totp_enabled,
        hasRecoveryKey: u.has_key,
        botOwner: u.owner_username,
        servers: u.servers,
        messages: u.messages,
        bytes: Number(u.bytes),
      })),
      hasMore: rows.length > 50,
    });
  }));

  async function target(req) {
    const id = parseId(req.params.id);
    const { rows } = id ? await db.query('SELECT id, username, display_name, is_bot, is_admin, blocked_at FROM users WHERE id = $1', [id]) : { rows: [] };
    if (!rows[0]) fail(404, 'Conta não encontrada.');
    return rows[0];
  }

  // Bloquear: a pessoa sai de todos os aparelhos e não consegue mais entrar.
  r.post('/admin/users/:id/block', wrap(async (req, res) => {
    const u = await target(req);
    if (u.id === req.userId) fail(400, 'Você não pode bloquear a sua própria conta.');
    if (u.is_admin) fail(400, 'Tire a administração dessa conta antes de bloquear.');
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    await db.query('UPDATE users SET blocked_at = now(), blocked_reason = $2, token_version = token_version + 1 WHERE id = $1', [u.id, reason]);
    voice.leave(u.id);
    disconnectEverywhere(u.id);
    console.log(`Conta @${u.username} bloqueada por #${req.userId}.`);
    res.json({ ok: true });
  }));

  r.delete('/admin/users/:id/block', wrap(async (req, res) => {
    const u = await target(req);
    await db.query('UPDATE users SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1', [u.id]);
    res.json({ ok: true });
  }));

  // Código para a pessoa criar uma senha nova (vale 24 h, uma vez). Aparece só agora.
  r.post('/admin/users/:id/reset-code', wrap(async (req, res) => {
    const u = await target(req);
    if (u.is_bot) fail(400, 'Bots não têm senha.');
    const code = admin.newResetCode();
    await db.query(
      "UPDATE users SET reset_code_hash = $2, reset_expires_at = now() + interval '24 hours' WHERE id = $1",
      [u.id, admin.hashCode(code)],
    );
    res.json({ code, username: u.username, expiresInHours: 24 });
  }));

  r.put('/admin/users/:id/admin', wrap(async (req, res) => {
    const u = await target(req);
    if (u.is_bot) fail(400, 'Bots não podem ser administradores.');
    const on = !!req.body.admin;
    if (!on) {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE is_admin AND blocked_at IS NULL AND NOT is_bot');
      if (rows[0].n <= 1 && u.is_admin) fail(400, 'O Nexo precisa de pelo menos um administrador.');
    }
    if (on && u.blocked_at) fail(400, 'Desbloqueie a conta antes.');
    await db.query('UPDATE users SET is_admin = $2 WHERE id = $1', [u.id, on]);
    // eslint-disable-next-line global-require
    const { USER_COLS } = require('./auth');
    const { rows: me } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [u.id]);
    if (me[0]) events.emitTo([`user:${u.id}`], 'me:updated', { user: S.me(me[0]) });
    res.json({ ok: true });
  }));

  // Disco: configurações da limpeza e limpar agora.
  r.put('/admin/storage', wrap(async (req, res) => {
    const s = admin.cleanStorageSettings(req.body || {});
    await admin.saveStorageSettings(s);
    res.json({ settings: s });
  }));

  r.post('/admin/storage/cleanup', wrap(async (req, res) => {
    const days = Math.round(Number(req.body.olderThanDays));
    if (!Number.isFinite(days) || days < 1 || days > 3650) fail(400, 'Diga de quantos dias para trás (1 ou mais).');
    res.json(await admin.purgeOld(days));
  }));
};
