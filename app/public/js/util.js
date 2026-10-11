// Utilidades do frontend: criação de elementos, API, janelas, menus e formatação.
// Regra de ouro: texto vindo de usuários entra SEMPRE como texto (textContent),
// nunca como HTML — assim ninguém consegue injetar scripts nas mensagens.

export const $ = (sel, root = document) => root.querySelector(sel);

// h('div', { class: 'x', onclick: fn }, 'texto', filho)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// localStorage pode falhar (aba anônima etc.); nunca deixa isso quebrar o app.
export function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* ignora */ }
  return null;
}

// ---------------------------------------------------------------- API

let token = null;
let onUnauthorized = () => {};
export const setToken = (t) => { token = t; };
export const getToken = () => token;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Upload com barra de progresso (fetch não informa progresso de envio).
export function uploadFile(file, onProgress, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'arquivo'));
    xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
    Object.entries(extraHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, String(v)));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* resposta vazia */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.attachment);
      else reject(new Error(data.error || (xhr.status === 413 ? 'Arquivo grande demais.' : `Erro ${xhr.status}`)));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão.'));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------- Formatação

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
export const formatTime = (d) => timeFmt.format(d);

export function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return dateFmt.format(date);
}

export function fullTime(date) {
  const label = dayLabel(date);
  return label === 'Hoje' || label === 'Ontem'
    ? `${label} às ${timeFmt.format(date)}`
    : `${dateFmt.format(date)} ${timeFmt.format(date)}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => [...p][0]).join('').toUpperCase() || '?';

export const hueFor = (id) => ((Number(id) || 0) * 137) % 360;

// Status de presença: online, ausente, não perturbe ou offline.
export const STATUS_LABEL = {
  online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível', offline: 'Offline',
};
export const presenceOf = (u) => (u && u.status) || (u && u.online ? 'online' : 'offline');

// "online" pode ser true/false ou um status ('online', 'idle', 'dnd', 'offline').
export function avatar(user, { size, online } = {}) {
  const el = h('div', { class: `avatar${size ? ` ${size}` : ''}`, style: `--hue:${hueFor(user.id)}` });
  if (user.avatarUrl) {
    const img = h('img', { class: 'avatar-img', src: user.avatarUrl, alt: '', loading: 'lazy', draggable: 'false' });
    // Se a foto falhar (apagada no meio do caminho), volta para as iniciais.
    img.addEventListener('error', () => img.replaceWith(initials(user.displayName)));
    el.append(img);
  } else el.append(initials(user.displayName));
  if (online !== undefined) {
    const status = typeof online === 'string' ? (online === 'invisible' ? 'offline' : online) : (online ? 'online' : 'offline');
    el.append(h('span', { class: `dot ${status}${status !== 'offline' ? ' on' : ''}`, title: STATUS_LABEL[status] || 'Offline' }));
  }
  return el;
}

// Foto de perfil / ícone do servidor: recorta no centro (quadrado), reduz para 256x256 e envia.
export async function uploadAvatar(file, path = '/api/me/avatar') {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Escolha uma imagem PNG, JPG, GIF ou WEBP.');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Não deu para abrir essa imagem.'); });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  if (bitmap.close) bitmap.close();
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.9);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/png');
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data.user || data.server;
}

export function badge(count) {
  return count > 0 ? h('span', { class: 'badge' }, count > 99 ? '99+' : String(count)) : null;
}

// ---------------------------------------------------------------- Avisos

let toastTimer;
export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

export async function copyText(text, fallbackInput) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Em http:// (sem HTTPS) a API de área de transferência é bloqueada; tenta o jeito antigo.
    if (!fallbackInput) return false;
    fallbackInput.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

// ---------------------------------------------------------------- Janelas (modais)

// openDialog({ title, text, body, actions: [{ label, kind, onClick, close }] })
// onClick pode ser async; se lançar erro, a mensagem aparece na janela.
export function openDialog({ title, text, body, actions = [], wide = false, onClose }) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const buttons = actions.map((a) => h('button', {
    type: a.submit ? 'submit' : 'button',
    class: `btn ${a.kind || 'ghost'}`,
  }, a.label));
  const form = h('form', { method: 'dialog', class: 'dialog-form' },
    title ? h('h2', {}, title) : null,
    text ? h('p', { class: 'muted' }, text) : null,
    body || null,
    error,
    buttons.length ? h('div', { class: 'dialog-actions' }, buttons) : null,
  );
  const dialog = h('dialog', { class: wide ? 'wide' : '' }, form);
  document.body.append(dialog);

  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => { dialog.remove(); if (onClose) onClose(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // clique fora fecha

  const run = async (a, btn) => {
    error.textContent = '';
    if (!a.onClick) return close();
    btn.disabled = true;
    try {
      const keep = await a.onClick();
      if (keep !== false && a.close !== false) close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  actions.forEach((a, i) => buttons[i].addEventListener('click', (e) => { e.preventDefault(); run(a, buttons[i]); }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const i = actions.findIndex((a) => a.submit);
    if (i !== -1) run(actions[i], buttons[i]);
  });

  dialog.showModal();
  const first = form.querySelector('input:not([type=hidden]):not([readonly]), textarea, select');
  if (first) { first.focus(); if (first.select) first.select(); }
  return { dialog, close, setError: (m) => { error.textContent = m; } };
}

// Pergunta com um campo de texto.
export function ask({ title, text, placeholder = '', value = '', okLabel = 'OK', maxLength = 100, onSubmit }) {
  const input = h('input', { placeholder, maxlength: String(maxLength), value });
  openDialog({
    title, text, body: input,
    actions: [
      { label: 'Cancelar' },
      { label: okLabel, kind: 'primary', submit: true, onClick: () => onSubmit(input.value.trim()) },
    ],
  });
}

// Confirmação simples (botão vermelho para ações destrutivas).
export function confirmDialog({ title, text, okLabel = 'Confirmar', danger = true, onConfirm }) {
  openDialog({
    title, text,
    actions: [
      { label: 'Cancelar' },
      { label: okLabel, kind: danger ? 'danger' : 'primary', submit: true, onClick: onConfirm },
    ],
  });
}

// ---------------------------------------------------------------- Popovers e menus

let activePopover = null;

export function closePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

// Mostra "content" flutuando perto de "anchor" (um elemento ou {x, y}).
export function openPopover(anchor, content, { align = 'start', className = '' } = {}) {
  closePopover();
  const pop = h('div', { class: `popover ${className}` }, content);
  // Dentro de uma janela (dialog), o popover precisa ficar dentro dela para ser clicável.
  const host = (anchor instanceof Element && anchor.closest('dialog[open]')) || document.body;
  host.append(pop);
  activePopover = pop;

  const place = () => {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };
  place();
  // O conteúdo pode crescer depois (ex.: lista carregada): reposiciona.
  if (window.ResizeObserver) new ResizeObserver(() => { if (pop.isConnected) place(); }).observe(pop);

  setTimeout(() => {
    const onDown = (e) => {
      if (!pop.isConnected) return document.removeEventListener('mousedown', onDown, true);
      if (!pop.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) {
        closePopover();
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);
  });
  return pop;
}

// Menu de opções: items = [{ label, onClick, danger, hidden }]
export function openMenu(anchor, items, opts) {
  const visible = items.filter((i) => i && !i.hidden);
  return openPopover(anchor, h('div', { class: 'menu', role: 'menu' },
    visible.map((i) => (i.separator ? h('div', { class: 'menu-sep' }) : h('button', {
      class: `menu-item${i.danger ? ' danger' : ''}`,
      role: 'menuitem',
      onclick: () => { closePopover(); i.onClick(); },
    }, i.label)))), opts);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

// ---------------------------------------------------------------- Som de notificação

let audioCtx = null;
export function playPing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  } catch { /* sem áudio */ }
}
