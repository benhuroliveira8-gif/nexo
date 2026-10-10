// Nexo — frontend (Fase 5). JavaScript puro em módulos, sem etapa de build.
import {
  $, h, storage, api, setToken, setUnauthorizedHandler, uploadFile, formatTime, dayLabel, fullTime,
  formatSize, avatar, badge, toast, copyText, openDialog, ask, confirmDialog, openPopover,
  closePopover, openMenu, playPing, hueFor, presenceOf, STATUS_LABEL, uploadAvatar,
} from './util.js';
import { openEmojiPicker } from './emoji.js';
import {
  state, P, can, isOwner, myTop, memberById, memberRoles, memberTop, roleColor, knownUsers,
  currentDm, currentChannel,
} from './state.js';
import { renderFriendsPage } from './home.js';
import { openServerSettings, refreshSettings, closeServerSettings } from './settings.js';
import {
  initVoice, voiceState, inVoice, joinVoice, leaveVoice, resyncAfterReconnect, renderVoicePanel, renderStage,
} from './voice.js';
import { openDeveloper } from './developer.js';
import { renderMarkdown, isJumboEmoji } from './markdown.js';
import { openUserSettings, closeUserSettings, refreshUserSettings } from './usersettings.js';
import { registerServiceWorker, resyncPush, disablePush } from './push.js';
import { applyTheme } from './theme.js';
import { canRecord, startRecording, formatDuration, voicePlayer, MAX_VOICE_MS } from './voicemsg.js';

applyTheme();

// "Instalar app" (Chrome/Edge/Android): guardamos o convite para mostrar nas Configurações.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => { deferredInstall = null; });
const installPrompt = () => deferredInstall;

const isVisible = () => document.visibilityState === 'visible';
let tempSeq = 0;

// Executa no máximo uma vez a cada "ms" (junta vários eventos seguidos em um).
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ================================================================ Login / cadastro

let authMode = 'login';
let registrationRequiresCode = false;
api('/config').then((c) => {
  registrationRequiresCode = !!c.registrationRequiresCode;
  if (authMode === 'register') $('#reg-code-field').hidden = !registrationRequiresCode;
}).catch(() => {});

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
  $('#reg-code-field').hidden = !register || !registrationRequiresCode;
  $('#auth-submit').textContent = register ? 'Cadastrar' : 'Entrar';
  $('#auth-switch-text').textContent = register ? 'Já tem conta?' : 'Não tem conta?';
  $('#auth-switch').textContent = register ? 'Entrar' : 'Cadastre-se';
  $('#auth-form [name=password]').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  $('#auth-form [name=username]').focus();
}

$('#auth-switch').addEventListener('click', () => showAuth(authMode === 'login' ? 'register' : 'login'));

// Segunda etapa do login: a senha estava certa, falta o código do app autenticador.
let pendingLogin = null;
function showCodeStep(body) {
  pendingLogin = body;
  $('#auth-form').hidden = true;
  $('#auth-code-form').hidden = false;
  $('.auth-switch').hidden = true;
  $('#auth-title').textContent = 'Verificação em duas etapas';
  $('#auth-subtitle').textContent = 'Digite o código de 6 dígitos do seu app autenticador.';
  $('#auth-code-error').textContent = '';
  $('#auth-code-form [name=code]').value = '';
  $('#auth-code-form [name=code]').focus();
}
function hideCodeStep() {
  pendingLogin = null;
  $('#auth-form').hidden = false;
  $('#auth-code-form').hidden = true;
  $('.auth-switch').hidden = false;
}
$('#auth-code-back').addEventListener('click', () => { hideCodeStep(); showAuth('login'); });
$('#auth-code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-code-submit');
  btn.disabled = true;
  $('#auth-code-error').textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { ...pendingLogin, code: e.currentTarget.code.value.trim() } });
    hideCodeStep();
    finishLogin(data);
  } catch (err) {
    $('#auth-code-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function finishLogin(data) {
  state.token = data.token;
  setToken(data.token);
  storage('nexo.token', data.token);
  $('#auth-form').reset();
  start(data.user);
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('#auth-submit');
  const body = { username: form.username.value.trim().toLowerCase(), password: form.password.value };
  if (authMode === 'register') {
    body.displayName = form.displayName.value.trim();
    if (registrationRequiresCode) body.inviteCode = form.inviteCode.value.trim();
  }
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const data = await api(`/auth/${authMode}`, { method: 'POST', body });
    if (data.twoFactorRequired) return showCodeStep(body);
    finishLogin(data);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function logout({ skipServer = false } = {}) {
  if (inVoice()) leaveVoice();
  // Este aparelho para de receber notificações desta conta.
  if (!skipServer && state.token) disablePush().catch(() => {});
  closeUserSettings();
  stopRecording(false);
  storage('nexo.token', null);
  if (state.socket) state.socket.disconnect();
  closeServerSettings();
  closePopover();
  Object.assign(state, {
    token: null, me: null, socket: null, servers: [], view: 'home', detail: null, channelId: null,
    dms: [], friends: { friends: [], incoming: [], outgoing: [] }, editingId: null, replyTo: null,
  });
  closeSearch();
  setToken(null);
  state.messages.clear();
  state.typing.clear();
  clearUploads();
  document.title = 'Nexo';
  showAuth('login');
}

setUnauthorizedHandler(() => logout({ skipServer: true }));

// ================================================================ Início

async function boot() {
  // Link de convite: /convite/CODIGO
  const m = /^\/convite\/([\w-]{4,32})\/?$/.exec(location.pathname);
  if (m) sessionStorage.setItem('nexo.pendingInvite', m[1]);
  pendingOpen = parseOpenUrl(location.href);
  if (m || location.pathname !== '/' || location.search) history.replaceState(null, '', '/');
  registerServiceWorker();

  if (!state.token) return showAuth('login');
  setToken(state.token);
  try {
    const { user } = await api('/me');
    start(user);
  } catch {
    logout();
  }
}

// Notificação clicada: /?canal=ID&servidor=ID&msg=ID
let pendingOpen = null;
function parseOpenUrl(href) {
  try {
    const u = new URL(href, location.origin);
    const channelId = Number(u.searchParams.get('canal'));
    if (!channelId) return null;
    return { channelId, serverId: Number(u.searchParams.get('servidor')) || null, messageId: u.searchParams.get('msg') || null };
  } catch {
    return null;
  }
}
async function openFromNotification(target) {
  if (!target) return;
  if (target.serverId) {
    if (!state.servers.some((s) => s.id === target.serverId)) return;
    if (state.view !== target.serverId) await selectServer(target.serverId, target.channelId);
    else await selectChannel(target.channelId);
  } else if (state.dms.some((d) => d.channelId === target.channelId)) {
    await goHome(target.channelId);
  } else return;
  if (target.messageId) jumpToMessage(target.channelId, target.messageId);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && state.me) openFromNotification(parseOpenUrl(e.data.url));
  });
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
  if (pendingOpen && pendingOpen.serverId && state.servers.some((s) => s.id === pendingOpen.serverId)) await selectServer(pendingOpen.serverId, pendingOpen.channelId);
  else if (savedServer) await selectServer(savedServer.id);
  else {
    const homeChannel = Number(storage('nexo.homeChannel'));
    await goHome(state.dms.some((d) => d.channelId === homeChannel) ? homeChannel : null);
  }

  const invite = sessionStorage.getItem('nexo.pendingInvite');
  if (invite) {
    sessionStorage.removeItem('nexo.pendingInvite');
    showInvitePreview(invite);
  }
  if (pendingOpen) { const t = pendingOpen; pendingOpen = null; openFromNotification(t); }
  resyncPush();
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
  let fetched;
  try {
    fetched = await fetchDetail(serverId);
  } catch {
    return; // provavelmente fomos removidos; o evento server:removed cuida disso
  }
  if (state.view !== serverId) return;
  const { detail } = fetched;
  setDetail(detail, fetched.replay);
  if (!detail.channels.some((c) => c.id === state.channelId)) {
    const first = detail.channels.find((c) => c.kind === 'text') || detail.channels[0];
    if (first) return selectChannel(first.id);
  }
  renderAll();
  refreshSettings();
}

