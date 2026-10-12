// Ausente automático: depois de X minutos sem mexer no Nexo (mouse, teclado, toque),
// você aparece como 🌙 Ausente para os outros. Mexeu, volta sozinho.
import { h, storage } from './util.js';

const KEY = 'nexo.autoAway'; // minutos ("0" = nunca)
let last = Date.now();
let idle = false;
let hooks = { getSocket: () => null, isBusy: () => false, onChange: () => {} };

export const autoAwayMinutes = () => {
  const v = storage(KEY);
  const n = v === null ? 10 : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 10;
};
export const isAutoIdle = () => idle;

function set(on) {
  if (idle === on) return;
  idle = on;
  const s = hooks.getSocket();
  if (s) s.emit('client:idle', on);
  hooks.onChange(on);
}

function activity() {
  last = Date.now();
  if (idle) set(false);
}

function check() {
  const min = autoAwayMinutes();
  if (!min || hooks.isBusy()) { if (idle) set(false); return; }
  if (!idle && Date.now() - last > min * 60000) set(true);
}

export function initIdle(h2) {
  hooks = { ...hooks, ...h2 };
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'].forEach((ev) => window.addEventListener(ev, activity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') activity(); });
  setInterval(check, 15000);
}

// Conectou de novo (ex.: depois de uma atualização): avisa como está agora.
export function resendIdle() {
  const s = hooks.getSocket();
  if (s && idle) s.emit('client:idle', true);
}

// Para testes e para o botão "voltar": força o estado.
export function forceCheck() { check(); }

export function autoAwaySection(rerender) {
  const cur = autoAwayMinutes();
  const sel = h('select', { class: 'select' },
    [[5, '5 minutos'], [10, '10 minutos'], [15, '15 minutos'], [30, '30 minutos'], [60, '1 hora'], [0, 'Nunca']]
      .map(([v, l]) => h('option', { value: String(v), selected: v === cur }, l)));
  sel.addEventListener('change', () => { storage(KEY, sel.value); if (rerender) rerender(); });
  return h('label', { class: 'perm' },
    h('div', { class: 'perm-text' }, h('strong', {}, '🌙 Ficar Ausente sozinho'),
      h('span', { class: 'muted small' }, 'Depois de um tempo sem mexer no Nexo (mouse, teclado ou toque), os outros veem você como Ausente. Mexeu, volta sozinho. Durante uma chamada isso não acontece.')),
    sel);
}
