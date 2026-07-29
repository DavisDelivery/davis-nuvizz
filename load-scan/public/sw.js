/* load-scan service worker.
 *
 * Deliberately conservative — a dock scanner that serves a STALE build is worse
 * than one that needs a network round-trip:
 *
 *   • Navigations (the HTML shell) are NETWORK-FIRST. A fresh deploy is picked up
 *     on the next load; the cached shell is only used when the network fails, so
 *     the app still opens in a dead zone in the yard.
 *   • Vite's /assets/* files are content-hashed, so their URL changes whenever the
 *     bytes change. Those are safe to serve CACHE-FIRST — permanently.
 *   • Everything else (API + function calls) is never cached. Scan state must never
 *     come from disk.
 *
 * skipWaiting + clients.claim mean a new SW takes over on the next load instead of
 * waiting for every tab to close — which, on a phone that never closes tabs, is
 * effectively never.
 */
const CACHE = 'load-scan-v1';
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache function/API traffic.
  if (url.pathname.startsWith('/.netlify/')) return;

  // App shell / client-routed pages → network first, cached shell as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Content-hashed build output → cache first, fill on miss.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
            }
            return res;
          }),
      ),
    );
  }
});
