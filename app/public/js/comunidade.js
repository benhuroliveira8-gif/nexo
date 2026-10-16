// Primeiros passos (regras + interesses), mensagens que somem, pastas de servidores,
// denúncias de mensagens e a cor de cada servidor.
import { h, api, toast, openDialog, openMenu, avatar, fullTime, storage, ask } from './util.js';
import { state, P, can, isOwner, myTop } from './state.js';
import { serverIcon, refreshSettings } from './settings.js';
import { setServerAccent } from './theme.js';
import { renderMarkdown } from './markdown.js';

let hooks = {
  refreshDetail: () => {}, renderRail: () => {}, renderSidebar: () => {}, selectServer: () => {},
  jumpTo: () => {}, renderComposer: () => {},
};
export function initComunidade(h0) { hooks = { ...hooks, ...h0 }; }

const rulesText = (text) => h('div', { class: 'ob-rules' }, renderMarkdown(text, { users: [], meId: state.me ? state.me.id : 0 }));

// ================================================================ Cor do servidor

export const THEME_COLORS = [
  ['#ff7a45', 'Laranja'], ['#f5c542', 'Amarelo'], ['#3ecf8e', 'Verde'], ['#2ec4b6', 'Turquesa'], ['#4d9fff', 'Azul'],
  ['#7c6cff', 'Roxo'], ['#c86bfa', 'Lilás'], ['#ff5c8a', 'Rosa'], ['#ff5c6c', 'Vermelho'],
];

// Chamado sempre que muda o servidor aberto (ou a cor dele).
export function applyServerTheme() {
  setServerAccent(state.view !== 'home' && state.detail ? state.detail.server.themeColor : null);
}

export function serverThemeBlock() {
  const d = state.detail;
  const manage = can(P.MANAGE_SERVER);
  const current = d.server.themeColor || null;
  const save = async (color) => {
    try {
      await api(`/servers/${d.server.id}`, { method: 'PATCH', body: { themeColor: color } });
      d.server.themeColor = color;
      applyServerTheme();
      refreshSettings();
      toast(color ? 'Cor do servidor salva!' : 'O servidor voltou a usar a cor de cada pessoa.');
    } catch (err) { toast(err.message); }
  };
  return h('div', { class: 'settings-block server-theme' },
    h('h3', {}, '🎨 Cor do servidor'),
    h('p', { class: 'muted small' }, 'Quem entra no servidor vê os botões, links e destaques nesta cor. Sem cor: cada pessoa vê a cor que escolheu.'),
    h('div', { class: 'swatches' },
      h('button', {
        class: `swatch none${!current ? ' active' : ''}`, title: 'Sem cor (cada um usa a sua)', disabled: !manage,
        onclick: () => save(null),
      }, '∅'),
      THEME_COLORS.map(([c, label]) => h('button', {
        class: `swatch${current === c ? ' active' : ''}`, style: `background:${c}`, title: label, disabled: !manage,
        dataset: { color: c },
        onclick: () => save(c),
      })),
      manage ? h('input', {
        type: 'color', class: 'swatch-custom', title: 'Escolher outra cor', value: current || '#ff7a45',
        onchange: (e) => save(e.target.value),
      }) : null));
}

// ================================================================ Primeiros passos

let obOpenFor = null;

// Depois de abrir um servidor: se a pessoa ainda não aceitou as regras, mostra a tela.
export function maybeOnboarding() {
  const d = state.detail;
  if (!d || !d.me.onboardingPending || !d.onboarding) return;
  if (obOpenFor === d.server.id) return;
  openOnboarding();
}

export const onboardingBlocked = () => !!(state.view !== 'home' && state.detail && state.detail.me.onboardingPending && state.detail.onboarding);