// Eventos que chegam ENQUANTO os detalhes do servidor estão sendo baixados seriam
// apagados pela resposta (que é de um instante anterior). Por isso eles ficam
// guardados e são aplicados de novo por cima da resposta.
const inflight = new Set();

function applyLive(fn) {
  fn();
  for (const replay of inflight) replay.push(fn);
}

async function fetchDetail(serverId) {
  const replay = [];
  inflight.add(replay);
  try {
    const detail = await api(`/servers/${serverId}`);
    return { detail, replay };
  } finally {
    inflight.delete(replay);
  }
}

function setDetail(detail, replay) {
  state.detail = detail;
  replay.forEach((fn) => fn());
  state.detailVersion++;
  syncServerFromDetail();
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
    socket.emit('visibility', isVisible());
    if (connectedBefore) refreshAfterReconnect();
    connectedBefore = true;
  });
  socket.on('disconnect', () => { $('#conn-status').hidden = false; });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout();
    else $('#conn-status').hidden = false;
  });

  socket.on('message:new', onMessageNew);
  socket.on('message:updated', (msg) => {
    updateMessage(msg.channelId, msg.id, msg);
    // Quem respondeu essa mensagem mostra o texto novo na citação.
    patchReplies(msg.channelId, msg.id, (r) => ({ ...r, content: msg.content.slice(0, 120), hasAttachments: msg.attachments.length > 0 }));
  });
  socket.on('channel:pins', ({ channelId }) => { if (pinsOpenFor === channelId) openPins(); });
  socket.on('message:reactions', ({ id, channelId, reactions }) => updateMessage(channelId, id, { reactions }));
  socket.on('message:poll', ({ id, channelId, poll }) => updateMessage(channelId, id, { poll }));
  socket.on('message:deleted', ({ id, channelId }) => {
    const bucket = state.messages.get(channelId);
    if (!bucket) return;
    bucket.items = bucket.items.filter((m) => m.id !== id);
    if (state.editingId === id) state.editingId = null;
    if (state.replyTo && state.replyTo.message.id === id) setReply(null);
    patchReplies(channelId, id, () => ({ deleted: true }));
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

  socket.on('voice:update', ({ serverId, channelId, states }) => {
    applyLive(() => {
      if (!state.detail || state.detail.server.id !== serverId) return;
      if (!state.detail.voice) state.detail.voice = {};
      if (states.length) state.detail.voice[channelId] = states;
      else delete state.detail.voice[channelId];
    });
    if (!state.detail || serverId !== state.view) return;
    renderSidebar();
    if (currentChannel() && currentChannel().kind === 'voice') renderMain();
  });

  socket.on('server:removed', ({ serverId, reason }) => {
    if (voiceState().serverId === serverId) leaveVoice({ silent: true });
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

  socket.on('presence', ({ userId, online, status, statusText }) => {
    const p = { online, status: status || (online ? 'online' : 'offline'), statusText: statusText || null };
    applyLive(() => {
      const m = memberById(userId);
      if (m) Object.assign(m, p);
    });
    for (const list of Object.values(state.friends)) list.forEach((f) => { if (f.id === userId) Object.assign(f, p); });
    state.dms.forEach((d) => { if (d.user.id === userId) Object.assign(d.user, p); });
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
  resyncAfterReconnect();
  // Recarrega o histórico, mas mantém as mensagens que ainda estão "enviando…"
  // (o socket.io reenvia quando a conexão volta, e a confirmação substitui a temporária).
  for (const bucket of state.messages.values()) {
    bucket.items = bucket.items.filter((m) => m.pending || m.failed);
    bucket.nodes.clear();
    bucket.hasMore = true;
    bucket.loaded = false;
    bucket.loading = false;
  }
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
  if (state.me.status === 'dnd') return; // "Não perturbe": sem som nem aviso
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
  if (state.socket) state.socket.emit('visibility', isVisible());
  if (isVisible() && state.me) scheduleMarkRead();
});

// ================================================================ Navegação

async function goHome(channelId = null) {
  if (state.view !== 'home') closeSearch();
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
  if (state.view !== serverId) closeSearch();
  state.view = serverId;
  storage('nexo.view', String(serverId));
  renderRail();
  let fetched;
  try {
    fetched = await fetchDetail(serverId);
  } catch (err) {
    toast(err.message);
    return goHome();
  }
  if (state.view !== serverId) return; // clicou em outro no meio do caminho
  const { detail } = fetched;
  setDetail(detail, fetched.replay);

  const saved = preferredChannelId || Number(storage(`nexo.channel.${serverId}`));
  const channel = detail.channels.find((c) => c.id === saved) || detail.channels.find((c) => c.kind === 'text') || detail.channels[0];
  if (channel) await selectChannel(channel.id);
  else { state.channelId = null; renderAll(); }
}

async function selectChannel(channelId) {
  if (state.channelId !== channelId) {
    state.editingId = null;
    clearUploads();
    setReply(null, { render: false });
    pinsOpenFor = null;
    if (state.recording) stopRecording(false);
  }
  state.channelId = channelId;
  if (state.view === 'home') storage('nexo.homeChannel', String(channelId));
  else storage(`nexo.channel.${state.view}`, String(channelId));
  $('#app').classList.remove('sidebar-open');
  renderAll();
  if (currentChannel() && currentChannel().kind === 'voice') return;

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
          }, avatar(d.user, { size: 'sm', online: d.user.online ? presenceOf(d.user) : 'offline' }), h('span', { class: 'truncate' }, d.user.displayName), badge(d.mentions))))),
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
  const text = channels.filter((c) => c.kind === 'text');
  const voiceChannels = channels.filter((c) => c.kind === 'voice');
  const threadsOf = (parentId) => channels
    .filter((t) => t.kind === 'thread' && t.parentChannelId === parentId && threadVisible(t))
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  const gear = (c) => (manage || (c.kind === 'thread' && c.createdBy === state.me.id)
    ? h('button', { class: 'icon-btn small channel-gear', title: c.kind === 'thread' ? 'Editar thread' : 'Editar canal', onclick: () => editChannelDialog(c) }, '⚙')
    : null);
  const threadRow = (t) => h('li', { class: 'channel-row thread' },
    h('button', {
      class: `side-item channel thread${t.id === state.channelId ? ' active' : ''}${t.unread ? ' unread' : ''}`,
      title: t.name,
      onclick: () => selectChannel(t.id),
    }, h('span', { class: 'thread-branch', 'aria-hidden': 'true' }), h('span', { class: 'truncate' }, t.name), badge(t.mentions)),
    gear(t));
  const vs = voiceState();

  body.replaceChildren(...[
    h('div', { class: 'section-title' },
      h('span', {}, 'Canais de texto'),
      manage ? h('button', { class: 'icon-btn small', title: 'Criar canal', onclick: () => createChannelDialog('text') }, '+') : null),
    h('ul', { class: 'side-list' }, text.flatMap((c) => [h('li', { class: 'channel-row' },
      h('button', {
        class: `side-item channel${c.id === state.channelId ? ' active' : ''}${c.unread ? ' unread' : ''}`,
        onclick: () => selectChannel(c.id),
      }, h('span', { class: 'hash' }, '#'), h('span', { class: 'truncate' }, c.name), badge(c.mentions)),
      gear(c)), ...threadsOf(c.id).map(threadRow)])),
    voiceChannels.length || manage ? h('div', { class: 'section-title' },
      h('span', {}, 'Canais de voz'),
      manage ? h('button', { class: 'icon-btn small', title: 'Criar canal de voz', onclick: () => createChannelDialog('voice') }, '+') : null) : null,
    h('ul', { class: 'side-list' }, voiceChannels.map((c) => {
      const people = (state.detail.voice && state.detail.voice[c.id]) || [];
      const connectedHere = vs.channelId === c.id;
      return h('li', { class: 'channel-row voice' },
        h('button', {
          class: `side-item channel voice${c.id === state.channelId ? ' active' : ''}${connectedHere ? ' connected' : ''}`,
          title: connectedHere ? 'Você está aqui' : 'Clique para entrar',
          onclick: () => openVoiceChannel(c),
        }, h('span', { class: 'hash' }, '🔊'), h('span', { class: 'truncate' }, c.name)),
        gear(c),
        people.length ? h('ul', { class: 'voice-people' }, people.map((p) => {
          const m = memberById(p.userId);
          if (!m) return null;
          return h('li', { class: 'voice-person' },
            avatar(m, { size: 'xs' }),
            h('span', { class: 'truncate' }, m.displayName),
            h('span', { class: 'vp-icons' },
              p.screen ? h('span', { title: 'Compartilhando a tela', class: 'live' }, 'AO VIVO') : null,
              p.video ? h('span', { title: 'Câmera ligada' }, '📹') : null,
              p.deafened ? h('span', { title: 'Ensurdecido' }, '🙉') : p.muted ? h('span', { title: 'Mutado' }, '🔇') : null));
        })) : null);
    })),
  ].filter(Boolean));
}

