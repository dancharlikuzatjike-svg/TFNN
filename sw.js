// App-shell cache only. API calls (a different origin - your Render backend)
// are deliberately never intercepted here; the app itself handles those via
// the outbox in app.html, since a queued write needs real logic, not a cache.
const CACHE_NAME = 'tfnn-shell-v1';
const SHELL_FILES = ['./app.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let API calls pass through untouched

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ---- Push notifications ----
self.addEventListener('push', (event) => {
  let data = { title: 'TFNN', body: '' };
  try { data = event.data.json(); } catch (e) { /* keep default */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TFNN', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./app.html');
    })
  );
});
