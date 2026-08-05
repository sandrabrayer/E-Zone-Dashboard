# API auth — PIN session cookie gating the data routes

Closes the unauthenticated data exposure: `GET/POST /api/sheets` and the
data-bearing `/api/debug/*` endpoints were fully open. A correct PIN now mints a
signed HttpOnly session cookie, and every data route requires it. Only this app's
own frontend consumes the Railway proxy (Managers/Therapists hit Apps Script
directly), so no external consumer is affected.

## What is now gated

Behind a valid session cookie (`401 {error:'unauthorized'}` without one):
- `GET /api/sheets` (read all leads + patients)
- `POST /api/sheets` (all writes: saveAll, moveLeadIrrelevant, removeLead, …)
- `POST /api/outpatient-lead`
- `GET /api/debug/last-load`, `GET /api/debug/last-save` (they echo lead/patient
  previews)

Stays open (by design):
- Static app shell — `index.html`, `/app.js`, `/style.css`, `/sw.js`, icons,
  `/manifest.json` (the PIN screen must load before any auth exists)
- `GET /healthz`
- `POST /api/verify-pin` (issues the cookie) and `POST /api/logout` (clears it)

## Session cookie

- New `lib/session.js` (Node `crypto` only, no new dependencies):
  - `createSessionToken(secret)` → `"<expiry>.<signature>"` where `signature =
    HMAC-SHA256("ezone-session." + expiry, secret)` and `expiry = now + 7 days`
    (epoch seconds). Refuses an empty/undefined secret.
  - `verifySessionToken(token, secret)` → boolean; constant-time
    (`crypto.timingSafeEqual`) signature compare; rejects malformed, tampered, or
    expired tokens without throwing.
- On a correct PIN, `POST /api/verify-pin` sets:
  `ezone_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
  plus `Secure` when the request arrived over HTTPS (Railway forwards
  `x-forwarded-proto=https`). Plain-HTTP localhost dev omits `Secure` so the
  cookie is usable there. The existing rate limiting and constant-time PIN check
  are unchanged.
- `POST /api/logout` expires the cookie (`Max-Age=0`).

## `SESSION_SECRET` requirement + fail-closed behavior

- New env var **`SESSION_SECRET`** (long random string, 48+ chars recommended).
- **Fail-closed:** if `SESSION_SECRET` is unset, the server still boots and serves
  the static app + `/api/verify-pin`, but every guarded route returns
  `503 {error:'session_not_configured'}` — it never falls back to open access.
  A correct PIN is still accepted (200) but no usable cookie can be minted, so the
  data routes stay 503 until the secret is configured. This surfaces the
  misconfiguration to the operator, never as open data to a visitor.

## Viewer-mode removal

- Single PIN for everything — the "viewer" tier is gone. Removed the
  `המשך כצופה בלבד` button (`pin-viewer`) from `index.html` and its entry path in
  `app.js`, and the `body.viewer-mode` toggle.
- Removed the `sessionStorage 'ezone-mode'` trust-on-load. On load the app reveals
  its shell and attempts the initial data fetch; a `401` flips to the PIN screen.
  `apiGet`/`apiPost` show the PIN screen on any `401` (session expired). Cookies
  ride automatically on same-origin fetch — no header changes.
- **Route taken for the woven mode checks:** `state.mode === 'edit'` is threaded
  through ~10 render sites, so per the task's guidance the mode *machinery* is
  retained and `'edit'` is simply the only reachable value (an authenticated user
  is always an editor); the checks now evaluate true rather than being ripped out.
  The now-dead `body.viewer-mode` CSS rules are left in place (harmless, never
  applied) to keep the change focused.

## Debug-endpoint removals

- **Removed `GET /api/debug/routes` and `GET /api/debug/env`** entirely (they
  leaked request-hit counters and infra/host metadata unauthenticated).
  - The only repo reference to either path is `test/pwa-foundation.test.js`, which
    feeds the string `.../api/debug/env` to the service worker's `shouldCache()`
    to assert it is network-only. That tests SW routing and does not call the
    route, so removal does not affect it (full suite stays green).
  - The in-memory `allHits`/`routeHits` counters and `SERVER_STARTED_AT` that fed
    those endpoints were removed; the per-request `console.log` (operational value
    in Railway logs) is kept.

## Tests
Existing `node:test` patterns (direct `require` for server modules, vm-sandbox for
frontend):
- `test/session.test.js` — round-trip verify; wrong-secret / tampered-signature /
  tampered-expiry / expired / malformed rejected; creation refuses empty secret;
  verify with empty secret is false; wire-format matches the documented HMAC.
- `test/api-auth.test.js` — `parseSessionCookie`; `sessionAuthStatus`
  (ok / unauthorized / not_configured); `buildSessionCookie` attributes +
  Secure-only-on-HTTPS; `requestIsHttps`; and the `requireSession` middleware:
  no cookie → 401, valid cookie → `next()`, expired → 401, unset secret → 503.
- `test/pin-session-frontend.test.js` — `apiGet`/`apiPost` reveal the PIN screen
  and hide the app on a 401; a 200 does not.
- `test/mobile-tabs-and-edit-mode.test.js` — updated: its Fix-2 test asserted the
  viewer tier still existed ("Option A"); it now asserts viewer removal while
  confirming the retained edit-mode gates.

Full suite: `npm test` → **349 passed, 0 failed** (325 prior + 24 new), zero
regressions.

## Deploy
- **BEFORE merging: add `SESSION_SECRET` to the Railway service variables** (long
  random string, e.g. 48+ chars). Railway env changes apply only to deployments
  started after saving — set it first, then merge.
- Without it, the app boots but data routes return **503** by design (fail-closed).
- **Post-merge verification:** open the live app in a fresh incognito window → PIN
  screen appears (no viewer button) → wrong PIN rejected → correct PIN enters and
  data loads → `curl https://ezone-dashboard.up.railway.app/api/sheets?action=getData`
  returns **401** → `/api/debug/last-save` returns **401**.
