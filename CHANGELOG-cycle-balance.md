# The cycle balance — one rule for גבייה, בקרת גבייה and «מטופלים»

October 11, 2026. **Railway + Code.gs** (clasp CI on merge; Code.gs is in its
own commit). No column, sheet, Script Property, env var or trigger. Nothing
is written by code; one editor-only repair function is added (dry run by
default, **not run**). SW `CACHE_VERSION` v58 → **v61** (live is v58; v59 /
v60 are claimed by the tab-order and payment-status PRs; v17 stays burned).
Outpatient and the shared revenue rules (`buildMonthlyRevenue`, the month
split, «נגבה», «הכנסה מאומתת») are untouched.

## The rule (Sandra, 11/10/2026)

- A cycle is one coverage period: entry date → +1 month. Its price is owed
  **once** for the whole period.
- Splitting it across calendar months is revenue allocation / display only
  and never creates a balance.
- **Balance = the cycle's expected amount − every payment attached to the
  cycle**, whatever calendar month the money or a slice of it falls in.
- **Expected amount:** a cycle already settled (stored «שולם», or paid ≥ its
  stamped amount) stays settled at what was billed. An **open** cycle owes:
  1. the per-month override;
  2. else the patient's **agreed price** (Patients `pay`, «תשלום כולל מעמ»);
  3. else the stamped amount.
- A full payment → balance 0, «שולם», no «דווח תשלום», not under «יתרות
  פתוחות מתאריכים קודמים».

## Investigation — per case, against the live sheet (11/10/2026)

**Calendar months were not the cause.** No code path in גבייה, בקרת גבייה or
the patient card filters a payment by calendar month for the balance. The
server links each receipt to its cycle by the receipt's coverage start inside
the cycle window (`linkReceiptsToCycles_`). It re-derives the cycle from all
of them (`recomputeCycleFromReceipts_`). The month split (`coverageSplitHtml`,
הכנסות חודשיות) is display only. Every receipt below was received on 11/10
— the next calendar month for the September cycles — and **was** counted.
The balances came from the **expected amount**.

**33,000 vs 30,000 is not VAT.** Patients `pay` and every Payments amount
are stored VAT-inclusive; 30,000 × 1.18 = 35,400. The 33,000 is a stamped
price, explained per case below.