export async function openOnboarding({ review = false, preview = null } = {}) {
  const d = state.detail;
  if (!preview && (!d || !d.onboarding)) return toast('Este servidor não tem regras nem interesses configurados.');
  const serverId = d.server.id;
  const ob = preview || d.onboarding;
  const chosen = new Set();
  if (review && !preview) {
    try {
      const { myRoleIds } = await api(`/servers/${serverId}/onboarding`);
      ob.interests.forEach((x) => { if (x.roleId && myRoleIds.includes(x.roleId)) chosen.add(x.id); });
    } catch { /* abre sem marcar */ }
  }
  if (!preview) obOpenFor = serverId;
  const chips = h('div', { class: 'ob-interests' });
  const drawChips = () => chips.replaceChildren(...ob.interests.map((x) => h('button', {
    type: 'button',
    class: `ob-chip${chosen.has(x.id) ? ' on' : ''}`,
    'aria-pressed': chosen.has(x.id) ? 'true' : 'false',
    dataset: { id: x.id },
    onclick: () => { if (chosen.has(x.id)) chosen.delete(x.id); else chosen.add(x.id); drawChips(); },
  }, x.emoji ? h('span', { class: 'ob-emoji' }, x.emoji) : null, x.label, chosen.has(x.id) ? ' ✓' : '')));
  drawChips();
  const accepted = !d.me.onboardingPending && !preview;
  const body = h('div', { class: 'onboarding' },
    h('div', { class: 'ob-head' }, serverIcon(d.server, 'lg'),
      h('div', {}, h('h2', {}, `Boas-vindas a ${d.server.name}!`),
        h('p', { class: 'muted' }, accepted ? 'Reveja as regras e mude seus interesses quando quiser.' : 'Antes de conversar, leia as regras do servidor.'))),
    ob.rules ? h('section', {}, h('h3', {}, '📜 Regras'), rulesText(ob.rules)) : null,
    ob.interests.length ? h('section', {}, h('h3', {}, '✨ Do que você gosta?'),
      h('p', { class: 'muted small' }, 'Escolha quantos quiser. Cada interesse libera os canais e cargos certos para você.'), chips) : null);
  openDialog({
    title: '',
    body,
    wide: true,
    onClose: () => { if (!preview) obOpenFor = null; },
    actions: preview ? [{ label: 'Fechar a prévia', kind: 'primary' }] : [
      { label: accepted ? 'Fechar' : 'Agora não' },
      {
        label: accepted ? 'Salvar interesses' : (ob.rules ? '✅ Li e aceito' : 'Continuar'), kind: 'primary', submit: true,
        onClick: async () => {
          await api(`/servers/${serverId}/onboarding/accept`, { method: 'POST', body: { interestIds: [...chosen] } });
          if (state.detail && state.detail.server.id === serverId) state.detail.me.onboardingPending = false;
          toast(accepted ? 'Interesses salvos!' : 'Tudo pronto! Pode conversar à vontade. 🎉');
          hooks.renderComposer();
          hooks.refreshDetail();
        },
      },
    ],
  });
}