// Threads aparecem na lista enquanto estão ativas (última semana), com algo
// não lido ou abertas agora. As antigas continuam acessíveis pela mensagem de origem.
function threadVisible(t) {
  if (t.id === state.channelId || t.unread) return true;
  return Date.now() - new Date(t.lastMessageAt || 0) < 7 * 24 * 3600 * 1000;
}

// Clicar num canal de voz: abre a tela dele e entra (se ainda não estiver nele).
function openVoiceChannel(channel) {
  selectChannel(channel.id);
  if (voiceState().channelId !== channel.id) {
    joinVoice({ channelId: channel.id, channelName: channel.name, serverId: state.view, serverName: state.detail.server.name });
  }
}

function onVoiceChange() {
  renderVoicePanel($('#voice-panel'));
  if (state.view !== 'home' && state.detail) {
    renderSidebar();
    const c = currentChannel();
    if (c && c.kind === 'voice') renderMain();
  }
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
        avatar(dm.user, { size: 'xs', online: dm.user.online ? presenceOf(dm.user) : 'offline' }), h('span', { class: 'truncate' }, dm.user.displayName)),
    );
  } else if (channel && channel.kind === 'thread') {
    const parent = state.detail.channels.find((c) => c.id === channel.parentChannelId);
    title.replaceChildren(
      parent ? h('button', { class: 'crumb', onclick: () => selectChannel(parent.id) }, h('span', { class: 'hash' }, '#'), h('span', { class: 'truncate' }, parent.name)) : null,
      parent ? h('span', { class: 'crumb-sep' }, '›') : null,
      h('span', { class: 'hash thread-icon' }, '🧵'), h('span', { class: 'truncate' }, channel.name),
    );
  } else {
    title.replaceChildren(h('span', { class: 'hash' }, channel && channel.kind === 'voice' ? '🔊' : '#'), h('span', { class: 'truncate' }, channel ? channel.name : ''));
  }
  const textual = !!state.channelId && !(channel && channel.kind === 'voice');
  $('#btn-pins').hidden = !textual;
  $('#btn-toggle-members').hidden = state.view === 'home';
  $('#search-input').placeholder = state.view === 'home'
    ? (dm ? `Buscar com @${dm.user.username}` : 'Buscar nas conversas')
    : `Buscar em ${state.detail ? state.detail.server.name : 'servidor'}`;
}

function renderMain() {
  const friendsPage = state.view === 'home' && !state.channelId;
  const channel = currentChannel();
  const voicePage = !!channel && channel.kind === 'voice';
  $('#friends-page').hidden = !friendsPage;
  $('#voice-stage').hidden = !voicePage;
  $('#messages').hidden = friendsPage || voicePage;
  $('#app').classList.toggle('home-view', state.view === 'home');
  if (friendsPage) renderFriendsPage($('#friends-page'));
  else if (voicePage) {
    renderStage($('#voice-stage'), {
      channel,
      serverId: state.view,
      serverName: state.detail.server.name,
      others: (state.detail.voice && state.detail.voice[channel.id]) || [],
      members: state.detail.members,
    });
  } else renderMessages(); // cores/permissões podem ter mudado
}

// ---------------------------------------------------------------- Membros

