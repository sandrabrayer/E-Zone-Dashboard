# גבייה search finds the patient — any status, every cycle (classic + CRM)

October 28, 2026. **Railway only** (`public/`). Code.gs not touched — no
Apps Script deploy, no column, sheet, Script Property or env var. SW
`CACHE_VERSION` v94 → **v95** (live `/sw.js` read **v93** on 28/10/2026 with
v94 already on the deploy branch and Railway behind it; monotonic, v17 stays
burned).

## The bug (Vered, 28/10/2026, classic view)

Typing «אביעד» in the גבייה search box changed nothing: the three KPI cards
read 0 and both lists said «אין תשלומים לגבייה בתאריך זה» / «אין יתרות
פתוחות מתאריכים קודמים» — exactly what they said before typing.

**Root cause** (`public/app.js`, `renderBilling` → `renderBillingDueList` /
`renderBillingOpenList`): the box is a *filter* over two lists that are both
**date-scoped** — patients due on the selected date (`patientsDueOn`, which
requires the stay to cover that date) and open balances dated before it. A
patient with nothing due that day and no open balance is not in the searched
population at all, so a name produces no change; a released patient (אביעד:
rehab, released 06/09/2026, both cycles paid) never can be. The empty text
then reads as "no payments today" rather than "not found".

The CRM «גבייה» area had no search at all: the top box switched the area to
«לידים» as soon as a letter was typed.

## What changed

### Classic (`public/index.html`, `public/app.js`, `public/style.css`)

- A third group, **«תוצאות חיפוש — כל המחזורים»** (`#billing-search-group`,
  grey token, hidden while the box is empty), rendered by
  `renderBillingSearchResults(q)` right after the two existing lists on every
  keystroke. The two existing lists and the KPI cards behave exactly as before.
- `billingSearchHits(q, patients, discharged, payments, leads)` (pure) finds
  the **patient**, not the date:
  - every patient in `state.patients` whose name / house label matches
    (`dischargedPatientMatchesQuery` — the shared matcher), **any status**
    (active, trial, wait, released), with **all** their cycle rows
    (`paymentBelongsToPatient`; `rcpt-` receipts excluded), newest due date
    first;
  - discharged rows whose patient is no longer on the Patients tab (same
    house + normalized name as a listed patient → not repeated; `deletedAt` /
    restored rows skipped), with cycle rows matched by house + name;
  - cycle rows that belong to nobody, found by their own `patientName`, under a
    pseudo-patient marked «תשלום ללא שיוך למטופל».
- Each hit has a header line — name · house · status · כניסה · יציאה
  (`billingSearchHitMeta`) and a cycle count — then its rows through the
  existing `buildBillingRow` (override-aware via `cycleView` for real
  patients), so every action on a row (report, override, void …) is the same
  control as in the other two lists. A found patient with no cycles says
  «אין מחזורי תשלום רשומים».
- Nobody at all: **«לא נמצא מטופל בשם «…» — לא בבתים, לא בין המשוחררים ולא
  בתשלומים»** — explicit, instead of looking like "no payments today".
- Every rendered value goes through `escapeHtml`. No new endpoint; reads
  only what the page already holds.

### CRM (`public/crm/crm.js`)

- The top search box **stays on «גבייה»** when typed there (it still jumps to
  «לידים» from any other non-list area).
- `billingSearch(overview, q, patients)` (pure, exported) narrows the overview
  to one name: matching debtors, matching receipts, and every other patient
  whose name / house matches (released included) — all words, any order,
  case-insensitive. `renderBilling` shows them above the overview as
  «תוצאות חיפוש «…»» with three small tables (debtors → drawer, people →
  drawer «חשבון», receipts) and the explicit not-found line; the overview
  below is unchanged.

## Tests

- `test/billing-search-any-patient.test.js` (new, 11): the reproduction
  (released patient, nothing due, found with both cycles and no receipt),
  blank query → nothing, house match, patient with no cycles, orphan rows,
  discharged-row de-duplication and skipping of deleted rows, meta lines,
  markup + render wiring + escaping; CRM: null on blank, released patient
  found with receipts and not repeated as a debtor, word order, house, nobody,
  and the search-box area rule.
- `test/dashboard-perf-assets.test.js`, `test/crm-pwa.test.js`: v95 pins.
- Full suite: 3576 tests, green. `npm audit`: 0 high / critical.
