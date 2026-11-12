# CHANGELOG — the calculator on every money table + «חובות של תקופה»

Date: 2026-11-12 · Branch `claude/calc-everywhere` → base `claude/build-ezone-dashboard-QOg5s`
Sandra (on «תקבולים אחרונים»): «אני רוצה אופציה גם פה לחשב סה"כ, צריך בהכל שזה יהיה אפשרי.
אני גם רוצה אופציה לראות חובות לפי תקופה בין לבין, לא רק היסטורית חודש שלם.»
Replaces the debtors-only calculator of `CHANGELOG-debtors-select-sum.md` (PR #382).

## 1. The calculator, everywhere
- Every money table now has a tick box per row and one in the header (all / none):
  «לגבייה בתאריך», the «צפי תזרים» lists (receipts and refunds), «רשימת חייבים לגבייה»,
  «חובות פתוחים לפי מטופל/ת», **«תקבולים אחרונים»**, «זיכויים לתשלום», «שיוך תשלומים», the
  search results (debts, receipts) and the four tables of a patient's «חשבון».
- **One bar at the bottom of the screen** (Σ): «נבחרו N מתוך M · <table> · סה"כ ₪X». Ticks in
  several tables show a line per table and a grand total. «ניקוי בחירה» clears everything.
- Ticked rows are highlighted; ticking never opens the row and never moves the list; the
  ticks survive a re-render while the page is open.
- The debtors bar that sat above «רשימת חייבים לגבייה» is gone — that list uses the same
  bottom bar now.

### Rules
- The amount is the row's cell under the table's amount header, **as displayed** — the sum is
  of the figures on the screen (whole shekels); nothing is recomputed. A row with no amount
  («—») and a total row get no tick box.
- «תקבולים אחרונים» still lists the latest 25 receipts — the calculator sums what is listed.
- «ניקוי חובות היסטוריים» keeps its own ticks (they choose what to close).
- Page-only: nothing is saved or sent; a refresh clears the ticks.

## 2. «חובות של תקופה» in «רשימת חייבים לגבייה»
- Two date fields — «יום חיוב מתאריך» / «עד תאריך» — plus «החודש», «החודש הקודם» and
  «כל התקופות ✕». Either date may be left empty.
- With a period, the list keeps only the open cycles whose **billing day** (the start of the
  cycle) is inside it, both ends included, and each patient's debt, cycles and days overdue
  are re-summed from those cycles. The header chip, the total and the calculator follow.
- The screen says the list is narrowed. No period → exactly the list as before.
- Same cycles and balances as the `debtAging` answer — filtered, not recomputed
  (`collectionDebtors(…, range)` → `billingOverview`). Months partition the total (test).

## Data / security
- UI only: no request, no action, no server / Code.gs / Railway change.
- Tick cells are built with DOM nodes (no HTML concatenation); the period dates are validated
  (`isoDateOk`) and escaped. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `CALC_TABLES`, `moneyFromText`, `calcSummary`, `calcBarText`,
  `debtRange` (pure); `decorateCalc` / `paintCalc` (a MutationObserver decorates every
  listed table as it appears); the period controls + handlers; the debtors-only code removed.
- `public/crm/crm.css`: tick cells, picked rows, the bottom bar.
- `public/sw.js`: v130 → **v131**.
- Tests: `test/table-calculator.test.js` (new, 10; replaces `test/debtors-select-sum.test.js`);
  `test/crm-shell-browser.test.js` (Chromium at 1366 / 390 px); `test/billing-debtors-list.test.js`.
