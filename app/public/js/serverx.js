// Páginas extras das configurações do servidor: figurinhas, sons, boas-vindas,
// moderação automática e estatísticas.
import { h, api, toast, confirmDialog, getToken, avatar } from './util.js';
import { state, P, can, isOwner, myTop } from './state.js';
import { audioDuration } from './sounds.js';

// ---------------------------------------------------------------- Figurinhas e sons

async function uploadAsset(serverId, kind, file, name, emoji) {
  const res = await fetch(`/api/servers/${serverId}/${kind}s`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream',
      'X-Asset-Name': encodeURIComponent(name), ...(emoji ? { 'X-Asset-Emoji': encodeURIComponent(emoji) } : {}),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data[kind];
}

const nameFrom = (filename) => String(filename || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 30) || 'sem nome';

export function renderAssets(kind) {
  const d = state.detail;
  const sound = kind === 'sound';
  const list = (sound ? d.sounds : d.stickers) || [];
  const max = sound ? 24 : 30;
  const picker = h('input', {
    type: 'file', multiple: true, hidden: true,
    accept: sound ? 'audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,.mp3,.ogg,.wav,.webm,.m4a' : 'image/png,image/gif,image/webp,image/jpeg',
  });
  picker.addEventListener('change', async () => {
    const chosen = [...picker.files];
    picker.value = '';
    let ok = 0;
    for (const f of chosen.slice(0, max - list.length)) {
      try {
        if (f.size > 512 * 1024) throw new Error(`"${f.name}" passa de 512 KB.`);
        if (sound) {
          const dur = await audioDuration(f).catch(() => null);
          if (dur === null) throw new Error(`"${f.name}" não é um áudio que o navegador entenda.`);
          if (dur > 7) throw new Error(`"${f.name}" tem ${Math.round(dur)} s. Use sons de até 7 segundos.`);
        }
        await uploadAsset(d.server.id, kind, f, nameFrom(f.name), sound ? '🔊' : null);
        ok++;
      } catch (err) { toast(err.message); }
    }
    if (ok) toast(sound ? `${ok} ${ok === 1 ? 'som adicionado' : 'sons adicionados'}!` : `${ok} ${ok === 1 ? 'figurinha adicionada' : 'figurinhas adicionadas'}!`);
  });
  const save = async (item, body) => {
    try { await api(`/servers/${d.server.id}/${kind}s/${item.id}`, { method: 'PATCH', body }); toast('Salvo!'); } catch (err) { toast(err.message); }
  };
  return h('div', { class: 'settings-page' },
    h('h2', {}, sound ? 'Sons (soundboard)' : 'Figurinhas'),
    h('p', { class: 'muted' }, sound
      ? 'Sons curtos (até 7 segundos) para tocar na chamada pelo botão 🎵. Além destes, todo servidor já vem com os sons do Nexo (buzina, aplausos, risada…).'
      : 'Figurinhas grandes para mandar no chat pelo botão 🏷️ (ou ＋ → Enviar figurinha). Quem está no servidor também pode usá-las nas DMs.'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary small', disabled: list.length >= max, onclick: () => picker.click() }, sound ? '+ Enviar som' : '+ Enviar figurinha'),
      h('span', { class: 'muted small' }, `${list.length} de ${max} · ${sound ? 'MP3, OGG, WAV, WEBM ou M4A' : 'PNG, GIF, WEBP ou JPG'} (até 512 KB)`),
      picker),
    list.length === 0
      ? h('div', { class: 'empty-state' }, h('div', { class: 'empty-art' }, sound ? '🎵' : '🏷️'), h('p', { class: 'muted' }, sound ? 'Nenhum som próprio ainda.' : 'Nenhuma figurinha ainda.'))
      : h('div', { class: sound ? 'asset-admin sounds' : 'asset-admin' }, list.map((item) => {
        const input = h('input', { value: item.name, maxlength: '30', 'aria-label': 'Nome' });
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
        input.addEventListener('blur', () => { if (input.value.trim() !== item.name) save(item, { name: input.value }); });
        const emoji = sound ? h('input', { value: item.emoji, maxlength: '8', class: 'asset-emoji', 'aria-label': 'Emoji' }) : null;
        if (emoji) emoji.addEventListener('blur', () => { if (emoji.value.trim() !== item.emoji) save(item, { name: input.value, emoji: emoji.value }); });
        return h('div', { class: 'asset-row' },
          sound
            ? h('button', { class: 'icon-btn', title: 'Ouvir', onclick: () => { const a = new Audio(item.url); a.volume = 0.6; a.play().catch(() => {}); } }, '▶️')
            : h('img', { class: 'asset-img', src: item.url, alt: '' }),
          emoji, input,
          h('button', {
            class: 'icon-btn small', title: 'Apagar',
            onclick: () => confirmDialog({
              title: `Apagar "${item.name}"?`, okLabel: 'Apagar',
              text: sound ? 'Ninguém mais vai conseguir tocar este som.' : 'Nas mensagens antigas ela vai aparecer como "figurinha apagada".',
              onConfirm: () => api(`/servers/${d.server.id}/${kind}s/${item.id}`, { method: 'DELETE' }),
            }),
          }, '🗑️'));
      })));
}

// ---------------------------------------------------------------- Boas-vindas

export function renderWelcome() {
  const d = state.detail;
  const w = (d.settings && d.settings.welcome) || { enabled: false, channelId: null, message: 'Boas-vindas, {usuario}! 👋 Leia as regras e divirta-se.', roleId: null };
  const enabled = h('input', { type: 'checkbox', class: 'switch', checked: !!w.enabled });
  const textChannels = d.channels.filter((c) => c.kind === 'text');
  const channel = h('select', {}, textChannels.map((c) => h('option', { value: String(c.id), selected: w.channelId === c.id }, `# ${c.name}`)));
  const message = h('textarea', { rows: '3', maxlength: '500' });
  message.value = w.message || '';
  const assignable = d.roles.filter((r) => !r.isDefault && (isOwner() || r.position < myTop()));
  const role = h('select', {}, h('option', { value: '' }, 'Nenhum'), assignable.map((r) => h('option', { value: String(r.id), selected: w.roleId === r.id }, r.name)));
  const preview = h('div', { class: 'welcome-preview muted' });
  const updatePreview = () => {
    preview.textContent = `👋 ${(message.value || 'Boas-vindas, {usuario}! 👋').replace(/\{usuario\}/gi, `@${state.me.username}`).replace(/\{nome\}/gi, state.me.displayName).replace(/\{servidor\}/gi, d.server.name)}`;
  };
  message.addEventListener('input', updatePreview);
  updatePreview();
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'muted small' }, hint) : null);
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Boas-vindas'),
    h('p', { class: 'muted' }, 'O que acontece quando alguém entra no servidor por um convite.'),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Cargo automático'),
      field('Dar este cargo para quem entra', role, 'Útil para liberar canais só para membros, por exemplo.')),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Mensagem de boas-vindas'),
      h('label', { class: 'switch-row' }, h('span', { class: 'kind-text' }, h('strong', {}, 'Mandar mensagem quando alguém entrar')), enabled),
      field('Canal', channel),
      field('Mensagem', message, 'Use {usuario} para mencionar a pessoa, {nome} para o nome dela e {servidor} para o nome do servidor.'),
      h('div', { class: 'muted small' }, 'Prévia:'), preview),
    h('div', { class: 'row-actions' }, h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api(`/servers/${d.server.id}/welcome`, { method: 'PUT', body: { enabled: enabled.checked, channelId: channel.value ? Number(channel.value) : null, message: message.value, roleId: role.value ? Number(role.value) : null } });
          toast('Boas-vindas salvas!');
        } catch (err) { toast(err.message); }
      },
    }, 'Salvar')));
}

