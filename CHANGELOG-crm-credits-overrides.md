# C11 — credits, discount and amount change inside the CRM — 2026-10-28

CRM restructure, Session C (eighth PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no SW bump. Classic contracts reused unchanged.

## What
- **«חשבון» tab**: every open cycle now also has «הנחה» (`me.canDiscount`) and «שנה סכום»
  (`me.canAmount`); a new «זיכויים» table lists the patient's credits (type, month, amount,
  status / paid date) with «סמן כשולם» on pending ones (finance).
- **«גבייה» area**: a «זיכויים לתשלום» block (pending credits with money, oldest payout first,
  total) — «סמן כשולם» opens the patient's drawer on «חשבון» with the settle form.
- Reads: `getCredits` joins the shared billing load (one fetch per page, with `debtAging` +
  `getPayments`). Writes, exactly as the classic app sends them:
  - `setBillingDiscount { discount: { patientId: <legacy key>, month, discountAmount, discountReason } }`
  - `upsertBillingOverride { override: { id: 'ovr::<key>::<month>', patientId: <key>, month, amount, created } }`
    (saved only when the answer echoes `override.id`)
  - `settleRefund { creditId, paidDate, method }`
- Client-side checks mirror the server's (month `YYYY-MM`, money 0–1,000,000 with ≤ 2 decimals,
  reason 2–120 chars, paid date not in the future, method 1–40); a server refusal shows its Hebrew
  `message` (or a mapped reason) and keeps the form open. A save re-reads all three answers;
  nothing is applied optimistically.
- Closing a drawer (or opening another one) clears the account / form state, so a form can never
  render into a hidden drawer.

## Still classic (links)
Receipt edit / void, manual credit creation (`saveCredit`), payment linking, override delete.

## Security
Server gates unchanged (finance / DISCOUNT_ACTIONS / AMOUNT_ACTIONS); the buttons follow
`/api/me` flags for display only. Every field through `esc()`. Guard test: write allow-list +
`setBillingDiscount`, `settleRefund`, `upsertBillingOverride`; GET allow-list + `getCredits`.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+1), `test/crm-shell-browser.test.js`
(+1 Chromium scenario), ESS, `docs/crm/ROLLOUT.md`. Rollback: flag off, or revert.
