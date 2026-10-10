// Nexo — frontend (Fase 2). JavaScript puro em módulos, sem etapa de build.
import {
  $, h, storage, api, setToken, setUnauthorizedHandler, uploadFile, formatTime, dayLabel, fullTime,
  formatSize, avatar, badge, toast, copyText, openDialog, ask, confirmDialog, openPopover,
  closePopover, openMenu, playPing, hueFor,
} from './util.js';
import { openEmojiPicker } from './emoji.js';
import {
  state, P, can, isOwner, myTop, memberById, memberRoles, memberTop, roleColor, knownUsers,
  currentDm, currentChannel,
} from './state.js';
import { renderFriendsPage } from './home.js';
import { openServerSettings, refreshSettings, closeServerSettings } from './settings.js';

const isVisible = () => document.visibilityState === 'visible';
let tempSeq = 0;

// Executa no máximo uma vez a cada "ms" (junta vários eventos seguidos em um).
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ================================================================ Login / cadastro

let authMode = 'login';

function showAuth(mode = 'login') {
  authMode = mode;
  const register = mode === 'register';
  const invite = sessionStorage.getItem('nexo.pendingInvite');
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth-title').textContent = register ? 'Crie sua conta' : 'Bem-vindo de volta';
  $('#auth-subtitle').textContent = invite
    ? 'Entre ou crie uma conta para aceitar o convite.'
    : register ? 'Leva menos de um minuto.' : 'Entre para continuar a conversa.';
  $('#display-name-field').hidden = !register;
  $('#auth-submit').textContent = register ? 'Cadastrar' : 'Entrar';
  $('#auth-switch-text').textContent = register ? 'Já tem conta?' : 'Não tem conta?';
  $('#auth-switch').textContent = register ? 'Entrar' : 'Cadastre-se';
  $('#auth-form [name=password]').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  $('#auth-form [name=username]').focus();
}

$('#auth-switch').addEventListener('click', () => showAuth(authMode === 'login' ? 'register' : 'login'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('#auth-submit');
  const body = { username: form.username.value.trim().toLowerCase(), password: form.password.value };
  if (authMode === 'register') body.displayName = form.displayName.value.trim();
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const data = await api(`/auth/${authMode}`, { method: 'POST', body });
    state.token = data.token;
    setToken(data.token);
    storage('nexo.token', data.token);
    form.reset();
    start(data.user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function logout() {
  storage('nexo.token', null);
  if (state.socket) state.socket.disconnect();
  closeServerSettings();
  closePopover();
  Object.assign(state, {
    token: null, me: null, socket: null, servers: [], view: 'home', detail: null, channelId: null,
    dms: [], friends: { friends: [], incoming: [], outgoing: [] }, editingId: null,
  });
  setToken(null);
  state.messages.clear();
  state.typing.clear();
  clearUploads();
  document.title = 'Nexo';
  showAuth('login');
}

setUnauthorizedHandler(logout);

// ================================================================ Início

async function boot() {
  // Link de convite: /convite/CODIGO
  const m = /^\/convite\/([\w-]{4,32})\/?$/.exec(location.pathname);
  if (m) sessionStorage.setItem('nexo.pendingInvite', m[1]);
  if (m || location.pathname !== '/') history.replaceState(null, '', '/');

  if (!state.token) return showAuth('login');
  setToken(state.token);
  try {
    const { user } = await api('/me');
    start(user);
  } catch {
    logout();
  }
}

async function start(user) {
  state.me = user;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  renderUserPanel();
  if (storage('nexo.hideMembers') === '1') $('#app').classList.add('no-members');

  connectSocket();
  await Promise.all([loadServers(), loadDms(), loadFriends()]);

  const savedView = storage('nexo.view');
  const savedServer = state.servers.find((s) => String(s.id) === savedView);
  if (savedServer) await selectServer(savedServer.id);
  else {
    const homeChannel = Number(storage('nexo.homeChannel'));
    await goHome(state.dms.some((d) => d.channelId === homeChannel) ? homeChannel : null);
  }

  const invite = sessionStorage.getItem('nexo.pendingInvite');
  if (invite) {
    sessionStorage.removeItem('nexo.pendingInvite');
    showInvitePreview(invite);
  }
}

// ================================================================ Carregar dados

async function loadServers() {
  const { servers } = await api('/servers');
  state.servers = servers;
  syncServerFromDetail();
  renderRail();
  updateTitle();
}

async function loadDms() {
  const { dms } = await api('/dms');
  state.dms = dms;
  renderRail();
  if (state.view === 'home') { renderSidebar(); renderHeader(); }
  updateTitle();
}

async function loadFriends() {
  state.friends = await api('/friends');
  renderRail();
  if (state.view === 'home') { renderSidebar(); if (!state.channelId) renderMain(); }
}

async function refreshDetail() {
  if (state.view === 'home') return;
  const serverId = state.view;
  let detail;
  try {
    detail = await api(`/servers/${serverId}`);
  } catch {
    return; // provavelmente fomos removidos; o evento server:removed cuida disso
  }
  if (state.view !== serverId) return;
  state.detail = detail;
  state.detailVersion++;
  syncServerFromDetail();
  if (!detail.channels.some((c) => c.id === state.channelId)) {
    const first = detail.channels[0];
    if (first) return selectChannel(first.id);
  }
  renderAll();
  refreshSettings();
}

const refreshDetailSoon = debounce(refreshDetail, 150);
const loadServersSoon = debounce(() => loadServers().catch(() => {}), 300);
const loadFriendsSoon = debounce(() => loadFriends().catch(() => {}), 200);

// O servidor aberto tem a contagem exata (por canal); copia para a lista do trilho.
function syncServerFromDetail() {
  if (state.view === 'home' || !state.detail) return;
  const s = state.servers.find((x) => x.id === state.detail.server.id);
  if (!s) return;
  s.name = state.detail.server.name;
  s.unread = state.detail.channels.some((c) => c.unread);
  s.mentions = state.detail.channels.reduce((n, c) => n + (c.mentions || 0), 0);
}

// ================================================================ Tempo real

function connectSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  let connectedBefore = false;

  socket.on('connect', () => {
    $('#conn-status').hidden = true;
    if (connectedBefore) refreshAfterReconnect();
    connectedBefore = true;
  });
  socket.on('disconnect', () => { $('#conn-status').hidden = false; });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout();
    else $('#conn-status').hidden = false;
  });

  socket.on('message:new', onMessageNew);
  socket.on('message:updated', (msg) => updateMessage(msg.channelId, msg.id, msg));
  socket.on('message:reactions', ({ id, channelId, reactions }) => updateMessage(channelId, id, { reactions }));
  socket.on('message:deleted', ({ id, channelId }) => {
    const bucket = state.messages.get(channelId);
    if (!bucket) return;
    bucket.items = bucket.items.filter((m) => m.id !== id);
    if (state.editingId === id) state.editingId = null;
    if (channelId === state.channelId) renderMessages();
  });

  socket.on('channel:read', ({ channelId }) => {
    clearLocalUnread(channelId);
    renderBadges();
  });

  socket.on('server:changed', ({ serverId }) => {
    if (serverId === state.view) refreshDetailSoon();
    loadServersSoon();
  });

  socket.on('server:removed', ({ serverId, reason }) => {
    const s = state.servers.find((x) => x.id === serverId);
    state.servers = state.servers.filter((x) => x.id !== serverId);
    if (s && reason === 'kicked') toast(`Você foi expulso de "${s.name}".`);
    if (s && reason === 'deleted') toast(`O servidor "${s.name}" foi apagado.`);
    if (state.view === serverId) {
      closeServerSettings();
      goHome();
    } else renderRail();
    updateTitle();
  });

  socket.on('friends:changed', () => { loadFriendsSoon(); loadDmsSoon(); });

  socket.on('presence', ({ userId, online }) => {
    const m = memberById(userId);
    if (m) m.online = online;
    for (const list of Object.values(state.friends)) list.forEach((f) => { if (f.id === userId) f.online = online; });
    state.dms.forEach((d) => { if (d.user.id === userId) d.user.online = online; });
    if (state.view === 'home') {
      renderSidebar();
      renderHeader();
      if (!state.channelId) renderMain();
    } else renderMembers();
  });

  socket.on('typing', ({ channelId, user }) => {
    if (user.id === state.me.id) return;
    if (!state.typing.has(channelId)) state.typing.set(channelId, new Map());
    const map = state.typing.get(channelId);
    const prev = map.get(user.id);
    if (prev) clearTimeout(prev.timer);
    map.set(user.id, {
      name: user.displayName,
      timer: setTimeout(() => { map.delete(user.id); renderTyping(); }, 3500),
    });
    renderTyping();
  });
}