// ---------------------------------------------------------------- Moderação automática

export function renderAutomod() {
  const d = state.detail;
  const a = (d.settings && d.settings.automod) || {};
  const words = h('textarea', { rows: '5', placeholder: 'Uma palavra (ou expressão) por linha' });
  words.value = (a.words || []).join('\n');
  const num = (v, min, max) => h('input', { type: 'number', min: String(min), max: String(max), value: String(v), class: 'num-input' });
  const wordsTimeout = num(a.wordsTimeout || 0, 0, 1440);
  const spam = h('input', { type: 'checkbox', class: 'switch', checked: !!a.spam });
  const spamCount = num(a.spamCount || 5, 3, 30);
  const spamSeconds = num(a.spamSeconds || 10, 3, 120);
  const spamDuplicates = num(a.spamDuplicates || 3, 2, 20);
  const spamMentions = num(a.spamMentions || 6, 2, 50);
  const spamTimeout = num(a.spamTimeout || 5, 1, 1440);
  const line = (...parts) => h('div', { class: 'automod-line' }, ...parts);
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Moderação automática'),
    h('p', { class: 'muted' }, 'Vale para todo mundo, menos o dono, administradores e quem pode "Gerenciar mensagens". Castigos e bloqueios aparecem no registro de auditoria.'),
    h('div', { class: 'settings-block' },
      h('h3', {}, '🚫 Palavras bloqueadas'),
      h('p', { class: 'muted small' }, 'Mensagens com essas palavras não são enviadas. Não importa maiúscula nem acento ("Palavrão" = "palavrao").'),
      words,
      line('Castigo ao usar:', wordsTimeout, h('span', {}, 'minutos (0 = só bloqueia a mensagem)'))),
    h('div', { class: 'settings-block' },
      h('h3', {}, '🛡️ Anti-spam'),
      h('label', { class: 'switch-row' }, h('span', { class: 'kind-text' }, h('strong', {}, 'Ligar anti-spam'), h('span', { class: 'muted small' }, 'Quem passar dos limites leva castigo automático.')), spam),
      line('Mais de', spamCount, h('span', {}, 'mensagens em'), spamSeconds, h('span', {}, 'segundos')),
      line('A mesma mensagem repetida', spamDuplicates, h('span', {}, 'vezes (em 1 minuto)')),
      line('Mais de', spamMentions, h('span', {}, 'menções numa mensagem só')),
      line('Castigo:', spamTimeout, h('span', {}, 'minutos'))),
    h('div', { class: 'row-actions' }, h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api(`/servers/${d.server.id}/automod`, {
            method: 'PUT',
            body: {
              words: words.value, wordsTimeout: Number(wordsTimeout.value), spam: spam.checked, spamCount: Number(spamCount.value),
              spamSeconds: Number(spamSeconds.value), spamDuplicates: Number(spamDuplicates.value), spamMentions: Number(spamMentions.value), spamTimeout: Number(spamTimeout.value),
            },
          });
          toast('Moderação automática salva!');
        } catch (err) { toast(err.message); }
      },
    }, 'Salvar')));
}

