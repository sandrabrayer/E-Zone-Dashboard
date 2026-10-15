# Changelog — Dashboard: «שחרורים צפויים» (expected discharges, read-only) — 2026-10-15

## What
- **Dashboard tab «דשבורד»**: a new card **«שחרורים צפויים»**, all houses together:
  - patients whose expected discharge date is **today … +14 days** (`ALERT_LEAD_DAYS = 14`,
    inclusive), sorted by date: name, house, `שחרור משוער: dd/m/yy` and
    «היום» / «מחר» / «בעוד N ימים»;
  - a red **«דורש עדכון»** list on top: the date has passed and the patient is still in the house
    («התאריך עבר אתמול» / «התאריך עבר לפני N ימים»);
  - one quiet line per house: «<בית>: N מטופלים ללא תאריך שחרור משוער»;
  - every row: **«נקבע ע״י <manager> ב-<date>»** from the existing audit trail;
  - the hint «לקריאה בלבד · התאריכים נקבעים ומשתנים באפליקציית המנהלים».
- **Apps Script**: new READ-ONLY action **`expectedDischarges`** →
  `{ ok, today, expectedDischargeSupported: true, houses: [{ house, label, patients: [{ name, entryDate, expectedDischarge: { date, editedAt, editedBy } | null }] }] }`.
- New page module **`lib/discharge-alerts.js`** (served at `/discharge-alerts.js`, `window.DischargeAlerts`).

## Why
Sandra, Task F (15 Oct 2026): managers set «שחרור משוער» in the Managers app (Managers #44,
Dashboard #230, sheet `ManagersExpectedDischarge`) and see alerts there (Managers #46). The
Dashboard showed nothing.

## How
- **One source of truth.** The action reads the same `ManagersExpectedDischarge` sheet with the
  same readers as Managers `houseData` (`mwInHousePatients_` + `mwReadDischarges_`; the last row
  of a stay wins). A test pins the Dashboard read equal to `houseData`. No new sheet, no column,
  no write: the append-only structure is untouched.
- **Only patients in the house today**: a discharged patient is not listed.
- **No editing in the Dashboard.** The card has no input or button (only «ניסיון חוזר» on a load
  error). The Dashboard never calls `dischargeSet`.
- **Shared rule.** The two apps are separate repos, so `lib/discharge-alerts.js` is a copy of the
  Managers core (`israelToday`, `dayDiff`, `whenText`, `noDateText`, the 14-day window). Both repos
  run the **identical** fixture `test/fixtures/discharge-alert-cases.json` (14 in, 15 out, 0, 1,
  -1, -3, year and leap-day edges, bad dates, Israel midnight) against their own copy. Its sha256
  is pinned in both test files: changing it on one side fails CI.
- **Israel time.** The card computes "today" in the browser with `Asia/Jerusalem`
  (`DischargeAlerts.israelToday`), so it turns at Israel midnight whatever the device clock. The
  action's "in the house today" also uses `Asia/Jerusalem`.
- **Load**: one GET per 60 s at most (the dashboard re-renders often); every render recomputes the
  alerts against today.

## Security
- **Gate 1, server.js**: `requireExpectedDischargesView` on both `/api/sheets` routes, before the
  proxy secret is attached: a personal session holding `staff` that is not the controller view
  (`lib/role-scope.js canViewExpectedDischarges`). Ortal → 403, no session → 401.
- **Gate 2, Apps Script**: not in `OPEN_ACTIONS`, so `PROXY_SECRET` (Script Property) is required
  like every Dashboard read. On top of that, `handle_` refuses it unless the caller is a VERIFIED
  personal staff session, **in both `PROXY_SECRET_MODE`s** (fail-closed even in `log`): no or wrong
  secret → `unauthorized`; controller, meeting-report or role-less → `forbidden`.
- **"Admin session only" — our reading.** The Dashboard has no "admin" role. The feed is allowed
  for exactly the sessions that already see the patient list (Sandra, Vered, Shiran, Yael), and
  refused to Ortal's controller view. It carries name, admission date, expected date and who set
  it — no phone, money or notes.
- **No new secret, Script Property, env var or Railway variable.**
- **No patient names in logs**: the response key is `houses` (the proxy's summary log prints a
  first `patients[0]` only for a top-level `patients` array); the server logs the action name only;
  Code.gs logs nothing here; tests assert it.
- **Text-only rendering**: `createElement` + `textContent`, never `innerHTML` with data (a test DOM
  throws on `innerHTML`).
- `npm audit`: 0 high / 0 critical (1 moderate in `qs`, pre-existing on the deployed branch,
  unchanged by this PR).

## UI
RTL, 16px text throughout the card, 44px rows / retry button, wraps at 360px (checked in Chromium
at 360×740: no horizontal scroll). SW `CACHE_VERSION` **v63 → v64** (production `/sw.js` served
v63 on 15/10/2026); `/discharge-alerts.js` added to the hashed bundle.

## Display-only
No bonus, occupancy or billing figure reads it; the existing Dashboard snapshots and suites are
unchanged.

## Tests
2843 → 2868 (+25): `test/dashboard-expected-discharges.test.js` (24 new) and
`test/fixtures/discharge-alert-cases.json`; `test/dashboard-perf-assets.test.js` asset table (+1 per-file case) and SW
version (v64) updated.

## Deploy
Apps Script: automatic on merge (Code.gs changed). Railway: automatic. No manual step.
