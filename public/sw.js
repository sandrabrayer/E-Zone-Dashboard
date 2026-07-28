/* E-Zone Dashboard service worker.
 *
 * Caching policy:
 *  - NETWORK-ONLY for any request whose URL contains "sheets" or hits the
 *    "/api/" path. Patient/lead data is NEVER written to the cache, so an
 *    offline device can never surface stale clinical data.
 *  - NETWORK-FIRST for the app shell (index.html / "/") AND the JS/CSS bundle
 *    (app.js, style.css). All three change per deploy; the cached copy is only
 *    an OFFLINE fallback. (Previously app.js/style.css were cache-first with
 *    ignoreSearch, which ignored the `?v=__BUILD__` cache-bust and pinned
 *    clients to a stale bundle across deploys — fixed here.)
 *  - CACHE-FIRST for truly versioned-by-filename assets: icons and manifest.
 *    Icons change filename on a rebrand and the manifest rarely changes; both
 *    are evicted wholesale by bumping CACHE_VERSION.
 *
 * The cache name is versioned; bump CACHE_VERSION to invalidate. Old caches
 * are deleted on activate.
 *
 * cacheStrategy(url) is the single source of truth for how a request is routed
 * ('network-only' | 'network-first' | 'cache-first' | 'network'); shouldCache(url)
 * is the derived "is this cache-first?" boolean. Both are exported for unit
 * testing (see test/pwa-foundation.test.js and test/sw-cache-strategy.test.js).
 */

// Bump on any static-asset change (icons, style.css, shell) so old caches are
// purged on activate. v1 → v2: PWA follow-up (icon parity + RTL/overflow CSS).
// v2 → v3: icon rebrand (white bg + #5b8bff letter) — evict old green icons.
// v3 → v4: icon redesign — the original E-Zone brand logo recoloured to #0055ff
// with a white contour halo on the original dark #071410 background — evict the
// old v3 icons.
// v4 → v5: cache-strategy change — app.js/style.css move from cache-first to
// network-first; bump to evict any bundle pinned in a v4 cache under the old
// cache-first + ignoreSearch policy.
var CACHE_VERSION = 'v5';
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

/* Route a request URL to a caching strategy. Pure function of the URL string
 * (no globals), so it is unit-testable and is the single source of truth for
 * the fetch handler below. Returns one of:
 *   'network-only'  — data endpoints ("sheets" / "/api/"): never touch the cache.
 *   'network-first' — the shell ("/", "/index.html") and the JS/CSS bundle
 *                     (app.js, style.css): always try the network so a new
 *                     deploy is picked up immediately; cache is an OFFLINE-only
 *                     fallback. This is what fixes the stale-bundle pin.
 *   'cache-first'   — versioned-by-filename assets (icons, manifest).
 *   'network'       — everything else: pass through to the network. */
function cacheStrategy(url) {
  var path;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch (e) {
    return 'network';
  }

  // Data endpoints: never cached.
  if (url.indexOf('sheets') !== -1) return 'network-only';
  if (path.indexOf('/api/') !== -1) return 'network-only';

  // Shell + JS/CSS bundle: network-first (offline fallback only).
  if (path === '/' || path === '/index.html') return 'network-first';
  if (path === '/app.js' || path === '/style.css') return 'network-first';

  // Truly versioned-by-filename static assets: cache-first.
  if (path === '/manifest.json') return 'cache-first';
  if (path.indexOf('/icons/') === 0) return 'cache-first';

  return 'network';
}

/* Derived "is this served cache-first?" boolean. Kept as a named export because
 * the test harness and callers reason in terms of it. */
function shouldCache(url) {
  return cacheStrategy(url) === 'cache-first';
}

// Expose for the test harness (Node vm sandbox) without affecting the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cacheStrategy: cacheStrategy,
    shouldCache: shouldCache,
    CACHE_NAME: CACHE_NAME,
    CACHE_VERSION: CACHE_VERSION,
  };
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

/* NETWORK-FIRST: always try the network; on success refresh the cache, on
 * failure (offline) fall back to whatever we have cached. `cacheKey` lets the
 * shell normalize to '/' (its precached key) regardless of the requested path;
 * the offline fallback uses ignoreSearch so a `?v=` mismatch still resolves to
 * the last-cached bundle when the network is gone. */
function networkFirst(req, cacheKey) {
  var key = cacheKey || req;
  return fetch(req).then(function (res) {
    if (res && res.status === 200) {
      var copy = res.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(key, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(key, { ignoreSearch: true }).then(function (hit) {
      return hit || Response.error();
    });
  });
}

/* CACHE-FIRST: serve the cached copy if present, else fetch and cache it. */
function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET; let the browser do POST/PUT etc. straight to network.
  if (req.method !== 'GET') return;

  var strategy = cacheStrategy(req.url);

  // NETWORK-ONLY (data endpoints) and the default: let the browser hit the
  // network; never touch the cache.
  if (strategy === 'network-only' || strategy === 'network') return;

  if (strategy === 'network-first') {
    var path;
    try { path = new URL(req.url).pathname; } catch (e) { path = ''; }
    // The shell caches/serves under its precached '/' key; the bundle uses req.
    var key = (path === '/' || path === '/index.html') ? '/' : req;
    event.respondWith(networkFirst(req, key));
    return;
  }

  if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(req));
    return;
  }
});
