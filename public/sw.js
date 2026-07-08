/* E-Zone Dashboard service worker.
 *
 * Caching policy (PR 1 — PWA foundation):
 *  - NETWORK-ONLY for any request whose URL contains "sheets" or hits the
 *    "/api/" path. Patient/lead data is NEVER written to the cache, so an
 *    offline device can never surface stale clinical data.
 *  - NETWORK-FIRST for the app shell (index.html / "/"). The HTML is
 *    __BUILD__-substituted per deploy, so it must never be served stale while
 *    online; the cached copy is only a fallback when the network is gone.
 *  - CACHE-FIRST for versioned static assets (app.js, style.css, icons,
 *    manifest). These are safe to serve from cache and refresh in the
 *    background on the next successful fetch.
 *
 * The cache name is versioned; bump CACHE_VERSION to invalidate. Old caches
 * are deleted on activate.
 *
 * shouldCache(url) is the single source of truth for "is this a cacheable
 * static asset?" and is exported for unit testing (see
 * test/pwa-foundation.test.js).
 */

// Bump on any static-asset change (icons, style.css, shell) so old caches are
// purged on activate. v1 → v2: PWA follow-up (icon parity + RTL/overflow CSS).
// v2 → v3: icon rebrand (white bg + #5b8bff letter) — evict old green icons.
// v3 → v4: bold geometric E redrawn — #0055ff letter with a white halo on the
// original dark #071410 background — evict the old v3 icons.
var CACHE_VERSION = 'v4';
var CACHE_NAME = 'ezone-dashboard-' + CACHE_VERSION;

// App-shell / static assets pre-cached on install. The shell HTML is included
// so the app can boot offline, but at runtime it is served network-first.
var PRECACHE_URLS = [
  '/',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

/* Decide whether a request URL is a cacheable static asset.
 * Returns false (network-only) for anything data-bearing: any URL containing
 * "sheets" or the "/api/" path is never cached. The HTML shell ("/",
 * "/index.html") is intentionally NOT cache-first — it is handled
 * network-first in fetch — so shouldCache returns false for it too.
 * Pure function of the URL string; no globals, so it is unit-testable. */
function shouldCache(url) {
  var path;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch (e) {
    return false;
  }

  // Never cache data endpoints or anything mentioning sheets.
  if (url.indexOf('sheets') !== -1) return false;
  if (path.indexOf('/api/') !== -1) return false;

  // The shell is network-first, not cache-first.
  if (path === '/' || path === '/index.html') return false;

  // Cacheable static assets.
  if (path === '/app.js') return true;
  if (path === '/style.css') return true;
  if (path === '/manifest.json') return true;
  if (path.indexOf('/icons/') === 0) return true;

  return false;
}

// Expose for the test harness (Node vm sandbox) without affecting the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shouldCache: shouldCache, CACHE_NAME: CACHE_NAME, CACHE_VERSION: CACHE_VERSION };
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll is atomic-ish; ignore individual failures so a single 404
      // (e.g. an icon rename) doesn't block the whole install.
      return Promise.all(PRECACHE_URLS.map(function (u) {
        return cache.add(u).catch(function () { /* non-fatal */ });
      }));
    })
  );
  // Activate this SW immediately without waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () {
      // Take control of all open clients right away.
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET; let the browser do POST/PUT etc. straight to network.
  if (req.method !== 'GET') return;

  var url = req.url;
  var path;
  try {
    path = new URL(url).pathname;
  } catch (e) {
    return;
  }

  // NETWORK-ONLY for data endpoints and anything mentioning sheets.
  if (url.indexOf('sheets') !== -1 || path.indexOf('/api/') !== -1) {
    return; // fall through to the network; never touch the cache
  }

  // NETWORK-FIRST for the app shell so per-deploy HTML is never stale.
  if (path === '/' || path === '/index.html') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put('/', copy); });
        return res;
      }).catch(function () {
        return caches.match('/').then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  // CACHE-FIRST for versioned static assets.
  if (shouldCache(url)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything else: default to the network.
});
