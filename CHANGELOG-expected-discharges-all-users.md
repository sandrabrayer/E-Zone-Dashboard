# Changelog — «שחרורים צפויים» for every logged-in user — 2026-10-15

## What
The read-only card «שחרורים צפויים» (Dashboard PR #233) is now visible to **every user who can
log in to the Dashboard**. The per-person allow-list (Sandra, Vered, Shiran, Yael — a `staff`
role and not Ortal's controller view) is removed from the `expectedDischarges` read action, in
both gates:

- **server.js** — `requireExpectedDischargesView` → `lib/role-scope.js canViewExpectedDischarges`
  now accepts any resolved personal session (no role check, no id list).
- **Apps Script** — `expectedDischargesRefused_` accepts any VERIFIED personal session (no role
  check, no controller exclusion). Isolated commit; deploys automatically on merge.
- **Controller view (Ortal)** — `expectedDischarges` is appended to `CONTROLLER_ACTIONS` in
  `lib/finance-scope.js` and `Code.gs` (append-only, pinned equal by the guard tests). Her page has
  only «בקרת גבייה», so `applyControllerView` moves the card (the same node, one id) to the top
  of that screen; `renderAll` paints it for every view.

## Why
CEO decision, 15 Oct 2026: every user who can log in to the Dashboard app may see the card.

## Unchanged (security)
- A valid authenticated session is still required: no / forged / stale (reset-PIN) session →
  **401** at `requireSession`, nothing proxied.
- Apps Script still requires `PROXY_SECRET` (not an `OPEN_ACTIONS` member) and a verified
  personal session **in both `PROXY_SECRET_MODE`s**: no or wrong secret → `unauthorized`; a
  verified non-personal caller (the meeting-report proxy) or a personal one without an id →
  `forbidden`. The Managers secret does not open it.
- Still READ-ONLY (no sheet, cell or lock), the same payload for every user (name, admission
  date, expected date, who/when — no phone, money or notes), text-only rendering.
- No new secret, Script Property, env var or Railway variable; no new endpoint.
- No patient names in logs (server logs the action / user id only; Code.gs logs nothing here).
- `npm audit`: 0 high / 0 critical (1 moderate in `qs`, pre-existing, unchanged).

## UI
SW `CACHE_VERSION` **v65 → v66** (production `/sw.js` served v65 on 15/10/2026) — `app.js` changed.

## Tests
2884 → 2887 (+3):
- `test/dashboard-expected-discharges.test.js`:
  - C (Code.gs): every user (Sandra, Vered, Shiran, Yael, Ortal, a narrowed role-less record)
    gets the full feed in both modes; no / wrong secret, a body-only claimed session, a
    non-personal caller and a personal one without an id are refused; no allow-list left in the
    gate;
  - D (server): `canViewExpectedDischarges` for every personal session; GET for all five users
    and POST served, secret + principal forwarded; no / forged / stale session → 401 with nothing
    proxied; no patient name in the server log;
  - F (new, 3): the controller view's card is moved (not copied, idempotent) under the «בקרת
    גבייה» title; wiring of `applyControllerView` / `renderAll`; Code.gs ⇄ lib lists equal and
    the same feed for Ortal and Vered.
- `test/billing-control-tab.test.js` pinned list (+ `expectedDischarges`, appended),
  `test/dashboard-perf-assets.test.js` SW v66.
- Existing snapshots unchanged.

## Deploy
Apps Script: automatic on merge (Code.gs changed). Railway: automatic. No manual step.
