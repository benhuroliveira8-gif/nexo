const db = require('../db');
const auth = require('../auth');
const S = require('../serializers');
const events = require('../events');
const files = require('../files');
const presence = require('../presence');
const totp = require('../totp');
const webpush = require('../webpush');
const { wrap, fail } = require('./util');

const USER_COLS = 'id, username, display_name, is_bot, avatar_id, status, status_text, token_version, (totp_secret IS NOT NULL) AS two_factor';

// Código de convite para criar conta (opcional). Útil quando o Nexo fica
// aberto na internet: sem o código, ninguém de fora consegue se cadastrar.
const REGISTRATION_CODE = String(process.env.REGISTRATION_CODE || '').trim();

// Proteção contra quem tenta adivinhar senha: 10 erros em 15 min por IP+usuário.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // chave -> [timestamps]

function clientIp(req) {
  return String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}
function recentFails(key) {
  const now = Date.now();
  const list = (loginFails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFails.set(key, list); else loginFails.delete(key);
  return list;
}
setInterval(() => { for (const k of [...loginFails.keys()]) recentFails(k); }, 5 * 60 * 1000).unref();

// Nome, foto ou status mudou: todo mundo que vê essa pessoa precisa atualizar.
async function profileChanged(userId) {
  const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [userId]);
  servers.rows.forEach((s) => events.serverChanged(s.server_id));
  events.friendsChanged(userId, ...(await events.friendIdsOf(userId)));
  events.presenceChanged(userId);
}
files.onAvatarChanged((userId) => profileChanged(userId).catch(() => {}));

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
const RESERVED = new Set(['everyone', 'here']);

function cleanDisplayName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length > 32) fail(400, 'Nome de exibição pode ter no máximo 32 caracteres.');
  return name || fallback;
}

