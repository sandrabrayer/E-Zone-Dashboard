# C10 — «דווח תשלום» inside the CRM — 2026-10-28

CRM restructure, Session C (seventh PR; Sandra 2026-10-28: "rebuild, then switch").
Flag-gated (`CRM_ENABLED` + `/?view=crm`). No server change, no Code.gs, no SW bump.

## What
- In a patient's «חשבון» tab every open cycle (and every stamped unpaid / partial row not already
  listed) has «דווח תשלום». The form is the SAME strict report as the classic modal: received date,
  amount (remaining prefilled), method, reference, payer, funder (prefilled only with a reportable
  one — never pro-bono / unset), coverage window (prefilled), «חשבונית?» + «על שם» (no default).
- Validation client-side through the shared `lib/payment-report-rules.js` (now loaded by the shell as
  `window.PaymentReportRules`; required under node); staff 90-day limit unless `me.approver`.
  Field errors under the fields; nothing is posted while an issue exists. Code.gs
  `validatePaymentReport_` stays the authority — its `invalid_report` issues are shown the same way.
- Server contract unchanged: `reportPayment { cycle, report, submissionId, confirmDuplicate? }`.
  One `sub-<32hex>` idempotency key per opened form, reused on the «קבלה נוספת» re-send.
  `possible_duplicate` → confirm dialog → re-send with `confirmDuplicate:true`. "Saved" only with
  `ok:true` + a receipt id; then BOTH reads (`debtAging`, `getPayments`) are re-fetched and the pane
  repainted — nothing is applied optimistically (the money a row shows is the server's).
- Cycle bodies: a recorded cycle re-sends its Payments row (id, legacy `patientId`, name, house, due,
  stamped amount, coverage); an unrecorded one is minted as the classic app does —
  `pay::<houseId>::<name>::<entryDate>::<due>` with debtAging's window and expected amount.

## Fix carried from C9
Money rows are keyed on the legacy triple `houseId::name::entryDate` (`patientId`) with the uid
alongside (`patientUid`); C9 matched the uid only, so a classic-reported row could be missed.
`patientAccount` now matches uid OR triple (`patientKeyOf`, `rowIsPatient`).

## Still classic (link at the bottom of the tab)
Credits / discounts / overrides / refunds (next PR), receipt edit / void, payment linking.

## Security
Finance-gated on the server (`FINANCE_ACTIONS`); `approver` comes from `/api/me`, never the body.
Every field through `esc()`. The write allow-list guard now includes `reportPayment`.

## Files
`public/crm/crm.js`, `public/crm/crm.html` (rules script), `public/crm/crm.css`,
`test/crm-shell-ui.test.js` (+1), `test/crm-shell-browser.test.js` (+1 Chromium scenario:
client issues, reference rule, duplicate → confirm → re-send with the same key, re-read, minted
unrecorded cycle, server issues keep the form open), ESS, `docs/crm/ROLLOUT.md`.
Rollback: flag off, or revert.
