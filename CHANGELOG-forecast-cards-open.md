# CHANGELOG — the «צפי תזרים» cards open their lists; shortcut to the debt cleanup

Date: 2026-11-11 · Branch `claude/forecast-cards-open` → base `claude/build-ezone-dashboard-QOg5s`
(stacked on `claude/today-active-patients`, PR #378).
Sandra: «הקוביות לא נפתחות» · «איך מסדרים או מוחקים מטופלים עם חוב פתוח שנסגר?»

## 1. Every forecast card opens the list behind its number
- «סה"כ צפוי», «פרטיים», «מוסדיים — שוטף +30», «ללא גורם מממן», «זיכויים לתשלום», «נטו צפוי»
  are now buttons («פתיחת הרשימה ←»). A click shows the list **right under the cards**, with
  a total row; a second click (or «סגירה ✕») closes it.
  - receipts cards → the expected receipts of that kind (a row opens the patient's «חשבון»);
  - «זיכויים לתשלום» → the refunds; «נטו צפוי» → both tables.
- Each list holds exactly what its number counts («סה"כ צפוי» leaves «ללא גורם מממן» out).
- The collapsed lists at the bottom of the block stay as they were. Works for Ortal too.

## 2. From «רשימת חייבים לגבייה» to «ניקוי חובות היסטוריים»
- For Vered / Sandra, when released debtors are listed: a line under the list header with a
  button **«ניקוי חובות היסטוריים ↓»** that opens the existing tool
  (`CHANGELOG-historical-debt-cleanup.md`) and scrolls to it. Not shown to Ortal (the tool is
  finance-only and stays so).

## Data / security
- Read-only UI; no new request, no new action, no Code.gs / Railway change. The cleanup tool's
  own rules (finance + `canDiscount`, reason required, audited `setBillingDiscount`) are untouched.
- Every rendered value through `esc()`. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `forecastOpenList` (pure), `renderForecastOpen`, the cards as buttons
  (`data-fc-open`, `state.fcOpen`), `data-cleanup-jump`.
- `public/sw.js`: v127 → **v128**.
- Tests: `test/forecast-cards-open.test.js` (new, 4); `test/crm-shell-browser.test.js`
  (Chromium: open / switch / close, no request), SW guards.
