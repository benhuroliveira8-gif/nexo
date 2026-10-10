// Configurações da conta: perfil, segurança (senha, 2 etapas, aparelhos, excluir),
// aparência (tema/cor), notificações e instalar o app no celular.
import { h, api, avatar, toast, openDialog, confirmDialog, copyText, setToken, storage, playPing } from './util.js';
import { state } from './state.js';
import { qrSvg } from './qr.js';
import { ACCENTS, themeSetting, accentSetting, setTheme, setAccent } from './theme.js';
import {
  pushSupport, currentSubscription, currentEndpoint, enablePush, disablePush, isIos, isStandalone,
} from './push.js';
import { applyMe, logout, pickAvatar, removeAvatar, editDisplayName, installPrompt } from './main.js';

let ui = null; // { root, tab }

export function closeUserSettings() {
  if (!ui) return;
  ui.root.remove();
  document.removeEventListener('keydown', onKey);
  ui = null;
}

function onKey(e) {
  if (e.key === 'Escape' && ui && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) closeUserSettings();
}

export function openUserSettings(tab = 'account') {
  closeUserSettings();
  const root = h('div', { class: 'settings-overlay', role: 'dialog', 'aria-modal': 'true' });
  document.body.append(root);
  ui = { root, tab };
  document.addEventListener('keydown', onKey);
  render();
}

export function refreshUserSettings() { if (ui) render(); }

const TABS = [
  ['account', 'Minha conta'],
  ['security', 'Segurança'],
  ['appearance', 'Aparência'],
  ['notifications', 'Notificações'],
  ['app', 'App no celular'],
];

function render() {
  const nav = h('nav', { class: 'settings-nav' },
    h('div', { class: 'settings-server truncate' }, 'Configurações'),
    TABS.map(([key, label]) => h('button', {
      class: `settings-tab${ui.tab === key ? ' active' : ''}`,
      onclick: () => { ui.tab = key; render(); },
    }, label)));
  const pages = { account: pageAccount, security: pageSecurity, appearance: pageAppearance, notifications: pageNotifications, app: pageApp };
  const content = h('div', { class: 'settings-page' });
  ui.root.replaceChildren(h('div', { class: 'settings' },
    nav,
    h('div', { class: 'settings-content' }, content),
    h('button', { class: 'settings-close', title: 'Fechar (Esc)', onclick: closeUserSettings }, '✕')));
  Promise.resolve(pages[ui.tab]()).then((nodes) => content.replaceChildren(...[nodes].flat().filter(Boolean)));
}

// Depois de trocar a senha / sair dos outros aparelhos o servidor manda um token novo.
function useNewToken(token, user) {
  state.token = token;
  setToken(token);
  storage('nexo.token', token);
  if (state.socket) state.socket.auth = { ...(state.socket.auth || {}), token };
  if (user) applyMe(user);
}

const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'muted small' }, hint) : null);

// ---------------------------------------------------------------- Minha conta

function pageAccount() {
  const me = state.me;
  return [
    h('h2', {}, 'Minha conta'),
    h('div', { class: 'account-card' },
      h('div', { class: 'account-banner' }),
      h('div', { class: 'account-row' },
        avatar(me, { size: 'xl' }),
        h('div', { class: 'account-names' },
          h('strong', {}, me.displayName),
          h('span', { class: 'muted' }, `@${me.username}`)),
        h('div', { class: 'account-actions' },
          h('button', { class: 'btn primary', onclick: () => pickAvatar(() => render()) }, 'Mudar foto'),
          me.avatarUrl ? h('button', { class: 'btn', onclick: () => removeAvatar(() => render()) }, 'Remover foto') : null)),
      h('div', { class: 'account-fields' },
        h('div', { class: 'account-field' },
          h('div', {}, h('div', { class: 'label' }, 'Nome de exibição'), h('div', {}, me.displayName)),
          h('button', { class: 'btn small', onclick: () => editDisplayName(() => render()) }, 'Editar')),
        h('div', { class: 'account-field' },
          h('div', {}, h('div', { class: 'label' }, 'Usuário'), h('div', {}, `@${me.username}`)),
          h('span', { class: 'muted small' }, 'não pode mudar')))),
    h('p', { class: 'muted small' }, 'Status, foto e nome também podem ser trocados clicando no seu nome, embaixo, à esquerda.'),
  ];
}

// ---------------------------------------------------------------- Segurança

