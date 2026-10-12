// Configurações do usuário: conta, segurança (senha, 2FA, aparelhos), aparência,
// voz e vídeo, notificações e instalar o app.
import {
  h, api, avatar, toast, openDialog, confirmDialog, uploadAvatar, copyText, storage, playPing, getToken,
} from './util.js';
import { state } from './state.js';
import { qrSvg } from './qr.js';
import { ACCENTS, getTheme, getAccent, setTheme, setAccent } from './theme.js';
import { voiceSettings, saveVoiceSettings, keyLabel } from './voice.js';
import { devicesSection } from './devices.js';
import { profileLookSection, dndScheduleSection, paintBanner } from './profile.js';
import { previewRingtone, playJoin, playLeave } from './callsounds.js';
import { ttsSettingsSection } from './tts.js';
import { economySection } from './economy.js';
import { autoAwaySection } from './idle.js';
import { transcriptionSupported, transcriptionOn } from './extras.js';
import { downloadHelper } from './remote.js';
import {
  pushStatus, enablePush, disablePush, canPromptInstall, promptInstall, isStandalone, isIos, onPwaChange,
} from './pwa.js';

let hooks = { applyMe: () => {}, setSession: () => {}, logout: () => {} };
export const initAccount = (h2) => { hooks = { ...hooks, ...h2 }; };

let ui = null; // { root, tab }

const TABS = [
  ['account', 'Minha conta'],
  ['security', 'Segurança'],
  ['appearance', 'Aparência'],
  ['voice', 'Voz e vídeo'],
  ['notifications', 'Notificações e app'],
];

export function closeAccountSettings() {
  if (!ui) return;
  ui.root.remove();
  document.removeEventListener('keydown', onKey);
  ui = null;
}

function onKey(e) {
  if (e.key === 'Escape' && ui && !document.querySelector('dialog[open]') && !document.querySelector('.popover') && !ui.capturing) closeAccountSettings();
}

export function openAccountSettings(tab = 'account') {
  closeAccountSettings();
  const root = h('div', { class: 'settings-overlay', role: 'dialog', 'aria-modal': 'true' });
  document.body.append(root);
  ui = { root, tab };
  document.addEventListener('keydown', onKey);
  render();
}

export const refreshAccountSettings = () => { if (ui) render(); };
// Outras telas pedem para abrir uma aba (ex.: o ⚙️ da chamada abre "Voz e vídeo").
window.addEventListener('nexo:open-settings', (e) => { import('./util.js').then(({ closePopover }) => closePopover()); openAccountSettings(e.detail || 'account'); });
onPwaChange(refreshAccountSettings);

function render() {
  const nav = h('nav', { class: 'settings-nav' },
    h('div', { class: 'settings-server truncate' }, 'Configurações do usuário'),
    TABS.map(([key, label]) => h('button', {
      class: `settings-tab${ui.tab === key ? ' active' : ''}`,
      onclick: () => { ui.tab = key; render(); },
    }, label)),
    h('div', { class: 'settings-sep' }),
    h('button', { class: 'settings-tab danger', onclick: () => { closeAccountSettings(); hooks.logout(); } }, 'Sair da conta'));
  const pages = { account: pageAccount, security: pageSecurity, appearance: pageAppearance, voice: pageVoice, notifications: pageNotifications };
  const content = h('div', { class: 'settings-content' });
  ui.root.replaceChildren(h('div', { class: 'settings' },
    nav,
    content,
    h('button', { class: 'settings-close', title: 'Fechar (Esc)', onclick: closeAccountSettings }, '✕')));
  const page = pages[ui.tab]();
  content.append(page);
}

const block = (title, ...children) => h('div', { class: 'settings-block' }, title ? h('h3', {}, title) : null, ...children);
const busy = (fn) => async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
};

// ---------------------------------------------------------------- Minha conta

