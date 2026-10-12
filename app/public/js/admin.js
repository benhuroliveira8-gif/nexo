// Administração do Nexo (a instância inteira): contas, bloqueio, código para senha nova e disco.
import { h, api, avatar, toast, openDialog, confirmDialog, copyText, formatSize } from './util.js';
import { state } from './state.js';

let ui = null; // { root, tab, q }

export function closeAdmin() {
  if (!ui) return;
  clearInterval(ui.timer);
  ui.root.remove();
  document.removeEventListener('keydown', onKey);
  ui = null;
}
function onKey(e) {
  if (e.key === 'Escape' && ui && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) closeAdmin();
}

export function openAdmin(tab = 'overview') {
  if (!state.me || !state.me.isAdmin) return toast('Só a administração do Nexo pode abrir isso.');
  closeAdmin();
  const root = h('div', { class: 'settings-overlay admin-overlay', role: 'dialog', 'aria-modal': 'true' });
  document.body.append(root);
  ui = { root, tab, q: '' };
  document.addEventListener('keydown', onKey);
  render();
}

function render() {
  const tabs = [['overview', '📊 Visão geral e disco'], ['health', '🩺 Saúde'], ['users', '👥 Contas']];
  const content = h('div', { class: 'settings-content' });
  ui.root.replaceChildren(h('div', { class: 'settings' },
    h('nav', { class: 'settings-nav' },
      h('div', { class: 'settings-server truncate' }, '🛡️ Administração do Nexo'),
      tabs.map(([k, label]) => h('button', { class: `settings-tab${ui.tab === k ? ' active' : ''}`, onclick: () => { ui.tab = k; render(); } }, label))),
    content,
    h('button', { class: 'settings-close', title: 'Fechar (Esc)', onclick: closeAdmin }, '✕')));
  clearInterval(ui.timer);
  content.append(ui.tab === 'users' ? pageUsers() : ui.tab === 'health' ? pageHealth() : pageOverview());
}

