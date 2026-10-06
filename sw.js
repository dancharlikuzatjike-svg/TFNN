// App-shell cache only. API calls (a different origin - your Render backend)
// are deliberately never intercepted here; the app itself handles those via
// the outbox in app.html, since a queued write needs real logic, not a cache.
const CACHE_NAME = 'tfnn-shell-v3';
const SHELL_FILES = ['./', './index.html', './app.html', './manifest.json', './icon-192.png', './icon-512.png', './emblem.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache each file on its own so one missing file can never abort the whole install
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})))
    )
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

  // Network-first, fall back to cache when offline, so fixes reach users right away
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok && event.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
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
