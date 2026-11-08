# CRM «גבייה» → «לגבייה בתאריך» — 2026-11-02

## Why
Vered works her collections from the classic «גבייה» → «לגבייה בתאריך הנבחר» list (who starts a
cycle on a given date). The CRM «גבייה» area had only the debt overview, so she had to go back
to the classic screen.

## What the CRM area shows now (top of «גבייה»)
- **Date picker** (default today) + «היום» to jump back; **funder filter** (כל הגורמים המממנים,
  each funder, «לא הוגדר»); the top search box filters the list by name / house.
- **KPIs** for the filtered list: מטופלים לתשלום · סך לגבייה · נגבה בתאריך הנבחר.
- **Table**: patient (opens the card; «שוחרר/ה» chip when released), house, monthly amount,
  coverage period with the calendar-month split (e.g. אוקטובר 2026 · 5 ימים · 4,839 ₪ |
  נובמבר 2026 · 26 ימים · 25,161 ₪), status, paid, balance.
- **«דווח תשלום»** on every row with a balance: opens the patient's «חשבון» tab with the existing
  C10 report form already on THAT cycle (the existing Payments row when there is one, else the
  classic `pay::<key>::<date>` cycle). Not shown for Ortal (controller). Dana never sees «גבייה».

## Rules (the same as the classic list and the server engine)
- A cycle starts on entry + k months, month-end clamped (Code.gs `recCycleDueDates_`, CRM
  `stayCycles`).
- Never before entry; never on/after the exit date (CHANGELOG-billing-exit-day-not-due.md);
  released with no exit date → not listed.
- Pro-bono on the date → not listed.
- Amount = `lib/cycle-balance.js` `cycleState` (override → agreed price → stamp, discount net,
  settled stays settled) over the cycle's Payments row. A row stamped at an old price and paid in
  full at the corrected price reads «שולם» — no phantom balance.
- One difference from classic, by design: classic matches the entry day-of-month exactly, so an
  entry on the 31st never appears in a 30-day month; the CRM clamps to the month's last day like
  the server.

## Data
Existing reads only: `getData` (patients incl. released + `billingOverrides`) and `getPayments`
(cycles + funders), both already loaded by the area. No new action, no server change, Code.gs
untouched. `crm.html` now loads `/cycle-balance.js` (already served and in the SW bundle list).

## Security
Read-only rendering; every interpolated value through `esc()`; the report goes through the
existing `reportPayment` contract (server-validated, finance scope). No new route.

## Tests
`test/crm-collect-on-date.test.js` (10): anniversary matching, exit on the billing day, released
without exit, month-end clamp, override + discount, stamped-above-agreed fully paid, pro-bono and
funder labels, KPI + filters, void row / missing payments / bad date, month split, page wiring
(script order, placement, escaping, no report for Ortal). SW pins updated.

## Files
`public/crm/crm.js`, `public/crm/crm.html`, `public/sw.js` (**v110 → v111**),
`test/crm-collect-on-date.test.js`, `test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`docs/crm/ROLLOUT.md`, `EZONE-ECOSYSTEM-STATUS.md`.