| Case (as shown) | Sheet rows | Expected — from where | Payments summed | Root cause | After this PR |
| --- | --- | --- | --- | --- | --- |
| **אוריאן אלון** — ריהאב, 22/09–21/10, 30,000, paid 20,000 / balance 10,000 | Payments 95 (cycle, legacy amountPaid 20,000 by שירן on 22/09); Patients 51: pay 30,000, note «שולם 20,000 ב15/10 ישולם עוד 10000 שח» | agreed price 30,000 = stamped; no override | 20,000 — all of it | **None — the balance is genuine.** 10,000 is due on 15/10 per the patient note. | unchanged: «שולם חלקית», 10,000, «דווח תשלום» stays |
| **ינון כהן** — ריהאב, 23/09–22/10, 30,000, paid 25,000 / balance 5,000 | Payments 121 (cycle) + 122 (receipt, 25,000 צ'ק, received 11/10, confirmed by אורטל); Patients 72: pay 30,000; BillingOverrides: 2026-08 = 25,000 | agreed price 30,000 = stamped. The 25,000 override is for **August only** (overrides are per month) | 25,000 — all of it, in the next calendar month | The agreed price on the sheet is still 30,000; the August discount was never extended to September. Not a code bug. | unchanged (5,000) until Sandra decides: see «Data» |
| **סמיר בן מיור** (sheet: **טמיר בן מיור**) — עפרוני, 27/09–26/10, 33,000, paid 30,000 / balance 3,000 | Payments 133 (cycle) + 134 (receipt, 30,000 העברה, received 11/10, confirmed); Patients 20: pay 33,000; July cycle (row 35) billed and paid 33,000; BillingOverrides: 2026-08 = 30,000 | agreed price 33,000 = stamped. The 30,000 override is for **August only** | 30,000 — all of it | Same as ינון: the agreed price on the sheet is 33,000; August's 30,000 was month-scoped. Not VAT, not a month split. | unchanged (3,000) until Sandra decides |
| **אליהו חן** — עפרוני, 01/10–31/10, 33,000, paid 30,000 / balance 3,000 | Payments 125 (cycle, amount 33,000) + 126 (receipt, 30,000 העברה, received 11/10, confirmed); Patients 50: pay **30,000** | **stale stamp.** On 04/10 the house move הפרדס → עפרוני rewrote `pay` (AuditLog: changed houseId, pay). The 11/10 08:21 report created the cycle at that pay, 33,000. At 08:23 Vered set `pay` to 30,000; the frozen cycle kept 33,000 | 30,000 — all of it | the cycle's amount is frozen at creation; a later correction of the agreed price never reached it | **expected 30,000 → balance 0, «שולם», no «דווח תשלום», off «יתרות פתוחות»** |

Same root cause found on two more live rows:
- **שחר חיון**, Payments 127: stamped 35,000; the 32,000 report was at 08:28 and pay was corrected to 32,000 at 08:32. Now paid.
- **נועם שני**, Payments 112: stamped 30,000; the 28,000 report was on 05/10 and pay was corrected to 28,000 on 06/10. Now paid.

## The fix

- **`lib/cycle-balance.js`** (new, pure, no I/O, no clock), loaded by the
  page as `window.CycleBalance`. It provides `cycleWindow`, `paymentInCycle`,
  `paidInCycle`, `cycleExpected`, `cycleBalance` and `cycleState`.
- **Code.gs `cycleBalanceState_`** is the same rule; Apps Script cannot
  require a file. A parity test runs both over 3,600 inputs. The cycle
  window is also checked against `receiptCycleWindow_`.
- **app.js `cycleView(pay, patient)`** applies the override overlay
  (unchanged), then the shared rule. Every money screen uses it:
  - גבייה: the due list (`paymentForPatientOnDate`), «יתרות פתוחות מתאריכים
    קודמים» (it now filters on the shared status), and the monthly summary
    (יתרה);
  - «מטופלים» / the patient card: `patientPaymentState`;
  - בקרת גבייה: the open-debt ids behind «השלמת גורם מממן» and, server side,
    `debtAging_`. That feeds the tab's «חובות מעל 60 יום» card and list and
    the debt-aging report, now with the same expected amount.
- If the module fails to load, the page keeps the stored figures (as before).

## Data — repair available, NOT run

`repairStaleCycleAmountsNow()` (Apps Script editor) is a **dry run by
default**: it logs and returns the plan and writes nothing.
`repairStaleCycleAmountsNow(true)` applies it under the script lock. It
re-checks each row (same id, amount, amountPaid, status) and writes only
`amount` / `balance` / `status`, with one AuditLog `cycle_amount_repaired`
per row. A row is planned only if all of these hold:
- it is an open cycle (not a receipt, not void);
- it has exactly one owner patient;
- its expected amount comes from the agreed price or the override and
  differs from the stamp.

Expected plan on the live sheet (11/10/2026):

| Payments row | Patient | amount | status → |
| --- | --- | --- | --- |
| 112 | נועם שני | 30,000 → 28,000 | partial → paid, balance 0 |
| 125 | אליהו חן | 33,000 → 30,000 | partial → paid, balance 0 |
| 127 | שחר חיון | 35,000 → 32,000 | partial → paid, balance 0 |

The display is already correct without it. The repair only aligns the stored
row for other readers of the Payments sheet (accounting feed, exports).

**Needs a decision, not a repair:** Payments **121** (ינון כהן, 5,000) and
**133** (טמיר בן מיור, 3,000). If the agreed price from August on is 25,000 /
30,000, set that on the patient (Patients `pay`) or add a 2026-09 override.
The rule then reads both as paid, and the repair function will plan them.

## Tests

- New `test/cycle-balance.test.js` (14):
  - full payment across a month boundary → 0;
  - genuine partial → its balance;
  - a payment dated in the next calendar month counts (module + Code.gs
    derivation);
  - expected-amount source: agreed over stale stamp, override over agreed,
    settled stays settled, not VAT;
  - parity grid;
  - גבייה row / open list / «דווח תשלום»;
  - «מטופלים» = גבייה;
  - monthly summary;
  - graceful without the module;
  - **בקרת גבייה totals (`debtAging_`) = the sum of יתרות פתוחות** (18,000);
  - repair dry run writes nothing;
  - repair apply writes only the planned rows, audited, and skips a row
    changed since the plan;
  - repair refuses an ambiguous owner, void and receipt rows;
  - wiring.
  Nine of the fourteen fail on the previous code (the pure-module ones and
  the graceful fallback pass on either).
- `test/funder-grace.test.js`: the BUNDLE_PATHS check no longer requires
  funder-grace to be last.
- `test/dashboard-perf-assets.test.js`: the new asset is hashed; pins v61.
- `test/refund-logic-wiring.test.js`: the pre-existing clock bug (same fix as
  the tab-order PR).
