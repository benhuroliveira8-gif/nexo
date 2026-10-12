// Configurações do servidor: visão geral (nome e ícone), cargos, membros (moderação),
// convites, banimentos e registro de auditoria.
import {
  h, api, avatar, toast, openDialog, confirmDialog, openMenu, presenceOf, uploadAvatar, fullTime, copyText, getToken,
} from './util.js';
import { state, P, PERMISSION_INFO, can, isOwner, myTop, memberRoles, memberTop } from './state.js';
import { sortable } from './sortable.js';
import { renderAssets, renderWelcome, renderAutomod, renderStats, canSeeStats } from './serverx.js';
import { renderLevels } from './levelsui.js';

const PRESET_COLORS = ['#ff7a45', '#f5c542', '#3ecf8e', '#2ec4b6', '#4d9fff', '#7c6cff', '#c86bfa', '#ff5c8a', '#ff5c6c', '#a7adbb'];

let ui = null; // { root, tab, roleId, draft, dirty, filter, cache }

export function closeServerSettings() {
  if (!ui) return;
  ui.root.remove();
  document.removeEventListener('keydown', onKey);
  ui = null;
}

function onKey(e) {
  if (e.key === 'Escape' && ui && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) closeServerSettings();
}

export function openServerSettings(tab = 'overview') {
  closeServerSettings();
  const root = h('div', { class: 'settings-overlay', role: 'dialog', 'aria-modal': 'true' });
  document.body.append(root);
  ui = { root, tab, roleId: null, draft: null, dirty: false, filter: '', cache: {} };
  document.addEventListener('keydown', onKey);
  render();
}

// Chamado quando os detalhes do servidor mudam (outra pessoa mexeu, por exemplo).
export function refreshSettings() {
  if (!ui) return;
  if (!state.detail) return closeServerSettings();
  render();
}

const isAdmin = () => isOwner() || (state.detail.me.permissions & P.ADMINISTRATOR) !== 0;
const canGrant = (flag) => isAdmin() || (state.detail.me.permissions & flag) === flag;
const roleManageable = (role) => can(P.MANAGE_ROLES) && (role.isDefault || role.position < myTop());
const memberManageable = (m) => m.id === state.me.id || isOwner() || memberTop(m) < myTop();
const canModerate = (m) => m.id !== state.me.id && m.id !== state.detail.server.ownerId && memberTop(m) < myTop();

function tabsAvailable() {
  const tabs = [['overview', 'Visão geral']];
  if (can(P.MANAGE_ROLES)) tabs.push(['roles', 'Cargos']);
  if (can(P.MANAGE_ROLES) || can(P.KICK_MEMBERS) || can(P.BAN_MEMBERS) || can(P.MODERATE_MEMBERS)) tabs.push(['members', 'Membros']);
  if (can(P.MANAGE_EMOJIS)) tabs.push(['emojis', 'Emojis'], ['stickers', 'Figurinhas'], ['sounds', 'Sons']);
  if (can(P.MANAGE_SERVER)) tabs.push(['welcome', 'Boas-vindas'], ['automod', 'Moderação automática'], ['levels', 'Níveis']);
  if (canSeeStats()) tabs.push(['stats', 'Estatísticas']);
  if (can(P.CREATE_INVITE)) tabs.push(['invites', 'Convites']);
  if (can(P.BAN_MEMBERS)) tabs.push(['bans', 'Banimentos']);
  if (can(P.VIEW_AUDIT_LOG)) tabs.push(['audit', 'Registro de auditoria']);
  return tabs;
}

function render() {
  const d = state.detail;
  const tabs = tabsAvailable();
  if (!tabs.some(([k]) => k === ui.tab)) ui.tab = 'overview';

  const nav = h('nav', { class: 'settings-nav' },
    h('div', { class: 'settings-server truncate' }, d.server.name),
    tabs.map(([key, label]) => h('button', {
      class: `settings-tab${ui.tab === key ? ' active' : ''}`,
      onclick: () => { ui.tab = key; render(); },
    }, label)));

  const pages = {
    emojis: renderEmojis, roles: renderRoles, members: renderMembersTab, invites: renderInvites, bans: renderBans, audit: renderAudit, overview: renderOverview,
    stickers: () => renderAssets('sticker'), sounds: () => renderAssets('sound'), welcome: renderWelcome, automod: renderAutomod, levels: renderLevels,
    stats: () => renderStats({ cache: ui.cache, rerender: render }),
  };
  const content = (pages[ui.tab] || renderOverview)();

  ui.root.replaceChildren(h('div', { class: 'settings' },
    nav,
    h('div', { class: 'settings-content' }, content),
    h('button', { class: 'settings-close', title: 'Fechar (Esc)', onclick: closeServerSettings }, '✕')));
  if (ui.afterRender) { const fn = ui.afterRender; ui.afterRender = null; fn(); }
}

export function serverIcon(server, size = '') {
  const el = h('div', { class: `server-icon ${size}` });
  if (server.iconUrl) el.append(h('img', { src: server.iconUrl, alt: '', draggable: 'false' }));
  else el.append(String(server.name || '?').trim().split(/\s+/).slice(0, 2).map((p) => [...p][0]).join('').toUpperCase());
  return el;
}

