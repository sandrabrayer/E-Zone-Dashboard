# Changelog — «ועדות קרובות» on the dashboard (read-only) — 2026-10-15

## Why
Sandra (PR 3): committee («ועדה») dates set by the house managers in the Managers app
(CHANGELOG-managers-committee.md) should be visible on the Dashboard to every logged-in user,
and to Ortal on «בקרת גבייה», like the expected-discharge card.

## What
- **Card «ועדות קרובות»** on «דשבורד», right after «שחרורים צפויים»:
  - «היום» first (red, «ועדה היום»), then the next 7 days (amber);
  - each row shows the house, patient, `ועדה: dd/m/yy · <label>`, «היום» / «מחר» / «בעוד N
    ימים», and «נקבע ע״י <manager> ב-<date>»;
  - a count and a read-only hint;
  - **loading, empty («אין ועדות היום וב-7 הימים הקרובים») and error («לא ניתן לטעון…» + a
    44px «ניסיון חוזר») states are always visible**; the card never hides.
- **Controller view (Ortal)**: the card is moved (not copied) to the top of «בקרת גבייה», right
  after «שחרורים צפויים».
- **Apps Script action `upcomingCommittees`** (READ-ONLY: no sheet, cell or lock):
  - one source of truth, the `ManagersCommittee` sheet and the same readers Managers'
    `houseData` uses;
  - **data minimisation**: only patients in the house today whose committee is today … +7
    (Israel time); only name, admission date and committee (date, label, who / when); no phone,
    money or notes; the list key is `houses`.
- **Gate**: the same as `expectedDischarges`:
  - `PROXY_SECRET` plus a verified personal session (any logged-in user, Ortal included);
  - refused in both proxy-secret modes;
  - server.js refuses first (`ALL_USERS_READ_ACTIONS`);
  - appended to `PROXY_KNOWN_ACTIONS` and `CONTROLLER_ACTIONS` (Code.gs and
    `lib/finance-scope.js`, pinned equal); not in `OPEN_ACTIONS` or `FINANCE_ACTIONS`.
- **Shared rule**: `lib/committee-alerts.js` copies the core of ezone-managers
  `public/committee-alerts.js` (`COMMITTEE_LEAD_DAYS = 7`). Both repos run the identical
  `test/fixtures/committee-alert-cases.json` (sha256 pinned on both sides).
- Text-only rendering (`textContent`); no names in logs. RTL, 16px, 44px. SW v69 → v70 (live v69
  verified).

## Tests
`test/dashboard-committees.test.js` (+19) covers:
- the fixture boundaries (today, +1, +7, +8, −1, year / leap, Israel midnight);
- the view model and text-only card, with a hostile name or label;
- the states;
- Code.gs: data minimisation, last row wins, read-only, authorization in both modes;
- the server gate (Ortal served, no session 401, no names in logs);
- the wiring, including the controller move.

`dashboard-perf-assets` gained the new bundle file, and the controller-list pin was updated.
**2934 → 2954**, all green.

## Deploy
Code.gs is an isolated commit and deploys automatically on merge. No new Script Property, Railway
variable or sheet. Until it deploys, the card shows its error state.
