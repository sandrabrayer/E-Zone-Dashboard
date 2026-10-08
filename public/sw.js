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
// v17 → v18: v17 is SKIPPED on purpose. It was PR #145's version; #146
// reverted that PR, and phones still hold a v17 cache, so reusing the number
// could leave them on it. The first public/ change after the revert ships as
// v18 and the activate step evicts both v16 and the orphaned v17.
// v18 → v19: a busy Apps Script lock ({ok:false, error:'lock_busy'}) is now
// retried once after 2 s and otherwise reported as «המערכת עסוקה, נסו שוב».
// app.js is the only asset that changed — evict v18 so no phone keeps a bundle
// that shows the server's English text and never retries.
// v19 → v20: the meetings summary strip, the meetingWith dropdowns and the
// per-house meetingWith default read the CURRENT managers (getData
// currentManagers); a saved former-manager value stays selectable. app.js is
// the only asset that changed — evict v19 so no phone keeps the old roster.
// v20 → v21: the credits modal takes its refund suggestion from the server
// (suggestRefunds → computeRefund_) and shows the breakdown; the old-rule
// suggestCredits is gone and the payout echo uses the 10th cutoff. app.js and
// style.css changed — evict v20 so no phone keeps suggesting old-rule refunds.
// v21 → v22: the גבייה payout view gains the refund payout forecast (ממתין
// להחלטה / חסרים נתוני תשלום) and the «ייצוא להנהלת חשבונות» CSV. app.js,
// index.html and style.css changed — evict v21 so no phone keeps the old view.
// v22 → v23: «ייצוא להנהלת חשבונות» downloads a server-built .xlsx from
// /api/export/refund-forecast.xlsx instead of a browser-built CSV. app.js
// changed — evict v22 so no phone keeps the CSV button. The export route is
// under /api/, so cacheStrategy() keeps it network-only (never cached).
// v23 → v24: the גבייה tab gains «חובות פתוחים» (debt aging as of a date,
// action=debtAging) and its «ייצוא לאקסל» from /api/export/debt-aging.xlsx.
// app.js, index.html and style.css changed — evict v23. The export is under
// /api/, so cacheStrategy() keeps it network-only (never cached).
// v24 → v25: every גבייה group gets its own colour (a bold heading with a
// 4px bar, a tinted panel and a matching chip); the refund view drops the
// missing-payment section for one line linking to «חובות פתוחים»; the export
// button reads «ייצוא זיכויים לאקסל». app.js, index.html and style.css
// changed — evict v24.
// v25 → v26: personal-PIN login (tap your name → 6-digit PIN), the shared-PIN
// banner and Sandra's «קוד אישי חדש». app.js, index.html and style.css
// changed — evict v25 so no phone keeps the 4-digit-only login. The login
// and every /api/ route (/api/verify-pin, /api/login-users, /api/me,
// /api/pin-admin/*) stay network-only: cacheStrategy() never caches /api/.
// v26 → v27: restricted view — Shiran and Yael do not get the four money tabs
// (גבייה, הכנסות חודשיות, שיוך תשלומים, גרף צמיחה) or any billing widget.
// app.js, index.html and style.css changed — evict v26 so no phone keeps the
// old shell. Every /api/ route stays network-only (never cached).
// v27 → v28: «ייצוא רשימת תיקונים» — a button next to the other exports on
// the גבייה tab downloads the data-cleanup workbook. app.js and index.html
// changed — evict v27. /api/export/cleanup.xlsx is under /api/, so
// cacheStrategy() keeps it network-only (never cached).
// v28 → v29: personal PINs PR C — the shared-code field, the «מי מתחבר/ת?»
// picker and the amber shared-session banner are gone; delete / void /
// cancel controls show only for a deleter, un-void only for Sandra. app.js,
// index.html and style.css changed — evict v28 so no phone keeps the shared
// login. Every /api/ route stays network-only (never cached).
// v29 → v30: Phase 3 PR 2 — the strict «דווח תשלום» form. The גבייה row's
// status dropdown and «שולם בפועל» box are gone; a row shows its derived
// state, its receipts and a «דווח תשלום» button; the patient card gains the
// funder editor. app.js, index.html, style.css changed and the page loads a
// new /payment-report-rules.js (network-first like app.js) — evict v29 so no
// phone keeps the old editable status. /api/ stays network-only.
// v31 → v32: (v31 is reserved by open PR #177; this evicts v30 or v31) patient funder on the Funders sheet — no default funder (an
// unset patient shows the amber «לא הוגדר»), the funder required at
// admission, «השלמת גורם מממן» and the funder filter + funder × house strip
// on גבייה, all finance-only. New script public/funder.js (precached,
// network-first like app.js); app.js, index.html and style.css changed —
// evict v30 (and v31 if #177 shipped first). appendFunder goes through /api/sheets, network-only.
// v32 → v33: Phase 4 — the «בקרת גבייה» tab (Ortal's verification queue,
// Sandra's «חריגים פתוחים»), the «מאומת» figure on הכנסות חודשיות and the
// controller view. app.js, index.html, style.css changed and the page loads a
// new /billing-control-rules.js (network-first like app.js) — evict v32 (and
// v30 / v31 on a phone that skipped them). (PR #179 was built as v31, then
// rebased onto #178's v32.)
// v33 → v34: coordinators roster (PR #177, built as v31, rebased onto
// #179's v33) — the dashboard gains the «🟢 קליטת מטופל חדש» intake button
// and the «🚪 שחרורים מהבתים» panel (discharges the coordinators recorded).
// app.js, index.html, style.css changed — evict v33 (and older). /api/ stays
// network-only.
// v36 → v37: (v35 / v36 are reserved by open PRs #181 / #182; this evicts
// v34, v35 or v36, whichever a phone has) pro-bono — the fifth funder
// «פרו-בונו» (funder.js keys/labels; app.js skips pro-bono rows in the due
// list, «יתרות פתוחות» and the renewal / overdue alerts). /api/ stays
// network-only.
// v37 → v38: (v35 / v36 / v37 are reserved by open PRs #181 / #182 / #183;
// this evicts v34–v37, whichever a phone has) the invoice on the payment
// report — «חשבונית?» כן / לא (no default) and «על שם» in the «דווח תשלום»
// form, shown on the receipts list and the «בקרת גבייה» card. app.js,
// style.css and /payment-report-rules.js changed. /api/ stays network-only.
// v38 → v39: perf (CHANGELOG-dashboard-perf.md; built as v18 in PR #149,
// rebased). index.html now links each JS/CSS file as `<file>?v=<its content
// hash>`; such a URL is served 'cache-first-hashed' (exact URL, no
// ignoreSearch — a new hash is a cache miss, so a deploy is never pinned),
// and older hashes of the same file are pruned. Unversioned requests stay
// network-first. app.js (the three reads start together) changed — evict
// v38. /api/ stays network-only.
// v39 → v40: «בקרת גבייה» status dropdown, partial amount, remaining
// balance, the note; Ortal reads «גבייה» (CHANGELOG-ortal-verification-status.md).
// v40 → v41: PR #145's reactivation fix, re-landed (CHANGELOG-reactivation-fix.md)
// — a patient set back to live via ✏️ / re-add / admission / restore no longer
// vanishes on the next load, and the load-time heal announces itself. app.js
// is the only asset that changed: index.html links it at its new content hash,
// so the 'cache-first-hashed' lookup misses and phones fetch the new bundle;
// activate evicts v40 and any orphaned v17 (#145's burned number, never reused).
// v41 → v42: «לא נקלט כמטופל · N ימים» on the lead card and its count on the
// לידים tab (CHANGELOG-unadmitted-lead-warning.md). app.js, index.html and
// style.css changed; hashed URLs miss and phones fetch them; activate evicts
// v41 (and any orphaned v17 — still burned, never reused).
// v42 → v43: duplicate discharges — «השחרור כבר נרשם», «מחק כפילות» on the
// מטופלים משוחררים tab (CHANGELOG-duplicate-discharges.md). app.js changed;
// its hashed URL misses and phones fetch it; activate evicts v42 (and any
// orphaned v17 — still burned, never reused).
// v43 → v44: receipts — the «אומתו» month-split line, «כפילות» in «בקרת
// גבייה», Vered's duplicate prompt and ✏️ on a receipt
// (CHANGELOG-receipt-duplicates-and-edit.md). app.js, style.css and
// billing-control-rules.js changed; activate evicts v43 (v17 never reused).
// v44 → v45: the «מטופלים» tab — the patient list, «ממתינים לקליטה», problem
// chips and «פרטי הליד» (CHANGELOG-patients-tab-ui.md). app.js, index.html and
// style.css changed; activate evicts v44 (v17 never reused).
// v45 → v46: refund rule v2 (CHANGELOG-refund-rule-v2.md) — every house: an
// exit on day 14+ of the billing month gets no refund (exits from 07/10/2026);
// the «זיכויים» modal shows the rule line and the billing-month day. app.js,
// style.css and index.html changed and the page loads a new /refund-rules.js
// (hashed like app.js); activate evicts v45 (v17 never reused).
// v46 → v47: the institutional-funder grace period (CHANGELOG-funder-grace.md)
// — a ביטוח לאומי / מכבי / משרד הביטחון cycle reads «ממתין לגורם מממן»
// (grey) for 30 days after its due date instead of overdue. app.js,
// style.css and index.html changed and the page loads a new /funder-grace.js
// (hashed like app.js); activate evicts v46 (v17 never reused).
// v47 → v48: «דוח תשלום» persistence (CHANGELOG-payment-report-persistence.md)
// — a stale getPayments can no longer overwrite a confirmed report, a failed
// one no longer wipes the money state, and every report carries an
// idempotency key. app.js changed; activate evicts v47 (v17 never reused).
// v48 → v49: the תקופת כיסוי cell on גבייה gains the month split
// (CHANGELOG-coverage-month-split.md — first written as a v17 bump in PR #137,
// renumbered: v17 is burned). app.js and style.css changed; activate evicts v48.
// v49 → v50: write-path hardening, money (CHANGELOG-write-path-hardening.md,
// PR A) — every money write is tracked in flight, guarded against stale reads
// and «saved» only with the server's row. app.js changed; activate evicts v49.
var CACHE_VERSION = 'v50';
var CACHE_NAME = 'ezone-dashboard-' + CACHE_VERSION;

