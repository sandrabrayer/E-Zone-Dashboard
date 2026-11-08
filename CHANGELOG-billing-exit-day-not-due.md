# גבייה: leaving on the billing day opens no new cycle — 2026-11-02

## Bug
Reported on טמיר בן מיור (עפרוני): entered 27/07/2026, discharged with exit date 27/10/2026.
The classic «גבייה» → «לגבייה בתאריך הנבחר» for 27/10/2026 still listed him for a new cycle
27/10–26/11 (30,000 ₪, «לא שולם»).

## Root cause
`patientDueOnDate` (public/app.js) decided "due" as: anchor day matches AND the stay covers the
date, with the exit day inclusive (`exit >= date`). A patient leaving ON their billing day
therefore opened a whole new cycle on the day they left.

Every other engine already draws the line at the exit day:
- Code.gs `recCycleDueDates_` and `debtAging_` — no cycle on/after exit;
- app.js `projectedCycleDueDates` (monthly revenue) — same bound.
So only the daily due list (and its KPI cards) disagreed.

## Fix
`patientDueOnDate` now also returns false when the exit date is on or before the date asked.
`patientStayCoversDate` is unchanged: the exit day is still a stay day (occupancy, revenue days).

| Exit vs. billing day | Before | After |
| --- | --- | --- |
| exit = billing day (Tamir) | due | **not due** |
| exit = billing day + 1 | due | due (a day of the cycle was used; refund rules apply) |
| exit before billing day | not due | not due |
| active, no exit | due | due |

## Not changed
- Refund / credit logic, debt aging, Code.gs — untouched.
- The CRM already uses the server debt engine, which was correct.

## Tests
`test/billing-exit-day-not-due.test.js` (8): the reported case, cycles inside the stay, exit ±1 day,
a UTC-timestamp exit, an active patient with a future exit, parity with `projectedCycleDueDates`
and the Code.gs bound. SW pins updated.

## Security
Client-side pure logic only; no new route, no data written, no PII in logs.

## Files
`public/app.js`, `public/sw.js` (**v109 → v110**), `test/billing-exit-day-not-due.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.
