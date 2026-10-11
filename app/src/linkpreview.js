// Prévias de link: quando alguém manda um link, o Nexo abre a página e pega título,
// descrição e imagem (as tags "og:" que sites e o YouTube colocam para isso).
//
// Segurança: o servidor só acessa endereços PÚBLICOS da internet. Endereços da sua rede
// (192.168.x.x, o banco de dados, o Jenkins...) são bloqueados, inclusive depois de
// redirecionamentos, para ninguém usar as prévias para espiar a rede interna.
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const db = require('./db');

const ENABLED = process.env.LINK_PREVIEWS !== '0';
const ALLOW_PRIVATE = process.env.LINK_PREVIEW_ALLOW_PRIVATE === '1'; // só para testes
const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const CACHE_HOURS = 24;
const UA = 'Mozilla/5.0 (compatible; NexoBot/1.0; +link-preview)';

// ---------------------------------------------------------------- Endereços proibidos

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['2001::', 32], ['2001:db8::', 32], ['2002::', 16]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function isPublicIp(ip) {
  if (ALLOW_PRIVATE) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) return globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
  return false;
}

async function resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const list = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.promises.lookup(host, { all: true });
  if (!list.length || !list.every((a) => isPublicIp(a.address))) throw new Error('endereço não permitido');
  return list[0];
}

// ---------------------------------------------------------------- Baixar com segurança

function requestOnce(url, { accept, maxBytes, stopOn }) {
  return new Promise((resolve, reject) => {
    resolvePublic(url.hostname).then((addr) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.6' },
        timeout: 6000,
        // Conecta exatamente no IP que já conferimos (evita trocar o DNS no meio do caminho).
        lookup: (h, opts, cb) => (opts && opts.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)),
      }, (res) => {
        const type = String(res.headers['content-type'] || '').toLowerCase();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
        if (stopOn && stopOn(type)) { res.destroy(); return resolve({ type, body: Buffer.alloc(0), stopped: true }); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            return resolve({ type, body: Buffer.concat(chunks), truncated: true });
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
      req.on('error', reject);
      req.end();
    }).catch(reject);
  });
}

async function safeFetch(rawUrl, opts) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 5; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocolo não permitido');
    if (url.port && !['80', '443'].includes(url.port) && !ALLOW_PRIVATE) throw new Error('porta não permitida');
    if (url.username || url.password) throw new Error('endereço não permitido');
    const r = await requestOnce(url, opts);
    if (!r.redirect) return { ...r, url: url.href };
    url = new URL(r.redirect, url);
  }
  throw new Error('redirecionamentos demais');
}

// ---------------------------------------------------------------- Ler as tags da página

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const clean = (s, max) => (s ? decodeEntities(String(s)).replace(/\s+/g, ' ').trim().slice(0, max) : null) || null;

function parseMeta(html) {
  const end = html.search(/<\/head>/i);
  const head = end === -1 ? html : html.slice(0, end);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    tag.replace(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_, k, __, a, b, c) => { attrs[k.toLowerCase()] = a ?? b ?? c; });
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  return { meta, title: title ? title[1] : null };
}

