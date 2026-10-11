// Service worker do Nexo: deixa o app instalável, abre mais rápido e mostra
// as notificações push mesmo com o Nexo fechado.
const CACHE = 'nexo-v7';
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png',
  '/js/main.js', '/js/util.js', '/js/state.js', '/js/home.js', '/js/settings.js', '/js/emoji.js',
  '/js/voice.js', '/js/developer.js', '/js/markdown.js', '/js/theme.js', '/js/pwa.js', '/js/qr.js',
  '/js/sortable.js', '/js/account.js', '/js/extras.js', '/socket.io/socket.io.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Sempre tenta a rede primeiro (assim uma atualização do Nexo aparece na hora);
// o cache só é usado quando a internet cai.
const NEVER_CACHE = /^\/(api|files|avatars|link-image|vendor)\/|^\/socket\.io\/(?!socket\.io\.js)/;
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;
  const isPage = req.mode === 'navigate';
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (isPage || SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(isPage ? '/' : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(isPage ? '/' : req);
      if (cached) return cached;
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const call = data.kind === 'call';
  event.waitUntil(self.registration.showNotification(data.title || 'Nexo', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
    requireInteraction: call,
    vibrate: call ? [300, 150, 300, 150, 300] : [120, 60, 120],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'nexo:open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
