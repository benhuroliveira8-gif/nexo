// Notificações push no navegador: liga/desliga neste aparelho.
import { api } from './util.js';

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function pushSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'Precisa abrir o Nexo pelo endereço com HTTPS (cadeado).' };
  if (isIos() && !isStandalone()) {
    return { ok: false, reason: 'No iPhone/iPad, primeiro adicione o Nexo à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra por lá.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'Este navegador não suporta notificações. Use Chrome, Edge, Firefox ou Safari atualizados.' };
  }
  return { ok: true };
}

let registration = null;
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch {
    return null;
  }
}

async function readyRegistration() {
  if (registration) return registration;
  return registerServiceWorker();
}

export async function currentSubscription() {
  const reg = await readyRegistration();
  if (!reg || !reg.pushManager) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}

export async function currentEndpoint() {
  const sub = await currentSubscription();
  return sub ? sub.endpoint : '';
}

const keyBytes = (b64) => {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function enablePush() {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.reason);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('As notificações foram bloqueadas. Libere nas configurações do site (ícone ao lado do endereço) e tente de novo.');
  }
  const reg = await readyRegistration();
  if (!reg) throw new Error('Não foi possível preparar as notificações neste navegador.');
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  // Se a chave do servidor mudou, refaz a inscrição.
  if (sub && sub.options && sub.options.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const wanted = keyBytes(publicKey);
    if (current.length !== wanted.length || current.some((v, i) => v !== wanted[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// Ao entrar: se este aparelho já tinha notificações ligadas, avisa o servidor de novo
// (garante que estão ligadas para a conta que acabou de entrar).
export async function resyncPush() {
  const sub = await currentSubscription();
  if (sub && Notification.permission === 'granted') {
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
  }
}
