// Silenciar servidor/canal, caixa de menções (🔔), troca rápida (Ctrl+K), galeria do canal,
// modo lento, webhooks e e-mail da conta.
import { h, api, toast, openDialog, openMenu, avatar, fullTime, formatSize, copyText, closePopover } from './util.js';
import { state, P, can, dmName } from './state.js';
import { serverIcon } from './settings.js';

let hooks = {
  rerender: () => {}, renderRail: () => {}, renderHeader: () => {}, renderComposer: () => {},
  selectServer: () => {}, selectChannel: () => {}, goHome: () => {}, openDm: () => {}, jumpTo: () => {},
};
export function initAvisos(h0) { hooks = { ...hooks, ...h0 }; }

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ================================================================ Silenciar

const settings = new Map(); // target -> { level, mutedUntil }
let muteTimer = null;

export async function loadNotify() {
  try {
    const { settings: list } = await api('/me/notify');
    settings.clear();
    list.forEach((s) => settings.set(s.target, s));
  } catch { /* sem preferências */ }
  scheduleUnmute();
  hooks.rerender();
}

export function onNotifyChanged({ setting }) {
  if (!setting.level && !setting.mutedUntil) settings.delete(setting.target);
  else settings.set(setting.target, setting);
  scheduleUnmute();
  hooks.rerender();
}

// Quando um "silenciar por 8 h" acaba, redesenha.
function scheduleUnmute() {
  clearTimeout(muteTimer);
  const next = [...settings.values()].map((s) => (s.mutedUntil ? new Date(s.mutedUntil).getTime() : 0)).filter((t) => t > Date.now()).sort((a, b) => a - b)[0];
  if (next && next - Date.now() < 2 ** 31) muteTimer = setTimeout(() => hooks.rerender(), next - Date.now() + 500);
}

const isMuted = (s) => !!(s && s.mutedUntil && new Date(s.mutedUntil).getTime() > Date.now());

// O que vale para este canal: { muted, level }.
export function effectiveNotify(serverId, channelId, parentId = null) {
  const ch = settings.get(`c:${channelId}`) || (parentId ? settings.get(`c:${parentId}`) : null);
  const sv = serverId ? settings.get(`s:${serverId}`) : null;
  const muted = isMuted(ch) || isMuted(sv);
  const level = (ch && ch.level) || (sv && sv.level) || (serverId ? 'mentions' : 'all');
  return { muted, level: muted ? 'none' : level };
}
export const serverMuted = (serverId) => isMuted(settings.get(`s:${serverId}`));
export const channelMuted = (channelId) => isMuted(settings.get(`c:${channelId}`));

function untilLabel(s) {
  if (!isMuted(s)) return '';
  const d = new Date(s.mutedUntil);
  if (d.getFullYear() > 2900) return 'até você reativar';
  return `até ${fullTime(d).replace(/^Hoje às /, '')}`;
}

