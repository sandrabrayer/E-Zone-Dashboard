# CHANGELOG — «צפי תזרים» takes the refunds to pay into account

Date: 2026-11-11 · Branch `claude/cashflow-refunds` → base `claude/build-ezone-dashboard-QOg5s`
(stacked on `claude/ortal-crm-default`, PR #375).
Sandra: «התזרים צריך גם לקחת בחשבון זיכויים שיש לשלם.»

## What Sandra / Vered / Ortal see (CRM «גבייה» → «צפי תזרים»)
- Two new cards next to the existing three: **«זיכויים לתשלום (N)»** (shown as a minus,
  with «K באיחור» when some are past their payout date) and **«נטו צפוי · אחרי זיכויים»**
  = expected receipts − refunds, for the chosen range.
- The **weekly table** gains «זיכויים» and «נטו». A week with refunds only still gets a row.
- **«זיכויים לתשלום בטווח»** (collapsed): patient, house, type, payout date, expected payment
  date, amount; «מחושב — טרם הוחלט» marks a refund the policy computed for a discharge nobody
  decided yet.
- The existing cards («סה"כ צפוי», «פרטיים», «מוסדיים») are unchanged.

## The rules
- **Which refunds:** exactly the classic «זיכויים לתשלום» list — the server's
  `refundPayoutForecast` answer (`toPay.rows`): every saved pending credit with money, plus
  the policy's computed lines for discharges with no decision. No amount is computed in the
  browser.
- **When:** on the refund's `payoutDate` (the existing rule: decided by the 10th → the 15th
  of that month, later → the 15th of the next). A payout date that already passed, or a
  missing one, is money still owed → **today**.
- Only refunds expected inside the range count; a range that starts after today does not
  carry the overdue ones.
- **Never a silent zero:** if the refunds read fails, the saved pending credits (`getCredits`)
  are used and the screen says the computed ones are missing; if both fail the card shows «—»,
  a red line says the forecast is shown without refunds, and «נסי שוב» re-reads.

## Data / security
- Read-only. One more READ when «גבייה» opens: `refundPayoutForecast` — an existing action,
  already finance-gated (`FINANCE_ACTIONS`; Dana → 403) and on Ortal's `CONTROLLER_ACTIONS`
  (she gets it cut to `CONTROLLER_FORECAST_SCHEMA`: no discharge note, no override reason).
- No new route, no new action, no Code.gs change (no Apps Script deploy), no Railway change.
- Every rendered value through `esc()`. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `forecastRefunds`, `cashForecastNet`, `fmtSigned` (pure);
  `loadBilling` reads `refundPayoutForecast` fail-soft (`state.billing.refunds`);
  `renderCashForecast` (cards, weekly columns, the list, the notes).
- `public/sw.js`: v124 → **v125**.
- Tests: `test/cashflow-refunds.test.js` (new, 10); `test/crm-shell-browser.test.js`
  (Chromium: the cards, the weekly columns, the list, one read), `test/crm-shell-ui.test.js`
  (GET-read pin), `test/crm-dana-default-switch-user.test.js` (Dana 403 on the new read),
  SW guards.
