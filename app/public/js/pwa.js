// App instalável (PWA) e notificações push.
import { api } from './util.js';

let installEvent = null;
const listeners = new Set();
export const onPwaChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignora */ } });

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canPromptInstall = () => !!installEvent;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  changed();
});
window.addEventListener('appinstalled', () => { installEvent = null; changed(); });

export async function promptInstall() {
  if (!installEvent) return false;
  const e = installEvent;
  installEvent = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => null);
  changed();
  return !!(choice && choice.outcome === 'accepted');
}

// ---------------------------------------------------------------- Service worker

let registration = null;
export async function registerServiceWorker(onOpenUrl) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
  // Clique numa notificação com o Nexo já aberto: o service worker avisa aqui.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'nexo:open' && typeof e.data.url === 'string') onOpenUrl(e.data.url);
  });
  return registration;
}

// ---------------------------------------------------------------- Push

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = registration || await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off'
export async function pushStatus() {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const keyBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function enablePush() {
  if (!pushSupported()) throw new Error(isIos() ? 'No iPhone, instale o Nexo na tela de início primeiro (Compartilhar → Adicionar à Tela de Início).' : 'Este navegador não aceita notificações push.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Você não permitiu as notificações. Libere nas configurações do navegador (cadeado ao lado do endereço).');
  const reg = registration || await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  // Se a chave do servidor mudou, inscreve de novo.
  if (sub && sub.options && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = keyBytes(publicKey);
    if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  changed();
  return true;
}

export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  changed();
}

// Depois do login: se este aparelho já tinha notificações ligadas, garante que elas
// estão ligadas para a conta que entrou agora.
export async function syncPushAfterLogin() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  } catch { /* sem push, tudo bem */ }
}

// Ao sair da conta: este aparelho para de receber avisos dela.
export async function forgetPushOnLogout() {
  try {
    const sub = await currentSubscription();
    if (sub) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  } catch { /* ignora */ }
}
