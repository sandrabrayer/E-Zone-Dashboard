# CHANGELOG — Billing tab search

## What

Live search filter on the גבייה (billing) tab, following the discharged-tab
search (PR #86): an RTL search input (`חיפוש מטופל...`) in the screen header,
filtering both billing lists on every keystroke by patient name, phone, and
house label.

## Behavior

- **Live filtering** — `input` event, no button; same immediate-on-input
  pattern as every other tab search.
- **Both lists filtered** — לגבייה בתאריך הנבחר (due list) AND יתרות פתוחות
  מתאריכים קודמים (carry-forward list).
- **Fields matched** — same shared semantics as the discharged search
  (`dischargedPatientMatchesQuery` is the shared core): name and house label
  by lowercased substring; phone by raw substring OR normalized digits via
  `normalizePhone`. Name falls back to `payment.patientName` and the house
  resolves `payment.houseId` before `patient.houseId` — mirroring exactly what
  `buildBillingRow` displays, including orphaned carry-forward rows whose
  patient was released/renamed.
- **KPI cards reflect the filter** — the three stat cards (מטופלים לתשלום /
  סך לגבייה / נגבה בתאריך הנבחר) recompute from the FILTERED due list, same
  "counts match what the list shows" rule as the discharged tab's count pill.
  With an empty query they are byte-identical to the previous behavior.
- **Monthly summary untouched** — סיכום חודשי stays a month-scoped aggregate,
  deliberately not filtered by the search.
- **Empty states** — zero matches while searching → `לא נמצאו תוצאות` in the
  affected list; genuinely empty lists keep their original messages
  (אין תשלומים לגבייה בתאריך זה / אין יתרות פתוחות מתאריכים קודמים).
- **Empty query** — everything renders exactly as before.

## Implementation

- `public/index.html` — added the standard `input[type=search]` (placeholder
  `חיפוש מטופל...`) to the existing billing `.actions` block, next to the
  date picker. No new CSS — the existing `.actions input[type=search]` rules
  (incl. mobile full-width) apply.
- `public/app.js`
  - `state.billingSearch` + input wiring (trim + lowercase, re-render on
    input), mirroring the other tab searches.
  - `billingRowMatchesQuery(patient, payment, q)` — pure per-row matcher
    delegating to `dischargedPatientMatchesQuery`; consults both the patient
    object and the payment record for name/house.
  - `renderBilling()` — filters the due list before the KPI reductions and
    passes the unfiltered count down for the empty-state message.
  - `renderBillingDueList()` / `renderBillingOpenList()` — apply the filter;
    the open list was restructured to build its `{patient, pay}` pairs first
    (behavior otherwise unchanged, incl. override overlay + pseudo-patient
    fallback) so the same matcher runs on exactly what the row will display.
- **Zero `Code.gs` changes** — frontend only. The patient schema is untouched
  (patients carry no phone today; the phone leg is defensive and activates
  whenever a phone field is present on the row's patient/payment).

## Tests

- `test/billing-search.test.js` — new, same vm-sandbox approach as
  `discharged-search.test.js`. Covers: empty query, name via patient +
  fallback via `payment.patientName` (orphaned rows), phone across formatting
  via `normalizePhone`, house via `payment.houseId`-first resolution + raw-id
  fallback, no-match, and null safety.
- Full suite: 515/515 pass.
