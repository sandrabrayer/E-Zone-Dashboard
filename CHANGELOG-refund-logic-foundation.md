# Refund logic foundation — pure server-side rules (billing-control plan, Phase 1)

**What:** two pure functions in `apps-script/Code.gs`, `computeRefund_` and
`refundPayoutDate_`. Together they apply Sandra's refund rules (01/10/2026,
`docs/billing-control-plan.md` §8).

**Zero user-facing change.** No endpoint, no `handle_` action, no sheet read or
write, no lock, no `getData` change, nothing in `public/`, no service-worker
bump. Nothing calls the new functions yet. The live credits path is untouched:
`suggestCredits` in `app.js`, plus `payoutDateFor_` and `upsertCredit_` in
`Code.gs`. Until a later phase wires the new functions in, the live path keeps
its current behaviour: the calendar-month last 7 days, a refund on day 14, and
a payout cutoff on the 15th. A test pins this (`payoutDateFor_('2026-10-11')`
still returns `2026-10-15`).

## Commit order (TDD, per the plan)

1. `test/refund-logic-foundation.test.js` with **only** the three tests the
   plan requires first (§8.1, §8.2, §8.4). All three were red, with a
   `ReferenceError`, because the functions did not exist yet.
2. `Code.gs`: the implementation. The three tests go green.
3. The remaining tests and the docs.

## `computeRefund_(input)` → breakdown

The refund for **one** paid billing cycle. **Input:**

| field | meaning |
|---|---|
| `houseId` | Patients-sheet house id. Mapped through the existing `facilityTypeFor_`. An unknown id **throws** `unknown_house`. It never returns a silent 0. |
| `entryDate` | First day of the stay, which is day 1. |
| `exitDate` | Last day of the stay. It counts as a day stayed. An exit before the entry throws `exit_before_entry`. |
| `amountPaid` | ₪ received for this cycle, VAT-inclusive, ≥ 0. Anything else throws `bad_amount`. |
| `decidedDate` | The day the refund is decided. It drives `payoutDate`. |
| `cycleStart` | Optional. Which cycle to compute, given by its start date. It must be an entry-anchored cycle start, otherwise it throws `cycle_not_aligned`. When omitted, the function uses the cycle that contains the exit. |
| `coverageStart` / `coverageEnd` | Optional, and must be passed together. The period the payment row **records**. It wins over the derived cycle (plan §8.1). Passing only one of them throws `coverage_incomplete`. |

**Output:** `houseId, facilityType, entryDate, exitDate, stayDay, cycleStart,
cycleEnd, cycleSource, cycleDays, daysStayed, daysNotStayed, divisor,
amountPaid, dailyRate, uncappedRefund, capped, lastDaysFrom, lastDaysTo, rule,
creditType, refund, decidedDate, payoutDate`.

**Rules:**

- **Cycle.** The patient's own month, anchored on the entry date. Cycle *k*
  starts at entry + *k* months, with the day clamped to the target month's
  length. It ends the day before cycle *k+1* starts. Steps always count from
  the entry and are never chained, so a 31 Jan entry gives cycles starting on
  31/01, 28/02 and 31/03, never 28/03. In a leap year the second cycle starts
  on 29/02.
- **Rate.** `amountPaid / 30`, whatever the cycle's length. The refund is the
  rate × the days not stayed (the days after the exit until the cycle end),
  capped at `amountPaid`. The refund is computed from the unrounded rate and
  rounded to agorot. `dailyRate` is rounded for display only.
- **Balance houses** (`residential`: asher, ramot). An exit inside
  `[cycleEnd − 6, cycleEnd]` gives `residential_last_days_zero`, a refund of 0.
  Otherwise the rule is `residential_prorata`. The calendar month plays no
  part.
- **Rehab / dual-diagnosis houses** (`detox_dual`: rehab, pardes, arfoni, and
  sde through the existing map). `stayDay = exit − entry + 1`. A `stayDay` of
  14 or more gives `detox_tenure_cutoff_zero`, a refund of 0. Otherwise the
  rule is `detox_prorata`. The stay day counts from the entry, not from the
  cycle start, so any exit in the second cycle or later gives 0.
