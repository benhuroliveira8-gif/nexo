// Níveis e XP: página nas configurações do servidor e a janela de ranking.
import { h, api, toast, avatar, openDialog, confirmDialog } from './util.js';
import { state, isOwner, myTop } from './state.js';

const bar = (cur, need) => h('div', { class: 'level-bar' }, h('i', { style: `width:${Math.round((cur / need) * 100)}%` }));

// ---------------------------------------------------------------- Configurações do servidor → Níveis

export function renderLevels() {
  const d = state.detail;
  const page = h('div', { class: 'settings-page' }, h('h2', {}, 'Níveis e XP'), h('p', { class: 'muted' }, 'Carregando…'));
  api(`/servers/${d.server.id}/levels?limit=10`).then((data) => fill(page, data)).catch((err) => toast(err.message));
  return page;
}

function fill(page, data) {
  const d = state.detail;
  const cfg = data.settings || {};
  const enabled = h('input', { type: 'checkbox', class: 'switch', checked: !!cfg.enabled });
  const announce = h('select', {},
    h('option', { value: 'same', selected: cfg.announce === 'same' }, 'No canal onde a pessoa falou'),
    h('option', { value: 'channel', selected: cfg.announce === 'channel' }, 'Num canal fixo'),
    h('option', { value: 'off', selected: cfg.announce === 'off' }, 'Não avisar'));
  const textChannels = d.channels.filter((c) => c.kind === 'text');
  const channel = h('select', {}, textChannels.map((c) => h('option', { value: String(c.id), selected: cfg.channelId === c.id }, `# ${c.name}`)));
  const channelField = h('label', { class: 'field', hidden: cfg.announce !== 'channel' }, h('span', {}, 'Canal dos avisos'), channel);
  announce.addEventListener('change', () => { channelField.hidden = announce.value !== 'channel'; });
  const message = h('input', { maxlength: '300', value: cfg.message || '' });
  const cooldown = h('input', { type: 'number', min: '0', max: '3600', value: String(cfg.cooldown ?? 60), class: 'num-input' });
  const assignable = d.roles.filter((r) => !r.isDefault && (isOwner() || r.position < myTop()));
  const rewards = (cfg.rewards || []).map((r) => ({ ...r }));
  const rewardList = h('div', { class: 'reward-list' });
  const drawRewards = () => rewardList.replaceChildren(
    ...rewards.map((rw, i) => {
      const lvl = h('input', { type: 'number', min: '1', max: '500', value: String(rw.level), class: 'num-input' });
      lvl.addEventListener('input', () => { rw.level = Number(lvl.value); });
      const role = h('select', {}, assignable.map((r) => h('option', { value: String(r.id), selected: rw.roleId === r.id }, r.name)));
      if (!assignable.some((r) => r.id === rw.roleId) && assignable[0]) rw.roleId = assignable[0].id;
      role.addEventListener('change', () => { rw.roleId = Number(role.value); });
      return h('div', { class: 'reward-row' }, h('span', {}, 'Nível'), lvl, h('span', {}, '→ cargo'), role,
        h('button', { class: 'icon-btn small', title: 'Tirar', onclick: () => { rewards.splice(i, 1); drawRewards(); } }, '✕'));
    }),
    assignable.length
      ? h('button', { class: 'btn small', onclick: () => { rewards.push({ level: (rewards.at(-1)?.level || 0) + 5, roleId: assignable[0].id }); drawRewards(); } }, '＋ Adicionar recompensa')
      : h('p', { class: 'muted small' }, 'Crie cargos (abaixo do seu) para usar como recompensa.'));
  drawRewards();
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'muted small' }, hint) : null);

  page.replaceChildren(
    h('h2', {}, 'Níveis e XP'),
    h('p', { class: 'muted' }, 'Quem conversa ganha XP (de 15 a 25 por mensagem, no máximo uma vez por minuto) e sobe de nível. É opcional: fica desligado até você ligar.'),
    data.settings ? h('div', { class: 'settings-block' },
      h('label', { class: 'switch-row' }, h('span', { class: 'kind-text' }, h('strong', {}, 'Ligar níveis neste servidor')), enabled),
      field('Avisar quando alguém subir de nível', announce),
      channelField,
      field('Mensagem do aviso', message, 'Use {usuario} para mencionar, {nome} para o nome e {nivel} para o nível.'),
      field('Segundos entre mensagens que dão XP', cooldown, 'Evita que quem manda muitas mensagens seguidas suba rápido demais (padrão: 60).')) : null,
    data.settings ? h('div', { class: 'settings-block' },
      h('h3', {}, 'Cargos automáticos por nível'),
      h('p', { class: 'muted small' }, 'Ao chegar no nível, a pessoa ganha o cargo (e quem já passou dele ganha na hora).'),
      rewardList) : null,
    data.settings ? h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await api(`/servers/${d.server.id}/levels`, {
              method: 'PUT',
              body: {
                enabled: enabled.checked, announce: announce.value, channelId: channel.value ? Number(channel.value) : null,
                message: message.value, cooldown: Number(cooldown.value), rewards,
              },
            });
            toast(enabled.checked ? 'Níveis salvos! ⭐' : 'Níveis desligados.');
          } catch (err) { toast(err.message); }
        },
      }, 'Salvar'),
      h('button', {
        class: 'btn danger-ghost',
        onclick: () => confirmDialog({
          title: 'Zerar o XP de todo mundo?', text: 'Todos voltam para o nível 0. Os cargos já ganhos continuam.', okLabel: 'Zerar XP',
          onConfirm: () => api(`/servers/${d.server.id}/levels/xp`, { method: 'DELETE' }).then(() => toast('XP zerado.')),
        }),
      }, 'Zerar XP')) : null,
    data.enabled ? h('div', { class: 'settings-block' }, h('h3', {}, 'Ranking'), rankingList(data.ranking)) : null);
}

