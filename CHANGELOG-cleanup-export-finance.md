# Fix: «ייצוא רשימת תיקונים» — 403 for Sandra's personal session

Branch `fix/cleanup-export-finance` → base `claude/build-ezone-dashboard-QOg5s`.
`server.js` only. No `apps-script/Code.gs` change, no `public/` change, so no
service worker bump (`CACHE_VERSION` stays v28).

## The bug

Sandra, signed in with her **personal** code (approver, full view), clicked
«ייצוא רשימת תיקונים» on the גבייה tab and got
«הייצוא נכשל — אין הרשאה לייצוא זה» (HTTP 403).

## Root cause

The route's own middleware was **not** the problem.
`GET /api/export/cleanup.xlsx` has the same chain as the two sibling exports
(`requireSession → requireFinance → requireProxySecret → handler`), and
`requireFinance` passes Sandra: `sessionPrincipalFromRequest` gives
`{ auth: 'personal', id: 'sandra' }`, and `principalCapabilities` gives
`['finance']`.

The 403 came from **Apps Script**, one step later:

1. `cleanupXlsxHandler` called `sheetsPost({ action: 'cleanupReport', user })`
   **without the session principal** (the second argument).
2. `sheetsPost` then used `NO_PRINCIPAL`, so the body sent to Apps Script said
   `proxyAuth: 'none'`, `proxyUserId: ''`, `proxyCaps: []`.
3. Code.gs `proxyGate_` → `proxyActor_` → `actorCaps_('none', '', [])` gave
   the verified actor **no** `finance` capability.
4. `cleanupReport` is in Code.gs `FINANCE_ACTIONS`, so `financeRefused_` was
   true and `handle_` answered `{ ok: false, error: 'forbidden' }`.
5. `cleanupXlsxHandler` turns `error: 'forbidden'` into HTTP 403; the browser
   shows «אין הרשאה לייצוא זה».

In short: the server checked the right person, then told Apps Script the
request came from nobody.

`refundForecastXlsxHandler` and `debtAgingXlsxHandler` had the **same
omission** (`sheetsPost({ action, user })` with no principal). Against the
Code.gs now deployed (restricted view, `financeRefused_`), they get the same
`forbidden`. If they still worked for Sandra, the click most likely came
before that Code.gs version was deployed. All three are fixed here.

`/api/sheets` was never affected: it already passes the principal
(`sheetsGet(..., principal)` / `sheetsPost(body, principal)`).

## The fix

`server.js`: each of the three export handlers passes
`sessionPrincipalFromRequest(req)` to its fetcher, and the default fetcher
forwards it to `sheetsPost` as the principal:

- `refundForecastXlsxHandler` — `fetchForecast(user, principal)`
- `debtAgingXlsxHandler` — `fetchAging(asOf, user, principal)`
- `cleanupXlsxHandler` — `fetchCleanup(user, principal)`

The injectable deps keep their old first arguments, so existing tests and
callers are unchanged.

## Security

- **No widening.** The capability is still decided on both sides: server.js
  `requireFinance` refuses a session without `finance` before anything is
  proxied, and Code.gs re-derives the capability from `proxyAuth` +
  `proxyUserId` and intersects it with `proxyCaps`. The principal is read from
  the signed session cookie only, never from the request. `buildAppsScriptBody`
  still drops any client-sent `proxy*` field.
- Shiran and Yael still get 403 from server.js, and nothing reaches Apps Script.
- Logs are unchanged: outcome only, never patient data.

## Tests — `test/cleanup-export-finance.test.js` (4 tests)

The stubbed Apps Script runs the **real Code.gs gate** (`proxyGate_` +
`financeRefused_`, loaded in a `vm` sandbox) on every body the server sends. So
a missing principal fails exactly as it did live.

- The gate itself: a body with `proxyAuth 'none'` / `proxyCaps []` is refused
  for `cleanupReport` (the live bug). Sandra's real principal is not refused.
- **Sandra (personal, id `sandra`) → 200** on `cleanup.xlsx`,
  `refund-forecast.xlsx` and `debt-aging.xlsx`. The body carries
  `proxyAuth: 'personal'`, `proxyUserId: 'sandra'`, `proxyCaps: ['finance']`.
- Vered (personal) → 200 on `cleanup.xlsx`.
- **Shiran (personal) → 403** on all three routes, and 0 calls reach Apps Script.

Checked: **without** the `server.js` change, the Sandra and Vered tests fail
with `403 {"ok":false,"error":"forbidden"}`, which is the live symptom. With
the change, the full suite passes: **1946 / 1946**.

## Deploy

Railway redeploys `server.js` on merge. No Apps Script redeploy and no
Script Property change are needed.