- **Prepaid cycle not yet started at the exit.** Rule `prepaid_return`: the
  full `amountPaid` comes back, in every house.
- **Cycle that ended before the exit.** Rule `cycle_fully_used`: 0.
- The "0 by policy" rules still record the raw `daysNotStayed` and
  `uncappedRefund` in the breakdown, so the decision stays auditable.

## `refundPayoutDate_(decided)`

A decision on the 1st–10th of a month is paid on the 15th of that month. A
decision on the 11th or later is paid on the 15th of the next month. December
rolls into January of the next year. An unreadable date throws `bad_date`.
New constant: `CREDIT_DECISION_CUTOFF_DAY = 10`.

## Dates

Every date input goes through `refundDateIso_`, which treats each kind of input
as follows:

- **Sheets `Date` cell:** formatted in **Asia/Jerusalem** explicitly, never in
  the spreadsheet's zone (the same trap as `managerDateIso_`, PR #154).
- **Sheets date serial:** taken as its exact day.
- **Timestamp string with a timezone marker:** converted to its Jerusalem day.
- **Bare `YYYY-MM-DD`:** accepted only if it is a real calendar day.
- **Anything else** (`DD/MM/YYYY`, blank, `2026-02-30`): throws `bad_date`.

The arithmetic runs on UTC epoch-day numbers, so neither the runtime's zone
nor the sheet's zone can shift a day.

## Constants added to `Code.gs`

`CREDIT_DAYS_DIVISOR = 30`, `CREDIT_RESIDENTIAL_LAST_DAYS = 7` and
`CREDIT_DETOX_TENURE_CUTOFF_DAYS = 14` use the same names and values as in
`app.js`. `CREDIT_DECISION_CUTOFF_DAY = 10` is new. `REFUND_MAX_CYCLES = 1200`
is a loop guard.

## Out of scope (deliberately)

- **Exceptions and write-offs** (Sandra only, server-enforced). There is no
  override parameter. Any `refund`, `override`, `exceptionApprovedBy` or
  `policyResult` field in the input is ignored, and a test checks this. A
  `TODO(Phase 0b-3, personal PINs)` sits on the function: enforcement waits
  until the user in the request can no longer be spoofed.
- Wiring into `upsertCredit_` / `policyResult`, the `app.js` side
  (`suggestCredits`, `payoutDateFor`), `USER_ROLES`, and the comparison test
  between `app.js` and `Code.gs`. All of these belong to later Phase 1 work.

## Tests

`test/refund-logic-foundation.test.js`: 19 tests, all in a vm sandbox on the
real `Code.gs`, with the spreadsheet zone set to **UTC**. They cover:

- the three plan tests (8.1, 8.2, 8.4);
- balance-house boundaries: exits on the cycle end, on end − 6 and on end − 7,
  checked against the full breakdown;
- rehab/dual-diagnosis boundaries at day 13 and day 14 in rehab, pardes and
  arfoni, plus a second-cycle exit;
- the prepaid full refund (plan 8.3) and the fully used cycle;
- the 31 Jan month clamp, plus entry-anchored stepping, a leap year and the
  December rollover;
- the 31-day cycle cap and rounding;
- recorded coverage;
- the payout date on the 10th vs the 11th and across December → January;
- a Jerusalem-midnight `Date` cell under a UTC sheet, with no `SpreadsheetApp`
  access at all;
- the unknown-house error and other bad-input errors;
- the absence of an override parameter;
- a check that nothing is wired: no call site, no action, nothing in `public/`,
  and `payoutDateFor_` unchanged.

Full suite: `node --test` → 1678 / 1678 pass.

## Deploy

`Code.gs` changes, so clasp CI deploys on merge. The deploy is behaviour-neutral
because nothing calls the new code.
