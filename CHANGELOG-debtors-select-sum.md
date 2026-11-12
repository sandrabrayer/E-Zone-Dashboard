# CHANGELOG — the debtors calculator: tick debtors, see their sum

Date: 2026-11-12 · Branch `claude/debtors-select-sum` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «אני רוצה אופציה לבחור חייבים ולסכם אותם» · «מחשבון כזה».

## What Sandra / Vered / Ortal see (CRM «גבייה» → «רשימת חייבים לגבייה»)
- A tick box at the start of every debtor row, and one in the header that ticks / clears all.
- A bar above the table: **«נבחרו N מתוך M · סה"כ ₪X (P% מהחוב ברשימה)»**. It stays at the
  top of the screen while the list scrolls. «ניקוי בחירה» clears the ticks.
- Ticked rows are highlighted. Ticking does not open the patient and does not move the list.
- The ticks survive a re-render (a payment report, the funder filter); with the funder
  filter on, only ticked debtors that are in the list now are summed.

## Rules
- The sum is the ticked rows' «סכום חוב» — the same per-patient figures the list shows
  (`collectionDebtors` → `billingOverview`); no debt is computed here.
- The selection lives in the page only: nothing is saved, nothing is sent, a refresh clears it.

## Data / security
- UI only: no request, no action, no server / Code.gs / Railway change.
- Row labels through `esc()`. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `debtorPickKey`, `debtorsPicked`, `debtorsPickedText` (pure);
  the tick cells + bar in `renderCollectionDebtors`; `paintDebtorCalc`; change / clear handlers.
- `public/crm/crm.css`: the bar, tick cells, picked rows.
- `public/sw.js`: v129 → **v130**.
- Tests: `test/debtors-select-sum.test.js` (new, 4); `test/crm-shell-browser.test.js`
  (Chromium at 1366 / 390 px: tick → sum in place, no drawer, no re-render, no request), SW guards.
