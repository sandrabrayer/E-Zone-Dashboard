# C9 — the patient drawer's «חשבון» tab over real data — 2026-10-27

CRM restructure, Session C (sixth PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no new action, no write, no SW bump (hashed assets).

## What
- A patient's drawer → «חשבון» now shows, for finance users (Vered, Sandra): open debt and its
  open cycles (window, expected, received, balance, age chip, «ללא דיווח», funder-grace chip),
  the stamped payment cycles (due date, amount, paid, status שולם / חלקי / לא שולם / בוטל),
  the patient's own receipts (date, amount, method, payer, verification chip) and the funder
  (current + history). «דווח תשלום / זיכוי» stays a link to the classic dashboard.
- The data is the SAME two reads the גבייה area uses (`debtAging` + `getPayments`), loaded once
  per page and shared: opening the tab first and then the area (or the reverse) fetches once.
  Loading waiters run after the fetch; a drawer closed in the meantime is skipped.
- A lead's «חשבון» says the account opens with admission; a non-finance user sees the
  no-permission line as before.

## Pure core (`CrmCore.patientAccount`, node-tested)
`patientAccount(patientId, debtAnswer, paymentsAnswer)` → `{ openTotal, openCycles[],
settledCycles, cycles[] (newest due first), receipts[] (own only, newest first), receivedTotal,
currentFunder, funders[] (newest effectiveFrom first), errors[] }`. Refused / missing answers
→ zeros + errors, never a throw.

## Security
Read-only; same scope as C8 (both reads already on the finance list). Every field through `esc()`.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+1), `test/crm-shell-browser.test.js`
(+1 Chromium scenario: tab content, single fetch shared with the area, lead has no account),
ESS, `docs/crm/ROLLOUT.md`. Rollback: flag off, or revert.
