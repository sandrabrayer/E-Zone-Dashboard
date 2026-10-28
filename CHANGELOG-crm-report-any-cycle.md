# C13 — report for any cycle; fix or void a receipt — 2026-10-28

CRM restructure, Session C (tenth PR). Sandra's two morning findings: (1) no «דווח תשלום» when the
patient has no open cycle (an advance); (2) "צריך גם אפשרות לתקן טעות". Flag-gated. No Code.gs,
no server change, no SW bump; classic contracts reused unchanged.

## «דווח תשלום למחזור אחר»
- Under the open cycles: a picker of every entry-anchored stay cycle not already offered by an
  open / unpaid row — past and up to 3 months ahead (Code.gs `recCycleDueDates_` rule: the entry
  day of each month, clamped to the month end; nothing on / after the exit). Default = the first
  cycle starting today or later (an advance). Amount prefilled from the patient's monthly `pay`
  (now carried by `normalise`) or the stamped row's amount.
- A stamped row is re-sent as itself; a new cycle is minted `pay::<key>::<start>` with the
  window as coverage — the same `reportPayment` flow as C10.

## Fixing a receipt (in the «תקבולים» table)
- **עריכה** → `editReceipt { edit: { id, fields: {only the changed ones}, reason? } }`. Editable:
  method, reference, payer, «חשבונית?» / «על שם», coverage — the server's `RECEIPT_EDIT_FIELDS`.
  Client-side: the shared rules on the touched fields only (a method change re-checks the
  reference, an invoice change re-checks «על שם»); "nothing changed" is refused locally.
- **ביטול** (`me.deleter`) → the classic void: `savePayment` with `status:'void'`,
  `linkStatus:'duplicate'`, the reason in `linkNote` — after a confirm. Accepted only when the
  server echoes the receipt as void. The form says plainly that amount and received date are not
  editable: void, then report again.
- A void receipt shows «בוטלה» and no buttons. Every save re-reads the three answers.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+2), `test/crm-shell-browser.test.js`
(C10 scenario extended with the advance; +1 receipt scenario), ESS, `docs/crm/ROLLOUT.md`.
Guards: writes + `editReceipt`, `savePayment`. Rollback: flag off, or revert.