// Janela "Notificações de …" (servidor, canal ou conversa).
export function notifyDialog({ serverId = null, channelId = null, title }) {
  const target = channelId ? `c:${channelId}` : `s:${serverId}`;
  const isDm = !!channelId && !serverId;
  const body = h('div', { class: 'notify-dialog' });
  const save = async (changes) => {
    try {
      const { setting } = await api('/me/notify', { method: 'PUT', body: { ...(channelId ? { channelId } : { serverId }), ...changes } });
      onNotifyChanged({ setting });
      draw();
    } catch (err) { toast(err.message); }
  };
  const draw = () => {
    const s = settings.get(target) || {};
    const def = isDm ? 'all' : channelId ? 'server' : 'mentions';
    const level = s.level || (channelId && !isDm ? 'server' : def);
    const opt = (value, label, desc) => h('label', { class: `kind-option${level === value ? ' active' : ''}` },
      h('input', { type: 'radio', name: 'notify-level', value, checked: level === value, onchange: () => save({ level: value === 'server' ? null : value }) }),
      h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));
    const muteBtn = (minutes, label) => h('button', { class: 'btn small', dataset: { mute: String(minutes) }, onclick: () => save({ mute: minutes }) }, label);
    body.replaceChildren(
      isMuted(s)
        ? h('div', { class: 'muted-box' }, h('span', {}, `🔕 Silenciado ${untilLabel(s)}.`), h('button', { class: 'btn small primary', id: 'unmute-btn', onclick: () => save({ mute: 0 }) }, '🔔 Reativar'))
        : h('div', {},
          h('p', { class: 'muted small' }, 'Silenciar: não toca, não avisa e não acende (você ainda pode entrar e ler).'),
          h('div', { class: 'row-actions mute-times' }, muteBtn(15, '15 min'), muteBtn(60, '1 hora'), muteBtn(480, '8 horas'), muteBtn(1440, '24 horas'), muteBtn(-1, 'Até eu reativar'))),
      h('h3', {}, 'Avisar quando…'),
      h('div', { class: 'kind-options notify-levels' },
        channelId && !isDm ? opt('server', 'Igual ao servidor', 'Segue o que você escolheu para o servidor.') : null,
        opt('all', 'Todas as mensagens', 'Avisa a cada mensagem nova.'),
        opt('mentions', 'Só menções', '@você, @everyone e respostas para você.'),
        opt('none', 'Nada', 'Nunca avisa (nem menção). O número vermelho também some.')));
  };
  draw();
  openDialog({ title: title || '🔔 Notificações', body, actions: [{ label: 'Pronto', kind: 'primary' }] });
}

// Ícone no cabeçalho só quando o canal está silenciado ou em "Nada" (o resto fica no menu ⋯).
export function notifyHeaderButton({ serverId, channelId, parentId, label }) {
  const e = effectiveNotify(serverId, channelId, parentId);
  if (!e.muted && e.level !== 'none') return null;
  const own = settings.get(`c:${channelId}`);
  return h('button', {
    class: 'icon-btn notify-btn off', id: 'btn-notify',
    title: e.muted ? `Silenciado ${untilLabel(own) || '(pelo servidor)'}` : 'Notificações: nada',
    onclick: () => notifyDialog({ serverId, channelId, title: `🛎️ Notificações de ${label}` }),
  }, e.muted ? '🔕' : '🔇');
}

// ================================================================ Caixa de menções (🔔)

let inboxCount = 0;
export function setInboxCount(n) {
  inboxCount = Math.max(0, n);
  const slot = document.querySelector('#btn-inbox .badge-slot');
  if (slot) slot.replaceChildren(...(inboxCount ? [h('span', { class: 'badge' }, inboxCount > 99 ? '99+' : String(inboxCount))] : []));
}
export async function loadInboxCount() {
  try { setInboxCount((await api('/me/mentions/count')).unread); } catch { /* ignora */ }
}
// Mensagem nova chegou: conta na caixa se for para mim.
export function inboxNoticeMessage(msg) {
  if (!state.me || msg.author.id === state.me.id || msg.kind !== 'default') return;
  const direct = msg.mentions.includes(state.me.id);
  if (direct || (msg.mentionEveryone && msg.serverId)) setInboxCount(inboxCount + 1);
}

const REASON = { mention: '@ menção', reply: '↩️ resposta', everyone: '📢 @everyone' };

