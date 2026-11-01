# CRM «היום שלי» — every task card opens — 2026-11-01

Branch `claude/crm-today-card-open` → base `claude/build-ezone-dashboard-QOg5s`.
Code.gs untouched (no Apps Script deploy). SW `CACHE_VERSION` v107 → **v108** (from the live v107).

## The bug
«כרטיס» on a «לעדכן המשך טיפול» row (e.g. a patient discharged from רמות השבים on 18/10/2026) did nothing.

## Root cause (not a layout problem)
- The row is built from the discharge audit row (`dischargedPatients`) and opened with `data-open-patient = d.patientId`.
- Only CRM and coordinator discharges write `patientId`. The classic «שחרר» flow leaves it **blank**, so the button
  rendered `data-open-patient=""`.
- The click handler tested the value (`t.dataset.openPatient` → `''` → falsy) and fell through: **silent no-op**.
- Even with an id, `openDrawer` returned silently whenever the id was not on Patients.
- Every classic-discharged patient was affected, both in the work list and in the «חריגים בבתים» side box.
  Other task types (leads, reports, calls) were not affected.

## Fix
1. `dischargePatientId(d, patients)` (pure) resolves a discharge row to its Patients id:
   - first, `patientId` when it is on Patients;
   - else the stay triple (house, name with spaces normalised, entry date);
   - else the one released row of the house with the same source lead;
   - else the stored id.

   This is the same matching order `restoreTarget` already uses. `houseExceptions` uses it.
2. The click handler checks the **attribute** (`hasAttribute`), not its value.
3. `openDrawer` and the contact panel show a Hebrew toast when a record is not found; they never fail silently.
4. «לעדכן המשך טיפול» now opens the card on «פגישות ושירותים» (button «לעדכון»). The «שחרור» block there now has an
   «המשך טיפול» select and a «שמירה» button. They call the **existing** `setDischargeContinuity` action, the same
   one the classic «חתכי מטופלים» select uses. Code.gs re-validates the key and the row under its lock. The row
   leaves the list after saving.
5. Consistency:
   - a restored discharge is recognised in every spelling (`TRUE` / `true` / `1`), not only `'1'`;
   - `continuity: 'unknown'` (the CRM discharge default) counts as "not recorded", the same as blank;
   - the drawer shows the Hebrew label instead of the stored key.
6. Layout («היום שלי»):
   - ≤ 1279 px: the side column («פגישות היום / ממתין לגורם אחר / חריגים בבתים») moves under the work list, with
     its boxes side by side;
   - 900–1099 px: work rows switch to a two-line layout, with actions on their own line;
   - grid children may shrink (`min-width: 0`), so there is no horizontal page scroll.

   Verified at 1440 / 1280 / 1024 / 960 / 768 / 700 px.

## Not changed
No data, no permissions, no server or Code.gs code, no other area.
- Dana (ops view) can open every card. She can set «המשך טיפול», which is an operational, non-money write, the
  same as discharge.
- «חשבון» stays hidden for her.

## Answers recorded
- **Where is the manager's report («לקרוא דיווח מנהל/ת»)?** It is on the **lead's** card, tab «פגישות ושירותים»,
  section «דיווח המנהל/ת». The «לדיווח» button, or the name in «חריגים בבתים», opens it there. Opening the tab
  marks the report as read.
- **«לעדכן המשך טיפול»**: a discharge from the last 14 days with no recorded continued treatment. Set it on the
  card → «פגישות ושירותים» → «שחרור» → «המשך טיפול». In classic, the same field is in «מטופלים» → «חתכי מטופלים».

## Tests
`test/crm-today-card-open.test.js` (6):
- pure: the resolver, the exceptions, the helpers, and source guards;
- real server + Chromium: every «כרטיס» opens, as Vered and as Dana, at 6 widths, with the drawer fully on
  screen, no horizontal scroll and no page errors;
- the continuity save posts `setDischargeContinuity` and clears the row.

The browser test fails on the previous `crm.js` (reproduces the bug) and passes with the fix.
SW pins updated in `test/crm-pwa.test.js` and `test/dashboard-perf-assets.test.js`.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js`, `test/crm-today-card-open.test.js` (new),
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`, `CHANGELOG-crm-today-card-open.md`.