// App-shell / static assets pre-cached on install. The shell HTML is included
// so the app can boot offline, but at runtime it is served network-first.
var PRECACHE_URLS = [
  '/',
  '/style.css',
  '/funder.js',
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
 *   'cache-first-hashed' — the JS/CSS bundle at `?v=<12-hex content hash>`
 *                     (what index.html links): those bytes can never change
 *                     under that URL, so the cached copy is served without a
 *                     network round trip. Matched by EXACT url.
 *   'network'       — everything else: pass through to the network. */
/* The JS/CSS files index.html links with a content hash (server.js ASSETS). */
var BUNDLE_PATHS = ['/app.js', '/style.css', '/payment-report-rules.js', '/funder.js', '/billing-control-rules.js', '/refund-rules.js', '/funder-grace.js'];

/* True for `?v=<exactly 12 lowercase hex>` — the server's content hash. The
 * old `?v=<BUILD_ID>` (digits-dash-base36) never matches. Pure. */
function isContentHashUrl(url) {
  try {
    return /^[0-9a-f]{12}$/.test(new URL(url, 'http://localhost').searchParams.get('v') || '');
  } catch (e) {
    return false;
  }
}

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

  // Shell: network-first (offline fallback only).
  if (path === '/' || path === '/index.html') return 'network-first';

  // JS/CSS bundle: cache-first at its content hash, network-first otherwise.
  if (BUNDLE_PATHS.indexOf(path) !== -1) {
    return isContentHashUrl(url) ? 'cache-first-hashed' : 'network-first';
  }

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
    isContentHashUrl: isContentHashUrl,
    cacheFirstHashed: cacheFirstHashed,
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

/* CACHE-FIRST BY EXACT URL for a content-hashed bundle file. A hit is served
 * with no network at all. A miss fetches, stores, and deletes every OTHER
 * cached copy of the same path (an older hash), so the cache holds one copy
 * per file no matter how many deploys happen within one CACHE_VERSION.
 * Offline with a miss: the last copy of that path (ignoreSearch), else
 * Response.error(). Always resolves to a Response. */
function cacheFirstHashed(req) {
  var url = req.url || String(req);
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(req, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          cache.put(req, copy).then(function () {
            return pruneOtherVersions(cache, url);
          }).catch(function () { /* cache write is best-effort */ });
        }
        return res;
      }, function () {
        return cache.match(req, { ignoreSearch: true, ignoreVary: true }).then(function (old) {
          return old || Response.error();
        });
      });
    });
  }).catch(function () {
    return Response.error();
  });
}

/* Delete cached entries with the same pathname as `url` but another query. */
function pruneOtherVersions(cache, url) {
  var keep = new URL(url, 'http://localhost');
  return cache.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      var u = new URL(k.url, 'http://localhost');
      return (u.pathname === keep.pathname && u.search !== keep.search) ? cache.delete(k) : false;
    }));
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

  if (strategy === 'cache-first-hashed') {
    event.respondWith(cacheFirstHashed(req));
    return;
  }
});
