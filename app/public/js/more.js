// Status com prazo, mensagens agendadas, lembretes, mensagens salvas,
// figurinhas e exportação de conversa.
import { h, api, toast, openDialog, openPopover, closePopover, openMenu, getToken, playPing } from './util.js';
import { openEmojiPicker } from './emoji.js';
import { state } from './state.js';

let hooks = {
  applyMe: () => {}, resultCard: null, openResult: () => {}, closeSearch: () => {},
  sendSticker: () => {}, rerenderMessages: () => {}, jumpTo: () => {},
};
export function initMore(h0) { hooks = { ...hooks, ...h0 }; }

// ---------------------------------------------------------------- Datas

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
export function whenLabel(date) {
  const d = new Date(date);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return `hoje às ${timeFmt.format(d)}`;
  if (same(d, tomorrow)) return `amanhã às ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)} às ${timeFmt.format(d)}`;
}
const at = (days, hour, minute = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d; };
const inMinutes = (m) => new Date(Date.now() + m * 60000);

// ---------------------------------------------------------------- 1. Status com emoji e prazo

const STATUS_PRESETS = [['🎮', 'Jogando'], ['📚', 'Estudando'], ['💼', 'Trabalhando'], ['🎧', 'Ouvindo música'], ['🍕', 'Comendo'], ['😴', 'Dormindo'], ['🚗', 'Na rua']];
const CLEAR_OPTIONS = [
  ['never', 'Não limpar'], ['30m', 'Daqui a 30 minutos'], ['1h', 'Daqui a 1 hora'], ['4h', 'Daqui a 4 horas'],
  ['today', 'Hoje (meia-noite)'], ['custom', 'Escolher o horário…'],
];
const EMOJI_START = /^(\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️|\p{Emoji_Modifier})*|\p{Regional_Indicator}{2})\s*/u;

