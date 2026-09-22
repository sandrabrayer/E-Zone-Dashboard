# The service worker never finished installing

**Symptom (live, https://ezone-dashboard.up.railway.app).** After Unregister +
hard refresh the registration read `active: none, waiting: none, installing:
"installing"` — and stayed there. CacheStorage held ten caches,
`ezone-dashboard-v4` through `v14`, none of them ever deleted. Every static
asset returned 200 when fetched with `no-store`, so a missing precache file was
never the cause.

---

## 1. Root cause

**`server.js` stamped `Vary: *` on every response, and the Cache API refuses to
store a response whose `Vary` header contains `*`.**

`noCache()` — applied globally at `app.use((_req, res, next) => { noCache(res); next(); })`
— set six headers, the last of which was `res.set('Vary', '*')`. Per the Cache
API spec, `Cache.add` / `Cache.addAll` / `Cache.put` must reject with a
`TypeError` for such a response. Chromium's message is literal:

```
TypeError: Failed to execute 'add' on 'Cache': Vary header contains *
```

So **not one precache write could ever succeed**, for any of the six URLs. That
alone explains the empty caches. The *hang* came from how the old install
handler reacted:

```js
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
  self.skipWaiting();
});
```

Six `cache.add()` calls issued **concurrently against one `Cache`**, each
rejection swallowed by an empty `.catch()`. Instrumenting the real worker in
Chromium shows exactly where it stops — all six adds start, three reject, and
**the last three never settle at all**:

```
[SW] PROBE install: enter
[SW] PROBE install: cache opened
[SW] PROBE add start /            … /style.css … /manifest.json
[SW] PROBE add start /icons/icon-192.png … icon-512 … icon-maskable-512
[SW] PROBE add REJECTED /               :: TypeError: … Vary header contains *
[SW] PROBE add REJECTED /style.css      :: TypeError: … Vary header contains *
[SW] PROBE add REJECTED /manifest.json  :: TypeError: … Vary header contains *
   (the three icon adds never settle — no OK, no REJECTED)
t+1s … t+11s  {"installing":"installing","waiting":null,"active":null}
```

The concurrent failures leave the queued-behind operations permanently
unsettled, so `Promise.all` never settles → `event.waitUntil()` stays pending →
the worker sits in `installing` forever. The server log confirms it from the
other side: only four of the six precache URLs are ever requested.

**And because `install` never completed, `activate` never ran** — which is why
the old-cache cleanup never ran and v4…v14 piled up. The caches existed because
`caches.open(CACHE_NAME)` succeeds at the *start* of install; they were all
empty.

The empty `.catch()`, written to make a single 404 non-fatal, is what hid a
systematic `TypeError` for ten cache versions.

### Ruled out, explicitly

- **Not a missing precache file.** All six return 200; the new tests assert
  every entry exists under `public/` and has an explicit `server.js` route.
- **Not the PIN gate.** `requireSession` is applied per-route to `/api/*` only.
  `app.get('/sw.js', sendStatic('sw.js', 'application/javascript'))` is
  registered plainly: **200**, `Content-Type: application/javascript`,
  `Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private`, no
  auth middleware, no redirect. Same for `/`, `/style.css`, `/manifest.json`
  and the three icons. All asserted against the running server.
- **Not a redirect / credentials mismatch.** `fetch` reports
  `redirected=false, type=basic` for every precache URL.
- **Not `Cache-Control: no-store`.** The Cache API deliberately ignores HTTP
  cache semantics; the probe below stores the identical `no-store` responses
  fine once `Vary: *` is gone.
- **Not a regression in `sw.js`.** The install handler is byte-identical to the
  oldest version in this branch's history (`v5`); only the version string ever
  changed. The trigger was on the server.

---

## 2. The fix

### `server.js` — drop `Vary: *` (this is what unblocks the Cache API)

`noCache()` no longer sets it. **Nothing is weakened.** `Vary: *` only ever
told a *shared* cache "never reuse this for anyone" — which the remaining
directives already say, more explicitly and to more caches:

| header | says |
|---|---|
| `Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private` | do not store it, never serve it without revalidating, never in a shared cache |
| `Surrogate-Control: no-store` | the same, to Fastly-class surrogates |
| `CDN-Cache-Control: no-store` | the same, to CDNs generally |
| `Cloudflare-CDN-Cache-Control: no-store` | the same, to Cloudflare |
| `Pragma: no-cache`, `Expires: 0` | the HTTP/1.0 belt-and-braces |

`Vary: *` added no protection on top of `no-store`. It broke the one cache the
app actually wants — its own offline shell.

### `public/sw.js` — install must always settle

```js
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .catch(function (err) {
        console.error('[sw] precache failed, activating without it:', err);
      })
      .then(function () { return self.skipWaiting(); })
  );
});
```

- **One `cache.addAll(PRECACHE_URLS)`** — one operation, one promise. No array
  of concurrent adds that can strand each other.
- **A precache failure is logged and swallowed on purpose**, and the worker
  proceeds to `skipWaiting()`. This is a deliberate reading of "install must
  always resolve or reject": losing the offline shell is a *degraded* PWA;
  never activating is a *broken* one, and never activating is precisely the bug
  being fixed. With `addAll` rejecting hard the worker would never install, so
  the stale caches would still never be purged. A bad precache list is caught
  by `test/sw-install-fix.test.js` at CI time instead — not on a user's phone.
- **`skipWaiting()` is awaited inside `waitUntil`**, so activation follows the
  precache deterministically instead of racing it.

`activate` is unchanged in behaviour — it deletes every cache whose name is not
`CACHE_NAME`, then `clients.claim()`. It simply never got to run before.

**The `/api/` fetch strategy is untouched.** `cacheStrategy()` still routes
anything matching `sheets` or `/api/` to `network-only`; patient and lead data
still never reach the cache. Asserted by test.

### Cache version: **`v14` → `v15`**

No `v14` cache was ever *populated*, so the bump is not about evicting stale
content — it is about leaving a clean current name while the now-reachable
`activate` purges the ten empty shells (`v4`…`v14`) that accumulated on every
installed device.

---

## 3. Stale-cache cleanup

On the first load after deploy, the worker installs, activates, and `activate`
deletes every cache except `ezone-dashboard-v15`. **No user action is needed** —
no Unregister, no hard refresh, no "clear site data". Verified in Chromium
against the real `server.js`, seeding the exact pile-up the live site reported:

```
seeded caches: [v4, v5, v6, v7, v8, v9, v10, v11, v13, v14, v15]
t+0s {"installing":null,"waiting":null,"active":null}
t+1s {"installing":null,"waiting":null,"active":"activated"}
FINAL CACHES: {
  "ezone-dashboard-v15": [
    "/", "/icons/icon-192.png", "/icons/icon-512.png",
    "/icons/icon-maskable-512.png", "/manifest.json", "/style.css"
  ]
}
VERIFIED: activated, 1 cache, 6 precached entries, stale caches purged.
```

Before the fix the same run produced `{"installing":"installing"}` at every
sample and `{"ezone-dashboard-v14": []}`.

---

## 3b. Pre-merge review of the fetch handler

The worker has not controlled a page in ten versions, so every routing path
below was unreachable in practice and is reachable from the next deploy on.
Reviewed against `cacheStrategy()` and the `fetch` listener:

| request | strategy | verdict |
|---|---|---|
| `/`, `/index.html` (the shell) | **network-first** | already correct — a deploy can never be masked by a stale shell; the cache is an offline-only fallback keyed to the precached `'/'` |
| any other navigation (`/meeting-report`, …) | `network` | not intercepted at all; no shell is ever substituted |
| `/style.css`, `/app.js` | **network-first** | already correct, so **no version-bump-pinning test is needed** — the cached copy is only the offline fallback, never the served bundle. This is the simpler of the two options the review offered, and it is what the code already does. |
| `/manifest.json`, `/icons/*` | cache-first | correct: versioned by filename, evicted wholesale by the version bump |
| `/api/*`, any URL containing `sheets` | **network-only** | `return`s before `respondWith`, so the worker never touches the request and no cache write is reachable. Patient and lead data still never land in a cache. |
| any non-GET | — | returned before the strategy is consulted |

**One real defect found and fixed: `cacheFirst` did not degrade gracefully.**
On a cache miss with the network down, `fetch(req)` rejected and nothing caught
it, so the promise handed to `event.respondWith()` *rejected* — an unhandled
rejection inside the worker and a bare network error in the page. It never
returned `undefined`, but it was not a graceful fallback either. It now ends
the same way `networkFirst` already did:

```js
  }).catch(function () {
    // Cache miss AND the network is gone (or the cache lookup itself failed).
    return Response.error();
  });
```

Also hardened, for the same "it actually runs now" reason: both fire-and-forget
`cache.put` calls are wrapped in their own `.catch()`. `cache.put` rejects for a
redirected or opaque response and when the storage quota is exhausted; an
unhandled rejection in a live worker is noise at best, and a failed cache
refresh must never disturb the response being returned.

`CACHE_VERSION` is **not** bumped again for this — `v15` has not shipped; it is
still the same unreleased worker.

## 3c. `noCache()` after removing `Vary: *`

Confirmed against the running server, not by reading the source: every response
— the precached statics, `/sw.js`, `/app.js`, a data endpoint's 401, `/healthz`
and the 404 fallback — still carries

```
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private
Pragma: no-cache
Expires: 0
Surrogate-Control: no-store
CDN-Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
```

`/api/*` is unchanged: `no-store` **and** `private`, and still 401 without a
session. Pinned by `test E: noCache() still sets no-store, no-cache AND private
on every response`, which asserts all six headers on thirteen representative
paths and that `app.use((_req, res, next) => { noCache(res); next(); })` still
runs before every route.

---

## 4. Tests

### `test/sw-install-fix.test.js` — 19 tests (node, no browser)

Loads the real `public/sw.js` in a vm sandbox that **captures** the `install`
and `activate` handlers, then drives each one and awaits its `waitUntil`
promise **under a 2-second race**, so "never settles" fails the test instead of
hanging the run.

- **A** every precache path exists under `public/` (`/` → `public/index.html`),
  and each has an explicit `server.js` route rather than falling to the 404.
- **B** no precache entry is an `/api/` route, a `sheets` URL, or served behind
  `requireSession` / `requireMeetingReportSession`; and `cacheStrategy()` still
  returns `network-only` for `/api/sheets`, `/api/me` and the Apps Script URL.
- **C** install **settles**, precaches through one `cache.addAll`, calls
  `skipWaiting` exactly once, opens exactly the current cache name; it still
  settles when `addAll` rejects; and the per-entry `cache.add` loop with its
  empty `catch` is gone from the source.
- **D** activate deletes every non-current cache (driven with the real v4…v14
  pile-up plus an unrelated cache, derived so it stays a guard at any version),
  never deletes the current one, and calls `clients.claim()` once; plus the
  version is off `v14`.
- **E** boots the **real `server.js`** on an ephemeral port: `/sw.js` returns
  **200 with no cookie** (not PIN-gated), `Content-Type: */javascript`,
  `Cache-Control` containing `no-cache`; **no response carries `Vary: *`**;
  every precache URL is reachable unauthenticated and storable; all six
  no-cache headers survive on thirteen representative paths (§3c); and
  `/api/sheets` + `/api/me` still return **401** unauthenticated.
- **F** the fetch handler, driven end to end against a fake network and cache
  (§3b): the shell and `/style.css` + `/app.js` are served from the **network**
  even when a cached copy exists; other navigations and every `/api/` or
  `sheets` URL are **not intercepted at all** and write nothing; a cache miss
  with the network down yields `Response.error()` on **both** strategies —
  never `undefined`, never a rejection; a cached copy is served when offline; a
  failing `cache.put` never disturbs the response; non-GET is never
  intercepted.

9 of the 19 fail against the pre-fix code, including both root-cause guards and
both `cacheFirst` hardening guards.

### `test/sw-install-browser.test.js` — 3 tests (real Chromium)

Skipped unless `playwright` resolves and a Chromium binary is present, the
same gate the other browser tests here use.

- the worker reaches **`activated`**, the current cache holds **all six**
  precache entries, and the seeded v4…v14 pile-up is **gone**;
- **causality**: `cache.addAll(PRECACHE_URLS)` against the real Cache API
  **rejects with `TypeError: … Vary header contains *` and stores 0** when the
  header is served, and **stores all 6** when it is not — the header alone;
- **resilience**: served `Vary: *` again, the fixed worker still reaches
  `activated` with an empty cache rather than hanging.

### Full suite

```
npm test  →  1366 tests, 1366 pass, 0 fail, 0 skipped
```

---

## 5. Deployment

Push to the deploy branch; Railway redeploys `server.js` + `public/`. Nothing
else to set — no env var, no Script Property, no Apps Script deploy. The first
load after the deploy installs `v15`, activates, and purges the old caches by
itself.
