/* E-ZONE service worker — minimal offline support for the managers app.
 *
 * Strategy:
 *   - Static shell (HTML, CSS, JS, icons) → stale-while-revalidate so
 *     the app loads instantly and updates in the background.
 *   - /api/sheets → network-only. We never want managers to see stale
 *     bonus figures from a previous month sitting in the SW cache.
 *   - Anything else → network-first with a cache fallback.
 */

const VERSION = 'v3';
const CACHE_NAME = 'ezone-shell-' + VERSION;
const PRECACHE = [
  '/managers',
  '/managers.html',
  '/managers.css',
  '/managers.js',
  '/style.css',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API responses — bonus data must be fresh.
  if (url.pathname.startsWith('/api/')) return;

  // Stale-while-revalidate for same-origin static assets.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
