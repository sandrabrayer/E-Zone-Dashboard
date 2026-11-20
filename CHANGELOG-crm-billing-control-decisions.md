# CRM — «בקרת גבייה» decisions are native (no classic page)

Sandra, 20/11/2026: Ortal's billing-control decisions were still only in the classic
page. They now live on each receipt in the CRM. Migrating every classic-only
operation so `/?view=classic` can be dropped.

## What is new

Beside the existing **«אמת»** (confirmed) and **«אימות חלקי»** (partial), each receipt
a confirmer can act on now offers:

| Button | status | Effect |
| --- | --- | --- |
| «לא שולם» | `flagged` | returns the report to Vered |
| «כפילות» | `duplicate` | **voids** the receipt (a duplicate); it is not counted |
| «לא התקבל» | `not_received` | **cancels the claim**; the cycle returns to open debt |

Each opens an inline, required **reason** (2–120 chars) and asks the same confirmation
as the classic flow. All three post the **existing `confirmPayment` contract**
(`{ ids:[one receipt], status, flagNote }`) — no new action, no new column.

## Nothing is lost

- «כפילות» and «לא התקבל» **void** the receipt — the server keeps the row (`isVoid`,
  with the reason), reversible there; the CRM keeps it too, shown as «בוטלה», never
  removed from the list.
- **R3 proof:** the receipt must come back (changed / already-in-state / voided) or the
  CRM clears nothing and tells the controller the result is unknown — a lost answer
  never silently drops a receipt.
- A void / flag changes open debt and the cycle balance, so after a proven answer the
  CRM **re-reads** the authoritative balances rather than trusting a local guess.
- Permission is the same as «אמת» (`canVerifyReceipt`), enforced server-side.

## Removed

The controller's `#crm-controller-classic` link to the classic «בקרת גבייה». (The
classic page itself still answers `/?view=classic`; it is no longer linked for these
decisions.)

## Security

No new endpoint or action; values escaped; the reason is length-capped; no receipt or
patient data logged. `npm audit`: 0 high / critical.

## Tests

- `test/crm-billing-control-decisions.test.js` (new, 5): the reason rule, the
  confirmPayment body, R3 acceptance, the keep-the-row-on-void apply, the UI wiring.
- `test/crm-shell-browser.test.js`: one scenario — Ortal marks a receipt «כפילות»
  (empty reason refused; a real decision posts the contract, the row becomes «בוטלה»,
  the balances are re-read) and «לא התקבל».
- Updated `ortal-crm-default`, `crm-switch-user-browser`, `crm-native-patient-edit`
  for the removed link.

## Files

`public/crm/crm.js`, `public/sw.js` (v151 → v152),
`test/crm-billing-control-decisions.test.js` (new), `test/crm-shell-browser.test.js`,
`test/ortal-crm-default.test.js`, `test/crm-switch-user-browser.test.js`,
`test/crm-native-patient-edit.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
