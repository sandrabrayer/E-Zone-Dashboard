# A debt closes when the payment is VERIFIED, not when it is reported

Sandra, 15/11/2026: «מה שלא אומת… כשלוחצים… מאמת ומוחק למעשה את החוב». Follow-up to
`CHANGELOG-billing-verify-fixes.md`. CRM only — **no Code.gs change, no new action.**

## What changed (CRM «גבייה»)

A payment Vered reports is a claim; the money is real once Ortal verifies it.

- **«חובות פתוחים»:** the reported-and-unverified amount stays in the patient's
  debt, marked «ממתין לאימות» (or «מתוכו ₪X ממתין לאימות» next to real open
  cycles). A patient who reported everything is still listed until verified.
  The section says how much of the total is waiting. Period, funder, house and
  search filters apply to it like to any debt.
- **«סקירה»:** «חוב פתוח» includes it and says «מתוכו ₪X דווח וממתין לאימות».
  The menu badge and the search results agree with the list.
- **Patient «חשבון»:** «חוב פתוח» includes it, with the same mark.
- **«אמת»** (Ortal / Sandra) removes it at once — toast «אומת ✓ — התשלום אושר
  והחוב נסגר». Vered's save toast now says «החוב ייסגר לאחר אימות».

Rule: reported / flagged → the whole amount waits; partial → the reported amount
minus what Ortal confirmed; confirmed / void → nothing.

## What did NOT change — read this

The billing engine in Apps Script still nets every live receipt. So these keep
treating a reported payment as paid, as before:
- the classic dashboard, the .xlsx exports, «לגבייה בתאריך», «צפי תזרים»,
  the debt-aging buckets on «סקירה», «ניקוי חובות היסטוריים»;
- any other app or report that reads debt from the engine — so a family that
  paid is not treated as a debtor elsewhere while Ortal has not verified yet.

Moving the engine itself is a separate, larger change (Code.gs + every reader).

## Security

Pure browser computation from answers the session already reads (`debtAging`,
`getPayments`); no new request, permission, or stored data. Values escaped.
`npm audit`: 0 high / critical.

## Files

- `public/crm/crm.js` — `unverifiedReceipts`, `unverifiedTotal`,
  `collectionDebtors` (+ the waiting money), `patientAccount`, `billingFind`,
  the three renders, two toasts
- `public/sw.js` — cache `v136 → v137` (from the live v136)
- Tests: `test/debt-until-verified.test.js` (new, 5), one new browser scenario
  and updated amounts in `test/crm-shell-browser.test.js`, `test/crm-pwa.test.js`,
  `test/dashboard-perf-assets.test.js`
- Docs: `EZONE-ECOSYSTEM-STATUS.md`
