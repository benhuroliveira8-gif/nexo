const db = require('../db');
const auth = require('../auth');
const S = require('../serializers');
const events = require('../events');
const files = require('../files');
const presence = require('../presence');
const totp = require('../totp');
const voice = require('../voice');
const push = require('../push');
const gifs = require('../gifs');
const { wrap, fail, parseId } = require('./util');

const USER_COLS = 'id, username, display_name, is_bot, avatar_id, status, status_text, status_expires_at, about, totp_enabled, token_version';

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
      `SELECT ${USER_COLS}, password_hash FROM users WHERE username = $1 AND NOT is_bot`,
      [username],
    );
    const user = rows[0];
    if (!user || !(await auth.checkPassword(password, user.password_hash))) {
      loginFails.set(key, [...recentFails(key), Date.now()]);
      fail(401, 'Usuário ou senha incorretos.');
    }
    loginFails.delete(key);
    // Com 2FA ligado, a senha certa só libera a segunda etapa (o código do app).
    if (user.totp_enabled) return res.json({ twoFactorRequired: true, ticket: auth.signTicket(user.id, '2fa-login') });
    res.json({ token: auth.signToken(user), user: S.me(user) });
  }));

  // Segunda etapa do login: código de 6 dígitos do app (ou um código de recuperação).
  r.post('/auth/2fa', wrap(async (req, res) => {
    const userId = auth.verifyTicket(req.body.ticket, '2fa-login');
    if (!userId) fail(401, 'O tempo para digitar o código acabou. Entre de novo.');
    const key = `2fa|${userId}`;
    if (recentFails(key).length >= LOGIN_MAX_FAILS) fail(429, 'Muitos códigos errados. Espere 15 minutos e tente de novo.');
    const ok = await checkSecondFactor(userId, req.body.code);
    if (!ok) {
      loginFails.set(key, [...recentFails(key), Date.now()]);
      fail(401, 'Código incorreto.');
    }
    loginFails.delete(key);
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
    res.json({ token: auth.signToken(rows[0]), user: S.me(rows[0]), usedRecovery: ok === 'recovery' });
  }));
}

// Confere o código do app autenticador ou um código de recuperação (que só vale uma vez).
// Devolve 'totp', 'recovery' ou false.
async function checkSecondFactor(userId, code) {
  const { rows } = await db.query('SELECT totp_secret, totp_last_step, totp_recovery FROM users WHERE id = $1 AND totp_enabled', [userId]);
  const u = rows[0];
  if (!u) return false;
  const step = totp.verify(u.totp_secret, code, u.totp_last_step);
  if (step !== null) {
    // Grava o passo usado: o mesmo código não serve duas vezes.
    const upd = await db.query(
      'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
      [userId, step],
    );
    return upd.rowCount ? 'totp' : false;
  }
  const hash = totp.hashRecovery(code);
  if (String(code || '').replace(/[^a-f0-9]/gi, '').length === 10 && (u.totp_recovery || []).includes(hash)) {
    const upd = await db.query(
      'UPDATE users SET totp_recovery = array_remove(totp_recovery, $2) WHERE id = $1 AND $2 = ANY(totp_recovery)',
      [userId, hash],
    );
    return upd.rowCount ? 'recovery' : false;
  }
  return false;
}

