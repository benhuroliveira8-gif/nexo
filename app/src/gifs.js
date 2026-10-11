// GIFs pelo KLIPY (https://klipy.com), o mesmo serviço que o Discord passou a usar
// depois que o Google desligou o Tenor.
//
// Regras do KLIPY que este arquivo respeita:
//  • a pesquisa é feita direto pelo navegador de cada pessoa (o servidor não busca nem guarda GIFs);
//  • o GIF é mostrado a partir do endereço do próprio KLIPY;
//  • aparece "Powered by KLIPY" na janela de pesquisa.
// Sem KLIPY_API_KEY no .env, a pesquisa fica desligada (o resto do Nexo funciona normal).
const crypto = require('crypto');

const KEY = String(process.env.KLIPY_API_KEY || '').trim();
const RATINGS = new Set(['g', 'pg', 'pg-13', 'r']);
const RATING = RATINGS.has(String(process.env.GIF_RATING || '').toLowerCase()) ? process.env.GIF_RATING.toLowerCase() : 'pg-13';
const ENABLED = /^[A-Za-z0-9_-]{8,200}$/.test(KEY);
if (KEY && !ENABLED) console.warn('KLIPY_API_KEY parece inválida (só letras, números, - e _). Pesquisa de GIFs desligada.');

// Identificador anônimo e fixo de cada pessoa (o KLIPY pede um "customer_id").
// Não dá para descobrir quem é a pessoa a partir dele.
const SALT = crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'nexo')).update('klipy-customer').digest();
function customerId(userId) {
  return crypto.createHmac('sha256', SALT).update(String(userId)).digest('hex').slice(0, 32);
}

function config(userId) {
  if (!ENABLED) return { enabled: false };
  return { enabled: true, provider: 'klipy', key: KEY, customerId: customerId(userId), rating: RATING };
}

// Só aceitamos GIFs hospedados pelo KLIPY (https).
const HOST_RE = /(^|\.)klipy\.(com|co)$/i;
function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > 600) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || !HOST_RE.test(u.hostname) || u.username || u.password || u.port) return null;
  return u.href;
}
const dim = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 4096 ? n : null; };

// Confere o GIF que veio do navegador. Devolve { url, mp4?, width, height, title, id } ou lança erro.
function clean(gif, MessageError) {
  if (!gif || typeof gif !== 'object') throw new MessageError('GIF inválido.');
  const url = cleanUrl(gif.url);
  if (!url) throw new MessageError('Esse GIF não é do KLIPY.');
  const width = dim(gif.width);
  const height = dim(gif.height);
  if (!width || !height) throw new MessageError('GIF inválido.');
  const out = { provider: 'klipy', url, width, height };
  const mp4 = gif.mp4 ? cleanUrl(gif.mp4) : null;
  if (mp4) out.mp4 = mp4;
  const title = String(gif.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (title) out.title = title;
  const id = String(gif.id || '').slice(0, 80);
  if (/^[\w-]+$/.test(id)) out.id = id;
  return out;
}

module.exports = { ENABLED, config, clean, cleanUrl, customerId };
