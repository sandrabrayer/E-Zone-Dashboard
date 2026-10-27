# C2 — CRM shell: side menu, six areas, read-only over existing data — 2026-10-27

CRM restructure, Session C (`docs/crm/ROLLOUT.md` §C2; SPEC §3–§7, §10). Stacked on C1
(`CHANGELOG-crm-shell-flag.md`): only `/?view=crm` with `CRM_ENABLED=true` loads any of this. The
classic dashboard, its assets and `sw.js` (v93) are untouched.

## What ships (`public/crm/`)
- **Shell**: 220 px right side menu (desktop ≥ 900 px), drawer + burger on mobile; header with the
  area title, search and «+ פנייה חדשה» (links to the classic dashboard). Dark tokens matching
  `style.css`; RTL throughout; loading / error (with retry) / empty states.
- **Areas** (visibility mirrors the SERVER gates via `/api/me` — the server still refuses the data):
  finance (Vered, Sandra) → all six; controller (Ortal) → היום שלי · גבייה · בקרה; no finance (Dana)
  → everything but גבייה.
  - **היום שלי** — 4 clickable KPIs (באיחור / להיום / פניות חדשות / פגישות היום) filtering a work
    queue grouped באיחור / להיום / ממתין; each row = client · action · owner · due · state · «כרטיס».
    Rows are COMPUTED from existing lead fields (meeting without outcome, lead waiting ≥ 3 days,
    unscheduled visit, waitlist, admission) and are marked derived — a task record with real due
    dates is a later track (spec §14). Ortal's day = counts from `billingControlQueue`.
  - **פניות** — board by stage (ליד חדש / ביקור נקבע / רשימת המתנה / בטיפול פעיל) ⇄ sortable table;
    one shared filter (house, owner, search) that survives the toggle and opening a card. Cards show
    stage, next action and alert as three distinct things.
  - **לקוחות** — patients in a house today, days in house, house filter.
  - **יומן** — meetings today → +14 days, grouped by day.
  - **גבייה** — links to the classic sub-screens (no billing data is re-implemented here).
  - **בקרה** — action metrics: untouched leads, late tasks, meetings without outcome, unscheduled
    visits, open admissions.
- **Client drawer** (side panel, full-width on mobile): סקירה (existing lead / patient fields),
  פעילות (the B3 `getActivity` timeline, manual vs system marked), פגישות ושירותים, חשבון, מסמכים
  (the last two say what is not connected yet). «עריכה בדשבורד» links out; no write path exists.
- **Reads only**: `/api/me`, `getData`, `billingControlQueue` (controller), `getActivity`. Every
  interpolated value goes through `esc()`.

## Server
`crm/crm.js` + `crm/crm.css` join `ASSETS` (hashed, immutable when current) and get static routes;
`sendCrmShell` versions the references. NOT in `sw.js BUNDLE_PATHS` → no SW bump.

## Tests
`test/crm-shell-ui.test.js` (10, pure core) and `test/crm-shell-browser.test.js` (3, real Chromium
at 1366 px and 390 px: areas per role, KPI filter, board/table toggle keeps the filter, drawer +
timeline, burger menu, no horizontal scroll; skipped where Chromium is absent). C1's flag test
updated for the new shell marker. Full suite 3521 / 0 fail.

## Files
`public/crm/crm.html`, `public/crm/crm.css`, `public/crm/crm.js`, `server.js`, the two test files,
`test/crm-shell-flag.test.js`, `EZONE-ECOSYSTEM-STATUS.md`, `docs/crm/ROLLOUT.md` §C2.
No Code.gs, no SW bump, no schema change, no Railway variable beyond C1's `CRM_ENABLED`.

## Rollback
`CRM_ENABLED` off (Sandra, Railway), or revert. The dark classic UI is unaffected either way.
