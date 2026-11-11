# CHANGELOG — Ortal lands on the CRM, on «גבייה»

Date: 2026-11-11 · Branch `claude/ortal-crm-default` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «אורטל לא נכנסת לאפליקציה במראה החדש. לכן היא גם לא רואה הרבה שדות חשובים שם כמו תזרים.»

## What changes for Ortal
- `/` now opens the **CRM** for her (it opened the classic page), and the CRM opens on
  **«גבייה»** — «לגבייה בתאריך», «צפי תזרים», the open debts, receipts and «זיכויים לתשלום».
  «היום שלי» and «בקרה» are one tap away, as before.
- A link at the top of her «גבייה»: **«בקרת גבייה — אימות דיווחים»** → her classic tab
  (`/?view=classic`), where confirming / flagging still happens. The same link stays at the
  bottom of the page.
- Vered, Sandra and Dana: nothing changes.

## How
- `lib/crm-shell-flag.js`: `CRM_DEFAULT_VIEWS = ['full', 'ops', 'controller']`. Still needs
  `CRM_ENABLED=true` + `CRM_DEFAULT=true` (both already set) and a verified personal session.
  `/api/me.landing` answers `crm` for her, so a PIN login on the classic page reloads into the CRM.
- `public/crm/crm.js`: `landingArea(me, current)` (pure) — the controller view opens on
  `billing`; applied once, on the first load only (`state.landed`), so a refresh after a
  write never moves her. `#crm-controller-classic` link at the top of `renderBilling`.
- `public/sw.js`: v123 → **v124** (live v123 verified on production 2026-11-11).

## Security
- Routing decides the PAGE only. Her data scope is untouched: `CONTROLLER_ACTIONS` /
  `CONTROLLER_ROUTES` (server) and the same lists in Code.gs still refuse every other action
  and every finance write; `getData` still answers her with patients + overrides only.
- No new route, no new action, no Code.gs change (no Apps Script deploy), no Railway change.
- `npm audit`: 0 high / critical.

## Tests
- `test/ortal-crm-default.test.js` (new, 4): routing matrix (flags, session kinds, views),
  `landingArea`, the one-time landing + the top link, the allow-list holds no finance write.
- Updated: `test/crm-shell-flag.test.js`, `test/crm-dana-default-switch-user.test.js`
  (Ortal → CRM on `/`, classic on `/?view=classic`, `landing: 'crm'`),
  `test/crm-switch-user-browser.test.js` (Chromium scenario), SW guards
  (`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`).

## Nothing for Sandra to set
Ortal: hard refresh once (Ctrl+Shift+R) at https://ezone-dashboard.up.railway.app .