// Aba "Primeiros passos" nas configurações do servidor.
export function renderOnboardingSettings(rerender) {
  const d = state.detail;
  const saved = d.onboardingDraft || null;
  const page = h('div', { class: 'settings-page' }, h('h2', {}, 'Primeiros passos'), h('p', { class: 'muted' }, 'Carregando…'));
  const draw = (ob) => {
    const enabled = h('input', { type: 'checkbox', class: 'switch', id: 'ob-enabled', checked: !!ob.enabled });
    const rules = h('textarea', { rows: '7', maxlength: '3000', id: 'ob-rules', placeholder: '1. Respeite todo mundo.\n2. Nada de spam ou propaganda.\n3. Conteúdo adulto não é permitido.' });
    rules.value = ob.rules || '';
    const assignable = d.roles.filter((r) => !r.isDefault && (isOwner() || r.position < myTop())).sort((a, b) => b.position - a.position);
    const list = ob.interests.map((x) => ({ ...x }));
    const rows = h('div', { class: 'ob-edit-list' });
    const drawRows = () => rows.replaceChildren(...list.map((x, i) => h('div', { class: 'ob-edit-row' },
      h('input', { class: 'ob-e-emoji', maxlength: '8', placeholder: '🎮', value: x.emoji || '', oninput: (e) => { x.emoji = e.target.value; } }),
      h('input', { class: 'ob-e-label', maxlength: '40', placeholder: 'Ex.: Jogo X', value: x.label || '', oninput: (e) => { x.label = e.target.value; } }),
      h('select', { class: 'ob-e-role', onchange: (e) => { x.roleId = e.target.value ? Number(e.target.value) : null; } },
        h('option', { value: '' }, 'Sem cargo'),
        assignable.map((r) => h('option', { value: String(r.id), selected: x.roleId === r.id }, `Dá o cargo: ${r.name}`))),
      h('button', { class: 'icon-btn small', title: 'Tirar', onclick: () => { list.splice(i, 1); drawRows(); } }, '✕'))),
    ...(list.length < 20 ? [h('button', { class: 'btn small', id: 'ob-add', onclick: () => { list.push({ emoji: '', label: '', roleId: null }); drawRows(); } }, '➕ Adicionar interesse')] : []));
    drawRows();
    page.replaceChildren(
      h('h2', {}, 'Primeiros passos'),
      h('p', { class: 'muted' }, 'Quem entra no servidor vê uma tela de boas-vindas com as regras, clica em "Li e aceito" e escolhe os interesses, que já dão os cargos certos. Até aceitar, a pessoa só lê.'),
      h('div', { class: 'settings-block' },
        h('label', { class: 'switch-row' }, h('span', { class: 'kind-text' }, h('strong', {}, 'Mostrar a tela de boas-vindas para quem entrar'),
          h('span', { class: 'muted small' }, 'Quem já está no servidor não precisa aceitar de novo.')), enabled)),
      h('div', { class: 'settings-block' },
        h('h3', {}, '📜 Regras'),
        h('label', { class: 'field' }, h('span', { class: 'muted small' }, 'Aceita **negrito**, listas e links.'), rules)),
      h('div', { class: 'settings-block' },
        h('h3', {}, '✨ Interesses'),
        h('p', { class: 'muted small' }, 'Ex.: 🎮 Jogo X → cargo "Jogadores"; 📚 Estudos → cargo "Estudos". Só aparecem cargos abaixo do seu.'),
        rows),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => openOnboarding({ preview: { enabled: true, rules: rules.value, interests: list.filter((x) => (x.label || '').trim()).map((x, i) => ({ ...x, id: x.id || `p${i}` })) } }) }, '👀 Ver como fica'),
        h('button', {
          class: 'btn primary', id: 'ob-save',
          onclick: async (e) => {
            const btn = e.currentTarget;
        btn.disabled = true;
            try {
              const res = await api(`/servers/${d.server.id}/onboarding`, { method: 'PUT', body: { enabled: enabled.checked, rules: rules.value, interests: list.filter((x) => (x.label || '').trim()) } });
              d.onboardingDraft = res.onboarding;
              toast('Primeiros passos salvos!');
              rerender();
            } catch (err) { toast(err.message); } finally { btn.disabled = false; }
          },
        }, 'Salvar')));
  };
  if (saved) draw(saved);
  else {
    api(`/servers/${d.server.id}/onboarding`).then(({ onboarding }) => { d.onboardingDraft = onboarding; draw(onboarding); }).catch((err) => toast(err.message));
  }
  return page;
}

// ================================================================ Mensagens que somem

const DISAPPEAR_LABEL = { 0: 'Desligado', 86400: '24 horas', 604800: '7 dias' };

export function disappearMenu(anchor, dm) {
  const on = dm.disappearingSeconds || 0;
  const set = async (seconds) => {
    try {
      await api(`/dms/${dm.channelId}/disappearing`, { method: 'PUT', body: { seconds } });
      dm.disappearingSeconds = seconds;
      toast(seconds ? `⏳ As novas mensagens somem ${DISAPPEAR_LABEL[seconds]} depois de enviadas.` : 'Mensagens temporárias desligadas.');
    } catch (err) { toast(err.message); }
  };
  openMenu(anchor, [
    { label: `${on === 0 ? '● ' : ''}Desligado (ficam para sempre)`, onClick: () => set(0) },
    { label: `${on === 86400 ? '● ' : ''}⏳ Somem depois de 24 horas`, onClick: () => set(86400) },
    { label: `${on === 604800 ? '● ' : ''}⏳ Somem depois de 7 dias`, onClick: () => set(604800) },
  ], { align: 'end', className: 'popover-menu' });
}