// Confere a senha (e o 2FA, se estiver ligado) antes de ações sensíveis.
async function confirmIdentity(userId, { password, code }) {
  const { rows } = await db.query('SELECT password_hash, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await auth.checkPassword(String(password || ''), rows[0].password_hash))) fail(403, 'Senha incorreta.');
  if (rows[0].totp_enabled && !(await checkSecondFactor(userId, code))) fail(403, 'Código de verificação incorreto.');
}

// Desconecta todas as abas/aparelhos de uma pessoa.
function disconnectEverywhere(userId) {
  const io = events.getIo();
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
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
    let about = u.about;
    if (b.about !== undefined) {
      about = String(b.about || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (about.length > 190) fail(400, 'O "sobre mim" pode ter no máximo 190 caracteres.');
      about = about || null;
    }
    let statusText = u.status_text;
    if (b.statusText !== undefined) {
      statusText = String(b.statusText || '').replace(/\s+/g, ' ').trim();
      if (statusText.length > 80) fail(400, 'O texto do status pode ter no máximo 80 caracteres.');
      statusText = statusText || null;
    }
    // Prazo do status personalizado ("até 22h"): some sozinho nesse horário.
    let expires = u.status_expires_at;
    if (b.statusText !== undefined) expires = null;
    if (b.statusExpiresAt !== undefined && b.statusExpiresAt !== null && statusText) {
      const d = new Date(String(b.statusExpiresAt));
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 30000) fail(400, 'Escolha um horário no futuro para o status sumir.');
      if (d.getTime() > Date.now() + 31 * 86400000) fail(400, 'O prazo pode ser de no máximo 31 dias.');
      expires = d.toISOString();
    }
    if (!statusText) expires = null;
    const { rows } = await db.query(
      `UPDATE users SET display_name = $2, status = $3, status_text = $4, about = $5, status_expires_at = $6 WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, displayName, status, statusText, about, expires],
    );
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));

  r.delete('/me/avatar', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE users u SET avatar_id = NULL FROM users old WHERE u.id = $1 AND old.id = u.id
       RETURNING old.avatar_id AS previous, ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')}`,
      [req.userId],
    );
    if (rows[0]?.previous) files.removeAvatar(rows[0].previous);
    await profileChanged(req.userId);
    res.json({ user: S.me(rows[0]) });
  }));

  // Perfil de outra pessoa (para o cartão de perfil): "sobre mim" e desde quando está no Nexo.
  // Só para quem divide um servidor, uma conversa ou é amigo.
  r.get('/users/:userId/profile', wrap(async (req, res) => {
    const id = parseId(req.params.userId);
    const { rows } = id ? await db.query(
      `SELECT u.id, u.username, u.display_name, u.is_bot, u.avatar_id, u.about, u.created_at FROM users u
       WHERE u.id = $1 AND ($1 = $2
         OR EXISTS (SELECT 1 FROM server_members x JOIN server_members y ON y.server_id = x.server_id WHERE x.user_id = $1 AND y.user_id = $2)
         OR EXISTS (SELECT 1 FROM dm_members x JOIN dm_members y ON y.channel_id = x.channel_id WHERE x.user_id = $1 AND y.user_id = $2)
         OR EXISTS (SELECT 1 FROM friendships f WHERE (f.requester_id = $1 AND f.addressee_id = $2) OR (f.requester_id = $2 AND f.addressee_id = $1)))`,
      [id, req.userId],
    ) : { rows: [] };
    if (!rows[0]) fail(404, 'Usuário não encontrado.');
    const mutual = await db.query(
      `SELECT s.id, s.name FROM servers s JOIN server_members x ON x.server_id = s.id AND x.user_id = $1
       JOIN server_members y ON y.server_id = s.id AND y.user_id = $2 ORDER BY s.name LIMIT 20`,
      [id, req.userId],
    );
    res.json({
      user: S.user(rows[0]),
      about: rows[0].about || null,
      createdAt: rows[0].created_at,
      mutualServers: id === req.userId ? [] : mutual.rows,
    });
  }));

  // ---------- Segurança da conta (só pessoas)
  r.use('/me/password', auth.humansOnly);
  r.use('/me/2fa', auth.humansOnly);
  r.use('/me/sessions', auth.humansOnly);

  // Trocar a senha: sai de todos os outros aparelhos e devolve um token novo para este.
  r.post('/me/password', wrap(async (req, res) => {
    const next = String(req.body.newPassword || '');
    if (next.length < 6 || next.length > 128) fail(400, 'A nova senha precisa ter entre 6 e 128 caracteres.');
    await confirmIdentity(req.userId, { password: req.body.currentPassword, code: req.body.code });
    const hash = await auth.hashPassword(next);
    const { rows } = await db.query(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, hash],
    );
    disconnectEverywhere(req.userId);
    res.json({ token: auth.signToken(rows[0]), user: S.me(rows[0]) });
  }));

  // Sair de todos os aparelhos (inclusive este; o navegador recebe um token novo).
  r.post('/me/sessions/revoke', wrap(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId],
    );
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.userId]);
    disconnectEverywhere(req.userId);
    res.json({ token: auth.signToken(rows[0]), user: S.me(rows[0]) });
  }));

  // 2FA passo 1: gera o segredo (ainda desligado) e devolve o endereço para o QR code.
  r.post('/me/2fa/setup', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT username, password_hash, totp_enabled FROM users WHERE id = $1', [req.userId]);
    if (rows[0].totp_enabled) fail(400, 'A verificação em duas etapas já está ligada.');
    if (!(await auth.checkPassword(String(req.body.password || ''), rows[0].password_hash))) fail(403, 'Senha incorreta.');
    const secret = totp.newSecret();
    await db.query('UPDATE users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1', [req.userId, secret]);
    res.json({ secret, uri: totp.otpauthUri(secret, rows[0].username) });
  }));

  // 2FA passo 2: confere o primeiro código do app e liga. Devolve os códigos de recuperação.
  r.post('/me/2fa/enable', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.userId]);
    if (rows[0].totp_enabled) fail(400, 'A verificação em duas etapas já está ligada.');
    if (!rows[0].totp_secret) fail(400, 'Comece a configuração de novo.');
    const step = totp.verify(rows[0].totp_secret, req.body.code, null);
    if (step === null) fail(400, 'Código incorreto. Confira se o horário do celular está certo e tente de novo.');
    const codes = totp.newRecoveryCodes();
    const { rows: updated } = await db.query(
      `UPDATE users SET totp_enabled = true, totp_last_step = $2, totp_recovery = $3, token_version = token_version + 1
       WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId, step, codes.map(totp.hashRecovery)],
    );
    disconnectEverywhere(req.userId);
    res.json({ recoveryCodes: codes, token: auth.signToken(updated[0]), user: S.me(updated[0]) });
  }));

  r.post('/me/2fa/disable', wrap(async (req, res) => {
    await confirmIdentity(req.userId, { password: req.body.password, code: req.body.code });
    const { rows } = await db.query(
      `UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL
       WHERE id = $1 RETURNING ${USER_COLS}`,
      [req.userId],
    );
    res.json({ user: S.me(rows[0]) });
  }));

  // Gera códigos de recuperação novos (os antigos param de valer).
  r.post('/me/2fa/recovery', wrap(async (req, res) => {
    const { rows } = await db.query('SELECT totp_enabled FROM users WHERE id = $1', [req.userId]);
    if (!rows[0].totp_enabled) fail(400, 'Ligue a verificação em duas etapas primeiro.');
    await confirmIdentity(req.userId, { password: req.body.password, code: req.body.code });
    const codes = totp.newRecoveryCodes();
    await db.query('UPDATE users SET totp_recovery = $2 WHERE id = $1', [req.userId, codes.map(totp.hashRecovery)]);
    res.json({ recoveryCodes: codes });
  }));

  // Apagar a conta. Mensagens antigas ficam como "Usuário removido".
  // Quem é dono de servidor precisa apagar (ou passar) os servidores antes.
  r.delete('/me', auth.humansOnly, wrap(async (req, res) => {
    await confirmIdentity(req.userId, { password: req.body.password, code: req.body.code });
    const owned = await db.query('SELECT name FROM servers WHERE owner_id = $1 ORDER BY name', [req.userId]);
    if (owned.rows.length) {
      fail(400, `Você é dono de ${owned.rows.length === 1 ? 'um servidor' : `${owned.rows.length} servidores`} (${owned.rows.map((s) => s.name).join(', ')}). Apague-os antes de apagar a conta.`);
    }
    const servers = await db.query('SELECT server_id FROM server_members WHERE user_id = $1', [req.userId]);
    const friends = await events.friendIdsOf(req.userId);
    const groups = await db.query(
      `SELECT c.id FROM channels c JOIN dm_members d ON d.channel_id = c.id AND d.user_id = $1
       WHERE c.kind = 'dm' AND c.dm_key IS NULL`,
      [req.userId],
    );
    const partners = await db.query(
      'SELECT DISTINCT o.user_id FROM dm_members d JOIN dm_members o ON o.channel_id = d.channel_id AND o.user_id <> d.user_id WHERE d.user_id = $1',
      [req.userId],
    );
    const bots = await db.query('SELECT id, avatar_id FROM users WHERE bot_owner_id = $1', [req.userId]);
    const me = await db.query('SELECT avatar_id FROM users WHERE id = $1', [req.userId]);
    voice.leave(req.userId);
    disconnectEverywhere(req.userId);
    bots.rows.forEach((b) => disconnectEverywhere(b.id));
    await db.transaction(async (c) => {
      // Grupos que eram desta pessoa passam para outro membro.
      await c.query(
        `UPDATE channels c SET created_by = (SELECT user_id FROM dm_members WHERE channel_id = c.id AND user_id <> $1 LIMIT 1)
         WHERE c.kind = 'dm' AND c.dm_key IS NULL AND c.created_by = $1`,
        [req.userId],
      );
      await c.query('DELETE FROM users WHERE id = $1', [req.userId]);
      // Grupo que ficou vazio some.
      await c.query(
        `DELETE FROM channels c WHERE c.kind = 'dm' AND c.dm_key IS NULL AND c.id = ANY($1::int[])
           AND NOT EXISTS (SELECT 1 FROM dm_members WHERE channel_id = c.id)`,
        [groups.rows.map((g) => g.id)],
      );
    });
    [me.rows[0], ...bots.rows].forEach((u) => { if (u && u.avatar_id) files.removeAvatar(u.avatar_id); });
    servers.rows.forEach((s) => events.serverChanged(s.server_id));
    events.friendsChanged(...friends);
    events.emitTo(partners.rows.map((p) => `user:${p.user_id}`), 'dms:changed', {});
    res.json({ ok: true });
  }));

  // ---------- Notificações push
  // Configuração da pesquisa de GIFs (KLIPY). A pesquisa é feita pelo navegador.
  r.get('/gifs/config', wrap(async (req, res) => res.json(gifs.config(req.userId))));

  r.get('/push/key', wrap(async (req, res) => res.json({ publicKey: await push.publicKey() })));
  r.post('/push/subscribe', auth.humansOnly, wrap(async (req, res) => {
    if (!(await push.subscribe(req.userId, req.body || {}))) fail(400, 'Inscrição de notificação inválida.');
    res.json({ ok: true });
  }));
  r.post('/push/unsubscribe', wrap(async (req, res) => {
    await push.unsubscribe(req.userId, req.body && req.body.endpoint);
    res.json({ ok: true });
  }));
  // Manda uma notificação de teste para os seus aparelhos.
  r.post('/push/test', auth.humansOnly, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.userId]);
    if (!rows[0].n) fail(400, 'Nenhum aparelho com notificações ligadas.');
    await push.sendToUsers([req.userId], { title: 'Nexo', body: 'As notificações estão funcionando! 🎉', url: '/', tag: 'teste' });
    res.json({ ok: true, devices: rows[0].n });
  }));
}

module.exports = { publicRoutes, meRoutes, profileChanged, USER_COLS };
