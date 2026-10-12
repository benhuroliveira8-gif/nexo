// Nexo — frontend (Fase 5). JavaScript puro em módulos, sem etapa de build.
import { effectiveTheme, onThemeChange } from './theme.js';
import {
  $, h, storage, api, setToken, setUnauthorizedHandler, uploadFile, formatTime, dayLabel, fullTime,
  formatSize, avatar, badge, toast, copyText, openDialog, ask, confirmDialog, openPopover,
  closePopover, openMenu, playPing, hueFor, presenceOf, STATUS_LABEL, uploadAvatar,
} from './util.js';
import { openEmojiPicker, setCustomEmojiProvider, emojiNode } from './emoji.js';
import {
  state, P, can, isOwner, myTop, memberById, memberRoles, memberTop, roleColor, roleStyle, knownUsers,
  currentDm, currentChannel, dmName,
} from './state.js';
import { renderFriendsPage } from './home.js';
import {
  openServerSettings, refreshSettings, closeServerSettings, serverIcon, inviteDialog, timeoutMenu, kickDialog, banDialog,
} from './settings.js';
import {
  initVoice, voiceState, inVoice, joinVoice, leaveVoice, resyncAfterReconnect, renderVoicePanel, renderStage,
  openVolumePopover, playSoundEvent, onStageRole, noticeVoiceStates, quietVoiceSounds,
} from './voice.js';
import { startRingtone, stopRingtone, stopRingback, isRingingBack, playBusy } from './callsounds.js';
import { quietNow, activityText, activityBlock, paintBanner, badgesRow, levelBlock } from './profile.js';
import {
  loadCommands, commandsFor, matchSlash, suggestions as commandSuggestions, parseCommand, runCommand, commandItem,
  commandLine, ephemeralMessage, forgetCommands,
} from './commands.js';
import { maybeSpeak, ttsHeaderButton, onTtsChange } from './tts.js';
import { renderForumPage, onForumChanged, postHeaderActions } from './forum.js';
import { rankingSidebarItem } from './levelsui.js';
import { readPendingShare, openShareDialog } from './share.js';
import { openAdmin } from './admin.js';
import { translateMessage, translationOf, hideTranslation, langName } from './translate.js';
import { initUpdates, onHello, onRestarting, onDisconnected, maybeReloadLater } from './updates.js';
import { openDeveloper } from './developer.js';
import { renderMarkdown, isJumbo, stripMarkdown } from './markdown.js';
import { openGifPicker, buildGif, setGifUser } from './gifs.js';
import { initEvents, loadEvents, wireEventSocket, eventsSidebarItem, openEventsPanel } from './events.js';
import {
  initMore, wireMoreSocket, openStatusDialog, openScheduleDialog, openReminderMenu, isSaved, loadSavedIds, toggleSaved,
  openListsPanel, closeListsPanel, forgetListsPanel, buildSticker, openStickerPicker, exportDialog,
} from './more.js';
import {
  createPollDialog, buildPoll, buildVoicePlayer, buildEmbeds, startRecording, canRecord, liveBars, fmtDuration,
} from './extras.js';
import { initAccount, openAccountSettings, closeAccountSettings, refreshAccountSettings } from './account.js';
import {
  registerServiceWorker, syncPushAfterLogin, forgetPushOnLogout, pushStatus, canPromptInstall, promptInstall, onPwaChange,
} from './pwa.js';
import { sortable } from './sortable.js';

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
  state.config = c;
  initUpdates({ version: c.version });
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
  $('#forgot-link').hidden = register;
  $('#recover-form').hidden = true;
  $('#auth-form').hidden = false;
  $('#auth-switch').parentElement.hidden = false;
  $('#auth-form [name=username]').focus();
}

// Esqueci a senha: chave de recuperação (que a pessoa guardou) ou código da administração.
$('#forgot-link').addEventListener('click', () => {
  $('#auth-form').hidden = true;
  $('#auth-switch').parentElement.hidden = true;
  $('#recover-form').hidden = false;
  $('#auth-title').textContent = 'Criar uma senha nova';
  $('#auth-subtitle').textContent = 'Use a sua chave de recuperação ou o código que a administração do Nexo te passou.';
  $('#recover-error').textContent = '';
  $('#recover-form [name=username]').value = $('#auth-form [name=username]').value;
  $('#recover-form [name=username]').focus();
});
$('#recover-back').addEventListener('click', () => showAuth('login'));
$('#recover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('#recover-submit');
  btn.disabled = true;
  $('#recover-error').textContent = '';
  try {
    const data = await api('/auth/recover', {
      method: 'POST',
      body: { username: form.username.value.trim().toLowerCase(), code: form.code.value, newPassword: form.newPassword.value },
    });
    form.reset();
    if (data.token) {
      beginSession(data.token, data.user);
      setTimeout(() => toast('Senha nova criada! 🔑 Crie outra chave de recuperação em Configurações → Segurança.'), 800);
    } else {
      showAuth('login');
      toast('Senha nova criada! Entre com ela (e o código do app autenticador).');
    }
  } catch (err) {
    $('#recover-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#auth-switch').addEventListener('click', () => showAuth(authMode === 'login' ? 'register' : 'login'));

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
    if (data.twoFactorRequired) {
      form.reset();
      showTwoFactor(data.ticket);
      return;
    }
    beginSession(data.token, data.user);
    form.reset();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function beginSession(token, user) {
  state.token = token;
  setToken(token);
  storage('nexo.token', token);
  start(user);
}

// Segunda etapa do login (2FA): código do app autenticador.
let twoFactorTicket = null;
function showTwoFactor(ticket) {
  twoFactorTicket = ticket;
  $('#auth-form').hidden = true;
  $('#auth-switch').parentElement.hidden = true;
  $('#twofa-form').hidden = false;
  $('#auth-title').textContent = 'Verificação em duas etapas';
  $('#auth-subtitle').textContent = 'Abra o app autenticador no celular e digite o código de 6 dígitos do Nexo.';
  $('#twofa-error').textContent = '';
  $('#twofa-form [name=code]').value = '';
  $('#twofa-form [name=code]').focus();
}
function hideTwoFactor() {
  twoFactorTicket = null;
  $('#twofa-form').hidden = true;
  $('#auth-form').hidden = false;
  $('#auth-switch').parentElement.hidden = false;
}
$('#twofa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#twofa-submit');
  btn.disabled = true;
  $('#twofa-error').textContent = '';
  try {
    const data = await api('/auth/2fa', { method: 'POST', body: { ticket: twoFactorTicket, code: $('#twofa-form [name=code]').value } });
    hideTwoFactor();
    beginSession(data.token, data.user);
    if (data.usedRecovery) setTimeout(() => toast('Você usou um código de recuperação. Ele não vale mais.'), 800);
  } catch (err) {
    $('#twofa-error').textContent = err.message;
    if (/acabou/.test(err.message)) setTimeout(() => { hideTwoFactor(); showAuth('login'); }, 1500);
  } finally {
    btn.disabled = false;
  }
});
$('#twofa-back').addEventListener('click', () => { hideTwoFactor(); showAuth('login'); });

let loggingOut = false;
async function logout({ skipServer = false } = {}) {
  if (loggingOut) return;
  loggingOut = true;
  if (inVoice()) leaveVoice();
  if (state.token && !skipServer) await Promise.race([forgetPushOnLogout(), new Promise((r) => setTimeout(r, 1500))]);
  storage('nexo.token', null);
  if (state.socket) state.socket.disconnect();
  closeServerSettings();
  closeAccountSettings();
  closePopover();
  stopRinging();
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
  loggingOut = false;
}

setUnauthorizedHandler(() => logout({ skipServer: true }));

// Senha trocada, 2FA ligado, "sair de todos": o servidor devolve um token novo para este aparelho.
function setSession(token, user) {
  state.token = token;
  setToken(token);
  storage('nexo.token', token);
  if (state.socket) {
    state.socket.auth = { token };
    if (!state.socket.connected) state.socket.connect();
  }
  if (user) applyMe(user);
}

// ================================================================ Início

async function boot() {
  // Link de convite: /convite/CODIGO
  const m = /^\/convite\/([\w-]{4,32})\/?$/.exec(location.pathname);
  if (m) sessionStorage.setItem('nexo.pendingInvite', m[1]);
  // Veio de uma notificação: /?servidor=1&canal=2&msg=3 (ou &atender=1 numa ligação).
  if (location.search) {
    const q = new URLSearchParams(location.search);
    if (q.get('canal')) sessionStorage.setItem('nexo.pendingOpen', `/?${q}`);
    // Atalhos do ícone do app (segurar o ícone) e "Compartilhar → Nexo" da galeria.
    if (q.get('atalho')) sessionStorage.setItem('nexo.pendingShortcut', q.get('atalho'));
    if (q.get('compartilhar')) sessionStorage.setItem('nexo.pendingShare', q.get('compartilhar'));
    if (q.get('admin')) sessionStorage.setItem('nexo.pendingAdmin', '1');
  }
  if (m || location.pathname !== '/' || location.search) history.replaceState(null, '', '/');
  registerServiceWorker((url) => openFromUrl(url));

  if (!state.token) return showAuth('login');
  setToken(state.token);
  for (let attempt = 0; ; attempt++) {
    try {
      const { user } = await api('/me');
      return start(user);
    } catch (err) {
      // Só sai da conta se o servidor disse que o login não vale mais.
      // Sem internet (ou servidor reiniciando), tenta de novo.
      if (err.status === 401) return logout({ skipServer: true });
      if (attempt === 0) toast('Sem conexão com o Nexo. Tentando de novo…');
      await new Promise((r) => setTimeout(r, Math.min(2000 + attempt * 1000, 10000)));
    }
  }
}

async function start(user) {
  state.me = user;
  setGifUser(user.id);
  loadSavedIds();
  $('#auth').hidden = true;
  $('#app').hidden = false;
  renderUserPanel();
  if (storage('nexo.hideMembers') === '1') $('#app').classList.add('no-members');

  connectSocket();
  await Promise.all([loadServers(), loadDms(), loadFriends(), loadMyEmojis()]);

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
  const pendingOpen = sessionStorage.getItem('nexo.pendingOpen');
  if (pendingOpen) {
    sessionStorage.removeItem('nexo.pendingOpen');
    openFromUrl(pendingOpen);
  }
  if (sessionStorage.getItem('nexo.pendingAdmin')) { sessionStorage.removeItem('nexo.pendingAdmin'); if (user.isAdmin) openAdmin(); }
  const shortcut = sessionStorage.getItem('nexo.pendingShortcut');
  if (shortcut) { sessionStorage.removeItem('nexo.pendingShortcut'); runShortcut(shortcut); }
  const share = sessionStorage.getItem('nexo.pendingShare');
  if (share) { sessionStorage.removeItem('nexo.pendingShare'); receiveShare(share); }
  syncPushAfterLogin().then(refreshPushFlag);
}

// Atalhos do ícone do app instalado.
async function runShortcut(name) {
  if (name === 'amigos') return goHome();
  if (name === 'conversas') {
    const last = Number(storage('nexo.homeChannel'));
    const dm = state.dms.find((d) => d.channelId === last) || state.dms[0];
    return goHome(dm ? dm.channelId : null);
  }
  if (name === 'salvas') return openListsPanel('saved');
  if (name === 'servidor' && state.view === 'home' && state.servers[0]) return selectServer(state.servers[0].id);
  return null;
}

// Fotos compartilhadas da galeria: escolhe a conversa e envia.
async function receiveShare(flag) {
  if (flag === 'falhou') return toast('Não deu para receber o que foi compartilhado. Tente de novo pelo app instalado.');
  const share = await readPendingShare();
  if (!share || (!share.files.length && !share.text && !share.url && !share.title)) return toast('Nada para compartilhar.');
  openShareDialog(share, {
    dms: state.dms.map((d) => ({ channelId: d.channelId, label: dmName(d) })),
    servers: state.servers.map((x) => ({ id: x.id, name: x.name })),
    send: (channelId, content, attachmentIds) => new Promise((resolve, reject) => {
      if (!content && !attachmentIds.length) return reject(new Error('Nada para enviar.'));
      state.socket.timeout(20000).emit('message:send', { channelId, content, attachmentIds }, (err, res) => {
        if (err || !res || !res.ok) reject(new Error((res && res.error) || 'Não foi possível enviar.'));
        else resolve(res.message);
      });
    }),
    open: (channelId, serverId) => (serverId ? selectServer(serverId, channelId) : goHome(channelId)),
  });
}

// Abre o lugar de uma notificação.
async function openFromUrl(url) {
  if (!state.me) { sessionStorage.setItem('nexo.pendingOpen', url); return; }
  const q = new URL(url, location.origin).searchParams;
  const channelId = Number(q.get('canal'));
  const serverId = Number(q.get('servidor'));
  const msgId = q.get('msg');
  const wantsEvents = !!q.get('eventos');
  if (!channelId && !(serverId && wantsEvents)) return;
  if (serverId) {
    if (!state.servers.some((s) => s.id === serverId)) return toast('Você não está mais nesse servidor.');
    await selectServer(serverId, channelId || undefined);
    if (wantsEvents) openEventsPanel(serverId);
  } else {
    if (!state.dms.some((d) => d.channelId === channelId)) await loadDms().catch(() => {});
    if (!state.dms.some((d) => d.channelId === channelId)) return toast('Essa conversa não existe mais.');
    await goHome(channelId);
    if (q.get('atender')) {
      const dm = currentDm();
      if (dm && dm.voice && dm.voice.length) answerCall(channelId, false);
    }
  }
  if (msgId && /^\d+$/.test(msgId)) jumpToMessage(channelId, msgId);
  // "Responder" na notificação (sem caixa de texto no aparelho): abre já pronto para escrever.
  if (q.get('responder')) setTimeout(() => { const m = msgId && (state.messages.get(channelId) || { items: [] }).items.find((x) => x.id === msgId); if (m && state.view !== 'home') setReply(m); input.focus(); }, 400);
}

// Notificações deste aparelho já chegam pelo push? Então não repetimos com o aviso do navegador.
let pushOn = false;
const refreshPushFlag = () => pushStatus().then((s) => { pushOn = s === 'on'; }).catch(() => {});
onPwaChange(refreshPushFlag);

// ================================================================ Carregar dados

