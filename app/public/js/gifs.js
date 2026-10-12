// GIFs: pesquisa no KLIPY (feita direto pelo navegador, como o KLIPY exige)
// e exibição dos GIFs nas mensagens.
import { isEconomy } from './economy.js';
import { h, api, openPopover, closePopover, storage, toast } from './util.js';

const API = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const RECENT_MAX = 24;
const TRENDING_TTL = 10 * 60 * 1000;

let cfgPromise = null;
let trendingCache = null; // { at, items, page, hasNext }

export function gifConfig() {
  if (!cfgPromise) {
    cfgPromise = api('/gifs/config').catch(() => {
      cfgPromise = null; // tenta de novo na próxima vez
      return { enabled: false, error: true };
    });
  }
  return cfgPromise;
}

// ---------------------------------------------------------------- Recentes (só neste navegador)

const recentKey = (userId) => `nexo.recentGifs.${userId}`;
function recent(userId) {
  try {
    const list = JSON.parse(storage(recentKey(userId)) || '[]');
    return Array.isArray(list) ? list.filter((g) => g && g.url && g.width && g.height).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function remember(userId, gif) {
  const list = [gif, ...recent(userId).filter((g) => g.url !== gif.url)].slice(0, RECENT_MAX);
  storage(recentKey(userId), JSON.stringify(list));
}

// ---------------------------------------------------------------- Favoritos ⭐ (só neste navegador)

const FAV_MAX = 100;
let currentUserId = null;
export const setGifUser = (id) => { currentUserId = id; };
const favKey = (userId) => `nexo.favGifs.${userId}`;
export function favorites(userId = currentUserId) {
  try {
    const list = JSON.parse(storage(favKey(userId)) || '[]');
    return Array.isArray(list) ? list.filter((g) => g && g.url && g.width && g.height) : [];
  } catch { return []; }
}
export const isFavorite = (gif, userId = currentUserId) => favorites(userId).some((g) => g.url === gif.url);
// Liga/desliga; devolve true se ficou favorito.
export function toggleFavorite(gif, userId = currentUserId) {
  const list = favorites(userId);
  const on = !list.some((g) => g.url === gif.url);
  const next = on
    ? [{ id: gif.id, title: gif.title, url: gif.url, mp4: gif.mp4, width: gif.width, height: gif.height, thumb: gif.thumb || gif.url, thumbW: gif.thumbW || gif.width, thumbH: gif.thumbH || gif.height }, ...list].slice(0, FAV_MAX)
    : list.filter((g) => g.url !== gif.url);
  storage(favKey(userId), JSON.stringify(next));
  return on;
}
const starBtn = (gif, userId, onToggle) => {
  const b = h('button', { type: 'button', class: 'gif-star' });
  const paint = () => {
    const on = isFavorite(gif, userId);
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
    b.title = on ? 'Tirar dos favoritos' : 'Favoritar';
    b.setAttribute('aria-label', b.title);
  };
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const on = toggleFavorite(gif, userId);
    paint();
    if (onToggle) onToggle(on);
  });
  paint();
  return b;
};

// ---------------------------------------------------------------- KLIPY

class GifError extends Error {}

// Um item do KLIPY -> { id, title, url, mp4, width, height, thumb, thumbW, thumbH }
function fromKlipy(item) {
  const f = item && item.file;
  if (!f) return null; // anúncios e outros tipos: ignora
  const pick = (sizes, kinds) => {
    for (const s of sizes) for (const k of kinds) {
      const v = f[s] && f[s][k];
      if (v && v.url && v.width && v.height) return v;
    }
    return null;
  };
  const main = pick(['md', 'hd', 'sm'], ['webp', 'gif']);
  const thumb = pick(['sm', 'xs', 'md'], ['webp', 'gif']) || main;
  if (!main) return null;
  const mp4 = pick(['md', 'hd'], ['mp4']);
  return {
    id: String(item.slug || item.id || ''),
    title: String(item.title || '').slice(0, 140),
    url: main.url, width: main.width, height: main.height,
    mp4: mp4 ? mp4.url : undefined,
    thumb: thumb.url, thumbW: thumb.width, thumbH: thumb.height,
  };
}

// Mesma escala do Tenor/KLIPY: high = só livre, off = tudo.
const FILTER = { g: 'high', pg: 'medium', 'pg-13': 'low', r: 'off' };

