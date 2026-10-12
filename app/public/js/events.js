// Eventos do servidor: lista, calendário do mês, criar/editar, "Vou"/"Talvez", lembretes,
// arquivo de agenda (.ics) e link para assinar no Google Agenda.
import { h, api, toast, openDialog, confirmDialog, avatar, openMenu, playPing, copyText, storage } from './util.js';
import { state, P, can, memberById } from './state.js';

const byServer = new Map(); // serverId -> [eventos]
const byMonth = new Map(); // `${serverId}:${ano}-${mês}` -> [eventos] (calendário)
let hooks = { onChange: () => {}, openChannel: () => {} };
let openPanel = null; // { serverId, render }

export function initEvents(h0) { hooks = { ...hooks, ...h0 }; }

const upcoming = (serverId) => (byServer.get(serverId) || [])
  .filter((e) => new Date(e.startsAt).getTime() > Date.now() - 3 * 3600 * 1000)
  .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

export async function loadEvents(serverId) {
  try {
    const { events } = await api(`/servers/${serverId}/events`);
    byServer.set(serverId, events);
    hooks.onChange(serverId);
    if (openPanel && openPanel.serverId === serverId) openPanel.render();
  } catch { /* sem eventos por agora */ }
}

function upsert(ev) {
  const list = (byServer.get(ev.serverId) || []).filter((x) => x.id !== ev.id);
  list.push(ev);
  byServer.set(ev.serverId, list);
  const d = new Date(ev.startsAt);
  for (const [key, arr] of byMonth) {
    if (!key.startsWith(`${ev.serverId}:`)) continue;
    const next = arr.filter((x) => x.id !== ev.id);
    if (key === monthKey(ev.serverId, d.getFullYear(), d.getMonth())) next.push(ev);
    byMonth.set(key, next);
  }
  hooks.onChange(ev.serverId);
  if (openPanel && openPanel.serverId === ev.serverId) openPanel.render();
}

// Eventos em tempo real (socket).
export function wireEventSocket(socket) {
  socket.on('event:changed', ({ event }) => {
    if (!byServer.has(event.serverId)) return; // ainda não abriu esse servidor
    // Canal privado que eu não vejo: esconde.
    if (event.channelId && state.detail && state.detail.server.id === event.serverId
      && !state.detail.channels.some((c) => c.id === event.channelId)) event.channelId = null;
    upsert(event);
  });
  socket.on('event:deleted', ({ serverId, id }) => {
    for (const [key, arr] of byMonth) if (key.startsWith(`${serverId}:`)) byMonth.set(key, arr.filter((e) => e.id !== id));
    if (!byServer.has(serverId)) return;
    byServer.set(serverId, byServer.get(serverId).filter((e) => e.id !== id));
    hooks.onChange(serverId);
    if (openPanel && openPanel.serverId === serverId) openPanel.render();
  });
  socket.on('event:reminder', (r) => {
    toast(r.text);
    if (state.soundOn) playPing();
  });
}

// ---------------------------------------------------------------- Datas

