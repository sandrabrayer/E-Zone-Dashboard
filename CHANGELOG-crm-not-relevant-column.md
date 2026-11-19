# CRM leads board: «לא רלוונטי» column + «לא רלוונטי ✕» on every card

Sandra, 19/11/2026 («תעשה מקום ללידים לא רלוונטים»). Frontend only: no Code.gs, no
new action, no schema change, no Railway variable.

## What changed

- **Card action.** Every card on the leads board (לוח) has a small **«לא רלוונטי ✕»**
  button next to «שלב הבא». It opens a short drawer: the status is fixed to
  «לא רלוונטי» and a **reason is required**. Sandra's 05/11/2026 rule still applies:
  nothing closes with a field missing. The drawer suggests common reasons
  (`NOT_RELEVANT_REASONS`), but free text works too. Saving goes through the existing
  `data-form="close"` handler → `closeLeadErrors` → `closeLeadAction`, so it is the
  same `moveLeadIrrelevant` write as the lead card's «סגירת ליד»: optimistic, rolled
  back with a toast if the server refuses.
- **New column «לא רלוונטי (30 יום)».** This is the last board column (left-most in
  RTL). It shows the leads closed as «לא רלוונטי» in the last 30 days, newest first:
  name, house, owner, close date, the reason (truncated, full text on hover), and
  **«שחזור ל«<previous stage>»»**. That is the same `restoreLead` as «לידים סגורים».
  It follows the board's house / owner / search filter. Older closures and other
  statuses (סיים טיפול, הפסיק לפני הזמן, משוחרר לטיפול חוץ) stay only in
  «לידים סגורים», which is unchanged.
- The full «סגירת ליד / הסרה» form in the lead card is unchanged (all four statuses).
- Board grid goes from 4 to 5 columns (desktop and the 80vw mobile layout); the board
  scrolls inside itself, not the page.
- Service worker cache v146 → v147.

## Trace (read-only findings that drove the design)

- `renderLeads` → `board(c.leads, f)` builds the 4 stage columns from `STAGES`;
  cards had only «שלב הבא» (`data-stage-next`).
- Closing already existed: `closeRecord` + `closeLeadAction` (`moveLeadIrrelevant`,
  optimistic + undo); `closeLeadErrors` requires a status and a reason.
  `restoreLeadAction` (`restoreLead`) puts the lead back at `originSheet`.
- Closed leads come from getData's `irrelevantLeads`. `closedDisposition` is the
  classic `computeDisposition`; legacy rows map through `not_relevant_reason`.
- Every count (menu badge, funnel, KPI, «היום שלי», «מכבי», triage) reads `leads`,
  never `irrelevantLeads`.

## Decisions

1. The column reads `irrelevantLeads` only, so it is display-only and adds to no count.
   A lead closed from its card leaves the open-lead badge as before.
2. The reason stays **required**, following Sandra's 05/11 rule rather than the
   handoff draft's "optional reason".
3. Restore keeps the existing behaviour: back to the stage it was closed from
   (`originSheet`), not always «ליד חדש».
4. No drag-and-drop, because the board has none.
5. 30 days is a constant (`NOT_RELEVANT_DAYS`); `notRelevantColumn(closed, f, today, days)`
   takes it as a parameter.

## Security

- Every rendered value goes through `esc()`, including the reason in text and in `title`.
  A test feeds `<b>` and checks that no element is created.
- The reason is plain text, `maxlength=500`. The server path is unchanged
  (`moveLeadIrrelevant` with its existing validation and formula neutralisation).
- No new route or action; auth and the proxy secret are unchanged. No PII in logs, and
  no secrets touched.
- `npm audit`: 0 high/critical (1 moderate, pre-existing).

## Tests

- `test/crm-not-relevant-column.test.js` (new, 10 tests):
  - pure: the 30-day window, not_relevant only, legacy mapping, filters, sort,
    defensive input, no effect on counts, the close rule;
  - source guards: the card button, the drawer reusing `data-form="close"`, the
    required reason, escaping, CSS, SW v147.
- `test/crm-shell-browser.test.js`: one new real-Chromium test. It covers: the empty
  reason is blocked; a refusal rolls back; a save posts ONE `moveLeadIrrelevant`
  (`not_relevant` + the reason); the card lands in the column, newest first; restore
  works; old and other closures are hidden; there is no page overflow at 390 px. The
  1366 px test now expects 5 columns.
- `test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`: SW v147.

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js`,
`test/crm-not-relevant-column.test.js`, `test/crm-shell-browser.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`, `CHANGELOG-crm-not-relevant-column.md`.
