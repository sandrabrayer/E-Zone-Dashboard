# CHANGELOG — one «חוב פתוח» figure

## Why
«חוב רשום» showed ₪0 next to ₪2,067,900 of «מחזורים ללא רישום», and the
monthly card said «חוב פתוח ₪0» per house. Cause (traced in Code.gs
`debtAging_`): «חוב רשום» only counts cycles that HAVE a Payments row and are
short. A cycle nobody paid has no row at all, so every real debt landed in the
other block, and the monthly card — which only looked at rows — showed ₪0.
The split is a data artifact, not something a reader should have to understand.

## What changed (display only — no server or data change)
- **«חובות פתוחים»**: ONE «חוב פתוח» table (house × age) = every cycle that
  passed and is not paid in full. A one-line footnote says how much of it is in
  cycles with no payment row and how much in rows that were opened and not paid.
  House and patient rows show one «חוב פתוח» figure.
- **By funder**: one «חוב פתוח לפי גורם מממן» table instead of two.
- **Monthly summary** («נגבה החודש» / «יתרה פתוחה» / per-house card): «חוב
  פתוח» of the month is now every owed cycle of that month from the debt report
  (as of today), so it no longer reads ₪0 when nothing was recorded. Wording:
  «נגבה» → «שולם». The report is loaded once when «גבייה» is opened — never at
  boot, on a filter or on a re-render. Until it arrives (or if it fails), the
  old row-only figure is shown.
- The Excel export keeps its two sheets and labels (unchanged).
- `debtAgingView` (app.js and lib/debt-aging-xlsx.js, pinned equal) gains
  `tables.open_debt` and per-patient `openTotal`.
- Service worker v87 (live was v86). No Railway change; no Apps Script change.

## Tests
Updated the tests that pinned the two-block layout (browser + DOM + strip);
new: monthly open debt by house, one-headline view/DOM, load-on-open wiring.
