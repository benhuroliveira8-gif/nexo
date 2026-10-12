// Modo economia (deste aparelho): gasta menos internet e bateria.
// GIFs só carregam quando você toca, câmeras chegam em qualidade baixa, sua câmera envia em 360p
// e as imagens das prévias de link não carregam.
import { h, storage } from './util.js';

const KEY = 'nexo.economy';
const listeners = new Set();
export const onEconomyChange = (fn) => listeners.add(fn);

// Sem escolha salva: liga sozinho se o celular estiver em "economia de dados".
export function isEconomy() {
  const v = storage(KEY);
  if (v === '1') return true;
  if (v === '0') return false;
  return !!(navigator.connection && navigator.connection.saveData);
}

export function setEconomy(on) {
  storage(KEY, on ? '1' : '0');
  apply();
  listeners.forEach((fn) => { try { fn(on); } catch { /* */ } });
}

export function apply() {
  document.documentElement.classList.toggle('economy', isEconomy());
}

export function economySection(rerender) {
  const on = isEconomy();
  return h('label', { class: 'perm' },
    h('div', { class: 'perm-text' },
      h('strong', {}, '🔋 Modo economia (internet e bateria)'),
      h('span', { class: 'muted small' }, 'GIFs só carregam quando você toca, câmeras dos outros chegam em qualidade baixa, a sua câmera envia em 360p e as imagens das prévias de link não carregam. Bom no 4G.')),
    h('input', { type: 'checkbox', class: 'switch', checked: on, onchange: (e) => { setEconomy(e.target.checked); if (rerender) rerender(); } }));
}

apply();
