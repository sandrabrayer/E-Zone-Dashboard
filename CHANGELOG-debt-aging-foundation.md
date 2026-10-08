# Debt aging, as of any date — foundation (read-only)

Plan: `docs/billing-control-plan.md` §14.1. Branch `feat/debt-aging-foundation`
→ base `claude/build-ezone-dashboard-QOg5s`. Only `apps-script/Code.gs` changes
code (its own commit). **No user-facing change:** no UI, nothing in `public/`,
no `CACHE_VERSION` bump, no `server.js` change, no sheet write.

## What it answers

"How much is owed, and how old is it, as of date D?" D is any day (default:
today in Asia/Jerusalem), so a historical date such as 2026-08-31 gives the
picture as it stood that evening.

## The rules (decided by Sandra, 2026-10-02)

| # | Rule | How the code applies it |
|---|---|---|
| 1 | Outstanding at D = charges for cycles that **started** on or before D, minus payments **received** on or before D | A cycle counts when its start ≤ D. Money counts when its received day ≤ D. The received day is `chargedAt` (see "Rule conflicts" below). |
| 2 | Two figures, never summed | `recorded_debt` (a Payments row exists and is short at D) and `unrecorded_cycles` (no row at all, «לא שולם, או ששולם ולא הוזן»). No field adds them; a test walks every key. |
| 3 | Cycles from the entry date, same clamp as `computeRefund_`; overrides applied; a recorded coverage period wins | Cycle starts: `recCycleDueDates_`. Cycle ends: `refundAddMonths_` (the `computeRefund_` clamp). Amount: `recApplyOverride_`. A row with a usable `coverageStart`/`coverageEnd` uses that period for start, end, the as-of test, the cutoff and the age. |
| 4 | Only cycles starting on/after 2026-07-01; active and discharged; a discharge ends the cycles | `recBeforeCutoff_` / `recRecordsCutoff_`. Every Patients row is read, released included. No cycle starts on or after the exit (`recCycleDueDates_`), and the exit cycle's `end` is clipped to the exit day. |
| 5 | Void out; detached listed separately with a total | `status: 'void'` rows are skipped and claim no cycle (`voidExcluded` counts them). A row is **detached** when `linkStatus === 'not_a_patient'` or the four-tier match (`recMatchPatient_`) finds no single patient. It goes to `detachedPayments` with `count`, `amount` and `receivedByAsOf`. |
| 6 | VAT-inclusive | The stored figures, never divided. `vatInclusive: true`. |
| 7 | Credits not subtracted; pending credits at D per house beside the debt | `pendingCredits` (see below). The debt is identical with and without credits (tested). |
| 8 | Aging from cycle start to D: 0–7, 8–30, 31–60, 61+ | `DEBT_AGING_BUCKETS`: `d0_7`, `d8_30`, `d31_60`, `d61_plus`. |

## What changed (`apps-script/Code.gs`)

- **`debtAging_(asOfIso, tabs)`**: a pure function. `tabs` has the same shape
  `recCollect_` produces: `{ patients, payments, credits, overrides }`, each
  `{ rows: [{ rowNumber, obj }] }`. It reads no service and has no clock
  except for a blank `asOf`. It returns:
  - `totals`: `{ recorded_debt, unrecorded_cycles }`, each
    `{ count, total, d0_7, d8_30, d31_60, d61_plus }`;
  - `byHouse`: the same split per house id;
  - `byPatient`: `patientId`, `patientKey`, `name`, `houseId`, `status`,
    `entryDate`, `exitDate`, `inHouseAtAsOf`, `settledCycles` and
    `cycles: [{ start, end, expected, received, balance, days, bucket, kind, … }]`,
    where `kind` is `recorded` or `unrecorded`. Only owed cycles are listed;
    the fully paid ones are counted in `settledCycles`;
  - `detachedPayments`: `{ count, amount, receivedByAsOf, rows }`;
  - `pendingCredits`: `{ count, total, createdDateUnknown, byHouse }`;
  - other figures that are reported, never silent: `receivedDateUnknown`,
    `outsideStay`, `releasedWithoutExit`, `noEntryDate`, `voidExcluded`.
- **`debtAgingAction_(params)`** and the action **`debtAging`**
  (`asOf=YYYY-MM-DD`):
  - read-only: it reads `Patients`, `Payments`, `Credits` and
    `BillingOverrides` with `getSheetByName` and `recReadSheet_`, and never
    creates a tab, locks, writes or logs;
  - gated by `PROXY_SECRET`. It is **not** in `OPEN_ACTIONS`, and it is added
    to `PROXY_KNOWN_ACTIONS`;
  - a bad `asOf` (`2026-02-30`, `30/09/2026`, a number) →
    `{ ok:false, error:'bad_asOf' }`. A blank `asOf` → today.
- Small helpers: `debtAgingAsOf_`, `debtAgingBucket_`, `debtAgingCycleEnd_`,
  `debtAgingReceivedOn_`, `debtAgingEmpty_`, `debtAgingAdd_`.
