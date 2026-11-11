# CHANGELOG — the «הכנסות חודשיות» engine as a shared file (foundation, no user-facing change)

Date: 2026-11-11 · Branch `claude/month-view` → base `claude/build-ezone-dashboard-QOg5s`
Foundation for «תפוסה והכנסות לפי חודש» in the CRM (`CHANGELOG-crm-month-view.md`).

## Why
Monthly revenue is computed by `buildMonthlyRevenue()` inside the classic page's `app.js`,
a browser global script the CRM page cannot load. The CRM must show the SAME figures, so a
second implementation was not an option.

## What
- `scripts/build-revenue-engine.js` copies the engine's 84 top-level declarations
  **verbatim** out of `public/app.js` (the dependency closure of `buildMonthlyRevenue` and of
  the normalisers that turn raw `getData` / `getPayments` / `getCredits` answers into its
  inputs) into **`public/revenue-engine.js`** — a self-contained file exposing
  `RevenueEngine.monthModel({ month, data, payments, credits, today })`.
- `app.js` stays the single source of truth and is **not modified**. The classic page does
  not load the new file. Nothing a user sees changes in this PR.

## Rule for future changes
Edit the rule in `app.js`, then run `node scripts/build-revenue-engine.js` and commit both.
Never edit `public/revenue-engine.js` by hand.

## Guards (`test/revenue-engine-shared.test.js`, 6)
- the checked-in file equals what the script generates from today's `app.js`
  (an `app.js` rule change without a re-run fails CI);
- **parity**: on the same raw answers, seven months in a row, the engine's model deep-equals
  `app.js`'s own normalise + `buildMonthlyRevenue` (received, expected, credits, net, per
  house, «מאומת»);
- a missing / duplicated declaration is an error, never a guess;
- self-contained: defines only `RevenueEngine`; no DOM, storage or network.

## Security
Pure computation; no route, no action, no data change. No Code.gs / Railway change.
`npm audit`: 0 high / critical.
