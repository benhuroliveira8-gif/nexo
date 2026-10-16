// Códigos por e-mail: confirmar o endereço (cadastro/troca) e recuperar a senha.
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const CODE_MINUTES = 30;
const RESET_MINUTES = 15;
const MAX_TRIES = 5;

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 120 && EMAIL_RE.test(e) ? e : null;
}

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hash = (userId, purpose, code) => crypto.createHmac('sha256', String(process.env.JWT_SECRET))
  .update(`${purpose}:${userId}:${String(code).replace(/\D/g, '')}`).digest('hex');

// Limite de envios: 1 por minuto e 6 por hora para cada conta (e cada endereço).
const sent = new Map();
function allowSend(key) {
  const now = Date.now();
  const list = (sent.get(key) || []).filter((t) => now - t < 3600000);
  if (list.length && now - list[list.length - 1] < 60000) return 'Espere um minuto para pedir outro código.';
  if (list.length >= 6) return 'Você pediu códigos demais. Tente de novo daqui a uma hora.';
  list.push(now);
  sent.set(key, list);
  return null;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of sent) if (!l.some((t) => now - t < 3600000)) sent.delete(k); }, 600000).unref();

// O e-mail já é de outra conta (confirmado)?
async function emailTaken(email, exceptUserId) {
  const { rows } = await db.query('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, exceptUserId || 0]);
  return rows.length > 0;
}

// Grava o e-mail novo (pendente) e manda o código de confirmação.
async function startVerify(user, email) {
  const code = newCode();
  await db.query(
    `UPDATE users SET email_new = $2, email_code_hash = $3, email_code_expires_at = now() + make_interval(mins => $4), email_code_tries = 0
     WHERE id = $1`,
    [user.id, email, hash(user.id, 'verify', code), CODE_MINUTES],
  );
  const body = mailer.codeEmail({
    title: 'Confirme o seu e-mail no Nexo',
    intro: `Olá, ${user.display_name || user.username}! Digite este código no Nexo para confirmar o seu e-mail:`,
    code,
    outro: `O código vale por ${CODE_MINUTES} minutos. Se não foi você que pediu, é só ignorar este e-mail.`,
  });
  await mailer.send({ to: email, subject: `${code} é o seu código do Nexo`, ...body });
}

// Confere o código. Devolve null (ok) ou a mensagem de erro.
async function finishVerify(userId, code) {
  const { rows } = await db.query(
    'SELECT email_new, email_code_hash, email_code_expires_at, email_code_tries FROM users WHERE id = $1',
    [userId],
  );
  const u = rows[0];
  if (!u || !u.email_new || !u.email_code_hash) return 'Peça um código primeiro.';
  if (u.email_code_tries >= MAX_TRIES) return 'Códigos errados demais. Peça um código novo.';
  if (new Date(u.email_code_expires_at) < new Date()) return 'O código venceu. Peça um novo.';
  const ok = crypto.timingSafeEqual(Buffer.from(u.email_code_hash), Buffer.from(hash(userId, 'verify', code)));
  if (!ok) {
    await db.query('UPDATE users SET email_code_tries = email_code_tries + 1 WHERE id = $1', [userId]);
    return 'Código incorreto.';
  }
  if (await emailTaken(u.email_new, userId)) return 'Esse e-mail já está em outra conta do Nexo.';
  try {
    await db.query(
      `UPDATE users SET email = email_new, email_new = NULL, email_verified_at = now(),
         email_code_hash = NULL, email_code_expires_at = NULL, email_code_tries = 0 WHERE id = $1`,
      [userId],
    );
  } catch (err) {
    if (err.code === '23505') return 'Esse e-mail já está em outra conta do Nexo.';
    throw err;
  }
  return null;
}

// "Esqueci a senha": manda um código para o e-mail confirmado (se existir).
async function startReset(login) {
  const v = String(login || '').trim().toLowerCase();
  if (!v) return;
  const { rows } = await db.query(
    `SELECT id, username, display_name, email FROM users
     WHERE NOT is_bot AND blocked_at IS NULL AND email IS NOT NULL AND (username = $1 OR lower(email) = $1)`,
    [v],
  );
  const u = rows[0];
  if (!u || allowSend(`reset:${u.id}`)) return; // em silêncio: não revela se a conta existe
  const code = newCode();
  await db.query(
    'UPDATE users SET email_reset_hash = $2, email_reset_expires_at = now() + make_interval(mins => $3) WHERE id = $1',
    [u.id, hash(u.id, 'reset', code), RESET_MINUTES],
  );
  const body = mailer.codeEmail({
    title: 'Criar uma senha nova no Nexo',
    intro: `Olá, ${u.display_name || u.username}! Alguém (provavelmente você) pediu para trocar a senha da conta @${u.username}. Use este código:`,
    code,
    outro: `O código vale por ${RESET_MINUTES} minutos. Se não foi você, ignore este e-mail: a sua senha continua a mesma.`,
  });
  await mailer.send({ to: u.email, subject: `${code} é o código para trocar a sua senha do Nexo`, ...body });
}

const resetMatches = (u, code) => !!(u && u.email_reset_hash && u.email_reset_expires_at
  && new Date(u.email_reset_expires_at) > new Date()
  && String(code || '').replace(/\D/g, '').length === 6
  && u.email_reset_hash === hash(u.id, 'reset', code));

module.exports = { cleanEmail, allowSend, emailTaken, startVerify, finishVerify, startReset, resetMatches };