// ---------------------------------------------------------------- Visão geral

function renderOverview() {
  const d = state.detail;
  const manage = can(P.MANAGE_SERVER);
  const name = h('input', { value: d.server.name, maxlength: '100', disabled: !manage });
  const pickIcon = () => {
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      try { toast('Enviando ícone…'); await uploadAvatar(file, `/api/servers/${d.server.id}/icon`); toast('Ícone atualizado!'); } catch (err) { toast(err.message); }
    });
    picker.click();
  };
  const parts = [
    h('h2', {}, 'Visão geral'),
    h('div', { class: 'icon-editor' },
      h('button', { class: 'icon-preview', disabled: !manage, title: manage ? 'Trocar ícone' : null, onclick: pickIcon }, serverIcon(d.server, 'xl'), manage ? h('span', { class: 'avatar-edit' }, '✏️') : null),
      h('div', { class: 'icon-text' },
        h('strong', {}, 'Ícone do servidor'),
        h('span', { class: 'muted small' }, 'Aparece na barra da esquerda. Use uma imagem quadrada (mínimo 128×128).'),
        manage ? h('div', { class: 'row-actions' },
          h('button', { class: 'btn small', onclick: pickIcon }, 'Enviar imagem'),
          d.server.iconUrl ? h('button', {
            class: 'btn small danger-ghost',
            onclick: async () => { try { await api(`/servers/${d.server.id}/icon`, { method: 'DELETE' }); } catch (err) { toast(err.message); } },
          }, 'Remover') : null) : null)),
    h('label', { class: 'field' }, 'Nome do servidor', name),
  ];
  if (manage) {
    parts.push(h('button', {
      class: 'btn primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(`/servers/${d.server.id}`, { method: 'PATCH', body: { name: name.value.trim() } });
          toast('Nome salvo!');
        } catch (err) { toast(err.message); } finally { e.currentTarget.disabled = false; }
      },
    }, 'Salvar nome'));
  }

  if (isOwner()) {
    parts.push(h('div', { class: 'settings-block danger-zone' },
      h('h3', {}, 'Zona de perigo'),
      h('p', { class: 'muted' }, 'Apagar o servidor remove todos os canais, mensagens e arquivos. Não dá para desfazer.'),
      h('button', { class: 'btn danger', onclick: deleteServerDialog }, 'Apagar servidor')));
  }
  return h('div', { class: 'settings-page' }, parts);
}