export function openInbox(anchor) {
  const ui = { items: [], hasMore: false, loading: true, filter: 'all' };
  const list = h('div', { class: 'inbox-list' });
  const draw = () => {
    const shown = ui.items.filter((x) => ui.filter === 'all' || x.reason !== 'everyone');
    list.replaceChildren(
      ...(ui.loading && !ui.items.length ? [h('p', { class: 'muted inbox-empty' }, 'Carregando…')] : []),
      ...(!ui.loading && !shown.length ? [h('p', { class: 'muted inbox-empty' }, '📭 Nenhuma menção por aqui.')] : []),
      ...shown.map((x) => {
        const m = x.message;
        const where = x.server ? `${x.server.name} › ${x.channel.parentName ? `${x.channel.parentName} › ` : '#'}${x.channel.name}` : 'Mensagem direta';
        return h('button', {
          class: `inbox-item${x.unread ? ' unread' : ''}`,
          dataset: { id: m.id },
          onclick: () => { closePopover(); hooks.jumpTo({ serverId: x.server ? x.server.id : null, channelId: m.channelId, messageId: m.id }); },
        },
        avatar(m.author, { size: 'sm' }),
        h('span', { class: 'inbox-body' },
          h('span', { class: 'inbox-top' }, h('strong', {}, m.author.displayName), h('span', { class: 'inbox-reason' }, REASON[x.reason] || ''), h('span', { class: 'muted small' }, fullTime(new Date(m.createdAt)))),
          h('span', { class: 'muted small truncate' }, where),
          h('span', { class: 'inbox-text' }, (m.content || (m.attachments.length ? '📎 Anexo' : m.gif ? '🎞️ GIF' : '')).slice(0, 200))));
      }),
      ...(ui.hasMore ? [h('button', { class: 'btn small inbox-more', onclick: () => load(true) }, 'Ver mais antigas')] : []));
  };
  const load = async (more = false) => {
    ui.loading = true; draw();
    try {
      const last = ui.items.at(-1);
      const res = await api(`/me/mentions${more && last ? `?before=${last.message.id}` : ''}`);
      ui.items = more ? [...ui.items, ...res.items] : res.items;
      ui.hasMore = res.hasMore;
      // Abriu a caixa: marca tudo como visto (a lista continua mostrando quais eram novas).
      if (!more && res.items[0]) api('/me/mentions/seen', { method: 'POST', body: { id: res.items[0].message.id } }).then(() => setInboxCount(0)).catch(() => {});
    } catch (err) { toast(err.message); }
    ui.loading = false; draw();
  };
  const tab = (key, label) => h('button', { class: `seg-btn${ui.filter === key ? ' active' : ''}`, onclick: () => { ui.filter = key; panel.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.k === key)); draw(); }, dataset: { k: key } }, label);
  const panel = h('div', { class: 'inbox' },
    h('div', { class: 'inbox-head' }, h('strong', {}, '🔔 Menções e respostas'), h('span', { class: 'seg' }, tab('all', 'Tudo'), tab('direct', 'Só para mim'))),
    list);
  draw();
  import('./util.js').then(({ openPopover }) => openPopover(anchor, panel, { align: 'end', className: 'inbox-pop' }));
  load();
}

// ================================================================ Troca rápida (Ctrl+K)

let switcherCache = null; // { at, channels }
export const forgetSwitcher = () => { switcherCache = null; };

async function switcherChannels() {
  if (switcherCache && Date.now() - switcherCache.at < 60000) return switcherCache.channels;
  const { channels } = await api('/me/switcher');
  switcherCache = { at: Date.now(), channels };
  return channels;
}

const kindIcon = (c) => (c.kind === 'voice' ? (c.stage ? '🎙️' : '🔊') : c.kind === 'forum' ? '💬' : c.kind === 'thread' ? '🧵' : c.announce ? '📢' : c.isClips ? '🎬' : '#');

function score(name, q) {
  const n = norm(name);
  if (!q) return 1;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - n.length / 100;
  const i = n.indexOf(q);
  if (i !== -1) return 60 - i / 10;
  // Iniciais/pedaços: "gr" acha "geral-rpg" (letras em ordem).
  let k = 0;
  for (const ch of n) if (ch === q[k]) k++;
  return k === q.length ? 20 - n.length / 100 : 0;
}

