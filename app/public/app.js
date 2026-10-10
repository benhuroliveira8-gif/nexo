// Nexo — frontend (Fase 1). JavaScript puro, sem etapa de build.
// Todo texto vindo de usuários é inserido com textContent (nunca innerHTML),
// para evitar que alguém injete HTML/scripts nas mensagens.

const $ = (sel) => document.querySelector(sel);

// Cria elementos: h('div', { class: 'x', onclick: fn }, 'texto', filho)
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------------------------------------------------------- Estado

const state = {
  token: localStorage.getItem('nexo.token'),
  me: null,
  socket: null,
  servers: [],
  serverId: null,
  detail: null,               // { server, channels, members }
  channelId: null,
  messages: new Map(),        // channelId -> { items, hasMore, loading }
  unreadChannels: new Set(),
  unreadServers: new Set(),
  typing: new Map(),          // channelId -> Map(userId -> { name, timer })
};

let tempSeq = 0;
const emptyState = $('#empty-state'); // guardado para reaparecer quando não houver servidor

// ---------------------------------------------------------------- Utilidades

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* navegação privada etc. */ }
  return null;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) logout();
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

const hueFor = (id) => ((Number(id) || 0) * 137) % 360;

function avatar(user, { size, online } = {}) {
  const el = h('div', { class: `avatar${size ? ` ${size}` : ''}`, style: `--hue:${hueFor(user.id)}` },
    initials(user.displayName));
  if (online !== undefined) el.append(h('span', { class: `dot${online ? ' on' : ''}` }));
  return el;
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return dateFmt.format(date);
}

function fullTime(date) {
  const label = dayLabel(date);
  return label === 'Hoje' || label === 'Ontem'
    ? `${label} às ${timeFmt.format(date)}`
    : `${dateFmt.format(date)} ${timeFmt.format(date)}`;
}

// Janela simples com um campo de texto.
function ask({ title, text, placeholder = '', value = '', okLabel = 'OK', readonly = false, onSubmit }) {
  const dialog = $('#dialog');
  const input = $('#dialog-input');
  const error = $('#dialog-error');
  const ok = $('#dialog-ok');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text || '';
  input.value = value;
  input.placeholder = placeholder;
  input.readOnly = readonly;
  error.textContent = '';
  ok.textContent = okLabel;
  ok.disabled = false;

  const form = $('#dialog-form');
  form.onsubmit = async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return; // fecha normalmente
    e.preventDefault();
    error.textContent = '';
    ok.disabled = true;
    try {
      await onSubmit(input.value.trim());
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      ok.disabled = false;
    }
  };
  dialog.showModal();
  input.focus();
  input.select();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Em http:// (sem HTTPS) a API de clipboard é bloqueada; tenta o jeito antigo.
    const input = $('#dialog-input');
    input.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

// ---------------------------------------------------------------- Login / cadastro

let authMode = 'login';

function showAuth(mode = 'login') {
  authMode = mode;
  const register = mode === 'register';
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth-title').textContent = register ? 'Crie sua conta' : 'Bem-vindo de volta';
  $('#auth-subtitle').textContent = register
    ? 'Leva menos de um minuto.'
    : 'Entre para continuar a conversa.';
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
  const body = {
    username: form.username.value.trim().toLowerCase(),
    password: form.password.value,
  };
  if (authMode === 'register') body.displayName = form.displayName.value.trim();
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const data = await api(`/auth/${authMode}`, { method: 'POST', body });
    state.token = data.token;
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
  Object.assign(state, {
    token: null, me: null, socket: null, servers: [], serverId: null, detail: null, channelId: null,
  });
  state.messages.clear();
  state.unreadChannels.clear();
  state.unreadServers.clear();
  state.typing.clear();
  showAuth('login');
}

$('#btn-logout').addEventListener('click', logout);

// ---------------------------------------------------------------- Início

async function boot() {
  if (!state.token) return showAuth('login');
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
  $('#me-avatar').replaceWith(Object.assign(avatar(user), { id: 'me-avatar' }));
  $('#me-name').textContent = user.displayName;
  $('#me-username').textContent = `@${user.username}`;
  if (storage('nexo.hideMembers') === '1') $('#app').classList.add('no-members');

  connectSocket();
  await loadServers();
  const saved = Number(storage('nexo.server'));
  const first = state.servers.find((s) => s.id === saved) || state.servers[0];
  if (first) await selectServer(first.id);
  else renderEmpty();
}

// ---------------------------------------------------------------- Tempo real

function connectSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  let connectedBefore = false;

  socket.on('connect', () => {
    $('#conn-status').hidden = true;
    // Depois de uma queda, recarrega o que pode ter perdido.
    if (connectedBefore && state.serverId) refreshAfterReconnect();
    connectedBefore = true;
  });
  socket.on('disconnect', () => { $('#conn-status').hidden = false; });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout();
    else $('#conn-status').hidden = false;
  });

  socket.on('message:new', onMessage);

  socket.on('channel:created', (channel) => {
    if (!state.detail || channel.serverId !== state.serverId) return;
    if (state.detail.channels.some((c) => c.id === channel.id)) return;
    state.detail.channels.push(channel);
    renderChannels();
  });

  socket.on('member:joined', ({ serverId, member }) => {
    if (!state.detail || serverId !== state.serverId) return;
    if (state.detail.members.some((m) => m.id === member.id)) return;
    state.detail.members.push(member);
    renderMembers();
  });

  socket.on('presence', ({ userId, online }) => {
    const m = state.detail && state.detail.members.find((x) => x.id === userId);
    if (m) {
      m.online = online;
      renderMembers();
    }
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

async function refreshAfterReconnect() {
  await loadServers();
  // Joga fora o cache e recarrega o servidor/canal atuais.
  state.messages.clear();
  if (state.servers.some((s) => s.id === state.serverId)) await selectServer(state.serverId, state.channelId);
}

function onMessage(msg) {
  const bucket = state.messages.get(msg.channelId);
  if (bucket) {
    if (bucket.items.some((m) => m.id === msg.id)) return;
    // Minha própria mensagem: troca a versão "enviando…" pela confirmada.
    const pending = msg.author.id === state.me.id &&
      bucket.items.find((m) => m.pending && m.content === msg.content);
    if (pending) Object.assign(pending, msg, { pending: false, tempId: undefined });
    else bucket.items.push(msg);
  }

  clearTyping(msg.channelId, msg.author.id);

  if (msg.channelId === state.channelId) {
    renderMessages({ stick: msg.author.id === state.me.id ? 'always' : 'if-near' });
  } else if (msg.author.id !== state.me.id) {
    if (msg.serverId === state.serverId) {
      state.unreadChannels.add(msg.channelId);
      renderChannels();
    } else {
      state.unreadServers.add(msg.serverId);
      renderServerList();
    }
  }
}

function clearTyping(channelId, userId) {
  const map = state.typing.get(channelId);
  const entry = map && map.get(userId);
  if (entry) {
    clearTimeout(entry.timer);
    map.delete(userId);
    renderTyping();
  }
}

// ---------------------------------------------------------------- Servidores e canais

async function loadServers() {
  const { servers } = await api('/servers');
  state.servers = servers;
  renderServerList();
}

async function selectServer(serverId, preferredChannelId) {
  state.serverId = serverId;
  state.unreadServers.delete(serverId);
  storage('nexo.server', String(serverId));
  renderServerList();

  const detail = await api(`/servers/${serverId}`);
  if (state.serverId !== serverId) return; // usuário clicou em outro no meio do caminho
  state.detail = detail;
  state.unreadChannels.clear();

  $('#server-name').textContent = detail.server.name;
  $('#btn-invite').hidden = false;
  $('#btn-create-channel').hidden = detail.server.ownerId !== state.me.id;
  renderMembers();

  const saved = preferredChannelId || Number(storage(`nexo.channel.${serverId}`));
  const channel = detail.channels.find((c) => c.id === saved) || detail.channels[0];
  if (channel) await selectChannel(channel.id);
  else renderChannels();
}

async function selectChannel(channelId) {
  state.channelId = channelId;
  state.unreadChannels.delete(channelId);
  storage(`nexo.channel.${state.serverId}`, String(channelId));
  $('#app').classList.remove('sidebar-open');

  const channel = state.detail.channels.find((c) => c.id === channelId);
  $('#channel-name').textContent = channel ? channel.name : '';
  $('#composer').hidden = false;
  $('#composer-input').placeholder = `Conversar em #${channel ? channel.name : ''}`;
  renderChannels();
  renderTyping();

  if (!state.messages.has(channelId)) {
    state.messages.set(channelId, { items: [], hasMore: true, loading: false });
    renderMessages({ stick: 'always' });
    await loadOlder(channelId);
  }
  if (state.channelId === channelId) renderMessages({ stick: 'always' });
  if (window.matchMedia('(min-width: 901px)').matches) $('#composer-input').focus();
}

async function loadOlder(channelId) {
  const bucket = state.messages.get(channelId);
  if (!bucket || bucket.loading || !bucket.hasMore) return;
  bucket.loading = true;
  const oldest = bucket.items.find((m) => !m.pending);
  try {
    const qs = oldest ? `?before=${oldest.id}` : '';
    const { messages, hasMore } = await api(`/channels/${channelId}/messages${qs}`);
    const known = new Set(bucket.items.map((m) => m.id));
    bucket.items.unshift(...messages.filter((m) => !known.has(m.id)));
    bucket.hasMore = hasMore;
  } catch (err) {
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

// ---------------------------------------------------------------- Renderização

function renderServerList() {
  const list = $('#server-list');
  list.replaceChildren(...state.servers.map((s) =>
    h('button', {
      class: `rail-btn${s.id === state.serverId ? ' active' : ''}${state.unreadServers.has(s.id) ? ' unread' : ''}`,
      title: s.name,
      onclick: () => selectServer(s.id),
    }, initials(s.name)),
  ));
}

function renderChannels() {
  const list = $('#channel-list');
  const channels = state.detail ? [...state.detail.channels].sort((a, b) => a.position - b.position || a.id - b.id) : [];
  list.replaceChildren(...channels.map((c) =>
    h('li', {},
      h('button', {
        class: `channel${c.id === state.channelId ? ' active' : ''}${state.unreadChannels.has(c.id) ? ' unread' : ''}`,
        onclick: () => selectChannel(c.id),
      }, h('span', { class: 'hash' }, '#'), h('span', { class: 'truncate' }, c.name)),
    ),
  ));
}

function renderMembers() {
  const panel = $('#member-list');
  if (!state.detail) return panel.replaceChildren();
  const ownerId = state.detail.server.ownerId;
  const online = state.detail.members.filter((m) => m.online);
  const offline = state.detail.members.filter((m) => !m.online);
  const group = (title, members, isOnline) => members.length === 0 ? null :
    h('div', { class: 'member-group' },
      h('div', { class: 'section-title' }, `${title} — ${members.length}`),
      ...members.map((m) =>
        h('div', { class: `member${isOnline ? '' : ' off'}`, title: `@${m.username}` },
          avatar(m, { size: 'sm', online: isOnline }),
          h('span', { class: 'name truncate' }, m.displayName),
          m.id === ownerId ? h('span', { class: 'owner-badge', title: 'Dono do servidor' }, '★') : null,
        )),
    );
  panel.replaceChildren(...[group('Online', online, true), group('Offline', offline, false)].filter(Boolean));
}

function renderEmpty() {
  $('#server-name').textContent = 'Nenhum servidor';
  $('#channel-name').textContent = '';
  $('#btn-invite').hidden = true;
  $('#btn-create-channel').hidden = true;
  $('#composer').hidden = true;
  $('#channel-list').replaceChildren();
  $('#member-list').replaceChildren();
  $('#messages').replaceChildren(emptyState);
}

function renderMessages({ stick = 'if-near' } = {}) {
  const box = $('#messages');
  const bucket = state.messages.get(state.channelId);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;

  const nodes = [];
  if (bucket) {
    if (bucket.hasMore) {
      nodes.push(h('div', { class: 'load-more' }, bucket.loading ? 'Carregando…' : 'Role para cima para ver mais'));
    } else {
      const channel = state.detail.channels.find((c) => c.id === state.channelId);
      nodes.push(h('div', { class: 'empty', style: 'margin-top:24px;text-align:left;max-width:none' },
        h('h2', {}, `Bem-vindo a #${channel ? channel.name : ''}!`),
        h('p', { class: 'muted' }, 'Este é o começo do canal.')));
    }

    let prev = null;
    for (const m of bucket.items) {
      const date = new Date(m.createdAt);
      const newDay = !prev || new Date(prev.createdAt).toDateString() !== date.toDateString();
      if (newDay) nodes.push(h('div', { class: 'day-sep' }, dayLabel(date)));

      const sameGroup = prev && !newDay && prev.author.id === m.author.id &&
        date - new Date(prev.createdAt) < 7 * 60 * 1000;
      const textClass = `msg-text${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}`;

      if (sameGroup) {
        nodes.push(h('div', { class: 'msg-line' },
          h('span', { class: 'msg-time hover', title: fullTime(date) }, timeFmt.format(date)),
          h('div', { class: textClass }, m.content)));
      } else {
        nodes.push(h('div', { class: 'msg-group' },
          avatar(m.author),
          h('div', { class: 'msg-body' },
            h('div', { class: 'msg-head' },
              h('span', { class: 'msg-author', style: `color:hsl(${hueFor(m.author.id)} 75% 72%)` }, m.author.displayName),
              h('span', { class: 'msg-time', title: fullTime(date) }, fullTime(date))),
            h('div', { class: textClass }, m.content))));
      }
      prev = m;
    }
  }
  box.replaceChildren(...nodes);

  if (stick === 'always' || (stick === 'if-near' && nearBottom)) box.scrollTop = box.scrollHeight;
  else if (stick === 'keep-position') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  else box.scrollTop = prevTop;
}

function renderTyping() {
  const map = state.typing.get(state.channelId);
  const names = map ? [...map.values()].map((t) => t.name) : [];
  const el = $('#typing');
  if (names.length === 0) return el.replaceChildren();
  const who = names.length > 3
    ? [h('strong', {}, 'Várias pessoas')]
    : names.flatMap((n, i) => [i ? (i === names.length - 1 ? ' e ' : ', ') : '', h('strong', {}, n)]);
  el.replaceChildren(...who, names.length === 1 ? ' está digitando…' : ' estão digitando…');
}

// ---------------------------------------------------------------- Enviar mensagens

const input = $('#composer-input');
let lastTypingSent = 0;

function autoResize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', () => {
  autoResize();
  const now = Date.now();
  if (input.value.trim() && now - lastTypingSent > 2500 && state.socket) {
    lastTypingSent = now;
    state.socket.emit('typing', { channelId: state.channelId });
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const content = input.value.trim();
  if (!content || !state.channelId || !state.socket) return;
  if (!state.socket.connected) return toast('Sem conexão. Aguarde reconectar.');

  const channelId = state.channelId;
  const temp = {
    id: `tmp-${++tempSeq}`, tempId: true, pending: true, channelId, serverId: state.serverId,
    content, createdAt: new Date().toISOString(), author: state.me,
  };
  state.messages.get(channelId).items.push(temp);
  input.value = '';
  autoResize();
  lastTypingSent = 0;
  renderMessages({ stick: 'always' });

  state.socket.timeout(10000).emit('message:send', { channelId, content }, (err, res) => {
    const bucket = state.messages.get(channelId);
    if (!bucket) return;
    const idx = bucket.items.indexOf(temp);
    if (err || !res || !res.ok) {
      if (idx !== -1) Object.assign(temp, { pending: false, failed: true });
      toast((res && res.error) || 'Não foi possível enviar a mensagem.');
    } else if (idx !== -1) {
      // Se a mensagem confirmada já chegou pelo "message:new", só remove a temporária.
      if (bucket.items.some((m) => m !== temp && m.id === res.message.id)) bucket.items.splice(idx, 1);
      else Object.assign(temp, res.message, { pending: false, tempId: undefined });
    }
    if (channelId === state.channelId) renderMessages();
  });
});

$('#messages').addEventListener('scroll', (e) => {
  if (e.currentTarget.scrollTop < 80 && state.channelId) loadOlder(state.channelId);
});

// ---------------------------------------------------------------- Botões

$('#btn-create-server').addEventListener('click', () => ask({
  title: 'Criar um servidor',
  text: 'Seu servidor é onde você e seus amigos conversam.',
  placeholder: 'Nome do servidor',
  value: `Servidor de ${state.me.displayName}`,
  okLabel: 'Criar',
  onSubmit: async (name) => {
    if (!name) throw new Error('Dê um nome ao servidor.');
    const { server } = await api('/servers', { method: 'POST', body: { name } });
    state.servers.push(server);
    await selectServer(server.id);
  },
}));

$('#btn-join-server').addEventListener('click', () => ask({
  title: 'Entrar em um servidor',
  text: 'Cole o código de convite que você recebeu.',
  placeholder: 'Ex.: aB3dE9xZ',
  okLabel: 'Entrar',
  onSubmit: async (code) => {
    if (!code) throw new Error('Cole um código de convite.');
    const { server } = await api('/servers/join', { method: 'POST', body: { code } });
    if (!state.servers.some((s) => s.id === server.id)) state.servers.push(server);
    await selectServer(server.id);
  },
}));

$('#btn-create-channel').addEventListener('click', () => ask({
  title: 'Criar canal de texto',
  placeholder: 'novo-canal',
  okLabel: 'Criar',
  onSubmit: async (name) => {
    if (!name) throw new Error('Dê um nome ao canal.');
    const { channel } = await api(`/servers/${state.serverId}/channels`, { method: 'POST', body: { name } });
    if (!state.detail.channels.some((c) => c.id === channel.id)) state.detail.channels.push(channel);
    await selectChannel(channel.id);
  },
}));

$('#btn-invite').addEventListener('click', () => {
  if (!state.detail) return;
  const code = state.detail.server.inviteCode;
  ask({
    title: 'Convide amigos',
    text: 'Envie este código. A pessoa entra clicando em ↪ e colando o código.',
    value: code,
    readonly: true,
    okLabel: 'Copiar',
    onSubmit: async () => {
      if (await copyText(code)) toast('Código copiado!');
      else throw new Error('Não deu para copiar automaticamente. Selecione e copie com Ctrl+C.');
    },
  });
});

$('#btn-toggle-members').addEventListener('click', () => {
  const hidden = $('#app').classList.toggle('no-members');
  storage('nexo.hideMembers', hidden ? '1' : null);
});

$('#btn-toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));

boot();
