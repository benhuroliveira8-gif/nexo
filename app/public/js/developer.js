// Tela "Desenvolvedor": criar e gerenciar bots.
import { h, api, avatar, toast, openDialog, confirmDialog, openMenu, copyText } from './util.js';
import { state } from './state.js';

let bots = [];

async function load(list) {
  try {
    ({ bots } = await api('/bots'));
  } catch (err) {
    toast(err.message);
  }
  render(list);
}

// Mostra o token uma única vez, com botão de copiar.
function showToken(bot, token) {
  const field = h('input', { value: token, readonly: true, class: 'mono' });
  openDialog({
    title: `Token do ${bot.displayName}`,
    text: 'Copie agora: por segurança ele não aparece de novo. Quem tiver este token controla o bot, então não compartilhe.',
    body: h('div', {},
      field,
      h('p', { class: 'muted small' }, 'Para usar o bot de exemplo, coloque no .env do servidor:'),
      h('pre', { class: 'code' }, `BOT_TOKEN=${token}`)),
    actions: [
      { label: 'Fechar' },
      {
        label: 'Copiar token', kind: 'primary', submit: true, close: false,
        onClick: async () => {
          if (await copyText(token, field)) toast('Token copiado!');
          else throw new Error('Selecione o texto e copie com Ctrl+C.');
        },
      },
    ],
  });
}

function createDialog(list) {
  const username = h('input', { placeholder: 'meu_bot', maxlength: '32', autocapitalize: 'none', spellcheck: 'false' });
  const displayName = h('input', { placeholder: 'Meu Bot', maxlength: '32' });
  openDialog({
    title: 'Criar bot',
    body: h('div', {},
      h('label', { class: 'field' }, 'Nome de usuário (@)', username),
      h('label', { class: 'field' }, 'Nome de exibição', displayName)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar bot', kind: 'primary', submit: true,
        onClick: async () => {
          const res = await api('/bots', { method: 'POST', body: { username: username.value.trim(), displayName: displayName.value.trim() } });
          await load(list);
          setTimeout(() => showToken(res.bot, res.token));
        },
      },
    ],
  });
}

function addToServer(anchor, bot) {
  if (state.servers.length === 0) return toast('Você ainda não está em nenhum servidor.');
  openMenu(anchor, state.servers.map((s) => ({
    label: s.name,
    onClick: async () => {
      try {
        await api(`/servers/${s.id}/bots`, { method: 'POST', body: { username: bot.username } });
        toast(`${bot.displayName} entrou em ${s.name}!`);
        load(document.querySelector('.dev-bots'));
      } catch (err) {
        toast(err.message);
      }
    },
  })));
}

function render(list) {
  if (!list || !list.isConnected) return;
  list.replaceChildren(...(bots.length === 0
    ? [h('p', { class: 'muted' }, 'Você ainda não criou nenhum bot.')]
    : bots.map((b) => h('div', { class: 'dev-bot' },
      avatar(b),
      h('div', { class: 'dev-bot-text' },
        h('strong', { class: 'truncate' }, b.displayName, h('span', { class: 'bot-tag' }, 'BOT')),
        h('span', { class: 'muted small' }, `@${b.username} • em ${b.serverCount} ${b.serverCount === 1 ? 'servidor' : 'servidores'}`)),
      h('div', { class: 'dev-bot-actions' },
        h('button', { class: 'btn small', onclick: (e) => addToServer(e.currentTarget, b) }, 'Adicionar a um servidor'),
        h('button', {
          class: 'btn small', onclick: () => confirmDialog({
            title: 'Gerar token novo',
            text: 'O token atual para de funcionar e o bot é desconectado até você usar o novo.',
            okLabel: 'Gerar novo', danger: false,
            onConfirm: async () => {
              const { token } = await api(`/bots/${b.id}/token`, { method: 'POST' });
              setTimeout(() => showToken(b, token));
            },
          }),
        }, 'Novo token'),
        h('button', {
          class: 'btn small danger-ghost', onclick: () => confirmDialog({
            title: `Apagar ${b.displayName}`,
            text: 'O bot sai de todos os servidores. As mensagens dele ficam como "Usuário removido".',
            okLabel: 'Apagar bot',
            onConfirm: async () => { await api(`/bots/${b.id}`, { method: 'DELETE' }); await load(list); },
          }),
        }, 'Apagar'))))));
}

export function openDeveloper() {
  const list = h('div', { class: 'dev-bots' }, h('p', { class: 'muted' }, 'Carregando…'));
  const origin = location.origin;
  openDialog({
    title: '🤖 Desenvolvedor',
    text: 'Bots são contas automáticas que leem e mandam mensagens por um programa seu.',
    wide: true,
    body: h('div', {},
      h('button', { class: 'btn primary', type: 'button', onclick: () => createDialog(list) }, '+ Criar bot'),
      list,
      h('details', { class: 'dev-docs' },
        h('summary', {}, 'Como programar um bot'),
        h('p', { class: 'muted small' }, 'Use o token no cabeçalho Authorization: "Bot <token>". Exemplo, mandar uma mensagem:'),
        h('pre', { class: 'code' },
          `curl -X POST ${origin}/api/channels/ID_DO_CANAL/messages \\\n`
          + '  -H "Authorization: Bot SEU_TOKEN" \\\n'
          + '  -H "Content-Type: application/json" \\\n'
          + '  -d \'{"content": "Olá, eu sou um bot!"}\''),
        h('p', { class: 'muted small' },
          'Para receber mensagens em tempo real, conecte no Socket.IO com auth: { token: "Bot SEU_TOKEN" } e escute o evento "message:new". '
          + 'O projeto já traz um exemplo pronto em examples/bot-exemplo (comandos !ping, !dado, !eco...).'))),
    actions: [{ label: 'Fechar' }],
  });
  load(list);
}