export function openStatusDialog() {
  const cur = state.me.statusText || '';
  const m = EMOJI_START.exec(cur);
  let emoji = m ? m[1] : '💬';
  const emojiBtn = h('button', { type: 'button', class: 'btn status-emoji', title: 'Escolher emoji' }, emoji);
  const text = h('input', { maxlength: '70', placeholder: 'O que você está fazendo?', value: m ? cur.slice(m[0].length) : cur });
  emojiBtn.addEventListener('click', () => openEmojiPicker(emojiBtn, (picked) => {
    if (/^<a?:/.test(picked)) return toast('No status, use um emoji comum.');
    emoji = picked;
    emojiBtn.textContent = picked;
  }));
  const clear = h('select', {}, CLEAR_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
  const custom = h('input', { type: 'datetime-local', value: toLocalInput(at(0, 22)), hidden: true });
  clear.addEventListener('change', () => { custom.hidden = clear.value !== 'custom'; });
  if (state.me.statusExpiresAt) {
    clear.value = 'custom';
    custom.hidden = false;
    custom.value = toLocalInput(new Date(state.me.statusExpiresAt));
  }
  const presets = h('div', { class: 'status-presets' }, STATUS_PRESETS.map(([e, t]) => h('button', {
    type: 'button', class: 'chip', onclick: () => { emoji = e; emojiBtn.textContent = e; text.value = t; text.focus(); },
  }, `${e} ${t}`)));
  const save = async (clearAll) => {
    const t = clearAll ? '' : text.value.trim();
    const statusText = t ? `${emoji} ${t}` : '';
    let statusExpiresAt = null;
    if (t) {
      const v = clear.value;
      if (v === '30m') statusExpiresAt = inMinutes(30);
      else if (v === '1h') statusExpiresAt = inMinutes(60);
      else if (v === '4h') statusExpiresAt = inMinutes(240);
      else if (v === 'today') { statusExpiresAt = at(1, 0); }
      else if (v === 'custom') {
        statusExpiresAt = new Date(custom.value);
        if (Number.isNaN(statusExpiresAt.getTime())) throw new Error('Escolha o horário.');
      }
    }
    const { user } = await api('/me', { method: 'PATCH', body: { statusText, ...(statusExpiresAt ? { statusExpiresAt: statusExpiresAt.toISOString() } : {}) } });
    hooks.applyMe(user);
    toast(!t ? 'Status removido.' : statusExpiresAt ? `Status salvo. Some ${whenLabel(statusExpiresAt)}.` : 'Status salvo.');
  };
  openDialog({
    title: 'Status personalizado',
    body: h('div', { class: 'status-form' },
      h('div', { class: 'status-row' }, emojiBtn, text),
      presets,
      h('label', { class: 'field' }, h('span', {}, 'Limpar depois de'), clear),
      custom),
    actions: [
      cur ? { label: 'Tirar status', onClick: () => save(true) } : { label: 'Cancelar' },
      { label: 'Salvar', kind: 'primary', submit: true, onClick: () => save(false) },
    ],
  });
}

// ---------------------------------------------------------------- 2. Mensagem agendada

export function openScheduleDialog(channelId, initialText = '', onDone = () => {}) {
  const text = h('textarea', { rows: '4', maxlength: '4000', placeholder: 'Mensagem que vai ser enviada…' });
  text.value = initialText;
  const when = h('input', { type: 'datetime-local', value: toLocalInput(inMinutes(60)), min: toLocalInput(new Date()) });
  const quick = [['Em 1 hora', () => inMinutes(60)], ['Hoje 20h', () => at(0, 20)], ['Amanhã 9h', () => at(1, 9)], ['Amanhã 18h', () => at(1, 18)]];
  openDialog({
    title: '⏰ Agendar mensagem',
    body: h('div', { class: 'schedule-form' },
      text,
      h('label', { class: 'field' }, h('span', {}, 'Enviar em'), when),
      h('div', { class: 'status-presets' }, quick.filter(([, f]) => f().getTime() > Date.now() + 60000)
        .map(([l, f]) => h('button', { type: 'button', class: 'chip', onclick: () => { when.value = toLocalInput(f()); } }, l))),
      h('p', { class: 'muted small' }, 'O Nexo envia sozinho no horário, mesmo com você desconectado. Veja e cancele em 🔖 → Agendadas.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Agendar', kind: 'primary', submit: true,
        onClick: async () => {
          const d = new Date(when.value);
          if (Number.isNaN(d.getTime())) throw new Error('Escolha o horário.');
          await api(`/channels/${channelId}/scheduled`, { method: 'POST', body: { content: text.value, sendAt: d.toISOString() } });
          toast(`⏰ Mensagem agendada para ${whenLabel(d)}.`);
          onDone();
        },
      },
    ],
  });
  setTimeout(() => text.focus(), 0);
}

// ---------------------------------------------------------------- 3. Lembrete

export function openReminderMenu(anchor, message) {
  const create = async (date) => {
    try {
      await api(`/messages/${message.id}/reminders`, { method: 'POST', body: { remindAt: date.toISOString() } });
      toast(`⏰ Vou te lembrar ${whenLabel(date)}.`);
    } catch (err) { toast(err.message); }
  };
  const choices = [
    ['Em 20 minutos', () => inMinutes(20)], ['Em 1 hora', () => inMinutes(60)], ['Em 3 horas', () => inMinutes(180)],
    ['Hoje às 20h', () => at(0, 20)], ['Amanhã às 9h', () => at(1, 9)], ['Daqui a uma semana', () => at(7, 9)],
  ].filter(([, f]) => f().getTime() > Date.now() + 60000);
  openMenu(anchor, [
    ...choices.map(([label, f]) => ({ label: `⏰  ${label}`, onClick: () => create(f()) })),
    { label: '📅  Escolher data e hora…', onClick: () => {
      const input = h('input', { type: 'datetime-local', value: toLocalInput(at(1, 9)), min: toLocalInput(new Date()) });
      openDialog({
        title: 'Lembrar desta mensagem', body: input,
        actions: [{ label: 'Cancelar' }, { label: 'Criar lembrete', kind: 'primary', submit: true, onClick: () => create(new Date(input.value)) }],
      });
    } },
  ], { className: 'popover-menu' });
}

// ---------------------------------------------------------------- 5. Mensagens salvas

const saved = new Set();
export const isSaved = (id) => saved.has(String(id));
export async function loadSavedIds() {
  try { const { ids } = await api('/saved/ids'); saved.clear(); ids.forEach((id) => saved.add(id)); } catch { /* */ }
}
export async function toggleSaved(m) {
  const on = !saved.has(m.id);
  try {
    await api(`/messages/${m.id}/save`, { method: on ? 'PUT' : 'DELETE' });
    if (on) saved.add(m.id); else saved.delete(m.id);
    m._v = (m._v || 0) + 1;
    hooks.rerenderMessages();
    toast(on ? '🔖 Mensagem salva. Veja em 🔖 no topo.' : 'Tirada das salvas.');
    if (panel && panel.tab === 'saved') renderPanel();
  } catch (err) { toast(err.message); }
}

// ---------------------------------------------------------------- Painel 🔖 (salvas, lembretes, agendadas)

let panel = null; // { tab, data, loading }

export function openListsPanel(tab = 'saved') {
  hooks.closeSearch();
  panel = { tab, data: null, loading: true };
  load();
}
export function closeListsPanel() {
  if (!panel) return;
  panel = null;
  const el = document.getElementById('search-panel');
  el.hidden = true;
  el.replaceChildren();
  document.getElementById('app').classList.remove('searching');
}
export const listsPanelOpen = () => !!panel;

async function load() {
  if (!panel) return;
  const tab = panel.tab;
  panel.loading = true;
  renderPanel();
  try {
    const path = { saved: '/saved', reminders: '/reminders', scheduled: '/scheduled' }[tab];
    const data = await api(path);
    if (!panel || panel.tab !== tab) return;
    panel.data = data;
  } catch (err) { toast(err.message); }
  if (!panel) return;
  panel.loading = false;
  renderPanel();
}

const placeLabel = (c) => {
  if (!c) return null;
  if (c.kind === 'dm') return `💬 ${c.name}`;
  return `${c.kind === 'thread' ? '🧵' : '#'} ${c.name}${c.serverName ? ` · ${c.serverName}` : ''}`;
};

function renderPanel() {
  if (!panel) return;
  const el = document.getElementById('search-panel');
  el.hidden = false;
  document.getElementById('app').classList.add('searching');
  const tabs = [['saved', '🔖 Salvas'], ['reminders', '⏰ Lembretes'], ['scheduled', '🕒 Agendadas']];
  const list = h('div', { class: 'search-results' });
  const d = panel.data;
  if (panel.loading && !d) list.append(h('p', { class: 'muted search-tip' }, 'Carregando…'));
  else if (panel.tab === 'saved') {
    const items = (d && d.saved) || [];
    if (!items.length) list.append(h('p', { class: 'muted search-tip' }, 'Nada salvo ainda. Passe o mouse numa mensagem e clique em 🔖 para guardar aqui (só você vê).'));
    items.forEach((m) => list.append(card(m, placeLabel(m.channel), [
      h('button', { class: 'icon-btn small', title: 'Tirar das salvas', onclick: (e) => { e.stopPropagation(); toggleSaved(m); } }, '✕'),
    ])));
  } else if (panel.tab === 'reminders') {
    const items = (d && d.reminders) || [];
    if (!items.length) list.append(h('p', { class: 'muted search-tip' }, 'Nenhum lembrete. Numa mensagem, clique em ⏰ para o Nexo te avisar depois.'));
    items.forEach((r) => list.append(card(r.message, `⏰ ${whenLabel(r.remindAt)} · ${placeLabel(r.message.channel) || ''}`, [
      h('button', { class: 'icon-btn small', title: 'Cancelar lembrete', onclick: async (e) => { e.stopPropagation(); await api(`/reminders/${r.id}`, { method: 'DELETE' }).catch((err) => toast(err.message)); load(); } }, '✕'),
    ])));
  } else {
    const items = (d && d.scheduled) || [];
    if (!items.length) list.append(h('p', { class: 'muted search-tip' }, 'Nenhuma mensagem agendada. No ＋ da caixa de mensagem, escolha "Agendar mensagem".'));
    items.forEach((s) => list.append(h('div', { class: 'result' },
      h('div', { class: 'result-channel muted' }, `🕒 ${whenLabel(s.sendAt)} · ${placeLabel(s.channel) || ''}`),
      h('div', { class: 'result-row' },
        h('div', { class: 'result-body' }, h('div', { class: 'msg-text scheduled-text' }, s.content)),
        h('div', { class: 'result-actions' },
          h('button', { class: 'icon-btn small', title: 'Cancelar envio', onclick: async () => { await api(`/scheduled/${s.id}`, { method: 'DELETE' }).catch((err) => toast(err.message)); toast('Envio cancelado.'); load(); } }, '✕'))))));
  }
  el.replaceChildren(
    h('div', { class: 'search-head' },
      h('strong', {}, 'Só para você'),
      h('button', { class: 'icon-btn small', title: 'Fechar', onclick: closeListsPanel }, '✕')),
    h('div', { class: 'lists-tabs' }, tabs.map(([k, l]) => h('button', {
      class: `lists-tab${panel.tab === k ? ' active' : ''}`, onclick: () => { panel.tab = k; panel.data = null; load(); },
    }, l))),
    list,
  );
}

function card(m, label, actions) {
  const c = hooks.resultCard(m, { channelLabel: label, actions });
  c.classList.add('clickable');
  c.title = 'Ir para a mensagem';
  c.addEventListener('click', (e) => { if (!e.target.closest('a, .mention, button')) hooks.openResult(m); });
  return c;
}

// ---------------------------------------------------------------- 4. Figurinhas

export function buildSticker(st, { onLoad } = {}) {
  const img = h('img', { class: 'sticker-img', src: st.url || `/sticker/${st.id}`, alt: st.name, title: st.name, loading: 'lazy', draggable: 'false' });
  if (onLoad) img.addEventListener('load', onLoad);
  img.addEventListener('error', () => img.replaceWith(h('div', { class: 'sticker-gone muted small' }, `🏷️ ${st.name} (figurinha apagada)`)));
  return h('div', { class: 'sticker-msg' }, img);
}

let myStickers = null;
async function stickerList() {
  if (state.view !== 'home' && state.detail) return (state.detail.stickers || []).map((s) => ({ ...s, serverName: state.detail.server.name }));
  if (!myStickers || Date.now() - myStickers.at > 60000) {
    const { stickers } = await api('/stickers');
    myStickers = { at: Date.now(), list: stickers };
  }
  return myStickers.list;
}

export async function openStickerPicker(anchor) {
  const box = h('div', { class: 'sticker-picker' }, h('p', { class: 'muted small' }, 'Carregando…'));
  openPopover(anchor, box, { align: 'end', className: 'popover-sticker' });
  let list = [];
  try { list = await stickerList(); } catch (err) { box.replaceChildren(h('p', { class: 'muted small' }, err.message)); return; }
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty-state small' }, h('div', { class: 'empty-art' }, '🏷️'),
      h('p', { class: 'muted small' }, state.view === 'home'
        ? 'Nenhuma figurinha nos seus servidores ainda.'
        : 'Este servidor ainda não tem figurinhas. Quem gerencia emojis pode enviar em Configurações do servidor → Figurinhas.')));
    return;
  }
  const groups = new Map();
  list.forEach((s) => { const g = s.serverName || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
  box.replaceChildren(...[...groups].flatMap(([name, items]) => [
    groups.size > 1 ? h('div', { class: 'emoji-cat' }, name) : null,
    h('div', { class: 'sticker-grid' }, items.map((s) => h('button', {
      type: 'button', class: 'sticker-btn', title: s.name,
      onclick: () => { closePopover(); hooks.sendSticker(s); },
    }, h('img', { src: s.url, alt: s.name, loading: 'lazy', draggable: 'false' })))),
  ]).filter(Boolean));
}

// ---------------------------------------------------------------- 12. Exportar conversa

export function exportDialog(channelId, label) {
  let format = 'html';
  const opt = (v, title, desc) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'exp-format', checked: v === format, onchange: () => { format = v; } }),
    h('span', { class: 'kind-text' }, h('strong', {}, title), h('span', { class: 'muted small' }, desc)));
  openDialog({
    title: `📥 Exportar ${label}`,
    body: h('div', { class: 'kind-options' },
      opt('html', 'Página (HTML)', 'Abre no navegador, fácil de ler e imprimir.'),
      opt('txt', 'Texto (TXT)', 'Simples, abre em qualquer lugar.'),
      opt('json', 'Dados (JSON)', 'Para programas e backups.'),
      h('p', { class: 'muted small' }, 'Leva as últimas 20.000 mensagens. Anexos vão como links.')),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Baixar', kind: 'primary', submit: true,
        onClick: async () => {
          const tz = new Date().getTimezoneOffset();
          const res = await fetch(`/api/channels/${channelId}/export?format=${format}&tz=${tz}&base=${encodeURIComponent(location.origin)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
          if (!res.ok) { let msg = 'Não foi possível exportar.'; try { msg = (await res.json()).error || msg; } catch { /* */ } throw new Error(msg); }
          const blob = await res.blob();
          const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || `nexo.${format}`;
          const a = h('a', { href: URL.createObjectURL(blob), download: name });
          document.body.append(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          toast('📥 Conversa exportada.');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Avisos em tempo real

export function wireMoreSocket(socket) {
  socket.on('me:updated', ({ user }) => hooks.applyMe(user));
  socket.on('reminder', (r) => {
    if (state.soundOn) playPing();
    reminderToast(r);
  });
  socket.on('scheduled:sent', () => {
    toast('🕒 Sua mensagem agendada foi enviada.');
    if (panel && panel.tab === 'scheduled') load();
  });
  socket.on('scheduled:failed', ({ error }) => toast(`🕒 Não deu para enviar a mensagem agendada: ${error}`));
}

// Aviso de lembrete com botão para ir até a mensagem (fica até fechar).
function reminderToast(r) {
  const box = document.getElementById('reminder-toasts') || (() => { const el = h('div', { id: 'reminder-toasts', class: 'reminder-toasts' }); document.body.append(el); return el; })();
  const el = h('div', { class: 'reminder-toast', role: 'alert' },
    h('span', { class: 'rt-text' }, r.text),
    h('div', { class: 'rt-actions' },
      h('button', { class: 'btn small primary', onclick: () => { el.remove(); hooks.jumpTo(r); } }, 'Ver mensagem'),
      h('button', { class: 'icon-btn small', title: 'Fechar', onclick: () => el.remove() }, '✕')));
  box.append(el);
}

// A busca usa o mesmo painel: quando ela abre, este painel "some" sem mexer na tela.
export function forgetListsPanel() { panel = null; }