const block = (title, ...children) => h('div', { class: 'settings-block' }, title ? h('h3', {}, title) : null, ...children);
const ago = (d) => {
  if (!d) return 'nunca';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 120) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dia(s)`;
};

// ---------------------------------------------------------------- Visão geral e disco

function pageOverview() {
  const page = h('div', { class: 'settings-page' }, h('h2', {}, 'Visão geral'), h('p', { class: 'muted' }, 'Carregando…'));
  api('/admin/overview').then((d) => fillOverview(page, d)).catch((err) => toast(err.message));
  return page;
}

function fillOverview(page, d) {
  const tile = (label, value) => h('div', { class: 'stat-tile' }, h('span', { class: 'muted small' }, label), h('strong', {}, value));
  const disk = d.disk;
  const used = disk ? disk.percent : 0;
  const maxAge = h('input', { type: 'number', min: '0', max: '3650', value: String(d.settings.maxAgeDays), class: 'num-input' });
  const warn = h('input', { type: 'number', min: '50', max: '99', value: String(d.settings.warnPercent), class: 'num-input' });
  const now = h('input', { type: 'number', min: '1', max: '3650', value: '180', class: 'num-input' });
  const kindLabel = { imagem: '🖼️ Imagens', video: '🎬 Vídeos', audio: '🎵 Áudios', 'audio-voz': '🎤 Mensagens de voz', outro: '📎 Outros' };
  page.replaceChildren(
    h('h2', {}, 'Visão geral'),
    d.diskWarning ? h('div', { class: 'admin-alert' }, `⚠️ O disco está ${used}% cheio. Limpe anexos antigos abaixo ou aumente o disco da VM.`) : null,
    h('div', { class: 'stat-tiles' },
      tile('Pessoas', d.counts.people), tile('Bots', d.counts.bots), tile('Servidores', d.counts.servers),
      tile('Mensagens', d.counts.messages.toLocaleString('pt-BR')), tile('Contas bloqueadas', d.counts.blocked)),
    block('Disco',
      disk ? h('div', { class: 'disk' },
        h('div', { class: `disk-bar${d.diskWarning ? ' warn' : ''}` }, h('i', { style: `width:${used}%` })),
        h('div', { class: 'muted small' }, `${used}% usado • ${formatSize(disk.used)} de ${formatSize(disk.total)} • livre: ${formatSize(disk.free)}`))
        : h('p', { class: 'muted' }, 'Não deu para ler o disco.'),
      h('div', { class: 'stat-tiles' },
        tile('Anexos', `${formatSize(d.storage.attachments.bytes)} (${d.storage.attachments.count})`),
        tile('Fotos de perfil, ícones e capas', formatSize(d.storage.avatars.bytes)),
        tile('Banco de dados', formatSize(d.storage.database)),
        tile('Anexos antigos já removidos', d.storage.attachments.purged)),
      d.storage.byKind.length ? h('div', { class: 'admin-kinds muted small' },
        d.storage.byKind.map((k) => h('span', {}, `${kindLabel[k.kind] || k.kind}: ${formatSize(k.bytes)}`))) : null,
      d.storage.topUsers.length ? h('div', {}, h('div', { class: 'profile-label' }, 'Quem mais ocupa espaço'),
        h('ol', { class: 'admin-top' }, d.storage.topUsers.map((u) => h('li', {}, `${u.displayName} (@${u.username}) — ${formatSize(u.bytes)} em ${u.files} arquivo(s)`)))) : null),
    block('Limpeza automática',
      h('p', { class: 'muted' }, 'Apaga só o ARQUIVO dos anexos mais antigos (a mensagem continua, com o aviso "arquivo antigo removido"). Fotos de perfil, ícones, figurinhas e sons nunca são apagados.'),
      h('div', { class: 'automod-line' }, 'Apagar anexos com mais de', maxAge, 'dias (0 = nunca)'),
      h('div', { class: 'automod-line' }, 'Avisar a administração quando o disco passar de', warn, '%'),
      h('div', { class: 'row-actions' }, h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await api('/admin/storage', { method: 'PUT', body: { maxAgeDays: Number(maxAge.value), warnPercent: Number(warn.value) } });
            toast('Configuração do disco salva.');
          } catch (err) { toast(err.message); }
        },
      }, 'Salvar'))),
    block('Limpar agora',
      h('div', { class: 'automod-line' }, 'Apagar agora os anexos com mais de', now, 'dias'),
      h('button', {
        class: 'btn danger-ghost',
        onclick: () => confirmDialog({
          title: `Apagar anexos com mais de ${now.value} dias?`,
          text: 'Os arquivos somem para sempre (as mensagens continuam). Não dá para desfazer.',
          okLabel: 'Apagar arquivos',
          onConfirm: async () => {
            const r = await api('/admin/storage/cleanup', { method: 'POST', body: { olderThanDays: Number(now.value) } });
            toast(r.count ? `${r.count} arquivo(s) apagado(s), ${formatSize(r.bytes)} liberados.` : 'Nenhum anexo tão antigo.');
            if (ui) render();
          },
        }),
      }, 'Apagar arquivos antigos')));
}

// ---------------------------------------------------------------- Saúde

const dur = (secs) => {
  if (secs == null) return '—';
  const d = Math.floor(secs / 86400); const hh = Math.floor((secs % 86400) / 3600); const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} dia(s) e ${hh} h`;
  if (hh) return `${hh} h ${m} min`;
  if (m) return `${m} min`;
  return `${secs} s`;
};

function pageHealth() {
  const page = h('div', { class: 'settings-page' }, h('h2', {}, 'Saúde do Nexo'), h('p', { class: 'muted' }, 'Carregando…'));
  const load = () => api('/admin/health').then((d) => { if (ui && ui.tab === 'health') fillHealth(page, d); }).catch((err) => toast(err.message));
  load();
  ui.timer = setInterval(load, 15000); // atualiza sozinho
  return page;
}

