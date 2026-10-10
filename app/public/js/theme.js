// Aparência: tema (escuro, claro ou automático) e cor de destaque.
// Fica salvo neste navegador. O index.html aplica antes de desenhar a tela (sem "piscar").
import { storage } from './util.js';

export const ACCENTS = [
  ['#ff7a45', 'Laranja (padrão)'], ['#f5c542', 'Amarelo'], ['#3ecf8e', 'Verde'], ['#2ec4b6', 'Turquesa'],
  ['#4d9fff', 'Azul'], ['#7c6cff', 'Roxo'], ['#c86bfa', 'Lilás'], ['#ff5c8a', 'Rosa'],
];

const media = window.matchMedia('(prefers-color-scheme: light)');

export const themeSetting = () => storage('nexo.theme') || 'dark';
export const accentSetting = () => storage('nexo.accent') || ACCENTS[0][0];

// Texto escuro em cor clara e texto branco em cor escura.
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#1a0d06' : '#ffffff';
}

export function applyTheme() {
  const pref = themeSetting();
  const theme = pref === 'auto' ? (media.matches ? 'light' : 'dark') : pref;
  const root = document.documentElement;
  root.dataset.theme = theme;
  const accent = accentSetting();
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', inkFor(accent));
  }
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = theme === 'light' ? '#f2f3f5' : '#161920';
}

export function setTheme(value) { storage('nexo.theme', value); applyTheme(); }
export function setAccent(value) { storage('nexo.accent', value); applyTheme(); }

media.addEventListener('change', () => { if (themeSetting() === 'auto') applyTheme(); });