function pageAccount() {
  const me = state.me;
  const name = h('input', { value: me.displayName, maxlength: '32' });
  const about = h('textarea', { class: 'textarea', maxlength: '190', rows: '3', placeholder: 'Conte um pouco sobre você (aparece no seu perfil).' });
  about.value = me.about || '';
  const counter = h('span', { class: 'muted small counter' }, `${about.value.length}/190`);
  about.addEventListener('input', () => { counter.textContent = `${about.value.length}/190`; });

  const pickPhoto = () => {
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      try { toast('Enviando foto…'); hooks.applyMe(await uploadAvatar(file)); toast('Foto atualizada!'); render(); } catch (err) { toast(err.message); }
    });
    picker.click();
  };

  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Minha conta'),
    h('div', { class: 'account-card' },
      (() => { const b = h('div', { class: 'profile-banner', style: `--hue:${(me.id * 137) % 360}` }); paintBanner(b, me); return b; })(),
      h('div', { class: 'account-head' },
        h('button', { class: 'account-avatar', title: 'Trocar foto', onclick: pickPhoto }, avatar(me, { size: 'xl' }), h('span', { class: 'avatar-edit' }, '✏️')),
        h('div', { class: 'account-names' }, h('strong', {}, me.displayName), h('span', { class: 'muted' }, `@${me.username}`)),
        h('div', { class: 'account-photo-actions' },
          h('button', { class: 'btn small', onclick: pickPhoto }, 'Trocar foto'),
          me.avatarUrl ? h('button', {
            class: 'btn small danger-ghost',
            onclick: busy(async () => { hooks.applyMe((await api('/me/avatar', { method: 'DELETE' })).user); render(); }),
          }, 'Remover') : null))),
    h('p', { class: 'muted small' }, '🎞️ Foto e capa podem ser GIF animado (até 8 MB).'),
    h('label', { class: 'field' }, 'Nome de exibição', name),
    h('label', { class: 'field' }, h('span', { class: 'field-row' }, 'Sobre mim', counter), about),
    h('p', { class: 'muted small' }, 'Dica: dá para usar **negrito**, *itálico* e emojis.'),
    h('button', {
      class: 'btn primary',
      onclick: busy(async () => {
        const { user } = await api('/me', { method: 'PATCH', body: { displayName: name.value.trim(), about: about.value } });
        hooks.applyMe(user);
        toast('Perfil salvo!');
        render();
      }),
    }, 'Salvar perfil'),
    profileLookSection(me, { applyMe: hooks.applyMe, rerender: render }),
    h('div', { class: 'settings-block' },
      h('h3', {}, 'Baixar os meus dados'),
      h('p', { class: 'muted' }, 'Um arquivo .zip com as suas mensagens (fácil de ler no navegador), mensagens salvas, perfil, foto, capa e os arquivos que você enviou.'),
      h('button', { class: 'btn', onclick: (e) => downloadMyData(e.currentTarget) }, '📦 Baixar meus dados')),
    h('div', { class: 'settings-block danger-zone' },
      h('h3', {}, 'Apagar conta'),
      h('p', { class: 'muted' }, 'Sua conta some para sempre. Suas mensagens continuam nas conversas, mas aparecem como "Usuário removido". Se você for dono de algum servidor, apague-o antes.'),
      h('button', { class: 'btn danger', onclick: deleteAccountDialog }, 'Apagar minha conta')));
}

function codeField() {
  return h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '11', placeholder: 'Código do app (6 dígitos)', class: 'code-input' });
}

