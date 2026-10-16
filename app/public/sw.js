// Service worker do Nexo: deixa o app instalável, abre mais rápido e mostra
// as notificações push mesmo com o Nexo fechado.
const CACHE = 'nexo-v18';
const SHARE_CACHE = 'nexo-share'; // o que foi compartilhado da galeria espera aqui até o app abrir
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png',
  '/js/main.js', '/js/util.js', '/js/state.js', '/js/home.js', '/js/settings.js', '/js/emoji.js',
  '/js/voice.js', '/js/developer.js', '/js/markdown.js', '/js/theme.js', '/js/pwa.js', '/js/qr.js',
  '/js/sortable.js', '/js/account.js', '/js/extras.js', '/js/forum.js', '/js/commands.js', '/js/tts.js',
  '/js/profile.js', '/js/callsounds.js', '/js/levelsui.js', '/js/share.js', '/js/admin.js', '/js/updates.js',
  '/js/translate.js', '/js/economy.js', '/js/catchup.js', '/js/idle.js', '/js/comunidade.js', '/js/clips.js', '/js/avisos.js',
  '/js/devices.js', '/js/events.js', '/js/gifs.js', '/js/more.js', '/js/remote.js', '/js/serverx.js', '/js/sounds.js',
  '/socket.io/socket.io.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== SHARE_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Sempre tenta a rede primeiro (assim uma atualização do Nexo aparece na hora);
// o cache só é usado quando a internet cai.
const NEVER_CACHE = /^\/(api|files|avatars|link-image|vendor)\/|^\/socket\.io\/(?!socket\.io\.js)/;
// "Compartilhar → Nexo" na galeria do celular: o sistema manda um POST com as fotos.
// Guardamos tudo e abrimos o app, que pergunta para qual conversa mandar.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0).slice(0, 10);
    const meta = {
      at: Date.now(),
      title: String(form.get('title') || '').slice(0, 300),
      text: String(form.get('text') || '').slice(0, 2000),
      url: String(form.get('url') || '').slice(0, 2000),
      files: files.map((f, i) => ({ key: `/compartilhado/${i}`, name: f.name || `arquivo-${i + 1}`, type: f.type || 'application/octet-stream', size: f.size })),
    };
    await Promise.all(files.map((f, i) => cache.put(`/compartilhado/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
    await cache.put('/compartilhado/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/?compartilhar=1', 303);
  } catch {
    return Response.redirect('/?compartilhar=falhou', 303);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname === '/compartilhar') {
    event.respondWith(receiveShare(req));
    return;
  }
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
  // Mensagem: botões "Responder" (com caixa de texto onde o aparelho deixa) e "Marcar como lida".
  const actions = data.reply ? [
    { action: 'reply', title: '↩️ Responder', type: 'text', placeholder: 'Escreva a resposta…' },
    { action: 'read', title: '✔️ Marcar como lida' },
  ] : call ? [{ action: 'open', title: '📞 Atender' }] : [];
  event.waitUntil(self.registration.showNotification(data.title || 'Nexo', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/', reply: data.reply || null },
    actions,
    requireInteraction: call,
    vibrate: call ? [300, 150, 300, 150, 300] : [120, 60, 120],
  }));
});

const postJson = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const nd = event.notification.data || {};
  // Respondeu direto na notificação (computador/Android com caixa de texto).
  if (event.action === 'reply' && nd.reply && event.reply) {
    event.waitUntil(postJson('/api/push/reply', { token: nd.reply, content: String(event.reply).slice(0, 4000) })
      .then((res) => self.registration.showNotification(res.ok ? '✅ Resposta enviada' : '⚠️ Não deu para responder', {
        body: res.ok ? event.reply : 'Abra o Nexo para responder.', tag: 'resposta', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', silent: true,
      }))
      .catch(() => {}));
    return;
  }
  if (event.action === 'read' && nd.reply) {
    event.waitUntil(postJson('/api/push/read', { token: nd.reply }).catch(() => {}));
    return;
  }
  // "Responder" sem caixa de texto: abre o Nexo já pronto para escrever.
  const url = event.action === 'reply' ? `${nd.url || '/'}${(nd.url || '/').includes('?') ? '&' : '?'}responder=1` : (nd.url || '/');
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
