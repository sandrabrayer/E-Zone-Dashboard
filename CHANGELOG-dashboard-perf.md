# Dashboard perf — page load (October 6, 2026)

The Dashboard was slow to open. This change finds the three biggest causes,
fixes them, and adds timing lines so the real numbers show up after deploy.
It carries PR #149 (built 29 Sep, 152 commits behind, never merged), rebased
onto the deployed branch, and adds compressed, content-hashed assets on top.

**No change to data or permissions.** On the same sheets, the old and new
`Code.gs` return byte-identical JSON for `getData`, `getPayments` and
`getCredits` (sha256 below). A session without `finance` still never asks for
the two money reads.

## How it was measured — and what could not be

- **The live app could not be reached from the build session.** Its network
  policy refused `ezone-dashboard.up.railway.app` (proxy 403), and the session
  has no Railway access. So there is no live waterfall or server log in this
  document. The deployed branch (`claude/build-ezone-dashboard-QOg5s`) was
  taken from `EZONE-ECOSYSTEM-STATUS.md`. It still has to be confirmed in
  Railway → `zucchini-hope` → `web` → Settings → Source before merging.
- **Asset bytes: exact.** The bytes of the real files, compressed the way the
  server now compresses them.
- **Apps Script work: exact call counts.** The real `Code.gs`, before and
  after, runs over fake sheets that count every Sheets call. The data is the
  PR #149 benchmark: 250 leads, 90 patients, 1,600 payments, 60 credits.