function renderMembers() {
  const panel = $('#member-list');
  if (state.view === 'home' || !state.detail) return panel.replaceChildren();
  const ownerId = state.detail.server.ownerId;
  const online = state.detail.members.filter((m) => m.online);
  const offline = state.detail.members.filter((m) => !m.online);
  const statusLine = (m) => (m.statusText ? h('span', { class: 'member-status truncate' }, m.statusText) : null);
  const group = (title, members, isOnline) => (members.length === 0 ? null
    : h('div', { class: 'member-group' },
      h('div', { class: 'section-title' }, `${title} — ${members.length}`),
      members.map((m) => {
        const color = roleColor(m.id);
        return h('button', { class: `member${isOnline ? '' : ' off'}`, title: `@${m.username}`, onclick: (e) => openProfile(e.currentTarget, m) },
          avatar(m, { size: 'sm', online: isOnline ? presenceOf(m) : 'offline' }),
          h('span', { class: 'member-info' },
            h('span', { class: 'member-name' },
              h('span', { class: 'name truncate', style: color ? `color:${color}` : null }, m.displayName),
              m.isBot ? botTag() : null,
              m.id === ownerId ? h('span', { class: 'owner-badge', title: 'Dono do servidor' }, '👑') : null),
            isOnline ? statusLine(m) : null));
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
    // Uma mensagem "enviando…" que já está no histórico (a confirmação se perdeu numa queda):
    // fica só a verdadeira.
    bucket.items = bucket.items.filter((t) => !(t.pending || t.failed) || !messages.some((m) =>
      m.author.id === state.me.id && m.content === t.content
      && Math.abs(new Date(m.createdAt) - new Date(t.createdAt)) < 2 * 60 * 1000));
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
    nodes.push(cached('top', `start|${dm ? dm.user.displayName : channel && channel.name}|${dm && dm.user.avatarUrl}`, () => {
      if (dm) {
        return h('div', { class: 'channel-start' }, avatar(dm.user, { size: 'lg' }), h('h2', {}, dm.user.displayName),
          h('p', { class: 'muted' }, `Este é o começo da sua conversa com @${dm.user.username}.`));
      }
      if (channel && channel.kind === 'thread') {
        const parent = state.detail.channels.find((c) => c.id === channel.parentChannelId);
        return h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, '🧵'),
          h('h2', {}, channel.name),
          h('p', { class: 'muted' }, parent ? `Thread criada a partir de uma mensagem em #${parent.name}. ` : 'Thread. ',
            parent && channel.parentMessageId
              ? h('button', { class: 'link', onclick: () => jumpToMessage(parent.id, channel.parentMessageId) }, 'Ver mensagem original')
              : null));
      }
      return h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, '#'),
        h('h2', {}, `Bem-vindo a #${channel ? channel.name : ''}!`),
        h('p', { class: 'muted' }, 'Este é o começo do canal.'));
    }));
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
    const grouped = !!prev && !newDay && prev.author.id === m.author.id && !prev.failed && !m.replyTo &&
      date - new Date(prev.createdAt) < 7 * 60 * 1000;
    const replying = !!(state.replyTo && state.replyTo.message.id === m.id);
    const sig = [m._v || 0, grouped, !!m.pending, !!m.failed, state.editingId === m.id, replying, view].join('|');
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

// Em DM qualquer um fixa; em servidor precisa de "Gerenciar mensagens".
const canPin = () => state.view === 'home' || can(P.MANAGE_MESSAGES);

// Dados mais recentes de um usuário (nome/foto podem ter mudado depois da mensagem).
function freshUser(u) {
  if (!u || u.id == null) return u;
  if (u.id === state.me.id) return { ...u, displayName: state.me.displayName, avatarUrl: state.me.avatarUrl };
  const m = memberById(u.id);
  if (m) return m;
  const dm = state.dms.find((d) => d.user.id === u.id);
  return dm ? dm.user : u;
}

// A linha "↱ Fulano: texto" acima de uma resposta.
function buildReplyRef(m) {
  const r = m.replyTo;
  if (r.deleted) return h('div', { class: 'reply-ref deleted' }, h('span', { class: 'reply-spine' }), h('em', {}, 'A mensagem original foi apagada'));
  const author = freshUser(r.author);
  const color = (r.author.id && roleColor(r.author.id)) || null;
  const text = r.content ? r.content.replace(/\s+/g, ' ') : (r.hasAttachments ? '📎 Clique para ver o anexo' : '');
  return h('button', { class: 'reply-ref', type: 'button', title: 'Ir para a mensagem', onclick: () => jumpToMessage(m.channelId, r.id) },
    h('span', { class: 'reply-spine' }),
    avatar(author, { size: 'xxs' }),
    h('strong', { style: color ? `color:${color}` : null }, `@${author.displayName}`),
    h('span', { class: 'reply-text truncate' }, text));
}

// O "chip" de thread embaixo da mensagem de origem.
function buildThreadChip(m) {
  const t = m.thread;
  const last = t.lastAt ? new Date(t.lastAt) : null;
  return h('button', { class: 'thread-chip', type: 'button', onclick: () => selectChannel(t.id) },
    h('span', { class: 'thread-icon' }, '🧵'),
    h('strong', { class: 'truncate' }, t.name),
    h('span', { class: 'link' }, t.messageCount === 1 ? '1 mensagem' : `${t.messageCount} mensagens`),
    last ? h('span', { class: 'muted' }, `· ${fullTime(last)}`) : null);
}

function buildMessage(m, grouped) {
  const date = new Date(m.createdAt);
  const mine = m.author.id === state.me.id;
  const mentionsMe = !mine && (m.mentions.includes(state.me.id) || m.mentionEveryone);
  const editing = state.editingId === m.id;
  const authorUser = freshUser(m.author);

  const left = grouped
    ? h('span', { class: 'msg-time hover', title: fullTime(date) }, formatTime(date))
    : h('button', { class: 'avatar-btn', onclick: (e) => openProfile(e.currentTarget, authorUser) }, avatar(authorUser));

  const body = h('div', { class: 'msg-body' });
  if (!grouped) {
    const color = roleColor(m.author.id) || `hsl(${hueFor(m.author.id)} 75% 72%)`;
    body.append(h('div', { class: 'msg-head' },
      h('button', { class: 'msg-author', style: `color:${color}`, onclick: (e) => openProfile(e.currentTarget, authorUser) }, m.author.displayName),
      m.author.isBot ? botTag() : null,
      h('span', { class: 'msg-time', title: fullTime(date) }, fullTime(date)),
      m.pinnedAt ? h('span', { class: 'pin-mark', title: 'Mensagem fixada' }, '📌') : null));
  } else if (m.pinnedAt) {
    body.append(h('span', { class: 'pin-mark floating', title: 'Mensagem fixada' }, '📌'));
  }

  if (editing) body.append(buildEditor(m));
  else if (m.content) {
    body.append(h('div', { class: `msg-text${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${isJumboEmoji(m.content) ? ' jumbo' : ''}` },
      renderMarkdown(m.content, renderContent),
      m.editedAt ? h('span', { class: 'edited', title: fullTime(new Date(m.editedAt)) }, ' (editado)') : null));
  }

  if (m.poll) body.append(buildPoll(m));
  if (m.attachments.length) body.append(h('div', { class: 'attachments' }, m.attachments.map((a) => buildAttachment(a, m.pending))));
  if (m.embeds && m.embeds.length && !editing) body.append(h('div', { class: 'embeds' }, m.embeds.map(buildEmbed)));
  if (m.failed) body.append(h('div', { class: 'msg-failed' }, 'Não foi enviada.'));
  if (m.reactions.length) body.append(buildReactions(m));
  if (m.thread) body.append(buildThreadChip(m));

  const repliesToMe = !mine && m.replyTo && !m.replyTo.deleted && m.replyTo.author && m.replyTo.author.id === state.me.id;
  const replying = !!(state.replyTo && state.replyTo.message.id === m.id);
  const el = h('div', {
    class: `msg ${grouped ? 'grouped' : 'first'}${mentionsMe || repliesToMe ? ' mentioned' : ''}${editing ? ' editing' : ''}${replying ? ' replying' : ''}${m.replyTo ? ' has-reply' : ''}`,
    dataset: { id: m.id },
  }, m.replyTo ? buildReplyRef(m) : null, h('div', { class: 'msg-left' }, left), body);

  if (!m.pending && !m.failed && !editing) {
    const tools = [];
    const channel = currentChannel();
    if (can(P.ADD_REACTIONS)) tools.push(h('button', { class: 'tool', title: 'Reagir', onclick: (e) => openEmojiPicker(e.currentTarget, (emoji) => toggleReaction(m, emoji, true)) }, '😀'));
    if (can(P.SEND_MESSAGES)) tools.push(h('button', { class: 'tool', title: 'Responder', onclick: () => setReply(m) }, '↩️'));
    if (channel && channel.kind === 'text' && can(P.SEND_MESSAGES)) {
      tools.push(h('button', { class: 'tool', title: m.thread ? 'Abrir thread' : 'Criar thread', onclick: () => (m.thread ? selectChannel(m.thread.id) : createThreadDialog(m)) }, '🧵'));
    }
    if (canPin()) tools.push(h('button', { class: 'tool', title: m.pinnedAt ? 'Desafixar' : 'Fixar', onclick: () => togglePin(m) }, m.pinnedAt ? '📍' : '📌'));
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
  if (a.voice && !pending && !a.local) return voicePlayer(a);
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

// ---------------------------------------------------------------- Prévia de links

function buildEmbed(e) {
  const scroll = () => { if (stickToBottom) $('#messages').scrollTop = $('#messages').scrollHeight; };
  if (e.type === 'image') {
    const img = h('img', { src: e.image, alt: '', loading: 'lazy', class: 'embed-only-img' });
    img.addEventListener('load', scroll);
    return h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'embed-image-link' }, img);
  }
  const image = e.image ? h('img', { src: e.image, alt: '', loading: 'lazy' }) : null;
  if (image) image.addEventListener('load', scroll);
  let media = null;
  if (e.youtubeId && image) {
    media = h('button', { class: 'embed-video', type: 'button', title: 'Assistir aqui' }, image, h('span', { class: 'play' }, '▶'));
    media.addEventListener('click', () => {
      media.replaceWith(h('iframe', {
        class: 'embed-iframe',
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.youtubeId)}?autoplay=1`,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
        title: e.title || 'YouTube',
      }));
    });
  } else if (image && e.largeImage) {
    media = h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'embed-large' }, image);
  }
  return h('div', { class: `embed${!media && image ? ' with-thumb' : ''}`, style: e.color ? `--embed-color:${e.color}` : null },
    h('div', { class: 'embed-body' },
      e.siteName ? h('div', { class: 'embed-site' }, e.siteName) : null,
      e.title ? h('a', { class: 'embed-title', href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, e.title) : null,
      e.description ? h('div', { class: 'embed-desc' }, e.description) : null,
      media),
    !media && image ? h('a', { class: 'embed-thumb', href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, image) : null);
}

// ---------------------------------------------------------------- Enquetes

function timeLeft(date) {
  const ms = new Date(date) - Date.now();
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} dias`;
}

function buildPoll(m) {
  const p = m.poll;
  const ended = p.ended || new Date(p.endsAt) <= new Date();
  const mine = new Set(p.options.filter((o) => o.users.includes(state.me.id)).map((o) => o.id));
  const voted = mine.size > 0;
  const showResults = voted || ended;
  const maxVotes = Math.max(0, ...p.options.map((o) => o.users.length));
  const canEnd = !ended && (m.author.id === state.me.id || (state.view !== 'home' && can(P.MANAGE_MESSAGES)));
  const users = new Map([...knownUsers().values()].map((u) => [u.id, u]));
  const vote = async (optionId) => {
    let next;
    if (p.multi) next = mine.has(optionId) ? [...mine].filter((id) => id !== optionId) : [...mine, optionId];
    else next = mine.has(optionId) ? [] : [optionId];
    try { await api(`/messages/${m.id}/poll`, { method: 'PUT', body: { optionIds: next } }); } catch (err) { toast(err.message); }
  };
  const left = timeLeft(p.endsAt);
  return h('div', { class: `poll${ended ? ' ended' : ''}` },
    h('div', { class: 'poll-q' }, p.question),
    h('div', { class: 'poll-sub muted' }, ended ? 'Enquete encerrada' : p.multi ? 'Escolha uma ou mais opções' : 'Escolha uma opção'),
    h('div', { class: 'poll-options' }, p.options.map((o) => {
      const n = o.users.length;
      const pct = p.totalVoters ? Math.round((n / p.totalVoters) * 100) : 0;
      const winner = ended && n > 0 && n === maxVotes;
      const names = o.users.map((id) => (users.get(id) || {}).displayName).filter(Boolean);
      return h('button', {
        type: 'button',
        class: `poll-opt${mine.has(o.id) ? ' mine' : ''}${winner ? ' winner' : ''}${showResults ? ' results' : ''}`,
        disabled: ended || m.pending,
        title: showResults && names.length ? names.join(', ') : null,
        onclick: () => vote(o.id),
      },
      showResults ? h('span', { class: 'poll-bar', style: `width:${pct}%` }) : null,
      h('span', { class: `poll-check${p.multi ? ' square' : ''}` }, mine.has(o.id) ? '✓' : ''),
      h('span', { class: 'poll-text' }, o.text, winner ? ' 🏆' : ''),
      showResults ? h('span', { class: 'poll-count' }, `${n} · ${pct}%`) : null);
    })),
    h('div', { class: 'poll-foot muted' },
      `${p.totalVoters} ${p.totalVoters === 1 ? 'voto' : 'votos'}`,
      ended ? ' · encerrada' : left ? ` · termina em ${left}` : '',
      voted && !ended ? ' · clique de novo para tirar o voto' : '',
      canEnd ? h('button', {
        class: 'link small', type: 'button',
        onclick: () => confirmDialog({
          title: 'Encerrar enquete', text: 'Ninguém mais vai poder votar.', okLabel: 'Encerrar',
          onConfirm: () => api(`/messages/${m.id}/poll/end`, { method: 'POST' }),
        }),
      }, ' Encerrar agora') : null));
}

function createPollDialog() {
  if (!state.channelId) return;
  const question = h('input', { maxlength: '300', placeholder: 'Ex.: Que horas a gente joga?' });
  const list = h('div', { class: 'poll-edit-options' });
  const addOption = (value = '') => {
    if (list.children.length >= 10) return toast('No máximo 10 opções.');
    const input = h('input', { maxlength: '80', placeholder: `Opção ${list.children.length + 1}`, value });
    const row = h('div', { class: 'poll-edit-row' }, input,
      h('button', { class: 'icon-btn small', type: 'button', title: 'Remover', onclick: () => { if (list.children.length > 2) row.remove(); } }, '✕'));
    list.append(row);
    return input;
  };
  addOption(); addOption();
  const duration = h('select', {},
    [[1, '1 hora'], [4, '4 horas'], [8, '8 horas'], [24, '1 dia'], [72, '3 dias'], [168, '1 semana']]
      .map(([v, label]) => h('option', { value: String(v), selected: v === 24 }, label)));
  const multi = h('input', { type: 'checkbox', class: 'switch' });
  openDialog({
    title: '📊 Criar enquete',
    body: h('div', { class: 'poll-editor' },
      h('label', { class: 'field' }, 'Pergunta', question),
      h('div', { class: 'field' }, 'Opções', list,
        h('button', { class: 'btn small', type: 'button', onclick: () => { const i = addOption(); if (i) i.focus(); } }, '+ Adicionar opção')),
      h('div', { class: 'poll-edit-bottom' },
        h('label', { class: 'field' }, 'Duração', duration),
        h('label', { class: 'switch-row' }, multi, h('span', {}, 'Permitir várias respostas')))),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Publicar', kind: 'primary', submit: true,
        onClick: async () => {
          const options = [...list.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
          if (!question.value.trim()) throw new Error('Escreva a pergunta.');
          if (options.length < 2) throw new Error('Preencha pelo menos 2 opções.');
          await api(`/channels/${state.channelId}/messages`, {
            method: 'POST',
            body: { content: '', poll: { question: question.value.trim(), options, multi: multi.checked, durationHours: Number(duration.value) } },
          });
        },
      },
    ],
  });
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
  const ch = currentChannel();
  const show = !!state.channelId && !(ch && ch.kind === 'voice');
  $('#composer-area').hidden = !show;
  if (!show) return;
  const allowed = can(P.SEND_MESSAGES);
  input.disabled = !allowed;
  $('#composer').classList.toggle('disabled', !allowed);
  $('#btn-attach').hidden = !allowed;
  $('#btn-voice').hidden = !allowed || !can(P.ATTACH_FILES) || !canRecord() || !!state.recording;
  const dm = currentDm();
  const channel = currentChannel();
  input.placeholder = !allowed
    ? 'Você não tem permissão para enviar mensagens aqui.'
    : dm ? `Conversar com @${dm.user.username}`
      : channel && channel.kind === 'thread' ? `Conversar em 🧵 ${channel.name}` : `Conversar em #${channel ? channel.name : ''}`;
  renderUploads();
  renderReplyBar();
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
  if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); setReply(null); return; }
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
  const reply = state.replyTo && state.replyTo.channelId === channelId ? state.replyTo.message : null;
  const temp = {
    id: `tmp-${nonce}`, nonce, pending: true, channelId, serverId: state.view === 'home' ? null : state.view,
    content, createdAt: new Date().toISOString(), author: state.me, mentions: [], mentionEveryone: false,
    reactions: [], attachments: ups.map((u) => ({ ...u.attachment, local: true })),
    replyTo: reply ? { id: reply.id, content: reply.content.slice(0, 120), hasAttachments: reply.attachments.length > 0, author: reply.author } : null,
    thread: null, pinnedAt: null,
  };
  const attachmentIds = ups.map((u) => u.attachment.id);
  bucketFor(channelId).items.push(temp);
  input.value = '';
  autoResize();
  clearUploads();
  hideAutocomplete();
  setReply(null, { render: false });
  lastTypingSent = 0;
  renderMessages({ stick: 'always' });

  const payload = { channelId, content, attachmentIds, nonce, ...(reply ? { replyToId: reply.id } : {}) };
  state.socket.timeout(15000).emit('message:send', payload, (err, res) => {
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

$('#btn-attach').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { label: '📎  Enviar arquivo', hidden: !can(P.ATTACH_FILES), onClick: () => $('#file-input').click() },
  { label: '📊  Criar enquete', onClick: createPollDialog },
  { label: '🎤  Mensagem de voz', hidden: !can(P.ATTACH_FILES) || !canRecord(), onClick: beginRecording },
]));
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

// ---------------------------------------------------------------- Mensagem de voz

state.recording = null; // { rec, channelId, timer }

$('#btn-voice').addEventListener('click', () => beginRecording());

async function beginRecording() {
  if (state.recording || !state.channelId) return;
  if (!can(P.ATTACH_FILES) || !can(P.SEND_MESSAGES)) return toast('Você não pode enviar áudio aqui.');
  const channelId = state.channelId;
  const time = h('span', { class: 'rec-time' }, '0:00');
  const bars = h('div', { class: 'rec-wave' });
  const bar = $('#recorder');
  bar.replaceChildren(
    h('button', { class: 'icon-btn rec-cancel', type: 'button', title: 'Cancelar (Esc)', onclick: () => stopRecording(false) }, '🗑️'),
    h('span', { class: 'rec-dot' }), time, bars,
    h('button', { class: 'btn primary rec-send', type: 'button', title: 'Enviar (Enter)', onclick: () => stopRecording(true) }, 'Enviar ➤'));
  try {
    const rec = await startRecording({
      onTick: (elapsed, levels) => {
        time.textContent = formatDuration(elapsed);
        const last = levels.slice(-40);
        const peak = Math.max(0.02, ...levels);
        bars.replaceChildren(...last.map((v) => h('i', { style: `height:${Math.max(8, Math.round(Math.sqrt(v / peak) * 100))}%` })));
        if (elapsed > MAX_VOICE_MS - 10000) time.classList.add('warn');
      },
      onAutoStop: () => stopRecording(true),
    });
    state.recording = { rec, channelId };
    $('#composer').hidden = true;
    bar.hidden = false;
    bar.querySelector('.rec-send').focus();
    renderComposerState();
  } catch (err) {
    toast(err.message);
  }
}

async function stopRecording(send) {
  const cur = state.recording;
  if (!cur) return;
  state.recording = null;
  $('#recorder').hidden = true;
  $('#composer').hidden = false;
  renderComposerState();
  if (!send) { cur.rec.cancel(); return; }
  const result = await cur.rec.stop();
  if (!result || result.durationMs < 700 || !result.blob.size) return toast('Áudio curto demais.');
  const ext = result.blob.type.includes('mp4') || result.blob.type.includes('aac') ? 'm4a' : result.blob.type.includes('ogg') ? 'ogg' : 'webm';
  const file = new File([result.blob], `mensagem-de-voz.${ext}`, { type: result.blob.type });
  toast('Enviando áudio…');
  try {
    const att = await uploadFile(file, () => {}, { 'X-Voice-Duration': String(result.durationMs), 'X-Voice-Waveform': result.waveform });
    const res = await new Promise((resolve) => state.socket.timeout(15000).emit('message:send', {
      channelId: cur.channelId, content: '', attachmentIds: [att.id], nonce: `v${Date.now().toString(36)}`,
    }, (err, r) => resolve(err ? { ok: false } : r)));
    if (!res || !res.ok) throw new Error((res && res.error) || 'Não foi possível enviar o áudio.');
  } catch (err) {
    toast(err.message);
  }
}

document.addEventListener('keydown', (e) => {
  if (!state.recording || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { e.preventDefault(); stopRecording(false); }
  if (e.key === 'Enter') { e.preventDefault(); stopRecording(true); }
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
  const friendship = friendStatus(user.id);
  const source = member || user;
  const online = source.online;
  const status = isMe ? state.me.status : presenceOf(source);
  const statusText = isMe ? state.me.statusText : (online ? source.statusText : null);

  const actions = [];
  if (!isMe) {
    actions.push(h('button', { class: 'btn primary', onclick: () => openDm(user.id) }, 'Enviar mensagem'));
    if (user.isBot) {
      // bots não fazem amizade
    } else if (!friendship) {
      actions.push(h('button', {
        class: 'btn', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api('/friends', { method: 'POST', body: { username: user.username } }); toast('Pedido de amizade enviado!'); closePopover(); } catch (err) { toast(err.message); }
        },
      }, 'Adicionar amigo'));
    } else if (friendship === 'incoming') {
      actions.push(h('button', {
        class: 'btn', onclick: async () => {
          try { await api(`/friends/${user.id}/accept`, { method: 'POST' }); toast('Agora vocês são amigos!'); closePopover(); } catch (err) { toast(err.message); }
        },
      }, 'Aceitar amizade'));
    } else if (friendship === 'outgoing') {
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
    h('div', { class: 'profile-avatar' }, avatar(freshUser(user), { size: 'xl', online: online === undefined && !isMe ? undefined : (isMe ? status : (online ? status : 'offline')) })),
    h('div', { class: 'profile-body' },
      h('h3', { style: color ? `color:${color}` : null }, freshUser(user).displayName, user.isBot ? botTag() : null),
      h('div', { class: 'muted' }, `@${user.username}`),
      statusText ? h('div', { class: 'profile-status' }, statusText) : null,
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
    { label: '➕  Criar canal', hidden: !can(P.MANAGE_CHANNELS), onClick: () => createChannelDialog('text') },
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

function createChannelDialog(kind = 'text') {
  let chosen = kind === 'voice' ? 'voice' : 'text';
  const name = h('input', { placeholder: 'novo-canal', maxlength: '100' });
  const option = (value, icon, label, desc) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'kind', value, checked: chosen === value, onchange: () => { chosen = value; } }),
    h('span', { class: 'kind-icon' }, icon),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));
  openDialog({
    title: 'Criar canal',
    body: h('div', {},
      h('div', { class: 'kind-options' },
        option('text', '#', 'Texto', 'Mensagens, imagens, emojis e arquivos'),
        option('voice', '🔊', 'Voz', 'Conversa por voz, câmera e tela')),
      h('label', { class: 'field' }, 'Nome do canal', name)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar canal', kind: 'primary', submit: true,
        onClick: async () => {
          if (!name.value.trim()) throw new Error('Dê um nome ao canal.');
          const { channel } = await api(`/servers/${state.view}/channels`, { method: 'POST', body: { name: name.value.trim(), kind: chosen } });
          await refreshDetail();
          await selectChannel(channel.id);
        },
      },
    ],
  });
}

function editChannelDialog(channel) {
  const thread = channel.kind === 'thread';
  const input2 = h('input', { value: channel.name, maxlength: '100' });
  openDialog({
    title: thread ? 'Editar thread' : 'Editar canal',
    body: h('label', { class: 'field' }, thread ? 'Nome da thread' : 'Nome do canal', input2),
    actions: [
      {
        label: thread ? 'Apagar thread' : 'Apagar canal', kind: 'danger-ghost',
        onClick: () => {
          confirmDialog({
            title: thread ? `Apagar a thread "${channel.name}"` : `Apagar #${channel.name}`,
            text: thread ? 'Todas as mensagens da thread serão apagadas para sempre.'
              : 'Todas as mensagens deste canal (e das threads dele) serão apagadas para sempre.',
            okLabel: thread ? 'Apagar thread' : 'Apagar canal',
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
    }, avatar(f, { size: 'sm', online: f.online ? presenceOf(f) : 'offline' }), h('strong', {}, f.displayName), h('span', { class: 'muted' }, `@${f.username}`)))),
    actions: [{ label: 'Fechar' }],
  });
}

// ================================================================ Painel do usuário

function renderUserPanel() {
  $('#me-avatar').replaceChildren(avatar(state.me, { size: 'sm', online: state.me.status || 'online' }));
  $('#me-name').textContent = state.me.displayName;
  $('#me-username').textContent = state.me.statusText || `@${state.me.username}`;
  $('#me-username').title = state.me.statusText ? `@${state.me.username} • ${state.me.statusText}` : '';
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

const STATUS_MENU = [
  ['online', '🟢', 'Online'],
  ['idle', '🌙', 'Ausente'],
  ['dnd', '⛔', 'Não perturbe (sem sons nem avisos)'],
  ['invisible', '⚫', 'Invisível (aparece offline)'],
];

$('#me-info').addEventListener('click', (e) => openMenu(e.currentTarget, [
  ...STATUS_MENU.map(([value, icon, label]) => ({
    label: `${icon}  ${label}${state.me.status === value ? '  ✓' : ''}`,
    onClick: () => saveMe({ status: value }),
  })),
  { label: state.me.statusText ? '💬  Editar status personalizado' : '💬  Definir status personalizado', onClick: editStatusText },
  { separator: true },
  { label: '⚙️  Configurações', onClick: () => openUserSettings() },
  { label: '🖼️  Mudar foto de perfil', onClick: pickAvatar },
  { label: '🗑️  Remover foto de perfil', hidden: !state.me.avatarUrl, onClick: removeAvatar },
  { label: '✏️  Mudar nome de exibição', onClick: editDisplayName },
  { label: '🤖  Desenvolvedor (bots)', onClick: () => openDeveloper() },
  { separator: true },
  { label: '🚪  Sair da conta', danger: true, onClick: logout },
]));

function applyMe(user) {
  state.me = user;
  renderUserPanel();
  if (state.channelId) renderMessages();
  refreshUserSettings();
}

async function saveMe(changes) {
  try {
    const { user } = await api('/me', { method: 'PATCH', body: changes });
    applyMe(user);
  } catch (err) {
    toast(err.message);
  }
}

const editStatusText = () => ask({
  title: 'Status personalizado',
  text: 'Aparece embaixo do seu nome. Ex.: "Jogando Minecraft", "Estudando 📚". Deixe vazio para tirar.',
  placeholder: 'O que você está fazendo?',
  value: state.me.statusText || '',
  maxLength: 80,
  okLabel: 'Salvar',
  onSubmit: async (statusText) => {
    const { user } = await api('/me', { method: 'PATCH', body: { statusText } });
    applyMe(user);
  },
});

function pickAvatar(after) {
  const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      toast('Enviando foto…');
      applyMe(await uploadAvatar(file));
      toast('Foto de perfil atualizada!');
      if (after) after();
    } catch (err) {
      toast(err.message);
    }
  });
  picker.click();
}

