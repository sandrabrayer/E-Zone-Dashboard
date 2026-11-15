# «בונוס» — Dana's lead bonus tab

Sandra, 15/11/2026: Dana gets **₪50** for every lead she brings to a visit that
takes place, and **₪100 more** if that lead enters a house (אשפוז). She needs a
tab that shows where she stands. CRM only — no Code.gs change, no new action,
nothing is written.

## The tab

Menu → «דוחות והגדרות» → **«בונוס»**. Seen by Dana («הבונוס שלי») and by Sandra
(«הבונוס של דנה»). Nobody else has it.

- Month picker (current month by default).
- Cards: total bonus this month · visits held (N × ₪50) · admissions (N × ₪100)
  · past visits waiting for a report · planned visits · running total.
- «פירוט החודש»: each lead, its visit, its admission, and the bonus per line
  (a line opens the lead).
- «בדרך — עוד לא נספר»: visits not counted yet (planned, or past and unreported).
- «לפי חודש»: every month so far.

## The rules (constants `BONUS` in `public/crm/crm.js`)

- **Her lead:** «משוייך ל» = דנה.
- **Visit took place (₪50):** the visit date has arrived AND there is evidence:
  the manager's report says it was held, or the recorded outcome is «נכנסים
  לטיפול» / «חושבים על זה» / «לא רלוונטי», or the lead was admitted after a visit.
  «לא הגיע / בוטל», cancelled and postponed earn nothing. A past visit nobody
  reported yet is «ממתין לדיווח» — ₪0 until it is reported.
- **Admission (₪100):** a patient row is linked to the lead, or the lead's
  stage is admitted. Outpatient is not counted as אשפוז.
- The visit is counted in the month of the visit; the admission in the month
  of entry. A lead closed after its visit still counts for the visit.
- No start date is applied — every month has its own line. Tell Claude a start
  date if earlier months should not count.

## Security

Display only, computed from `getData` the session already reads; no money
field of a patient is used (Dana's view has none). The tab is refused in the
menu and in the render for anyone but Dana / Sandra. Values escaped.
`npm audit`: 0 high / critical.

## Files

`public/crm/crm.js`, `public/sw.js` (v139 → v140, from the live v139),
`test/dana-bonus-tab.test.js` (new, 4), a browser scenario in
`test/crm-shell-browser.test.js`, `test/crm-kpi-tab.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`.