- **No second engine.** The block reuses `recModel_` (normalizing and the
  payment→patient match), `recCycleDueDates_`, `recStayCovers_`,
  `recExitISO_`, `recApplyOverride_`, `recBeforeCutoff_`, `refundAddMonths_`,
  `refundDayNum_` and `refundForecastIso_`. A test checks the reuse in the
  source.

### How a payment row meets a cycle

Each matched, non-void row is one recorded cycle, as in the monthly revenue
view. The row claims its derived cycle by exact due date, or by the same
month, the same "drifted a day" rule `buildMonthlyRevenue` uses. Every
unclaimed derived cycle is an unrecorded cycle.

### Pending credits at D

The Credits sheet keeps no status history, so "pending at D" is
reconstructed:
- **Created on or before D:** `createdAt`, else `decidedDate`. When both are
  blank, the credit is counted and `createdDateUnknown` goes up.
- **Then by status:**
  - `pending` → pending at D;
  - `paid` → pending only if `paidDate` is after D;
  - `cancelled` → never pending. No cancel date is stored.
- Only amounts > 0 count.

## Rule conflicts found (reported, not silently resolved)

1. **There is no "actual paid date" on Payments.** The closest field is
   `chargedAt`, which has three problems:
   - It means "**reported** paid in the dashboard", not "arrived in the
     bank".
   - It is **re-stamped every time `amountPaid` changes**
     (`stampPaymentRow_`). A partial payment that is topped up later moves
     the whole `amountPaid` to the top-up day, so at a D between the two
     payments, the first part reads as not yet received. That overstates the
     debt.
   - **Paid rows written before the column existed have a blank
     `chargedAt`.** They are dated to their cycle start and counted in
     `receivedDateUnknown` (`{count, amount}`).

   A real `paidOn` (plan §5.1, `PaymentReports`) would fix all three.
2. **Records cutoff vs the monthly revenue view (#140).** `buildMonthlyRevenue`
   keeps a **recorded** row dated before 2026-07-01 in EXPECTED ("a recorded
   pre-cutoff row still counts"). Rule 4 excludes every cycle before the
   cutoff, so debt aging drops it. Asserted in the cross-check test.
3. **A recorded row after the exit.** The revenue view counts its shortfall in
   EXPECTED (`billed_unpaid`). Rule 4 ends the cycles at the exit, so debt
   aging lists it under `outsideStay` and never as debt. Asserted.
4. **Overrides on paid or partial rows.** Rule 3 says "billing amount with
   overrides applied". The existing rule (`applyBillingOverride` /
   `recApplyOverride_`) applies an override **only to unpaid rows**: paid and
   partial rows are history. Debt aging keeps the existing rule, so a partial
   row's expected amount is its stored amount. If the override should win
   there too, both the גבייה tab and this engine need to change together.
5. **A cycle starting on the exit day.** The stay window includes the exit
   day, but the existing cycle helpers (`recCycleDueDates_`,
   `projectedCycleDueDates`) create **no** cycle on or after it. Debt aging
   follows the cycle helpers.
6. **Released with no exit date.** The existing stay rule treats such a
   patient as gone, with no invented cycles. Debt aging does the same and
   lists them in `releasedWithoutExit`. Their recorded rows still count.

## Cross-check with the monthly revenue view (#133)

For September 2026, today = 2026-09-30, on one fixture:
- every revenue `unbilled_past` row equals a debt aging `unrecorded` cycle
  (same patient, same start, `fullAmount === expected`);
- every debt aging `recorded` cycle equals a revenue `billed_unpaid` row
  (`fullAmount === balance`).

The **only** difference is conflict 3 above (the after-exit row), and the
test pins it. Conflict 2 is checked on July. The exit-straddling cycle agrees:
revenue truncates only the **in-month share**, and its `fullAmount` is the
full contracted amount, like `expected` here.

## Tests

`test/debt-aging-foundation.test.js`, 24 tests (vm sandbox on the real
`Code.gs` and `public/app.js`, TZ Asia/Jerusalem, synthetic names). It covers:
- the as-of logic: a payment after D and a cycle after D, and a cycle on D;
- 2026-08-31 vs today on one fixture, with exact totals per bucket;
- the two figures are never summed (every key walked), and per-house sums
  match the totals;
- a partial payment; an override (recorded and unrecorded); a coverage
  period; a void row; detached payments; the pre-cutoff cycle; a discharge;
  bucket boundaries 7/8, 30/31 and 60/61, through the engine; the month clamp
  (against `computeRefund_`, and February);
- an invalid `asOf`, and the Jerusalem day for a blank one;
- pending credits at D; the unknown received date; VAT-inclusive amounts;
- purity, with the input unchanged and no service touched;
- the action: same answer as the function, no write, refused without
  `PROXY_SECRET` in enforce mode (and a secret in the URL does not count),
  not open, and known;
- a read-only source guard; `getData` keeps its keys;
- the two cross-checks.

**Full suite: 1737 / 1737** (1713 before).

## For Sandra

Nothing to set. Once this is merged, clasp CI deploys `Code.gs`. The action
is only reachable with `PROXY_SECRET` (the Dashboard proxy). Nothing in the
app calls it yet. The UI is a later PR.