async function klipy(cfg, kind, { q = '', page = 1 } = {}) {
  const params = new URLSearchParams({
    page: String(page), per_page: String(PER_PAGE), customer_id: cfg.customerId,
    rating: cfg.rating, content_filter: FILTER[cfg.rating] || 'low',
  });
  if (q) params.set('q', q);
  let res;
  try {
    res = await fetch(`${API}/${encodeURIComponent(cfg.key)}/gifs/${kind}?${params}`, { referrerPolicy: 'no-referrer' });
  } catch {
    throw new GifError('Não consegui falar com o KLIPY. Verifique a internet.');
  }
  if (res.status === 429) throw new GifError('Muitas pesquisas de GIF nesta hora. Tente daqui a pouco.');
  if (res.status === 401 || res.status === 403) throw new GifError('A chave do KLIPY foi recusada. Avise o dono do Nexo.');
  if (!res.ok) throw new GifError('O KLIPY não respondeu agora. Tente de novo.');
  const json = await res.json().catch(() => null);
  const box = json && json.data;
  const list = Array.isArray(box) ? box : (box && Array.isArray(box.data) ? box.data : []);
  const items = list.map(fromKlipy).filter(Boolean);
  const hasNext = box && typeof box.has_next === 'boolean' ? box.has_next : items.length >= PER_PAGE / 2;
  return { items, hasNext };
}

// ---------------------------------------------------------------- Seletor

// Abre o seletor perto de "anchor"; onPick(gif) recebe o GIF para enviar.
export function openGifPicker(anchor, onPick, { userId } = {}) {
  const input = h('input', { class: 'gif-search', type: 'search', placeholder: 'Pesquisar GIFs no KLIPY', maxlength: '50', enterkeyhint: 'search' });
  const grid = h('div', { class: 'gif-grid' });
  const status = h('p', { class: 'gif-status muted small' });
  const scroller = h('div', { class: 'gif-scroll' }, grid, status);
  const footer = h('div', { class: 'gif-footer' }, h('span', {}, 'Powered by '), h('strong', {}, 'KLIPY'));
  const box = h('div', { class: 'gif-picker' }, input, scroller, footer);
  const pop = openPopover(anchor, box, { align: 'end', className: 'popover-gif' });

  let cfg = null;
  let seq = 0; // descarta respostas de pesquisas antigas
  let mode = null; // { kind: 'search'|'trending', q, page, hasNext, loading }
  let timer = null;

  const pick = (g) => {
    const gif = { id: g.id, title: g.title, url: g.url, mp4: g.mp4, width: g.width, height: g.height };
    remember(userId, { ...gif, thumb: g.thumb || g.url, thumbW: g.thumbW || g.width, thumbH: g.thumbH || g.height });
    closePopover();
    onPick(gif);
  };

  const tile = (g) => {
    const w = g.thumbW || g.width;
    const ht = g.thumbH || g.height;
    const img = h('img', {
      src: g.thumb || g.url, alt: g.title || 'GIF', loading: 'lazy', draggable: 'false',
      referrerpolicy: 'no-referrer', style: `aspect-ratio:${w}/${ht}`,
    });
    const t = h('div', { class: 'gif-tile', role: 'button', tabindex: '0', title: g.title || 'GIF', onclick: () => pick(g) },
      img, starBtn(g, userId));
    t.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === t) { e.preventDefault(); pick(g); } });
    return t;
  };

  const section = (title) => h('div', { class: 'gif-cat' }, title);

  const setStatus = (text) => { status.textContent = text || ''; status.hidden = !text; };

  async function load(kind, q, page) {
    const my = ++seq;
    mode = { kind, q, page, hasNext: false, loading: true };
    if (page === 1) setStatus('Carregando…');
    try {
      let result;
      if (kind === 'trending' && page === 1 && trendingCache && Date.now() - trendingCache.at < TRENDING_TTL) {
        result = trendingCache;
      } else {
        result = await klipy(cfg, kind, { q, page });
        if (kind === 'trending' && page === 1) trendingCache = { ...result, at: Date.now() };
      }
      if (my !== seq || !pop.isConnected) return;
      mode = { kind, q, page, hasNext: result.hasNext, loading: false };
      if (page === 1 && kind === 'search') grid.replaceChildren();
      grid.append(...result.items.map(tile));
      if (page === 1 && !result.items.length) setStatus(kind === 'search' ? `Nenhum GIF para “${q}”.` : 'Nada por aqui agora.');
      else setStatus('');
      fillIfShort();
    } catch (err) {
      if (my !== seq || !pop.isConnected) return;
      mode.loading = false;
      mode.hasNext = false;
      setStatus(err instanceof GifError ? err.message : 'Não foi possível carregar os GIFs.');
    }
  }

  // Tela inicial: recentes + em alta.
  function home() {
    seq++;
    grid.replaceChildren();
    const rec = recent(userId);
    const favs = favorites(userId);
    const on = !!(cfg && cfg.enabled);
    if (favs.length) grid.append(section('⭐ Favoritos'), ...favs.map(tile));
    if (rec.length) grid.append(section('Recentes'), ...rec.map(tile));
    if ((rec.length || favs.length) && on) grid.append(section('Em alta'));
    if (!on) {
      mode = null;
      setStatus(cfg && cfg.error ? 'Não foi possível carregar os GIFs.' : 'A pesquisa de GIFs ainda não foi ativada neste Nexo. O dono precisa colocar a chave do KLIPY (KLIPY_API_KEY) no .env.');
      return;
    }
    load('trending', '', 1);
  }

  function fillIfShort() {
    // Se a lista não encheu a janela, carrega mais (senão não dá para rolar).
    requestAnimationFrame(() => {
      if (mode && mode.hasNext && !mode.loading && scroller.scrollHeight <= scroller.clientHeight + 40) more();
    });
  }
  function more() {
    if (!mode || mode.loading || !mode.hasNext) return;
    load(mode.kind, mode.q, mode.page + 1);
  }
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 300) more();
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!cfg || !cfg.enabled) return;
    timer = setTimeout(() => {
      if (!pop.isConnected) return;
      if (q.length < 2) { home(); return; }
      scroller.scrollTop = 0;
      load('search', q, 1);
    }, 450); // espera parar de digitar (economiza pesquisas)
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      const q = input.value.trim();
      if (cfg && cfg.enabled && q.length >= 1) { scroller.scrollTop = 0; load('search', q, 1); }
    }
  });

  setStatus('Carregando…');
  gifConfig().then((c) => {
    cfg = c;
    if (!pop.isConnected) return;
    input.disabled = !c.enabled;
    home();
    if (c.enabled && window.matchMedia('(min-width: 901px)').matches) input.focus();
  });
}

