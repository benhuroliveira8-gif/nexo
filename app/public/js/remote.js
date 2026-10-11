// Controle remoto (estilo AnyDesk) pela tela compartilhada.
//
// Quem ASSISTE pede o controle; quem COMPARTILHA aceita ou recusa.
// Os comandos (mouse e teclado) vão pelo canal de dados da chamada (LiveKit) até
// o navegador de quem compartilha, que repassa para o programa "Nexo Controle"
// rodando no próprio PC (127.0.0.1). Só esse programa consegue mexer no mouse/teclado.
//
// Segurança:
//  • nada acontece sem quem compartilha clicar em "Permitir";
//  • só a pessoa autorizada é obedecida (o LiveKit garante quem mandou cada mensagem);
//  • só funciona com o "Nexo Controle" aberto, e ele só aceita o endereço do Nexo;
//  • quem compartilha retoma na hora: botão, Ctrl+Alt+End ou mexendo no próprio mouse.
import { h, toast, openDialog } from './util.js';

const HELPER_URL = 'ws://127.0.0.1:47800';
const TOPIC_CTL = 'nexo-ctl';
const TOPIC_IN = 'nexo-in';
const enc = new TextEncoder();
const dec = new TextDecoder();

let ctx = null; // { room(), Track, onChange(), userIdOf(participant), nameOf(participant) }

// Quem assiste: { identity, name, state: 'pending' | 'active' }
let viewing = null;
// Quem compartilha: { identity, name }
let hosting = null;
const lastRequest = new Map(); // identity -> horário (anti-spam)
let openRequest = null; // janela "Fulano quer controlar" aberta

export function initRemote(c) { ctx = c; }
export const remoteState = () => ({ viewing, hosting });

function send(topic, msg, identity, reliable = true) {
  const room = ctx && ctx.room();
  if (!room || !identity) return;
  try {
    room.localParticipant.publishData(enc.encode(JSON.stringify(msg)), { reliable, destinationIdentities: [identity], topic });
  } catch { /* caiu a conexão */ }
}

// ---------------------------------------------------------------- Programa "Nexo Controle"

let helper = null; // { ws, screens, ready }
let helperWaiters = [];

function connectHelper(timeout = 1500) {
  if (helper && helper.ready && helper.ws.readyState === WebSocket.OPEN) return Promise.resolve(helper);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(HELPER_URL); } catch { finish(null); return; }
    const me = { ws, screens: [], ready: false };
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } finish(null); }, timeout);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'hello') {
        me.screens = Array.isArray(msg.screens) ? msg.screens : [];
        me.version = msg.version;
        me.ready = true;
        helper = me;
        clearTimeout(timer);
        finish(me);
      } else if (msg.t === 'revoked') {
        // Ctrl+Alt+End no PC de quem compartilha.
        if (hosting) { toast('Você retomou o controle do seu PC.'); endHosting({ notify: true, fromHelper: true }); }
      } else if (msg.t === 'host-active') {
        if (hosting) send(TOPIC_CTL, { t: 'ctl-host' }, hosting.identity);
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => {
      if (helper === me) {
        helper = null;
        if (hosting) { toast('O Nexo Controle foi fechado: o controle remoto parou.'); endHosting({ notify: true, fromHelper: true }); }
      }
      finish(null);
    };
  });
}