function pageSecurity() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: '128' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '128' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '128' });
  const changePassword = async (e) => {
    const btn = e.currentTarget;
    if (next.value.length < 6) return toast('A senha nova precisa ter pelo menos 6 caracteres.');
    if (next.value !== again.value) return toast('As duas senhas novas não são iguais.');
    btn.disabled = true;
    try {
      const { token, user } = await api('/me/password', {
        method: 'POST',
        body: { currentPassword: cur.value, newPassword: next.value, socketId: state.socket && state.socket.id, keepEndpoint: await currentEndpoint() },
      });
      useNewToken(token, user);
      cur.value = ''; next.value = ''; again.value = '';
      toast('Senha trocada! Os outros aparelhos foram desconectados.');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  const twoFactor = state.me.twoFactor;
  return [
    h('h2', {}, 'Segurança'),
    h('div', { class: 'settings-block first' },
      h('h3', {}, 'Trocar a senha'),
      field('Senha atual', cur),
      field('Senha nova', next, 'Pelo menos 6 caracteres.'),
      field('Repita a senha nova', again),
      h('button', { class: 'btn primary', onclick: changePassword }, 'Trocar senha'),
      h('p', { class: 'muted small' }, 'Ao trocar a senha, você continua conectado aqui, mas os outros aparelhos precisam entrar de novo.')),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Verificação em duas etapas ', twoFactor ? h('span', { class: 'pill ok' }, 'ATIVA') : h('span', { class: 'pill' }, 'DESLIGADA')),
      h('p', { class: 'muted' }, 'Além da senha, o Nexo pede um código de 6 dígitos do app autenticador do seu celular (Google Authenticator, Microsoft Authenticator, Authy...). Mesmo que alguém descubra sua senha, não entra.'),
      twoFactor
        ? h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: newRecoveryCodes }, 'Gerar novos códigos de recuperação'),
          h('button', { class: 'btn danger-ghost', onclick: disable2fa }, 'Desativar'))
        : h('button', { class: 'btn primary', onclick: setup2fa }, 'Ativar verificação em duas etapas')),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Aparelhos conectados'),
      h('p', { class: 'muted' }, 'Esqueceu o Nexo aberto em outro computador ou perdeu o celular? Saia de todos os outros aparelhos de uma vez. Este aqui continua conectado.'),
      h('button', { class: 'btn', onclick: logoutOthers }, 'Sair de todos os outros aparelhos')),
    h('div', { class: 'settings-block danger-zone' },
      h('h3', {}, 'Excluir conta'),
      h('p', { class: 'muted' }, 'Apaga sua conta, seus amigos e seus bots para sempre. Suas mensagens continuam nos canais, mas aparecem como "Usuário removido". Se você é dono de algum servidor, transfira ou apague antes.'),
      h('button', { class: 'btn danger', onclick: deleteAccount }, 'Excluir minha conta')),
  ];
}

async function logoutOthers() {
  confirmDialog({
    title: 'Sair de todos os outros aparelhos',
    text: 'Todos os outros navegadores e celulares vão precisar entrar de novo. Este continua conectado.',
    okLabel: 'Sair dos outros',
    onConfirm: async () => {
      const { token, user } = await api('/me/logout-all', {
        method: 'POST', body: { socketId: state.socket && state.socket.id, keepEndpoint: await currentEndpoint() },
      });
      useNewToken(token, user);
      toast('Pronto! Os outros aparelhos foram desconectados.');
    },
  });
}

function askPassword(title, text, onSubmit, { withCode = false } = {}) {
  const pass = h('input', { type: 'password', autocomplete: 'current-password', maxlength: '128' });
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', placeholder: '123456 ou código de recuperação' });
  openDialog({
    title,
    text,
    body: h('div', {}, field('Sua senha', pass), withCode ? field('Código do app autenticador', code) : null),
    actions: [
      { label: 'Cancelar' },
      { label: 'Continuar', kind: 'primary', submit: true, onClick: () => onSubmit(pass.value, code.value.trim()) },
    ],
  });
  setTimeout(() => pass.focus(), 50);
}

function showRecoveryCodes(codes) {
  const text = `Códigos de recuperação do Nexo (@${state.me.username})\nCada código funciona UMA vez, se você perder o celular.\n\n${codes.join('\n')}\n`;
  openDialog({
    title: 'Guarde seus códigos de recuperação',
    text: 'Se você perder o celular, use um destes códigos no lugar do código de 6 dígitos. Cada um vale uma vez. Guarde num lugar seguro (anote num papel ou salve o arquivo).',
    body: h('div', { class: 'recovery-codes' }, codes.map((c) => h('code', {}, c))),
    actions: [
      {
        label: 'Baixar arquivo', close: false,
        onClick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'nexo-codigos-de-recuperacao.txt' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      },
      { label: 'Copiar', close: false, onClick: async () => { if (await copyText(codes.join('\n'))) toast('Códigos copiados!'); } },
      { label: 'Já guardei', kind: 'primary', submit: true },
    ],
  });
}

