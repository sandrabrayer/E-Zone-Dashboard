# CHANGELOG — «רשימת חייבים לגבייה» right under «צפי תזרים»

Date: 2026-11-11 · Branch `claude/billing-debtors-list` → base `claude/build-ezone-dashboard-QOg5s`
(stacked on `claude/cashflow-refunds`, PR #376, itself on PR #375).
Sandra: «וצריך שתפתח רשימת חייבים לגבייה בדיוק שם.»

## What Sandra / Vered / Ortal see (CRM «גבייה» → «צפי תזרים»)
- Directly under the forecast cards, **open by default**: **«רשימת חייבים לגבייה»** with a
  chip «N חייבים · ₪X». The forecast leaves past debt out on purpose — this is that debt.
- Columns: מטופל/ת · בית · גורם מממן · סכום חוב · מחזורים · ימים בפיגור · תשלום אחרון · סטטוס.
  Patients in a house and released ones; oldest debt first.
- A row opens the patient's «חשבון» tab (where «דווח תשלום» is, for Vered / Sandra).
- The «לגבייה בתאריך» funder filter narrows this list too (a chip says so).
- Closing the list stays closed while the page re-renders.
- «חובות פתוחים לפי מטופל/ת» further down (with the aging filters) is unchanged.

## The rules
- **No second debt computation:** `collectionDebtors` is built on `billingOverview` — the same
  `debtAging` answer and the same per-patient balances as «חובות פתוחים לפי מטופל/ת». A test
  pins total = the sum of those figures.
- Funder = the one in force today (`funderOnDay`, by patient id or stay key); none → «לא הוגדר».
- Last payment = the latest real receipt of that patient (void ignored).
- Debt not loaded → «חובות לא נטענו» + «נסי שוב», never «אין חובות».

## Data / security
- Read-only; **no new request** — computed from the `debtAging` + `getPayments` answers the
  area already loads. No server, Code.gs or Railway change; Dana still has no «גבייה».
- Every rendered value through `esc()`. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `collectionDebtors` (pure), `renderCollectionDebtors`, the `toggle`
  handler (`state.fcDebtorsClosed`).
- `public/sw.js`: v125 → **v126**.
- Tests: `test/billing-debtors-list.test.js` (new, 7); `test/crm-shell-browser.test.js`
  (Chromium at 1366 / 390 px: open by default, position, row → «חשבון», stays closed), SW guards.