export function openSwitcher() {
  if (document.querySelector('.switcher')) return;
  const input = h('input', { class: 'switcher-input', placeholder: 'Para onde? Canal, servidor ou pessoa…', 'aria-label': 'Ir para', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'switcher-list', role: 'listbox' });
  const hint = h('p', { class: 'muted small switcher-hint' }, 'Dica: comece com # para canais, @ para pessoas, * para servidores. ↑↓ para escolher, Enter para ir.');
  let channels = [];
  let results = [];
  let sel = 0;
  const serverName = (id) => (state.servers.find((s) => s.id === id) || {}).name || '';
  const go = (r) => { dlg.close(); r.go(); };
  const build = () => {
    let q = norm(input.value.trim());
    let only = null;
    if (/^[#@*]/.test(q)) { only = q[0]; q = q.slice(1).trim(); }
    const items = [];
    if (!only || only === '#') {
      for (const c of channels) {
        if (c.kind === 'thread' && !q) continue;
        const s = score(c.name, q);
        if (s) items.push({ s: s + (c.serverId === state.view ? 5 : 0), icon: kindIcon(c), label: c.name, sub: serverName(c.serverId), go: () => (state.view === c.serverId ? hooks.selectChannel(c.id) : hooks.selectServer(c.serverId, c.id)) });
      }
    }
    if (!only || only === '@') {
      const seen = new Set();
      for (const d of state.dms) {
        const name = dmName(d);
        const s = Math.max(score(name, q), d.user ? score(d.user.username, q) : 0);
        if (d.user) seen.add(d.user.id);
        if (s) items.push({ s: s + 3, avatar: d.isGroup ? null : d.user, icon: d.isGroup ? '👥' : null, label: name, sub: d.isGroup ? 'Grupo' : `@${d.user.username}`, go: () => hooks.goHome(d.channelId) });
      }
      for (const f of state.friends.friends || []) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const s = Math.max(score(f.displayName, q), score(f.username, q));
        if (s) items.push({ s, avatar: f, label: f.displayName, sub: `@${f.username} · amigo`, go: () => hooks.openDm(f.id) });
      }
      // Gente do servidor aberto (só quando digitou algo, para a lista não encher).
      if (q && state.view !== 'home' && state.detail) {
        for (const m of state.detail.members || []) {
          if (seen.has(m.id) || m.id === state.me.id || m.isBot) continue;
          const s = Math.max(score(m.displayName, q), score(m.username, q));
          if (s) items.push({ s: s - 2, avatar: m, label: m.displayName, sub: `@${m.username} · ${state.detail.server.name}`, go: () => hooks.openDm(m.id) });
        }
      }
    }
    if (!only || only === '*') {
      for (const s0 of state.servers) {
        const s = score(s0.name, q);
        if (s) items.push({ s: s + 4, server: s0, label: s0.name, sub: 'Servidor', go: () => hooks.selectServer(s0.id) });
      }
    }
    results = items.sort((a, b) => b.s - a.s).slice(0, 40);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(...(results.length ? results.map((r, i) => h('button', {
      class: `switcher-item${i === sel ? ' sel' : ''}`, role: 'option', 'aria-selected': i === sel ? 'true' : 'false',
      onmousemove: () => { if (sel !== i) { sel = i; build(); } },
      onclick: () => go(r),
    },
    r.server ? serverIcon(r.server, 'mini') : r.avatar ? avatar(r.avatar, { size: 'xs' }) : h('span', { class: 'switcher-icon' }, r.icon),
    h('span', { class: 'truncate' }, r.label),
    h('span', { class: 'muted small truncate switcher-sub' }, r.sub))) : [h('p', { class: 'muted switcher-empty' }, 'Nada encontrado.')]));
    const el = list.querySelector('.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; build(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); build(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); build(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) go(results[sel]); }
  });
  const dlg = h('dialog', { class: 'switcher' }, h('div', { class: 'switcher-box' }, input, list, hint));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
  build();
  switcherChannels().then((c) => { channels = c; build(); }).catch(() => {});
}

// ================================================================ Galeria do canal

export function openGallery(channelId, label) {
  const ui = { type: 'media', items: [], hasMore: false, loading: false };
  const grid = h('div', { class: 'gallery' });
  const load = async (more = false) => {
    ui.loading = true; draw();
    try {
      const last = ui.items.at(-1);
      const res = await api(`/channels/${channelId}/media?type=${ui.type}${more && last ? `&before=${last.messageId}` : ''}`);
      ui.items = more ? [...ui.items, ...res.items] : res.items;
      ui.hasMore = res.hasMore;
    } catch (err) { toast(err.message); }
    ui.loading = false; draw();
  };
  const jump = (x) => { dlgCtl.close(); hooks.jumpTo({ serverId: state.view === 'home' ? null : state.view, channelId, messageId: x.messageId }); };
  const draw = () => {
    const media = ui.type === 'media';
    grid.className = `gallery ${media ? 'media' : 'files'}`;
    grid.replaceChildren(...[
      ...ui.items.map((x) => {
        const a = x.attachment;
        const meta = h('span', { class: 'gal-meta muted small' }, `${x.author ? x.author.displayName : '—'} · ${fullTime(new Date(x.createdAt))}`);
        if (media) {
          return h('figure', { class: 'gal-item' },
            a.kind === 'video'
              ? h('video', { src: a.url, controls: true, preload: 'metadata' })
              : h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, h('img', { src: a.url, alt: a.filename, loading: 'lazy' })),
            h('figcaption', {}, meta, h('button', { class: 'link small', onclick: () => jump(x) }, 'ver na conversa')));
        }
        return h('div', { class: 'gal-file' },
          h('span', { class: 'att-icon' }, a.kind === 'audio' ? '🎵' : '📄'),
          h('span', { class: 'gal-file-info' }, h('a', { href: a.url, download: a.filename, class: 'truncate' }, a.filename), h('span', { class: 'muted small' }, `${formatSize(a.size)} · `, meta)),
          h('button', { class: 'btn small', onclick: () => jump(x) }, 'Ver'));
      }),
      !ui.loading && !ui.items.length ? h('p', { class: 'muted gal-empty' }, media ? 'Nenhuma foto ou vídeo neste canal ainda.' : 'Nenhum arquivo neste canal ainda.') : null,
      ui.loading ? h('p', { class: 'muted gal-empty' }, 'Carregando…') : null,
      ui.hasMore && !ui.loading ? h('button', { class: 'btn small gal-more', onclick: () => load(true) }, 'Carregar mais') : null].filter(Boolean));
  };
  const tabs = h('div', { class: 'seg' },
    h('button', { class: 'seg-btn active', dataset: { t: 'media' }, onclick: () => setType('media') }, '🖼️ Fotos e vídeos'),
    h('button', { class: 'seg-btn', dataset: { t: 'files' }, onclick: () => setType('files') }, '📄 Arquivos'));
  const setType = (t) => { ui.type = t; ui.items = []; tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.t === t)); load(); };
  const dlgCtl = openDialog({ title: `🖼️ Galeria · ${label}`, body: h('div', { class: 'gallery-panel' }, tabs, grid), wide: true, actions: [{ label: 'Fechar' }] });
  load();
}

