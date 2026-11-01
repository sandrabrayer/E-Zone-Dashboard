# CHANGELOG — «דווח תשלום» on an old cycle saves again (CRM billing dates read on the Israel day)

Date: 2026-11-01 · Branch `claude/modest-carson-63mh4e` → base `claude/build-ezone-dashboard-QOg5s`
Reported by Vered (via Sandra): on the new screen, reporting a payment on an OLD cycle "just does not save".
Bug fix, client only (`public/crm/crm.js`), SW v105 → v106. Nothing to set.

## Cause

Older rows of the Payments sheet hold real **Date** cells (written before the coverage / due columns
were text-formatted). `getPayments` hands a Date cell to the browser as a **UTC timestamp**: Israel's
1 April arrives as `"2026-03-31T21:00:00.000Z"`. The CRM read every billing date with
`.slice(0, 10)` → `2026-03-31`, **one day early**.

For «דווח תשלום» on such a cycle the form pre-filled «תחילת תקופת הכיסוי» with that day — one day
**before** the cycle — and `Code.gs reportPayment_` (correct: it reads the cell by its local Israel
day) refused the report with `coverage_outside_cycle`. New rows are stored as text and were never
affected, which is why only *old* payments failed. The classic dashboard already guards against this
in `app.js isoDate()`; the CRM did not.

## Fix

- New pure helper `sheetDay(v)` in `crm.js` — the same rule as `app.js isoDate()`: a bare
  `YYYY-MM-DD` is kept as is; a full timestamp (or a Date) is read as its **calendar day in
  Asia/Jerusalem**; anything else → `''`.
- Used for every billing date the CRM reads from a sheet: cycle `dueDate` / `coverageStart` /
  `coverageEnd` (`patientAccount`), receipt `receivedDate` / `dueDate` / coverage (`receiptsOf`, the
  verification rows of Vered's / Ortal's day), funder `effectiveFrom`, credit `allocationMonth` /
  `decidedDate` / `payoutDate` / `paidDate` (`creditsOf`), detached-payment `dueDate`, debtAging
  window `start` / `end`.
- No server change: `Code.gs` already reads Date cells by their local day; no sheet, header or
  stored value is touched (append-only contract kept).

## Tests

`test/crm-old-payment-dates.test.js` (4):
- `sheetDay` — bare day, summer (UTC+3) and winter (UTC+2) timestamps, a Date, junk;
- the CRM readers on Date-typed cells land on the right day;
- **end to end with the real `Code.gs`**: a legacy cycle with Date cells → `getPayments` →
  `patientAccount` → the form's cycle + defaults → `reportPayment` as Vered → **saved**, the receipt
  pays the old cycle (no new cycle minted);
- the bug pinned: the old `.slice(0, 10)` value is refused with `coverage_outside_cycle`.
All 4 fail on the pre-fix `crm.js`. SW guards (`crm-pwa`, `dashboard-perf-assets`) moved to v106.

Full suite: 3641 / 3642 — the one failure (`chitukim-fixes-browser`, export-button spinner) fails
identically on the untouched base and is unrelated. `npm audit`: 0 high / critical.

## Security

No new input path; the helper only normalises dates already returned to an authorised session.
No secrets, no logging, permissions unchanged (server and Code.gs remain the authority).
