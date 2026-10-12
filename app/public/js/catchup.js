// "Resumo do que você perdeu": ao abrir um canal com muitas mensagens novas, mostra
// quantas são, desde quando, quem mais falou, menções a você e as mais reagidas.
import { $, h, api } from './util.js';

let current = null; // { channelId, data }

const when = (d) => {
  const date = new Date(d);
  const now = new Date();
  const hm = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(now.toDateString()) - new Date(date.toDateString())) / 86400000);
  if (days === 0) return `hoje às ${hm}`;
  if (days === 1) return `ontem às ${hm}`;
  if (days < 7) return `${date.toLocaleDateString('pt-BR', { weekday: 'long' })} às ${hm}`;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
};

// Chamado ao abrir um canal com algo não lido (antes de marcar como lido).
export async function loadCatchup(channelId) {
  current = null;
  draw();
  let data;
  try { data = await api(`/channels/${channelId}/catchup`); } catch { return; }
  if (!data || data.count < data.min) return;
  current = { channelId, data };
}

export function hideCatchup() { current = null; draw(); }

// opts: { channelId, label, jump(messageId) }
export function renderCatchup(opts) {
  draw(opts);
}

function draw(opts) {
  const el = $('#catchup');
  if (!el) return;
  if (!current || !opts || opts.channelId !== current.channelId) { el.hidden = true; el.replaceChildren(); return; }
  const d = current.data;
  const item = (m, icon) => h('button', { class: 'cu-item', onclick: () => opts.jump(m.id) },
    h('span', { class: 'cu-icon' }, icon),
    h('strong', {}, m.author.displayName), h('span', { class: 'truncate' }, m.preview || '…'),
    m.reactions ? h('span', { class: 'muted small' }, `${m.reactions} reações`) : null);
  el.replaceChildren(h('div', { class: 'catchup' },
    h('div', { class: 'cu-head' },
      h('span', { class: 'cu-title' }, `📬 ${d.count >= 1000 ? 'Mais de 1000' : d.count} mensagens novas em ${opts.label} desde ${when(d.since)}`),
      h('button', { class: 'icon-btn small', title: 'Dispensar', onclick: hideCatchup }, '✕')),
    d.authors && d.authors.length ? h('div', { class: 'muted small cu-authors' },
      'Quem mais falou: ', d.authors.map((a) => `${a.displayName} (${a.count})`).join(', ')) : null,
    d.mentions && d.mentions.length ? h('div', { class: 'cu-group' }, h('div', { class: 'cu-label' }, 'Falaram com você'), d.mentions.map((m) => item(m, '🔔'))) : null,
    d.top && d.top.length ? h('div', { class: 'cu-group' }, h('div', { class: 'cu-label' }, 'Mais reagidas'), d.top.map((m) => item(m, '🔥'))) : null,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small primary', onclick: () => { opts.jump(d.firstUnreadId); hideCatchup(); } }, '⬆️ Ler desde a primeira nova'),
      h('button', { class: 'btn small', onclick: hideCatchup }, 'Ok, entendi'))));
  el.hidden = false;
}