function deleteServerDialog() {
  const d = state.detail;
  const input = h('input', { placeholder: d.server.name });
  openDialog({
    title: `Apagar ${d.server.name}`,
    text: 'Para confirmar, digite o nome do servidor.',
    body: input,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Apagar para sempre', kind: 'danger', submit: true,
        onClick: async () => {
          if (input.value.trim() !== d.server.name) throw new Error('O nome não confere.');
          await api(`/servers/${d.server.id}`, { method: 'DELETE' });
          closeServerSettings();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Cargos

function selectRole(role) {
  ui.roleId = role.id;
  ui.draft = { name: role.name, color: role.color, permissions: role.permissions };
  ui.dirty = false;
}

function renderRoles() {
  const d = state.detail;
  const roles = [...d.roles].sort((a, b) => b.position - a.position);
  let role = roles.find((r) => r.id === ui.roleId);
  if (!role) {
    role = roles.find((r) => !r.isDefault && roleManageable(r)) || roles.find((r) => r.isDefault);
    selectRole(role);
  } else if (!ui.dirty) {
    selectRole(role); // recarrega do servidor se o usuário não estava editando
  }
  const counts = new Map();
  d.members.forEach((m) => m.roleIds.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1)));

  const list = h('div', { class: 'role-list' },
    h('button', {
      class: 'btn primary small', onclick: async () => {
        try {
          const { role: created } = await api(`/servers/${d.server.id}/roles`, { method: 'POST', body: { name: 'novo cargo' } });
          ui.roleId = created.id;
          ui.dirty = false;
        } catch (err) { toast(err.message); }
      },
    }, '+ Criar cargo'),
    roles.map((r) => h('button', {
      class: `role-item${r.id === role.id ? ' active' : ''}${!r.isDefault && roleManageable(r) ? ' draggable' : ''}`,
      dataset: r.isDefault ? { roleId: String(r.id) } : { roleId: String(r.id), dragId: roleManageable(r) ? String(r.id) : '' },
      onclick: () => {
        if (ui.dirty && r.id !== role.id && !window.confirm('Descartar as alterações não salvas?')) return;
        selectRole(r);
        render();
      },
    },
    !r.isDefault && roleManageable(r) ? h('span', { class: 'drag-grip', 'aria-hidden': 'true' }, '⠿') : null,
    h('i', { class: 'role-dot', style: `background:${r.color || 'var(--text-3)'}` }),
    h('span', { class: 'truncate' }, r.name),
    h('span', { class: 'muted small' }, r.isDefault ? 'todos' : String(counts.get(r.id) || 0)))),
    h('p', { class: 'muted small role-hint' }, 'Arraste os cargos para mudar a ordem (no celular, segure e arraste).'));

  // Arrastar para reordenar: só cargos abaixo do seu, e não dá para passar do @everyone.
  sortable(list, {
    handle: '.role-item.draggable',
    targets: '.role-item',
    canDrop: (dragEl, target, before) => {
      const t = d.roles.find((x) => String(x.id) === target.dataset.roleId);
      if (!t) return false;
      if (t.isDefault) return before; // só acima do @everyone
      const newPos = before ? t.position + 1 : t.position;
      return newPos < myTop() || isOwner();
    },
    onDrop: async (dragEl, target, before) => {
      const ids = roles.filter((r) => !r.isDefault).map((r) => r.id);
      const moving = Number(dragEl.dataset.roleId);
      const targetId = Number(target.dataset.roleId);
      const from = ids.indexOf(moving);
      ids.splice(from, 1);
      const tRole = d.roles.find((x) => x.id === targetId);
      let at = tRole.isDefault ? ids.length : ids.indexOf(targetId) + (before ? 0 : 1);
      if (at < 0) at = ids.length;
      ids.splice(at, 0, moving);
      try { await api(`/servers/${d.server.id}/roles/order`, { method: 'PUT', body: { roleIds: ids } }); } catch (err) { toast(err.message); }
    },
  });

  return h('div', { class: 'settings-page roles-page' },
    h('h2', {}, 'Cargos'),
    h('p', { class: 'muted' }, 'Cargos dão permissões e cor ao nome. Quem está mais alto na lista manda em quem está abaixo.'),
    h('div', { class: 'roles-layout' }, list, roleEditor(role)));
}

function roleEditor(role) {
  const d = state.detail;
  const editable = roleManageable(role);
  const draft = ui.draft;
  const mark = () => { ui.dirty = true; saveBtn.disabled = false; };

  const name = h('input', {
    value: draft.name, maxlength: '32', disabled: !editable || role.isDefault,
    oninput: (e) => { draft.name = e.target.value; mark(); },
  });

  const swatches = h('div', { class: 'swatches' },
    h('button', {
      class: `swatch none${!draft.color ? ' active' : ''}`, title: 'Sem cor', disabled: !editable || role.isDefault,
      onclick: () => { draft.color = null; mark(); render(); },
    }, '∅'),
    PRESET_COLORS.map((c) => h('button', {
      class: `swatch${draft.color === c ? ' active' : ''}`, style: `background:${c}`, title: c, disabled: !editable || role.isDefault,
      onclick: () => { draft.color = c; mark(); render(); },
    })),
    h('input', {
      type: 'color', class: 'swatch-custom', title: 'Outra cor', value: draft.color || '#ff7a45', disabled: !editable || role.isDefault,
      onchange: (e) => { draft.color = e.target.value; mark(); render(); },
    }));

  const perms = h('div', { class: 'perm-list' }, PERMISSION_INFO.map(([flag, label, desc]) => {
    const on = (draft.permissions & flag) === flag;
    const allowed = editable && canGrant(flag);
    return h('label', { class: `perm${allowed ? '' : ' locked'}` },
      h('div', { class: 'perm-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)),
      h('input', {
        type: 'checkbox', class: 'switch', checked: on, disabled: !allowed,
        onchange: (e) => { draft.permissions = e.target.checked ? draft.permissions | flag : draft.permissions & ~flag; mark(); },
      }));
  }));

  const saveBtn = h('button', {
    class: 'btn primary', disabled: !ui.dirty,
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      const body = { permissions: draft.permissions };
      if (!role.isDefault) { body.name = draft.name.trim(); body.color = draft.color; }
      try {
        await api(`/servers/${d.server.id}/roles/${role.id}`, { method: 'PATCH', body });
        ui.dirty = false;
        toast('Cargo salvo!');
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    },
  }, 'Salvar alterações');

  const move = (dir) => async () => {
    try { await api(`/servers/${d.server.id}/roles/${role.id}`, { method: 'PATCH', body: { move: dir } }); } catch (err) { toast(err.message); }
  };

  return h('div', { class: 'role-editor' },
    !editable ? h('div', { class: 'notice' }, 'Este cargo está acima (ou no mesmo nível) do seu cargo mais alto, então você não pode editá-lo.') : null,
    role.isDefault ? h('div', { class: 'notice soft' }, 'O @everyone vale para todo mundo do servidor. Aqui você define o que qualquer membro pode fazer.') : null,
    h('label', { class: 'field' }, 'Nome do cargo', name),
    h('div', { class: 'field' }, h('span', {}, 'Cor do nome'), swatches),
    h('div', { class: 'field' }, h('span', {}, 'Permissões'), perms),
    h('div', { class: 'role-actions' },
      !role.isDefault && editable ? [
        h('button', { class: 'btn small', title: 'Subir na hierarquia', onclick: move('up') }, '↑ Subir'),
        h('button', { class: 'btn small', title: 'Descer na hierarquia', onclick: move('down') }, '↓ Descer'),
        h('button', {
          class: 'btn small danger-ghost', onclick: () => confirmDialog({
            title: `Apagar o cargo ${role.name}`,
            text: 'Quem tem esse cargo perde as permissões dele.',
            okLabel: 'Apagar cargo',
            onConfirm: async () => { await api(`/servers/${d.server.id}/roles/${role.id}`, { method: 'DELETE' }); ui.roleId = null; ui.dirty = false; },
          }),
        }, 'Apagar'),
      ] : null,
      h('span', { class: 'spacer' }),
      editable ? saveBtn : null));
}

// ---------------------------------------------------------------- Moderação (também usada pelo perfil)

const TIMEOUTS = [[1, '1 minuto'], [5, '5 minutos'], [10, '10 minutos'], [60, '1 hora'], [24 * 60, '1 dia'], [7 * 24 * 60, '1 semana']];

export function timeoutMenu(anchor, member) {
  const d = state.detail;
  const set = async (minutes) => {
    try {
      await api(`/servers/${d.server.id}/members/${member.id}/timeout`, { method: 'PUT', body: { minutes } });
      toast(minutes ? `${member.displayName} está de castigo.` : `${member.displayName} saiu do castigo.`);
    } catch (err) { toast(err.message); }
  };
  openMenu(anchor, [
    ...(member.timeoutUntil ? [{ label: '✅  Tirar o castigo', onClick: () => set(0) }, { separator: true }] : []),
    ...TIMEOUTS.map(([m, label]) => ({ label: `⏳  ${label}`, onClick: () => set(m) })),
  ], { className: 'popover-menu' });
}

export function kickDialog(member) {
  confirmDialog({
    title: `Expulsar ${member.displayName}`,
    text: `${member.displayName} vai sair do servidor, mas pode voltar se receber um convite.`,
    okLabel: 'Expulsar',
    onConfirm: () => api(`/servers/${state.detail.server.id}/members/${member.id}`, { method: 'DELETE' }),
  });
}

export function banDialog(member) {
  const reason = h('input', { maxlength: '300', placeholder: 'Motivo (opcional, aparece no registro)' });
  const del = h('select', { class: 'select' },
    h('option', { value: '0' }, 'Não apagar nada'),
    h('option', { value: '1' }, 'Da última hora'),
    h('option', { value: '24' }, 'Das últimas 24 horas'),
    h('option', { value: '168' }, 'Dos últimos 7 dias'));
  openDialog({
    title: `Banir ${member.displayName}`,
    text: `${member.displayName} sai do servidor e não consegue voltar, nem com convite (até alguém tirar o ban).`,
    body: h('div', { class: 'stack' }, reason, h('label', { class: 'field' }, 'Apagar mensagens recentes', del)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Banir', kind: 'danger', submit: true,
        onClick: async () => {
          await api(`/servers/${state.detail.server.id}/bans/${member.id}`, { method: 'PUT', body: { reason: reason.value, deleteMessagesHours: Number(del.value) } });
          toast(`${member.displayName} foi banido.`);
        },
      },
    ],
  });
}

// Ações de moderação disponíveis para um membro (para menus).
export function moderationItems(member) {
  if (!state.detail || !canModerate(member)) return [];
  const items = [];
  if (can(P.MODERATE_MEMBERS)) items.push({ label: member.timeoutUntil ? '⏳  Castigo…' : '⏳  Castigar…', onClick: () => timeoutMenu(document.activeElement || document.body, member) });
  if (can(P.KICK_MEMBERS)) items.push({ label: '👢  Expulsar', danger: true, onClick: () => kickDialog(member) });
  if (can(P.BAN_MEMBERS)) items.push({ label: '🔨  Banir', danger: true, onClick: () => banDialog(member) });
  return items;
}

const untilText = (iso) => `até ${fullTime(new Date(iso)).replace(/^Hoje às /, 'hoje às ').replace(/^Ontem às /, 'ontem às ')}`;

// ---------------------------------------------------------------- Membros

function renderMembersTab() {
  const d = state.detail;
  const q = ui.filter.toLowerCase();
  const members = d.members.filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.username.includes(q));
  const search = h('input', {
    placeholder: 'Procurar membro', value: ui.filter,
    oninput: (e) => {
      ui.filter = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const again = ui.root.querySelector('.members-search');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    },
  });
  search.classList.add('members-search');

  const assignable = d.roles.filter((r) => !r.isDefault && roleManageable(r)).sort((a, b) => b.position - a.position);

  const setRoles = async (m, roleIds) => {
    try { await api(`/servers/${d.server.id}/members/${m.id}/roles`, { method: 'PUT', body: { roleIds } }); } catch (err) { toast(err.message); }
  };

  const rows = members.map((m) => {
    const isServerOwner = m.id === d.server.ownerId;
    const manageable = can(P.MANAGE_ROLES) && memberManageable(m);
    const roles = memberRoles(m);
    const missing = assignable.filter((r) => !m.roleIds.includes(r.id));
    const mod = canModerate(m) && (can(P.KICK_MEMBERS) || can(P.BAN_MEMBERS) || can(P.MODERATE_MEMBERS));
    return h('div', { class: 'member-row' },
      avatar(m, { online: m.online ? presenceOf(m) : 'offline' }),
      h('div', { class: 'member-text' },
        h('strong', { class: 'truncate' }, m.displayName, isServerOwner ? ' 👑' : ''),
        h('span', { class: 'muted small truncate' }, `@${m.username}`),
        m.timeoutUntil ? h('span', { class: 'timeout-tag' }, `⏳ castigo ${untilText(m.timeoutUntil)}`) : null),
      h('div', { class: 'role-chips' },
        roles.map((r) => h('span', { class: 'role-chip' },
          h('i', { style: `background:${r.color || 'var(--text-3)'}` }), r.name,
          manageable && roleManageable(r) ? h('button', {
            class: 'chip-x', title: `Tirar ${r.name}`,
            onclick: () => setRoles(m, m.roleIds.filter((id) => id !== r.id)),
          }, '✕') : null)),
        manageable && missing.length ? h('button', {
          class: 'chip-add', title: 'Dar cargo',
          onclick: (e) => openMenu(e.currentTarget, missing.map((r) => ({ label: r.name, onClick: () => setRoles(m, [...m.roleIds, r.id]) }))),
        }, '+') : null),
      mod ? h('button', {
        class: 'btn small', title: 'Moderar',
        onclick: (e) => {
          const anchor = e.currentTarget;
          openMenu(anchor, [
            can(P.MODERATE_MEMBERS) ? { label: m.timeoutUntil ? '⏳  Castigo…' : '⏳  Castigar…', onClick: () => timeoutMenu(anchor, m) } : null,
            can(P.KICK_MEMBERS) ? { label: '👢  Expulsar', danger: true, onClick: () => kickDialog(m) } : null,
            can(P.BAN_MEMBERS) ? { label: '🔨  Banir', danger: true, onClick: () => banDialog(m) } : null,
          ], { align: 'end', className: 'popover-menu' });
        },
      }, 'Moderar ▾') : h('span', { class: 'kick-placeholder' }));
  });

  return h('div', { class: 'settings-page' },
    h('h2', {}, `Membros — ${d.members.length}`),
    search,
    h('div', { class: 'member-rows' }, rows.length ? rows : h('p', { class: 'muted' }, 'Ninguém encontrado.')));
}

// ---------------------------------------------------------------- Emojis

const EMOJI_MAX = 50;
const emojiNameFrom = (filename) => String(filename || '').replace(/\.[^.]+$/, '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'emoji';

// Reduz para no máximo 128x128 (GIF vai como está, para continuar animado).
async function prepareEmoji(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(`${file.name}: use PNG, JPG, GIF ou WEBP.`);
  if (file.type === 'image/gif') {
    if (file.size > 256 * 1024) throw new Error(`${file.name}: GIF animado pode ter no máximo 256 KB.`);
    return file;
  }
  const bmp = await createImageBitmap(file).catch(() => { throw new Error(`${file.name}: não deu para abrir a imagem.`); });
  const scale = Math.min(1, 128 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const toBlob = (t, q) => new Promise((r) => canvas.toBlob(r, t, q));
  let blob = await toBlob('image/webp', 0.92);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/png');
  return blob;
}

async function uploadEmoji(serverId, file, name) {
  const body = await prepareEmoji(file);
  const res = await fetch(`/api/servers/${serverId}/emojis`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream', 'X-Emoji-Name': encodeURIComponent(name) },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data.emoji;
}

function renderEmojis() {
  const d = state.detail;
  const list = d.emojis || [];
  const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
  picker.addEventListener('change', async () => {
    const chosen = [...picker.files];
    picker.value = '';
    let ok = 0;
    for (const f of chosen.slice(0, EMOJI_MAX - list.length)) {
      try { await uploadEmoji(d.server.id, f, emojiNameFrom(f.name)); ok++; } catch (err) { toast(err.message); }
    }
    if (ok) toast(ok === 1 ? 'Emoji adicionado!' : `${ok} emojis adicionados!`);
  });
  const rename = async (e, input) => {
    const name = input.value.trim().toLowerCase().replace(/:/g, '');
    if (name === e.name) return;
    try { await api(`/servers/${d.server.id}/emojis/${e.id}`, { method: 'PATCH', body: { name } }); toast('Nome salvo!'); } catch (err) { toast(err.message); input.value = e.name; }
  };
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Emojis'),
    h('p', { class: 'muted' }, `Emojis próprios do servidor (até ${EMOJI_MAX}). Para usar, escreva :nome: na mensagem ou escolha no 😊. Também servem como reação. Quem está no servidor pode usá-los nas DMs.`),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary small', disabled: list.length >= EMOJI_MAX, onclick: () => picker.click() }, '+ Enviar emoji'),
      h('span', { class: 'muted small' }, `${list.length} de ${EMOJI_MAX} · PNG, JPG, WEBP ou GIF (até 256 KB). Imagens quadradas ficam melhores.`),
      picker),
    list.length === 0
      ? h('div', { class: 'empty-state' }, h('div', { class: 'empty-art' }, '😺'), h('p', { class: 'muted' }, 'Nenhum emoji ainda. Envie uma imagem para começar!'))
      : h('div', { class: 'emoji-admin' }, list.map((e) => {
        const input = h('input', { value: e.name, maxlength: '32', 'aria-label': 'Nome do emoji' });
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
        input.addEventListener('blur', () => rename(e, input));
        return h('div', { class: 'emoji-admin-row' },
          h('img', { class: 'emoji-admin-img', src: e.url, alt: '' }),
          h('span', { class: 'emoji-colon' }, ':'), input, h('span', { class: 'emoji-colon' }, ':'),
          e.animated ? h('span', { class: 'muted small' }, 'animado') : null,
          h('button', {
            class: 'icon-btn small', title: 'Apagar emoji',
            onclick: () => confirmDialog({
              title: `Apagar :${e.name}:?`,
              text: 'Nas mensagens antigas ele vai aparecer só como texto.',
              okLabel: 'Apagar',
              onConfirm: () => api(`/servers/${d.server.id}/emojis/${e.id}`, { method: 'DELETE' }),
            }),
          }, '🗑️'));
      })));
}

// ---------------------------------------------------------------- Convites

const AGES = [[1800, '30 minutos'], [3600, '1 hora'], [6 * 3600, '6 horas'], [12 * 3600, '12 horas'], [86400, '1 dia'], [7 * 86400, '7 dias'], [0, 'Nunca']];
const USES = [[0, 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [50, '50 usos'], [100, '100 usos']];

export function inviteSummary(inv) {
  const parts = [];
  parts.push(inv.expiresAt ? `expira ${fullTime(new Date(inv.expiresAt)).replace(/^Hoje às /, 'hoje às ').replace(/^Ontem/, 'ontem')}` : 'nunca expira');
  parts.push(inv.maxUses ? `${inv.uses}/${inv.maxUses} usos` : `${inv.uses} ${inv.uses === 1 ? 'uso' : 'usos'}`);
  return parts.join(' · ');
}

// Janela "Convidar pessoas": cria (ou reaproveita) um link de 7 dias; dá para mudar as opções.
export async function inviteDialog() {
  const d = state.detail;
  let inv;
  try {
    ({ invite: inv } = await api(`/servers/${d.server.id}/invites`, { method: 'POST', body: { reuse: true, maxAgeSeconds: 7 * 86400, maxUses: 0 } }));
  } catch (err) { return toast(err.message); }
  const field = h('input', { value: `${location.origin}/convite/${inv.code}`, readonly: true });
  const info = h('p', { class: 'muted small' }, inviteSummary(inv));
  const age = h('select', { class: 'select' }, AGES.map(([v, l]) => h('option', { value: String(v), selected: v === 7 * 86400 }, l)));
  const uses = h('select', { class: 'select' }, USES.map(([v, l]) => h('option', { value: String(v) }, l)));
  const options = h('div', { class: 'invite-options', hidden: true },
    h('label', { class: 'field' }, 'Expira depois de', age),
    h('label', { class: 'field' }, 'Número máximo de usos', uses),
    h('button', {
      type: 'button', class: 'btn small primary',
      onclick: async () => {
        try {
          const { invite } = await api(`/servers/${d.server.id}/invites`, { method: 'POST', body: { maxAgeSeconds: Number(age.value), maxUses: Number(uses.value) } });
          field.value = `${location.origin}/convite/${invite.code}`;
          info.textContent = inviteSummary(invite);
          options.hidden = true;
          toast('Link novo criado!');
        } catch (err) { toast(err.message); }
      },
    }, 'Gerar link novo'));
  openDialog({
    title: `Convide amigos para ${d.server.name}`,
    text: 'Quem abrir o link (ou colar no botão ↪) entra no servidor.',
    body: h('div', {}, field, info,
      h('button', { type: 'button', class: 'link small', onclick: () => { options.hidden = !options.hidden; } }, '⚙️ Mudar validade e limite de usos'),
      options),
    actions: [
      { label: 'Fechar' },
      {
        label: 'Copiar link', kind: 'primary', submit: true,
        onClick: async () => {
          if (await copyText(field.value, field)) toast('Link copiado!');
          else throw new Error('Não deu para copiar automaticamente. Selecione e copie com Ctrl+C.');
        },
      },
    ],
  });
}

function renderInvites() {
  const d = state.detail;
  const page = h('div', { class: 'settings-page' },
    h('h2', {}, 'Convites'),
    h('p', { class: 'muted' }, can(P.MANAGE_SERVER) ? 'Todos os convites que ainda valem. Apagar um convite faz o link parar de funcionar.' : 'Os seus convites que ainda valem.'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary small', onclick: () => inviteDialog() }, '+ Criar convite')));
  const list = h('div', { class: 'invite-list' }, h('p', { class: 'muted' }, 'Carregando…'));
  page.append(list);
  api(`/servers/${d.server.id}/invites`).then(({ invites }) => {
    if (!ui || ui.tab !== 'invites') return;
    if (!invites.length) return list.replaceChildren(h('p', { class: 'muted' }, 'Nenhum convite ativo.'));
    list.replaceChildren(...invites.map((inv) => h('div', { class: 'invite-row' },
      h('div', { class: 'invite-main' },
        h('code', {}, inv.code),
        h('span', { class: 'muted small' }, `${inv.createdBy ? `por ${inv.createdBy.displayName} · ` : ''}${inviteSummary(inv)}`)),
      h('button', {
        class: 'icon-btn small', title: 'Copiar link',
        onclick: async () => { if (await copyText(`${location.origin}/convite/${inv.code}`)) toast('Link copiado!'); },
      }, '📋'),
      (inv.createdBy && inv.createdBy.id === state.me.id) || can(P.MANAGE_SERVER) ? h('button', {
        class: 'btn small danger-ghost',
        onclick: async () => { try { await api(`/invites/${inv.code}`, { method: 'DELETE' }); toast('Convite apagado.'); render(); } catch (err) { toast(err.message); } },
      }, 'Apagar') : null)));
  }).catch((err) => list.replaceChildren(h('p', { class: 'form-error' }, err.message)));
  return page;
}

// ---------------------------------------------------------------- Banimentos

function renderBans() {
  const d = state.detail;
  const list = h('div', { class: 'member-rows' }, h('p', { class: 'muted' }, 'Carregando…'));
  api(`/servers/${d.server.id}/bans`).then(({ bans }) => {
    if (!ui || ui.tab !== 'bans') return;
    if (!bans.length) return list.replaceChildren(h('p', { class: 'muted' }, 'Ninguém banido. 😇'));
    list.replaceChildren(...bans.map((b) => h('div', { class: 'member-row' },
      avatar(b.user),
      h('div', { class: 'member-text wide' },
        h('strong', { class: 'truncate' }, b.user.displayName),
        h('span', { class: 'muted small truncate' }, `@${b.user.username} · ${fullTime(new Date(b.createdAt))}${b.bannedBy ? ` · por ${b.bannedBy}` : ''}`),
        b.reason ? h('span', { class: 'small' }, `Motivo: ${b.reason}`) : null),
      h('button', {
        class: 'btn small',
        onclick: () => confirmDialog({
          title: `Tirar o ban de ${b.user.displayName}?`,
          text: 'A pessoa poderá entrar de novo com um convite.',
          okLabel: 'Tirar ban', danger: false,
          onConfirm: async () => { await api(`/servers/${d.server.id}/bans/${b.user.id}`, { method: 'DELETE' }); render(); },
        }),
      }, 'Tirar ban'))));
  }).catch((err) => list.replaceChildren(h('p', { class: 'form-error' }, err.message)));
  return h('div', { class: 'settings-page' }, h('h2', {}, 'Banimentos'), list);
}

// ---------------------------------------------------------------- Registro de auditoria

const PERM_NAMES = new Map(PERMISSION_INFO.map(([flag, label]) => [flag, label]));
function permDiff(from, to) {
  const added = [];
  const removed = [];
  for (const [flag, label] of PERM_NAMES) {
    if ((to & flag) && !(from & flag)) added.push(label);
    if (!(to & flag) && (from & flag)) removed.push(label);
  }
  return [added.length ? `+ ${added.join(', ')}` : '', removed.length ? `− ${removed.join(', ')}` : ''].filter(Boolean).join('; ');
}
const mins = (m) => (m >= 1440 ? `${Math.round(m / 1440)} dia(s)` : m >= 60 ? `${Math.round(m / 60)} hora(s)` : `${m} min`);

function describe(e) {
  const t = e.targetName ? `"${e.targetName}"` : '';
  const who = e.targetName || 'alguém';
  const x = e.details || {};
  switch (e.action) {
    case 'member_kick': return [`expulsou ${who}`, x.reason ? `Motivo: ${x.reason}` : ''];
    case 'member_ban': return [`baniu ${who}`, [x.reason ? `Motivo: ${x.reason}` : '', x.deletedHours ? 'mensagens recentes apagadas' : ''].filter(Boolean).join(' · ')];
    case 'member_unban': return [`tirou o ban de ${who}`];
    case 'member_timeout': return [`castigou ${who} por ${mins(x.minutes)}`, x.reason ? `Motivo: ${x.reason}` : ''];
    case 'member_timeout_remove': return [`tirou o castigo de ${who}`];
    case 'member_roles': return [`mudou os cargos de ${who}`, [x.added && x.added.length ? `+ ${x.added.join(', ')}` : '', x.removed && x.removed.length ? `− ${x.removed.join(', ')}` : ''].filter(Boolean).join('; ')];
    case 'role_create': return [`criou o cargo ${t}`];
    case 'role_update': return [`editou o cargo ${t}`, [x.name ? `nome: ${x.name.from} → ${x.name.to}` : '', x.permissions ? permDiff(x.permissions.from, x.permissions.to) : '', 'color' in x ? 'cor mudou' : ''].filter(Boolean).join(' · ')];
    case 'role_delete': return [`apagou o cargo ${t}`];
    case 'role_reorder': return ['reordenou os cargos'];
    case 'channel_create': return [`criou o canal ${t}`, x.private ? 'privado' : ''];
    case 'channel_update': return [`editou o canal ${t}`, [x.name ? `nome: ${x.name.from} → ${x.name.to}` : '', 'private' in x ? (x.private ? 'ficou privado' : 'ficou público') : '', 'roles' in x ? 'cargos com acesso mudaram' : ''].filter(Boolean).join(' · ')];
    case 'channel_delete': return [`apagou o canal ${t}`];
    case 'category_create': return [`criou a categoria ${t}`];
    case 'category_update': return [`editou a categoria ${t}`];
    case 'category_delete': return [`apagou a categoria ${t}`];
    case 'server_update': return ['renomeou o servidor', x.from ? `${x.from} → ${x.to}` : ''];
    case 'server_icon': return ['mudou o ícone do servidor'];
    case 'invite_create': return ['criou um convite', [x.code, x.maxUses ? `${x.maxUses} usos` : '', x.maxAgeSeconds ? `vale ${mins(Math.round(x.maxAgeSeconds / 60))}` : 'sem validade'].filter(Boolean).join(' · ')];
    case 'invite_delete': return ['apagou um convite', x.code || ''];
    case 'message_delete': return [`apagou uma mensagem de ${who}`, [x.channel ? `#${x.channel}` : '', x.preview ? `"${x.preview}"` : ''].filter(Boolean).join(' · ')];
    case 'bot_add': return [`adicionou o bot ${who}`];
    case 'emoji_create': return [`adicionou o emoji :${e.targetName}:`];
    case 'emoji_update': return [`renomeou o emoji :${x.from}: para :${x.to}:`];
    case 'emoji_delete': return [`apagou o emoji :${e.targetName}:`];
    case 'sticker_create': return [`adicionou a figurinha ${t}`];
    case 'sticker_delete': return [`apagou a figurinha ${t}`];
    case 'sound_create': return [`adicionou o som ${t}`];
    case 'sound_delete': return [`apagou o som ${t}`];
    case 'welcome_update': return ['mudou as boas-vindas', [x.enabled ? 'mensagem ligada' : 'mensagem desligada', x.roleId ? 'com cargo automático' : ''].filter(Boolean).join(' · ')];
    case 'automod_update': return ['mudou a moderação automática', [`${x.words || 0} palavra(s) bloqueada(s)`, x.spam ? 'anti-spam ligado' : 'anti-spam desligado'].join(' · ')];
    case 'levels_update': return ['mudou os níveis', [x.enabled ? 'níveis ligados' : 'níveis desligados', x.rewards ? `${x.rewards} recompensa(s)` : ''].filter(Boolean).join(' · ')];
    case 'levels_reset': return ['zerou o XP de todo mundo', ''];
    case 'automod_timeout': return [`castigou ${who} por ${mins(x.minutes)}`, x.reason ? `Motivo: ${x.reason}` : ''];
    case 'event_create': return [`criou o evento ${t}`];
    default: return [e.action];
  }
}

const AUDIT_ICONS = {
  member_kick: '👢', member_ban: '🔨', member_unban: '🕊️', member_timeout: '⏳', member_timeout_remove: '✅', member_roles: '🏷️',
  role_create: '🏷️', role_update: '🏷️', role_delete: '🏷️', role_reorder: '↕️', channel_create: '#️⃣', channel_update: '#️⃣',
  channel_delete: '#️⃣', category_create: '📁', category_update: '📁', category_delete: '📁', server_update: '⚙️', server_icon: '🖼️',
  invite_create: '✉️', invite_delete: '✉️', message_delete: '🗑️', bot_add: '🤖',
  emoji_create: '😺', emoji_update: '😺', emoji_delete: '😺',
  sticker_create: '🏷️', sticker_delete: '🏷️', sound_create: '🎵', sound_delete: '🎵',
  welcome_update: '👋', automod_update: '🛡️', automod_timeout: '🤖', levels_update: '⭐', levels_reset: '⭐',
};

function renderAudit() {
  const d = state.detail;
  const list = h('div', { class: 'audit-list' });
  const more = h('button', { class: 'btn small', hidden: true }, 'Carregar mais');
  let last = null;
  const load = async () => {
    more.disabled = true;
    try {
      const { entries, hasMore } = await api(`/servers/${d.server.id}/audit${last ? `?before=${last}` : ''}`);
      if (!ui || ui.tab !== 'audit') return;
      if (!last && !entries.length) list.append(h('p', { class: 'muted' }, 'Nada registrado ainda.'));
      entries.forEach((e) => {
        const [main, sub] = describe(e);
        list.append(h('div', { class: 'audit-row' },
          h('span', { class: 'audit-icon' }, AUDIT_ICONS[e.action] || '•'),
          e.actor ? avatar(e.actor, { size: 'sm' }) : null,
          h('div', { class: 'audit-text' },
            h('div', {}, h('strong', {}, e.actor ? e.actor.displayName : e.action.startsWith('automod') ? '🤖 Moderação automática' : 'Alguém'), ` ${main}`),
            sub ? h('div', { class: 'muted small' }, sub) : null,
            h('div', { class: 'muted small' }, fullTime(new Date(e.createdAt))))));
      });
      last = entries.length ? entries[entries.length - 1].id : last;
      more.hidden = !hasMore;
    } catch (err) { toast(err.message); } finally { more.disabled = false; }
  };
  more.addEventListener('click', load);
  load();
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Registro de auditoria'),
    h('p', { class: 'muted' }, 'Quem fez o quê no servidor (expulsões, bans, castigos, cargos, canais, convites…).'),
    list, more);
}