- **Wall times: estimates.** Call counts × the per-call costs in
  `CHANGELOG-dashboard-load-perf.md` (#149). After deploy, the real figures
  are in Apps Script → Executions (`[perf] …` lines) and in the browser
  console (`[E-ZONE][perf] loadAll …`).

## What happens on a page load (before)

1. `GET /` (index.html, 33 KB, `no-store`).
2. `style.css` and four scripts: **789 KB in all, uncompressed, `no-store`**.
   The service worker re-fetched them on every load, because the strategy was
   network-first.
3. `loadAll`: `getData` → **wait** → `getPayments` → **wait** → `getCredits`.
   These are three Apps Script executions, **one after another**.
4. Render.

## The top 3 causes, ranked by impact

| # | Cause | Evidence | Before | After |
|---|---|---|---|---|
| 1 | **The three data reads ran one after another.** The page waited for the *sum* of three Apps Script round trips. | `public/app.js` `loadAll`: `await getData`, then `await getPayments`, then `await getCredits` | ~11 s (sum) | **~2 s** (the slowest one) |
| 2 | **The read path wrote to the sheet and read sheets twice.** Every read re-applied whole-column formats, which counts as a write. It also looked up the timezone once per lead, and re-read sheets for backfill checks. | Call counts per page load (table below) | 51 format writes, 13 sheet reads, 166 timezone lookups | **0 / 8 / 0** |
| 3 | **789 KB of JS/CSS, uncompressed and never cached.** Every response was `no-store`, nothing was gzipped, and the service worker re-downloaded the bundle on every visit. | Exact file bytes (table below) | 789 KB on every visit | **204 KB first visit, 9 KB after** |

### Cause 2 — Apps Script calls per page load (exact, benchmark data)

| Read | `getValues` | format writes | timezone lookups | JSON (sha256, first 16) |
|---|---|---|---|---|
| getData | 9 → **6** | 19 → **0** | 166 → **0** | `12282b9482a3a23b` → `12282b9482a3a23b` |
| getPayments | 2 → **1** | 26 → **0** | 0 | `9c6399f7210aebae` → `9c6399f7210aebae` |
| getCredits | 2 → **1** | 6 → **0** | 0 | `157a44e7be187a32` → `157a44e7be187a32` |

Raw JSON on the benchmark data: getData 144 KB, getPayments 1.1 MB,
getCredits 24 KB. That is the browser's full download for one load.

### Cause 3 — bytes (exact)

| File | Raw | br (sent now) |
|---|---|---|
| app.js | 630,297 | 161,186 |
| style.css | 95,526 | 23,386 |
| payment-report-rules.js | 13,100 | 4,351 |
| billing-control-rules.js | 8,804 | 3,224 |
| funder.js | 8,113 | 2,981 |
| index.html | 33,203 | 9,075 |
| **Page total** | **789,043** | **204,203 first visit · 9,075 after** |

Transfer time at 1.6 / 5 / 20 Mbps: before 3.95 / 1.26 / 0.32 s. After,
first visit: 1.02 / 0.33 / 0.08 s. After, repeat visit: about 0.

Unverified: whether Railway's edge already compresses. If it does, the
first-visit gain is smaller, but the cache gain on repeat visits still holds.
To check, run `curl -sI -H 'Accept-Encoding: br, gzip' https://ezone-dashboard.up.railway.app/app.js`
and look for `content-encoding`.

## Before / after — page load (estimates; the `[perf]` lines give the real ones)

| | Before | After |
|---|---|---|
| First paint (shell + CSS + JS) at 5 Mbps | ~1.3 s download + parse | **~0.35 s first visit, ~0 repeat** |
| getData | ~5 s | **~1.7 s** |
| getPayments | ~4 s (+ up to 10 s while a save holds the lock) | **~1.6 s**, no lock |
| getCredits | ~1.6 s | **~1.2 s** |
| **Full data on screen** | **~11 s** (sum) | **~2 s** (max of the three) |

## What changed

**From PR #149 (rebased, re-validated)**
- `apps-script/Code.gs`:
  - Reads open their sheets without the format pass (`sheetForRead_`).
  - One `getValues` per sheet (`sheetValues_` / `rowsFromValues_`).
  - The timezone is looked up only for Date cells.
  - `getPayments` takes the lock only when there is real work to fill.
  - `managerPhones_` is one `getProperties` call.
  - Saves skip identical Leads and digest rewrites.
  - Full detail is in `CHANGELOG-dashboard-load-perf.md`.
- `public/app.js`: `loadAll` starts the three reads together. Each settles
  into `{ok, value|error, ms}`, so none can become an unhandled rejection.
  It also logs one `[E-ZONE][perf] loadAll …` line.

**Rebase fixes (new in this PR)**
- `getPayments_`: keeps the single read and adds the current receipts/funders
  split (`paymentRowsDerived_`, `fundersForClient_`).
- `getData_`: keeps `currentManagers` / `currentManagersSource`.
- `writeDigestRows_`: keeps the newer behaviour of throwing on a busy lock.
  So the stored signature is recorded only after a write made under the lock
  (#149's `locked` flag is gone).
- `loadAll`: the restricted view never starts `getPayments` / `getCredits`.
  If `finance` turns false while `getData` is still in flight, the money
  results are dropped, exactly as before.
- `PATIENTS_WRITE_ACTIONS` also covers `recordDischargeFromCoordinators` (#177).
- A `[perf]` lap label in `handle_` was renamed `digest` → `roster`. The old
  name tripped the "no digest function reachable over HTTP" guard.

**Assets (new in this PR)**
- `lib/static-assets.js` (no new dependency):
  - Content hash (12 hex of sha256) per file.
  - br q9 + gzip 9 computed once per content version, not per request.
  - The store re-stats each file on every request and rebuilds the entry on
    change, so a hot redeploy is still picked up immediately.
- `server.js`:
  - `index.html` links `app.js`, `style.css`, `funder.js`,
    `payment-report-rules.js` and `billing-control-rules.js` as
    `?v=<own hash>`. The URL changes only when that file's bytes change.
  - A request naming the current hash gets
    `Cache-Control: public, max-age=31536000, immutable`; any other request
    keeps the old `no-store`.
  - `index.html` and every Apps Script JSON answer are compressed above 1 KB.
    Redaction of `PROXY_SECRET` still runs on the plain text, before
    compression.
  - `sw.js`, the manifest, icons and the meeting-report files are served
    exactly as before.
- `public/sw.js`, **`CACHE_VERSION` v38 → v39**:
  - New strategy `cache-first-hashed` for bundle URLs that carry a content
    hash. It matches the exact URL, so a new hash is a cache miss and a
    deploy is never pinned.
  - Older hashes of the same file are pruned.
  - Offline, it falls back to the last copy of that file.
  - Unversioned requests stay network-first, and `/api/` stays network-only.
  - v39 is the next free number: v38 is deployed and no branch claims a
    higher one. v17 is burned and was not touched.

## Not done, and why

- **Serve-stale data with «מתעדכן…».** Not done here: every edit saves the
  full in-memory state through `saveAll`. Rendering a stale snapshot that
  someone then edits risks writing old data back. Showing stale data on a
  first load would also mean storing patient data on the device. Revisit
  only with a read-only window until fresh data arrives.
- **Faster saves.** `replaceHousePatients_` still makes ~6 whole-sheet passes
  per save. This is follow-up 1 in `CHANGELOG-dashboard-load-perf.md`. Load
  time comes first.

## Tests

- `test/dashboard-perf-assets.test.js`: **24 new tests**.
  - Hash, negotiation and store rebuild.
  - Over HTTP: index links all five hashes; immutable only at the current
    hash; byte-exact round trips; `sw.js` unchanged; JSON compression.
  - Service worker v39: exact-URL hit, new-hash miss + prune, offline
    fallback.
- `test/dashboard-load-perf.test.js` (#149, 45 tests): 3 tests updated to the
  rebased behaviour (busy-lock digest, the v39 pin, the invalidation list),
  plus 2 new restricted-view `loadAll` tests.
- Guards updated to the new shape, with no assertion weakened:
  - `restricted-view`: `loadAll` regexes.
  - `billing-control-tab`: `BUNDLE_PATHS`.
  - `sw-install-fix`: three guarded `cache.put` sites.
- **Mutation-checked:** each of these breaks at least one test:
  - always-immutable;
  - SW `ignoreSearch` on the hashed hit;
  - no pruning;
  - money reads started without `finance`;
  - assets bypassed.
- **Full suite: 2245 / 2245 pass, 0 skipped** (Playwright SW tests included).

## After merge

- **Deploy:** Railway redeploys the server. The Deploy Apps Script CI pushes
  `Code.gs` with clasp. No manual paste, no new Script Property, no new
  Railway variable.
- **Verify:**
  - Apps Script → Executions: a `getData` should log
    `[perf] getData_ …ms | … | leads=… patients=…`.
  - Browser console: `[E-ZONE][perf] loadAll …ms | getData=… getPayments=…
    getCredits=…`. Total ≈ the max of the three, not the sum.
  - DevTools → Network, second load: `app.js?v=…` from the service worker
    with no network request, and `/api/sheets` with
    `content-encoding: br` or `gzip`.
- **Close PR #149** as superseded by this PR.