const loadDmsSoon = debounce(() => loadDms().catch(() => {}), 200);

async function refreshAfterReconnect() {
  // Durante a queda podemos ter perdido mensagens: recarrega tudo que está aberto.
  state.messages.clear();
  await Promise.all([loadServers(), loadDms(), loadFriends()]).catch(() => {});
  if (state.view !== 'home') {
    if (state.servers.some((s) => s.id === state.view)) await selectServer(state.view, state.channelId);
    else goHome();
  } else if (state.channelId) {
    await selectChannel(state.channelId);
  }
}

function onMessageNew(msg) {
  const bucket = state.messages.get(msg.channelId);
  if (bucket && !bucket.items.some((m) => m.id === msg.id)) {
    const pending = msg.nonce && bucket.items.find((m) => m.nonce === msg.nonce && m.pending);
    if (pending) replaceTemp(bucket, pending, msg);
    else bucket.items.push(msg);
  }
  clearTyping(msg.channelId, msg.author.id);

  const mine = msg.author.id === state.me.id;
  const isDm = msg.serverId === null;
  const notify = !mine && (isDm || msg.mentionEveryone || msg.mentions.includes(state.me.id));
  const active = msg.channelId === state.channelId && isVisible();

  if (isDm) {
    const dm = state.dms.find((d) => d.channelId === msg.channelId);
    if (!dm) loadDms(); // conversa nova: o servidor já devolve a contagem certa
    else {
      dm.lastMessageAt = msg.createdAt;
      state.dms.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
    }
  }

  if (msg.channelId === state.channelId) renderMessages({ stick: mine ? 'always' : 'if-near' });

  if (active) scheduleMarkRead();
  else if (!mine) bumpUnread(msg, notify);

  if (notify && !active) notifyUser(msg);
  renderBadges();
}

function replaceTemp(bucket, temp, msg) {
  const i = bucket.items.indexOf(temp);
  if (i !== -1) bucket.items[i] = msg;
}

function updateMessage(channelId, id, changes) {
  const bucket = state.messages.get(channelId);
  const m = bucket && bucket.items.find((x) => x.id === id);
  if (!m) return;
  Object.assign(m, changes);
  m._v = (m._v || 0) + 1;
  if (channelId === state.channelId) renderMessages();
}

function bumpUnread(msg, notify) {
  if (msg.serverId === null) {
    const dm = state.dms.find((d) => d.channelId === msg.channelId);
    if (dm) { dm.unread = true; if (notify) dm.mentions++; }
  } else if (msg.serverId === state.view && state.detail) {
    const c = state.detail.channels.find((x) => x.id === msg.channelId);
    if (c) { c.unread = true; if (notify) c.mentions++; }
    syncServerFromDetail();
  } else {
    const s = state.servers.find((x) => x.id === msg.serverId);
    if (s) { s.unread = true; if (notify) s.mentions++; }
  }
}

function clearLocalUnread(channelId) {
  const dm = state.dms.find((d) => d.channelId === channelId);
  if (dm) { dm.unread = false; dm.mentions = 0; }
  const c = state.detail && state.detail.channels.find((x) => x.id === channelId);
  if (c) { c.unread = false; c.mentions = 0; syncServerFromDetail(); }
}

function notifyUser(msg) {
  if (state.soundOn) playPing();
  if ('Notification' in window && window.isSecureContext && Notification.permission === 'granted' && !isVisible()) {
    const where = msg.serverId === null ? 'mensagem direta' : 'menção';
    try { new Notification(`${msg.author.displayName} (${where})`, { body: msg.content.slice(0, 120) || '📎 Anexo' }); } catch { /* ignora */ }
  }
}

// ---------------------------------------------------------------- Marcar como lido

const lastReadSent = new Map();
let readTimer;
const scheduleMarkRead = () => { clearTimeout(readTimer); readTimer = setTimeout(markReadNow, 250); };

function markReadNow() {
  const channelId = state.channelId;
  if (!channelId || !isVisible()) return;
  const bucket = state.messages.get(channelId);
  const last = bucket && [...bucket.items].reverse().find((m) => !m.pending && !m.failed);
  clearLocalUnread(channelId);
  renderBadges();
  if (!last || !state.socket) return;
  const prev = lastReadSent.get(channelId);
  if (prev && BigInt(prev) >= BigInt(last.id)) return;
  lastReadSent.set(channelId, last.id);
  state.socket.emit('channel:read', { channelId, messageId: last.id });
}

document.addEventListener('visibilitychange', () => {
  if (isVisible() && state.me) scheduleMarkRead();
});

// ================================================================ Navegação

async function goHome(channelId = null) {
  state.view = 'home';
  state.detail = null;
  storage('nexo.view', 'home');
  closeServerSettings();
  if (channelId) return selectChannel(channelId);
  state.channelId = null;
  storage('nexo.homeChannel', null);
  state.editingId = null;
  clearUploads();
  $('#app').classList.remove('sidebar-open');
  renderAll();
}