function rankingList(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'Ninguém ganhou XP ainda.');
  const medal = ['🥇', '🥈', '🥉'];
  return h('ol', { class: 'ranking' }, list.map((x) => h('li', { class: `rank-row${x.user.id === state.me.id ? ' me' : ''}` },
    h('span', { class: 'rank-pos' }, medal[x.rank - 1] || `#${x.rank}`),
    avatar(x.user, { size: 'sm' }),
    h('span', { class: 'rank-name truncate' }, x.user.displayName),
    h('span', { class: 'rank-level' }, `Nível ${x.level}`),
    h('span', { class: 'rank-bar' }, bar(x.current, x.needed)),
    h('span', { class: 'muted small rank-xp' }, `${x.xp} XP`))));
}

// ---------------------------------------------------------------- Janela do ranking (todos os membros)

export async function openRanking(serverId) {
  let data;
  try { data = await api(`/servers/${serverId}/levels?limit=50`); } catch (err) { return toast(err.message); }
  if (!data.enabled) return toast('Os níveis estão desligados neste servidor.');
  const me = data.me;
  openDialog({
    title: '🏆 Ranking do servidor',
    wide: true,
    body: h('div', { class: 'ranking-dialog' },
      me ? h('div', { class: 'my-level' },
        h('div', {}, h('strong', {}, `Você: nível ${me.level}`), me.rank ? h('span', { class: 'muted' }, ` • #${me.rank}`) : null),
        bar(me.current, me.needed),
        h('div', { class: 'muted small' }, `${me.current}/${me.needed} XP para o nível ${me.level + 1} • ${me.messages} mensagens`)) : null,
      data.rewards && data.rewards.length ? h('div', { class: 'muted small rewards-hint' },
        '🎁 Recompensas: ', data.rewards.map((r) => {
          const role = state.detail && state.detail.roles.find((x) => x.id === r.roleId);
          return role ? `nível ${r.level} → ${role.name}` : null;
        }).filter(Boolean).join(' · ')) : null,
      rankingList(data.ranking)),
    actions: [{ label: 'Fechar' }],
  });
}

export function rankingSidebarItem(serverId) {
  if (!state.detail || !state.detail.levelsEnabled) return null;
  return h('button', { class: 'side-item ranking-item', onclick: () => openRanking(serverId) },
    h('span', { class: 'side-icon' }, '🏆'), h('span', { class: 'truncate' }, 'Ranking'));
}