function fillHealth(page, d) {
  const meter = (label, pct, extra) => h('div', { class: 'meter' },
    h('div', { class: 'meter-head' }, h('span', {}, label), h('strong', {}, `${pct}%`)),
    h('div', { class: `disk-bar${pct >= 90 ? ' warn' : ''}` }, h('i', { style: `width:${Math.min(100, pct)}%` })),
    extra ? h('div', { class: 'muted small' }, extra) : null);
  const svc = (label, x, okText) => h('div', { class: `svc ${x.ok ? 'ok' : 'bad'}` },
    h('span', { class: 'svc-dot' }), h('strong', {}, label), h('span', { class: 'muted small' }, x.ok ? `${okText} (${x.ms} ms)` : 'não respondeu'));
  const b = d.backups;
  const backupBox = !b.available
    ? h('p', { class: 'muted' }, 'A pasta dos backups não está ligada ao app (veja docs/administracao.md).')
    : !b.last ? h('div', { class: 'admin-alert' }, '⚠️ Nenhum backup encontrado.')
      : h('div', {},
        h('div', { class: b.old ? 'admin-alert' : 'svc ok' },
          b.old ? `⚠️ O último backup tem ${Math.round(b.ageHours)} horas. O job "nexo-backup" do Jenkins pode estar parado.` : [h('span', { class: 'svc-dot' }), h('strong', {}, 'Backup em dia'), h('span', { class: 'muted small' }, ` último há ${b.ageHours < 1 ? 'menos de 1 hora' : `${Math.round(b.ageHours)} h`}`)]),
        h('div', { class: 'muted small' }, `${b.count} backup(s) guardado(s). Último: ${new Date(b.last.at).toLocaleString('pt-BR')} (${formatSize(b.last.size)}).`));
  page.replaceChildren(
    h('h2', {}, 'Saúde do Nexo'),
    h('p', { class: 'muted small' }, 'Atualiza sozinho a cada 15 segundos.'),
    h('div', { class: 'stat-tiles' },
      h('div', { class: 'stat-tile' }, h('span', { class: 'muted small' }, 'Nexo no ar há'), h('strong', {}, dur(d.app.uptimeSeconds))),
      h('div', { class: 'stat-tile' }, h('span', { class: 'muted small' }, 'Versão'), h('strong', {}, d.app.version)),
      h('div', { class: 'stat-tile' }, h('span', { class: 'muted small' }, 'VM ligada há'), h('strong', {}, dur(d.system.uptimeSeconds))),
      h('div', { class: 'stat-tile' }, h('span', { class: 'muted small' }, 'Quedas (últimas 10 vezes)'), h('strong', {}, String(d.crashes)))),
    block('Serviços',
      h('div', { class: 'svcs' }, svc('Banco de dados', d.services.database, 'ok'), svc('Servidor de voz (LiveKit)', d.services.voice, 'ok'))),
    block('Máquina (VM)',
      meter('CPU', d.system.cpuPercent, `${d.system.cpus} núcleo(s) • carga: ${d.system.load.join(' / ')}`),
      meter('Memória', d.system.memPercent, `${formatSize(d.system.memTotal - d.system.memFree)} de ${formatSize(d.system.memTotal)} • o app usa ${formatSize(d.app.memoryBytes)}`)),
    block('Backup', backupBox),
    block('Reinícios e quedas',
      h('p', { class: 'muted small' }, '"Atualização/reinício" = o Nexo foi desligado direitinho (deploy, reinício). "Queda" = desligou de repente (falta de luz, VM travou).'),
      h('div', { class: 'runs' }, d.restarts.map((r) => h('div', { class: `run${r.previousClean === false ? ' crash' : ''}` },
        h('span', {}, new Date(r.startedAt).toLocaleString('pt-BR')),
        h('span', { class: 'muted small' }, `v${r.version}`),
        h('span', {}, r.current ? '🟢 agora' : ''),
        h('span', { class: 'small' }, r.previousClean === null ? 'primeira vez' : r.previousClean ? '🔄 atualização/reinício' : '⚠️ queda'),
        h('span', { class: 'muted small' }, r.downSeconds != null ? `fora do ar: ${dur(r.downSeconds)}` : ''))))));
}

// ---------------------------------------------------------------- Contas

function pageUsers() {
  const search = h('input', { type: 'search', placeholder: 'Buscar por nome ou usuário', value: ui.q, class: 'admin-search' });
  const list = h('div', { class: 'admin-users' }, h('p', { class: 'muted' }, 'Carregando…'));
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { ui.q = search.value.trim(); load(); }, 250); });
  const load = () => api(`/admin/users?q=${encodeURIComponent(ui.q)}`).then(({ users, hasMore }) => {
    list.replaceChildren(...[...users.map(userRow), hasMore ? h('p', { class: 'muted small' }, 'Mostrando as 50 primeiras. Use a busca.') : null].filter(Boolean));
    if (!users.length) list.replaceChildren(h('p', { class: 'muted' }, 'Ninguém encontrado.'));
  }).catch((err) => toast(err.message));
  load();
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Contas'),
    h('p', { class: 'muted' }, 'Todas as contas do Nexo. Bloquear tira a pessoa de todos os aparelhos e impede de entrar de novo.'),
    search, list);
}