async function selectServer(serverId, preferredChannelId) {
  state.view = serverId;
  storage('nexo.view', String(serverId));
  renderRail();
  let detail;
  try {
    detail = await api(`/servers/${serverId}`);
  } catch (err) {
    toast(err.message);
    return goHome();
  }
  if (state.view !== serverId) return; // clicou em outro no meio do caminho
  state.detail = detail;
  state.detailVersion++;
  syncServerFromDetail();

  const saved = preferredChannelId || Number(storage(`nexo.channel.${serverId}`));
  const channel = detail.channels.find((c) => c.id === saved) || detail.channels[0];
  if (channel) await selectChannel(channel.id);
  else { state.channelId = null; renderAll(); }
}

async function selectChannel(channelId) {
  if (state.channelId !== channelId) {
    state.editingId = null;
    clearUploads();
  }
  state.channelId = channelId;
  if (state.view === 'home') storage('nexo.homeChannel', String(channelId));
  else storage(`nexo.channel.${state.view}`, String(channelId));
  $('#app').classList.remove('sidebar-open');
  renderAll();

  const bucket = bucketFor(channelId);
  if (!bucket.loaded) {
    bucket.loaded = true;
    await loadOlder(channelId);
  }
  if (state.channelId === channelId) {
    renderMessages({ stick: 'always' });
    scheduleMarkRead();
    if (window.matchMedia('(min-width: 901px)').matches) $('#composer-input').focus();
  }
}

async function openDm(userId) {
  try {
    const { channelId, user } = await api('/dms', { method: 'POST', body: { userId } });
    if (!state.dms.some((d) => d.channelId === channelId)) {
      state.dms.unshift({ channelId, user, lastMessageAt: null, unread: false, mentions: 0 });
    }
    closePopover();
    await goHome(channelId);
  } catch (err) {
    toast(err.message);
  }
}

// ================================================================ Renderização geral

function renderAll() {
  renderRail();
  renderSidebar();
  renderHeader();
  renderMain();
  renderMembers();
  renderComposerState();
  renderTyping();
  updateTitle();
}

function renderBadges() {
  renderRail();
  renderSidebar();
  updateTitle();
}

function updateTitle() {
  const servers = state.servers.reduce((n, s) => n + (s.mentions || 0), 0);
  const dms = state.dms.reduce((n, d) => n + (d.mentions || 0), 0);
  const total = servers + dms;
  document.title = total ? `(${total}) Nexo` : 'Nexo';
}

function renderRail() {
  const homeCount = state.dms.reduce((n, d) => n + (d.mentions || 0), 0) + state.friends.incoming.length;
  const home = $('#home-btn');
  home.classList.toggle('active', state.view === 'home');
  home.querySelector('.badge-slot').replaceChildren(badge(homeCount) || '');

  $('#server-list').replaceChildren(...state.servers.map((s) => {
    const btn = h('button', {
      class: `rail-btn${s.id === state.view ? ' active' : ''}${s.unread ? ' unread' : ''}`,
      title: s.name,
      onclick: () => selectServer(s.id),
    }, initialsOf(s.name), h('span', { class: 'badge-slot' }, badge(s.mentions) || ''));
    return btn;
  }));
}

const initialsOf = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => [...p][0]).join('').toUpperCase();

// ---------------------------------------------------------------- Barra lateral

function renderSidebar() {
  const header = $('#sidebar-header');
  const body = $('#sidebar-body');

  if (state.view === 'home') {
    header.replaceChildren(h('span', { class: 'truncate' }, 'Mensagens diretas'));
    header.onclick = null;
    header.classList.remove('clickable');
    const pending = state.friends.incoming.length;
    body.replaceChildren(
      h('button', {
        class: `side-item${state.channelId === null ? ' active' : ''}`,
        onclick: () => goHome(),
      }, h('span', { class: 'side-icon' }, '👥'), h('span', { class: 'truncate' }, 'Amigos'), badge(pending)),
      h('div', { class: 'section-title' }, h('span', {}, 'Conversas'),
        h('button', { class: 'icon-btn small', title: 'Nova conversa', onclick: newDmDialog }, '+')),
      state.dms.length === 0
        ? h('p', { class: 'muted side-empty' }, 'Nenhuma conversa ainda. Abra uma pelo perfil de alguém ou pela lista de amigos.')
        : h('ul', { class: 'side-list' }, state.dms.map((d) => h('li', {},
          h('button', {
            class: `side-item dm${d.channelId === state.channelId ? ' active' : ''}${d.unread ? ' unread' : ''}`,
            onclick: () => selectChannel(d.channelId),
          }, avatar(d.user, { size: 'sm', online: d.user.online }), h('span', { class: 'truncate' }, d.user.displayName), badge(d.mentions))))),
    );
    return;
  }

  if (!state.detail) {
    header.replaceChildren(h('span', { class: 'truncate' }, '…'));
    body.replaceChildren();
    return;
  }

  header.replaceChildren(
    h('span', { class: 'truncate' }, state.detail.server.name),
    h('span', { class: 'chevron', 'aria-hidden': 'true' }, '▾'),
  );
  header.classList.add('clickable');
  header.onclick = () => openServerMenu(header);

  const manage = can(P.MANAGE_CHANNELS);
  const channels = [...state.detail.channels].sort((a, b) => a.position - b.position || a.id - b.id);
  body.replaceChildren(
    h('div', { class: 'section-title' },
      h('span', {}, 'Canais de texto'),
      manage ? h('button', { class: 'icon-btn small', title: 'Criar canal', onclick: createChannelDialog }, '+') : null),
    h('ul', { class: 'side-list' }, channels.map((c) => h('li', { class: 'channel-row' },
      h('button', {
        class: `side-item channel${c.id === state.channelId ? ' active' : ''}${c.unread ? ' unread' : ''}`,
        onclick: () => selectChannel(c.id),
      }, h('span', { class: 'hash' }, '#'), h('span', { class: 'truncate' }, c.name), badge(c.mentions)),
      manage ? h('button', { class: 'icon-btn small channel-gear', title: 'Editar canal', onclick: () => editChannelDialog(c) }, '⚙') : null,
    ))),
  );
}

// ---------------------------------------------------------------- Cabeçalho

function renderHeader() {
  const title = $('#chat-title');
  const dm = state.view === 'home' ? currentDm() : null;
  const channel = currentChannel();
  if (state.view === 'home' && !state.channelId) {
    title.replaceChildren(h('span', { class: 'side-icon' }, '👥'), h('span', { class: 'truncate' }, 'Amigos'));
  } else if (dm) {
    title.replaceChildren(
      h('button', { class: 'header-user', onclick: (e) => openProfile(e.currentTarget, dm.user) },
        avatar(dm.user, { size: 'xs', online: dm.user.online }), h('span', { class: 'truncate' }, dm.user.displayName)),
    );
  } else {
    title.replaceChildren(h('span', { class: 'hash' }, '#'), h('span', { class: 'truncate' }, channel ? channel.name : ''));
  }
  $('#btn-toggle-members').hidden = state.view === 'home';
}

