# CHANGELOG — «היסטוריה חודשית» in the CRM: a month's occupancy and revenue

Date: 2026-11-11 · Branch `claude/crm-month-view` → base `claude/build-ezone-dashboard-QOg5s`
(stacked on `claude/revenue-engine-shared`, PR #380).
Sandra: «איך אני יכולה לראות איזו תפוסה היתה בחודש אחר ומה היו ההכנסות באותו חודש?» ·
«זה צריך להיות בגרסה החדשה וגם תוסיף תפוסה היסטורית.»

## What Sandra / Vered see
New area in the side menu, under «דוחות והגדרות»: **«היסטוריה חודשית»**.
- A month picker with «‹ חודש קודם» / «חודש הבא ›». Opens on the previous month; a future
  month cannot be picked; the running month is counted up to today and marked «עד <date>».
- **תפוסה** cards: average occupancy %, average patients a day, patient-days, entries, exits.
- **הכנסות** cards (ex-VAT, by the month the revenue belongs to): «נגבה בפועל», «מאומת»,
  «צפוי», «זיכויים», «נטו» — the same figures as the classic «הכנסות חודשיות» tab.
- **Per house**, side by side: average patients, capacity, occupancy %, peak, entries, exits,
  and that house's נגבה / צפוי / זיכויים / נטו, with a total row.
- **תפוסה היסטורית — 12 חודשים**: per month the network occupancy %, each house's %, and
  נגבה / נטו. A row opens that month.

Dana sees the same screen with occupancy only — no money cards, no money columns, and no
money read. Ortal does not have the area.

## The occupancy rule (new here; stated on the screen)
- A patient is in a house on every day of [entry, exit], both inclusive; no exit → still there.
  This is the managers app's patient-day rule (Code.gs `computeMonthStats_`).
- The same person is counted once a day per house.
- Average = patient-days ÷ days counted; occupancy % = average ÷ capacity.
- **Capacity is today's** (the app keeps no capacity history). A house joins the network
  capacity from the month its first patient arrived; a closed house is listed with its
  patients, no %, and is not in the network %.
- Computed live from the patients list, so editing an old entry / exit date changes that
  month. The `OccupancySnapshots` sheet is not read.

## Revenue
- No figure is computed in `crm.js`: `monthRevenue` calls `RevenueEngine.monthModel`
  (`public/revenue-engine.js`, generated from `app.js` — `CHANGELOG-revenue-engine-shared.md`)
  on the raw `getData` / `getPayments` / `getCredits` answers the CRM already holds.
- Months before the app's complete payment records (01/07/2026) are flagged as partial.
- A failed read → «הכנסות החודש לא נטענו» + «נסי שוב», never a zero.

## Data / security
- Read-only. No new action or API route; the money reads are the existing finance-gated
  ones (`getPayments`, `getCredits` → 403 for Dana on the server) and are requested only for
  a finance session.
- One new static file route, `/revenue-engine.js` — code only, no data (like `/funder.js`).
- Every rendered value through `esc()`. No Code.gs / Railway change. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `monthOccupancy`, `occupancyTrend`, `monthRevenue`, `monthShift`,
  `monthLabelHe` (pure); `renderMonthly`; area `monthly`, nav, handlers.
- `public/crm/crm.html`: loads `billing-control-rules.js` + `revenue-engine.js` before `crm.js`.
- `public/crm/crm.css`: total row, picked row.
- `server.js`: `/revenue-engine.js` in `ASSETS` + its route. `public/sw.js`: bundle path, v128 → **v129**.
- Tests: `test/crm-month-view.test.js` (new, 9); `test/crm-shell-browser.test.js` (Chromium:
  Vered at 1366 / 390 px, Dana, Ortal); area pins; SW guards.