// Rotas públicas (sem login).
function publicRoutes(r) {
  r.get('/config', (req, res) => res.json({ registrationRequiresCode: !!REGISTRATION_CODE }));

  r.post('/auth/register', wrap(async (req, res) => {
    if (REGISTRATION_CODE && String(req.body.inviteCode || '').trim() !== REGISTRATION_CODE) {
      fail(403, 'Código de cadastro incorreto. Peça o código para quem administra o Nexo.');
    }
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!USERNAME_RE.test(username) || RESERVED.has(username)) {
      fail(400, 'Usuário deve ter 3 a 32 caracteres: letras minúsculas, números, _ ou .');
    }
    const displayName = cleanDisplayName(req.body.displayName, username);
    if (password.length < 6 || password.length > 128) fail(400, 'A senha precisa ter entre 6 e 128 caracteres.');

    try {
      const hash = await auth.hashPassword(password);
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, password_hash)
         VALUES ($1, $2, $3) RETURNING ${USER_COLS}`,
        [username, displayName, hash],
      );
      res.status(201).json({ token: auth.signToken(rows[0]), user: S.me(rows[0]) });
    } catch (err) {
      if (err.code === '23505') fail(409, 'Esse nome de usuário já existe.');
      throw err;
    }
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = `${clientIp(req)}|${username}`;
    if (recentFails(key).length >= LOGIN_MAX_FAILS) {
      fail(429, 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.');
    }
    const { rows } = await db.query(
      `SELECT ${USER_COLS}, password_hash, totp_secret, totp_last_step, totp_recovery FROM users WHERE username = $1 AND NOT is_bot`,
      [username],
    );
    const user = rows[0];
    const countFail = () => loginFails.set(key, [...recentFails(key), Date.now()]);
    if (!user || !(await auth.checkPassword(password, user.password_hash))) {
      countFail();
      fail(401, 'Usuário ou senha incorretos.');
    }
    // Verificação em duas etapas: senha certa, agora falta o código do app.
    if (user.totp_secret) {
      if (!req.body.code) return res.json({ twoFactorRequired: true });
      if (!(await checkSecondFactor(user, req.body.code))) {
        countFail();
        fail(401, 'Código inválido. Confira o app autenticador (ou use um código de recuperação).');
      }
    }
    loginFails.delete(key);
    res.json({ token: auth.signToken(user), user: S.me(user) });
  }));
}

// Confere o código de 6 dígitos (ou um código de recuperação, que só vale uma vez).
async function checkSecondFactor(user, rawCode) {
  const code = String(rawCode || '').trim();
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    const step = totp.verify(user.totp_secret, code, user.totp_last_step);
    if (step === null) return false;
    // Atualiza só se ninguém usou esse código antes (evita usar o mesmo código duas vezes).
    const r = await db.query(
      'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
      [user.id, step],
    );
    return r.rowCount === 1;
  }
  const hash = totp.hashRecovery(code);
  const r = await db.query(
    'UPDATE users SET totp_recovery = array_remove(totp_recovery, $2) WHERE id = $1 AND $2 = ANY(totp_recovery)',
    [user.id, hash],
  );
  return r.rowCount === 1;
}

async function loadSecrets(userId) {
  const { rows } = await db.query(
    `SELECT ${USER_COLS}, password_hash, totp_secret, totp_pending, totp_last_step, totp_recovery FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows[0]) fail(401, 'Usuário não encontrado.');
  return rows[0];
}

async function requirePassword(user, password) {
  if (!(await auth.checkPassword(String(password || ''), user.password_hash))) fail(403, 'Senha incorreta.');
}

// Derruba os outros logins: sobe a versão do token, desconecta as outras abas
// e para de mandar push para os outros aparelhos. Devolve o token novo deste aparelho.
async function revokeOtherSessions(req) {
  const { rows } = await db.query(
    `UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING ${USER_COLS}`,
    [req.userId],
  );
  const keep = String(req.body.keepEndpoint || '');
  await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint <> $2', [req.userId, keep]);
  const io = events.getIo();
  if (io) {
    const sockets = await io.in(`user:${req.userId}`).fetchSockets();
    sockets.filter((s) => s.id !== req.body.socketId).forEach((s) => s.disconnect(true));
  }
  return rows[0];
}

// Rotas do usuário logado.
function meRoutes(r) {
  r.get('/me', wrap(async (req, res) => {
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.userId]);
    if (!rows[0]) fail(401, 'Usuário não encontrado.');
    res.json({ user: S.me(rows[0]) });
  }));

  // Trocar nome de exibição, status (online/ausente/não perturbe/invisível)
  // e o texto do status ("Jogando Minecraft"). Só muda o que vier no corpo.
  r.patch('/me', wrap(async (req, res) => {
    const { rows: cur } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.userId]);
    const u = cur[0];
    if (!u) fail(401, 'Usuário não encontrado.');
    const b = req.body || {};
    const displayName = b.displayName !== undefined ? cleanDisplayName(b.displayName, u.username) : u.display_name;
    let status = u.status;
    if (b.status !== undefined) {
      if (!presence.STATUSES.includes(b.status)) fail(400, 'Status inválido.');
      status = b.status;
    }
    let statusText = u.status_text;
    if (b.statusText !== undefined) {
      statusText = String(b.statusText || '').replace(/\s+/g, ' ').trim();
      if (statusText.length > 80) fail(400, 'O texto do status pode ter no máximo 80 caracteres.');
      statusText = statusText || null;
    }
    const { rows } = await db.query(
      `UPDATE users SET display_name = $2, status = $3, status_text = $4 WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, displayName, status, statusText],
    );
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));

  r.delete('/me/avatar', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE users u SET avatar_id = NULL FROM users old WHERE u.id = $1 AND old.id = u.id
       RETURNING old.avatar_id AS previous, u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.status, u.status_text,
                 (u.totp_secret IS NOT NULL) AS two_factor`,
      [req.userId],
    );
    if (rows[0]?.previous) files.removeAvatar(rows[0].previous);
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));

  // ---------- Segurança da conta (só pessoas)

  r.post('/me/password', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    await requirePassword(user, req.body.currentPassword);
    const next = String(req.body.newPassword || '');
    if (next.length < 6 || next.length > 128) fail(400, 'A senha nova precisa ter entre 6 e 128 caracteres.');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.userId, await auth.hashPassword(next)]);
    const updated = await revokeOtherSessions(req);
    res.json({ token: auth.signToken(updated), user: S.me(updated) });
  }));

  r.post('/me/logout-all', auth.humansOnly, wrap(async (req, res) => {
    const updated = await revokeOtherSessions(req);
    res.json({ token: auth.signToken(updated), user: S.me(updated) });
  }));

  // Passo 1: gera o segredo (ainda não vale) e devolve o link para o QR code.
  r.post('/me/2fa/setup', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    await requirePassword(user, req.body.password);
    if (user.totp_secret) fail(400, 'A verificação em duas etapas já está ativa.');
    const secret = totp.newSecret();
    await db.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [req.userId, secret]);
    res.json({ secret, otpauthUrl: totp.otpauthUrl(secret, user.username) });
  }));

  // Passo 2: confere o primeiro código do app e ativa. Devolve os códigos de recuperação (uma vez só).
  r.post('/me/2fa/enable', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    if (user.totp_secret) fail(400, 'A verificação em duas etapas já está ativa.');
    if (!user.totp_pending) fail(400, 'Comece a configuração de novo.');
    const step = totp.verify(user.totp_pending, req.body.code);
    if (step === null) fail(400, 'Código inválido. Confira se o relógio do celular está certo e tente o código novo.');
    const codes = totp.newRecoveryCodes();
    const { rows } = await db.query(
      `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2, totp_recovery = $3
       WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, step, codes.map(totp.hashRecovery)],
    );
    res.json({ user: S.me(rows[0]), recoveryCodes: codes });
  }));

  r.post('/me/2fa/disable', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    await requirePassword(user, req.body.password);
    if (!user.totp_secret) fail(400, 'A verificação em duas etapas não está ativa.');
    if (!(await checkSecondFactor(user, req.body.code))) fail(403, 'Código inválido.');
    const { rows } = await db.query(
      `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_recovery = NULL
       WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId],
    );
    res.json({ user: S.me(rows[0]) });
  }));

  r.post('/me/2fa/recovery-codes', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    await requirePassword(user, req.body.password);
    if (!user.totp_secret) fail(400, 'A verificação em duas etapas não está ativa.');
    const codes = totp.newRecoveryCodes();
    await db.query('UPDATE users SET totp_recovery = $2 WHERE id = $1', [req.userId, codes.map(totp.hashRecovery)]);
    res.json({ recoveryCodes: codes });
  }));

  // Excluir a conta. Quem é dono de servidor precisa transferir ou apagar antes.
  r.delete('/me', auth.humansOnly, wrap(async (req, res) => {
    const user = await loadSecrets(req.userId);
    await requirePassword(user, req.body.password);
    if (user.totp_secret && !(await checkSecondFactor(user, req.body.code))) fail(403, 'Código de verificação inválido.');
    const owned = await db.query('SELECT name FROM servers WHERE owner_id = $1 ORDER BY name', [req.userId]);
    if (owned.rows.length) {
      fail(409, `Você é dono de: ${owned.rows.map((s) => s.name).join(', ')}. Transfira (Configurações do servidor → Membros) ou apague esses servidores antes.`);
    }
    const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [req.userId]);
    const friends = await events.friendIdsOf(req.userId);
    const avatar = await db.query('SELECT avatar_id FROM users WHERE id = $1', [req.userId]);
    const io = events.getIo();
    if (io) (await io.in(`user:${req.userId}`).fetchSockets()).forEach((s) => s.disconnect(true));
    await db.query('DELETE FROM users WHERE id = $1 OR (is_bot AND bot_owner_id = $1)', [req.userId]);
    if (avatar.rows[0]?.avatar_id) files.removeAvatar(avatar.rows[0].avatar_id);
    servers.rows.forEach((s) => events.serverChanged(s.server_id));
    events.friendsChanged(...friends);
    res.json({ ok: true });
  }));

  // ---------- Notificações push (cada navegador/celular se inscreve)

  r.get('/push/key', wrap(async (req, res) => res.json({ publicKey: await webpush.publicKey() })));

  r.post('/push/subscribe', auth.humansOnly, wrap(async (req, res) => {
    const endpoint = String(req.body.endpoint || '');
    const keys = req.body.keys || {};
    if (endpoint.length > 1000 || !webpush.validEndpoint(endpoint)) fail(400, 'Endereço de notificação inválido.');
    const p256dh = String(keys.p256dh || '');
    const authKey = String(keys.auth || '');
    if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,30}$/.test(authKey)) fail(400, 'Chaves de notificação inválidas.');
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.userId, endpoint, p256dh, authKey],
    );
    const count = await db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.userId]);
    if (count.rows[0].n > 20) {
      await db.query(
        `DELETE FROM push_subscriptions WHERE id IN (
           SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at LIMIT $2)`,
        [req.userId, count.rows[0].n - 20],
      );
    }
    res.status(201).json({ ok: true });
  }));

  r.post('/push/unsubscribe', wrap(async (req, res) => {
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.userId, String(req.body.endpoint || '')]);
    res.json({ ok: true });
  }));

  // Teste: manda uma notificação para os seus próprios aparelhos.
  r.post('/push/test', auth.humansOnly, wrap(async (req, res) => {
    await webpush.sendToUsers([req.userId], { title: 'Nexo', body: 'As notificações estão funcionando! 🎉', tag: 'teste', url: '/' });
    res.json({ ok: true });
  }));
}

module.exports = { publicRoutes, meRoutes, profileChanged };