function setup2fa() {
  askPassword('Ativar verificação em duas etapas', 'Confirme sua senha para começar.', async (password) => {
    const { secret, otpauthUrl } = await api('/me/2fa/setup', { method: 'POST', body: { password } });
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '000000', class: 'code-input' });
    setTimeout(() => {
      openDialog({
        title: 'Configure o app autenticador',
        body: h('div', { class: 'twofa' },
          h('ol', { class: 'steps' },
            h('li', {}, 'Instale um app autenticador no celular (ex.: ', h('strong', {}, 'Google Authenticator'), ' ou ', h('strong', {}, 'Microsoft Authenticator'), ').'),
            h('li', {}, 'No app, toque em ', h('strong', {}, '+'), ' → ', h('strong', {}, 'Ler QR code'), ' e aponte para o código abaixo.'),
            h('li', {}, 'Digite o código de 6 dígitos que aparecer no app.')),
          h('div', { class: 'qr-box' }, qrSvg(otpauthUrl, { size: 200 })),
          h('p', { class: 'muted small center' }, 'Está no celular? ', h('a', { href: otpauthUrl }, 'Toque aqui para abrir no app'), '. Ou digite a chave manualmente:'),
          h('div', { class: 'secret-key' }, secret.match(/.{1,4}/g).join(' ')),
          field('Código do app', code)),
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Ativar', kind: 'primary', submit: true,
            onClick: async () => {
              const { user, recoveryCodes } = await api('/me/2fa/enable', { method: 'POST', body: { code: code.value } });
              applyMe(user);
              render();
              setTimeout(() => showRecoveryCodes(recoveryCodes), 50);
              toast('Verificação em duas etapas ativada! 🔒');
            },
          },
        ],
      });
      code.focus();
    }, 50);
  });
}

function disable2fa() {
  askPassword('Desativar verificação em duas etapas', 'Sua conta fica protegida só pela senha.', async (password, code) => {
    const { user } = await api('/me/2fa/disable', { method: 'POST', body: { password, code } });
    applyMe(user);
    render();
    toast('Verificação em duas etapas desativada.');
  }, { withCode: true });
}

function newRecoveryCodes() {
  askPassword('Novos códigos de recuperação', 'Os códigos antigos param de funcionar.', async (password) => {
    const { recoveryCodes } = await api('/me/2fa/recovery-codes', { method: 'POST', body: { password } });
    setTimeout(() => showRecoveryCodes(recoveryCodes), 50);
  });
}

