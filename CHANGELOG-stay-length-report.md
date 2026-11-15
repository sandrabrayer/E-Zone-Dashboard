# «משך שהייה» — every stay with its details

Sandra, 15/11/2026: «אני רוצה לספור משך שהייה של מטופלים ומה הפרטים שלהם — זמן, בית,
גורם מפנה וכו'». CRM only — no Code.gs change, no new action, nothing written.

## The tab

Menu → «דוחות והגדרות» → **«משך שהייה»**. For Vered, Sandra and Dana (not Ortal).

- **One line per stay:** patient, house, referrer, entry, exit, days of stay,
  status (still in treatment / discharged), continuity of care. A returning
  patient has a line per stay. A line opens the patient.
- **«מי לכלול»:** discharged in the period (default) · entered in the period ·
  in a house during the period · all stays. Period: 1 January → today by default.
- **Filters:** status, house, referrer, length (up to 30 / 31–60 / 61–90 / 91+),
  free search.
- **«חתך לפי»:** house · referrer · length · entry month · continuity · status —
  a summary line per group: stays, average days, median, shortest, longest,
  total days.
- **Cards:** stays, average and median days (all / discharged / still in
  treatment), and how many in each length band.
- **«הורדה לאקסל (CSV)»** of exactly the lines on screen.

## The rules

- Days = exit date − entry date (not inclusive); a stay still in treatment
  counts to today. The same stay rules as the KPI cards
  (`lib/patient-retention.js`); stays with missing dates are not listed and
  their number is stated under the table.
- Referrer = the patient's own «מקור»; if empty, the source of the lead the
  patient came from; else «לא צוין».

The existing KPI card «משך שהייה והמשך טיפול» is unchanged (it counts the
patients who entered in the KPI period).

## Security

Display only, from `getData` already read; no price or payment field is used.
Filter keys are allow-listed; every cell is escaped; the CSV defuses cells that
start with `= + - @` (formula injection). `npm audit`: 0 high / critical.

## Files

`public/crm/crm.js`, `public/sw.js` (v140 → v141, from the live v140),
`test/stay-length-report.test.js` (new, 6), a browser scenario in
`test/crm-shell-browser.test.js`, `test/crm-kpi-tab.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`.