function helperSend(msg) {
  if (helper && helper.ws.readyState === WebSocket.OPEN) helper.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

// Baixa o programa já configurado com o endereço deste Nexo.
export async function downloadHelper() {
  try {
    const res = await fetch('/nexo-controle.ps1', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    let text = await res.text();
    text = text.replace(/__NEXO_SITE__/g, location.origin).replace(/\r?\n/g, '\r\n');
    // Com BOM, para o PowerShell do Windows entender os acentos.
    const blob = new Blob(['﻿', text], { type: 'application/octet-stream' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'nexo-controle.ps1' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch {
    toast('Não foi possível baixar o Nexo Controle.');
  }
}

// ---------------------------------------------------------------- Mensagens recebidas

export function onData(payload, participant, topic) {
  if (!ctx || !participant || (topic !== TOPIC_CTL && topic !== TOPIC_IN)) return;
  if (topic === TOPIC_IN) {
    // Comando de mouse/teclado: só de quem foi autorizado.
    if (!hosting || participant.identity !== hosting.identity) return;
    const msg = parse(payload);
    const clean = msg && sanitizeInput(msg);
    if (clean) helperSend(clean);
    return;
  }
  const msg = parse(payload);
  if (!msg) return;
  const from = participant.identity;
  const name = ctx.nameOf(participant);
  switch (msg.t) {
    case 'ctl-req': onRequest(from, name); break;
    case 'ctl-ans':
      if (viewing && viewing.identity === from && viewing.state === 'pending') {
        if (msg.ok) {
          viewing.state = 'active';
          toast(`🖱️ ${name} deixou você controlar o PC. Clique na tela para usar o teclado.`);
        } else {
          const why = {
            busy: `${name} já está sendo controlado por outra pessoa.`,
            'not-sharing': `${name} não está compartilhando a tela.`,
          }[msg.why] || `${name} recusou o controle.`;
          toast(why);
          viewing = null;
        }
        ctx.onChange();
      }
      break;
    case 'ctl-end':
      if (viewing && viewing.identity === from) {
        toast(`${name} retomou o controle do PC.`);
        stopViewing({ notify: false });
      } else if (hosting && hosting.identity === from) {
        toast(`${name} soltou o controle do seu PC.`);
        endHosting({ notify: false });
      } else if (openRequest && openRequest.identity === from) {
        openRequest.close();
      }
      break;
    case 'ctl-host':
      if (viewing && viewing.identity === from && viewing.state === 'active') hostMovedHint(name);
      break;
    default:
  }
}

function parse(payload) {
  try { return JSON.parse(typeof payload === 'string' ? payload : dec.decode(payload)); } catch { return null; }
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const KEY_RE = /^[A-Za-z0-9]{1,24}$/;

// Só deixa passar comandos conhecidos, com valores dentro dos limites.
function sanitizeInput(m) {
  switch (m.t) {
    case 'm': {
      const x = num(m.x, 0, 1); const y = num(m.y, 0, 1);
      return x === null || y === null ? null : { t: 'm', x, y };
    }
    case 'b': {
      const b = num(m.b, 0, 4);
      return b === null || !Number.isInteger(b) ? null : { t: 'b', b, d: !!m.d };
    }
    case 'w': {
      const dy = num(m.dy || 0, -2400, 2400); const dx = num(m.dx || 0, -2400, 2400);
      return dy === null || dx === null ? null : { t: 'w', dy: Math.round(dy), dx: Math.round(dx) };
    }
    case 'k':
      return typeof m.c === 'string' && KEY_RE.test(m.c) ? { t: 'k', c: m.c, d: !!m.d } : null;
    case 'up': return { t: 'up' }; // soltar tudo
    default: return null;
  }
}

// ---------------------------------------------------------------- Quem compartilha

function myScreenSettings() {
  try {
    const pub = ctx.room().localParticipant.getTrackPublication(ctx.Track().Source.ScreenShare);
    const t = pub && pub.track && pub.track.mediaStreamTrack;
    return t ? t.getSettings() : null;
  } catch { return null; }
}

function onRequest(identity, name) {
  const now = Date.now();
  if (now - (lastRequest.get(identity) || 0) < 4000) return; // anti-spam
  lastRequest.set(identity, now);
  if (!ctx.isSharing()) return send(TOPIC_CTL, { t: 'ctl-ans', ok: false, why: 'not-sharing' }, identity);
  if (hosting || openRequest) return send(TOPIC_CTL, { t: 'ctl-ans', ok: false, why: 'busy' }, identity);
  showRequestDialog(identity, name);
}

function showRequestDialog(identity, name) {
  const body = h('div', { class: 'rc-dialog' });
  let answered = false;
  let chosenScreen = 0;
  const answer = (ok) => {
    if (answered) return;
    answered = true;
    if (!ok) send(TOPIC_CTL, { t: 'ctl-ans', ok: false }, identity);
  };

  const dlg = openDialog({
    title: `🖱️ ${name} quer controlar o seu PC`,
    body,
    actions: [
      { label: 'Recusar', onClick: () => { answer(false); } },
      {
        label: 'Permitir', kind: 'primary', submit: true,
        onClick: async () => {
          const hp = await connectHelper();
          if (!hp) { drawBody(); throw new Error('Abra o Nexo Controle no seu PC primeiro (instruções acima).'); }
          const st = myScreenSettings();
          if (st && st.displaySurface && st.displaySurface !== 'monitor') {
            throw new Error('Para deixar controlar, compartilhe a TELA INTEIRA (não uma janela ou aba).');
          }
          if (!ctx.isSharing()) { answer(false); return; }
          answered = true;
          startHosting(identity, name, chosenScreen);
        },
      },
    ],
    onClose: () => { answer(false); openRequest = null; },
  });
  openRequest = { identity, close: () => dlg.close() };

  async function drawBody() {
    const hp = await connectHelper();
    if (hp) dlg.setError('');
    const st = myScreenSettings();
    const parts = [
      h('p', {}, `${name} vai poder usar o mouse e o teclado do seu computador, vendo a sua tela.`),
      h('ul', { class: 'rc-list' },
        h('li', {}, 'Seu mouse tem prioridade: se você mexer nele, os comandos da outra pessoa param na hora.'),
        h('li', {}, 'Para encerrar: ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Alt'), '+', h('kbd', {}, 'End'), ' ou o botão "Parar controle".'),
        h('li', {}, 'Só aceite de quem você confia.')),
    ];
    if (!hp) {
      parts.push(h('div', { class: 'rc-helper' },
        h('strong', {}, '⚠️ O Nexo Controle não está aberto neste PC.'),
        h('p', { class: 'small' }, 'O navegador sozinho não consegue mexer no mouse e no teclado. É preciso um programinha do Nexo (só para Windows):'),
        h('ol', { class: 'small' },
          h('li', {}, 'Baixe: ', h('button', { type: 'button', class: 'btn small', onclick: downloadHelper }, '⬇️ Baixar Nexo Controle')),
          h('li', {}, 'Clique com o botão direito no arquivo baixado → "Executar com o PowerShell".'),
          h('li', {}, 'Na primeira vez ele cria um atalho "Nexo Controle" na Área de Trabalho. Deixe a janela dele aberta.'),
          h('li', {}, 'Se o navegador perguntar sobre acessar "apps e serviços neste dispositivo", clique em Permitir.')),
        h('button', { type: 'button', class: 'btn small', onclick: drawBody }, '🔄 Já abri, verificar de novo')));
    } else if (hp.screens.length > 1) {
      // Vários monitores: qual está sendo compartilhado?
      const ratio = st && st.width && st.height ? st.width / st.height : null;
      const matches = hp.screens.map((s, i) => ({ ...s, i })).filter((s) => !ratio || Math.abs(s.w / s.h - ratio) < 0.03);
      const guess = (matches.find((s) => s.primary) || matches[0] || hp.screens.map((s, i) => ({ ...s, i }))[0]).i;
      chosenScreen = guess;
      parts.push(h('div', { class: 'field-label' }, 'Qual monitor você está compartilhando?'),
        h('div', { class: 'kind-options' }, hp.screens.map((s, i) => h('label', { class: 'kind-option' },
          h('input', { type: 'radio', name: 'rc-screen', checked: i === guess, onchange: () => { chosenScreen = i; } }),
          h('span', { class: 'kind-text' }, h('strong', {}, `Monitor ${i + 1}${s.primary ? ' (principal)' : ''}`), h('span', { class: 'muted small' }, `${s.w} × ${s.h}`))))));
    }
    if (st && st.displaySurface && st.displaySurface !== 'monitor') {
      parts.push(h('p', { class: 'form-error' }, 'Você está compartilhando uma janela ou aba. Para deixar controlar, pare e compartilhe a "Tela inteira".'));
    }
    body.replaceChildren(...parts);
  }
  body.append(h('p', { class: 'muted' }, 'Verificando…'));
  drawBody();
}

function startHosting(identity, name, screen) {
  hosting = { identity, name };
  helperSend({ t: 'grant', screen, name });
  send(TOPIC_CTL, { t: 'ctl-ans', ok: true }, identity);
  toast(`🖱️ ${name} está controlando o seu PC. Ctrl+Alt+End para retomar.`);
  ctx.onChange();
}

export function endHosting({ notify = true, fromHelper = false } = {}) {
  if (!hosting) return;
  const who = hosting;
  hosting = null;
  if (!fromHelper) helperSend({ t: 'revoke' });
  if (notify) send(TOPIC_CTL, { t: 'ctl-end' }, who.identity);
  ctx.onChange();
}

// ---------------------------------------------------------------- Quem assiste

export function requestControl(identity, name) {
  if (viewing) return;
  viewing = { identity, name, state: 'pending' };
  send(TOPIC_CTL, { t: 'ctl-req' }, identity);
  ctx.onChange();
  // Sem resposta em 60 s: desiste.
  setTimeout(() => {
    if (viewing && viewing.identity === identity && viewing.state === 'pending') {
      viewing = null;
      toast(`${name} não respondeu ao pedido de controle.`);
      ctx.onChange();
    }
  }, 60000);
}

export function stopViewing({ notify = true } = {}) {
  if (!viewing) return;
  const who = viewing;
  if (who.state === 'active') send(TOPIC_IN, { t: 'up' }, who.identity);
  viewing = null;
  if (notify) send(TOPIC_CTL, { t: 'ctl-end' }, who.identity);
  try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch { /* */ }
  ctx.onChange();
}

let hintTimer = null;
function hostMovedHint(name) {
  const el = document.querySelector('.tile.screen.controlling .rc-hint');
  if (!el) return;
  el.textContent = `✋ ${name} está mexendo no mouse`;
  el.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.hidden = true; }, 1500);
}

// Quem saiu da chamada / parou a tela.
export function onParticipantGone(identity) {
  if (viewing && viewing.identity === identity) { viewing = null; ctx.onChange(); }
  if (hosting && hosting.identity === identity) endHosting({ notify: false });
  if (openRequest && openRequest.identity === identity) openRequest.close();
}
export function onScreenStopped() {
  if (hosting) endHosting({ notify: true });
  if (openRequest) openRequest.close();
}
export function onRemoteScreenStopped(identity) {
  if (viewing && viewing.identity === identity) { viewing = null; toast('A transmissão acabou.'); ctx.onChange(); }
}
export function resetRemote() {
  if (hosting) endHosting({ notify: false });
  viewing = null;
  if (openRequest) openRequest.close();
}

// ---------------------------------------------------------------- Captura de mouse e teclado (quem assiste)

// Liga a captura num quadro de tela compartilhada. Chamada a cada desenho; só prepara uma vez.
export function attachControl(tile, video, identity) {
  if (tile._rc) { tile._rc.identity = identity; return; }
  const rc = { identity, pressed: new Set(), buttons: new Set(), lastMove: 0, pendingMove: null, wheelY: 0, wheelX: 0 };
  tile._rc = rc;
  const active = () => viewing && viewing.state === 'active' && viewing.identity === rc.identity;
  const sendIn = (msg, reliable = true) => send(TOPIC_IN, msg, rc.identity, reliable);

  // Posição dentro da imagem (descontando as faixas pretas do "contain").
  const point = (e) => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth; const vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale; const ht = vh * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - ht) / 2) / ht;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
  };
  const flushMove = () => {
    rc.raf = 0;
    if (rc.pendingMove) { sendIn({ t: 'm', ...rc.pendingMove }, false); rc.pendingMove = null; }
  };
  const BUTTON = { 0: 0, 2: 1, 1: 2, 3: 3, 4: 4 }; // navegador -> esquerdo, direito, meio, voltar, avançar

  video.addEventListener('pointermove', (e) => {
    if (!active()) return;
    const p = point(e);
    if (!p) return;
    rc.pendingMove = p;
    if (!rc.raf) rc.raf = requestAnimationFrame(flushMove);
  });
  video.addEventListener('pointerdown', (e) => {
    if (!active()) return;
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    tile.focus({ preventScroll: true });
    const b = BUTTON[e.button];
    if (b === undefined) return;
    try { video.setPointerCapture(e.pointerId); } catch { /* */ }
    sendIn({ t: 'm', ...p });
    sendIn({ t: 'b', b, d: true });
    rc.buttons.add(b);
  });
  const up = (e) => {
    const b = BUTTON[e.button];
    if (b === undefined || !rc.buttons.has(b)) return;
    rc.buttons.delete(b);
    if (active()) sendIn({ t: 'b', b, d: false });
  };
  video.addEventListener('pointerup', up);
  video.addEventListener('pointercancel', up);
  video.addEventListener('contextmenu', (e) => { if (active()) e.preventDefault(); });
  video.addEventListener('auxclick', (e) => { if (active()) e.preventDefault(); });
  video.addEventListener('wheel', (e) => {
    if (!active()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    // Windows: 120 = um "dente" da rodinha; para cima é positivo.
    rc.wheelY += -e.deltaY * k * 1.2;
    rc.wheelX += e.deltaX * k * 1.2;
    const dy = Math.trunc(rc.wheelY); const dx = Math.trunc(rc.wheelX);
    if (dy || dx) { rc.wheelY -= dy; rc.wheelX -= dx; sendIn({ t: 'w', dy, dx }); }
  }, { passive: false });
  video.addEventListener('dblclick', (e) => { if (active()) e.stopPropagation(); });

  tile.addEventListener('keydown', (e) => {
    if (!active()) return;
    if (!e.code || !KEY_RE.test(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    rc.pressed.add(e.code);
    sendIn({ t: 'k', c: e.code, d: true });
  }, true);
  tile.addEventListener('keyup', (e) => {
    if (!active() || !e.code) return;
    e.preventDefault();
    e.stopPropagation();
    if (rc.pressed.delete(e.code)) sendIn({ t: 'k', c: e.code, d: false });
  }, true);
  // Saiu da tela: solta tudo que estava apertado (senão uma tecla fica "presa").
  const releaseAll = () => {
    if (!rc.pressed.size && !rc.buttons.size) return;
    rc.pressed.clear();
    rc.buttons.clear();
    if (active()) sendIn({ t: 'up' });
  };
  tile.addEventListener('blur', releaseAll);
  window.addEventListener('blur', releaseAll);
  // Em tela cheia, segura também Esc, Alt+Tab etc. (o navegador mostra como sair).
  document.addEventListener('fullscreenchange', () => {
    try {
      if (document.fullscreenElement === tile && active() && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock();
    } catch { /* */ }
  });
}