// ---------------------------------------------------------------- GIF dentro da mensagem

const MAX_W = 300;
const MAX_H = 300;

export function buildGif(gif, { onLoad, pending } = {}) {
  const scale = Math.min(1, MAX_W / gif.width, MAX_H / gif.height);
  const w = Math.max(40, Math.round(gif.width * scale));
  const ht = Math.max(40, Math.round(gif.height * scale));
  // Modo economia: o GIF só baixa quando a pessoa toca.
  if (isEconomy() && !pending) {
    const box = h('button', {
      class: 'gif-msg gif-lazy', style: `width:${w}px;height:${ht}px;max-width:100%`, title: 'Modo economia: toque para ver o GIF',
      onclick: () => box.replaceWith(buildGifNow(gif, { onLoad, pending, w, ht })),
    }, h('span', { class: 'gif-lazy-play' }, '▶'), h('span', { class: 'gif-lazy-text' }, gif.title ? `GIF: ${gif.title}` : 'GIF — toque para ver'));
    return box;
  }
  return buildGifNow(gif, { onLoad, pending, w, ht });
}

function buildGifNow(gif, { onLoad, pending, w, ht }) {
  const img = h('img', {
    src: gif.url, alt: gif.title || 'GIF', loading: 'lazy', draggable: 'false',
    referrerpolicy: 'no-referrer', width: String(w), height: String(ht),
  });
  if (onLoad) img.addEventListener('load', onLoad);
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'gif-gone muted small' }, '🎞️ GIF indisponível')));
  return h('div', { class: `gif-msg${pending ? ' pending' : ''}`, style: `width:${w}px;max-width:100%` },
    img,
    h('span', { class: 'gif-badge', 'aria-hidden': 'true' }, 'GIF'),
    currentUserId && !pending ? starBtn(gif, currentUserId, (on) => toast(on ? '⭐ GIF nos favoritos.' : 'GIF tirado dos favoritos.')) : null);
}
