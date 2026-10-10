// Notificações push (aparecem no celular/PC mesmo com o Nexo fechado).
// Implementa o protocolo Web Push direto com o "crypto" do Node:
//  - VAPID (RFC 8292): identifica o nosso servidor para o Google/Apple/Mozilla
//  - aes128gcm (RFC 8291): criptografa a mensagem para só o aparelho conseguir ler
// As chaves VAPID são geradas sozinhas na primeira vez e ficam guardadas no banco.
const crypto = require('crypto');
const db = require('./db');

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:nexo@example.com';
let vapid = null; // { publicKey (base64url, 65 bytes), privateKey (KeyObject) }

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (str) => Buffer.from(String(str), 'base64url');

async function loadKeys() {
  if (vapid) return vapid;
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'vapid'");
  let jwk;
  if (rows[0]) {
    jwk = JSON.parse(rows[0].value);
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    // Se duas instâncias gerarem juntas, fica valendo a primeira.
    await db.query("INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(jwk)]);
    const again = await db.query("SELECT value FROM app_settings WHERE key = 'vapid'");
    jwk = JSON.parse(again.rows[0].value);
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  vapid = { publicKey, privateKey };
  return vapid;
}

async function publicKey() {
  return (await loadKeys()).publicKey;
}

// JWT assinado com ES256 que prova que a notificação veio do nosso servidor.
function vapidHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Criptografa a mensagem para um aparelho (RFC 8291 + RFC 8188, um único bloco).
function encrypt(plaintext, p256dhB64, authB64, testing = null) {
  const uaPublic = fromB64u(p256dhB64);
  const authSecret = fromB64u(authB64);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('chaves da inscrição inválidas');

  const ecdh = crypto.createECDH('prime256v1');
  let asPublic;
  if (testing) { ecdh.setPrivateKey(fromB64u(testing.asPrivate)); asPublic = ecdh.getPublicKey(); } else asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = testing ? fromB64u(testing.salt) : crypto.randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Endereços de push só podem ser dos serviços conhecidos (evita usar o servidor para atacar a rede interna).
const ALLOWED_PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)push\.microsoft\.com$/,
];
function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (process.env.PUSH_ALLOW_ANY_HOST === '1') return /^https?:$/.test(u.protocol); // só para testes
    if (u.protocol !== 'https:') return false;
    return ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// Envia para todos os aparelhos de uma lista de usuários.
async function sendToUsers(userIds, message) {
  if (!userIds.length) return;
  const { rows } = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ANY($1::int[])', [userIds]);
  if (!rows.length) return;
  const keys = await loadKeys();
  const payload = JSON.stringify(message).slice(0, 3000);
  await Promise.all(rows.map(async (sub) => {
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(sub.endpoint, keys),
          TTL: '86400',
          Urgency: 'high',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          ...(message.tag ? { Topic: String(message.tag).replace(/[^\w-]/g, '').slice(0, 32) } : {}),
        },
        body: encrypt(payload, sub.p256dh, sub.auth),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) {
        // O aparelho cancelou a inscrição (app desinstalado, permissão tirada...).
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      } else if (res.ok) {
        await db.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [sub.id]);
      } else {
        console.warn(`Push recusado (${res.status}) para ${new URL(sub.endpoint).hostname}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      console.warn('Falha ao enviar push:', err.message);
    }
  }));
}

module.exports = { publicKey, sendToUsers, encrypt, validEndpoint, vapidHeader, loadKeys };