function renderMain() {
  const friendsPage = state.view === 'home' && !state.channelId;
  $('#friends-page').hidden = !friendsPage;
  $('#messages').hidden = friendsPage;
  $('#app').classList.toggle('home-view', state.view === 'home');
  if (friendsPage) renderFriendsPage($('#friends-page'));
  else renderMessages(); // cores/permissões podem ter mudado
}

// ---------------------------------------------------------------- Membros

function renderMembers() {
  const panel = $('#member-list');
  if (state.view === 'home' || !state.detail) return panel.replaceChildren();
  const ownerId = state.detail.server.ownerId;
  const online = state.detail.members.filter((m) => m.online);
  const offline = state.detail.members.filter((m) => !m.online);
  const group = (title, members, isOnline) => (members.length === 0 ? null
    : h('div', { class: 'member-group' },
      h('div', { class: 'section-title' }, `${title} — ${members.length}`),
      members.map((m) => {
        const color = roleColor(m.id);
        return h('button', { class: `member${isOnline ? '' : ' off'}`, title: `@${m.username}`, onclick: (e) => openProfile(e.currentTarget, m) },
          avatar(m, { size: 'sm', online: isOnline }),
          h('span', { class: 'name truncate', style: color ? `color:${color}` : null }, m.displayName),
          m.id === ownerId ? h('span', { class: 'owner-badge', title: 'Dono do servidor' }, '👑') : null);
      })));
  panel.replaceChildren(...[group('Online', online, true), group('Offline', offline, false)].filter(Boolean));
}

// ================================================================ Mensagens

function bucketFor(channelId) {
  if (!state.messages.has(channelId)) {
    state.messages.set(channelId, { items: [], hasMore: true, loading: false, loaded: false, nodes: new Map() });
  }
  return state.messages.get(channelId);
}

async function loadOlder(channelId) {
  const bucket = bucketFor(channelId);
  if (bucket.loading || !bucket.hasMore) return;
  bucket.loading = true;
  if (channelId === state.channelId) renderMessages({ stick: 'keep' });
  const oldest = bucket.items.find((m) => !m.pending && !m.failed);
  try {
    const qs = oldest ? `?before=${oldest.id}` : '';
    const { messages, hasMore } = await api(`/channels/${channelId}/messages${qs}`);
    const known = new Set(bucket.items.map((m) => m.id));
    bucket.items.unshift(...messages.filter((m) => !known.has(m.id)));
    bucket.hasMore = hasMore;
  } catch (err) {
    bucket.hasMore = false;
    toast(err.message);
  } finally {
    bucket.loading = false;
  }
  if (channelId !== state.channelId) return;
  renderMessages({ stick: oldest ? 'keep-position' : 'always' });
  // Se ainda não dá para rolar (poucas mensagens na tela), busca mais um pouco.
  const box = $('#messages');
  if (bucket.hasMore && box.scrollHeight <= box.clientHeight + 80) loadOlder(channelId);
}

let stickToBottom = true;

$('#messages').addEventListener('scroll', (e) => {
  const box = e.currentTarget;
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (box.scrollTop < 80 && state.channelId) loadOlder(state.channelId);
});

// Coloca os nós na ordem certa mexendo o mínimo possível no DOM
// (assim um vídeo tocando não para quando chega mensagem nova).
function reconcile(parent, nodes) {
  let cur = parent.firstChild;
  for (const n of nodes) {
    if (n === cur) { cur = cur.nextSibling; continue; }
    parent.insertBefore(n, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    parent.removeChild(cur);
    cur = next;
  }
}

function renderMessages({ stick = 'if-near' } = {}) {
  const box = $('#messages');
  if (box.hidden) return;
  const bucket = state.messages.get(state.channelId);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  if (!bucket) return box.replaceChildren();

  const cache = bucket.nodes;
  const used = new Set();
  const cached = (key, sig, build) => {
    used.add(key);
    const c = cache.get(key);
    if (c && c.sig === sig) return c.node;
    const node = build();
    cache.set(key, { sig, node });
    return node;
  };

  const nodes = [];
  if (bucket.hasMore) {
    nodes.push(cached('top', `more|${bucket.loading}`, () => h('div', { class: 'load-more' }, bucket.loading ? 'Carregando…' : 'Role para cima para ver mais')));
  } else {
    const dm = currentDm();
    const channel = currentChannel();
    nodes.push(cached('top', `start|${dm ? dm.user.displayName : channel && channel.name}`, () => (dm
      ? h('div', { class: 'channel-start' }, avatar(dm.user, { size: 'lg' }), h('h2', {}, dm.user.displayName),
        h('p', { class: 'muted' }, `Este é o começo da sua conversa com @${dm.user.username}.`))
      : h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, '#'),
        h('h2', {}, `Bem-vindo a #${channel ? channel.name : ''}!`),
        h('p', { class: 'muted' }, 'Este é o começo do canal.')))));
  }

  const view = `${state.detailVersion}|${state.view}`;
  let prev = null;
  for (const m of bucket.items) {
    const date = new Date(m.createdAt);
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== date.toDateString();
    if (newDay) {
      const key = `day:${date.toDateString()}`;
      nodes.push(cached(key, dayLabel(date), () => h('div', { class: 'day-sep' }, dayLabel(date))));
    }
    const grouped = !!prev && !newDay && prev.author.id === m.author.id && !prev.failed &&
      date - new Date(prev.createdAt) < 7 * 60 * 1000;
    const sig = [m._v || 0, grouped, !!m.pending, !!m.failed, state.editingId === m.id, view].join('|');
    nodes.push(cached(`m:${m.nonce && m.pending ? m.nonce : m.id}`, sig, () => buildMessage(m, grouped)));
    prev = m;
  }
  for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);

  reconcile(box, nodes);

  if (stick === 'always' || (stick === 'if-near' && nearBottom)) box.scrollTop = box.scrollHeight;
  else if (stick === 'keep-position') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  if (state.editingId) {
    const ta = box.querySelector('.msg-edit textarea');
    if (ta && document.activeElement !== ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}

// ---------------------------------------------------------------- Uma mensagem

function canDelete(m) {
  if (m.author.id === state.me.id) return true;
  return state.view !== 'home' && can(P.MANAGE_MESSAGES);
}

function buildMessage(m, grouped) {
  const date = new Date(m.createdAt);
  const mine = m.author.id === state.me.id;
  const mentionsMe = !mine && (m.mentions.includes(state.me.id) || m.mentionEveryone);
  const editing = state.editingId === m.id;
  const authorUser = memberById(m.author.id) || m.author;

  const left = grouped
    ? h('span', { class: 'msg-time hover', title: fullTime(date) }, formatTime(date))
    : h('button', { class: 'avatar-btn', onclick: (e) => openProfile(e.currentTarget, authorUser) }, avatar(m.author));

  const body = h('div', { class: 'msg-body' });
  if (!grouped) {
    const color = roleColor(m.author.id) || `hsl(${hueFor(m.author.id)} 75% 72%)`;
    body.append(h('div', { class: 'msg-head' },
      h('button', { class: 'msg-author', style: `color:${color}`, onclick: (e) => openProfile(e.currentTarget, authorUser) }, m.author.displayName),
      h('span', { class: 'msg-time', title: fullTime(date) }, fullTime(date))));
  }

  if (editing) body.append(buildEditor(m));
  else if (m.content) {
    body.append(h('div', { class: `msg-text${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}` },
      renderContent(m.content),
      m.editedAt ? h('span', { class: 'edited', title: fullTime(new Date(m.editedAt)) }, ' (editado)') : null));
  }

  if (m.attachments.length) body.append(h('div', { class: 'attachments' }, m.attachments.map((a) => buildAttachment(a, m.pending))));
  if (m.failed) body.append(h('div', { class: 'msg-failed' }, 'Não foi enviada.'));
  if (m.reactions.length) body.append(buildReactions(m));

  const el = h('div', {
    class: `msg ${grouped ? 'grouped' : 'first'}${mentionsMe ? ' mentioned' : ''}${editing ? ' editing' : ''}`,
    dataset: { id: m.id },
  }, h('div', { class: 'msg-left' }, left), body);

  if (!m.pending && !m.failed && !editing) {
    const tools = [];
    if (can(P.ADD_REACTIONS)) tools.push(h('button', { class: 'tool', title: 'Reagir', onclick: (e) => openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m, emoji, true)) }, '😀'));
    if (mine) tools.push(h('button', { class: 'tool', title: 'Editar', onclick: () => startEdit(m) }, '✏️'));
    if (canDelete(m)) tools.push(h('button', { class: 'tool danger', title: 'Apagar (Shift+clique apaga direto)', onclick: (e) => deleteMessage(m, e.shiftKey) }, '🗑️'));
    if (tools.length) el.append(h('div', { class: 'msg-tools' }, tools));
  }
  return el;
}

