// Verificação em duas etapas (TOTP, RFC 6238): o mesmo código de 6 dígitos que
// apps como Google Authenticator, Microsoft Authenticator e Authy mostram.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;   // um código novo a cada 30 segundos
const WINDOW = 1;  // aceita o código anterior e o próximo (relógio um pouco atrasado/adiantado)

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const num = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(num).padStart(6, '0');
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// Devolve o "passo" do código se ele for válido (e mais novo que lastStep), senão null.
function verify(secret, code, lastStep = null, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const step = currentStep(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const s = step + d;
    if (lastStep !== null && s <= Number(lastStep)) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

// Link que os apps autenticadores entendem (vira QR code no navegador).
const otpauthUrl = (secret, account, issuer = 'Nexo') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// Códigos de recuperação: usados uma vez cada, se a pessoa perder o celular.
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
const hashRecovery = (code) => crypto.createHash('sha256')
  .update(String(code).toLowerCase().replace(/[^a-z2-7]/g, '')).digest('hex');

module.exports = { newSecret, verify, codeAt, currentStep, otpauthUrl, newRecoveryCodes, hashRecovery, base32Decode };
