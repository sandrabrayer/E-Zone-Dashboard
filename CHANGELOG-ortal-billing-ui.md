# Ortal billing — «בעיות גבייה» view, «הנחה» chip, Sandra's voids + discounts (PR 2)

October 22, 2026. Stacked on PR 1 (`CHANGELOG-ortal-billing-discounts.md`),
which adds the server rules this screen calls.

## What Ortal sees («בקרת גבייה»)

A new section at the top of the tab, **«בעיות גבייה»**, shown only to a session
that may act (`/api/me canAccount`: Ortal with `accountant`, Sandra). One
card per patient with a missing or unconfirmed payment, the oldest problem
first:

- each **unconfirmed receipt** (waiting, or marked «לא שולם»):
  - **«שולם - אשר»** — `confirmPayment` status `confirmed` (unchanged rule);
  - **«לא שולם - בטל תביעה»** — opens a reason box (2–120 characters,
    required, checked in the browser and again on the server) →
    `confirmPayment` status `not_received`. The receipt is soft-voided (kept
    in the history; only Sandra can restore it) and the cycle is owed again.
- each **owed cycle** (from debt aging — recorded balances and cycles with no
  payment row):
  - **«הנחה»** — amount (0 < x ≤ 1,000,000, a thousands comma is fine) +
    reason (2–120) → `setBillingDiscount` on that cycle's key. The answer must
    name the cycle (else «השמירה לא אושרה»); the tab then reloads.
- **«הנחות שניתנו»** (collapsed): every discount with month, reason, who, when.

## «הנחה» chip

- A discounted cycle shows **«הנחה» ₪X · לתשלום ₪Y** in «בעיות גבייה», and
  **«הנחה» ₪X** next to the amount on the «גבייה» row (the amount shown is
  already net of the discount).
- A cycle the discount covers fully is never listed as debt (balance 0).

## Sandra's «חריגים פתוחים» (read-only)

Two new lists, no buttons:
- **«ביטולים»** — every void row (kept on the sheet): patient, house, amount,
  kind («כפילות» / «לא שולם — תביעה בוטלה»), reason, who, when.
- **«הנחות»** — every discount: patient, house, month, amount, reason, who,
  when.

## Server (Code.gs)

`billingControlQueue` gains `problems: { complete, cycles, discounts }` only
for an accountant / approver session (the cycles carry `patientKey` + `month`,
the discount key), and `exceptions.voids` / `exceptions.discounts` for Sandra.
Read-only; no new action. The follow-up queue still carries no patient key.

## Security

Every value reaching HTML goes through `escapeHtml` (names, reasons, keys in
attributes). Buttons are hidden without the permission, and the server refuses
the action anyway (PR 1). No secret, no PII in logs.

## Service worker

`CACHE_VERSION` v83 → **v84** (live `/sw.js` read v83 on 22/10/2026; v17 is
burned and never reused). `test/dashboard-perf-assets.test.js` updated.

## Tests

`test/ortal-billing-ui.test.js` (8): the queue's `problems` only for
accountant / approver, the discount reflected and a full discount removing
the cycle; Sandra's voids + discounts; the reason / discount checks; the
model; the HTML (buttons by permission, chip, escaping, forms); Sandra's
list read-only and escaped; the request bodies + the R3 proof; the page
wiring and SW v84. `test/lock-busy-frontend.test.js` covers the new
`setBillingDiscount` write path.

## Manual steps

None beyond PR 1's (add `"accountant"` to Ortal's `USER_PIN_HASHES` roles).