function userRow(u) {
  const tags = [
    u.isAdmin ? h('span', { class: 'tag admin' }, '🛡️ Admin') : null,
    u.isBot ? h('span', { class: 'tag' }, `🤖 Bot${u.botOwner ? ` de @${u.botOwner}` : ''}`) : null,
    u.blockedAt ? h('span', { class: 'tag blocked', title: u.blockedReason || '' }, `⛔ Bloqueada${u.blockedReason ? `: ${u.blockedReason}` : ''}`) : null,
    u.twoFactor ? h('span', { class: 'tag' }, '🔐 2FA') : null,
    u.hasRecoveryKey ? h('span', { class: 'tag' }, '🔑 Chave') : null,
  ].filter(Boolean);
  const isMe = u.id === state.me.id;
  const actions = [];
  if (!u.isBot) actions.push(h('button', { class: 'btn small', onclick: () => resetCode(u) }, 'Código p/ senha nova'));
  if (!isMe && !u.isAdmin) {
    actions.push(u.blockedAt
      ? h('button', { class: 'btn small', onclick: () => act(api(`/admin/users/${u.id}/block`, { method: 'DELETE' }), 'Conta desbloqueada.') }, 'Desbloquear')
      : h('button', { class: 'btn small danger-ghost', onclick: () => blockDialog(u) }, 'Bloquear'));
  }
  if (!u.isBot && !u.blockedAt && !isMe) {
    actions.push(h('button', {
      class: 'btn small',
      onclick: () => confirmDialog({
        title: u.isAdmin ? `Tirar a administração de ${u.displayName}?` : `Tornar ${u.displayName} administrador(a) do Nexo?`,
        text: u.isAdmin ? 'A pessoa deixa de ver este painel.' : 'A pessoa vai poder ver todas as contas, bloquear e mexer no disco.',
        okLabel: u.isAdmin ? 'Tirar' : 'Tornar admin', danger: !u.isAdmin,
        onConfirm: () => act(api(`/admin/users/${u.id}/admin`, { method: 'PUT', body: { admin: !u.isAdmin } }), 'Feito.'),
      }),
    }, u.isAdmin ? 'Tirar admin' : 'Tornar admin'));
  }
  return h('div', { class: `admin-user${u.blockedAt ? ' blocked' : ''}` },
    avatar(u, { size: 'sm', online: u.online ? 'online' : 'offline' }),
    h('div', { class: 'admin-user-info' },
      h('div', {}, h('strong', {}, u.displayName), ' ', h('span', { class: 'muted' }, `@${u.username}`), ' ', ...tags),
      h('div', { class: 'muted small' },
        `Desde ${new Date(u.createdAt).toLocaleDateString('pt-BR')} • visto ${u.online ? 'agora (online)' : ago(u.lastSeenAt)} • ${u.servers} servidor(es) • ${u.messages} mensagem(ns) • ${formatSize(u.bytes)} em anexos`)),
    h('div', { class: 'admin-user-actions' }, actions));
}

async function act(promise, msg) {
  try { await promise; toast(msg); if (ui) render(); } catch (err) { toast(err.message); }
}

function blockDialog(u) {
  const reason = h('input', { maxlength: '200', placeholder: 'Ex.: spam, ofensas… (a pessoa vê ao tentar entrar)' });
  openDialog({
    title: `Bloquear ${u.displayName} (@${u.username})?`,
    text: 'A pessoa sai de todos os aparelhos e não consegue mais entrar. As mensagens dela continuam. Dá para desbloquear depois.',
    body: h('label', { class: 'field' }, 'Motivo (opcional)', reason),
    actions: [
      { label: 'Cancelar' },
      { label: 'Bloquear', kind: 'danger', submit: true, onClick: () => act(api(`/admin/users/${u.id}/block`, { method: 'POST', body: { reason: reason.value } }), 'Conta bloqueada.') },
    ],
  });
}

async function resetCode(u) {
  let r;
  try { r = await api(`/admin/users/${u.id}/reset-code`, { method: 'POST' }); } catch (err) { return toast(err.message); }
  const text = `Para criar uma senha nova no Nexo: na tela de entrar, clique em "Esqueci a senha", use o usuário ${r.username} e o código ${r.code} (vale 24 horas, uma vez).`;
  openDialog({
    title: `🔑 Código para @${r.username}`,
    text: 'Passe este código para a pessoa por um lugar seguro (ex.: mensagem direta no WhatsApp). Ele aparece só agora.',
    body: h('div', {}, h('div', { class: 'recovery-codes' }, h('code', { class: 'big-key' }, r.code)), h('p', { class: 'muted small' }, text)),
    actions: [
      { label: 'Copiar mensagem', onClick: async () => { await copyText(text); toast('Mensagem copiada.'); return false; } },
      { label: 'Pronto', kind: 'primary', submit: true },
    ],
  });
}
