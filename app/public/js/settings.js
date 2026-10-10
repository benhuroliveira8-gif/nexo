// Configurações do servidor: visão geral, cargos e membros.
import { h, api, avatar, toast, openDialog, confirmDialog, openMenu } from './util.js';
import { state, P, PERMISSION_INFO, can, isOwner, myTop, memberRoles, memberTop } from './state.js';

const PRESET_COLORS = ['#ff7a45', '#f5c542', '#3ecf8e', '#2ec4b6', '#4d9fff', '#7c6cff', '#c86bfa', '#ff5c8a', '#ff5c6c', '#a7adbb'];

let ui = null; // { root, tab, roleId, draft, dirty, filter }

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
  ui = { root, tab, roleId: null, draft: null, dirty: false, filter: '' };
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

function tabsAvailable() {
  const tabs = [['overview', 'Visão geral']];
  if (can(P.MANAGE_ROLES)) tabs.push(['roles', 'Cargos']);
  if (can(P.MANAGE_ROLES) || can(P.KICK_MEMBERS)) tabs.push(['members', 'Membros']);
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

  const content = ui.tab === 'roles' ? renderRoles() : ui.tab === 'members' ? renderMembersTab() : renderOverview();

  ui.root.replaceChildren(h('div', { class: 'settings' },
    nav,
    h('div', { class: 'settings-content' }, content),
    h('button', { class: 'settings-close', title: 'Fechar (Esc)', onclick: closeServerSettings }, '✕')));
}

// ---------------------------------------------------------------- Visão geral

function renderOverview() {
  const d = state.detail;
  const manage = can(P.MANAGE_SERVER);
  const name = h('input', { value: d.server.name, maxlength: '100', disabled: !manage });
  const parts = [
    h('h2', {}, 'Visão geral'),
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

  if (d.server.inviteCode) {
    parts.push(h('div', { class: 'settings-block' },
      h('h3', {}, 'Convite'),
      h('p', { class: 'muted' }, 'Código atual: ', h('strong', {}, d.server.inviteCode)),
      manage ? h('button', {
        class: 'btn', onclick: () => confirmDialog({
          title: 'Gerar novo convite',
          text: 'O link/código atual vai parar de funcionar. Quem já entrou continua no servidor.',
          okLabel: 'Gerar novo', danger: false,
          onConfirm: async () => {
            const { inviteCode } = await api(`/servers/${d.server.id}/invite`, { method: 'POST' });
            toast(`Novo código: ${inviteCode}`);
          },
        }),
      }, 'Gerar novo convite') : null));
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
      class: `role-item${r.id === role.id ? ' active' : ''}`,
      onclick: () => {
        if (ui.dirty && r.id !== role.id && !window.confirm('Descartar as alterações não salvas?')) return;
        selectRole(r);
        render();
      },
    },
    h('i', { class: 'role-dot', style: `background:${r.color || 'var(--text-3)'}` }),
    h('span', { class: 'truncate' }, r.name),
    h('span', { class: 'muted small' }, r.isDefault ? 'todos' : String(counts.get(r.id) || 0)))));

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
    return h('div', { class: 'member-row' },
      avatar(m, { online: m.online }),
      h('div', { class: 'member-text' },
        h('strong', { class: 'truncate' }, m.displayName, isServerOwner ? ' 👑' : ''),
        h('span', { class: 'muted small truncate' }, `@${m.username}`)),
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
      can(P.KICK_MEMBERS) && !isServerOwner && m.id !== state.me.id && memberTop(m) < myTop()
        ? h('button', {
          class: 'btn small danger-ghost', onclick: () => confirmDialog({
            title: `Expulsar ${m.displayName}`,
            text: `${m.displayName} vai sair do servidor, mas pode voltar com um convite.`,
            okLabel: 'Expulsar',
            onConfirm: () => api(`/servers/${d.server.id}/members/${m.id}`, { method: 'DELETE' }),
          }),
        }, 'Expulsar')
        : h('span', { class: 'kick-placeholder' }));
  });

  return h('div', { class: 'settings-page' },
    h('h2', {}, `Membros — ${d.members.length}`),
    search,
    h('div', { class: 'member-rows' }, rows.length ? rows : h('p', { class: 'muted' }, 'Ninguém encontrado.')));
}
