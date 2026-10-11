// Tema (escuro/claro/automático) e cor de destaque. Fica salvo só neste aparelho.
import { storage } from './util.js';

export const ACCENTS = [
  ['#ff7a45', 'Laranja (padrão)'], ['#f5c542', 'Amarelo'], ['#3ecf8e', 'Verde'], ['#2ec4b6', 'Turquesa'],
  ['#4d9fff', 'Azul'], ['#7c6cff', 'Roxo'], ['#c86bfa', 'Lilás'], ['#ff5c8a', 'Rosa'], ['#ff5c6c', 'Vermelho'],
];
const DEFAULT_ACCENT = '#ff7a45';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const getTheme = () => storage('nexo.theme') || 'dark';
export const getAccent = () => (/^#[0-9a-f]{6}$/i.test(storage('nexo.accent') || '') ? storage('nexo.accent') : DEFAULT_ACCENT);

const systemDark = () => !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
export const effectiveTheme = () => {
  const t = getTheme();
  return t === 'system' ? (systemDark() ? 'dark' : 'light') : t;
};

const themeListeners = new Set();
export const onThemeChange = (fn) => themeListeners.add(fn);

export function applyTheme() {
  const root = document.documentElement;
  const theme = effectiveTheme();
  root.dataset.theme = theme;
  const accent = getAccent();
  const rgb = hexToRgb(accent);
  const light = theme === 'light';
  // No tema claro a cor de destaque fica um pouco mais escura (para dar contraste no texto).
  const main = light && luminance(rgb) > 0.45 ? mix(rgb, [0, 0, 0], 0.25) : rgb;
  root.style.setProperty('--accent', toHex(main));
  root.style.setProperty('--accent-2', toHex(mix(main, light ? [0, 0, 0] : [255, 255, 255], 0.18)));
  root.style.setProperty('--accent-soft', `rgba(${main.join(', ')}, ${light ? 0.14 : 0.12})`);
  root.style.setProperty('--accent-line', `rgba(${main.join(', ')}, .5)`);
  root.style.setProperty('--accent-ink', luminance(main) > 0.35 ? '#1a0d06' : '#ffffff');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#f2f3f5' : '#0f1115');
  themeListeners.forEach((fn) => { try { fn(theme); } catch { /* ignora */ } });
}

export function setTheme(value) {
  storage('nexo.theme', value === 'dark' ? null : value);
  applyTheme();
}

export function setAccent(value) {
  storage('nexo.accent', value && value.toLowerCase() !== DEFAULT_ACCENT ? value : null);
  applyTheme();
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') applyTheme(); });
}
applyTheme();