// ================================================================ Modo lento

export const SLOW_OPTIONS = [[0, 'Desligado'], [5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'], [3600, '1 h'], [7200, '2 h'], [21600, '6 h']];
export const slowLabel = (s) => (SLOW_OPTIONS.find(([v]) => v === s) || [0, `${s} s`])[1];
export const slowExempt = () => can(P.MANAGE_MESSAGES) || can(P.MANAGE_CHANNELS);

const lastSent = new Map(); // canal -> horário do envio (deste aparelho)
let slowTick = null;
export function noteSent(channel) { if (channel && channel.slowmode && !slowExempt()) lastSent.set(channel.id, Date.now()); }
export function slowWaitLeft(channel) {
  if (!channel || !channel.slowmode || slowExempt()) return 0;
  const t = lastSent.get(channel.id);
  return t ? Math.max(0, Math.ceil((t + channel.slowmode * 1000 - Date.now()) / 1000)) : 0;
}
// Servidor recusou ("espere 12 s"): sincroniza o relógio daqui.
export function noteSlowError(channel, message) {
  const m = /espere (?:(\d+) min)? ?(?:(\d+) s)?/.exec(message || '');
  if (!channel || !m) return;
  const left = (Number(m[1] || 0) * 60) + Number(m[2] || 0);
  lastSent.set(channel.id, Date.now() - (channel.slowmode - left) * 1000);
}

// Faixa acima da caixa de texto: "🐢 Modo lento: 30 s" ou "🐢 Espere 12 s".
export function renderSlowBar(channel) {
  let bar = document.getElementById('slow-bar');
  const show = !!(channel && channel.kind === 'text' && channel.slowmode);
  if (!show) { if (bar) bar.remove(); clearInterval(slowTick); slowTick = null; return; }
  if (!bar) {
    bar = h('div', { id: 'slow-bar', class: 'slow-bar' });
    const area = document.getElementById('composer-area');
    area.insertBefore(bar, document.getElementById('composer'));
  }
  const paint = () => {
    const left = slowWaitLeft(channel);
    bar.classList.toggle('waiting', left > 0);
    bar.textContent = slowExempt()
      ? `🐢 Modo lento: ${slowLabel(channel.slowmode)} (a moderação não precisa esperar)`
      : left > 0 ? `🐢 Modo lento: espere ${left >= 60 ? `${Math.floor(left / 60)} min ${left % 60} s` : `${left} s`}` : `🐢 Modo lento: uma mensagem a cada ${slowLabel(channel.slowmode)}`;
    if (!left && slowTick && !slowExempt()) { clearInterval(slowTick); slowTick = null; hooks.renderComposer(); }
  };
  paint();
  clearInterval(slowTick);
  slowTick = slowWaitLeft(channel) > 0 ? setInterval(paint, 1000) : null;
}

// Menu do modo lento (moderação): escolher o tempo.
export function slowMenu(anchor, channel) {
  openMenu(anchor, SLOW_OPTIONS.map(([v, label]) => ({
    label: `${channel.slowmode === v ? '● ' : ''}${v ? `🐢 ${label}` : 'Desligado'}`,
    onClick: async () => {
      try { await api(`/channels/${channel.id}/slowmode`, { method: 'PUT', body: { seconds: v } }); toast(v ? `🐢 Modo lento ligado: ${label}.` : 'Modo lento desligado.'); } catch (err) { toast(err.message); }
    },
  })), { align: 'end', className: 'popover-menu slow-menu' });
}

// 🐢 no cabeçalho: só quando o modo lento está ligado.
export function slowHeaderButton(channel) {
  if (!channel || channel.kind !== 'text' || !channel.slowmode) return null;
  const mod = slowExempt();
  return h('button', {
    class: 'icon-btn slow-btn on', id: 'btn-slow',
    title: `Modo lento: ${slowLabel(channel.slowmode)}${mod ? ' (clique para mudar)' : ''}`,
    onclick: (e) => (mod ? slowMenu(e.currentTarget, channel) : toast(`🐢 Modo lento: cada pessoa manda uma mensagem a cada ${slowLabel(channel.slowmode)}.`)),
  }, '🐢', h('span', { class: 'disappear-label' }, slowLabel(channel.slowmode)));
}

// ================================================================ Webhooks (configurações do servidor)

export function renderWebhooks(rerender) {
  const d = state.detail;
  const page = h('div', { class: 'settings-page' }, h('h2', {}, 'Webhooks'), h('p', { class: 'muted' }, 'Carregando…'));
  const texts = d.channels.filter((c) => c.kind === 'text');
  const showUrl = (url, title) => {
    const input = h('input', { readonly: true, value: url, class: 'cal-link', id: 'webhook-url', onclick: (e) => e.target.select() });
    openDialog({
      title,
      body: h('div', { class: 'cal-link-box' },
        h('p', {}, 'Este é o link secreto. ', h('strong', {}, 'Ele aparece só agora'), ': copie e guarde (por exemplo, como credencial no Jenkins).'),
        h('div', { class: 'row-actions' }, input, h('button', { class: 'btn primary small', onclick: () => copyText(input.value, input).then((ok) => toast(ok ? 'Link copiado!' : 'Selecione e copie (Ctrl+C).')) }, 'Copiar')),
        h('p', { class: 'muted small' }, 'Para testar no terminal:'),
        h('pre', { class: 'code-sample' }, `curl -H "Content-Type: application/json" \\\n  -d '{"content":"Olá do webhook! ✅"}' \\\n  "COLE_O_LINK_AQUI"`),
        h('p', { class: 'muted small' }, '🔒 Quem tiver o link consegue postar no canal. Se vazar, gere um link novo.')),
      actions: [{ label: 'Pronto', kind: 'primary' }],
    });
  };
  const draw = (hooksList) => {
    const name = h('input', { maxlength: '32', placeholder: 'Ex.: Jenkins, Alertas da VM', id: 'webhook-name' });
    const ch = h('select', { id: 'webhook-channel' }, texts.map((c) => h('option', { value: String(c.id) }, `# ${c.name}`)));
    page.replaceChildren(
      h('h2', {}, 'Webhooks'),
      h('p', { class: 'muted' }, 'Um webhook é um link secreto que outros sistemas usam para postar num canal: o Jenkins avisando "deploy feito ✅", alertas da VM, etc. As mensagens aparecem com o nome do webhook.'),
      h('div', { class: 'settings-block' },
        h('h3', {}, 'Novo webhook'),
        h('div', { class: 'webhook-new' }, name, ch,
          h('button', {
            class: 'btn primary', id: 'webhook-create',
            onclick: async () => {
              try {
                const res = await api(`/servers/${d.server.id}/webhooks`, { method: 'POST', body: { name: name.value, channelId: Number(ch.value) } });
                showUrl(res.url, `🔗 Webhook "${res.webhook.name}" criado`);
                rerender();
              } catch (err) { toast(err.message); }
            },
          }, 'Criar'))),
      h('div', { class: 'settings-block' },
        h('h3', {}, `Webhooks deste servidor (${hooksList.length})`),
        hooksList.length ? h('div', { class: 'webhook-list' }, hooksList.map((w) => h('div', { class: 'webhook-row', dataset: { id: String(w.id) } },
          h('div', { class: 'avatar sm' }, '🔗'),
          h('div', { class: 'webhook-info' },
            h('strong', {}, w.name),
            h('span', { class: 'muted small' }, `# ${w.channelName} · ${w.uses} ${w.uses === 1 ? 'mensagem' : 'mensagens'}${w.lastUsedAt ? ` · última ${fullTime(new Date(w.lastUsedAt))}` : ' · nunca usado'}${w.createdBy ? ` · criado por ${w.createdBy.displayName}` : ''}`)),
          h('button', {
            class: 'icon-btn', title: 'Opções',
            onclick: (e) => openMenu(e.currentTarget, [
              { label: '✏️  Renomear', onClick: () => import('./util.js').then(({ ask }) => ask({ title: 'Renomear webhook', value: w.name, maxLength: 32, okLabel: 'Salvar', onSubmit: async (v) => { await api(`/webhooks/${w.id}`, { method: 'PATCH', body: { name: v } }); rerender(); } })) },
              ...texts.filter((c) => c.id !== w.channelId).slice(0, 15).map((c) => ({ label: `↪️  Postar em #${c.name}`, onClick: async () => { try { await api(`/webhooks/${w.id}`, { method: 'PATCH', body: { channelId: c.id } }); rerender(); } catch (err) { toast(err.message); } } })),
              { label: '🔄  Gerar link novo (o antigo para)', onClick: async () => { try { const res = await api(`/webhooks/${w.id}`, { method: 'PATCH', body: { rotate: true } }); showUrl(res.url, `🔗 Link novo de "${w.name}"`); } catch (err) { toast(err.message); } } },
              { separator: true },
              { label: '🗑️  Apagar', danger: true, onClick: () => import('./util.js').then(({ confirmDialog }) => confirmDialog({ title: `Apagar "${w.name}"?`, text: 'O link para de funcionar na hora. As mensagens antigas continuam.', okLabel: 'Apagar', onConfirm: async () => { await api(`/webhooks/${w.id}`, { method: 'DELETE' }); rerender(); } })) },
            ], { align: 'end', className: 'popover-menu' }),
          }, '⋯'))))
          : h('p', { class: 'muted' }, 'Nenhum webhook ainda.')),
      h('div', { class: 'settings-block' },
        h('h3', {}, 'Como usar'),
        h('p', { class: 'muted small' }, 'Mande um POST para o link com {"content": "texto"} (JSON) ou só o texto puro. Até 30 mensagens por minuto. Menções a @pessoas funcionam; @everyone não.'),
        h('p', { class: 'muted small' }, 'Jenkins: guarde o link como credencial "Secret text" com o ID nexo-webhook (veja docs/webhooks.md).')));
  };
  api(`/servers/${d.server.id}/webhooks`).then(({ webhooks }) => draw(webhooks)).catch((err) => toast(err.message));
  return page;
}

// ================================================================ E-mail da conta

export function emailBlock({ applyMe, rerender }) {
  const me = state.me;
  const enabled = state.config && state.config.emailEnabled;
  const box = h('div', { class: 'settings-block email-block' }, h('h3', {}, '📧 E-mail'));
  if (!enabled) {
    box.append(h('p', { class: 'muted' }, 'O envio de e-mail não está ligado neste Nexo (quem administra pode ligar: veja docs/email.md).'));
    return box;
  }
  const verify = () => {
    const code = h('input', { inputmode: 'numeric', maxlength: '7', placeholder: '123456', id: 'email-code', autocomplete: 'one-time-code' });
    openDialog({
      title: 'Confirmar e-mail', text: `Digite o código que mandamos para ${state.me.emailNew}.`, body: code,
      actions: [
        { label: 'Mandar de novo', onClick: async () => { await api('/me/email/resend', { method: 'POST' }); toast('Código enviado de novo.'); return false; } },
        { label: 'Confirmar', kind: 'primary', submit: true, onClick: async () => { const { user } = await api('/me/email/verify', { method: 'POST', body: { code: code.value } }); applyMe(user); toast('E-mail confirmado! ✅'); rerender(); } },
      ],
    });
  };
  const change = () => {
    const email = h('input', { type: 'email', maxlength: '120', placeholder: 'voce@exemplo.com', id: 'email-new', autocomplete: 'email' });
    const pass = h('input', { type: 'password', placeholder: 'Sua senha', id: 'email-pass', autocomplete: 'current-password' });
    openDialog({
      title: me.email ? 'Trocar e-mail' : 'Adicionar e-mail',
      text: 'Vamos mandar um código de 6 dígitos para confirmar. O e-mail serve para recuperar a senha.',
      body: h('div', { class: 'stack' }, email, pass),
      actions: [
        { label: 'Cancelar' },
        { label: 'Mandar código', kind: 'primary', submit: true, onClick: async () => {
          const res = await api('/me/email', { method: 'POST', body: { email: email.value, password: pass.value } });
          state.me.emailNew = res.emailNew;
          rerender();
          setTimeout(verify, 50);
        } },
      ],
    });
  };
  box.append(
    me.email ? h('p', {}, '✅ ', h('strong', {}, me.email), h('span', { class: 'muted' }, ' (confirmado)')) : h('p', { class: 'muted' }, 'Nenhum e-mail confirmado. Com um e-mail, você recupera a senha sozinho ("Esqueci a senha" → código por e-mail).'),
    me.emailNew ? h('p', { class: 'muted' }, `⏳ Esperando confirmação: ${me.emailNew} `, h('button', { class: 'link', onclick: verify }, 'digitar o código')) : null,
    h('div', { class: 'row-actions' },
      h('button', { class: me.email ? 'btn' : 'btn primary', id: 'email-change', onclick: change }, me.email ? 'Trocar e-mail' : 'Adicionar e-mail'),
      me.email && !me.emailPending ? h('button', {
        class: 'btn danger-ghost',
        onclick: () => {
          const pass = h('input', { type: 'password', placeholder: 'Sua senha', autocomplete: 'current-password' });
          openDialog({ title: 'Tirar o e-mail?', text: 'Sem e-mail, só a chave de recuperação ou a administração ajudam se você esquecer a senha.', body: pass, actions: [{ label: 'Cancelar' }, { label: 'Tirar', kind: 'danger', submit: true, onClick: async () => { await api('/me/email', { method: 'DELETE', body: { password: pass.value } }); applyMe((await api('/me')).user); rerender(); } }] });
        },
      }, 'Tirar e-mail') : null));
  return box;
}