function deleteAccount() {
  const confirmText = h('input', { placeholder: state.me.username, autocomplete: 'off', spellcheck: 'false' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12' });
  openDialog({
    title: 'Excluir conta para sempre',
    text: 'Isso não pode ser desfeito.',
    body: h('div', {},
      field(`Digite seu usuário (${state.me.username}) para confirmar`, confirmText),
      field('Sua senha', pass),
      state.me.twoFactor ? field('Código do app autenticador', code) : null),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Excluir conta', kind: 'danger', submit: true,
        onClick: async () => {
          if (confirmText.value.trim().toLowerCase() !== state.me.username) throw new Error('O usuário digitado não confere.');
          await api('/me', { method: 'DELETE', body: { password: pass.value, code: code.value.trim() } });
          closeUserSettings();
          toast('Sua conta foi excluída. Até mais! 👋');
          logout({ skipServer: true });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Aparência

function pageAppearance() {
  const theme = themeSetting();
  const accent = accentSetting();
  const option = (value, label, desc) => h('button', {
    class: `theme-option ${value}${theme === value ? ' active' : ''}`,
    onclick: () => { setTheme(value); render(); },
  }, h('span', { class: 'theme-preview' }, h('i'), h('i'), h('i')), h('strong', {}, label), h('span', { class: 'muted small' }, desc));
  return [
    h('h2', {}, 'Aparência'),
    h('p', { class: 'muted' }, 'Fica salvo neste navegador/aparelho.'),
    h('div', { class: 'settings-block first' },
      h('h3', {}, 'Tema'),
      h('div', { class: 'theme-options' },
        option('dark', 'Escuro', 'O de sempre'),
        option('light', 'Claro', 'Fundo branco'),
        option('auto', 'Automático', 'Igual ao sistema'))),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Cor de destaque'),
      h('p', { class: 'muted' }, 'Botões, seleção e detalhes.'),
      h('div', { class: 'accent-swatches' }, ACCENTS.map(([color, label]) => h('button', {
        class: `swatch${accent === color ? ' active' : ''}`,
        style: `--c:${color}`,
        title: label,
        'aria-label': label,
        onclick: () => { setAccent(color); render(); },
      }))),
      h('div', { class: 'accent-preview' },
        h('button', { class: 'btn primary' }, 'Botão'),
        h('span', { class: 'mention me' }, '@você'),
        h('span', { class: 'link' }, 'link'))),
  ];
}

// ---------------------------------------------------------------- Notificações

async function pageNotifications() {
  const support = pushSupport();
  const sub = support.ok ? await currentSubscription() : null;
  const on = !!sub && Notification.permission === 'granted';
  const soundToggle = h('input', { type: 'checkbox', class: 'switch', checked: state.soundOn });
  soundToggle.addEventListener('change', () => {
    state.soundOn = soundToggle.checked;
    storage('nexo.sound', state.soundOn ? '1' : '0');
    if (state.soundOn) playPing();
  });
  const toggle = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (on) { await disablePush(); toast('Notificações desligadas neste aparelho.'); } else { await enablePush(); toast('Notificações ligadas! 🔔'); }
    } catch (err) {
      toast(err.message);
    }
    render();
  };
  return [
    h('h2', {}, 'Notificações'),
    h('div', { class: 'settings-block first' },
      h('h3', {}, 'Notificações neste aparelho ', on ? h('span', { class: 'pill ok' }, 'LIGADAS') : h('span', { class: 'pill' }, 'DESLIGADAS')),
      h('p', { class: 'muted' }, 'Avisa de mensagens diretas, menções (@você, @everyone) e respostas, mesmo com o Nexo fechado. Não avisa se você está usando o Nexo naquele momento, nem no modo "Não perturbe".'),
      support.ok
        ? h('div', { class: 'row-actions' },
          h('button', { class: `btn ${on ? '' : 'primary'}`, onclick: toggle }, on ? 'Desligar neste aparelho' : 'Ligar notificações'),
          on ? h('button', {
            class: 'btn',
            onclick: async () => { try { await api('/push/test', { method: 'POST' }); toast('Teste enviado. Feche ou minimize o Nexo para ver.'); } catch (err) { toast(err.message); } },
          }, 'Enviar um teste') : null)
        : h('p', { class: 'notice' }, support.reason),
      h('p', { class: 'muted small' }, 'Cada aparelho (PC, celular) liga as notificações separadamente.')),
    h('div', { class: 'settings-block' },
      h('label', { class: 'switch-row' }, soundToggle, h('span', {}, h('strong', {}, 'Som de notificação'), h('span', { class: 'muted small' }, 'Toca um som quando chega menção ou mensagem direta com o Nexo aberto.')))),
  ];
}

// ---------------------------------------------------------------- App no celular

function pageApp() {
  const prompt = installPrompt();
  const installed = isStandalone();
  return [
    h('h2', {}, 'App no celular e no PC'),
    h('p', { class: 'muted' }, 'O Nexo pode virar um app: ícone na tela inicial, abre em tela cheia (sem a barra do navegador) e recebe notificações.'),
    installed
      ? h('p', { class: 'notice ok' }, '✅ Você já está usando o Nexo como app.')
      : prompt
        ? h('button', { class: 'btn primary', onclick: async () => { prompt.prompt(); await prompt.userChoice.catch(() => {}); render(); } }, 'Instalar o Nexo')
        : null,
    h('div', { class: 'settings-block first' },
      h('h3', {}, isIos() ? '📱 iPhone / iPad (Safari)' : '📱 Como instalar'),
      isIos()
        ? h('ol', { class: 'steps' },
          h('li', {}, 'Abra o Nexo no ', h('strong', {}, 'Safari'), '.'),
          h('li', {}, 'Toque em ', h('strong', {}, 'Compartilhar'), ' (o quadrado com a seta para cima).'),
          h('li', {}, 'Escolha ', h('strong', {}, 'Adicionar à Tela de Início'), ' → ', h('strong', {}, 'Adicionar'), '.'),
          h('li', {}, 'Abra pelo ícone novo e ligue as notificações em Configurações → Notificações.'))
        : h('ol', { class: 'steps' },
          h('li', {}, h('strong', {}, 'Android (Chrome):'), ' menu ⋮ → ', h('strong', {}, 'Instalar app'), ' (ou "Adicionar à tela inicial").'),
          h('li', {}, h('strong', {}, 'PC (Chrome/Edge):'), ' ícone de instalar na barra de endereço (um monitor com seta) → ', h('strong', {}, 'Instalar'), '.'),
          h('li', {}, h('strong', {}, 'iPhone:'), ' Safari → Compartilhar → Adicionar à Tela de Início.'))),
    h('p', { class: 'muted small' }, 'Funciona pelo endereço com HTTPS (o seu domínio). Pelo IP da rede de casa, só se o certificado estiver instalado.'),
  ];
}
