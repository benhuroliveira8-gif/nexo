// Tela de amigos (início): online, todos, pedidos pendentes e adicionar amigo.
import { h, api, avatar, badge, toast, confirmDialog } from './util.js';
import { state } from './state.js';
import { openDm, openProfile } from './main.js';

const TABS = [
  ['online', 'Online'],
  ['all', 'Todos'],
  ['pending', 'Pendentes'],
  ['add', 'Adicionar amigo'],
];

let addValue = '';
let addResult = null; // { ok, text }

function act(fn) {
  return async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
  };
}

function row(user, subtitle, actions) {
  return h('div', { class: 'friend-row' },
    h('button', { class: 'friend-main', onclick: (e) => openProfile(e.currentTarget, user) },
      avatar(user, { online: user.online }),
      h('div', { class: 'friend-text' },
        h('strong', { class: 'truncate' }, user.displayName),
        h('span', { class: 'muted truncate' }, subtitle))),
    h('div', { class: 'friend-actions' }, actions));
}

const roundBtn = (label, title, onclick, cls = '') => h('button', { class: `round-btn ${cls}`, title, 'aria-label': title, onclick }, label);

export function renderFriendsPage(container) {
  const f = state.friends;
  const tab = state.friendsTab;

  const tabs = h('div', { class: 'friends-tabs' }, TABS.map(([key, label]) => h('button', {
    class: `tab${tab === key ? ' active' : ''}${key === 'add' ? ' add' : ''}`,
    onclick: () => { state.friendsTab = key; addResult = null; renderFriendsPage(container); },
  }, label, key === 'pending' ? badge(f.incoming.length) : null)));

  let content;
  if (tab === 'add') {
    const input = h('input', {
      placeholder: 'Digite o @usuário da pessoa', value: addValue, maxlength: '33',
      autocapitalize: 'none', spellcheck: 'false',
      oninput: (e) => { addValue = e.target.value; },
    });
    const form = h('form', {
      class: 'add-friend',
      onsubmit: async (e) => {
        e.preventDefault();
        const username = input.value.trim();
        if (!username) return;
        try {
          const { status } = await api('/friends', { method: 'POST', body: { username } });
          addResult = { ok: true, text: status === 'accepted' ? 'Vocês agora são amigos! 🎉' : `Pedido enviado para @${username.replace(/^@/, '')}.` };
          addValue = '';
        } catch (err) {
          addResult = { ok: false, text: err.message };
        }
        renderFriendsPage(container);
      },
    }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Enviar pedido'));
    content = h('div', { class: 'friends-add' },
      h('h3', {}, 'Adicionar amigo'),
      h('p', { class: 'muted' }, 'Você pode adicionar alguém pelo nome de usuário (o que vem depois do @).'),
      form,
      addResult ? h('p', { class: addResult.ok ? 'form-ok' : 'form-error' }, addResult.text) : null);
    requestAnimationFrame(() => input.focus());
  } else if (tab === 'pending') {
    const rows = [
      ...f.incoming.map((u) => row(u, 'Pedido recebido', [
        roundBtn('✓', 'Aceitar', act(() => api(`/friends/${u.id}/accept`, { method: 'POST' })), 'ok'),
        roundBtn('✕', 'Recusar', act(() => api(`/friends/${u.id}`, { method: 'DELETE' })), 'no'),
      ])),
      ...f.outgoing.map((u) => row(u, 'Pedido enviado', [
        roundBtn('✕', 'Cancelar pedido', act(() => api(`/friends/${u.id}`, { method: 'DELETE' })), 'no'),
      ])),
    ];
    content = list(`Pendentes — ${rows.length}`, rows, 'Nenhum pedido pendente.');
  } else {
    const people = tab === 'online' ? f.friends.filter((u) => u.online) : f.friends;
    const rows = people.map((u) => row(u, u.online ? 'Online' : 'Offline', [
      roundBtn('💬', 'Enviar mensagem', () => openDm(u.id)),
      roundBtn('✕', 'Desfazer amizade', () => confirmDialog({
        title: `Desfazer amizade com ${u.displayName}`,
        text: 'Vocês continuam podendo conversar se estiverem no mesmo servidor.',
        okLabel: 'Desfazer amizade',
        onConfirm: () => api(`/friends/${u.id}`, { method: 'DELETE' }),
      }), 'no'),
    ]));
    const empty = tab === 'online'
      ? (f.friends.length ? 'Nenhum amigo online agora.' : 'Você ainda não tem amigos aqui. Que tal adicionar alguém?')
      : 'Você ainda não tem amigos aqui. Use "Adicionar amigo".';
    content = list(`${tab === 'online' ? 'Online' : 'Todos os amigos'} — ${rows.length}`, rows, empty);
  }

  container.replaceChildren(tabs, content);
}

function list(title, rows, empty) {
  return h('div', { class: 'friends-list' },
    h('div', { class: 'section-title' }, title),
    rows.length ? rows : h('div', { class: 'empty-state' }, h('div', { class: 'empty-art' }, '🌙'), h('p', { class: 'muted' }, empty)));
}
