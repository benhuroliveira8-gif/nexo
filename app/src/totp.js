// Verificação em duas etapas (2FA) com app autenticador (TOTP, RFC 6238):
// código de 6 dígitos que muda a cada 30 segundos.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
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

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
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
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = hmac[hmac.length - 1] & 15;
  const num = (hmac.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return String(num).padStart(6, '0');
}

// Confere o código aceitando 30s de diferença no relógio (para trás e para frente).
// Devolve o "passo" usado (para não aceitar o mesmo código duas vezes) ou null.
function verify(secret, code, lastStep) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = currentStep();
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= Number(lastStep)) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

// Endereço que o app autenticador entende (vira QR code no navegador).
const otpauthUri = (secret, username) =>
  `otpauth://totp/Nexo:${encodeURIComponent(username)}?secret=${secret}&issuer=Nexo&digits=6&period=30`;

// Códigos de recuperação (para quando perder o celular): guardamos só o hash.
function newRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 caracteres
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-f0-9]/g, '')).digest('hex');

module.exports = { newSecret, codeAt, currentStep, verify, otpauthUri, newRecoveryCodes, hashRecovery, base32Encode, base32Decode };
