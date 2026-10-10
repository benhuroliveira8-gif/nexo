// Seletor de emojis (lista própria, sem depender de nada externo).
import { h, openPopover, closePopover, storage } from './util.js';

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
  const rec = recent();
  if (rec.length) sections.push(['Recentes', rec]);
  sections.push(...CATEGORIES);

  const grid = h('div', { class: 'emoji-grid' },
    sections.map(([name, list]) => [
      h('div', { class: 'emoji-cat' }, name),
      h('div', { class: 'emoji-row' }, list.map((e) => h('button', { class: 'emoji-btn', type: 'button', title: e, onclick: () => pick(e) }, e))),
    ]));
  openPopover(anchor, h('div', { class: 'emoji-picker' }, grid), { align: 'end', className: 'popover-emoji' });
}
