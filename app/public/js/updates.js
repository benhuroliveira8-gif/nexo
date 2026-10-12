// Atualizações sem susto: mostra "o Nexo vai atualizar em 20 s", depois "atualizando…",
// e quando volta recarrega sozinho (se ninguém estiver no meio de algo) ou oferece o botão.
import { $, h, toast } from './util.js';

let bootVersion = null;
let restartUntil = 0;
let countdown = null;
let waitingRestart = false;
let pendingVersion = null;
let canReload = () => true;

export function initUpdates({ version, canReloadNow }) {
  if (version) bootVersion = version;
  if (canReloadNow) canReload = canReloadNow;
}

function banner(content, kind = '') {
  const el = $('#update-banner');
  if (!content) { el.hidden = true; el.replaceChildren(); return; }
  el.className = `update-banner ${kind}`;
  el.replaceChildren(...[].concat(content));
  el.hidden = false;
}

function showCountdown(seconds) {
  clearInterval(countdown);
  restartUntil = Date.now() + seconds * 1000;
  waitingRestart = true;
  const draw = () => {
    const left = Math.max(0, Math.round((restartUntil - Date.now()) / 1000));
    banner(left > 0
      ? `🔄 O Nexo vai atualizar em ${left} s. Você volta sozinho, inclusive na chamada.`
      : '🔄 Atualizando o Nexo… volta em instantes.', 'info');
  };
  draw();
  countdown = setInterval(draw, 1000);
}

export function onRestarting({ in: seconds }) {
  showCountdown(Number(seconds) || 0);
}

export function onDisconnected() {
  if (waitingRestart) { clearInterval(countdown); banner('🔄 Atualizando o Nexo… volta em instantes.', 'info'); }
}

// Ao conectar o servidor manda { version, restarting }.
export function onHello({ version, restarting }) {
  if (restarting && restarting.in > 0) { showCountdown(restarting.in); return; }
  const wasRestarting = waitingRestart;
  waitingRestart = false;
  clearInterval(countdown);
  if (!bootVersion) bootVersion = version;
  if (version && bootVersion && version !== bootVersion) return newVersion(version);
  banner(null);
  if (wasRestarting) toast('Nexo atualizado ✨');
}

function newVersion(version) {
  pendingVersion = version;
  if (canReload()) {
    banner(`✨ Nexo atualizado para a versão ${version}. Recarregando…`, 'info');
    setTimeout(() => location.reload(), 1200);
    return;
  }
  banner([
    h('span', {}, `✨ Saiu a versão ${version} do Nexo.`),
    h('button', { class: 'btn small primary', onclick: () => location.reload() }, 'Recarregar agora'),
    h('button', { class: 'icon-btn small', title: 'Depois', onclick: () => banner(null) }, '✕'),
  ], 'info');
}

// Saiu da chamada / terminou de escrever: se havia versão nova esperando, recarrega.
export function maybeReloadLater() {
  if (pendingVersion && canReload()) location.reload();
}