// Aparece no cabeçalho só quando está ligado (para mudar: o mesmo botão ou o menu ⋯).
export function disappearButton(dm) {
  const on = dm.disappearingSeconds || 0;
  if (!on) return null;
  return h('button', {
    class: 'icon-btn disappear-btn on', id: 'btn-disappear',
    title: `Mensagens temporárias: somem depois de ${DISAPPEAR_LABEL[on]}`,
    onclick: (e) => disappearMenu(e.currentTarget, dm),
  }, '⏳', h('span', { class: 'disappear-label' }, on === 86400 ? '24h' : '7d'));
}

function leftLabel(ms) {
  if (ms <= 0) return 'sumindo…';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} dias`;
}

export function expiresMark(m) {
  if (!m.expiresAt) return null;
  const at = new Date(m.expiresAt);
  return h('span', { class: 'expires-mark', title: `Some sozinha em ${fullTime(at)}` }, `⏳ ${leftLabel(at - Date.now())}`);
}

// ================================================================ Pastas de servidores

let folders = [];
const expanded = new Set(JSON.parse(storage('nexo.folderOpen') || '[]'));
const saveExpanded = () => storage('nexo.folderOpen', JSON.stringify([...expanded]));

export async function loadFolders() {
  try { ({ folders } = await api('/me/server-folders')); } catch { folders = []; }
  hooks.renderRail();
}
export function setFolders(list) { folders = Array.isArray(list) ? list : []; hooks.renderRail(); }
export const serverFolders = () => folders;

async function saveFolders(next) {
  const before = folders;
  folders = next.filter((f) => f.serverIds.length);
  hooks.renderRail();
  try { ({ folders } = await api('/me/server-folders', { method: 'PUT', body: { folders } })); hooks.renderRail(); } catch (err) { folders = before; hooks.renderRail(); toast(err.message); }
}

const FOLDER_COLORS = ['#4d9fff', '#3ecf8e', '#f5c542', '#ff7a45', '#ff5c8a', '#c86bfa', '#a7adbb'];
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const without = (list, serverId) => list.map((f) => ({ ...f, serverIds: f.serverIds.filter((id) => id !== serverId) }));

function newFolderDialog(serverId) {
  ask({
    title: 'Nova pasta',
    text: 'Junte servidores parecidos (ex.: "Jogos", "Faculdade") para a barra ficar arrumada.',
    placeholder: 'Nome da pasta',
    maxLength: 32,
    okLabel: 'Criar pasta',
    onSubmit: async (name) => {
      const f = { id: newId(), name: name || 'Pasta', color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length], serverIds: [serverId] };
      expanded.add(f.id); saveExpanded();
      await saveFolders([...without(folders, serverId), f]);
    },
  });
}

function serverMenu(anchor, s) {
  const inFolder = folders.find((f) => f.serverIds.includes(s.id));
  openMenu(anchor, [
    { label: '🛎️  Notificações…', onClick: () => import('./avisos.js').then(({ notifyDialog }) => notifyDialog({ serverId: s.id, title: `🛎️ Notificações de ${s.name}` })) },
    { separator: true },
    ...folders.filter((f) => f !== inFolder).map((f) => ({
      label: `📁  Mover para "${f.name}"`,
      onClick: () => saveFolders(without(folders, s.id).map((x) => (x.id === f.id ? { ...x, serverIds: [...x.serverIds, s.id] } : x))),
    })),
    { label: '➕  Nova pasta com este servidor', onClick: () => newFolderDialog(s.id) },
    { label: '↩️  Tirar da pasta', hidden: !inFolder, onClick: () => saveFolders(without(folders, s.id)) },
  ], { className: 'popover-menu' });
}

function folderMenu(anchor, f) {
  openMenu(anchor, [
    { label: '✏️  Renomear pasta', onClick: () => ask({
      title: 'Renomear pasta', placeholder: 'Nome da pasta', value: f.name, maxLength: 32, okLabel: 'Salvar',
      onSubmit: (name) => saveFolders(folders.map((x) => (x.id === f.id ? { ...x, name: name || 'Pasta' } : x))),
    }) },
    ...FOLDER_COLORS.map((c) => ({
      label: `${f.color === c ? '●' : '○'}  Cor: ${COLOR_NAMES[c]}`,
      onClick: () => saveFolders(folders.map((x) => (x.id === f.id ? { ...x, color: c } : x))),
    })),
    { separator: true },
    { label: '🗂️  Desfazer pasta (os servidores ficam soltos)', danger: true, onClick: () => saveFolders(folders.filter((x) => x.id !== f.id)) },
  ], { className: 'popover-menu' });
}
const COLOR_NAMES = { '#4d9fff': 'azul', '#3ecf8e': 'verde', '#f5c542': 'amarelo', '#ff7a45': 'laranja', '#ff5c8a': 'rosa', '#c86bfa': 'lilás', '#a7adbb': 'cinza' };

// Toque longo (celular) ou botão direito: menu do servidor/pasta.
function onContext(el, fn) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(el); });
}

// Monta os botões da barra da esquerda (servidores soltos e pastas).
export function railNodes({ servers, view, badge, select, muted = () => false }) {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const placed = new Set();
  const folderOf = new Map();
  folders.forEach((f) => f.serverIds.forEach((id) => { if (byId.has(id)) folderOf.set(id, f); }));
  const serverBtn = (s, inFolder) => {
    const btn = h('button', {
      class: `rail-btn${s.id === view ? ' active' : ''}${s.unread && !muted(s.id) ? ' unread' : ''}${s.iconUrl ? ' has-icon' : ''}${inFolder ? ' in-folder' : ''}${muted(s.id) ? ' muted' : ''}`,
      title: s.name,
      dataset: { serverId: String(s.id) },
      onclick: () => select(s.id),
    }, serverIcon(s), h('span', { class: 'badge-slot' }, badge(muted(s.id) ? 0 : s.mentions) || ''));
    onContext(btn, (el) => serverMenu(el, s));
    return btn;
  };
  const out = [];
  for (const s of servers) {
    if (placed.has(s.id)) continue;
    const f = folderOf.get(s.id);
    if (!f) { placed.add(s.id); out.push(serverBtn(s, false)); continue; }
    const inside = f.serverIds.map((id) => byId.get(id)).filter(Boolean);
    inside.forEach((x) => placed.add(x.id));
    const open = expanded.has(f.id);
    const hasActive = inside.some((x) => x.id === view);
    const unread = inside.some((x) => x.unread);
    const mentions = inside.reduce((n, x) => n + (x.mentions || 0), 0);
    const toggle = () => { if (open) expanded.delete(f.id); else expanded.add(f.id); saveExpanded(); hooks.renderRail(); };
    const head = h('button', {
      class: `rail-btn folder-btn${open ? ' open' : ''}${!open && hasActive ? ' active' : ''}${!open && unread ? ' unread' : ''}`,
      title: `📁 ${f.name} (${inside.length})`,
      style: `--folder:${f.color || '#4d9fff'}`,
      dataset: { folderId: f.id },
      onclick: toggle,
    },
    open ? h('span', { class: 'folder-icon' }, '📂')
      : h('span', { class: 'folder-grid' }, inside.slice(0, 4).map((x) => serverIcon(x, 'mini'))),
    h('span', { class: 'badge-slot' }, !open ? badge(mentions) || '' : ''));
    onContext(head, (el) => folderMenu(el, f));
    out.push(h('div', { class: `rail-folder${open ? ' open' : ''}`, style: `--folder:${f.color || '#4d9fff'}` },
      head, open ? inside.map((x) => serverBtn(x, true)) : null));
  }
  return out;
}

// ================================================================ Denúncias

export const REASONS = [
  ['spam', '📢 Spam ou propaganda'], ['ofensa', '😡 Ofensa ou assédio'], ['impróprio', '🔞 Conteúdo impróprio'],
  ['golpe', '🎣 Golpe ou link perigoso'], ['outro', '❓ Outro motivo'],
];

export function canReport(m) {
  return state.view !== 'home' && m.author && m.author.id !== state.me.id && !m.author.isBot && !m.pending && m.kind !== 'system';
}

export function reportDialog(m) {
  let reason = null;
  const details = h('textarea', { rows: '3', maxlength: '500', id: 'report-details', placeholder: 'Conte o que aconteceu (opcional). Só a moderação vê.' });
  const opts = h('div', { class: 'report-reasons' }, REASONS.map(([key, label]) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'report-reason', value: key, onchange: () => { reason = key; } }),
    h('span', { class: 'kind-text' }, h('strong', {}, label)))));
  const preview = h('div', { class: 'report-preview' }, avatar(m.author, { size: 'xs' }), h('strong', {}, m.author.displayName),
    h('span', { class: 'truncate muted' }, m.content ? m.content.slice(0, 140) : m.attachments.length ? `📎 ${m.attachments[0].filename}` : m.gif ? 'GIF' : ''));
  openDialog({
    title: '🚩 Denunciar mensagem',
    text: 'A denúncia vai para a fila da moderação deste servidor. Quem escreveu não fica sabendo quem denunciou.',
    body: h('div', {}, preview, opts, h('label', { class: 'field' }, 'Detalhes', details)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Enviar denúncia', kind: 'danger', submit: true,
        onClick: async () => {
          if (!reason) throw new Error('Escolha o motivo.');
          await api(`/messages/${m.id}/report`, { method: 'POST', body: { reason, details: details.value } });
          toast('Denúncia enviada. Obrigado por ajudar a moderação! 🚩');
        },
      },
    ],
  });
}

const reportCount = new Map(); // serverId -> abertas
let reportsPanel = null; // { serverId, render }

export async function loadReportCount(serverId) {
  if (!can(P.MANAGE_MESSAGES)) { reportCount.delete(serverId); return; }
  try {
    const { open } = await api(`/servers/${serverId}/reports/count`);
    const before = reportCount.get(serverId);
    reportCount.set(serverId, open);
    if (before !== open) hooks.renderSidebar();
  } catch { /* ignora */ }
}

export function wireReportsSocket(socket) {
  socket.on('reports:changed', ({ serverId }) => {
    if (!state.detail || state.detail.server.id !== serverId || !can(P.MANAGE_MESSAGES)) return;
    const before = reportCount.get(serverId) || 0;
    loadReportCount(serverId).then(() => {
      const now = reportCount.get(serverId) || 0;
      if (now > before) toast(`🚩 Nova denúncia na fila da moderação (${now} aberta${now === 1 ? '' : 's'}).`);
    });
    if (reportsPanel && reportsPanel.serverId === serverId) reportsPanel.reload();
  });
}

export function reportsSidebarItem(serverId) {
  if (!can(P.MANAGE_MESSAGES)) return null;
  const n = reportCount.get(serverId) || 0;
  return h('button', { class: `side-item reports-item${n ? ' has-reports' : ''}`, id: 'reports-item', onclick: () => openReportsPanel(serverId), title: 'Fila de denúncias (só a moderação vê)' },
    h('span', { class: 'hash' }, '🚩'), h('span', { class: 'truncate' }, 'Denúncias'), n ? h('span', { class: 'badge' }, String(n)) : null);
}

export function openReportsPanel(serverId) {
  const ui = { tab: 'open', list: null, loading: false };
  const body = h('div', { class: 'reports-panel' });
  const reload = async () => {
    ui.loading = true;
    try { ({ reports: ui.list } = await api(`/servers/${serverId}/reports?status=${ui.tab}`)); } catch (err) { toast(err.message); ui.list = []; }
    ui.loading = false;
    render();
  };
  const act = async (r, status, deleteMessage = false) => {
    try {
      await api(`/reports/${r.id}`, { method: 'PATCH', body: { status, deleteMessage } });
      toast(deleteMessage ? 'Mensagem apagada e denúncia resolvida.' : status === 'resolved' ? 'Denúncia resolvida.' : 'Denúncia descartada.');
      reload();
      loadReportCount(serverId);
    } catch (err) { toast(err.message); }
  };
  const card = (r) => {
    const snap = r.snapshot || {};
    const author = snap.author || { displayName: 'Alguém', id: 0 };
    return h('article', { class: `report-card ${r.status}`, dataset: { id: String(r.id) } },
      h('div', { class: 'report-top' },
        h('span', { class: 'report-reason' }, r.reasonLabel),
        r.sameCount > 1 ? h('span', { class: 'report-same', title: 'Pessoas diferentes denunciaram a mesma mensagem' }, `${r.sameCount} denúncias`) : null,
        h('span', { class: 'muted small' }, `${fullTime(new Date(r.createdAt))}${r.reporter ? ` · por ${r.reporter.displayName}` : ''}`)),
      r.details ? h('p', { class: 'report-details' }, `“${r.details}”`) : null,
      h('div', { class: 'report-msg' },
        avatar(author, { size: 'xs' }),
        h('div', { class: 'report-msg-body' },
          h('div', {}, h('strong', {}, author.displayName), h('span', { class: 'muted small' }, ` em #${snap.channelName || '?'}`)),
          snap.content ? h('div', { class: 'report-text' }, snap.content) : null,
          (snap.attachments || []).length ? h('div', { class: 'muted small' }, `📎 ${snap.attachments.map((a) => a.filename).join(', ')}`) : null,
          snap.gif ? h('div', { class: 'muted small' }, '🎞️ GIF') : null)),
      r.status === 'open'
        ? h('div', { class: 'row-actions' },
          r.messageExists ? h('button', { class: 'btn small', onclick: () => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); hooks.jumpTo({ serverId, channelId: r.channelId, messageId: r.messageId }); } }, '👀 Ver na conversa') : h('span', { class: 'muted small' }, 'A mensagem já foi apagada.'),
          r.messageExists ? h('button', { class: 'btn small danger', onclick: () => act(r, 'resolved', true) }, '🗑️ Apagar mensagem e resolver') : null,
          h('button', { class: 'btn small primary', onclick: () => act(r, 'resolved') }, '✔ Resolver'),
          h('button', { class: 'btn small ghost', onclick: () => act(r, 'dismissed') }, 'Descartar'))
        : h('p', { class: 'muted small' }, `${r.status === 'resolved' ? '✔ Resolvida' : 'Descartada'}${r.resolvedBy ? ` por ${r.resolvedBy.displayName}` : ''}${r.resolvedAt ? ` em ${fullTime(new Date(r.resolvedAt))}` : ''}${r.note ? ` · ${r.note}` : ''}`));
  };
  const render = () => {
    body.replaceChildren(
      h('div', { class: 'seg' },
        h('button', { class: `seg-btn${ui.tab === 'open' ? ' active' : ''}`, onclick: () => { ui.tab = 'open'; reload(); } }, `Abertas${reportCount.get(serverId) ? ` (${reportCount.get(serverId)})` : ''}`),
        h('button', { class: `seg-btn${ui.tab === 'closed' ? ' active' : ''}`, onclick: () => { ui.tab = 'closed'; reload(); } }, 'Histórico')),
      ui.list === null ? h('p', { class: 'muted' }, 'Carregando…')
        : ui.list.length ? h('div', { class: 'reports-list' }, ui.list.map(card))
          : h('p', { class: 'muted reports-empty' }, ui.tab === 'open' ? '🎉 Nenhuma denúncia aberta.' : 'Nada no histórico ainda.'));
  };
  reportsPanel = { serverId, reload };
  render();
  openDialog({ title: '🚩 Denúncias', text: 'Só quem pode gerenciar mensagens vê esta fila.', body, wide: true, actions: [{ label: 'Fechar' }], onClose: () => { reportsPanel = null; } });
  reload();
}