function deleteAccountDialog() {
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sua senha' });
  const code = state.me.twoFactor ? codeField() : null;
  openDialog({
    title: 'Apagar sua conta?',
    text: 'Isso não pode ser desfeito. Digite sua senha para confirmar.',
    body: h('div', { class: 'stack' }, password, code),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Apagar para sempre', kind: 'danger', submit: true,
        onClick: async () => {
          await api('/me', { method: 'DELETE', body: { password: password.value, code: code ? code.value : undefined } });
          closeAccountSettings();
          toast('Conta apagada. Até mais! 👋');
          hooks.logout({ skipServer: true });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Segurança

function pageSecurity() {
  const me = state.me;
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: '6', maxlength: '128' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '128' });
  const code = me.twoFactor ? codeField() : null;
  const err = h('p', { class: 'form-error', role: 'alert' });

  const changePassword = busy(async () => {
    err.textContent = '';
    if (next.value.length < 6) { err.textContent = 'A nova senha precisa ter pelo menos 6 caracteres.'; return; }
    if (next.value !== again.value) { err.textContent = 'As senhas novas não são iguais.'; return; }
    try {
      const data = await api('/me/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: next.value, code: code ? code.value : undefined } });
      hooks.setSession(data.token, data.user);
      toast('Senha trocada! Os outros aparelhos foram desconectados.');
      render();
    } catch (e) { err.textContent = e.message; }
  });

  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Segurança'),
    block('Trocar senha',
      h('label', { class: 'field' }, 'Senha atual', cur),
      h('label', { class: 'field' }, 'Nova senha', next),
      h('label', { class: 'field' }, 'Repita a nova senha', again),
      code ? h('label', { class: 'field' }, 'Código de verificação', code) : null,
      err,
      h('button', { class: 'btn primary', onclick: changePassword }, 'Trocar senha')),
    block('Verificação em duas etapas (2FA)',
      h('p', { class: 'muted' }, me.twoFactor
        ? '✅ Ligada. Para entrar, além da senha, é preciso o código de 6 dígitos do app autenticador.'
        : 'Protege sua conta mesmo se alguém descobrir sua senha: ao entrar, também é pedido um código que muda a cada 30 segundos no app autenticador do seu celular (Google Authenticator, Microsoft Authenticator, Authy…).'),
      me.twoFactor
        ? h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: recoveryDialog }, 'Gerar novos códigos de recuperação'),
          h('button', { class: 'btn danger-ghost', onclick: disable2faDialog }, 'Desligar 2FA'))
        : h('button', { class: 'btn primary', onclick: enable2faDialog }, 'Ligar verificação em duas etapas')),
    block('Chave de recuperação (esqueci a senha)',
      h('p', { class: 'muted' }, me.hasRecoveryKey
        ? '✅ Você tem uma chave guardada. Se esquecer a senha, clique em "Esqueci a senha" na tela de entrar e use a chave. Ela vale uma vez.'
        : 'Crie uma chave e guarde num lugar seguro (papel, gerenciador de senhas). Se você esquecer a senha, ela permite criar uma nova sem depender de ninguém.'),
      h('div', { class: 'row-actions' },
        h('button', { class: me.hasRecoveryKey ? 'btn' : 'btn primary', onclick: recoveryKeyDialog }, me.hasRecoveryKey ? 'Gerar outra chave' : 'Criar chave de recuperação'),
        me.hasRecoveryKey ? h('button', {
          class: 'btn danger-ghost',
          onclick: busy(async () => { await api('/me/recovery-key', { method: 'DELETE' }); hooks.applyMe((await api('/me')).user); toast('Chave apagada.'); }),
        }, 'Apagar chave') : null)),
    block('Aparelhos conectados',
      h('p', { class: 'muted' }, 'Perdeu o celular ou entrou num computador que não é seu? Saia de todos os aparelhos de uma vez. Este aparelho continua conectado.'),
      h('button', {
        class: 'btn',
        onclick: () => confirmDialog({
          title: 'Sair de todos os aparelhos?',
          text: 'Todos os outros navegadores e celulares vão precisar entrar de novo. As notificações push também são desligadas.',
          okLabel: 'Sair de todos',
          onConfirm: async () => {
            const data = await api('/me/sessions/revoke', { method: 'POST' });
            hooks.setSession(data.token, data.user);
            toast('Pronto! Os outros aparelhos foram desconectados.');
          },
        }),
      }, 'Sair de todos os aparelhos')));
}

