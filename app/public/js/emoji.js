// Seletor de emojis (lista própria, sem depender de nada externo).
import { h, openPopover, closePopover, storage } from './util.js';
import { customEmoji } from './markdown.js';

// Emojis personalizados disponíveis agora (o main.js informa): [{ id, name, animated, serverName }]
let customProvider = () => [];
export const setCustomEmojiProvider = (fn) => { customProvider = fn; };
export const emojiToken = (e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
const TOKEN = /^<(a?):([a-z0-9_]{2,32}):(\d{1,10})>$/;

// Mostra um emoji (normal ou personalizado) — usado nas reações e no seletor.
export function emojiNode(text, cls = 'cemoji') {
  const m = TOKEN.exec(text);
  return m ? customEmoji(m[2], m[3], cls) : text;
}

const CATEGORIES = [
  ['Carinhas', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖'],
  ['Gestos', '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🫡 🫶 👀 🧠'],
  ['Corações', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟'],
  ['Animais', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐴 🦄 🐝 🐛 🦋 🐌 🐢 🐍 🦖 🐙 🦈 🐬 🐳'],
  ['Comida', '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥑 🌽 🌶️ 🍞 🧀 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🌯 🍝 🍣 🍦 🍩 🍪 🎂 🍫 🍿 ☕ 🍺 🍻 🥂 🧃'],
  ['Atividades', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🎮 🕹️ 🎲 🧩 ♟️ 🎯 🎳 🏆 🥇 🎉 🎊 🎈 🎁 🎤 🎧 🎸 🎹 🥁 🎬 📷 🚀 ✈️ 🚗 🏍️ 🏠 🌍 🌈 ☀️ 🌙 ⚡ ❄️ ☔'],
  ['Objetos', '💻 🖥️ ⌨️ 🖱️ 📱 ☎️ 💡 🔦 📚 📝 ✏️ 📌 📎 🔒 🔑 🔨 🛠️ ⚙️ 🧪 💊 💰 💸 📈 📉 ⏰ ⌛ 📦 🗑️ ✅ ❌ ⚠️ ❓ ❗ 🆗 🆒 🆕 🔴 🟢 🔵 🇧🇷'],
].map(([name, list]) => [name, list.split(' ')]);

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

function recent() {
  try { return JSON.parse(storage('nexo.recentEmoji') || '[]').slice(0, 16); } catch { return []; }
}
function remember(emoji) {
  const list = [emoji, ...recent().filter((e) => e !== emoji)].slice(0, 16);
  storage('nexo.recentEmoji', JSON.stringify(list));
}

// Abre o seletor perto de "anchor"; chama onPick(emoji).
export function openEmojiPicker(anchor, onPick, { keepOpen = false } = {}) {
  const pick = (e) => {
    remember(e);
    if (!keepOpen) closePopover();
    onPick(e);
  };
  const sections = [];
  const custom = customProvider() || [];
  const customIds = new Set(custom.map(emojiToken));
  // "Recentes" pode ter emoji personalizado que não está mais disponível: tira.
  const rec = recent().filter((e) => !TOKEN.test(e) || customIds.has(e));
  if (rec.length) sections.push(['Recentes', rec]);
  // Personalizados, agrupados por servidor.
  const groups = new Map();
  custom.forEach((e) => {
    const g = e.serverName || 'Deste servidor';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(emojiToken(e));
  });
  groups.forEach((list, name) => sections.push([`⭐ ${name}`, list]));
  sections.push(...CATEGORIES);

  const titleOf = (e) => { const m = TOKEN.exec(e); return m ? `:${m[2]}:` : e; };
  const filter = h('input', { class: 'emoji-search', placeholder: 'Procurar emoji personalizado…', maxlength: '32' });
  const grid = h('div', { class: 'emoji-grid' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase().replace(/:/g, '');
    const shown = q ? [['Resultados', custom.filter((e) => e.name.includes(q)).map(emojiToken)]] : sections;
    grid.replaceChildren(...shown.flatMap(([name, list]) => [
      h('div', { class: 'emoji-cat' }, name),
      list.length ? h('div', { class: 'emoji-row' }, list.map((e) => h('button', { class: 'emoji-btn', type: 'button', title: titleOf(e), onclick: () => pick(e) }, emojiNode(e, 'cemoji picker')))) : h('p', { class: 'muted small' }, 'Nenhum emoji com esse nome.'),
    ]));
  };
  draw();
  filter.addEventListener('input', draw);
  openPopover(anchor, h('div', { class: 'emoji-picker' }, custom.length ? filter : null, grid), { align: 'end', className: 'popover-emoji' });
  if (custom.length && window.matchMedia('(min-width: 901px)').matches) setTimeout(() => filter.focus(), 0);
}