// Texto com links e @menções destacados (sempre como texto, nunca HTML).
const TOKEN_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"])|(^|[^\w@])(@[a-z0-9_.]{3,32})/gi;

function renderContent(text) {
  const out = [];
  const users = knownUsers();
  let last = 0;
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text))) {
    if (match[1]) {
      out.push(text.slice(last, match.index));
      out.push(h('a', { href: match[1], target: '_blank', rel: 'noopener noreferrer nofollow' }, match[1]));
      last = match.index + match[1].length;
    } else {
      const start = match.index + match[2].length;
      const raw = match[3];
      const name = raw.slice(1).toLowerCase().replace(/\.+$/, '');
      const user = users.get(name);
      if (name === 'everyone' || user) {
        out.push(text.slice(last, start));
        const shown = name === 'everyone' ? '@everyone' : `@${user.displayName}`;
        out.push(h('span', {
          class: `mention${user && user.id === state.me.id ? ' me' : ''}`,
          title: user ? `@${user.username}` : null,
          onclick: user ? (e) => openProfile(e.currentTarget, memberById(user.id) || user) : null,
        }, shown));
        // Mantém o ponto final que veio grudado no nome (ex.: "@ana.")
        const consumed = `@${name}`.length;
        last = start + consumed;
      }
    }
  }
  out.push(text.slice(last));
  return out.filter((x) => x !== '');
}

function buildAttachment(a, pending) {
  if (pending || a.local) {
    return h('div', { class: 'att-file' }, h('span', { class: 'att-icon' }, '📎'), h('span', { class: 'truncate' }, a.filename));
  }
  if (a.kind === 'image') {
    const img = h('img', { src: a.url, alt: a.filename, loading: 'lazy', class: 'att-img' });
    img.addEventListener('load', () => {
      const box = $('#messages');
      if (stickToBottom) box.scrollTop = box.scrollHeight;
    });
    return h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'att-img-link', title: a.filename }, img);
  }
  if (a.kind === 'video') return h('video', { src: a.url, controls: true, preload: 'metadata', class: 'att-video' });
  if (a.kind === 'audio') return h('div', { class: 'att-audio' }, h('div', { class: 'truncate muted' }, a.filename), h('audio', { src: a.url, controls: true, preload: 'none' }));
  return h('div', { class: 'att-file' },
    h('span', { class: 'att-icon' }, '📄'),
    h('div', { class: 'att-info' },
      h('a', { href: a.url, download: a.filename, class: 'truncate' }, a.filename),
      h('span', { class: 'muted' }, formatSize(a.size))));
}

function buildReactions(m) {
  const users = new Map([...knownUsers().values()].map((u) => [u.id, u]));
  const allowed = can(P.ADD_REACTIONS);
  return h('div', { class: 'reactions' },
    m.reactions.map((r) => {
      const mine = r.users.includes(state.me.id);
      const names = r.users.map((id) => (users.get(id) || {}).displayName).filter(Boolean);
      return h('button', {
        class: `reaction${mine ? ' mine' : ''}`,
        title: names.length ? `${names.join(', ')} reagiu com ${r.emoji}` : r.emoji,
        disabled: !allowed && !mine,
        onclick: () => toggleReaction(m, r.emoji, !mine),
      }, h('span', { class: 'r-emoji' }, r.emoji), h('span', { class: 'r-count' }, String(r.count)));
    }),
    allowed ? h('button', { class: 'reaction add', title: 'Adicionar reação', onclick: (e) => openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m, emoji, true)) }, '+') : null);
}

