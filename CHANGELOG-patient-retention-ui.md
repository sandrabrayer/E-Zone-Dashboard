# «חתכי מטופלים» + required «המשך טיפול» (PR 2 of 3)

**What:** the user-facing half of the patient-retention report, on top of PR 1
(`CHANGELOG-patient-retention-foundation.md`, PR #257).

Base: `claude/build-ezone-dashboard-QOg5s` (stacked on PR #257 — merge that
first). Code.gs **unchanged** (PR 1 already validates the key and ships the
update op). SW `v77` → `v78` (live v76 verified 20/10/2026; v17 never reused).

## The שחרור modal

`showCloseLeadModal` gains an opt-in `continuityField`. The שחרור modal passes
it, and gets a **required** «המשך טיפול *» radio group with the three real
values: המשיך באמבולטורי (E-ZONE) / המשיך במסגרת טיפולית אחרת / לא המשיך.
«לא ידוע» is never offered. אישור stays disabled until both the closure status
and «המשך טיפול» are picked. The key travels in the audit row
(`dischargeAuditRow` keeps only a real choice). Code.gs refuses any unknown key
(PR 1). The lead-closure and «לא נכנס» modals are unchanged.

## «חתכי מטופלים» — a sub-view of «מטופלים משוחררים»

A «חתכי מטופלים» button opens a card above the list. It is rendered by
`renderPatientRetention` from `lib/patient-retention.js`
(`window.PatientRetention`, loaded before app.js).

- **Period**: from / to dates, plus the leads funnel's presets (החודש / החודש
  הקודם / 3 חודשים אחרונים — `LeadsFunnel.presetRange`, Israel today). The
  default is the last 3 months. «לתקופה מסוימת (ימים)» sets the custom split
  (a whole number from 1 to 3650; anything else = no split).
- **Label**: «לפי תאריך כניסה בתקופה (כולל שני התאריכים)», plus how the days
  are counted.
- **Length cards**: up to 30 / 31–60 / 61+ / עדיין בטיפול. Each shows a count
  and its % of the cohort. «עדיין בטיפול» also has a days-so-far breakdown.
- **Custom split cards**: «עד N ימים» / «מעל N ימים», as % of the discharged
  patients.
- **Continuity cards**: the 4 keys, as % of the **discharged patients only**.
- **Cross table**: length bucket × continuity.
- **«נתונים חסרים: N»**: these patients are not counted in the report. They
  open as their own list, with the reason for each.
- **Patient lists**: click any count (card, cross-table cell, breakdown,
  missing) to open the patient list behind it (`PatientRetention.listFor`
  returns the same row objects the count came from).
- **CSV export**: «ייצוא CSV» exports the list shown. It uses
  `PatientRetention.toCsv`: UTF-8 BOM, CRLF, and every cell formula-guarded.
  The `csvCell` rule is pinned equal to `LeadsFunnel.csvCell`. The file is
  `חתכי-מטופלים-<from>-<to>-<selection>.csv`, built in the page.

## «לא ידוע — עדכון»

A legacy discharged row (continuity `unknown`) gets a select, in edit mode
only:
- placeholder «לא ידוע — עדכון» plus the three choices;
- shown on the «מטופלים משוחררים» row and in the report's lists (rows with an
  audit id).

When a value is picked, `updateDischargeContinuity`:
1. sets the value optimistically;
2. sends `setDischargeContinuity { id, continuity }` through `trackedWrite`,
   with the `withFieldSaving` busy marker;
3. checks proof with `requireSavedId` (the answer must name the row);
4. on a refusal or a failed write, rolls back to the previous value and shows
   «עדכון המשך הטיפול נכשל — …».

An unknown key, «unknown», or view mode never posts. Other rows show their
«המשך טיפול» label.

## UI rules

- Hebrew RTL.
- `escapeHtml` on every rendered value, including the selection JSON in
  `data-sel`. The row control is built with `textContent` only.
- Touch targets are ≥ 44px (cards, cells, presets, selects, modal radios).
- Text is 16px.

## Wiring

- `server.js`: `/patient-retention.js` added to `ASSETS`, served by the same
  `sendLibAsset` static-code route as `/leads-funnel.js`. Code only, no data,
  and not an `/api/` route.
- `index.html`: the button, the card, and the `<script>` before app.js.
- `sw.js`: `/patient-retention.js` added to `BUNDLE_PATHS` (the content-hashed
  bundle list). `PRECACHE_URLS` holds only `public/` files, and this file
  lives in `lib/`.

## Tests

- `test/patient-retention-ui.test.js` (new) covers:
  - `listFor` / `listTitle`;
  - CSV parity with the leads funnel's CSV, plus the BOM and the formula guard;
  - filenames;
  - label parity;
  - the modal gate, and that the payload carries continuity;
  - the view HTML: percentages, cohort label, cross table, missing data,
    escaping;
  - the inline control (edit mode only, no `unknown` option);
  - optimistic update, rollback, unproven answers, and no-post cases;
  - wiring, CSS, and the SW bump.
- `test/duplicate-discharges-browser.test.js` (Chromium) now checks:
  - the submit is disabled until «המשך טיפול» is picked;
  - there are 3 options and no `unknown`;
  - the picked key lands on the sheet.
- `test/lock-busy-frontend.test.js`: new write path `setDischargeContinuity`.
- `test/helpers/server-echo.js`: echoes `setDischargeContinuity`.
- SW pin updated in `dashboard-perf-assets`.

## Security

- No new `/api/` route and no Code.gs change. The server already validates the
  key per row, under the lock.
- No secrets.
- `npm audit`: 0 high / 0 critical (1 pre-existing moderate).