// Emojis personalizados: no servidor, os dele; nas DMs, os de todos os seus servidores.
state.myEmojis = [];
async function loadMyEmojis() {
  try { state.myEmojis = (await api('/emojis')).emojis; } catch { /* sem emojis */ }
}
const loadMyEmojisSoon = debounce(loadMyEmojis, 800);
const availableEmojis = () => (state.view !== 'home' && state.detail ? state.detail.emojis || [] : state.myEmojis);
setCustomEmojiProvider(availableEmojis);

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
  if (state.view === 'home') {
    if (state.channelId && !dms.some((d) => d.channelId === state.channelId)) return goHome();
    renderSidebar();
    renderHeader();
    renderMembers();
    renderCallStage();
    renderComposerState();
    $('#app').classList.toggle('home-view', !(currentDm() && currentDm().isGroup));
  }
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
  const before = currentChannel();
  setDetail(detail, fetched.replay);
  if (!detail.channels.some((c) => c.id === state.channelId)) {
    // Post/thread apagado: volta para o fórum (ou canal) de onde ele veio.
    const parent = before && before.parentChannelId && detail.channels.find((c) => c.id === before.parentChannelId);
    if (parent) return selectChannel(parent.id);
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

let timeoutTimer = null;
function setDetail(detail, replay) {
  state.detail = detail;
  replay.forEach((fn) => fn());
  state.detailVersion++;
  syncServerFromDetail();
  // Castigo acabando: recarrega na hora certa para liberar o envio.
  clearTimeout(timeoutTimer);
  if (detail.me.timeoutUntil) {
    const ms = new Date(detail.me.timeoutUntil) - Date.now() + 1000;
    if (ms > 0 && ms < 2 ** 31) timeoutTimer = setTimeout(() => refreshDetail(), ms);
  }
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
    if (connectedBefore) quietVoiceSounds(8000);
    socket.emit('client:visible', isVisible());
    if (connectedBefore) refreshAfterReconnect();
    connectedBefore = true;
  });
  socket.on('disconnect', (reason) => {
    $('#conn-status').hidden = false;
    quietVoiceSounds(15000);
    onDisconnected();
    // O servidor derrubou a conexão (ex.: senha trocada): tenta de novo com o token atual.
    // Se o token não valer mais, o "connect_error" leva para o login.
    if (reason === 'io server disconnect' && state.token) {
      setTimeout(() => { if (state.socket === socket && state.token) { socket.auth = { token: state.token }; socket.connect(); } }, 400);
    }
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout({ skipServer: true });
    else $('#conn-status').hidden = false;
  });

  socket.on('hello', onHello);
  socket.on('server:restarting', onRestarting);
  socket.on('admin:disk', (d) => toast(`⚠️ ${d.text} Abra Administração do Nexo para limpar.`));
  socket.on('message:new', onMessageNew);
  socket.on('message:updated', (msg) => {
    updateMessage(msg.channelId, msg.id, msg);
    // Quem respondeu essa mensagem mostra o texto novo na citação.
    patchReplies(msg.channelId, msg.id, (r) => ({ ...r, content: msg.content.slice(0, 120), hasAttachments: msg.attachments.length > 0 }));
  });
  socket.on('forum:changed', ({ channelId }) => onForumChanged(channelId));
  socket.on('channel:pins', ({ channelId }) => { if (pinsOpenFor === channelId) openPins(); });
  socket.on('message:poll', ({ id, channelId, poll }) => updateMessage(channelId, id, { poll }));
  socket.on('dms:changed', () => loadDmsSoon());
  socket.on('dm:removed', ({ channelId, reason }) => {
    const dm = state.dms.find((d) => d.channelId === channelId);
    state.dms = state.dms.filter((d) => d.channelId !== channelId);
    state.messages.delete(channelId);
    if (voiceState().channelId === channelId) leaveVoice({ silent: true });
    if (reason === 'removed' && dm) toast(`Você foi removido do grupo "${dmName(dm)}".`);
    if (state.view === 'home' && state.channelId === channelId) goHome();
    else renderAll();
  });
  socket.on('call:ring', onCallRing);
  socket.on('call:declined', ({ channelId, user }) => {
    stopRinging(channelId);
    if (voiceState().channelId === channelId && user.id !== state.me.id) {
      toast(`${user.displayName} recusou a chamada.`);
      const dm = state.dms.find((d) => d.channelId === channelId);
      if (isRingingBack() && dm && !dm.isGroup) { stopRingback(); playBusy(); }
    }
  });
  socket.on('message:reactions', ({ id, channelId, reactions }) => updateMessage(channelId, id, { reactions }));
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

  wireEventSocket(socket);
  wireMoreSocket(socket);
  socket.on('voice:sound', (data) => playSoundEvent(data, memberById(data.userId) || freshUser({ id: data.userId })));
  socket.on('stage:role', (data) => onStageRole(data));

  socket.on('server:changed', ({ serverId }) => {
    if (serverId === state.view) refreshDetailSoon();
    forgetCommands(); // bots entram/saem: a lista de comandos muda
    loadServersSoon();
    loadMyEmojisSoon();
  });

  socket.on('voice:update', ({ serverId, channelId, states }) => {
    noticeVoiceStates(channelId, states);
    if (serverId === null) return onDmVoiceUpdate(channelId, states);
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
    if (s && reason === 'banned') toast(`Você foi banido de "${s.name}".`);
    if (s && reason === 'deleted') toast(`O servidor "${s.name}" foi apagado.`);
    if (state.view === serverId) {
      closeServerSettings();
      goHome();
    } else renderRail();
    updateTitle();
  });

  socket.on('friends:changed', () => { loadFriendsSoon(); loadDmsSoon(); });

  socket.on('presence', ({ userId, online, status, statusText, activity }) => {
    const p = { online, status: status || (online ? 'online' : 'offline'), statusText: statusText || null, activity: activity || null };
    applyLive(() => {
      const m = memberById(userId);
      if (m) Object.assign(m, p);
    });
    for (const list of Object.values(state.friends)) list.forEach((f) => { if (f.id === userId) Object.assign(f, p); });
    state.dms.forEach((d) => (d.users || []).forEach((u) => { if (u.id === userId) Object.assign(u, p); }));
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
  const notify = !mine && msg.kind !== 'system' && (isDm || msg.mentionEveryone || msg.mentions.includes(state.me.id));
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
  // Leitura em voz alta (se ligada neste canal).
  maybeSpeak(msg, {
    meId: state.me.id,
    authorName: (freshUser(msg.author) || msg.author).displayName,
    mentionName: (username) => { const u = knownUsers().get(username); return u ? u.displayName : username; },
  });
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
  if (silenced()) return; // "Não perturbe" (ou horário de silêncio): sem som nem aviso
  if (state.soundOn) playPing();
  // Com o push ligado, o aviso já chega pelo celular/computador; não repete.
  if (!pushOn && 'Notification' in window && window.isSecureContext && Notification.permission === 'granted' && !isVisible()) {
    const where = msg.serverId === null ? 'mensagem direta' : 'menção';
    const body = stripMarkdown(msg.content).slice(0, 120) || (msg.poll ? `📊 ${msg.poll.question}` : msg.gif ? '🎞️ GIF' : '📎 Anexo');
    try { new Notification(`${msg.author.displayName} (${where})`, { body, icon: '/icons/icon-192.png' }); } catch { /* ignora */ }
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
  const last = bucket && [...bucket.items].reverse().find((m) => !m.pending && !m.failed && !m.ephemeral);
  clearLocalUnread(channelId);
  renderBadges();
  if (!last || !state.socket) return;
  const prev = lastReadSent.get(channelId);
  if (prev && BigInt(prev) >= BigInt(last.id)) return;
  lastReadSent.set(channelId, last.id);
  state.socket.emit('channel:read', { channelId, messageId: last.id });
}

document.addEventListener('visibilitychange', () => {
  if (state.socket) state.socket.emit('client:visible', isVisible());
  if (isVisible() && state.me) scheduleMarkRead();
});

// ================================================================ Navegação

async function goHome(channelId = null) {
  if (state.view !== 'home') closeSearch();
  if (!channelId) discardVoiceOnSwitch();
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

initMore({
  applyMe: (user) => applyMe(user),
  resultCard: (m, opts) => resultCard(m, opts),
  openResult: (m) => openSearchResult(m),
  closeSearch: () => closeSearch(),
  sendSticker: (st) => sendSticker(st),
  rerenderMessages: () => { if (state.channelId) renderMessages(); },
  jumpTo: async (r) => {
    if (r.serverId && state.view !== r.serverId) await selectServer(r.serverId, r.channelId);
    else if (!r.serverId && state.view !== 'home') await goHome(r.channelId);
    jumpToMessage(r.channelId, r.messageId);
  },
});

initEvents({
  onChange: (serverId) => { if (state.view === serverId && state.detail) renderSidebar(); },
  openChannel: (serverId, channelId) => (state.view === serverId ? selectChannel(channelId) : selectServer(serverId, channelId)),
});

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
  loadEvents(serverId);

  const saved = preferredChannelId || Number(storage(`nexo.channel.${serverId}`));
  const channel = detail.channels.find((c) => c.id === saved) || detail.channels.find((c) => c.kind === 'text') || detail.channels[0];
  if (channel) await selectChannel(channel.id);
  else { state.channelId = null; renderAll(); }
}

async function selectChannel(channelId) {
  if (state.channelId !== channelId) {
    state.editingId = null;
    discardVoiceOnSwitch();
    clearUploads();
    setReply(null, { render: false });
    pinsOpenFor = null;
  }
  state.channelId = channelId;
  if (state.view === 'home') storage('nexo.homeChannel', String(channelId));
  else storage(`nexo.channel.${state.view}`, String(channelId));
  $('#app').classList.remove('sidebar-open');
  renderAll();
  if (currentChannel() && (currentChannel().kind === 'voice' || currentChannel().kind === 'forum')) return;
  loadCommands(channelId);

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
      state.dms.unshift({ channelId, isGroup: false, name: null, ownerId: null, user, users: [user], voice: [], lastMessageAt: null, unread: false, mentions: 0 });
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
      class: `rail-btn${s.id === state.view ? ' active' : ''}${s.unread ? ' unread' : ''}${s.iconUrl ? ' has-icon' : ''}`,
      title: s.name,
      onclick: () => selectServer(s.id),
    }, serverIcon(s), h('span', { class: 'badge-slot' }, badge(s.mentions) || ''));
    return btn;
  }));
}

// ---------------------------------------------------------------- Barra lateral

const collapsed = new Set(JSON.parse(storage('nexo.collapsed') || '[]'));
function toggleCategory(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  storage('nexo.collapsed', JSON.stringify([...collapsed]));
  renderSidebar();
}

// Avatar de uma conversa: a pessoa (DM) ou um ícone de grupo.
function dmAvatar(d, size = 'sm') {
  if (!d.isGroup) return avatar(d.user, { size, online: d.user.online ? presenceOf(d.user) : 'offline' });
  const hue = hueFor(d.channelId * 7 + 3);
  return h('div', { class: `avatar group ${size}`, style: `--hue:${hue}`, title: `${d.users.length + 1} pessoas` }, '👥');
}