function youtubeId(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function buildPreview(url) {
  const yt = youtubeId(url);
  if (yt) {
    let title = null;
    let author = null;
    try {
      const r = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`,
        { accept: 'application/json', maxBytes: 64 * 1024 });
      const data = JSON.parse(r.body.toString('utf8'));
      title = clean(data.title, 200);
      author = clean(data.author_name, 100);
    } catch { /* sem título, mas ainda dá para mostrar o vídeo */ }
    return { type: 'youtube', url, youtubeId: yt, siteName: 'YouTube', title, description: author, image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, color: '#ff0000' };
  }

  const r = await safeFetch(url, {
    accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5',
    maxBytes: MAX_HTML,
    stopOn: (type) => !/text\/html|application\/xhtml/.test(type),
  });
  if (/^image\/(png|jpeg|gif|webp)/.test(r.type)) return { type: 'image', url, image: r.url };
  if (r.stopped) return null;
  const charset = /charset=([\w-]+)/.exec(r.type);
  let html;
  try { html = new TextDecoder(charset ? charset[1] : 'utf-8').decode(r.body); } catch { html = r.body.toString('utf8'); }
  const { meta, title } = parseMeta(html);
  const pick = (...keys) => keys.map((k) => meta[k]).find((v) => v && v.trim());
  const preview = {
    type: 'link',
    url,
    siteName: clean(pick('og:site_name', 'application-name'), 80) || new URL(r.url).hostname.replace(/^www\./, ''),
    title: clean(pick('og:title', 'twitter:title') || title, 200),
    description: clean(pick('og:description', 'twitter:description', 'description'), 350),
    image: null,
    color: /^#[0-9a-f]{6}$/i.test(meta['theme-color'] || '') ? meta['theme-color'] : null,
  };
  const img = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (img) {
    try {
      const abs = new URL(decodeEntities(img), r.url);
      if (abs.protocol === 'https:' || abs.protocol === 'http:') preview.image = abs.href;
    } catch { /* imagem inválida */ }
  }
  if (!preview.title && !preview.description) return null;
  return preview;
}

// Cache no banco: o mesmo link não é baixado de novo por 24 horas.
const inflight = new Map();
let running = 0;
const waiters = [];
async function limited(fn) {
  while (running >= 4) await new Promise((r) => waiters.push(r));
  running++;
  try { return await fn(); } finally { running--; const w = waiters.shift(); if (w) w(); }
}

async function getPreview(url) {
  const cached = await db.query(
    `SELECT data FROM link_previews WHERE url = $1 AND fetched_at > now() - make_interval(hours => $2::int)`,
    [url, CACHE_HOURS],
  );
  if (cached.rows[0]) return cached.rows[0].data;
  if (inflight.has(url)) return inflight.get(url);
  const p = limited(() => buildPreview(url))
    .catch(() => null)
    .then(async (data) => {
      await db.query(
        `INSERT INTO link_previews (url, data, fetched_at) VALUES ($1, $2, now())
         ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
        [url, data ? JSON.stringify(data) : null],
      );
      return data;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

// Links da mensagem que ganham prévia (até 3). Link entre <sinais> não ganha prévia,
// e links dentro de `código` ou ||spoiler|| também não.
const URL_RE = /<?https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"]>?/gi;
function linksIn(content) {
  const text = String(content || '').replace(/```[\s\S]*?```|`[^`\n]*`|\|\|[\s\S]*?\|\|/g, ' ');
  const out = [];
  for (const m of text.match(URL_RE) || []) {
    if (m.startsWith('<') && m.endsWith('>')) continue;
    const url = m.replace(/^<|>$/g, '');
    if (url.length > 600 || out.includes(url)) continue;
    out.push(url);
    if (out.length >= 3) break;
  }
  return out;
}

async function buildEmbeds(content) {
  if (!ENABLED) return [];
  const links = linksIn(content);
  if (!links.length) return [];
  const results = await Promise.all(links.map((u) => getPreview(u).catch(() => null)));
  return results.filter(Boolean);
}

// ---------------------------------------------------------------- Imagens das prévias
// As imagens passam pelo Nexo (assim os sites não ficam sabendo o IP de quem vê a mensagem).
// O endereço é assinado: só imagens que o próprio Nexo colocou numa prévia podem ser baixadas.
const SIGN_KEY = crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'nexo')).update('link-image').digest();
const sign = (url) => crypto.createHmac('sha256', SIGN_KEY).update(url).digest('base64url').slice(0, 22);
const proxyUrl = (url) => (url ? `/link-image/${sign(url)}/${Buffer.from(url).toString('base64url')}` : null);

function imageType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function serveImage(req, res) {
  let url;
  try { url = Buffer.from(String(req.params.data), 'base64url').toString('utf8'); } catch { return res.status(404).end(); }
  const sig = String(req.params.sig || '');
  const expected = sign(url);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(404).end();
  try {
    const r = await limited(() => safeFetch(url, { accept: 'image/*', maxBytes: MAX_IMAGE + 1 }));
    const type = imageType(r.body);
    if (!type || r.truncated) return res.status(404).end();
    res.set({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(r.body);
  } catch {
    if (!res.headersSent) res.status(404).end();
  }
}

// Faxina: tira do cache as prévias com mais de 7 dias.
function startCleanup() {
  const run = () => db.query("DELETE FROM link_previews WHERE fetched_at < now() - interval '7 days'").catch(() => {});
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { startCleanup, buildEmbeds, linksIn, proxyUrl, serveImage, youtubeId, isPublicIp, parseMeta, ENABLED };