const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function relative(date) {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return diff > -3 * 3600 * 1000 ? 'acontecendo agora' : 'já passou';
  const min = Math.round(diff / 60000);
  if (min < 60) return `em ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `em ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'amanhã' : `em ${days} dias`;
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ---------------------------------------------------------------- Barra lateral

export function eventsSidebarItem(serverId) {
  const list = upcoming(serverId);
  const next = list[0];
  const soon = list.filter((e) => new Date(e.startsAt).getTime() - Date.now() < 7 * 86400000).length;
  return h('button', { class: 'side-item events-item', onclick: () => openEventsPanel(serverId), title: 'Eventos do servidor' },
    h('span', { class: 'hash' }, '📅'),
    h('span', { class: 'events-text' },
      h('span', { class: 'truncate' }, soon ? `${soon} ${soon === 1 ? 'evento' : 'eventos'}` : 'Eventos'),
      next ? h('span', { class: 'muted small truncate' }, `${next.title} · ${relative(new Date(next.startsAt))}`) : null));
}

// ---------------------------------------------------------------- Painel

const monthKey = (serverId, y, m) => `${serverId}:${y}-${m}`;

async function loadMonth(serverId, y, m) {
  const from = new Date(y, m, 1);
  const to = new Date(y, m + 1, 1);
  const { events } = await api(`/servers/${serverId}/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  byMonth.set(monthKey(serverId, y, m), events);
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function openEventsPanel(serverId, { view } = {}) {
  const body = h('div', { class: 'events-panel' });
  const today = new Date();
  const ui = {
    view: view || (storage('nexo.eventsView') === 'month' ? 'month' : 'list'),
    y: today.getFullYear(), m: today.getMonth(), day: null, loading: false,
  };
  const setView = (v) => { ui.view = v; storage('nexo.eventsView', v === 'month' ? 'month' : null); render(); };
  const goMonth = (delta) => {
    const d = new Date(ui.y, ui.m + delta, 1);
    ui.y = d.getFullYear(); ui.m = d.getMonth(); ui.day = null;
    render();
  };

  const monthView = () => {
    const key = monthKey(serverId, ui.y, ui.m);
    if (!byMonth.has(key) && !ui.loading) {
      ui.loading = true;
      loadMonth(serverId, ui.y, ui.m).catch((err) => toast(err.message)).finally(() => { ui.loading = false; if (openPanel && openPanel.render === render) render(); });
    }
    const list = (byMonth.get(key) || []).slice().sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    const first = new Date(ui.y, ui.m, 1);
    const daysInMonth = new Date(ui.y, ui.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push(h('div', { class: 'cal-cell empty' }));
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(ui.y, ui.m, day);
      const evs = list.filter((e) => sameDay(new Date(e.startsAt), date));
      const isToday = sameDay(date, today);
      const past = date < new Date(today.getFullYear(), today.getMonth(), today.getDate());
      cells.push(h('button', {
        class: `cal-cell${isToday ? ' today' : ''}${evs.length ? ' has-events' : ''}${ui.day === day ? ' selected' : ''}${past ? ' past' : ''}`,
        dataset: { day: String(day) },
        title: evs.length ? evs.map((e) => `${timeFmt.format(new Date(e.startsAt))} ${e.title}`).join('\n') : null,
        onclick: () => { ui.day = ui.day === day ? null : day; render(); },
      },
      h('span', { class: 'cal-num' }, String(day)),
      h('span', { class: 'cal-events' }, evs.slice(0, 3).map((e) => h('span', { class: 'cal-ev truncate' }, h('b', {}, timeFmt.format(new Date(e.startsAt))), ' ', e.title)),
        evs.length > 3 ? h('span', { class: 'cal-more muted small' }, `+${evs.length - 3}`) : null)));
    }
    const dayEvents = ui.day ? list.filter((e) => sameDay(new Date(e.startsAt), new Date(ui.y, ui.m, ui.day))) : [];
    const monthName = first.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    return h('div', { class: 'calendar' },
      h('div', { class: 'cal-head' },
        h('button', { class: 'icon-btn', title: 'Mês anterior', onclick: () => goMonth(-1) }, '‹'),
        h('strong', { class: 'cal-title' }, cap(monthName)),
        h('button', { class: 'icon-btn', title: 'Próximo mês', onclick: () => goMonth(1) }, '›'),
        (ui.y !== today.getFullYear() || ui.m !== today.getMonth()) ? h('button', { class: 'btn small', onclick: () => { ui.y = today.getFullYear(); ui.m = today.getMonth(); ui.day = today.getDate(); render(); } }, 'Hoje') : null),
      h('div', { class: 'cal-grid' }, WEEKDAYS.map((w) => h('div', { class: 'cal-wd muted small' }, w)), cells),
      ui.day ? h('div', { class: 'cal-day' },
        h('h3', {}, cap(new Date(ui.y, ui.m, ui.day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))),
        dayEvents.length ? h('div', { class: 'events-list' }, dayEvents.map((e) => eventCard(e)))
          : h('p', { class: 'muted' }, 'Nada marcado neste dia.'),
        can(P.CREATE_EVENTS) && new Date(ui.y, ui.m, ui.day + 1) > today ? h('button', { class: 'btn small', onclick: () => editEventDialog(serverId, null, new Date(ui.y, ui.m, ui.day)) }, '➕ Criar evento neste dia') : null)
        : list.length ? null : h('p', { class: 'muted cal-empty' }, ui.loading ? 'Carregando…' : 'Nenhum evento neste mês.'));
  };

  const render = () => {
    const list = upcoming(serverId);
    body.replaceChildren(
      h('div', { class: 'events-top' },
        h('div', { class: 'seg', role: 'tablist' },
          h('button', { class: `seg-btn${ui.view === 'list' ? ' active' : ''}`, onclick: () => setView('list') }, 'Próximos'),
          h('button', { class: `seg-btn${ui.view === 'month' ? ' active' : ''}`, id: 'events-month-btn', onclick: () => setView('month') }, 'Mês')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', title: 'Ver os eventos dos seus servidores no Google Agenda ou no celular', onclick: calendarLinkDialog }, '🔗 Google Agenda'),
        can(P.CREATE_EVENTS) ? h('button', { class: 'btn primary small', onclick: () => editEventDialog(serverId) }, '➕ Criar evento') : null),
      ui.view === 'month' ? monthView() : h('div', {},
        h('p', { class: 'muted' }, list.length ? 'Confirme presença para receber um lembrete 15 minutos antes.' : 'Nenhum evento marcado.'),
        h('div', { class: 'events-list' }, list.map((e) => eventCard(e)))),
    );
  };
  openPanel = { serverId, render };
  render();
  openDialog({ title: '📅 Eventos', body, wide: true, actions: [{ label: 'Fechar' }], onClose: () => { if (openPanel && openPanel.render === render) openPanel = null; } });
  loadEvents(serverId);
}

// ---------------------------------------------------------------- Link para o Google Agenda

export async function calendarLinkDialog() {
  let url;
  try { ({ url } = await api('/me/calendar-link')); } catch (err) { return toast(err.message); }
  const input = h('input', { readonly: true, value: url, class: 'cal-link', onclick: (e) => e.target.select() });
  const body = h('div', { class: 'cal-link-box' },
    h('p', {}, 'Com este link, o Google Agenda (ou a agenda do celular) mostra os eventos de ', h('strong', {}, 'todos os seus servidores'), ' e atualiza sozinho.'),
    h('div', { class: 'row-actions' }, input, h('button', { class: 'btn primary small', onclick: () => copyText(input.value, input).then((ok) => toast(ok ? 'Link copiado!' : 'Selecione o link e copie (Ctrl+C).')) }, 'Copiar')),
    h('ol', { class: 'cal-steps' },
      h('li', {}, 'Copie o link acima.'),
      h('li', {}, 'No computador, abra o ', h('strong', {}, 'Google Agenda'), '.'),
      h('li', {}, 'Na esquerda, em ', h('strong', {}, 'Outras agendas'), ', clique em ', h('strong', {}, '+'), ' e depois em ', h('strong', {}, 'Do URL'), '.'),
      h('li', {}, 'Cole o link e clique em ', h('strong', {}, 'Adicionar agenda'), '.')),
    h('p', { class: 'muted small' }, 'O Google atualiza essas agendas de tempos em tempos (pode levar algumas horas para aparecer um evento novo). No iPhone: Ajustes → Calendário → Contas → Adicionar conta → Outra → Adicionar calendário assinado.'),
    h('p', { class: 'muted small' }, '🔒 O link é secreto: quem tiver ele vê os seus eventos. Se vazar, gere outro (o antigo para de funcionar).'));
  openDialog({
    title: '🔗 Assinar no Google Agenda', body,
    actions: [
      { label: 'Gerar outro link', onClick: async () => {
        const res = await api('/me/calendar-link', { method: 'POST' });
        input.value = res.url;
        toast('Link novo criado. O antigo parou de funcionar.');
        return false;
      } },
      { label: 'Fechar', kind: 'primary' },
    ],
  });
}

function eventCard(e) {
  const date = new Date(e.startsAt);
  const myStatus = e.going.includes(state.me.id) ? 'going' : e.maybe.includes(state.me.id) ? 'maybe' : null;
  const channel = e.channelId && state.detail && state.detail.channels.find((c) => c.id === e.channelId);
  const mine = e.createdBy && e.createdBy.id === state.me.id;
  const canEdit = can(P.MANAGE_EVENTS) || (mine && can(P.CREATE_EVENTS));
  const live = date.getTime() <= Date.now();
  const people = (ids) => ids.map((id) => memberById(id)).filter(Boolean);
  const goingPeople = people(e.going);
  const maybePeople = people(e.maybe);

  const rsvp = (status) => async () => {
    try {
      const { event } = await api(`/events/${e.id}/rsvp`, { method: 'PUT', body: { status: myStatus === status ? null : status } });
      upsert(event);
    } catch (err) { toast(err.message); }
  };
  const menuItems = [
    { label: '🗓️  Adicionar à minha agenda', onClick: () => downloadIcs(e) },
    { label: '✏️  Editar', hidden: !canEdit, onClick: () => editEventDialog(e.serverId, e) },
    { label: '🗑️  Apagar', danger: true, hidden: !canEdit, onClick: () => confirmDialog({
      title: 'Apagar o evento?', text: `"${e.title}" vai sumir para todo mundo.`, okLabel: 'Apagar',
      onConfirm: async () => { await api(`/events/${e.id}`, { method: 'DELETE' }); },
    }) },
  ];

  return h('article', { class: `event-card${live ? ' live' : ''}`, dataset: { id: String(e.id) } },
    h('div', { class: 'event-date' },
      h('span', { class: 'ev-day' }, String(date.getDate()).padStart(2, '0')),
      h('span', { class: 'ev-month' }, date.toLocaleString('pt-BR', { month: 'short' }).replace('.', ''))),
    h('div', { class: 'event-main' },
      h('div', { class: 'event-when' }, live ? '🔴 ' : '', cap(`${dateFmt.format(date)} às ${timeFmt.format(date)} · ${relative(date)}`)),
      h('h3', { class: 'event-title' }, e.title),
      e.description ? h('p', { class: 'event-desc' }, e.description) : null,
      channel ? h('button', { class: 'event-channel', onclick: () => { closeDialogs(); hooks.openChannel(e.serverId, channel.id); } },
        channel.kind === 'voice' ? '🔊 ' : '# ', channel.name) : null,
      h('div', { class: 'event-people' },
        goingPeople.length ? h('span', { class: 'ev-avatars', title: goingPeople.map((m) => m.displayName).join(', ') },
          goingPeople.slice(0, 8).map((m) => avatar(m, { size: 'xs' }))) : null,
        h('span', { class: 'muted small', title: maybePeople.length ? `Talvez: ${maybePeople.map((m) => m.displayName).join(', ')}` : null },
          `${e.going.length} ${e.going.length === 1 ? 'vai' : 'vão'}${e.maybe.length ? ` · ${e.maybe.length} talvez` : ''}`),
        e.createdBy ? h('span', { class: 'muted small' }, ` · criado por ${e.createdBy.displayName}`) : null),
      h('div', { class: 'event-actions' },
        h('button', { class: `btn small${myStatus === 'going' ? ' primary' : ''}`, onclick: rsvp('going') }, myStatus === 'going' ? '✅ Vou' : 'Vou'),
        h('button', { class: `btn small${myStatus === 'maybe' ? ' primary' : ''}`, onclick: rsvp('maybe') }, myStatus === 'maybe' ? '🤔 Talvez' : 'Talvez'),
        h('button', { class: 'icon-btn small', title: 'Mais opções', onclick: (ev) => openMenu(ev.currentTarget, menuItems, { className: 'popover-menu' }) }, '⋯'))));
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
}

// ---------------------------------------------------------------- Criar / editar

function editEventDialog(serverId, ev = null, onDay = null) {
  const title = h('input', { maxlength: '100', placeholder: 'Ex.: Jogatina de sexta', value: ev ? ev.title : '' });
  const start = ev ? new Date(ev.startsAt) : (() => {
    const d = onDay ? new Date(onDay) : new Date(Date.now() + 86400000);
    d.setMinutes(0, 0, 0); d.setHours(21);
    return d < new Date() ? new Date(Date.now() + 3600000) : d;
  })();
  const when = h('input', { type: 'datetime-local', value: toLocalInput(start), min: toLocalInput(new Date()) });
  const desc = h('textarea', { maxlength: '1000', rows: '3', placeholder: 'Detalhes (opcional)' });
  desc.value = ev ? ev.description : '';
  const channels = state.detail && state.detail.server.id === serverId
    ? state.detail.channels.filter((c) => c.kind === 'voice' || c.kind === 'text') : [];
  const where = h('select', {},
    h('option', { value: '' }, 'Nenhum (sem canal)'),
    channels.map((c) => h('option', { value: String(c.id), selected: ev ? ev.channelId === c.id : false }, `${c.kind === 'voice' ? '🔊' : '#'} ${c.name}`)));
  if (!ev) { const firstVoice = channels.find((c) => c.kind === 'voice'); if (firstVoice) where.value = String(firstVoice.id); }
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  openDialog({
    title: ev ? 'Editar evento' : '📅 Novo evento',
    body: h('div', { class: 'event-form' },
      field('Nome', title), field('Quando', when), field('Onde', where), field('Descrição', desc)),
    actions: [
      { label: 'Cancelar' },
      {
        label: ev ? 'Salvar' : 'Criar evento', kind: 'primary', submit: true,
        onClick: async () => {
          if (!when.value) throw new Error('Escolha a data e o horário.');
          const d = new Date(when.value); // horário daqui (do seu aparelho)
          if (Number.isNaN(d.getTime())) throw new Error('Data inválida.');
          const body = { title: title.value, startsAt: d.toISOString(), description: desc.value, channelId: where.value ? Number(where.value) : null };
          const res = ev
            ? await api(`/events/${ev.id}`, { method: 'PATCH', body })
            : await api(`/servers/${serverId}/events`, { method: 'POST', body });
          upsert(res.event);
          toast(ev ? 'Evento atualizado.' : 'Evento criado! 📅');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Agenda (.ics)

function downloadIcs(e) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const start = new Date(e.startsAt);
  const end = new Date(start.getTime() + 2 * 3600 * 1000);
  const server = state.servers.find((s) => s.id === e.serverId);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nexo//Eventos//PT', 'BEGIN:VEVENT',
    `UID:nexo-evento-${e.id}@${location.host}`, `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(e.title)}`,
    `DESCRIPTION:${esc(`${e.description ? `${e.description}\n\n` : ''}${server ? `Servidor: ${server.name}\n` : ''}${location.origin}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: `${e.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'evento'}.ics` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
