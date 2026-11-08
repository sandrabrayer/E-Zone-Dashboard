# CHANGELOG — «צפי תזרים»: the cash-flow forecast (CRM «גבייה»)

## Why
Sandra wants a cash-flow view: how much money the patients now in the houses
will bring in by the end of the month (or any range) — without the old
debts, most of which are payments that were never recorded (08/11/2026).

## What Sandra / Vered see
In «גבייה», right under «לגבייה בתאריך», a new section **«צפי תזרים —
מטופלים פעילים»**:
- **Range:** from / to dates (default today → end of this month) and three
  buttons: «עד סוף החודש», «החודש הבא», «90 יום». A range never starts
  before today.
- **KPIs:** «סה"כ צפוי» · «פרטיים · ביום החיוב» · «מוסדיים — שוטף +30» ·
  «ללא גורם מממן» (shown only when there are any, and NOT in the total).
- **By week** (weeks start on Sunday) and **by house** tables — private and
  «שוטף +30» columns, each adding up to the total.
- **«פירוט לפי מטופל/ת»** (collapsed): patient, house, funder, cycle, billing
  day, expected receipt date, amount. A row opens the patient on «חשבון».

## The rules
- **Who:** patients in a house only. Released patients are never forecast.
  Pro-bono is never forecast.
- **Which cycles:** the entry-anchored monthly cycles — the exact rule of
  «לגבייה בתאריך» (the per-cycle computation is now one shared function,
  `cycleOnDay`, used by both). No cycle on or after a known exit date.
- **How much:** the cycle's OPEN balance (`cycleState`: month override →
  agreed price, minus a discount, minus money already paid). A prepaid
  advance or a fully discounted cycle brings nothing.
- **When:**
  - private (and unset): on the billing day; only cycles due today or later —
    an older unpaid cycle is past debt and is not forecast;
  - **ביטוח לאומי / מכבי / משרד הביטחון** — the funder on the billing day —
    «שוטף +30»: expected 30 days after the billing day. A cycle billed last
    month whose expected date is still ahead IS counted (it is within terms,
    not debt); one whose expected date has passed is not.
- `FORECAST_TERMS_DAYS` = `FUNDER_GRACE_DAYS` (lib/funder-grace.js) and the
  institutional list = the grace funders — pinned by a test, so the debt
  grace and the forecast cannot drift apart.

## Not in this view (on purpose)
New admissions that have not happened yet, and expected discharges that are
not yet recorded as an exit date.

## Data / security
Read-only. No new request: computed in the browser from the `getData` and
`getPayments` answers the area already loads. No server, Code.gs or Railway
change. Every rendered value through `esc()`.

## Files
`public/crm/crm.js` (`cycleCtx`, `cycleOnDay` — extracted from `dueOnDate`,
behaviour unchanged — `cashForecast`, `forecastPreset`, `monthEndIso`,
`renderCashForecast`, handlers), `public/sw.js`,
`test/cashflow-forecast.test.js` (new, 18), `test/crm-collect-on-date.test.js`
(wiring pin), `test/crm-shell-browser.test.js` (+1 Chromium scenario at 1366
and 390 px; C8 KPI selector excludes the forecast block),
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`.
