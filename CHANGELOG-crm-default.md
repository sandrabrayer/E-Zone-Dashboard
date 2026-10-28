# C12 — the switch: `/` serves the CRM (`CRM_DEFAULT`) — 2026-10-28

CRM restructure, Session C (ninth PR). Sandra 2026-10-28: "rebuild, then switch".
Inert until the Railway variable is set; no Code.gs, no SW bump.

## Rule (`lib/crm-shell-flag.js`)
`/` serves the CRM shell when ALL hold: `CRM_ENABLED === 'true'` AND `CRM_DEFAULT === 'true'`,
a verified personal session, page view `full` (Vered, Sandra — `principalView`), and the query is
not `view=classic`. Otherwise `/` is the classic page exactly as before.
- `/?view=classic` → always the classic page (also before the switch).
- `/?view=crm` → the shell for any personal login (unchanged; Ortal / Dana can open it).
- Ortal (controller view) and restricted logins (Dana) keep the classic page by default: their
  CRM views are not complete yet (בקרת גבייה stays classic).
- No session → the PIN page; after login the classic script reloads `/`, which now lands on the CRM.
- Shared / sibling sessions, `/index.html`, `/healthz`, `/api/*`: untouched.

## Links
Every «בדשבורד הרגיל» link in the shell (`crm.js`, `crm.html`) now points at `/?view=classic`
(a test pins it) — `href="/"` would loop back to the CRM after the switch.

## Service worker
Untouched (`v93`). `/` is network-first in sw.js, so the switch takes effect on the next load; the
offline fallback copy of `/` becomes the shell HTML (its hashed assets are not precached, so
offline the CRM shows its loading state — the classic page needs the network for data anyway).

## Not in this PR
Hiding HQ analytics behind an הנהלה role in the classic page is Phase 2 (cross-app roles).

## Files
`lib/crm-shell-flag.js`, `server.js` (reads `CRM_DEFAULT` once, passes `principalView`),
`public/crm/crm.js`, `public/crm/crm.html`, `test/crm-shell-flag.test.js` (+3: lib rule, real
server with / without the variable per user, link guard), `test/crm-shell-browser.test.js`
(link assertion), `DEPLOY.md`, ESS, `docs/crm/ROLLOUT.md`.
Rollback: delete `CRM_DEFAULT` (Vered is back on the classic page on her next load), or revert.
