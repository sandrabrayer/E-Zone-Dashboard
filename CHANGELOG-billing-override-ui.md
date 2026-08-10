# Billing override UI — edit סכום חודשי per month (billing PR 2)

Builds on the PR 1 foundation (#77). The billing tab's סכום חודשי is now
editable **per month**: an edit writes an override for the selected month only,
the patient's base amount is never touched, and everything derived from the
row follows the effective amount.

## What changed (`public/app.js`, `public/style.css` — frontend only)

### The overlay rule — one choke point for every derived figure

- **`billingOverrideFor(overrides, patientId, month)`** + **`applyBillingOverride(payment, overrides)`**
  (pure): an **unpaid** record's `amount` follows the override for its
  due-date month (balance recomputed); **paid/partial records are history and
  are never rewritten**.
- **`paymentForPatientOnDate` is override-aware** — both the in-memory
  placeholder and a persisted unpaid record come back overlaid. Because every
  consumer already routes through it, the override automatically drives: the
  row's displayed amount, **יתרה**, the due-list KPI totals, and the
  **renewal confirm dialog + write** (a renewal in an overridden month charges
  the override amount).
- Due-list KPI **סך לגבייה now sums the effective payment amounts** (it
  previously summed base `pay` directly — a pre-existing inconsistency that
  would have ignored overrides).
- **Monthly summary + per-house breakdown** overlay overrides before summing
  outstanding; collected sums `amountPaid` and is untouched.
- **Carry-forward rows** (past open balances) are overlaid too, so an edited
  past month balances at its effective amount.

### The editor

- On editable rows (current-list, edit mode, not paid/partial) the amount cell
  gains a **✏️ pencil** → inline number input + שמור/ביטול. Saving writes the
  override **for that row's month only** via `saveBillingOverride`
  (optimistic + rollback, closeLead/dischargePatient pattern; re-saving the
  same month **replaces** — deterministic `ovr::` id + backend upsert).
- An active override shows the **`מותאם` badge** (blue, informational) and an
  **↩ clear control** → `clearBillingOverride` (optimistic + rollback) —
  reverts to the base amount.
- Hebrew strings, RTL-safe styling (inline-flex + gap, no directional
  margins). Double-fire guarded via `withBusyButton`; the optimistic
  re-render showing the new amount is the visual feedback.

### Ex-VAT rule — respected, untouched

The billing tab remains VAT-inclusive by design (gross collection); the
dashboard revenue KPI (`monthlyRevenueExVat`, ÷1.18) is a **run-rate over base
pay** and is intentionally not affected by per-month overrides; the growth
graph stays VAT-inclusive. No display-rule changes anywhere.

## Tests — `test/billing-override-ui.test.js` (12 new)

- Overlay: unpaid replaced + balance recomputed; **paid/partial never
  rewritten**; no-op without a match.
- Effective amounts: placeholder + persisted-unpaid overlaid; **month
  isolation** (override in month X leaves months W/Y at base); **clear
  restores base**.
- KPI aggregation: monthly-summary outstanding shows the override amount,
  collected unaffected.
- Workers: upsert action payload, optimistic apply, **replace-not-duplicate**
  on re-save, rollback on failure — for save and clear both.
- Rendering: badge + clear control only with an active override; effective
  amount rendered; paid rows and carry-forward rows offer no editing.

Full suite: `npm test` — **440 pass, 0 fail** (428 + 12).

## Deploy

Frontend only — no Code.gs change (PR 1's backend actions already live), no
server change. Railway redeploys on merge.

## Live verification (after merge)

1. גבייה tab → edit a patient's סכום חודשי → save → reload → the saved amount
   shows **for this month only**, with the `מותאם` badge.
2. Move the billing date a month forward/back → the base amount shows (no
   leak).
3. Clear the override (↩) → the row reverts to the base amount.
