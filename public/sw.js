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
// v5 → v6: name-picker overlay + whoami header (index.html/style.css/app.js).
// v6 → v7: the manager report's פירוט cap goes 2,000 → 5,000 chars — app.js,
// style.css and the meeting-report page assets all changed, so evict v6.
// v7 → v8: the wa.me share link's cap is fixed (encoded-length arithmetic) —
// meeting-report.js changed, so no phone may keep serving the v7 copy that
// still cuts a 400-char report down to ~260.
// v8 → v9: the shared loading-spinner pattern — busyButton() + the .is-busy
// spinner land in app.js, meeting-report.js, style.css AND meeting-report.css,
// so every cached copy of all four must go.
// v9 → v10: the spinner glyph fix. v9 precached a /style.css whose busy ring was
// faded to invisibility by the :disabled rule, and that copy is still the
// OFFLINE fallback on any device that installed v9 — evict it so no phone can
// fall back to the broken ring.
// v10 → v11: «קשר למטופל» becomes a dropdown — app.js changed (the option list,
// the אחר free-text escape and the legacy-value pinning all live there), so no
// phone may keep serving the v10 bundle that still renders a free-text input.
// v11 → v12: the loading-feedback rollout. busyButton now drives every button
// action and a new inline marker covers the [data-field] autosave, so app.js,
// meeting-report.js and style.css all changed — evict v11 so no phone keeps
// serving a bundle where half the actions still give no feedback at all.
// v12 → v13: the optimistic-trigger gap. v12 wired the stage buttons, the
// patient delete and the two billing-override buttons through busyButton, but
// each of those workers re-renders before it awaits, so that busy state was
// measured painting in 0 of ~90 frames. app.js now raises the page-level
// banner for those four round-trips — evict v12 so no phone keeps serving a
// bundle where they still look inert.
// v13 → v14: the native date/month picker icon. style.css now declares
// `color-scheme: dark` on every <input type="date"|"month"> and repaints the
// WebKit calendar indicator in --primary, so the glyph is no longer drawn
// near-black on the near-black field. style.css is the only file that changed
// and it is the OFFLINE fallback on any device that installed v13 — evict it so
// no phone keeps serving the copy where the גבייה / הכנסות חודשיות pickers still
// have an invisible icon.
// v14 → v15: the stuck-install fix. No v14 cache was ever POPULATED — every
// precache write was rejected by the Cache API (`Vary: *`, see the install
// handler below), so v5…v14 exist on every installed device as EMPTY shells
// that activate never got to delete. The bump forces a clean current name, and
// the now-reachable activate purges all of them on the first load after deploy.
// v15 → v16: every displayed date becomes DD/MM/YYYY (formatDateHe). app.js is
// the only file that changed, and the v15 copy is the OFFLINE fallback on any
// device that installed it — evict it so no phone keeps rendering ISO dates.
var CACHE_VERSION = 'v16';
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

/* INSTALL — must ALWAYS settle.
 *
 * The bug this replaces: the old handler ran six concurrent `cache.add()`
 * calls on one Cache and swallowed each rejection with `.catch(){}`. Every one
 * of those adds was rejected by the Cache API with
 *   TypeError: Failed to execute 'add' on 'Cache': Vary header contains *
 * because server.js stamped `Vary: *` on every response. Concurrent failing
 * adds on the same Cache left the last three (the icons) permanently
 * unsettled, so `Promise.all` never settled, `event.waitUntil()` stayed
 * pending, and the worker sat in `installing` forever — which meant `activate`
 * never ran and no old cache was ever deleted. The per-add `.catch()`, written
 * to make a single 404 non-fatal, is what hid the real error for ten versions.
 *
 * The rule now: this promise ALWAYS settles.
 *   - one `cache.addAll(PRECACHE_URLS)` — one operation, one promise;
 *   - a precache failure is logged and SWALLOWED ON PURPOSE, so the worker
 *     still reaches `activate` and still purges the stale caches. Losing the
 *     offline shell is a degraded PWA; never activating is a broken one, and
 *     that is the failure we are fixing. test/sw-install-fix.test.js is what
 *     catches a bad precache list — at CI time, not on a user's phone;
 *   - `skipWaiting()` is awaited INSIDE waitUntil so activation follows the
 *     precache deterministically. */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .catch(function (err) {
        // Never leave waitUntil pending. Activate anyway: the cache cleanup
        // below matters more than the offline fallback.
        console.error('[sw] precache failed, activating without it:', err);
      })
      .then(function () {
        // Activate immediately without waiting for old tabs to close.
        return self.skipWaiting();
      })
  );
});

/* ACTIVATE — delete EVERY cache that is not the current one, then claim.
 * Unchanged in behaviour; it simply never got to run before. On the first load
 * after this deploy it is what clears the v5…v14 pile-up. */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE_NAME ? Promise.resolve(false) : caches.delete(key);
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
      // Fire-and-forget, but NEVER unguarded: cache.put rejects for a
      // redirected or opaque response and when the quota is exhausted, and an
      // unhandled rejection inside a worker that now actually runs is noise
      // at best. A failed refresh must not disturb the response we return.
      caches.open(CACHE_NAME)
        .then(function (cache) { return cache.put(key, copy); })
        .catch(function () { /* cache refresh is best-effort */ });
    }
    return res;
  }).catch(function () {
    // Offline. Serve the last-cached copy; if there is none, a proper network
    // error — never undefined, which respondWith() would treat as a bug.
    return caches.match(key, { ignoreSearch: true }).then(function (hit) {
      return hit || Response.error();
    }).catch(function () { return Response.error(); });
  });
}

/* CACHE-FIRST: serve the cached copy if present, else fetch and cache it.
 *
 * ALWAYS RESOLVES TO A RESPONSE. The miss-plus-offline path used to have no
 * catch at all: `fetch` rejected, the rejection propagated out of cacheFirst,
 * and the promise handed to event.respondWith() rejected — an unhandled
 * rejection in the worker and a bare network error in the page. It never
 * returned undefined, but it was not a graceful fallback either. It now
 * degrades the same way networkFirst does: cached copy → network →
 * Response.error(). This path was unreachable for ten versions because the
 * worker never activated; it is reachable now. */
function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE_NAME)
          .then(function (cache) { return cache.put(req, copy); })
          .catch(function () { /* cache write is best-effort */ });
      }
      return res;
    });
  }).catch(function () {
    // Cache miss AND the network is gone (or the cache lookup itself failed).
    return Response.error();
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