async function toggleReaction(m, emoji, add) {
  try {
    await api(`/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, { method: add ? 'PUT' : 'DELETE' });
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- Editar / apagar

function startEdit(m) {
  state.editingId = m.id;
  renderMessages();
}

function buildEditor(m) {
  const ta = h('textarea', { rows: 1, maxlength: '4000', value: m.content });
  const save = async () => {
    const content = ta.value.trim();
    if (content === m.content) return cancel();
    if (!content && m.attachments.length === 0) {
      state.editingId = null;
      return deleteMessage(m, false);
    }
    try {
      const { message } = await api(`/messages/${m.id}`, { method: 'PATCH', body: { content } });
      state.editingId = null;
      updateMessage(m.channelId, m.id, message);
    } catch (err) {
      toast(err.message);
    }
  };
  const cancel = () => {
    state.editingId = null;
    renderMessages();
    $('#composer-input').focus();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  const resize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`; };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return h('div', { class: 'msg-edit' }, ta,
    h('div', { class: 'edit-hint muted' }, 'Enter para ',
      h('button', { class: 'link', type: 'button', onclick: save }, 'salvar'), ' • Esc para ',
      h('button', { class: 'link', type: 'button', onclick: cancel }, 'cancelar')));
}

function deleteMessage(m, skipConfirm) {
  const run = async () => {
    await api(`/messages/${m.id}`, { method: 'DELETE' });
  };
  if (skipConfirm) return run().catch((err) => toast(err.message));
  const preview = m.content.length > 140 ? `${m.content.slice(0, 140)}…` : m.content;
  confirmDialog({
    title: 'Apagar mensagem',
    text: preview ? `Tem certeza? "${preview}"` : 'Tem certeza que quer apagar essa mensagem?',
    okLabel: 'Apagar',
    onConfirm: run,
  });
}

// ---------------------------------------------------------------- Digitando…

function clearTyping(channelId, userId) {
  const map = state.typing.get(channelId);
  const entry = map && map.get(userId);
  if (entry) {
    clearTimeout(entry.timer);
    map.delete(userId);
    renderTyping();
  }
}

function renderTyping() {
  const map = state.typing.get(state.channelId);
  const names = map ? [...map.values()].map((t) => t.name) : [];
  const el = $('#typing');
  if (names.length === 0) return el.replaceChildren();
  const who = names.length > 3
    ? [h('strong', {}, 'Várias pessoas')]
    : names.flatMap((n, i) => [i ? (i === names.length - 1 ? ' e ' : ', ') : '', h('strong', {}, n)]);
  el.replaceChildren(h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i')), ...who, names.length === 1 ? ' está digitando…' : ' estão digitando…');
}

// ================================================================ Escrever mensagens

const input = $('#composer-input');
let lastTypingSent = 0;
state.uploads = [];

function renderComposerState() {
  const show = !!state.channelId;
  $('#composer-area').hidden = !show;
  if (!show) return;
  const allowed = can(P.SEND_MESSAGES);
  input.disabled = !allowed;
  $('#composer').classList.toggle('disabled', !allowed);
  $('#btn-attach').hidden = !allowed || !can(P.ATTACH_FILES);
  const dm = currentDm();
  const channel = currentChannel();
  input.placeholder = !allowed
    ? 'Você não tem permissão para enviar mensagens aqui.'
    : dm ? `Conversar com @${dm.user.username}` : `Conversar em #${channel ? channel.name : ''}`;
  renderUploads();
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', () => {
  autoResize();
  updateAutocomplete();
  const now = Date.now();
  if (input.value.trim() && now - lastTypingSent > 2500 && state.socket) {
    lastTypingSent = now;
    state.socket.emit('typing', { channelId: state.channelId });
  }
});

input.addEventListener('keydown', (e) => {
  if (handleAutocompleteKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'ArrowUp' && !input.value) {
    // Seta para cima com a caixa vazia: edita sua última mensagem.
    const bucket = state.messages.get(state.channelId);
    const last = bucket && [...bucket.items].reverse().find((m) => m.author.id === state.me.id && !m.pending && !m.failed);
    if (last) { e.preventDefault(); startEdit(last); }
  }
});

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

input.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

function sendMessage() {
  if (!state.channelId || !state.socket || input.disabled) return;
  const content = input.value.trim();
  const ups = state.uploads;
  if (ups.some((u) => !u.attachment && !u.error)) return toast('Espere os anexos terminarem de enviar.');
  if (ups.some((u) => u.error)) return toast('Remova os anexos que deram erro.');
  if (!content && ups.length === 0) return;

  const channelId = state.channelId;
  const nonce = `n${Date.now().toString(36)}${++tempSeq}`;
  const temp = {
    id: `tmp-${nonce}`, nonce, pending: true, channelId, serverId: state.view === 'home' ? null : state.view,
    content, createdAt: new Date().toISOString(), author: state.me, mentions: [], mentionEveryone: false,
    reactions: [], attachments: ups.map((u) => ({ ...u.attachment, local: true })),
  };
  const attachmentIds = ups.map((u) => u.attachment.id);
  bucketFor(channelId).items.push(temp);
  input.value = '';
  autoResize();
  clearUploads();
  hideAutocomplete();
  lastTypingSent = 0;
  renderMessages({ stick: 'always' });

  state.socket.timeout(15000).emit('message:send', { channelId, content, attachmentIds, nonce }, (err, res) => {
    const bucket = state.messages.get(channelId);
    if (!bucket) return;
    const idx = bucket.items.indexOf(temp);
    if (err || !res || !res.ok) {
      if (idx !== -1) Object.assign(temp, { pending: false, failed: true, _v: 1 });
      toast((res && res.error) || 'Não foi possível enviar a mensagem.');
    } else if (idx !== -1) {
      // Se a confirmada já chegou pelo "message:new", só remove a temporária.
      if (bucket.items.some((m) => m !== temp && m.id === res.message.id)) bucket.items.splice(idx, 1);
      else bucket.items[idx] = res.message;
    }
    if (channelId === state.channelId) renderMessages();
  });
}

// ---------------------------------------------------------------- Anexos

const MAX_ATTACHMENTS = 5;

$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});

function addFiles(files) {
  if (!state.channelId || !can(P.ATTACH_FILES) || !can(P.SEND_MESSAGES)) return toast('Você não pode enviar arquivos aqui.');
  const room = MAX_ATTACHMENTS - state.uploads.length;
  if (files.length > room) toast(`No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
  for (const file of files.slice(0, Math.max(0, room))) {
    const up = { key: `u${++tempSeq}`, file, progress: 0, attachment: null, error: null, channelId: state.channelId };
    up.preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    state.uploads.push(up);
    uploadFile(file, (p) => { up.progress = p; renderUploads(); })
      .then((att) => { up.attachment = att; })
      .catch((err) => { up.error = err.message; })
      .finally(() => renderUploads());
  }
  renderUploads();
  input.focus();
}

function clearUploads() {
  (state.uploads || []).forEach((u) => { if (u.preview) URL.revokeObjectURL(u.preview); });
  state.uploads = [];
  renderUploads();
}

function renderUploads() {
  const box = $('#uploads');
  box.hidden = state.uploads.length === 0;
  box.replaceChildren(...state.uploads.map((u) => h('div', { class: `upload${u.error ? ' error' : ''}` },
    u.preview ? h('img', { src: u.preview, alt: '' }) : h('span', { class: 'att-icon' }, '📄'),
    h('div', { class: 'upload-info' },
      h('span', { class: 'truncate' }, u.file.name),
      h('span', { class: 'muted' }, u.error || (u.attachment ? formatSize(u.file.size) : `Enviando… ${Math.round(u.progress * 100)}%`)),
      !u.attachment && !u.error ? h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(u.progress * 100)}%` })) : null),
    h('button', {
      class: 'icon-btn small', type: 'button', title: 'Remover',
      onclick: () => {
        if (u.preview) URL.revokeObjectURL(u.preview);
        state.uploads = state.uploads.filter((x) => x !== u);
        renderUploads();
      },
    }, '✕'))));
}

// Arrastar e soltar arquivos na conversa.
let dragDepth = 0;
const main = $('#main');
main.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files') || !state.channelId) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
main.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop-overlay').hidden = true;
});
main.addEventListener('dragover', (e) => { if (state.channelId) e.preventDefault(); });
main.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (files.length) addFiles(files);
});

// ---------------------------------------------------------------- Emojis no texto

$('#btn-emoji').addEventListener('click', (e) => {
  openEmojiPicker(e.currentTarget, (emoji) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    const pos = start + emoji.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    autoResize();
  }, { keepOpen: true });
});

// ---------------------------------------------------------------- Autocompletar @menções