let sidebarPending = false;
function renderSidebar() {
  // Não redesenha no meio de um arrastar (redesenha quando soltar).
  if (document.body.classList.contains('is-dragging')) {
    if (!sidebarPending) { sidebarPending = true; window.addEventListener('pointerup', () => { sidebarPending = false; setTimeout(renderSidebar, 0); }, { once: true }); }
    return;
  }
  const header = $('#sidebar-header');
  const body = $('#sidebar-body');

  if (state.view === 'home') {
    header.replaceChildren(h('span', { class: 'truncate' }, 'Mensagens diretas'));
    header.classList.remove('with-banner');
    header.style.backgroundImage = '';
    header.onclick = null;
    header.classList.remove('clickable');
    const pending = state.friends.incoming.length;
    body.replaceChildren(
      h('button', {
        class: `side-item${state.channelId === null ? ' active' : ''}`,
        onclick: () => goHome(),
      }, h('span', { class: 'side-icon' }, '👥'), h('span', { class: 'truncate' }, 'Amigos'), badge(pending)),
      h('div', { class: 'section-title' }, h('span', {}, 'Conversas'),
        h('button', { class: 'icon-btn small', title: 'Nova conversa ou grupo', onclick: newDmDialog }, '+')),
      state.dms.length === 0
        ? h('p', { class: 'muted side-empty' }, 'Nenhuma conversa ainda. Abra uma pelo perfil de alguém ou pela lista de amigos.')
        : h('ul', { class: 'side-list' }, state.dms.map((d) => h('li', {},
          h('button', {
            class: `side-item dm${d.channelId === state.channelId ? ' active' : ''}${d.unread ? ' unread' : ''}`,
            onclick: () => selectChannel(d.channelId),
          },
          dmAvatar(d),
          h('span', { class: 'dm-label' },
            h('span', { class: 'truncate' }, dmName(d)),
            d.isGroup ? h('span', { class: 'dm-sub muted truncate' }, `${d.users.length + 1} pessoas`) : null),
          d.voice && d.voice.length ? h('span', { class: 'call-dot', title: 'Chamada em andamento' }, '📞') : null,
          badge(d.mentions))))),
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
  // Capa do servidor no topo da lista de canais.
  const banner = state.detail.server.bannerUrl;
  header.classList.toggle('with-banner', !!banner);
  header.style.backgroundImage = banner ? `linear-gradient(to bottom, transparent 40%, rgba(0,0,0,.65)), url("${banner}")` : '';
  header.classList.add('clickable');
  header.onclick = () => openServerMenu(header);

  const manage = can(P.MANAGE_CHANNELS);
  const all = [...state.detail.channels].sort((a, b) => a.position - b.position || a.id - b.id);
  const categories = all.filter((c) => c.kind === 'category');
  const listed = all.filter((c) => c.kind === 'text' || c.kind === 'voice' || c.kind === 'forum');
  const catIds = new Set(categories.map((c) => c.id));
  const threadsOf = (parentId) => all
    .filter((t) => t.kind === 'thread' && t.parentChannelId === parentId && threadVisible(t))
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  const gear = (c) => (manage || (c.kind === 'thread' && c.createdBy === state.me.id)
    ? h('button', { class: 'icon-btn small channel-gear no-drag', title: c.kind === 'thread' ? 'Editar thread' : 'Editar canal', onclick: () => editChannelDialog(c) }, '⚙')
    : null);
  const threadRow = (t) => h('li', { class: 'channel-row thread' },
    h('button', {
      class: `side-item channel thread${t.id === state.channelId ? ' active' : ''}${t.unread ? ' unread' : ''}`,
      title: t.name,
      onclick: () => selectChannel(t.id),
    }, h('span', { class: 'thread-branch', 'aria-hidden': 'true' }), h('span', { class: 'truncate' }, t.name), badge(t.mentions)),
    gear(t));
  const vs = voiceState();

  const channelRow = (c) => {
    if (c.kind === 'voice') {
      const people = (state.detail.voice && state.detail.voice[c.id]) || [];
      const connectedHere = vs.channelId === c.id;
      return [h('li', { class: 'channel-row voice', dataset: { channelId: String(c.id), dragId: manage ? String(c.id) : '' } },
        h('button', {
          class: `side-item channel voice${c.id === state.channelId ? ' active' : ''}${connectedHere ? ' connected' : ''}`,
          title: connectedHere ? 'Você está aqui' : 'Clique para entrar',
          onclick: () => openVoiceChannel(c),
        }, h('span', { class: 'hash' }, c.stage ? '🎙️' : '🔊'), h('span', { class: 'truncate' }, c.name), c.private ? lockIcon() : null),
        gear(c),
        people.length ? h('ul', { class: 'voice-people' }, people.map((p) => {
          const m = memberById(p.userId);
          if (!m) return null;
          const me = p.userId === state.me.id;
          return h('li', {
            class: `voice-person${!me ? ' clickable' : ''}`,
            title: !me ? 'Clique para ajustar o volume' : null,
            onclick: !me ? (e) => openVolumePopover(e.currentTarget, m) : null,
          },
          avatar(m, { size: 'xs' }),
          h('span', { class: 'truncate' }, m.displayName),
          h('span', { class: 'vp-icons' },
            p.screen ? h('span', { title: 'Compartilhando a tela', class: 'live' }, 'AO VIVO') : null,
            p.video ? h('span', { title: 'Câmera ligada' }, '📹') : null,
            p.recording ? h('span', { title: 'Gravando a chamada', class: 'rec-dot' }, '🔴') : null,
            p.hand ? h('span', { title: 'Levantou a mão' }, '✋') : null,
            c.stage && p.speaker ? h('span', { title: 'No palco' }, '🎙️') : null,
            p.deafened ? h('span', { title: 'Ensurdecido' }, '🙉') : p.muted ? h('span', { title: 'Mutado' }, '🔇') : null));
        })) : null)];
    }
    if (c.kind === 'forum') {
      // Os posts não aparecem na lista lateral: ficam dentro do fórum.
      const posts = all.filter((t) => t.kind === 'thread' && t.parentChannelId === c.id);
      const openPost = posts.some((t) => t.id === state.channelId);
      const unread = posts.some((t) => t.unread);
      const mentions = posts.reduce((n, t) => n + (t.mentions || 0), 0);
      return [h('li', { class: 'channel-row', dataset: { channelId: String(c.id), dragId: manage ? String(c.id) : '' } },
        h('button', {
          class: `side-item channel forum-ch${c.id === state.channelId || openPost ? ' active' : ''}${unread ? ' unread' : ''}`,
          onclick: () => selectChannel(c.id),
        }, h('span', { class: 'hash' }, '💬'), h('span', { class: 'truncate' }, c.name), c.private ? lockIcon() : null, badge(mentions)),
        gear(c))];
    }
    return [h('li', { class: 'channel-row', dataset: { channelId: String(c.id), dragId: manage ? String(c.id) : '' } },
      h('button', {
        class: `side-item channel${c.id === state.channelId ? ' active' : ''}${c.unread ? ' unread' : ''}`,
        onclick: () => selectChannel(c.id),
      }, h('span', { class: 'hash', title: c.announce ? 'Canal de anúncios' : null }, c.announce ? '📢' : '#'), h('span', { class: 'truncate' }, c.name), c.private ? lockIcon() : null, badge(c.mentions)),
      gear(c)), ...threadsOf(c.id).map(threadRow)];
  };

  const blocks = [eventsSidebarItem(state.detail.server.id), rankingSidebarItem(state.detail.server.id)].filter(Boolean);
  // Canais sem categoria ficam no topo.
  const loose = listed.filter((c) => !c.categoryId || !catIds.has(c.categoryId));
  blocks.push(h('ul', { class: 'side-list cat-body', dataset: { categoryId: '' } }, loose.flatMap(channelRow),
    manage ? h('li', { class: 'drop-end', dataset: { categoryId: '', end: '1' } }) : null));
  for (const cat of categories) {
    const inside = listed.filter((c) => c.categoryId === cat.id);
    const isCollapsed = collapsed.has(cat.id);
    // Categoria fechada continua mostrando o canal aberto e os com menção.
    const shown = isCollapsed ? inside.filter((c) => c.id === state.channelId || c.mentions || (c.kind === 'voice' && (state.detail.voice || {})[c.id])) : inside;
    const unread = isCollapsed && inside.some((c) => c.unread);
    blocks.push(h('div', {
      class: `section-title category${isCollapsed ? ' collapsed' : ''}${unread ? ' unread' : ''}`,
      dataset: { categoryId: String(cat.id), dragId: manage ? String(cat.id) : '', category: '1' },
    },
    h('button', { class: 'cat-toggle', onclick: () => toggleCategory(cat.id), title: isCollapsed ? 'Abrir categoria' : 'Fechar categoria' },
      h('span', { class: 'cat-arrow' }, '▾'), h('span', { class: 'truncate' }, cat.name)),
    manage ? h('span', { class: 'cat-actions no-drag' },
      h('button', { class: 'icon-btn small', title: 'Editar categoria', onclick: () => editCategoryDialog(cat) }, '⚙'),
      h('button', { class: 'icon-btn small', title: 'Criar canal aqui', onclick: () => createChannelDialog('text', cat.id) }, '+')) : null));
    blocks.push(h('ul', { class: 'side-list cat-body', dataset: { categoryId: String(cat.id) } }, shown.flatMap(channelRow),
      manage && !isCollapsed ? h('li', { class: 'drop-end', dataset: { categoryId: String(cat.id), end: '1' } }) : null));
  }
  if (!categories.length && !loose.length) blocks.push(h('p', { class: 'muted side-empty' }, 'Nenhum canal.'));
  body.replaceChildren(...blocks);
  if (manage) enableChannelDrag(body);
}

const lockIcon = () => h('span', { class: 'lock', title: 'Canal privado' }, '🔒');

// Arrastar canais (entre categorias) e categorias (entre si).
function enableChannelDrag(body) {
  sortable(body, {
    handle: '.channel-row[data-drag-id]:not([data-drag-id=""]), .section-title.category[data-drag-id]:not([data-drag-id=""])',
    targets: '.channel-row:not(.thread), .section-title.category, .drop-end',
    canDrop: (dragEl, target, before) => {
      const draggingCategory = !!dragEl.dataset.category;
      if (draggingCategory) return !!target.dataset.category && target !== dragEl;
      if (target.dataset.end) return true;
      if (target.dataset.category) return !before; // logo abaixo do título = começo da categoria
      return true;
    },
    onDrop: async (dragEl, target, before) => {
      const id = Number(dragEl.dataset.dragId);
      let body2;
      if (dragEl.dataset.category) {
        const cats = [...$('#sidebar-body').querySelectorAll('.section-title.category')].map((x) => Number(x.dataset.categoryId)).filter((x) => x !== id);
        const tId = Number(target.dataset.categoryId);
        const idx = cats.indexOf(tId) + (before ? 0 : 1);
        body2 = { beforeId: cats[idx] || null };
      } else if (target.dataset.end) {
        body2 = { categoryId: target.dataset.categoryId ? Number(target.dataset.categoryId) : null, beforeId: null };
      } else if (target.dataset.category) {
        const catId = Number(target.dataset.categoryId);
        const first = state.detail.channels.filter((c) => c.categoryId === catId && (c.kind === 'text' || c.kind === 'voice' || c.kind === 'forum') && c.id !== id)
          .sort((a, b) => a.position - b.position || a.id - b.id)[0];
        body2 = { categoryId: catId, beforeId: first ? first.id : null };
      } else {
        const tId = Number(target.dataset.channelId);
        const t = state.detail.channels.find((c) => c.id === tId);
        const catId = t.categoryId || null;
        const siblings = state.detail.channels.filter((c) => (c.categoryId || null) === catId && (c.kind === 'text' || c.kind === 'voice' || c.kind === 'forum') && c.id !== id)
          .sort((a, b) => a.position - b.position || a.id - b.id);
        const idx = siblings.findIndex((c) => c.id === tId) + (before ? 0 : 1);
        body2 = { categoryId: catId, beforeId: siblings[idx] ? siblings[idx].id : null };
      }
      try { await api(`/channels/${id}/move`, { method: 'POST', body: body2 }); } catch (err) { toast(err.message); }
    },
  });
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
  if (!inVoice()) maybeReloadLater();
  const vs = voiceState();
  if (vs.channelId) stopRinging(vs.channelId);
  if (state.view === 'home') {
    renderHeader();
    renderCallStage();
    return;
  }
  if (state.detail) {
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
  const actions = $('#header-actions');
  actions.replaceChildren();
  if (state.view === 'home' && !state.channelId) {
    title.replaceChildren(h('span', { class: 'side-icon' }, '👥'), h('span', { class: 'truncate' }, 'Amigos'));
  } else if (dm && !dm.isGroup) {
    title.replaceChildren(
      h('button', { class: 'header-user', onclick: (e) => openProfile(e.currentTarget, dm.user) },
        avatar(dm.user, { size: 'xs', online: dm.user.online ? presenceOf(dm.user) : 'offline' }), h('span', { class: 'truncate' }, dm.user.displayName)),
    );
  } else if (dm) {
    title.replaceChildren(
      dmAvatar(dm, 'xs'),
      h('button', { class: 'header-user group-name', title: 'Mudar o nome do grupo', onclick: () => renameGroupDialog(dm) }, h('span', { class: 'truncate' }, dmName(dm))),
    );
  } else if (channel && channel.kind === 'thread') {
    const parent = state.detail.channels.find((c) => c.id === channel.parentChannelId);
    const inForum = parent && parent.kind === 'forum';
    title.replaceChildren(...[
      parent ? h('button', { class: 'crumb', onclick: () => selectChannel(parent.id) }, h('span', { class: 'hash' }, inForum ? '💬' : '#'), h('span', { class: 'truncate' }, parent.name)) : null,
      parent ? h('span', { class: 'crumb-sep' }, '›') : null,
      h('span', { class: 'hash thread-icon' }, inForum ? (channel.solved ? '✅' : '📝') : '🧵'), h('span', { class: 'truncate' }, channel.name),
    ].filter(Boolean));
    if (inForum) {
      actions.append(...postHeaderActions(channel, {
        isAuthor: channel.createdBy === state.me.id,
        canModerate: can(P.MANAGE_MESSAGES) || can(P.MANAGE_CHANNELS),
      }));
      if (channel.createdBy === state.me.id || can(P.MANAGE_CHANNELS)) {
        actions.append(h('button', { class: 'icon-btn', title: 'Renomear ou apagar o post', onclick: () => editChannelDialog(channel) }, '⚙'));
      }
    }
  } else if (channel && channel.kind === 'forum') {
    title.replaceChildren(...[h('span', { class: 'hash' }, '💬'), h('span', { class: 'truncate' }, channel.name), channel.private ? lockIcon() : null].filter(Boolean));
  } else {
    title.replaceChildren(...[h('span', { class: 'hash' }, channel && channel.kind === 'voice' ? (channel.stage ? '🎙️' : '🔊') : channel && channel.announce ? '📢' : '#'), h('span', { class: 'truncate' }, channel ? channel.name : ''),
      channel && channel.private ? lockIcon() : null].filter(Boolean));
  }
  if (dm) {
    const inThisCall = voiceState().channelId === dm.channelId;
    const callActive = dm.voice && dm.voice.length > 0;
    if (!inThisCall) {
      actions.append(
        h('button', { class: 'icon-btn call-btn', title: callActive ? 'Entrar na chamada' : 'Ligar (voz)', onclick: () => startDmCall(dm, false) }, '📞'),
        h('button', { class: 'icon-btn call-btn', title: 'Chamada de vídeo', onclick: () => startDmCall(dm, true) }, '📹'),
      );
    }
    actions.append(h('button', { class: 'icon-btn mobile-hide', title: 'Adicionar pessoas', onclick: () => addToGroupDialog(dm) }, '➕👤'));
    if (dm.isGroup) {
      actions.append(h('button', { class: 'icon-btn', title: 'Opções do grupo', onclick: (e) => groupMenu(e.currentTarget, dm) }, '⋯'));
    } else {
      actions.append(h('button', {
        class: 'icon-btn mobile-only', title: 'Mais opções',
        onclick: (e) => openMenu(e.currentTarget, [{ label: '➕  Criar grupo com mais amigos', onClick: () => addToGroupDialog(dm) }], { align: 'end', className: 'popover-menu' }),
      }, '⋯'));
    }
  }
  const textual = !!state.channelId && !(channel && (channel.kind === 'voice' || channel.kind === 'forum'));
  if (textual) {
    const label = dm ? (dm.isGroup ? `o grupo ${dmName(dm)}` : `a conversa com ${dm.user.displayName}`) : `#${channel ? channel.name : ''}`;
    const speakBtn = ttsHeaderButton(state.channelId, dm ? (dm.isGroup ? dmName(dm) : dm.user.displayName) : (channel && channel.kind === 'thread' ? channel.name : `canal ${channel ? channel.name : ''}`));
    if (speakBtn) actions.append(speakBtn);
    actions.append(h('button', { class: 'icon-btn mobile-hide', title: 'Exportar conversa', onclick: () => exportDialog(state.channelId, label) }, '📥'));
  }
  $('#btn-pins').hidden = !textual;
  $('#btn-toggle-members').hidden = !(state.view !== 'home' || (dm && dm.isGroup));
  $('#search-input').placeholder = state.view === 'home'
    ? (dm ? (dm.isGroup ? 'Buscar no grupo' : `Buscar com @${dm.user.username}`) : 'Buscar nas conversas')
    : `Buscar em ${state.detail ? state.detail.server.name : 'servidor'}`;
}

function renderMain() {
  const friendsPage = state.view === 'home' && !state.channelId;
  const channel = currentChannel();
  const voicePage = !!channel && channel.kind === 'voice';
  const forumPage = !!channel && channel.kind === 'forum';
  $('#friends-page').hidden = !friendsPage;
  $('#voice-stage').hidden = !voicePage;
  $('#forum-page').hidden = !forumPage;
  $('#messages').hidden = friendsPage || voicePage || forumPage;
  $('#app').classList.toggle('home-view', state.view === 'home' && !(currentDm() && currentDm().isGroup));
  renderCallStage();
  if (friendsPage) renderFriendsPage($('#friends-page'));
  else if (forumPage) {
    renderForumPage($('#forum-page'), channel, {
      canPost: can(P.SEND_MESSAGES),
      renderContent,
      onOpenPost: (id) => selectChannel(id),
      onCreated: async (post) => { await refreshDetail(); selectChannel(post.id); },
    });
  } else if (voicePage) {
    renderStage($('#voice-stage'), {
      channel,
      serverId: state.view,
      serverName: state.detail.server.name,
      others: (state.detail.voice && state.detail.voice[channel.id]) || [],
      members: state.detail.members,
    });
  } else renderMessages(); // cores/permissões podem ter mudado
}

// Chamada numa DM/grupo: aparece em cima das mensagens.
function renderCallStage() {
  const el = $('#call-stage');
  const dm = state.view === 'home' ? currentDm() : null;
  const inThisCall = dm && voiceState().channelId === dm.channelId && (inVoice() || voiceState().connecting);
  const active = dm && ((dm.voice && dm.voice.length) || inThisCall);
  el.hidden = !active;
  if (!active) { el.replaceChildren(); return; }
  if (voiceState().connecting && !inVoice()) {
    el.replaceChildren(h('div', { class: 'stage-lobby small' }, h('p', { class: 'muted' }, 'Conectando…')));
    return;
  }
  renderStage(el, {
    channel: { id: dm.channelId, name: dmName(dm) },
    serverId: null,
    serverName: '',
    others: dm.voice || [],
    members: [state.me, ...dm.users],
    isDm: true,
    compact: true,
  });
}

// ---------------------------------------------------------------- Membros

function renderMembers() {
  const panel = $('#member-list');
  const dm = state.view === 'home' ? currentDm() : null;
  if (dm && dm.isGroup) {
    const people = [state.me, ...dm.users];
    panel.replaceChildren(h('div', { class: 'member-group' },
      h('div', { class: 'section-title' }, `Membros — ${people.length}`),
      people.map((m) => {
        const online = m.id === state.me.id ? true : m.online;
        return h('button', { class: `member${online ? '' : ' off'}`, onclick: (e) => openProfile(e.currentTarget, m) },
          avatar(m, { size: 'sm', online: m.id === state.me.id ? (state.me.status || 'online') : (online ? presenceOf(m) : 'offline') }),
          h('span', { class: 'member-info' },
            h('span', { class: 'member-name' },
              h('span', { class: 'name truncate' }, m.displayName),
              m.id === dm.ownerId ? h('span', { class: 'owner-badge', title: 'Dono do grupo' }, '👑') : null),
            online && m.statusText ? h('span', { class: 'member-status truncate' }, m.statusText) : null));
      })));
    return;
  }
  if (state.view === 'home' || !state.detail) return panel.replaceChildren();
  const ownerId = state.detail.server.ownerId;
  const online = state.detail.members.filter((m) => m.online);
  const offline = state.detail.members.filter((m) => !m.online);
  const statusLine = (m) => (m.activity && m.activity.name
    ? h('span', { class: 'member-status activity truncate', title: activityText(m.activity) }, activityText(m.activity))
    : m.statusText ? h('span', { class: 'member-status truncate' }, m.statusText) : null);
  const group = (title, members, isOnline) => (members.length === 0 ? null
    : h('div', { class: 'member-group' },
      h('div', { class: 'section-title' }, `${title} — ${members.length}`),
      members.map((m) => {
        return h('button', { class: `member${isOnline ? '' : ' off'}`, title: `@${m.username}`, onclick: (e) => openProfile(e.currentTarget, m) },
          avatar(m, { size: 'sm', online: isOnline ? presenceOf(m) : 'offline' }),
          h('span', { class: 'member-info' },
            h('span', { class: 'member-name' },
              h('span', { class: 'name truncate', style: roleStyle(m.id) }, m.displayName),
              m.isBot ? botTag() : null,
              m.timeoutUntil ? h('span', { class: 'timeout-mark', title: 'De castigo' }, '⏳') : null,
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
  const oldest = bucket.items.find((m) => !m.pending && !m.failed && !m.ephemeral);
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
    nodes.push(cached('top', `start|${dm ? dmName(dm) : channel && channel.name}|${channel && channel.announce}|${dm && dm.user && dm.user.avatarUrl}`, () => {
      if (dm && dm.isGroup) {
        return h('div', { class: 'channel-start' }, dmAvatar(dm, 'lg'), h('h2', {}, dmName(dm)),
          h('p', { class: 'muted' }, 'Este é o começo do grupo. ', h('button', { class: 'link', onclick: () => addToGroupDialog(dm) }, 'Chamar mais amigos')));
      }
      if (dm) {
        return h('div', { class: 'channel-start' }, avatar(dm.user, { size: 'lg' }), h('h2', {}, dm.user.displayName),
          h('p', { class: 'muted' }, `Este é o começo da sua conversa com @${dm.user.username}.`));
      }
      if (channel && channel.kind === 'thread') {
        const parent = state.detail.channels.find((c) => c.id === channel.parentChannelId);
        if (parent && parent.kind === 'forum') {
          return h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, '📝'),
            h('h2', {}, channel.name),
            h('p', { class: 'muted' }, `Post no fórum 💬 ${parent.name}. `, h('button', { class: 'link', onclick: () => selectChannel(parent.id) }, 'Ver todos os posts')));
        }
        return h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, '🧵'),
          h('h2', {}, channel.name),
          h('p', { class: 'muted' }, parent ? `Thread criada a partir de uma mensagem em #${parent.name}. ` : 'Thread. ',
            parent && channel.parentMessageId
              ? h('button', { class: 'link', onclick: () => jumpToMessage(parent.id, channel.parentMessageId) }, 'Ver mensagem original')
              : null));
      }
      return h('div', { class: 'channel-start' }, h('div', { class: 'start-hash' }, channel && channel.announce ? '📢' : '#'),
        h('h2', {}, `Bem-vindo a #${channel ? channel.name : ''}!`),
        h('p', { class: 'muted' }, channel && channel.announce
          ? 'Canal de anúncios: a moderação posta aqui. Reaja ou comente numa thread 🧵.'
          : 'Este é o começo do canal.'));
    }));
  }

  const view = `${state.detailVersion}|${state.view}|${effectiveTheme()}`;
  let prev = null;
  for (const m of bucket.items) {
    const date = new Date(m.createdAt);
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== date.toDateString();
    if (newDay) {
      const key = `day:${date.toDateString()}`;
      nodes.push(cached(key, dayLabel(date), () => h('div', { class: 'day-sep' }, dayLabel(date))));
    }
    const grouped = !!prev && !newDay && prev.author.id === m.author.id && !prev.failed && !m.replyTo &&
      prev.kind !== 'system' && m.kind !== 'system' && prev.kind !== 'ephemeral' && m.kind !== 'ephemeral' && !m.command &&
      date - new Date(prev.createdAt) < 7 * 60 * 1000;
    const replying = !!(state.replyTo && state.replyTo.message.id === m.id);
    const sig = [m._v || 0, grouped, !!m.pending, !!m.failed, state.editingId === m.id, replying, view, isSaved(m.id)].join('|');
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
  for (const d of state.dms) {
    const found = (d.users || []).find((x) => x.id === u.id);
    if (found) return found;
  }
  return u;
}

// A linha "↱ Fulano: texto" acima de uma resposta.
function buildReplyRef(m) {
  const r = m.replyTo;
  if (r.deleted) return h('div', { class: 'reply-ref deleted' }, h('span', { class: 'reply-spine' }), h('em', {}, 'A mensagem original foi apagada'));
  const author = freshUser(r.author);
  const color = (r.author.id && roleColor(r.author.id)) || null;
  const text = r.content ? stripMarkdown(r.content) : (r.hasAttachments ? '📎 Clique para ver o anexo' : '');
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

// Aviso do sistema ("Ana adicionou Bia ao grupo").
function buildSystemMessage(m) {
  const date = new Date(m.createdAt);
  return h('div', { class: 'msg system', dataset: { id: m.id } },
    h('div', { class: 'msg-left' }, h('span', { class: 'sys-icon' }, '➜')),
    h('div', { class: 'msg-body' }, h('span', { class: 'sys-text' }, renderContent(m.content)), ' ',
      h('span', { class: 'msg-time', title: fullTime(date) }, fullTime(date))));
}

function buildEphemeral(m) {
  return h('div', { class: 'msg first ephemeral', dataset: { id: m.id } },
    h('div', { class: 'msg-left' }, h('span', { class: 'eph-icon' }, '🤖')),
    h('div', { class: 'msg-body' },
      h('div', { class: 'msg-head' }, h('strong', { class: 'msg-author' }, 'Nexo'), botTag(),
        h('span', { class: 'msg-time' }, fullTime(new Date(m.createdAt)))),
      h('div', { class: 'msg-text' }, renderContent(m.content)),
      h('div', { class: 'eph-foot muted small' }, '👁️ Só você pode ver isto • ',
        h('button', { class: 'link', onclick: () => dismissEphemeral(m) }, 'Dispensar'))));
}

function buildMessage(m, grouped) {
  if (m.kind === 'system') return buildSystemMessage(m);
  if (m.kind === 'ephemeral') return buildEphemeral(m);
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
    const color = roleColor(m.author.id) || (effectiveTheme() === 'light' ? `hsl(${hueFor(m.author.id)} 60% 36%)` : `hsl(${hueFor(m.author.id)} 75% 72%)`);
    body.append(h('div', { class: 'msg-head' },
      h('button', { class: 'msg-author', style: roleStyle(m.author.id) || `color:${color}`, onclick: (e) => openProfile(e.currentTarget, authorUser) }, m.author.displayName),
      m.author.isBot ? botTag() : null,
      h('span', { class: 'msg-time', title: fullTime(date) }, fullTime(date)),
      m.pinnedAt ? h('span', { class: 'pin-mark', title: 'Mensagem fixada' }, '📌') : null));
  } else if (m.pinnedAt) {
    body.append(h('span', { class: 'pin-mark floating', title: 'Mensagem fixada' }, '📌'));
  }

  if (m.command) {
    const bot = m.command.botId ? freshUser({ id: m.command.botId }) : null;
    body.append(commandLine(m, bot && bot.displayName));
  }
  if (editing) body.append(buildEditor(m));
  else if (m.content) {
    body.append(h('div', { class: `msg-text${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${isJumbo(m.content) ? ' jumbo' : ''}` },
      renderContent(m.content),
      m.editedAt ? h('span', { class: 'edited', title: fullTime(new Date(m.editedAt)) }, ' (editado)') : null));
  }

  const tr = !editing && translationOf(m.id);
  if (tr) {
    body.append(h('div', { class: 'translation' },
      tr.loading ? h('span', { class: 'muted small' }, '🌐 Traduzindo…')
        : tr.same ? h('span', { class: 'muted small' }, '🌐 Já está no seu idioma.')
          : [h('div', { class: 'tr-head muted small' }, `🌐 Traduzido do ${langName(tr.from)} • `,
            h('button', { class: 'link', onclick: () => { hideTranslation(m.id); m._v = (m._v || 0) + 1; renderMessages(); } }, 'ver só o original')),
          h('div', { class: 'tr-text' }, renderContent(tr.text))]));
  }

  if (m.poll) {
    body.append(buildPoll(m, {
      meId: state.me.id,
      nameOf: (id) => { const u = id === state.me.id ? state.me : freshUser({ id }); return u && u.displayName; },
      canVote: !m.pending && (state.view === 'home' || !(state.detail && state.detail.me.timeoutUntil)),
      canEnd: m.author.id === state.me.id || (state.view !== 'home' && can(P.MANAGE_MESSAGES)),
      onVote: (options) => api(`/messages/${m.id}/poll`, { method: 'PUT', body: { options } })
        .then(({ poll }) => updateMessage(m.channelId, m.id, { poll })).catch((err) => toast(err.message)),
      onEnd: () => confirmDialog({
        title: 'Encerrar a enquete agora?', text: 'Ninguém mais poderá votar.', okLabel: 'Encerrar',
        onConfirm: () => api(`/messages/${m.id}/poll/end`, { method: 'POST' }),
      }),
    }));
  }
  if (m.gif) body.append(buildGif(m.gif, { onLoad: keepBottom, pending: m.pending }));
  if (m.sticker) body.append(buildSticker(m.sticker, { onLoad: keepBottom }));
  if (m.attachments.length) body.append(h('div', { class: 'attachments' }, m.attachments.map((a) => buildAttachment(a, m.pending))));
  if (m.embeds && m.embeds.length && !editing) body.append(buildEmbeds(m.embeds, { onImageLoad: keepBottom }));
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
    if (can(P.SEND_MESSAGES) && !(channel && channel.announce && !can(P.MANAGE_MESSAGES))) tools.push(h('button', { class: 'tool', title: 'Responder', onclick: () => setReply(m) }, '↩️'));
    tools.push(h('button', { class: `tool${isSaved(m.id) ? ' on' : ''}`, title: isSaved(m.id) ? 'Tirar das salvas' : 'Salvar mensagem (só você vê)', onclick: () => toggleSaved(m) }, '🔖'));
    tools.push(h('button', { class: 'tool', title: 'Lembrar de mim depois', onclick: (e) => openReminderMenu(e.currentTarget, m) }, '⏰'));
    if (m.content && !mine) {
      tools.push(h('button', {
        class: 'tool', title: 'Traduzir',
        onclick: () => translateMessage(m, () => { m._v = (m._v || 0) + 1; if (m.channelId === state.channelId) renderMessages(); }),
      }, '🌐'));
    }
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

// Texto com formatação, links e @menções (sempre montado como elementos, nunca HTML).
function renderContent(text) {
  return renderMarkdown(text, {
    users: knownUsers(),
    meId: state.me.id,
    onMention: (el, user) => openProfile(el, memberById(user.id) || user),
  });
}

// Imagem/prévia carregou: se a conversa estava no fim, continua no fim.
function keepBottom() {
  const box = $('#messages');
  if (stickToBottom) box.scrollTop = box.scrollHeight;
}

function buildAttachment(a, pending) {
  if (pending || a.local) {
    if (a.isVoice) return h('div', { class: 'voice-msg pending' }, h('span', { class: 'vm-play' }, '🎤'), h('span', { class: 'muted' }, `Mensagem de voz · ${fmtDuration(a.duration)}`));
    return h('div', { class: 'att-file' }, h('span', { class: 'att-icon' }, '📎'), h('span', { class: 'truncate' }, a.filename));
  }
  if (a.purged) {
    return h('div', { class: 'att-file purged', title: 'A limpeza automática do Nexo apagou este arquivo antigo.' },
      h('span', { class: 'att-icon' }, '🗑️'), h('span', { class: 'truncate' }, a.filename), h('span', { class: 'muted small' }, 'arquivo antigo removido'));
  }
  if (a.isVoice && a.kind === 'audio') return buildVoicePlayer(a);
  if (a.kind === 'image') {
    const img = h('img', { src: a.url, alt: a.filename, loading: 'lazy', class: 'att-img' });
    img.addEventListener('load', keepBottom);
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
        title: names.length ? `${names.join(', ')} reagiu com ${r.emoji.replace(/^<a?:([a-z0-9_]+):\d+>$/, ':$1:')}` : r.emoji,
        disabled: !allowed && !mine,
        onclick: () => toggleReaction(m, r.emoji, !mine),
      }, h('span', { class: 'r-emoji' }, emojiNode(r.emoji, 'cemoji reaction-emoji')), h('span', { class: 'r-count' }, String(r.count)));
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
  const show = !!state.channelId && !(ch && (ch.kind === 'voice' || ch.kind === 'forum'));
  $('#composer-area').hidden = !show;
  if (!show) return;
  const announceOnly = !!(ch && ch.kind === 'text' && ch.announce && !can(P.MANAGE_MESSAGES));
  const allowed = can(P.SEND_MESSAGES) && !announceOnly;
  input.disabled = !allowed;
  $('#composer').classList.toggle('disabled', !allowed);
  $('#btn-attach').hidden = !allowed;
  const dm = currentDm();
  const channel = currentChannel();
  const timeout = state.view !== 'home' && state.detail && state.detail.me.timeoutUntil;
  input.placeholder = timeout
    ? `Você está de castigo até ${fullTime(new Date(timeout)).replace(/^Hoje às /, '')} e só pode ler.`
    : announceOnly
      ? '📢 Canal de anúncios: só a moderação escreve. Reaja ou comente numa thread 🧵.'
      : !allowed
      ? 'Você não tem permissão para enviar mensagens aqui.'
      : dm ? (dm.isGroup ? `Conversar em ${dmName(dm)}` : `Conversar com @${dm.user.username}`)
        : channel && channel.kind === 'thread' ? `Conversar em 🧵 ${channel.name}` : `Conversar em #${channel ? channel.name : ''}`;
  renderUploads();
  renderReplyBar();
  updateMicButton();
}

// Mostra o microfone (mensagem de voz) quando a caixa está vazia; senão, o botão Enviar.
function updateMicButton() {
  const canVoice = !input.disabled && can(P.ATTACH_FILES) && canRecord();
  const empty = !input.value.trim() && state.uploads.length === 0;
  $('#btn-mic').hidden = !canVoice || !empty;
  $('#composer .send').hidden = canVoice && empty;
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', () => {
  autoResize();
  updateMicButton();
  updateAutocomplete();
  const now = Date.now();
  if (input.value.trim() && now - lastTypingSent > 2500 && state.socket) {
    lastTypingSent = now;
    state.socket.emit('typing', { channelId: state.channelId });
  }
});

// Atalhos de formatação: Ctrl+B negrito, Ctrl+I itálico, Ctrl+U sublinhado, Ctrl+Shift+X riscado.
function wrapSelection(mark) {
  const a = input.selectionStart;
  const b = input.selectionEnd;
  const sel = input.value.slice(a, b);
  input.setRangeText(`${mark}${sel}${mark}`, a, b, 'end');
  if (!sel) input.setSelectionRange(a + mark.length, a + mark.length);
  else input.setSelectionRange(a + mark.length, b + mark.length);
  autoResize();
  updateMicButton();
}

input.addEventListener('keydown', (e) => {
  if (handleAutocompleteKey(e)) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    const mark = k === 'b' && !e.shiftKey ? '**' : k === 'i' && !e.shiftKey ? '*' : k === 'u' && !e.shiftKey ? '__' : k === 'x' && e.shiftKey ? '~~' : null;
    if (mark) { e.preventDefault(); wrapSelection(mark); return; }
  }
  if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); setReply(null); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'ArrowUp' && !input.value) {
    // Seta para cima com a caixa vazia: edita sua última mensagem.
    const bucket = state.messages.get(state.channelId);
    const last = bucket && [...bucket.items].reverse().find((m) => m.author.id === state.me.id && !m.pending && !m.failed && m.kind !== 'system');
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

  // Comando de barra (/dado, /sortear...)? Vai pela rota de comandos.
  if (/^\/[a-z0-9_-]{1,32}(\s|$)/i.test(content) && !ups.length) {
    const list = commandsFor(state.channelId);
    if (!list) { loadCommands(state.channelId).then(() => sendMessage()); return; }
    const parsed = parseCommand(content, list);
    if (parsed) return sendCommand(state.channelId, parsed);
  }

  const channelId = state.channelId;
  const nonce = `n${Date.now().toString(36)}${++tempSeq}`;
  const reply = state.replyTo && state.replyTo.channelId === channelId ? state.replyTo.message : null;
  const temp = {
    id: `tmp-${nonce}`, nonce, pending: true, channelId, serverId: state.view === 'home' ? null : state.view,
    content, createdAt: new Date().toISOString(), author: state.me, mentions: [], mentionEveryone: false,
    reactions: [], attachments: ups.map((u) => ({ ...u.attachment, local: true })),
    replyTo: reply ? { id: reply.id, content: (reply.content || (reply.gif ? '🎞️ GIF' : '')).slice(0, 120), hasAttachments: reply.attachments.length > 0, author: reply.author } : null,
    thread: null, pinnedAt: null,
  };
  const attachmentIds = ups.map((u) => u.attachment.id);
  bucketFor(channelId).items.push(temp);
  input.value = '';
  autoResize();
  clearUploads();
  hideAutocomplete();
  updateMicButton();
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

async function sendCommand(channelId, parsed) {
  const typed = input.value;
  input.value = '';
  autoResize();
  hideAutocomplete();
  updateMicButton();
  // "/enquete" sozinho abre a janelinha de enquete.
  if (parsed.name === 'enquete' && !parsed.args && !parsed.command.bot) return openPollDialog();
  try {
    const res = await runCommand(channelId, parsed);
    const bucket = bucketFor(channelId);
    if (res.message && !bucket.items.some((x) => x.id === res.message.id)) bucket.items.push(res.message);
    if (res.ephemeral) bucket.items.push(ephemeralMessage(channelId, res.ephemeral.text));
    if (channelId === state.channelId) renderMessages({ stick: 'always' });
  } catch (err) {
    toast(err.message);
    if (!input.value && state.channelId === channelId) { input.value = typed; autoResize(); updateMicButton(); }
  }
}

function dismissEphemeral(m) {
  const bucket = state.messages.get(m.channelId);
  if (!bucket) return;
  bucket.items = bucket.items.filter((x) => x !== m);
  renderMessages();
}

// ---------------------------------------------------------------- Figurinhas

$('#btn-sticker').addEventListener('click', (e) => openStickerPicker(e.currentTarget));

function sendSticker(st) {
  if (!state.channelId || !state.socket || input.disabled) return;
  const channelId = state.channelId;
  const reply = state.replyTo && state.replyTo.channelId === channelId ? state.replyTo.message : null;
  setReply(null, { render: false });
  state.socket.timeout(15000).emit('message:send', { channelId, content: '', stickerId: st.id, ...(reply ? { replyToId: reply.id } : {}) }, (err, res) => {
    if (err || !res || !res.ok) return toast((res && res.error) || 'Não foi possível enviar a figurinha.');
    const bucket = state.messages.get(channelId);
    if (bucket && !bucket.items.some((x) => x.id === res.message.id)) bucket.items.push(res.message);
    if (channelId === state.channelId) renderMessages({ stick: 'always' });
  });
}

$('#btn-saved').addEventListener('click', () => {
  if (!$('#search-panel').hidden && document.querySelector('#search-panel .lists-tabs')) closeListsPanel();
  else openListsPanel('saved');
});

// ---------------------------------------------------------------- GIFs

$('#btn-gif').addEventListener('click', (e) => openGifPicker(e.currentTarget, sendGif, { userId: state.me.id }));

// O GIF vai numa mensagem só dele (se estava respondendo alguém, vai como resposta).
function sendGif(gif) {
  if (!state.channelId || !state.socket || input.disabled) return;
  const channelId = state.channelId;
  const nonce = `n${Date.now().toString(36)}${++tempSeq}`;
  const reply = state.replyTo && state.replyTo.channelId === channelId ? state.replyTo.message : null;
  const temp = {
    id: `tmp-${nonce}`, nonce, pending: true, channelId, serverId: state.view === 'home' ? null : state.view,
    content: '', gif, createdAt: new Date().toISOString(), author: state.me, mentions: [], mentionEveryone: false,
    reactions: [], attachments: [],
    replyTo: reply ? { id: reply.id, content: (reply.content || (reply.gif ? '🎞️ GIF' : '')).slice(0, 120), hasAttachments: reply.attachments.length > 0, author: reply.author } : null,
    thread: null, pinnedAt: null,
  };
  bucketFor(channelId).items.push(temp);
  setReply(null, { render: false });
  renderMessages({ stick: 'always' });

  const payload = { channelId, content: '', gif, nonce, ...(reply ? { replyToId: reply.id } : {}) };
  state.socket.timeout(15000).emit('message:send', payload, (err, res) => {
    const bucket = state.messages.get(channelId);
    if (!bucket) return;
    const idx = bucket.items.indexOf(temp);
    if (err || !res || !res.ok) {
      if (idx !== -1) Object.assign(temp, { pending: false, failed: true, _v: 1 });
      toast((res && res.error) || 'Não foi possível enviar o GIF.');
    } else if (idx !== -1) {
      if (bucket.items.some((m) => m !== temp && m.id === res.message.id)) bucket.items.splice(idx, 1);
      else bucket.items[idx] = res.message;
    }
    if (channelId === state.channelId) renderMessages();
  });
}

// ---------------------------------------------------------------- Anexos

const MAX_ATTACHMENTS = 5;

// "+" abre um menu: arquivo ou enquete.
$('#btn-attach').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { label: '📎  Enviar arquivo', hidden: !can(P.ATTACH_FILES), onClick: () => $('#file-input').click() },
  { label: '🎞️  Enviar GIF', onClick: () => openGifPicker($('#btn-attach'), sendGif, { userId: state.me.id }) },
  { label: '🏷️  Enviar figurinha', onClick: () => openStickerPicker($('#btn-attach')) },
  { label: '⏰  Agendar mensagem', onClick: () => openScheduleDialog(state.channelId, input.value.trim(), () => { input.value = ''; autoResize(); }) },
  { label: '📊  Criar enquete', onClick: () => openPollDialog() },
  { label: '🎤  Gravar mensagem de voz', hidden: !can(P.ATTACH_FILES) || !canRecord(), onClick: () => startVoiceMessage(true) },
], { className: 'popover-menu' }));

function openPollDialog() {
  const channelId = state.channelId;
  createPollDialog(async (poll) => {
    const res = await new Promise((resolve) => state.socket.timeout(15000).emit('message:send', { channelId, content: '', poll }, (err, r) => resolve(err ? { ok: false, error: 'Sem conexão.' } : r)));
    if (!res || !res.ok) throw new Error((res && res.error) || 'Não foi possível criar a enquete.');
    if (channelId === state.channelId) {
      const bucket = bucketFor(channelId);
      if (!bucket.items.some((m) => m.id === res.message.id)) bucket.items.push(res.message);
      renderMessages({ stick: 'always' });
    }
  });
}

// ---------------------------------------------------------------- Mensagem de voz
// Como no WhatsApp:
//  • segure o 🎤 e fale; solte para enviar
//  • arraste para a ESQUERDA para cancelar, ou para CIMA para travar (e falar sem segurar)
//  • um toque rápido também trava a gravação
//  • travada: dá para pausar, cancelar, parar e ouvir antes de enviar
//  • Esc cancela; Enter envia
let rec = null; // { phase: 'holding'|'locked'|'review', recorder, channelId, result, previewUrl, drag }
const CANCEL_DX = 90;
const LOCK_DY = 70;

async function startVoiceMessage(locked = false) {
  if (rec || !state.channelId) return;
  const channelId = state.channelId;
  rec = { channelId, phase: locked ? 'locked' : 'holding', starting: true, drag: { dx: 0, dy: 0 } };
  renderRecBar();
  try {
    const recorder = await startRecording({ onTick: () => updateRecBar() });
    if (!rec || rec.cancelled) { recorder.cancel(); if (rec && rec.cancelled) rec = null; renderRecBar(); return; }
    rec.recorder = recorder;
    rec.starting = false;
    recorder.onAutoStop = () => { toast('Limite de 5 minutos: pare e ouça antes de enviar.'); stopForReview(); };
    renderRecBar();
  } catch (err) {
    rec = null;
    renderRecBar();
    toast(err.message);
  }
}

// Descarta a gravação (em qualquer etapa).
function cancelVoiceMessage(note) {
  const r = rec;
  if (!r) return;
  rec = null;
  if (r.recorder) r.recorder.cancel(); else r.cancelled = true;
  if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
  renderRecBar();
  if (note) toast(note);
}

// Para de gravar e mostra o áudio para ouvir antes de enviar.
async function stopForReview() {
  const r = rec;
  if (!r || !r.recorder || r.phase === 'review') return;
  if (r.recorder.elapsed() < 0.7) return cancelVoiceMessage('Áudio curto demais.');
  try {
    r.result = await r.recorder.stop();
  } catch (err) {
    cancelVoiceMessage(err.message);
    return;
  }
  if (rec !== r) return;
  r.phase = 'review';
  r.previewUrl = URL.createObjectURL(r.result.file);
  renderRecBar();
}

async function sendVoiceMessage() {
  const r = rec;
  if (!r) return;
  if (!r.result) {
    if (!r.recorder) return;
    if (r.recorder.elapsed() < 0.7) return cancelVoiceMessage('Segure o 🎤 enquanto fala (áudio curto demais).');
    try { r.result = await r.recorder.stop(); } catch (err) { return cancelVoiceMessage(err.message); }
  }
  if (rec !== r) return;
  rec = null;
  if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
  renderRecBar();
  const { file, duration, waveform } = r.result;
  const nonce = `n${Date.now().toString(36)}${++tempSeq}`;
  const temp = {
    id: `tmp-${nonce}`, nonce, pending: true, channelId: r.channelId, serverId: state.view === 'home' ? null : state.view,
    content: '', createdAt: new Date().toISOString(), author: state.me, mentions: [], mentionEveryone: false, kind: 'default',
    reactions: [], embeds: [], poll: null, replyTo: null, thread: null, pinnedAt: null,
    attachments: [{ id: nonce, filename: file.name, isVoice: true, duration, local: true }],
  };
  const bucket = bucketFor(r.channelId);
  bucket.items.push(temp);
  if (r.channelId === state.channelId) renderMessages({ stick: 'always' });
  try {
    const att = await uploadFile(file, () => {}, { 'X-Voice-Duration': duration.toFixed(2), 'X-Voice-Waveform': waveform });
    state.socket.timeout(15000).emit('message:send', { channelId: r.channelId, content: '', attachmentIds: [att.id], nonce }, (err, res) => {
      const idx = bucket.items.indexOf(temp);
      if (err || !res || !res.ok) {
        if (idx !== -1) Object.assign(temp, { pending: false, failed: true, _v: 1 });
        toast((res && res.error) || 'Não foi possível enviar o áudio.');
      } else if (idx !== -1) {
        if (bucket.items.some((m) => m !== temp && m.id === res.message.id)) bucket.items.splice(idx, 1);
        else bucket.items[idx] = res.message;
      }
      if (r.channelId === state.channelId) renderMessages();
    });
  } catch (err) {
    Object.assign(temp, { pending: false, failed: true, _v: 1 });
    if (r.channelId === state.channelId) renderMessages();
    toast(err.message);
  }
}

function togglePauseVoice() {
  if (!rec || !rec.recorder) return;
  if (rec.recorder.isPaused()) rec.recorder.resume(); else rec.recorder.pause();
  renderRecBar();
}

// Atualiza só o relógio e as barrinhas (sem refazer os botões a cada 100 ms).
function updateRecBar() {
  if (!rec || !rec.recorder || rec.phase === 'review') return;
  const bar = $('#rec-bar');
  const time = bar.querySelector('.rec-time');
  const bars = bar.querySelector('.rec-bars');
  if (time) time.textContent = fmtDuration(rec.recorder.elapsed());
  if (bars) bars.replaceWith(liveBars(rec.recorder.levels()));
}

function renderRecBar() {
  const bar = $('#rec-bar');
  const lockHint = $('#rec-lock');
  $('#composer').hidden = !!rec;
  bar.classList.toggle('holding', !!rec && rec.phase === 'holding');
  if (lockHint) lockHint.hidden = !rec || rec.phase !== 'holding';
  if (!rec) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  const btn = (cls, title, label, onclick) => h('button', { type: 'button', class: `rec-btn ${cls}`, title, 'aria-label': title, onclick }, label);

  if (rec.phase === 'review') {
    bar.replaceChildren(
      btn('danger', 'Descartar áudio (Esc)', '🗑️', () => cancelVoiceMessage()),
      h('div', { class: 'rec-review' }, buildVoicePlayer({ url: rec.previewUrl, duration: rec.result.duration, waveform: rec.result.waveform })),
      h('button', { type: 'button', class: 'btn primary small rec-send', title: 'Enviar (Enter)', onclick: sendVoiceMessage }, 'Enviar ➤'),
    );
    return;
  }

  const secs = rec.recorder ? rec.recorder.elapsed() : 0;
  const paused = !!(rec.recorder && rec.recorder.isPaused());
  const status = [
    h('span', { class: `rec-dot${paused ? ' paused' : ''}` }),
    h('span', { class: 'rec-time' }, rec.starting ? '0:00' : fmtDuration(secs)),
    rec.recorder ? liveBars(rec.recorder.levels()) : h('span', { class: 'rec-bars' }),
  ];

  if (rec.phase === 'holding') {
    // Segurando: a dica de cancelar acompanha o dedo.
    const dx = Math.max(0, rec.drag.dx);
    const near = dx / CANCEL_DX;
    bar.replaceChildren(
      ...status,
      h('span', {
        class: `rec-slide${near > 0.6 ? ' warn' : ''}`,
        style: `transform:translateX(${-Math.min(dx, CANCEL_DX)}px);opacity:${Math.max(0.3, 1 - near * 0.7)}`,
      }, '◀ Arraste para cancelar'),
      h('span', { class: 'muted small rec-hint' }, 'Solte para enviar'),
    );
    return;
  }

  // Travada: botões para cancelar, pausar, parar/ouvir e enviar.
  bar.replaceChildren(
    btn('danger', 'Cancelar (Esc)', '🗑️', () => cancelVoiceMessage()),
    ...status,
    paused ? h('span', { class: 'muted small rec-hint' }, 'Pausado') : '',
    btn('', paused ? 'Continuar gravando' : 'Pausar', paused ? '🎤' : '⏸️', togglePauseVoice),
    btn('', 'Parar e ouvir antes de enviar', '⏹️', stopForReview),
    h('button', { type: 'button', class: 'btn primary small rec-send', title: 'Enviar (Enter)', disabled: !rec.recorder, onclick: sendVoiceMessage }, 'Enviar ➤'),
  );
}

// Teclado: Esc cancela, Enter envia (quando a gravação está travada ou em revisão).
document.addEventListener('keydown', (e) => {
  if (!rec || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { e.preventDefault(); cancelVoiceMessage(); }
  if (e.key === 'Enter' && rec.phase !== 'holding' && !e.target.closest('button')) { e.preventDefault(); sendVoiceMessage(); }
});
// Trocar de conversa no meio da gravação descarta o áudio.
function discardVoiceOnSwitch() { if (rec) cancelVoiceMessage('Áudio descartado (você mudou de conversa).'); }

// Segurar o botão do microfone.
(() => {
  const mic = $('#btn-mic');
  let down = null; // { x, y, at, pointerId }
  mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    down = { x: e.clientX, y: e.clientY, at: performance.now(), pointerId: e.pointerId };
    try { mic.setPointerCapture(e.pointerId); } catch { /* ignora */ }
    startVoiceMessage(false);
  });
  mic.addEventListener('pointermove', (e) => {
    if (!down || !rec || rec.phase !== 'holding' || e.pointerId !== down.pointerId) return;
    rec.drag = { dx: down.x - e.clientX, dy: down.y - e.clientY };
    if (rec.drag.dx > CANCEL_DX) {
      down = null;
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* ignora */ } }
      cancelVoiceMessage('Áudio cancelado.');
      return;
    }
    if (rec.drag.dy > LOCK_DY) {
      down = null;
      rec.phase = 'locked';
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch { /* ignora */ } }
      renderRecBar();
      return;
    }
    renderRecBar();
  });
  const up = (e) => {
    if (!down) return;
    const held = performance.now() - down.at;
    down = null;
    if (!rec || rec.phase !== 'holding') return;
    if (e.type === 'pointercancel') { cancelVoiceMessage(); return; }
    // Toque rápido: trava a gravação (com os botões).
    if (held < 350) { rec.phase = 'locked'; renderRecBar(); return; }
    sendVoiceMessage();
  };
  mic.addEventListener('pointerup', up);
  mic.addEventListener('pointercancel', up);
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
})();


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
  updateMicButton();
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
  openEmojiPicker(e.currentTarget, (picked) => {
    // Emoji personalizado entra como :nome: (o servidor troca pela imagem).
    const custom = /^<a?:([a-z0-9_]+):\d+>$/.exec(picked);
    const emoji = custom ? `:${custom[1]}: ` : picked;
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
    return dm ? [...dm.users, state.me] : [];
  }
  return state.detail ? state.detail.members : [];
}