function recoveryKeyDialog() {
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const code = state.me.twoFactor ? codeField() : null;
  openDialog({
    title: '🔑 Chave de recuperação',
    text: 'Confirme que é você. A chave nova aparece uma vez só (a antiga, se houver, para de valer).',
    body: h('div', {}, h('label', { class: 'field' }, 'Sua senha', pass), code ? h('label', { class: 'field' }, 'Código de verificação', code) : null),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar chave', kind: 'primary', submit: true,
        onClick: async () => {
          const { key } = await api('/me/recovery-key', { method: 'POST', body: { password: pass.value, code: code ? code.value : undefined } });
          hooks.applyMe((await api('/me')).user);
          setTimeout(() => showRecoveryKey(key), 50);
        },
      },
    ],
  });
}

function showRecoveryKey(key) {
  openDialog({
    title: '🔑 Guarde a sua chave',
    text: 'Anote num papel ou salve no gerenciador de senhas. Ela não aparece de novo. Se esquecer a senha: tela de entrar → "Esqueci a senha".',
    body: h('div', { class: 'recovery-codes' }, h('code', { class: 'big-key' }, key)),
    actions: [
      { label: 'Copiar', onClick: async () => { await copyText(key); toast('Chave copiada.'); return false; } },
      { label: 'Já guardei', kind: 'primary', submit: true },
    ],
  });
}

