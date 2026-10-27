# C8 — «גבייה» inside the CRM, read-only overview — 2026-10-27

CRM restructure, Session C (fifth PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no new action, no write, no SW bump (hashed assets).

## What the area shows
Built from TWO existing finance reads, fetched on the FIRST open of «גבייה» only (never on boot —
both are heavier than `getData`; «נסי שוב» refetches):
- `debtAging` (today, the same engine as «חובות פתוחים» and its export) →
  **KPIs**: open debt (+ cycle count), over 60 days, patients with debt; **aging buckets**
  (עד 7 / 8–30 / 31–60 / 61+); **debt per house**; **debtors table** — balance, cycles
  (unrecorded ones flagged «ללא דיווח»), oldest cycle age (green ≤ 30, amber 31–60, red 61+),
  funder-grace chip, in-house / released. A row opens the patient drawer.
- `getPayments` → **receipts** (newest 25): date DD/MM/YYYY, name, house, amount, method,
  verification chip (דווח / אומת / סומן); KPIs «התקבל ב-30 יום» and «דיווחים לאימות».
- A refused or missing answer renders zeros with a Hebrew error line — never a blank page, so
  Ortal (controller: both actions are on `CONTROLLER_ACTIONS`) and Vered get the same area.

## What stays in the classic dashboard (links at the bottom)
Every ACTION: «דווח תשלום» (the R1–R12 strict report), overrides / discounts / credits / refunds,
payment linking (count of detached payments shown on the link), Ortal's verification queue.
Embedding the report form vs rebuilding it in the CRM is Sandra's call (open question, ROLLOUT).

## Pure core (`CrmCore.billingOverview`, node-tested)
`billingOverview(debtAnswer, paymentsAnswer, todayIso)` → `{ asOf, openDebt, openCycles, over60,
debtors, received30, received30Count, toVerify, detached, pendingCredits, funderGrace, buckets[],
patients[] (sorted by balance desc), houses[] (by total desc), receipts[] (newest first, ≤ 25),
errors[] }`. `fmtMoney` rounds to whole ₪ with thousands separators. House ids resolve through the
shared alias table (`hapardes` → רעננה הפרדס).

## Security
Read-only; the two reads are already on Vered's finance list and Ortal's controller list
(`lib/finance-scope.js`), so no scope change. Every interpolated field goes through `esc()`.
The guard test's GET allow-list now reads `billingControlQueue, debtAging, getActivity, getData,
getPayments`; the write allow-list is unchanged.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+1), `test/crm-shell-browser.test.js`
(+1 real-Chromium scenario: Vered + Ortal, fetched once, drawer from a debtor row, no write),
ESS, `docs/crm/ROLLOUT.md` (summary rows C4–C8). Rollback: flag off, or revert.
