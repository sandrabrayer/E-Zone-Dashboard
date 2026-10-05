# Invoice on the payment report — «חשבונית?» כן / לא (no default) + «על שם»

Branch `claude/intelligent-gates-roo3yc-invoice` → base
`claude/build-ezone-dashboard-QOg5s` (built off the deploy branch, **not**
stacked on the pro-bono PR #183). The code merges cleanly with #183 in
either order; only `public/sw.js` (keep v38 and both comment blocks) and
`EZONE-ECOSYSTEM-STATUS.md` (keep both sections) need a trivial hand-merge.
The combined tree was tested: 2174 tests, all green. `apps-script/Code.gs` deploys through the clasp CI on merge —
do not paste it by hand. Service worker `CACHE_VERSION` **v34 → v38**: v35,
v36 and v37 are held by open PRs #181, #182 and #183. v38 evicts every older
cache.

> **Overlap note.** Open PR #182 (`claude/lucid-mendel-v6qsbf-invoice`)
> implements the same request from an earlier session. This PR was built
> independently from the current deploy branch. Sandra merges one of the two
> and closes the other.

## What Sandra decided (2026-10-05)

| | Decision |
|---|---|
| 1 | `Payments` gets two columns, **appended at the end** (append-only): `invoiceWanted` (`'yes'` \| `'no'`) and `invoiceTo` (free text, 1–120 characters, formula-guarded). |
| 2 | The report form asks **«חשבונית?»** with radios **כן / לא** and **no default**. The report cannot be sent until one is chosen, in the UI and on the server (`invoice_choice_missing`). With **כן**: an «על שם» field, prefilled with the payer's name, is required (`invoice_to_missing`). With **לא**: `invoiceTo` is stored as `''`. On a refusal, nothing is written. |
| 3 | Shown in: the payment row in גבייה, the payment detail view («בקרת גבייה» card), Ortal's daily email («חשבונית» / «על שם»), the accounting feed, and the export workbook. A row written before this change shows **«—»**, never כן or לא. |
| 4 | `updatePayment` may change both fields with the same validation, and the change is audited the same way as other payment edits. |

## What users see

**Vered (and Sandra):**

- **«דווח תשלום»** has a new question at the bottom, **«חשבונית? \***», with
  two radios (כן / לא). Neither is selected when the form opens.
  - Submitting without a choice shows «חסר: חשבונית? — יש לבחור כן או לא»
    under the question, and nothing is sent.
  - **כן** reveals **«על שם \***», prefilled with the payer's name until you
    type your own. Leaving it empty shows «חסר: על שם מי החשבונית». A name
    over 120 characters, or one starting with `= + - @`, shows «שם לחשבונית
    לא תקין — עד 120 תווים, לא מתחיל ב-= + - @».
  - **לא** hides «על שם», and an empty name is stored.
- **The receipts list under a גבייה row** adds «חשבונית: כן · על שם X»,
  «חשבונית: לא», or «חשבונית: —» for a receipt from before this change.

**Ortal:**

- **«בקרת גבייה» card**: two more fields, «חשבונית» and «על שם» («—» when
  unknown).
- **«ייצוא אימות» workbook**: «חשבונית» and «על שם» columns after «גורם
  מממן».
- **Daily email**: «חשבונית» and «על שם» columns after «אסמכתא», in both the
  HTML table and the plain-text part.

**The accounting app:** each cycle record in `accountingPayments` gains
`invoiceWanted` / `invoiceTo` (the row's own pair, `null` on a cycle) and
`invoices`: one entry per receipt of that cycle, oldest first, as
`{ receiptUid, receivedDate, amount, void, invoiceWanted, invoiceTo }`.
`invoiceWanted` is `'yes'`, `'no'` or `null` (from before the question, never
guessed), and `invoiceTo` is non-null only for `'yes'`. The changes are
additive, so `schemaVersion` stays 1. When a receipt's invoice is edited
later, its cycle comes back in the next incremental read: the cycle's sort
key is the newest `sourceUpdatedAt` across the cycle and its receipts.

**Shiran and Yael (restricted):** no change. `reportPayment`,
`updatePayment` and `getPayments` were already finance-only (refused by
server.js and Code.gs), and the form never opens for them.

### The cleanup workbook

«ייצוא רשימת תיקונים» was **not changed**. Every row in it is a patient, a
cycle or a lead, never a receipt, so no row can carry a receipt's invoice
choice. The receipt-level export is «ייצוא אימות», which now has both
columns. If Sandra wants an invoice tab in the cleanup workbook too, that is a
small follow-up.

## Code

| File | Change |
|---|---|
| `apps-script/Code.gs` | `PAYMENT_COLUMNS` + `invoiceWanted`, `invoiceTo` (last), both in `PAYMENT_TEXT_COLUMNS`. `PAYMENT_INVOICE_COLUMNS`, `INVOICE_CHOICES`, `INVOICE_TO_MAX`, four messages. Pure helpers: `paymentInvoiceToCode_`, `validatePaymentInvoice_`, `paymentInvoiceClean_`, `paymentInvoiceHeaderClash_`, `paymentInvoiceFields_`, plus `logPaymentInvoiceChanged_`. `reportPayment_` adds the invoice issues to the report's issues, refuses on a header clash, stores the pair on the receipt, and audits the choice. `upsertPayment_` (savePayment / updatePayment): a receipt now accepts an **invoice-only edit** besides the void (every other cell is kept from the sheet). Same rules, refused before any cell moves, one `payment_invoice_changed` AuditLog row (old, new, by). A blank `invoiceWanted` means "not sending", so an older client never wipes a choice. `billingControlReceipt_` adds the pair to its allow-list. `digestRow_` / `digestCompose_` add «חשבונית» / «על שם». `accountingPaymentView_` / `accountingPayments_` add `invoiceWanted`, `invoiceTo`, `invoices`. |
| `lib/payment-report-rules.js` | `validatePaymentInvoice`, `INVOICE_CHOICES`, `INVOICE_FIELDS`, `INVOICE_TO_MAX`, and the four messages (parity-tested). |
| `lib/billing-control-xlsx.js` | «חשבונית» / «על שם» columns («—» for unknown). |
| `public/app.js` | The radio pair and «על שם» in the form (payer prefill, hidden on לא). `paymentReportIssues` adds `validatePaymentInvoice`. `normalizeReceipt` carries the pair. `invoiceLabel` / `invoiceToLabel` («—» for anything but yes/no). The receipts list and the «בקרת גבייה» card show it. |
| `public/style.css` | Radio row with 44px tap targets; receipt invoice text. |
| `public/sw.js` | v38. |

## Security

- **Validated on the server**, not only in the form: `reportPayment_` and
  `upsertPayment_` refuse a missing choice, an unknown choice, a missing
  name, or a bad name, and write nothing.
- **Formula injection:** `invoiceTo` may not start with `= + - @`, and the
  column is text-forced. The xlsx helper still guards every text cell, and a
  test proves a hand-typed `=HYPERLINK(…)` lands as `'=HYPERLINK(…)`.
- **XSS:** every render goes through `escapeHtml` (page) or `digestEsc_`
  (mail). Tests feed `<img onerror>` and `<b>` and check that the output is
  escaped.
- **Who may set it:** finance sessions only. Restricted users are refused by
  the existing finance gate, and the test proves nothing is written. The
  audit actor comes from the signed session, never from the payload.
- A name under «לא» is dropped on write and never shown.
- No new action, route, env var, Script Property, scope or trigger. No PII
  is logged to the console.

## Tests

`node --test`: **2156 tests, all green** (2141 before; +15). New file
`test/payment-invoice.test.js` (15 tests):

- the column guard (order, append-only, text-forced; header clash refuses
  with no data row written);
- rules parity, case by case (19 inputs), and the message map;
- `reportPayment` refuses with no choice, with כן but no name, and with a bad
  name or an unknown choice, writing nothing; the stored values; the audit;
- `updatePayment`: an invoice-only edit on a receipt (validated, audited,
  every other cell untouched); a stale client never wipes; a legacy receipt
  can be given a choice; a cycle row follows the same rules;
- restricted: refused, nothing written;
- the email (columns, «—» for legacy, escaping, no name under לא);
- the feed (`invoices`, `null` for legacy, the cycle re-surfacing after an
  edit);
- the page (no default, rules, markup, payer prefill, 44px targets; the
  receipts list and the card with «—» and escaping; restricted never opens
  the form);
- the export workbook (columns, «—», formula guard);
- SW v38.

Fixtures updated for the new required choice or the appended columns:
`payment-report-form`, `payment-report-form-browser` (it now picks כן and
checks the payer prefill and the stored pair), `billing-control-tab`,
`billing-control-tab-browser`, `payment-report-foundation`,
`accounting-source-feed`, `payment-coverage-period`,
`orphan-payments-reconcile`, `ortal-daily-digest`.

**Mutation check:** three breaks, each caught and reverted:

1. `reportPayment_` without the invoice check → 1 test fails.
2. No `payment_invoice_changed` audit → 1 test fails.
3. A legacy row shown as «לא» → 1 test fails.

## Live test (Vered)

1. «דווח תשלום»: neither כן nor לא is selected; «שמירת הדיווח» without choosing shows «חסר: חשבונית? — יש לבחור כן או לא», and nothing is saved.
2. Choose כן: «על שם» appears with the payer's name. Clear it and save → «חסר: על שם מי החשבונית».
3. Save with כן and a name: the receipt under the row reads «חשבונית: כן · על שם …».
4. Report another payment with לא: the receipt reads «חשבונית: לא». An older receipt reads «חשבונית: —».
5. Tomorrow's email from Ortal has «חשבונית» / «על שם» columns, and «ייצוא אימות» has the same two columns.