function removeAvatar(after) {
  confirmDialog({
    title: 'Remover foto de perfil',
    text: 'Seu avatar volta a ser as iniciais do seu nome.',
    okLabel: 'Remover',
    onConfirm: async () => { applyMe((await api('/me/avatar', { method: 'DELETE' })).user); if (after) after(); },
  });
}

const editDisplayName = (after) => ask({
  title: 'Seu nome de exibição',
  text: 'É o nome que aparece nas mensagens. O @usuário continua o mesmo.',
  value: state.me.displayName,
  maxLength: 32,
  okLabel: 'Salvar',
  onSubmit: async (displayName) => {
    const { user } = await api('/me', { method: 'PATCH', body: { displayName } });
    applyMe(user);
    if (typeof after === 'function') after();
  },
});

$('#btn-logout').addEventListener('click', () => logout());
$('#home-btn').addEventListener('click', () => goHome());

$('#btn-toggle-members').addEventListener('click', () => {
  const hidden = $('#app').classList.toggle('no-members');
  storage('nexo.hideMembers', hidden ? '1' : null);
});
$('#btn-toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));

function botTag() {
  return h('span', { class: 'bot-tag', title: 'Conta automática (bot)' }, 'BOT');
}

// ================================================================ Responder

function setReply(message, { render = true } = {}) {
  const prev = state.replyTo;
  state.replyTo = message ? { channelId: message.channelId, message } : null;
  renderReplyBar();
  if (!render) return;
  if (prev || message) renderMessages();
  if (message) input.focus();
}

function renderReplyBar() {
  const bar = $('#reply-bar');
  const r = state.replyTo;
  if (!r || r.channelId !== state.channelId) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  bar.replaceChildren(
    h('span', {}, 'Respondendo a ', h('strong', {}, freshUser(r.message.author).displayName)),
    h('button', { class: 'icon-btn small', type: 'button', title: 'Cancelar resposta (Esc)', onclick: () => setReply(null) }, '✕'),
  );
}

// Atualiza a citação nas respostas a uma mensagem (editada ou apagada).
function patchReplies(channelId, id, fn) {
  const bucket = state.messages.get(channelId);
  if (!bucket) return;
  let changed = false;
  for (const m of bucket.items) {
    if (m.replyTo && m.replyTo.id === id) {
      m.replyTo = fn(m.replyTo);
      m._v = (m._v || 0) + 1;
      changed = true;
    }
  }
  if (changed && channelId === state.channelId) renderMessages();
}

// ================================================================ Ir até uma mensagem

let jumpSeq = 0;

async function jumpToMessage(channelId, messageId) {
  const seq = ++jumpSeq;
  closePopover();
  if (state.channelId !== channelId) {
    const inServer = state.detail && state.detail.channels.some((c) => c.id === channelId);
    const isDm = state.dms.some((d) => d.channelId === channelId);
    if (inServer) await selectChannel(channelId);
    else if (isDm) await goHome(channelId);
    else return toast('Não foi possível abrir essa conversa.');
  }
  const bucket = bucketFor(channelId);
  // Vai carregando o histórico para trás até achar (no máximo ~2000 mensagens).
  for (let i = 0; i < 40 && !bucket.items.some((m) => m.id === messageId); i++) {
    if (seq !== jumpSeq || state.channelId !== channelId) return;
    if (!bucket.hasMore) break;
    if (bucket.loading) { await new Promise((r) => setTimeout(r, 100)); i--; continue; }
    await loadOlder(channelId);
  }
  if (seq !== jumpSeq || state.channelId !== channelId) return;
  const el = $(`#messages .msg[data-id="${CSS.escape(messageId)}"]`);
  if (!el) return toast('Essa mensagem não existe mais (ou é antiga demais).');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // reinicia a animação
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
}

// ================================================================ Threads

function createThreadDialog(m) {
  const suggestion = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  ask({
    title: 'Criar thread',
    text: 'Uma conversa paralela sobre essa mensagem, sem atrapalhar o canal.',
    placeholder: 'Nome da thread',
    value: suggestion,
    maxLength: 100,
    okLabel: 'Criar thread',
    onSubmit: async (name) => {
      const { channel } = await api(`/messages/${m.id}/thread`, { method: 'POST', body: { name } });
      await refreshDetail();
      await selectChannel(channel.id);
    },
  });
}

// ================================================================ Mensagens fixadas

let pinsOpenFor = null;

async function togglePin(m) {
  try {
    const { message } = await api(`/messages/${m.id}/pin`, { method: m.pinnedAt ? 'DELETE' : 'PUT' });
    updateMessage(message.channelId, message.id, message);
    toast(message.pinnedAt ? 'Mensagem fixada 📌' : 'Mensagem desafixada.');
  } catch (err) {
    toast(err.message);
  }
}

async function openPins() {
  const channelId = state.channelId;
  if (!channelId) return;
  const anchor = $('#btn-pins');
  let messages;
  try {
    ({ messages } = await api(`/channels/${channelId}/pins`));
  } catch (err) {
    return toast(err.message);
  }
  if (state.channelId !== channelId) return;
  pinsOpenFor = channelId;
  const allowed = canPin();
  openPopover(anchor, h('div', { class: 'pins' },
    h('div', { class: 'pins-title' }, '📌 Mensagens fixadas'),
    messages.length === 0
      ? h('p', { class: 'muted pins-empty' }, allowed
        ? 'Nenhuma mensagem fixada. Passe o mouse numa mensagem e clique em 📌 para fixar.'
        : 'Nenhuma mensagem fixada neste canal.')
      : h('div', { class: 'pins-list' }, messages.map((m) => resultCard(m, {
        actions: [
          h('button', { class: 'btn small', onclick: () => jumpToMessage(m.channelId, m.id) }, 'Ir'),
          allowed ? h('button', { class: 'icon-btn small', title: 'Desafixar', onclick: async () => { await togglePin(m); openPins(); } }, '✕') : null,
        ],
      })))), { align: 'end', className: 'popover-pins' });
}

$('#btn-pins').addEventListener('click', () => {
  if (pinsOpenFor === state.channelId && document.querySelector('.popover-pins')) { closePopover(); pinsOpenFor = null; return; }
  openPins();
});

// Cartão de mensagem usado nas fixadas e na busca.
function resultCard(m, { actions = [], channelLabel = null } = {}) {
  const date = new Date(m.createdAt);
  const author = freshUser(m.author);
  return h('div', { class: 'result' },
    channelLabel ? h('div', { class: 'result-channel muted' }, channelLabel) : null,
    h('div', { class: 'result-row' },
      avatar(author, { size: 'sm' }),
      h('div', { class: 'result-body' },
        h('div', { class: 'msg-head' },
          h('strong', { style: roleColor(m.author.id) ? `color:${roleColor(m.author.id)}` : null }, author.displayName),
          h('span', { class: 'msg-time' }, fullTime(date))),
        m.content ? h('div', { class: 'msg-text' }, renderMarkdown(m.content, renderContent)) : null,
        m.poll ? h('div', { class: 'muted small' }, `📊 ${m.poll.question}`) : null,
        m.attachments.length ? h('div', { class: 'muted small' }, `📎 ${m.attachments.length} anexo(s)`) : null),
      actions.length ? h('div', { class: 'result-actions' }, actions) : null));
}

// ================================================================ Busca

const search = { q: '', authorId: null, results: [], total: 0, hasMore: false, loading: false, scopeKey: '' };

function searchScope() {
  if (state.view !== 'home') return { key: `s${state.view}`, qs: `serverId=${state.view}` };
  if (state.channelId) return { key: `c${state.channelId}`, qs: `channelId=${state.channelId}` };
  return { key: 'dms', qs: 'dms=1' };
}

// "de:fulano bolo" = mensagens do @fulano com "bolo".
function parseSearch(text) {
  let authorId = null;
  let unknown = null;
  const q = text.replace(/(?:^|\s)(?:de|from):@?([a-z0-9_.]{1,32})/gi, (_, name) => {
    const u = knownUsers().get(name.toLowerCase());
    if (u) authorId = u.id; else unknown = name;
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  return { q, authorId, unknown };
}

async function runSearch(more = false) {
  const text = $('#search-input').value.trim();
  if (!text) return closeSearch();
  const { q, authorId, unknown } = parseSearch(text);
  if (unknown) return toast(`Não encontrei o usuário @${unknown}.`);
  if (!q && !authorId) return;
  const scope = searchScope();
  if (!more) Object.assign(search, { q, authorId, results: [], total: 0, hasMore: false, scopeKey: scope.key });
  search.loading = true;
  renderSearch();
  try {
    const params = new URLSearchParams({ q: search.q });
    if (search.authorId) params.set('authorId', search.authorId);
    const last = search.results.at(-1);
    if (more && last) params.set('before', last.id);
    const data = await api(`/search?${scope.qs}&${params}`);
    if (search.scopeKey !== scope.key) return;
    search.results.push(...data.messages);
    search.total = data.total;
    search.hasMore = data.hasMore;
  } catch (err) {
    toast(err.message);
  } finally {
    search.loading = false;
    renderSearch();
  }
}

function renderSearch() {
  const panel = $('#search-panel');
  panel.hidden = false;
  $('#app').classList.add('searching');
  const countText = search.loading && search.results.length === 0 ? 'Buscando…'
    : search.total === 0 ? 'Nenhum resultado'
      : search.total >= 1000 ? 'Mais de 1000 resultados' : `${search.total} ${search.total === 1 ? 'resultado' : 'resultados'}`;
  const channelName = (m) => {
    if (!m.channel) return null;
    if (m.channel.kind === 'dm') {
      const dm = state.dms.find((d) => d.channelId === m.channelId);
      return dm ? `@${dm.user.displayName}` : 'Mensagem direta';
    }
    return m.channel.kind === 'thread' ? `🧵 ${m.channel.name}` : `# ${m.channel.name}`;
  };
  panel.replaceChildren(
    h('div', { class: 'search-head' },
      h('strong', {}, countText),
      h('button', { class: 'icon-btn small', title: 'Fechar busca', onclick: closeSearch }, '✕')),
    h('div', { class: 'search-results' },
      search.results.map((m) => {
        const card = resultCard(m, { channelLabel: channelName(m) });
        card.classList.add('clickable');
        card.title = 'Ir para a mensagem';
        card.addEventListener('click', (e) => {
          if (e.target.closest('a, .mention')) return;
          openSearchResult(m);
        });
        return card;
      }),
      search.hasMore ? h('button', { class: 'btn search-more', disabled: search.loading, onclick: () => runSearch(true) }, search.loading ? 'Carregando…' : 'Carregar mais') : null,
      !search.loading && search.total === 0 ? h('p', { class: 'muted search-tip' }, 'Dica: use de:usuario para filtrar por quem escreveu. Ex.: de:ana bolo') : null),
  );
}

async function openSearchResult(m) {
  if (window.matchMedia('(max-width: 900px)').matches) closeSearch();
  if (m.serverId && state.view !== m.serverId) await selectServer(m.serverId, m.channelId);
  jumpToMessage(m.channelId, m.id);
}

function closeSearch() {
  const panel = $('#search-panel');
  if (!panel) return;
  panel.hidden = true;
  panel.replaceChildren();
  $('#app').classList.remove('searching');
  search.scopeKey = '';
}

$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.value = ''; closeSearch(); e.currentTarget.blur(); }
});
$('#search-input').addEventListener('search', (e) => { if (!e.currentTarget.value) closeSearch(); });

initVoice({ getSocket: () => state.socket, onChange: onVoiceChange });

// Funções usadas pelas outras telas (amigos, configurações).
export {
  openDm, goHome, refreshDetail, loadFriends, renderAll, selectChannel, botTag,
  applyMe, logout, pickAvatar, removeAvatar, editDisplayName, installPrompt,
};

boot();