let ac = null; // { items, index, start }

function mentionCandidates() {
  if (state.view === 'home') {
    const dm = currentDm();
    return dm ? [dm.user, state.me] : [];
  }
  return state.detail ? state.detail.members : [];
}

function updateAutocomplete() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const m = /(^|\s)@([a-z0-9_.]*)$/i.exec(before);
  if (!m) return hideAutocomplete();
  const q = m[2].toLowerCase();
  const items = mentionCandidates()
    .filter((u) => u.username.startsWith(q) || u.displayName.toLowerCase().includes(q))
    .slice(0, 8)
    .map((u) => ({ user: u, value: u.username }));
  if (state.view !== 'home' && can(P.MENTION_EVERYONE) && 'everyone'.startsWith(q)) {
    items.push({ everyone: true, value: 'everyone' });
  }
  if (items.length === 0) return hideAutocomplete();
  ac = { items, index: 0, start: pos - q.length - 1 };
  renderAutocomplete();
}

function renderAutocomplete() {
  const box = $('#autocomplete');
  if (!ac) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'ac-title' }, 'Membros'),
    ...ac.items.map((it, i) => h('button', {
      type: 'button',
      class: `ac-item${i === ac.index ? ' active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); pickAutocomplete(i); },
    }, it.everyone
      ? [h('span', { class: 'ac-at' }, '@'), h('strong', {}, '@everyone'), h('span', { class: 'muted' }, 'Notifica todo mundo')]
      : [avatar(it.user, { size: 'xs' }), h('strong', {}, it.user.displayName), h('span', { class: 'muted' }, `@${it.user.username}`)])),
  );
}

function hideAutocomplete() {
  ac = null;
  renderAutocomplete();
}

function pickAutocomplete(i) {
  if (!ac) return;
  const it = ac.items[i];
  const pos = input.selectionStart;
  const text = `@${it.value} `;
  input.value = input.value.slice(0, ac.start) + text + input.value.slice(pos);
  const caret = ac.start + text.length;
  input.setSelectionRange(caret, caret);
  hideAutocomplete();
  input.focus();
}

function handleAutocompleteKey(e) {
  if (!ac) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = ac.items.length;
    ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderAutocomplete();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickAutocomplete(ac.index);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideAutocomplete();
    return true;
  }
  return false;
}

// ================================================================ Perfil (cartão do usuário)

export function friendStatus(userId) {
  const f = state.friends;
  if (f.friends.some((x) => x.id === userId)) return 'friend';
  if (f.incoming.some((x) => x.id === userId)) return 'incoming';
  if (f.outgoing.some((x) => x.id === userId)) return 'outgoing';
  return null;
}

export function openProfile(anchor, user) {
  if (!user) return;
  const isMe = user.id === state.me.id;
  const member = state.view !== 'home' ? memberById(user.id) : null;
  const roles = memberRoles(member);
  const status = friendStatus(user.id);
  const online = member ? member.online : user.online;

  const actions = [];
  if (!isMe) {
    actions.push(h('button', { class: 'btn primary', onclick: () => openDm(user.id) }, 'Enviar mensagem'));
    if (!status) {
      actions.push(h('button', {
        class: 'btn', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api('/friends', { method: 'POST', body: { username: user.username } }); toast('Pedido de amizade enviado!'); closePopover(); } catch (err) { toast(err.message); }
        },
      }, 'Adicionar amigo'));
    } else if (status === 'incoming') {
      actions.push(h('button', {
        class: 'btn', onclick: async () => {
          try { await api(`/friends/${user.id}/accept`, { method: 'POST' }); toast('Agora vocês são amigos!'); closePopover(); } catch (err) { toast(err.message); }
        },
      }, 'Aceitar amizade'));
    } else if (status === 'outgoing') {
      actions.push(h('button', { class: 'btn', disabled: true }, 'Pedido enviado'));
    } else {
      actions.push(h('span', { class: 'friend-tag' }, '✓ Amigos'));
    }
    if (member && can(P.KICK_MEMBERS) && user.id !== state.detail.server.ownerId && memberTop(member) < myTop()) {
      actions.push(h('button', { class: 'btn danger-ghost', onclick: () => kickMember(member) }, 'Expulsar'));
    }
  }

  const color = member ? roleColor(member.id) : null;
  openPopover(anchor, h('div', { class: 'profile' },
    h('div', { class: 'profile-banner', style: `--hue:${hueFor(user.id)}` }),
    h('div', { class: 'profile-avatar' }, avatar(user, { size: 'xl', online: online === undefined ? undefined : !!online })),
    h('div', { class: 'profile-body' },
      h('h3', { style: color ? `color:${color}` : null }, user.displayName),
      h('div', { class: 'muted' }, `@${user.username}`),
      member && member.id === state.detail.server.ownerId ? h('div', { class: 'owner-line' }, '👑 Dono do servidor') : null,
      roles.length ? h('div', { class: 'role-chips' }, roles.map((r) => h('span', { class: 'role-chip' },
        h('i', { style: `background:${r.color || 'var(--text-3)'}` }), r.name))) : null,
      actions.length ? h('div', { class: 'profile-actions' }, actions) : null)), { className: 'popover-profile' });
}

function kickMember(member) {
  closePopover();
  confirmDialog({
    title: `Expulsar ${member.displayName}`,
    text: `${member.displayName} vai sair do servidor, mas pode voltar se receber um convite.`,
    okLabel: 'Expulsar',
    onConfirm: () => api(`/servers/${state.view}/members/${member.id}`, { method: 'DELETE' }),
  });
}

// ================================================================ Servidor: menus e janelas

function openServerMenu(anchor) {
  const d = state.detail;
  if (!d) return;
  const manageSomething = isOwner() || can(P.MANAGE_SERVER) || can(P.MANAGE_ROLES) || can(P.KICK_MEMBERS);
  openMenu(anchor, [
    { label: '✉️  Convidar pessoas', hidden: !d.server.inviteCode, onClick: inviteDialog },
    { label: '⚙️  Configurações do servidor', hidden: !manageSomething, onClick: () => openServerSettings() },
    { label: '➕  Criar canal', hidden: !can(P.MANAGE_CHANNELS), onClick: createChannelDialog },
    { separator: true, hidden: isOwner() },
    { label: '🚪  Sair do servidor', danger: true, hidden: isOwner(), onClick: leaveServerDialog },
  ], { className: 'popover-menu' });
}

function inviteDialog() {
  const d = state.detail;
  const link = `${location.origin}/convite/${d.server.inviteCode}`;
  const field = h('input', { value: link, readonly: true });
  const codeLine = h('p', { class: 'muted small' }, 'Ou passe só o código: ', h('strong', {}, d.server.inviteCode));
  const actions = [];
  if (can(P.MANAGE_SERVER)) {
    actions.push({
      label: 'Gerar novo', close: false,
      onClick: async () => {
        const { inviteCode } = await api(`/servers/${d.server.id}/invite`, { method: 'POST' });
        d.server.inviteCode = inviteCode;
        field.value = `${location.origin}/convite/${inviteCode}`;
        codeLine.lastChild.textContent = inviteCode;
        toast('Novo convite gerado. O antigo parou de funcionar.');
      },
    });
  }
  actions.push({ label: 'Fechar' });
  actions.push({
    label: 'Copiar link', kind: 'primary', submit: true,
    onClick: async () => {
      if (await copyText(field.value, field)) toast('Link copiado!');
      else throw new Error('Não deu para copiar automaticamente. Selecione e copie com Ctrl+C.');
    },
  });
  openDialog({
    title: `Convide amigos para ${d.server.name}`,
    text: 'Quem abrir o link (ou colar o código no botão ↪) entra no servidor.',
    body: h('div', {}, field, codeLine),
    actions,
  });
}

function createChannelDialog() {
  ask({
    title: 'Criar canal de texto',
    placeholder: 'novo-canal',
    okLabel: 'Criar',
    onSubmit: async (name) => {
      if (!name) throw new Error('Dê um nome ao canal.');
      const { channel } = await api(`/servers/${state.view}/channels`, { method: 'POST', body: { name } });
      await refreshDetail();
      await selectChannel(channel.id);
    },
  });
}

function editChannelDialog(channel) {
  const input2 = h('input', { value: channel.name, maxlength: '100' });
  openDialog({
    title: 'Editar canal',
    body: h('label', { class: 'field' }, 'Nome do canal', input2),
    actions: [
      {
        label: 'Apagar canal', kind: 'danger-ghost',
        onClick: () => {
          confirmDialog({
            title: `Apagar #${channel.name}`,
            text: 'Todas as mensagens deste canal serão apagadas para sempre.',
            okLabel: 'Apagar canal',
            onConfirm: () => api(`/channels/${channel.id}`, { method: 'DELETE' }),
          });
        },
      },
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', submit: true,
        onClick: async () => {
          const name = input2.value.trim();
          if (!name) throw new Error('Dê um nome ao canal.');
          await api(`/channels/${channel.id}`, { method: 'PATCH', body: { name } });
        },
      },
    ],
  });
}