function updateAutocomplete() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  // /da → comandos de barra
  const slash = matchSlash(before);
  if (slash !== null && state.channelId) {
    const channelId = state.channelId;
    const list = commandsFor(channelId);
    if (!list) {
      loadCommands(channelId).then(() => { if (state.channelId === channelId && document.activeElement === input) updateAutocomplete(); });
      return hideAutocomplete();
    }
    const items = commandSuggestions(list, slash).map((c) => ({ cmd: c, insert: `/${c.name} ` }));
    if (!items.length) return hideAutocomplete();
    ac = { items, index: 0, start: 0, title: 'Comandos' };
    return renderAutocomplete();
  }
  // :nom → emojis personalizados
  const em = /(^|\s):([a-z0-9_]{2,32})$/i.exec(before);
  if (em) {
    const q = em[2].toLowerCase();
    const items = availableEmojis().filter((e) => e.name.includes(q))
      .sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 8).map((e) => ({ emoji: e, insert: `:${e.name}: ` }));
    if (!items.length) return hideAutocomplete();
    ac = { items, index: 0, start: pos - q.length - 1, title: 'Emojis' };
    return renderAutocomplete();
  }
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
  ac = { items, index: 0, start: pos - q.length - 1, title: 'Membros' };
  renderAutocomplete();
}