// ---------------------------------------------------------------- Estatísticas

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function bars(values, labels, { title, labelEvery = 1, highlightMax = true } = {}) {
  const max = Math.max(1, ...values);
  const top = values.indexOf(Math.max(...values));
  return h('div', { class: 'chart' },
    title ? h('div', { class: 'chart-title' }, title) : null,
    h('div', { class: 'chart-bars', style: `--n:${values.length}` }, values.map((v, i) => h('div', {
      class: `chart-col${highlightMax && i === top && v > 0 ? ' top' : ''}`, title: `${labels[i]}: ${v} ${v === 1 ? 'mensagem' : 'mensagens'}`,
    }, h('div', { class: 'chart-bar', style: `height:${Math.round((v / max) * 100)}%` })))),
    h('div', { class: 'chart-labels', style: `--n:${values.length}` }, labels.map((l, i) => h('span', {}, i % labelEvery === 0 ? l : ''))));
}

export function renderStats(ctx) {
  const d = state.detail;
  const days = ctx.cache.statsDays || 30;
  const page = h('div', { class: 'settings-page' },
    h('h2', {}, 'Estatísticas'),
    h('div', { class: 'row-actions' }, [7, 30, 90].map((n) => h('button', {
      class: `btn small${n === days ? ' primary' : ''}`, onclick: () => { ctx.cache.statsDays = n; ctx.cache.stats = null; ctx.rerender(); },
    }, `${n} dias`))),
    h('p', { class: 'muted' }, 'Carregando…'));
  const cached = ctx.cache.stats;
  const fill = (st) => {
    const perDayMap = new Map(st.perDay.map((x) => [x.day, x.n]));
    const dayKeys = [];
    for (let i = st.days - 1; i >= 0; i--) {
      const t = new Date(Date.now() - i * 86400000);
      dayKeys.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
    }
    const busiestHour = st.perHour.indexOf(Math.max(...st.perHour));
    const busiestDay = st.perWeekday.indexOf(Math.max(...st.perWeekday));
    const tile = (n, l) => h('div', { class: 'stat-tile' }, h('strong', {}, n.toLocaleString('pt-BR')), h('span', { class: 'muted small' }, l));
    page.lastChild.replaceWith(h('div', { class: 'stats' },
      h('div', { class: 'stat-tiles' },
        tile(st.totals.messages, `mensagens em ${st.days} dias`),
        tile(st.totals.activeMembers, 'pessoas escreveram'),
        tile(st.totals.members, 'membros no total'),
        tile(st.totals.joined, `entraram em ${st.days} dias`)),
      st.totals.messages ? h('p', { class: 'muted' }, `Horário mais movimentado: ${busiestHour}h · Dia da semana mais ativo: ${WEEKDAYS[busiestDay]}`) : null,
      bars(dayKeys.map((k) => perDayMap.get(k) || 0), dayKeys.map((k) => k.slice(8, 10) + '/' + k.slice(5, 7)), { title: 'Mensagens por dia', labelEvery: st.days > 30 ? 14 : st.days > 7 ? 5 : 1 }),
      bars(st.perHour, st.perHour.map((_, i) => `${i}h`), { title: 'Por horário do dia', labelEvery: 3 }),
      bars(st.perWeekday, WEEKDAYS, { title: 'Por dia da semana' }),
      h('div', { class: 'stats-cols' },
        h('div', {}, h('div', { class: 'chart-title' }, 'Quem mais participa'),
          st.topMembers.length ? h('ol', { class: 'rank' }, st.topMembers.map((u) => h('li', {}, avatar(u, { size: 'xs' }), h('span', { class: 'truncate' }, u.displayName), h('span', { class: 'muted' }, u.count.toLocaleString('pt-BR'))))) : h('p', { class: 'muted small' }, 'Ninguém escreveu ainda.')),
        h('div', {}, h('div', { class: 'chart-title' }, 'Canais mais ativos'),
          st.topChannels.length ? h('ol', { class: 'rank' }, st.topChannels.map((c) => h('li', {}, h('span', { class: 'truncate' }, `${c.kind === 'thread' ? '🧵' : '#'} ${c.name}`), h('span', { class: 'muted' }, c.count.toLocaleString('pt-BR'))))) : h('p', { class: 'muted small' }, '—')))));
  };
  if (cached && cached.days === days) fill(cached);
  else {
    api(`/servers/${d.server.id}/stats?days=${days}&tz=${new Date().getTimezoneOffset()}`)
      .then((st) => { ctx.cache.stats = st; if (page.isConnected) fill(st); })
      .catch((err) => { page.lastChild.textContent = err.message; });
  }
  return page;
}

export const canSeeStats = () => can(P.MANAGE_SERVER) || can(P.VIEW_AUDIT_LOG);
