// Prévia de links: quando alguém manda um link, o servidor visita a página e
// pega título, descrição e imagem (as tags "og:" que sites colocam para isso).
//
// Segurança: o servidor só visita endereços PÚBLICOS da internet. Ele recusa
// IPs da rede de casa/Docker (192.168.x, 10.x, 172.16-31.x, 127.x...), para
// ninguém usar a prévia para espiar a sua rede interna. As imagens também
// passam pelo servidor (/embed-img), assim quem vê a mensagem não expõe o
// próprio IP para o site do link.
const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const db = require('./db');

const ALLOW_PRIVATE = process.env.LINK_PREVIEW_ALLOW_PRIVATE === '1'; // só para testes
const MAX_URLS = 3;
const HTML_LIMIT = 1024 * 1024;     // lê no máximo 1 MB da página
const IMAGE_LIMIT = 8 * 1024 * 1024;
const CACHE_HOURS = 24;
const UA = 'Mozilla/5.0 (compatible; NexoLinkPreview/1.0; +https://github.com)';

// ---------------------------------------------------------------- IPs proibidos

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)   // CGNAT
    || (a === 169 && b === 254)            // link-local (inclui metadados de nuvem)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

async function resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('endereço não encontrado');
  if (!ALLOW_PRIVATE && addrs.some((a) => isPrivateIp(a.address))) throw new Error('endereço interno bloqueado');
  return addrs[0];
}

// ---------------------------------------------------------------- Download seguro

function requestOnce(url, addr, accept) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      agent: false,
      timeout: 6000,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      // Conecta no IP que JÁ conferimos (evita trocar o DNS no meio do caminho).
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)),
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('demorou demais')));
    req.on('error', reject);
    req.end();
  });
}

// Baixa um endereço seguindo até 4 redirecionamentos (conferindo cada um).
async function safeFetch(rawUrl, { accept, limit, stopAt }) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('protocolo não permitido');
    const addr = await resolvePublic(url.hostname);
    const res = await requestOnce(url, addr, accept);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw new Error(`status ${res.statusCode}`); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const declared = Number(res.headers['content-length'] || 0);
    if (declared > limit && !stopAt) { res.destroy(); throw new Error('arquivo grande demais'); }
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size > limit || (stopAt && stopAt(c))) { res.destroy(); resolve(); }
      });
      res.on('end', resolve);
      res.on('error', reject);
      res.on('close', resolve);
    });
    let body = Buffer.concat(chunks);
    if (size > limit) {
      if (!stopAt) throw new Error('arquivo grande demais');
      body = body.subarray(0, limit);
    }
    return { url, type, body };
  }
  throw new Error('redirecionamentos demais');
}

// ---------------------------------------------------------------- Ler as tags da página

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseMeta(html) {
  const meta = {};
  const head = html.slice(0, 300000);
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
      return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
    };
    const key = (attr('property') || attr('name') || '').toLowerCase();
    const content = attr('content');
    if (key && content && !(key in meta)) meta[key] = content.trim();
  }
  const title = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(head);
  if (title) meta._title = decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
  return meta;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function youtubeId(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (/^\/(shorts|embed|live)\/([\w-]+)/.exec(u.pathname) || [])[2];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------- Imagens pelo nosso servidor

const IMG_KEY = crypto.createHash('sha256').update(`nexo-embed-img:${process.env.JWT_SECRET || ''}`).digest();
const signImage = (url) => crypto.createHmac('sha256', IMG_KEY).update(url).digest('hex').slice(0, 24);
const proxiedImage = (url) => `/embed-img?u=${Buffer.from(url).toString('base64url')}&s=${signImage(url)}`;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

async function serveImage(req, res) {
  let url;
  try {
    url = Buffer.from(String(req.query.u || ''), 'base64url').toString();
    const sig = String(req.query.s || '');
    if (sig.length !== 24 || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signImage(url)))) return res.status(403).end();
    const r = await safeFetch(url, { accept: 'image/*', limit: IMAGE_LIMIT });
    if (!IMAGE_TYPES.has(r.type)) return res.status(415).end();
    res.set({
      'Content-Type': r.type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(r.body);
  } catch {
    res.status(404).end();
  }
}

// ---------------------------------------------------------------- Gerar a prévia

async function buildPreview(rawUrl) {
  const yt = youtubeId(rawUrl);
  const r = await safeFetch(rawUrl, {
    accept: 'text/html,application/xhtml+xml,image/*;q=0.8',
    limit: HTML_LIMIT,
    stopAt: (chunk) => /<\/head>/i.test(chunk.toString('latin1')),
  });
  if (IMAGE_TYPES.has(r.type)) {
    return { type: 'image', url: rawUrl, image: proxiedImage(r.url.href) };
  }
  if (!/html/.test(r.type)) return null;
  const meta = parseMeta(r.body.toString('utf8'));
  const title = clip(meta['og:title'] || meta['twitter:title'] || meta._title, 200);
  const description = clip(meta['og:description'] || meta['twitter:description'] || meta.description, 300);
  let image = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
  try { image = image ? new URL(image, r.url).href : null; } catch { image = null; }
  if (image && !/^https?:/.test(image)) image = null;
  if (!title && !image) return null;
  const color = /^#[0-9a-f]{3,8}$/i.test(meta['theme-color'] || '') ? meta['theme-color'] : null;
  return {
    type: yt ? 'video' : 'link',
    url: rawUrl,
    siteName: clip(meta['og:site_name'] || r.url.hostname.replace(/^www\./, ''), 80),
    title,
    description,
    image: image ? proxiedImage(image) : null,
    largeImage: yt ? true : /summary_large_image/.test(meta['twitter:card'] || '') || !!meta['og:image:width'] && Number(meta['og:image:width']) >= 400,
    color,
    youtubeId: yt,
  };
}

async function previewFor(url) {
  const cached = await db.query(
    `SELECT data FROM link_previews WHERE url = $1 AND fetched_at > now() - make_interval(hours => $2::int)`,
    [url, CACHE_HOURS],
  );
  if (cached.rows[0]) return cached.rows[0].data;
  let data = null;
  try { data = await buildPreview(url); } catch { data = null; }
  await db.query(
    `INSERT INTO link_previews (url, data, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
    [url, data ? JSON.stringify(data) : null],
  );
  return data;
}

// Links do texto (no máximo 3). Link entre <sinais> não gera prévia, como no Discord.
const URL_RE = /<?https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"]/gi;
function urlsIn(content) {
  const out = [];
  for (const m of String(content || '').matchAll(URL_RE)) {
    if (m[0].startsWith('<')) continue;
    if (m[0].length > 2048) continue;
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

async function embedsFor(content) {
  const urls = urlsIn(content);
  if (!urls.length) return [];
  const list = await Promise.all(urls.map((u) => previewFor(u).catch(() => null)));
  return list.filter(Boolean);
}

module.exports = { embedsFor, urlsIn, serveImage, isPrivateIp, parseMeta, youtubeId };