async function downloadMyData(btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Preparando o arquivo…';
  try {
    const res = await fetch('/api/me/export', { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erro ${res.status}`);
    const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'nexo-meus-dados.zip';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Arquivo pronto! 📦');
  } catch (err) { toast(err.message); }
  btn.textContent = label;
  btn.disabled = false;
}

function showRecoveryCodes(codes) {
  const text = codes.join('\n');
  const list = h('div', { class: 'recovery-codes' }, codes.map((c) => h('code', {}, c)));
  openDialog({
    title: '🔑 Códigos de recuperação',
    text: 'Guarde estes códigos num lugar seguro (anote num papel ou salve um arquivo). Se você perder o celular, cada código serve UMA vez para entrar no lugar do código do app.',
    body: list,
    actions: [
      {
        label: 'Baixar arquivo', close: false,
        onClick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([`Códigos de recuperação do Nexo (@${state.me.username})\n\n${text}\n`], { type: 'text/plain' })), download: 'nexo-codigos-de-recuperacao.txt' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      },
      { label: 'Copiar', close: false, onClick: async () => { if (await copyText(text)) toast('Códigos copiados!'); else throw new Error('Não deu para copiar. Anote à mão.'); } },
      { label: 'Já guardei', kind: 'primary', submit: true },
    ],
  });
}

function enable2faDialog() {
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sua senha' });
  openDialog({
    title: 'Ligar verificação em duas etapas',
    text: 'Primeiro, confirme sua senha.',
    body: password,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Continuar', kind: 'primary', submit: true,
        onClick: async () => {
          const { secret, uri } = await api('/me/2fa/setup', { method: 'POST', body: { password: password.value } });
          setTimeout(() => step2(secret, uri), 0);
        },
      },
    ],
  });

  function step2(secret, uri) {
    const code = codeField();
    const grouped = secret.match(/.{1,4}/g).join(' ');
    const secretField = h('input', { value: grouped, readonly: true, class: 'mono' });
    openDialog({
      title: 'Escaneie o QR code',
      wide: true,
      body: h('div', { class: 'twofa-setup' },
        h('div', { class: 'qr-box' }, qrSvg(uri, 200)),
        h('ol', { class: 'twofa-steps' },
          h('li', {}, 'Instale um app autenticador no celular (Google Authenticator, Microsoft Authenticator ou Authy).'),
          h('li', {}, 'No app, toque em "+" e escaneie este QR code.'),
          h('li', {}, 'Está no próprio celular? No app, escolha "Inserir chave de configuração" e use esta chave:', secretField),
          h('li', {}, 'Digite abaixo o código de 6 dígitos que aparece no app:', code))),
      actions: [
        { label: 'Cancelar' },
        {
          label: 'Ligar 2FA', kind: 'primary', submit: true,
          onClick: async () => {
            const data = await api('/me/2fa/enable', { method: 'POST', body: { code: code.value } });
            hooks.setSession(data.token, data.user);
            render();
            setTimeout(() => showRecoveryCodes(data.recoveryCodes), 0);
          },
        },
      ],
    });
    setTimeout(() => code.focus(), 50);
  }
}

function disable2faDialog() {
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sua senha' });
  const code = codeField();
  code.placeholder = 'Código do app ou de recuperação';
  openDialog({
    title: 'Desligar a verificação em duas etapas?',
    text: 'Sua conta fica protegida só pela senha.',
    body: h('div', { class: 'stack' }, password, code),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Desligar', kind: 'danger', submit: true,
        onClick: async () => {
          const { user } = await api('/me/2fa/disable', { method: 'POST', body: { password: password.value, code: code.value } });
          hooks.applyMe(user);
          toast('Verificação em duas etapas desligada.');
          render();
        },
      },
    ],
  });
}

function recoveryDialog() {
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sua senha' });
  const code = codeField();
  openDialog({
    title: 'Novos códigos de recuperação',
    text: 'Os códigos antigos param de funcionar.',
    body: h('div', { class: 'stack' }, password, code),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Gerar', kind: 'primary', submit: true,
        onClick: async () => {
          const { recoveryCodes } = await api('/me/2fa/recovery', { method: 'POST', body: { password: password.value, code: code.value } });
          setTimeout(() => showRecoveryCodes(recoveryCodes), 0);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Aparência

function pageAppearance() {
  const theme = getTheme();
  const accent = getAccent();
  const option = (value, label, desc) => h('label', { class: `theme-option${theme === value ? ' active' : ''} t-${value}` },
    h('input', { type: 'radio', name: 'theme', value, checked: theme === value, onchange: () => { setTheme(value); render(); } }),
    h('span', { class: 'theme-swatch' }, h('i'), h('i'), h('i')),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Aparência'),
    h('p', { class: 'muted' }, 'Vale só para este aparelho.'),
    block('Economia', economySection(render)),
    block('Tema',
      h('div', { class: 'theme-options' },
        option('dark', 'Escuro', 'Confortável à noite'),
        option('light', 'Claro', 'Bom em lugares iluminados'),
        option('system', 'Automático', 'Segue o tema do seu aparelho'))),
    block('Cor de destaque',
      h('div', { class: 'swatches' },
        ACCENTS.map(([c, label]) => h('button', {
          class: `swatch${accent.toLowerCase() === c ? ' active' : ''}`, style: `background:${c}`, title: label,
          onclick: () => { setAccent(c); render(); },
        })),
        h('input', {
          type: 'color', class: 'swatch-custom', title: 'Escolher outra cor', value: accent,
          onchange: (e) => { setAccent(e.target.value); render(); },
        })),
      h('div', { class: 'accent-preview' },
        h('button', { class: 'btn primary small' }, 'Botão'),
        h('span', { class: 'mention' }, '@menção'),
        h('a', { href: '#', onclick: (e) => e.preventDefault() }, 'um link'))));
}

// ---------------------------------------------------------------- Voz e vídeo

function pageVoice() {
  const st = voiceSettings();
  const toggle = (key, label, desc) => h('label', { class: 'perm' },
    h('div', { class: 'perm-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)),
    h('input', { type: 'checkbox', class: 'switch', checked: !!st[key], onchange: (e) => { saveVoiceSettings({ [key]: e.target.checked }); } }));
  const modeOption = (value, label, desc) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'vmode', value, checked: st.mode === value, onchange: () => { saveVoiceSettings({ mode: value }); render(); } }),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));

  const keyBtn = h('button', { class: 'btn key-btn' }, keyLabel(st.pttKey));
  keyBtn.addEventListener('click', () => {
    keyBtn.textContent = 'Aperte a tecla…';
    keyBtn.classList.add('capturing');
    ui.capturing = true;
    const onDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onDown, true);
      setTimeout(() => { if (ui) ui.capturing = false; }, 0);
      if (e.code === 'Escape') { render(); return; }
      saveVoiceSettings({ pttKey: e.code });
      render();
    };
    window.addEventListener('keydown', onDown, true);
  });

  const saved = Object.keys(JSON.parse(storage('nexo.volumes') || '{}')).length;
  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Voz e vídeo'),
    h('p', { class: 'muted' }, 'Vale só para este aparelho.'),
    block('Microfone, som e câmera', devicesSection()),
    block('Modo do microfone',
      h('div', { class: 'kind-options' },
        modeOption('voice', 'Detecção de voz', 'O microfone fica ligado; use o botão 🎤 para mutar.'),
        modeOption('ptt', 'Aperte para falar', 'O microfone só liga enquanto você segura a tecla (ou o botão na tela).')),
      st.mode === 'ptt' ? h('div', { class: 'field' }, h('span', {}, 'Tecla para falar'), h('div', { class: 'row-actions' }, keyBtn,
        h('span', { class: 'muted small' }, 'Funciona com o Nexo aberto e em foco. No celular, use o botão "Segure para falar".'))) : null),
    block('Processamento de áudio',
      h('div', { class: 'perm-list' },
        toggle('noiseSuppression', 'Supressão de ruído', 'Tira barulhos de fundo (ventilador, teclado, rua).'),
        toggle('echoCancellation', 'Cancelamento de eco', 'Evita que os outros se ouçam de volta pelo seu microfone.'),
        toggle('autoGainControl', 'Ajuste automático de volume', 'Deixa sua voz num volume parecido, falando baixo ou alto.'))),
    block('Controle remoto (Windows)',
      h('p', { class: 'muted' }, 'Para alguém da chamada poder usar o mouse e o teclado do seu PC pela tela compartilhada, este PC precisa do programinha "Nexo Controle" aberto. Nada acontece sem você clicar em "Permitir".'),
      h('ol', { class: 'muted small rc-steps' },
        h('li', {}, 'Baixe e clique com o botão direito no arquivo → "Executar com o PowerShell".'),
        h('li', {}, 'Ele cria o atalho "Nexo Controle" na Área de Trabalho. Abra quando quiser poder ser controlado.')),
      h('button', { class: 'btn small', onclick: downloadHelper }, '⬇️ Baixar Nexo Controle')),
    block('Sons da chamada',
      h('div', { class: 'perm-list' },
        toggle('callSounds', 'Som de entrar e sair', 'Toca um "plim" quando alguém entra ou sai da chamada em que você está.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', onclick: playJoin }, '▶️ Entrar'),
        h('button', { class: 'btn small', onclick: playLeave }, '▶️ Sair'),
        h('button', { class: 'btn small', onclick: () => previewRingtone() }, '📱 Toque de ligação'))),
    block('Leitura em voz alta', ttsSettingsSection()),
    block('Mensagens de voz',
      transcriptionSupported() ? h('label', { class: 'perm' },
        h('div', { class: 'perm-text' }, h('strong', {}, '📝 Transcrever meus áudios'),
          h('span', { class: 'muted small' }, 'Enquanto você grava, o navegador escreve o que você fala e o texto vai junto com o áudio (para quem não pode ouvir na hora). No Chrome, o reconhecimento de voz usa os servidores do Google.')),
        h('input', { type: 'checkbox', class: 'switch', checked: transcriptionOn(), onchange: (e) => { storage('nexo.transcribe', e.target.checked ? '1' : '0'); } }))
        : h('p', { class: 'muted' }, 'Este navegador não sabe transcrever áudio. No Chrome ou Edge, seus áudios vão com o texto do que você falou.')),
    block('Volume de cada pessoa',
      h('p', { class: 'muted' }, 'Na chamada, clique no quadrado de alguém (ou no nome na lista do canal de voz) para mudar o volume só para você.'),
      saved ? h('button', {
        class: 'btn small',
        onclick: () => { storage('nexo.volumes', null); toast('Volumes voltaram ao normal.'); render(); },
      }, `Voltar todos ao normal (${saved})`) : null));
}

// ---------------------------------------------------------------- Notificações e app

function pageNotifications() {
  const statusBox = h('div', { class: 'push-status muted' }, 'Verificando…');
  const actions = h('div', { class: 'row-actions' });
  pushStatus().then((st) => {
    if (!ui) return;
    const texts = {
      on: '✅ Ligadas neste aparelho. Você recebe avisos de mensagens diretas, menções e ligações mesmo com o Nexo fechado.',
      off: 'Desligadas neste aparelho.',
      denied: '🚫 O navegador está bloqueando as notificações do Nexo. Libere no cadeado ao lado do endereço (Configurações do site → Notificações → Permitir).',
      unsupported: window.isSecureContext ? 'Este navegador não aceita notificações push.' : 'As notificações precisam do endereço com https:// (ex.: o seu domínio).',
      'needs-install': 'No iPhone/iPad, as notificações só funcionam com o Nexo instalado: toque em Compartilhar (□↑) e depois em "Adicionar à Tela de Início". Abra o Nexo pelo ícone e volte aqui.',
    };
    statusBox.textContent = texts[st];
    if (st === 'off') actions.append(h('button', { class: 'btn primary', onclick: busy(async () => { await enablePush(); toast('Notificações ligadas! 🔔'); render(); }) }, 'Ligar notificações'));
    if (st === 'on') {
      actions.append(
        h('button', { class: 'btn', onclick: busy(async () => { await api('/push/test', { method: 'POST' }); toast('Notificação de teste enviada.'); }) }, 'Mandar uma de teste'),
        h('button', { class: 'btn danger-ghost', onclick: busy(async () => { await disablePush(); toast('Notificações desligadas neste aparelho.'); render(); }) }, 'Desligar'),
      );
    }
  });

  const soundToggle = h('input', {
    type: 'checkbox', class: 'switch', checked: state.soundOn,
    onchange: (e) => {
      state.soundOn = e.target.checked;
      storage('nexo.sound', state.soundOn ? '1' : '0');
      if (state.soundOn) playPing();
      hooks.applyMe(state.me);
    },
  });

  let install;
  if (isStandalone()) install = h('p', { class: 'muted' }, '✅ Você está usando o Nexo instalado como app.');
  else if (canPromptInstall()) {
    install = h('div', {}, h('p', { class: 'muted' }, 'Instale o Nexo: ele ganha um ícone na tela inicial e abre em tela cheia, como um app.'),
      h('button', { class: 'btn primary', onclick: busy(async () => { if (await promptInstall()) toast('Nexo instalado! 🎉'); }) }, '📲 Instalar o Nexo'));
  } else if (isIos()) {
    install = h('ol', { class: 'install-steps' },
      h('li', {}, 'Abra o Nexo no Safari.'),
      h('li', {}, 'Toque no botão Compartilhar (quadrado com seta para cima).'),
      h('li', {}, 'Escolha "Adicionar à Tela de Início" e confirme.'));
  } else {
    install = h('div', { class: 'muted' },
      h('p', {}, 'No Android (Chrome): menu ⋮ → "Instalar app" ou "Adicionar à tela inicial".'),
      h('p', {}, 'No computador (Chrome/Edge): ícone de instalar na barra de endereço, ou menu ⋮ → "Instalar Nexo".'),
      !window.isSecureContext ? h('p', {}, '⚠️ Para instalar, abra o Nexo pelo endereço com https://.') : null);
  }

  return h('div', { class: 'settings-page' },
    h('h2', {}, 'Notificações e app'),
    block('Notificações no celular/computador', statusBox, actions),
    block('Som',
      h('label', { class: 'perm' },
        h('div', { class: 'perm-text' }, h('strong', {}, 'Som de notificação'), h('span', { class: 'muted small' }, 'Toca um "plim" quando chega mensagem direta ou menção com o Nexo aberto.')),
        soundToggle)),
    block('Ausente automático', autoAwaySection(render)),
    block('"Não perturbe" agendado', dndScheduleSection(state.me, async (changes) => {
      const { user } = await api('/me', { method: 'PATCH', body: changes });
      hooks.applyMe(user);
    })),
    block('Instalar como app', install));
}