function leaveServerDialog() {
  const d = state.detail;
  confirmDialog({
    title: `Sair de ${d.server.name}`,
    text: 'Você só volta se receber um convite de novo.',
    okLabel: 'Sair do servidor',
    onConfirm: async () => {
      await api(`/servers/${d.server.id}/members/me`, { method: 'DELETE' });
      state.servers = state.servers.filter((s) => s.id !== d.server.id);
      goHome();
    },
  });
}

async function showInvitePreview(code) {
  try {
    const info = await api(`/invites/${encodeURIComponent(code)}`);
    if (info.isMember) return selectServer(info.server.id);
    openDialog({
      title: `Convite para ${info.server.name}`,
      text: `${info.memberCount} ${info.memberCount === 1 ? 'membro' : 'membros'}. Quer entrar?`,
      actions: [
        { label: 'Agora não' },
        { label: 'Entrar no servidor', kind: 'primary', submit: true, onClick: () => joinServer(code) },
      ],
    });
  } catch (err) {
    toast(err.message);
  }
}

async function joinServer(code) {
  const { server } = await api('/servers/join', { method: 'POST', body: { code } });
  if (!state.servers.some((s) => s.id === server.id)) state.servers.push({ ...server, unread: false, mentions: 0 });
  await selectServer(server.id);
}

$('#btn-create-server').addEventListener('click', () => ask({
  title: 'Criar um servidor',
  text: 'Seu servidor é onde você e seus amigos conversam.',
  placeholder: 'Nome do servidor',
  value: `Servidor de ${state.me.displayName}`,
  okLabel: 'Criar',
  onSubmit: async (name) => {
    if (!name) throw new Error('Dê um nome ao servidor.');
    const { server } = await api('/servers', { method: 'POST', body: { name } });
    state.servers.push({ ...server, unread: false, mentions: 0 });
    await selectServer(server.id);
  },
}));

$('#btn-join-server').addEventListener('click', () => ask({
  title: 'Entrar em um servidor',
  text: 'Cole o link ou o código de convite que você recebeu.',
  placeholder: 'Ex.: http://…/convite/aB3dE9xZ ou aB3dE9xZ',
  okLabel: 'Entrar',
  onSubmit: async (code) => {
    if (!code) throw new Error('Cole um link ou código de convite.');
    await joinServer(code);
  },
}));

function newDmDialog() {
  const friends = state.friends.friends;
  if (friends.length === 0) {
    toast('Adicione amigos primeiro, ou abra uma conversa pelo perfil de alguém do seu servidor.');
    return goHome();
  }
  openDialog({
    title: 'Nova conversa',
    text: 'Escolha um amigo.',
    body: h('div', { class: 'pick-list' }, friends.map((f) => h('button', {
      class: 'pick-item', type: 'button',
      onclick: (e) => { e.currentTarget.closest('dialog').close(); openDm(f.id); },
    }, avatar(f, { size: 'sm', online: f.online }), h('strong', {}, f.displayName), h('span', { class: 'muted' }, `@${f.username}`)))),
    actions: [{ label: 'Fechar' }],
  });
}

// ================================================================ Painel do usuário

function renderUserPanel() {
  $('#me-avatar').replaceChildren(avatar(state.me));
  $('#me-name').textContent = state.me.displayName;
  $('#me-username').textContent = `@${state.me.username}`;
  $('#btn-sound').textContent = state.soundOn ? '🔔' : '🔕';
  $('#btn-sound').title = state.soundOn ? 'Som de notificação ligado' : 'Som de notificação desligado';
}

$('#btn-sound').addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  storage('nexo.sound', state.soundOn ? '1' : '0');
  renderUserPanel();
  if (state.soundOn) playPing();
  // Notificações do sistema só funcionam com HTTPS; pede permissão quando dá.
  if (state.soundOn && 'Notification' in window && window.isSecureContext && Notification.permission === 'default') {
    Notification.requestPermission();
  }
});

$('#me-info').addEventListener('click', () => ask({
  title: 'Seu nome de exibição',
  text: 'É o nome que aparece nas mensagens. O @usuário continua o mesmo.',
  value: state.me.displayName,
  maxLength: 32,
  okLabel: 'Salvar',
  onSubmit: async (displayName) => {
    const { user } = await api('/me', { method: 'PATCH', body: { displayName } });
    state.me = user;
    renderUserPanel();
  },
}));

$('#btn-logout').addEventListener('click', logout);
$('#home-btn').addEventListener('click', () => goHome());

$('#btn-toggle-members').addEventListener('click', () => {
  const hidden = $('#app').classList.toggle('no-members');
  storage('nexo.hideMembers', hidden ? '1' : null);
});
$('#btn-toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));

// Funções usadas pelas outras telas (amigos, configurações).
export { openDm, goHome, refreshDetail, loadFriends, renderAll, selectChannel };

boot();
