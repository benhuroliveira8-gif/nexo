// Notificações push (Web Push): avisam no celular/computador mesmo com o Nexo fechado.
//
// Como funciona: o navegador da pessoa se inscreve num serviço de push (do Google, Mozilla,
// Apple ou Microsoft) e nos dá um "endereço". Para avisar, mandamos para esse endereço uma
// mensagem criptografada (só o navegador da pessoa consegue ler) e assinada com as nossas
// chaves VAPID. As chaves são criadas sozinhas na primeira vez e ficam guardadas no banco.
const crypto = require('crypto');
const db = require('./db');

const CONTACT = process.env.PUSH_CONTACT || 'mailto:nexo@example.com';
const ALLOW_ANY_HOST = process.env.PUSH_ALLOW_ANY_HOST === '1'; // só para testes

// Serviços de push conhecidos. Qualquer outro endereço é recusado (evita que alguém
// use o Nexo para fazer requisições a endereços internos da sua rede).
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com',
  'notify.windows.com', 'push.apple.com'];

function validEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (String(endpoint).length > 1000) return false;
  if (ALLOW_ANY_HOST) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// ---------------------------------------------------------------- Chaves VAPID

let keysPromise = null;

function loadKeys() {
  if (!keysPromise) {
    keysPromise = (async () => {
      let { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'vapid'");
      if (!rows[0]) {
        const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const value = JSON.stringify({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) });
        await db.query("INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT DO NOTHING", [value]);
        ({ rows } = await db.query("SELECT value FROM app_settings WHERE key = 'vapid'"));
      }
      const privateKey = crypto.createPrivateKey(JSON.parse(rows[0].value).privateKey);
      const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
      const publicRaw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      return { privateKey, publicKey: publicRaw.toString('base64url') };
    })().catch((err) => { keysPromise = null; throw err; });
  }
  return keysPromise;
}

const publicKey = async () => (await loadKeys()).publicKey;

function vapidJwt(audience, privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

// ---------------------------------------------------------------- Criptografia (RFC 8291, aes128gcm)

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encrypt(payload, p256dh, authSecret) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const auth = Buffer.from(authSecret, 'base64url');
  if (uaPublic.length !== 65 || auth.length < 16) throw new Error('chaves de inscrição inválidas');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ---------------------------------------------------------------- Envio

async function sendOne(sub, payload, keys) {
  const url = new URL(sub.endpoint);
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${vapidJwt(`${url.protocol}//${url.host}`, keys.privateKey)}, k=${keys.publicKey}`,
    },
    body,
    signal: AbortSignal.timeout(10000),
    redirect: 'manual',
  });
  // Inscrição vencida/cancelada: apaga.
  if (res.status === 404 || res.status === 410) {
    await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
  } else if (res.status >= 400) {
    console.warn(`Push recusado (${res.status}) por ${url.hostname}`);
  }
}

// payload: { title, body, url, tag }
async function sendToUsers(userIds, payload) {
  if (!userIds.length) return;
  // "Não perturbe" agendado (ex.: 23h às 7h): ninguém é acordado. O teste sempre chega.
  if (payload.tag !== 'teste') {
    // eslint-disable-next-line global-require
    userIds = await require('./profile').notQuiet(userIds);
    if (!userIds.length) return;
  }
  const { rows } = await db.query('SELECT * FROM push_subscriptions WHERE user_id = ANY($1::int[])', [userIds]);
  if (!rows.length) return;
  const keys = await loadKeys();
  const data = {
    title: String(payload.title || 'Nexo').slice(0, 120),
    body: String(payload.body || '').slice(0, 240),
    url: payload.url || '/',
    tag: payload.tag || undefined,
    kind: payload.kind || 'message',
  };
  await Promise.all(rows.map((sub) => sendOne(sub, data, keys).catch((err) => {
    console.warn('Falha ao enviar push:', err.message);
  })));
}

async function subscribe(userId, { endpoint, keys }) {
  if (!validEndpoint(endpoint)) return false;
  const p256dh = String((keys && keys.p256dh) || '');
  const auth = String((keys && keys.auth) || '');
  if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,40}$/.test(auth)) return false;
  // O mesmo endereço passa a ser de quem se inscreveu por último (ex.: outra conta no mesmo celular).
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, endpoint, p256dh, auth],
  );
  // Limite de aparelhos por pessoa.
  await db.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT 10)`,
    [userId],
  );
  return true;
}

const unsubscribe = (userId, endpoint) =>
  db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, String(endpoint || '')]);

module.exports = { publicKey, sendToUsers, subscribe, unsubscribe, encrypt, validEndpoint };
