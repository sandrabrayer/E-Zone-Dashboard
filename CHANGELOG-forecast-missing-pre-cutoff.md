# Forecast: drop pre-cutoff exit cycles from «משוחררים ללא תשלום רשום»

Fixes item 2 under "Two exceptions, reported and not fixed" in `CHANGELOG-billing-tab-section-colors.md`.

## The bug

`refundPayoutForecastFor_` filtered discharges by **exit date** only (on or after the records cutoff, 01/07/2026).

Take a patient who entered on 20/06 and left on 05/07 with no recorded payment:
- the forecast counted them in `missing_payment_data`, so they showed in the «N משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״» line;
- but their exit cycle started on 20/06, before the cutoff, so `debtAging_` has no cycle for them. They were **not** in «חובות פתוחים», although the line said they were.

## Sandra's rule

Records before 01/07/2026 were never entered. A cycle that started before the cutoff is neither debt nor a refund question. These patients are not counted and not listed.

## The fix (`apps-script/Code.gs`, its own commit)

- **New helper `refundForecastExitCycleStart_(entryIso, exitIso)`.** It returns the start of the cycle that holds the exit. It is built on `recCycleDueDates_`, the cycle helper `debtAging_` uses (entry-anchored, clamped, none on or after the exit). If the stay ends inside its first cycle, or on its entry day, the answer is the entry day.
- **In `refundPayoutForecastFor_`:** before a discharge goes into `missing_payment_data`, it checks `recBeforeCutoff_(exitCycleStart, recRecordsCutoff_())`. That is the same test and the same constant `debtAging_` uses, with no second definition. If the exit cycle started before the cutoff, the discharge is skipped.
- **New response field `preCutoffExcludedCount`.** It counts the skipped discharges, for transparency. The UI does not show it.
- **Unchanged:**
  - the exit-date filter;
  - `decided`, `awaiting_decision`, `unresolved` and `zeroByPolicyCount`;
  - the case-1 behaviour: an unpaid ₪0 row for the exit cycle is still counted, and `debtAging_` lists it under «חוב רשום»;
  - nothing in `public/`, so no service-worker bump.

## Tests

- **`test/billing-tab-section-colors.test.js`:**
  - The old combined "known exceptions" test is split in two:
    - **case 1** keeps the same assertions (counted; «חוב רשום» in debt aging);
    - **case 2** is flipped: the 20/06 → 05/07 patient is not in `missing_payment_data` (count 0, no row), not in any other section, `preCutoffExcludedCount` is 1, and `debtAging_` has no entry for them.
  - **New cross-check, with no exceptions.** Every patient counted in the «משוחררים ללא תשלום רשום» line is in `debtAging_` as of today, as recorded or unrecorded. It uses one world with 8 discharges:
    - the 4 earlier cases;
    - the unpaid ₪0 row;
    - a pre-cutoff exit cycle (excluded);
    - an exit cycle starting exactly on 01/07 (counted);
    - an exit cycle starting after 01/07 with entry before it (counted).
  - The original "C: every missing discharge is under «מחזורים ללא רישום»" test is unchanged.
- **`test/refund-payout-forecast.test.js`,** "D: the records cutoff":
  - The old fixture (entry 25/06, exit 01/07, no payment) was exactly the case this fix changes. It is now a third discharge, «מחזור לפני», and the test asserts it is excluded and counted in `preCutoffExcludedCount`.
  - The "on 01/07 included" case now uses entry 01/07, exit 01/07.
- **Before the fix,** these 3 tests fail against the old `Code.gs`. With the fix they pass.
- **Full suite: `npm test` → 1870 / 1870** (base 1868).
