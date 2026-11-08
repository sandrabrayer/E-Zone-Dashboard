# CHANGELOG — «שולם עם הנחה» in the payment report form (CRM)

## Why
Vered reports a payment that is lower than the cycle because the family got a
discount. Until now this took two separate actions — «דווח תשלום», then
«הנחה» on the same cycle — and if the second was forgotten, the gap stayed as
an open debt that is not real (Sandra, 08/11/2026).

## What Vered sees
- In the patient card → «חשבון» → «דווח תשלום» on an **open cycle** (and from
  «לגבייה בתאריך»), a new checkbox: **«שולם עם הנחה — ההפרש בין היתרה לסכום
  שהתקבל יירשם כהנחה»**.
- Checking it opens a required **«סיבת ההנחה»** (2–120 characters) and a live
  line: «יירשם: תשלום ₪35,000 + הנחה ₪6,300 = ₪41,300 · המחזור ייסגר».
- One «שמירת הדיווח» saves both. The cycle closes; the receipt goes to Ortal's
  verification as always. The discount is not revenue and not debt.

## How it is written (no new server action, no Code.gs change)
1. Everything is validated in the browser first (the strict report rules + the
   discount plan). Nothing is sent if either fails.
2. `reportPayment` — exactly the existing strict report. The checkbox and the
   reason are stripped from it (`reportValuesOnly`).
3. Only when the payment is accepted: `setBillingDiscount` for the cycle's
   month, with the month's **total** = existing discount + the new gap (the
   action replaces the month's value). Payment first on purpose: a discount
   without its payment would hide money that never arrived.
4. If the discount is refused, the payment stays saved and the toast says so:
   «התשלום נשמר. ההנחה לא נשמרה — לחצי «הנחה» במחזור».

## Where it is offered
- Only to a user with `canDiscount` (Vered, Sandra — the server's
  `DISCOUNT_ACTIONS` gate is unchanged and stays the authority).
- Only on an OPEN cycle (the debt list / «לגבייה בתאריך»), whose balance is
  already net of the month's discount (`cycleState`). Not on «מחזור אחר» or a
  stamped «תשלומים» row, whose balance is not net of a discount.
- The amount received must be > 0 and lower than the open balance.

## Security
Server gates unchanged (reportPayment validation in Code.gs, finance-only
discount). Client checks mirror the server's (money ≤ 2 decimals, reason
2–120). Every rendered value through `esc()`. No new route, secret or log.

## Files
`public/crm/crm.js` (`paidWithDiscountPlan`, `paidWithDiscountBody`,
`reportValuesOnly`, form + submit chain + preview), `public/crm/crm.css`,
`public/sw.js` (**v120 → v121**, from the live v120),
`test/paid-with-discount.test.js` (new, 10), `test/crm-shell-browser.test.js`
(+2 Chromium scenarios), `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`. No Apps Script change → no clasp deploy.