function renderAutocomplete() {
  const box = $('#autocomplete');
  if (!ac) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'ac-title' }, ac.title || 'Membros'),
    ...ac.items.map((it, i) => h('button', {
      type: 'button',
      class: `ac-item${i === ac.index ? ' active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); pickAutocomplete(i); },
    }, it.cmd ? commandItem(it.cmd) : it.emoji
      ? [h('img', { class: 'cemoji ac-emoji', src: it.emoji.url, alt: '' }), h('strong', {}, `:${it.emoji.name}:`), it.emoji.serverName ? h('span', { class: 'muted' }, it.emoji.serverName) : null]
      : it.everyone
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
  const text = it.insert || `@${it.value} `;
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
    if (member && user.id !== state.detail.server.ownerId && memberTop(member) < myTop()
      && (can(P.KICK_MEMBERS) || can(P.BAN_MEMBERS) || can(P.MODERATE_MEMBERS))) {
      actions.push(h('button', {
        class: 'btn danger-ghost', onclick: (e) => {
          const anchor = e.currentTarget;
          openMenu(anchor, [
            can(P.MODERATE_MEMBERS) ? { label: member.timeoutUntil ? '⏳  Castigo…' : '⏳  Castigar…', onClick: () => timeoutMenu(anchor, member) } : null,
            can(P.KICK_MEMBERS) ? { label: '👢  Expulsar', danger: true, onClick: () => kickDialog(member) } : null,
            can(P.BAN_MEMBERS) ? { label: '🔨  Banir', danger: true, onClick: () => banDialog(member) } : null,
          ], { className: 'popover-menu' });
        },
      }, 'Moderar ▾'));
    }
    const vs = voiceState();
    const inCallWithThem = vs.room && ((state.detail && state.detail.voice && (state.detail.voice[vs.channelId] || []).some((p) => p.userId === user.id))
      || state.dms.some((d) => d.channelId === vs.channelId && (d.voice || []).some((p) => p.userId === user.id)));
    if (inCallWithThem) actions.push(h('button', { class: 'btn', onclick: (e) => openVolumePopover(e.currentTarget, user) }, '🔊 Volume'));
  }


  // "Sobre mim" e servidores em comum chegam um instante depois.
  const extra = h('div', { class: 'profile-extra' });
  const banner = h('div', { class: 'profile-banner', style: `--hue:${hueFor(user.id)}` });
  if (isMe) paintBanner(banner, state.me);
  else if (member && member.profileColor) paintBanner(banner, member);
  const badgeSlot = h('div', { class: 'badge-slot-row' });
  if (!user.isBot || isMe) {
    const sid = state.view !== 'home' && state.detail ? `?serverId=${state.detail.server.id}` : '';
    api(`/users/${user.id}/profile${sid}`).then((p) => {
      paintBanner(banner, p);
      const card = banner.closest('.profile');
      if (card && p.profileColor) card.style.setProperty('--profile-color', p.profileColor);
      const row = badgesRow(p.badges);
      if (row) badgeSlot.replaceChildren(row);
      const parts = [activityBlock(p.activity), levelBlock(p.level)].filter(Boolean);
      if (p.about) parts.push(h('div', { class: 'profile-section' }, h('div', { class: 'profile-label' }, 'Sobre mim'), h('div', { class: 'profile-about' }, renderContent(p.about))));
      if (p.mutualServers && p.mutualServers.length && state.view === 'home') {
        parts.push(h('div', { class: 'profile-section' }, h('div', { class: 'profile-label' }, 'Servidores em comum'),
          h('div', { class: 'muted small' }, p.mutualServers.map((x) => x.name).join(', '))));
      }
      if (p.createdAt) parts.push(h('div', { class: 'profile-section muted small' }, `No Nexo desde ${new Date(p.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`));
      extra.replaceChildren(...parts);
    }).catch(() => {});
  }
  openPopover(anchor, h('div', { class: 'profile' },
    banner,
    h('div', { class: 'profile-avatar' }, avatar(freshUser(user), { size: 'xl', online: online === undefined && !isMe ? undefined : (isMe ? status : (online ? status : 'offline')) })),
    h('div', { class: 'profile-body' },
      h('h3', { style: member ? roleStyle(member.id) : null }, freshUser(user).displayName, user.isBot ? botTag() : null),
      h('div', { class: 'muted' }, `@${user.username}`),
      badgeSlot,
      statusText ? h('div', { class: 'profile-status' }, statusText) : null,
      member && member.id === state.detail.server.ownerId ? h('div', { class: 'owner-line' }, '👑 Dono do servidor') : null,
      member && member.timeoutUntil ? h('div', { class: 'timeout-tag' }, `⏳ De castigo até ${fullTime(new Date(member.timeoutUntil))}`) : null,
      extra,
      roles.length ? h('div', { class: 'role-chips' }, roles.map((r) => h('span', { class: 'role-chip' },
        h('i', { style: `background:${r.color || 'var(--text-3)'}` }), r.name))) : null,
      actions.length ? h('div', { class: 'profile-actions' }, actions) : null)), { className: 'popover-profile' });
}

// ================================================================ Servidor: menus e janelas

function openServerMenu(anchor) {
  const d = state.detail;
  if (!d) return;
  const manageSomething = isOwner() || can(P.MANAGE_SERVER) || can(P.MANAGE_ROLES) || can(P.KICK_MEMBERS)
    || can(P.BAN_MEMBERS) || can(P.MODERATE_MEMBERS) || can(P.VIEW_AUDIT_LOG) || can(P.CREATE_INVITE) || can(P.MANAGE_EMOJIS);
  openMenu(anchor, [
    { label: '✉️  Convidar pessoas', hidden: !can(P.CREATE_INVITE), onClick: inviteDialog },
    { label: '⚙️  Configurações do servidor', hidden: !manageSomething, onClick: () => openServerSettings() },
    { label: '➕  Criar canal', hidden: !can(P.MANAGE_CHANNELS), onClick: () => createChannelDialog('text') },
    { label: '📁  Criar categoria', hidden: !can(P.MANAGE_CHANNELS), onClick: createCategoryDialog },
    { label: '😺  Emojis, figurinhas e sons', hidden: !can(P.MANAGE_EMOJIS), onClick: () => openServerSettings('emojis') },
    { label: '📊  Estatísticas', hidden: !(can(P.MANAGE_SERVER) || can(P.VIEW_AUDIT_LOG)), onClick: () => openServerSettings('stats') },
    { label: '📜  Registro de auditoria', hidden: !can(P.VIEW_AUDIT_LOG), onClick: () => openServerSettings('audit') },
    { separator: true, hidden: isOwner() },
    { label: '🚪  Sair do servidor', danger: true, hidden: isOwner(), onClick: leaveServerDialog },
  ], { className: 'popover-menu' });
}

// Escolher categoria e quem vê o canal (usado ao criar e ao editar).
function channelOptionsFields(channel) {
  const d = state.detail;
  const cats = d.channels.filter((c) => c.kind === 'category').sort((a, b) => a.position - b.position);
  const category = h('select', { class: 'select' },
    h('option', { value: '' }, '(sem categoria)'),
    cats.map((c) => h('option', { value: String(c.id), selected: channel.categoryId === c.id }, c.name)));
  const roles = d.roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const chosen = new Set(channel.allowedRoleIds || []);
  const priv = h('input', { type: 'checkbox', class: 'switch', checked: !!channel.private });
  const roleList = h('div', { class: 'role-pick', hidden: !channel.private },
    h('p', { class: 'muted small' }, 'Quem pode ver: o dono, administradores e os cargos marcados abaixo.'),
    roles.length ? roles.map((r) => h('label', { class: 'role-pick-item' },
      h('input', { type: 'checkbox', checked: chosen.has(r.id), onchange: (e) => { if (e.target.checked) chosen.add(r.id); else chosen.delete(r.id); } }),
      h('i', { class: 'role-dot', style: `background:${r.color || 'var(--text-3)'}` }), r.name))
      : h('p', { class: 'muted small' }, 'Ainda não há cargos. Crie cargos nas configurações do servidor para liberar o canal para eles.'));
  priv.addEventListener('change', () => { roleList.hidden = !priv.checked; });
  const el = h('div', {},
    cats.length ? h('label', { class: 'field' }, 'Categoria', category) : null,
    h('label', { class: 'switch-line' }, priv, h('span', {}, h('strong', {}, '🔒 Canal privado'), h('span', { class: 'muted small block' }, 'Só alguns cargos conseguem ver e entrar.'))),
    roleList);
  return {
    el,
    values: () => ({ categoryId: category.value ? Number(category.value) : null, private: priv.checked, roleIds: [...chosen] }),
  };
}

function createChannelDialog(kind = 'text', categoryId) {
  let chosen = ['voice', 'forum'].includes(kind) ? kind : 'text';
  const name = h('input', { placeholder: 'novo-canal', maxlength: '100' });
  const topic = h('textarea', { class: 'textarea', rows: '2', maxlength: '500', placeholder: 'Ex.: Tire suas dúvidas aqui. Antes de postar, use a busca!' });
  const topicField = h('label', { class: 'field', hidden: chosen !== 'forum' }, 'Descrição / regras do fórum (opcional)', topic);
  const announceBox = h('input', { type: 'checkbox', class: 'switch' });
  const announceField = h('label', { class: 'switch-row', hidden: chosen !== 'text' },
    h('span', { class: 'kind-text' }, h('strong', {}, '📢 Canal de anúncios'), h('span', { class: 'muted small' }, 'Só a moderação escreve; os outros reagem e comentam em threads.')), announceBox);
  const option = (value, icon, label, desc) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'kind', value, checked: chosen === value, onchange: () => { chosen = value; topicField.hidden = value !== 'forum'; announceField.hidden = value !== 'text'; } }),
    h('span', { class: 'kind-icon' }, icon),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));
  const fallbackCat = categoryId !== undefined ? categoryId
    : (state.detail.channels.find((c) => c.kind === 'category' && c.name === (chosen === 'voice' ? 'Canais de voz' : 'Canais de texto')) || {}).id;
  const opts = channelOptionsFields({ categoryId: fallbackCat || null, private: false, allowedRoleIds: [] });
  openDialog({
    title: 'Criar canal',
    body: h('div', {},
      h('div', { class: 'kind-options' },
        option('text', '#', 'Texto', 'Mensagens, imagens, enquetes e arquivos'),
        option('voice', '🔊', 'Voz', 'Conversa por voz, câmera e tela'),
        option('forum', '💬', 'Fórum', 'Cada post vira um tópico com respostas (dúvidas, sugestões, guias)')),
      h('label', { class: 'field' }, 'Nome do canal', name),
      topicField,
      announceField,
      opts.el),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar canal', kind: 'primary', submit: true,
        onClick: async () => {
          if (!name.value.trim()) throw new Error('Dê um nome ao canal.');
          const { channel } = await api(`/servers/${state.view}/channels`, { method: 'POST', body: { name: name.value.trim(), kind: chosen, ...(chosen === 'forum' ? { topic: topic.value } : {}), ...(chosen === 'text' ? { announce: announceBox.checked } : {}), ...opts.values() } });
          await refreshDetail();
          await selectChannel(channel.id);
        },
      },
    ],
  });
}

function createCategoryDialog() {
  ask({
    title: 'Criar categoria',
    text: 'Categorias agrupam canais (ex.: "Jogos", "Estudos"). Depois é só arrastar os canais para dentro.',
    placeholder: 'Nome da categoria',
    maxLength: 60,
    okLabel: 'Criar',
    onSubmit: async (name) => {
      if (!name) throw new Error('Dê um nome à categoria.');
      await api(`/servers/${state.view}/channels`, { method: 'POST', body: { name, kind: 'category' } });
    },
  });
}

function editCategoryDialog(cat) {
  const input2 = h('input', { value: cat.name, maxlength: '60' });
  openDialog({
    title: 'Editar categoria',
    body: h('label', { class: 'field' }, 'Nome da categoria', input2),
    actions: [
      {
        label: 'Apagar categoria', kind: 'danger-ghost',
        onClick: () => confirmDialog({
          title: `Apagar a categoria "${cat.name}"?`,
          text: 'Os canais dela NÃO são apagados: eles só ficam sem categoria.',
          okLabel: 'Apagar categoria',
          onConfirm: () => api(`/channels/${cat.id}`, { method: 'DELETE' }),
        }),
      },
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', submit: true,
        onClick: async () => {
          if (!input2.value.trim()) throw new Error('Dê um nome à categoria.');
          await api(`/channels/${cat.id}`, { method: 'PATCH', body: { name: input2.value.trim() } });
        },
      },
    ],
  });
}

function editChannelDialog(channel) {
  const thread = channel.kind === 'thread';
  const input2 = h('input', { value: channel.name, maxlength: '100' });
  const opts = !thread && can(P.MANAGE_CHANNELS) ? channelOptionsFields(channel) : null;
  const stageBox = channel.kind === 'voice' && can(P.MANAGE_CHANNELS) ? h('input', { type: 'checkbox', class: 'switch', checked: !!channel.stage }) : null;
  const topicBox = channel.kind === 'forum' && can(P.MANAGE_CHANNELS) ? h('textarea', { class: 'textarea', rows: '2', maxlength: '500' }) : null;
  const announceBox = channel.kind === 'text' && can(P.MANAGE_CHANNELS) ? h('input', { type: 'checkbox', class: 'switch', checked: !!channel.announce }) : null;
  if (topicBox) topicBox.value = channel.topic || '';
  openDialog({
    title: thread ? 'Editar thread' : 'Editar canal',
    body: h('div', {}, h('label', { class: 'field' }, thread ? 'Nome da thread' : 'Nome do canal', input2),
      topicBox ? h('label', { class: 'field' }, 'Descrição / regras do fórum', topicBox) : null,
      announceBox ? h('label', { class: 'switch-row' },
        h('span', { class: 'kind-text' }, h('strong', {}, '📢 Canal de anúncios'), h('span', { class: 'muted small' }, 'Só a moderação escreve; os outros reagem e comentam em threads.')), announceBox) : null,
      opts ? opts.el : null,
      stageBox ? h('label', { class: 'switch-row' },
        h('span', { class: 'kind-text' }, h('strong', {}, '🎙️ Modo palco'),
          h('span', { class: 'muted small' }, 'Só fala quem modera ou quem for chamado. Os outros ouvem e podem levantar a mão ✋.')),
        stageBox) : null),
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
          await api(`/channels/${channel.id}`, { method: 'PATCH', body: { name, ...(opts ? opts.values() : {}), ...(stageBox ? { stage: stageBox.checked } : {}), ...(topicBox ? { topic: topicBox.value } : {}), ...(announceBox ? { announce: announceBox.checked } : {}) } });
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

// Nova conversa: 1 amigo = conversa a dois; 2 ou mais = grupo.
function pickFriendsDialog({ title, text, exclude = [], max = 9, okLabel, onSubmit }) {
  const friends = state.friends.friends.filter((f) => !exclude.includes(f.id));
  if (friends.length === 0) {
    toast(exclude.length ? 'Todos os seus amigos já estão aqui.' : 'Adicione amigos primeiro, ou abra uma conversa pelo perfil de alguém do seu servidor.');
    return;
  }
  const chosen = new Set();
  const filter = h('input', { placeholder: 'Procurar amigo', maxlength: '32' });
  const counter = h('span', { class: 'muted small' }, `0 de ${max}`);
  const list = h('div', { class: 'pick-list' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(...friends.filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.username.includes(q)).map((f) => h('label', { class: 'pick-item' },
      h('input', {
        type: 'checkbox', checked: chosen.has(f.id),
        onchange: (e) => {
          if (e.target.checked && chosen.size >= max) { e.target.checked = false; return toast(`No máximo ${max}.`); }
          if (e.target.checked) chosen.add(f.id); else chosen.delete(f.id);
          counter.textContent = `${chosen.size} de ${max}`;
        },
      }),
      avatar(f, { size: 'sm', online: f.online ? presenceOf(f) : 'offline' }), h('strong', {}, f.displayName), h('span', { class: 'muted' }, `@${f.username}`))));
  };
  filter.addEventListener('input', draw);
  draw();
  openDialog({
    title, text,
    body: h('div', { class: 'stack' }, filter, list, counter),
    actions: [
      { label: 'Cancelar' },
      { label: okLabel, kind: 'primary', submit: true, onClick: () => onSubmit([...chosen]) },
    ],
  });
}

function newDmDialog() {
  pickFriendsDialog({
    title: 'Nova conversa',
    text: 'Escolha 1 amigo para conversar a dois, ou vários para criar um grupo (até 10 pessoas).',
    okLabel: 'Começar conversa',
    onSubmit: async (ids) => {
      if (!ids.length) throw new Error('Escolha pelo menos um amigo.');
      if (ids.length === 1) return openDm(ids[0]);
      const { channelId } = await api('/dms/group', { method: 'POST', body: { userIds: ids } });
      await loadDms();
      await goHome(channelId);
    },
  });
}

function addToGroupDialog(dm) {
  const exclude = dm.isGroup ? dm.users.map((u) => u.id) : [dm.user.id];
  pickFriendsDialog({
    title: dm.isGroup ? 'Adicionar ao grupo' : 'Criar grupo',
    text: dm.isGroup ? 'Quem você quer chamar para o grupo?' : `Escolha quem mais vai entrar. Vai ser criado um grupo novo com você, ${dm.user.displayName} e as pessoas escolhidas.`,
    exclude,
    max: 10 - (dm.isGroup ? dm.users.length + 1 : 2),
    okLabel: 'Adicionar',
    onSubmit: async (ids) => {
      if (!ids.length) throw new Error('Escolha pelo menos um amigo.');
      const { channelId } = await api(`/dms/${dm.channelId}/members`, { method: 'POST', body: { userIds: ids } });
      await loadDms();
      if (channelId !== dm.channelId) await goHome(channelId);
    },
  });
}

function renameGroupDialog(dm) {
  ask({
    title: 'Nome do grupo',
    text: 'Todo mundo do grupo vê o nome novo. Deixe vazio para mostrar os nomes das pessoas.',
    value: dm.name || '',
    maxLength: 60,
    okLabel: 'Salvar',
    onSubmit: (name) => api(`/dms/${dm.channelId}`, { method: 'PATCH', body: { name } }),
  });
}

function groupMenu(anchor, dm) {
  const owner = dm.ownerId === state.me.id;
  openMenu(anchor, [
    { label: '✏️  Mudar nome do grupo', onClick: () => renameGroupDialog(dm) },
    { label: '➕  Adicionar pessoas', onClick: () => addToGroupDialog(dm) },
    { label: '👢  Tirar alguém do grupo', hidden: !owner || !dm.users.length, onClick: () => removeFromGroupMenu(anchor, dm) },
    { separator: true },
    {
      label: '🚪  Sair do grupo', danger: true,
      onClick: () => confirmDialog({
        title: `Sair de "${dmName(dm)}"?`,
        text: 'Você só volta se alguém do grupo te adicionar de novo.',
        okLabel: 'Sair do grupo',
        onConfirm: async () => {
          await api(`/dms/${dm.channelId}/members/me`, { method: 'DELETE' });
          if (voiceState().channelId === dm.channelId) leaveVoice();
          state.dms = state.dms.filter((d) => d.channelId !== dm.channelId);
          goHome();
        },
      }),
    },
  ], { align: 'end', className: 'popover-menu' });
}

function removeFromGroupMenu(anchor, dm) {
  openMenu(anchor, dm.users.map((u) => ({
    label: `👢  ${u.displayName}`,
    onClick: () => confirmDialog({
      title: `Tirar ${u.displayName} do grupo?`,
      okLabel: 'Tirar',
      onConfirm: () => api(`/dms/${dm.channelId}/members/${u.id}`, { method: 'DELETE' }),
    }),
  })), { align: 'end', className: 'popover-menu' });
}

// ================================================================ Chamadas em mensagem direta

function startDmCall(dm, video) {
  if (state.view !== 'home' || state.channelId !== dm.channelId) goHome(dm.channelId);
  stopRinging(dm.channelId);
  // Ninguém na chamada ainda: quem liga ouve "chamando…" até alguém atender.
  const ringback = !(dm.voice && dm.voice.some((p) => p.userId !== state.me.id));
  joinVoice({ channelId: dm.channelId, channelName: dmName(dm), serverId: null, serverName: '', isDm: true, video, ringback });
}

function answerCall(channelId, video) {
  const dm = state.dms.find((d) => d.channelId === channelId);
  if (!dm) return;
  startDmCall(dm, video);
}

function onDmVoiceUpdate(channelId, states) {
  const dm = state.dms.find((d) => d.channelId === channelId);
  if (!dm) { loadDmsSoon(); return; }
  dm.voice = states;
  // Ninguém mais na chamada: para de tocar.
  if (!states.length) stopRinging(channelId);
  renderSidebar();
  if (state.view === 'home' && state.channelId === channelId) { renderHeader(); renderCallStage(); }
}

// Alguém está ligando: toque de celular (marimba) + janelinha com Atender / Recusar.
const ringing = new Map(); // channelId -> { el, stop }
// "Não perturbe" (manual ou no horário agendado) e o sino desligado deixam tudo em silêncio.
const silenced = () => state.me.status === 'dnd' || quietNow(state.me.dndSchedule);

function onCallRing({ channelId, from, video }) {
  if (voiceState().channelId === channelId || ringing.has(channelId)) return;
  const dm = state.dms.find((d) => d.channelId === channelId);
  const show = (d) => {
    const el = h('div', { class: 'incoming-call', role: 'alertdialog', 'aria-label': 'Chamada recebida' },
      avatar(from, { size: 'lg' }),
      h('div', { class: 'ic-text' },
        h('strong', {}, from.displayName),
        h('span', { class: 'muted' }, d && d.isGroup ? `está chamando em ${dmName(d)}` : (video ? 'chamada de vídeo' : 'está te ligando…'))),
      h('div', { class: 'ic-actions' },
        h('button', { class: 'round-btn big ok', title: 'Atender', onclick: () => answerCall(channelId, false) }, '📞'),
        h('button', { class: 'round-btn big ok', title: 'Atender com vídeo', onclick: () => answerCall(channelId, true) }, '📹'),
        h('button', {
          class: 'round-btn big danger', title: 'Recusar',
          onclick: () => { stopRinging(channelId); if (state.socket) state.socket.emit('call:decline', { channelId }); },
        }, '✕')));
    $('#incoming-calls').append(el);
    if (!silenced() && state.soundOn) startRingtone();
    if ('vibrate' in navigator && !silenced()) { try { navigator.vibrate([400, 200, 400, 200, 400]); } catch { /* */ } }
    const stop = setTimeout(() => stopRinging(channelId), 30000);
    ringing.set(channelId, { el, stop });
  };
  if (dm) show(dm);
  else loadDms().then(() => show(state.dms.find((d) => d.channelId === channelId))).catch(() => {});
}

function stopRinging(channelId) {
  for (const [id, r] of ringing) {
    if (channelId !== undefined && id !== channelId) continue;
    clearTimeout(r.stop);
    r.el.remove();
    ringing.delete(id);
  }
  if (!ringing.size) stopRingtone();
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
  { label: state.me.statusText ? '💬  Editar status personalizado' : '💬  Definir status personalizado', onClick: openStatusDialog },
  { separator: true },
  { label: '⚙️  Configurações do usuário', onClick: () => openAccountSettings() },
  { label: '🎨  Aparência (tema e cor)', onClick: () => openAccountSettings('appearance') },
  { label: '📲  Instalar o Nexo como app', hidden: !canPromptInstall(), onClick: () => promptInstall() },
  { label: '🤖  Desenvolvedor (bots)', onClick: () => openDeveloper() },
  { label: '🛡️  Administração do Nexo', hidden: !state.me.isAdmin, onClick: () => openAdmin() },
  { separator: true },
  { label: '🚪  Sair da conta', danger: true, onClick: () => logout() },
]));
$('#btn-settings').addEventListener('click', () => openAccountSettings());

function applyMe(user) {
  state.me = user;
  renderUserPanel();
  if (state.channelId) renderMessages();
  refreshAccountSettings();
}

initAccount({ applyMe, setSession, logout: (opts) => logout(opts) });

async function saveMe(changes) {
  try {
    const { user } = await api('/me', { method: 'PATCH', body: changes });
    applyMe(user);
  } catch (err) {
    toast(err.message);
  }
}

$('#home-btn').addEventListener('click', () => goHome());
onTtsChange(() => { if (state.me) renderHeader(); });

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
        m.content ? h('div', { class: 'msg-text' }, renderContent(m.content)) : null,
        m.attachments.length ? h('div', { class: 'muted small' }, `📎 ${m.attachments.length} anexo(s)`) : null,
        m.gif ? h('div', { class: 'muted small' }, '🎞️ GIF') : null,
        m.sticker ? h('div', { class: 'muted small' }, `🏷️ Figurinha: ${m.sticker.name}`) : null,
        m.poll ? h('div', { class: 'muted small' }, `📊 ${m.poll.question}`) : null),
      actions.length ? h('div', { class: 'result-actions' }, actions) : null));
}

// ================================================================ Busca

const search = { q: '', results: [], total: 0, hasMore: false, loading: false, scopeKey: '', ran: false,
  filters: { authorId: null, has: '', since: '', until: '' } };

const HAS_OPTIONS = [
  ['', 'Qualquer coisa'], ['arquivo', '📎 Arquivo'], ['imagem', '🖼️ Imagem'], ['video', '🎬 Vídeo'],
  ['link', '🔗 Link'], ['gif', '🎞️ GIF'], ['audio', '🎤 Áudio'], ['enquete', '📊 Enquete'],
];
const HAS_ALIASES = { arquivo: 'arquivo', arquivos: 'arquivo', anexo: 'arquivo', imagem: 'imagem', foto: 'imagem', video: 'video', vídeo: 'video', link: 'link', gif: 'gif', audio: 'audio', áudio: 'audio', voz: 'audio', enquete: 'enquete' };

function searchScope() {
  if (state.view !== 'home') return { key: `s${state.view}`, qs: `serverId=${state.view}` };
  if (state.channelId) return { key: `c${state.channelId}`, qs: `channelId=${state.channelId}` };
  return { key: 'dms', qs: 'dms=1' };
}

// Atalhos no texto: "de:ana", "tem:link", "depois:2026-10-01", "antes:2026-10-31".
function parseSearch(text) {
  const f = {};
  let unknown = null;
  const q = text
    .replace(/(?:^|\s)(?:de|from):@?([a-z0-9_.]{1,32})/gi, (_, name) => {
      const u = knownUsers().get(name.toLowerCase());
      if (u) f.authorId = u.id; else unknown = `Não encontrei o usuário @${name}.`;
      return ' ';
    })
    .replace(/(?:^|\s)tem:(\S+)/gi, (_, v) => {
      const k = HAS_ALIASES[v.toLowerCase()];
      if (k) f.has = k; else unknown = `Filtro "tem:${v}" não existe. Use: arquivo, imagem, video, link, gif, audio ou enquete.`;
      return ' ';
    })
    .replace(/(?:^|\s)(depois|antes):(\d{4}-\d{2}-\d{2})/gi, (_, k, d) => {
      f[k.toLowerCase() === 'depois' ? 'since' : 'until'] = d;
      return ' ';
    })
    .replace(/\s+/g, ' ').trim();
  return { q, f, unknown };
}

const hasFilters = () => !!(search.filters.authorId || search.filters.has || search.filters.since || search.filters.until);

async function runSearch(more = false) {
  const text = $('#search-input').value.trim();
  const scope = searchScope();
  if (!more) {
    const { q, f, unknown } = parseSearch(text);
    if (unknown) return toast(unknown);
    // Mudou de lugar (outro servidor/conversa): começa sem filtros.
    if (search.scopeKey && search.scopeKey !== scope.key) search.filters = { authorId: null, has: '', since: '', until: '' };
    Object.assign(search.filters, f);
    Object.assign(search, { q, results: [], total: 0, hasMore: false, scopeKey: scope.key });
  }
  if (!search.q && !hasFilters()) {
    // Nada para buscar ainda: mostra só os filtros.
    Object.assign(search, { ran: false, loading: false, results: [], total: 0, hasMore: false, scopeKey: scope.key });
    return renderSearch();
  }
  search.loading = true;
  search.ran = true;
  renderSearch();
  try {
    const params = new URLSearchParams();
    if (search.q) params.set('q', search.q);
    const f = search.filters;
    if (f.authorId) params.set('authorId', f.authorId);
    if (f.has) params.set('has', f.has);
    // Datas do dia inteiro, no horário daqui.
    if (f.since) params.set('since', new Date(`${f.since}T00:00:00`).toISOString());
    if (f.until) params.set('until', new Date(`${f.until}T23:59:59.999`).toISOString());
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

// Pessoas para o filtro "De": membros do servidor, ou quem está nas suas conversas.
function searchPeople() {
  const list = state.view !== 'home' && state.detail
    ? state.detail.members
    : [...knownUsers().values()];
  const seen = new Set();
  return list.filter((u) => u && !seen.has(u.id) && seen.add(u.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
}

function searchFilterBar() {
  const f = search.filters;
  const apply = () => runSearch();
  const who = h('select', { class: 'sf-select', 'aria-label': 'De quem', onchange: (e) => { f.authorId = e.target.value ? Number(e.target.value) : null; apply(); } },
    h('option', { value: '' }, 'Qualquer pessoa'),
    searchPeople().map((u) => h('option', { value: String(u.id), selected: f.authorId === u.id }, u.displayName)));
  const has = h('select', { class: 'sf-select', 'aria-label': 'Tem', onchange: (e) => { f.has = e.target.value; apply(); } },
    HAS_OPTIONS.map(([v, label]) => h('option', { value: v, selected: f.has === v }, label)));
  const since = h('input', { type: 'date', class: 'sf-date', value: f.since, 'aria-label': 'A partir de', onchange: (e) => { f.since = e.target.value; apply(); } });
  const until = h('input', { type: 'date', class: 'sf-date', value: f.until, 'aria-label': 'Até', onchange: (e) => { f.until = e.target.value; apply(); } });
  return h('div', { class: 'search-filters' },
    h('label', { class: 'sf' }, h('span', {}, 'De'), who),
    h('label', { class: 'sf' }, h('span', {}, 'Tem'), has),
    h('label', { class: 'sf' }, h('span', {}, 'A partir de'), since),
    h('label', { class: 'sf' }, h('span', {}, 'Até'), until),
    hasFilters() ? h('button', { class: 'btn small sf-clear', onclick: () => { search.filters = { authorId: null, has: '', since: '', until: '' }; apply(); } }, 'Limpar filtros') : null);
}

function renderSearch() {
  forgetListsPanel();
  const panel = $('#search-panel');
  panel.hidden = false;
  $('#app').classList.add('searching');
  const countText = !search.ran ? 'Buscar mensagens'
    : search.loading && search.results.length === 0 ? 'Buscando…'
    : search.total === 0 ? 'Nenhum resultado'
      : search.total >= 1000 ? 'Mais de 1000 resultados' : `${search.total} ${search.total === 1 ? 'resultado' : 'resultados'}`;
  const channelName = (m) => {
    if (!m.channel) return null;
    if (m.channel.kind === 'dm') {
      const dm = state.dms.find((d) => d.channelId === m.channelId);
      return dm ? (dm.isGroup ? `👥 ${dmName(dm)}` : `@${dm.user.displayName}`) : 'Mensagem direta';
    }
    return m.channel.kind === 'thread' ? `🧵 ${m.channel.name}` : `# ${m.channel.name}`;
  };
  panel.replaceChildren(
    h('div', { class: 'search-head' },
      h('strong', {}, countText),
      h('button', { class: 'icon-btn small', title: 'Fechar busca', onclick: closeSearch }, '✕')),
    searchFilterBar(),
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
      !search.loading && search.total === 0 ? h('p', { class: 'muted search-tip' },
        search.ran ? 'Nada encontrado. Tente outras palavras ou tire algum filtro.' : 'Digite algo ou escolha um filtro.',
        h('br'), 'Atalhos: de:ana · tem:link · depois:2026-10-01 · antes:2026-10-31') : null),
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
  search.filters = { authorId: null, has: '', since: '', until: '' };
}

$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  if (e.key === 'Escape' && !e.currentTarget.value && !$('#search-panel').hidden) { e.preventDefault(); closeSearch(); e.currentTarget.blur(); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.value = ''; closeSearch(); e.currentTarget.blur(); }
});
$('#search-input').addEventListener('search', (e) => { if (!e.currentTarget.value) closeSearch(); });

initVoice({ getSocket: () => state.socket, onChange: onVoiceChange, myId: () => (state.me ? state.me.id : null), getSounds: (serverId) => (state.detail && state.detail.server.id === serverId ? state.detail.sounds || [] : []) });
onThemeChange(() => { if (state.me && state.channelId) renderMessages(); });

// Funções usadas pelas outras telas (amigos, configurações).
export { openDm, goHome, refreshDetail, loadFriends, renderAll, selectChannel, botTag };

boot();

// Versão nova do Nexo: recarrega sozinho só se a pessoa não estiver no meio de algo.
initUpdates({
  canReloadNow: () => !inVoice() && !input.value.trim() && !state.uploads.length
    && !document.querySelector('dialog[open]') && !document.querySelector('.settings-overlay'),
});
