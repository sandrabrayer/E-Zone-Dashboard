# Invoice on the payment report (חשבונית? / על שם)

Branch `claude/lucid-mendel-v6qsbf-invoice` → base
`claude/build-ezone-dashboard-QOg5s`. Builds on
`CHANGELOG-payment-report-form.md` (#176) and `CHANGELOG-billing-control-tab.md`
(#179). This change touches both Apps Script and Railway. The
`apps-script/Code.gs` changes deploy through the clasp CI on merge, so do not
paste Code.gs by hand.

**Service worker:** `CACHE_VERSION` goes **v34 → v36**. The live deploy branch
is on v34, and v35 is taken by open PR #181 (pro-bono). If this PR ships
first, v36 still evicts v34.

**Independent of #181.** Both PRs append last to `CLEANUP_SECTION_KEYS` and
to the cleanup workbook's `TABS`, and both bump the SW. Whichever merges
second gets a small conflict on those lines. Keep both entries (pro-bono's
first if #181 merged first) and the higher SW version.

## What Sandra decided (2026-10-05)

| | Decision |
|---|---|
| 1 | `Payments` gets two new columns, appended **at the end** (the sheet is append-only, and a guard test pins the order): `invoiceWanted` (`'yes'` or `'no'`) and `invoiceTo` (free text, 1–120 characters, formula-guarded). |
| 2 | The payment report form gets a «חשבונית?» radio with כן / לא and **no default**. The report cannot be sent until one is chosen; this is checked in the UI and again on the server (`invoice_choice_missing`). When כן is chosen, an «על שם» field appears. It is prefilled with the payer name and it is required (`invoice_to_missing`). When לא is chosen, `invoiceTo` is stored as `''`. If the server refuses a report, nothing is written. |
| 3 | Where the choice shows: the payment line in גבייה, the payment detail view, Ortal's daily email (columns «חשבונית» / «על שם»), the accounting feed (`accountingPayments`) and the workbooks. **A row from before this change shows «—», never כן or לא.** |
| 4 | `updatePayment` may change both fields, with the same validation. The edit is audited like other payment edits. |

## What users see

**Vered and Sandra (finance):**

- **«דווח תשלום»** has a new «חשבונית? *» row, after the coverage period, with two 44px choices, כן and לא. Neither is pre-checked.
  - If you send the form with no choice, you get «חסר: האם להפיק חשבונית (כן / לא)» under the row, and nothing is sent.
  - Choosing **כן** shows «על שם *». If the field is empty, it is filled with the payer you typed, and you can change it.
  - If you send with an empty name, you get «חסר: על שם מי החשבונית».
  - A name that starts with = + @ - or is longer than 120 characters is refused with «שם לחשבונית לא תקין (1 עד 120 תווים, לא מתחיל ב־= + @ -)».
  - Choosing **לא** hides the field, and nothing typed in it is stored.
- **The receipt line** under a גבייה row now ends with «חשבונית: כן · על שם X», «חשבונית: לא», or «חשבונית: —» for a receipt from before this change. A live receipt also gets a **«חשבונית ✎»** button. It opens a small form with the same two questions and the same rules, and saves through `updatePayment`. A receipt still cannot be edited in any other way.
- **«בקרת גבייה»** (Ortal's tab and the detail card of each receipt): two new fields, «חשבונית» and «על שם».
- **«ייצוא אימות»**: two new columns, «חשבונית» and «על שם», on the receipt sheets.
- **«ייצוא רשימת תיקונים»**: a new last tab, **«קבלות ללא בחירת חשבונית»**. It lists every live receipt reported before this change (shown as «—»), with its date, amount and sheet row. The owner is ורד, and the fix is «חשבונית ✎».

**Ortal's daily email:** two new columns, «חשבונית» and «על שם», in both the HTML part and the text part. Legacy rows show «—».

**The accounting feed:** each cycle record gets two things:

- `invoices`: one entry per live receipt of that cycle, in the form `{ receiptId, receivedDate, amount, invoiceWanted: 'yes'|'no'|null, invoiceTo: string|null }`.
- The cycle row's own `invoiceWanted` / `invoiceTo` (null unless a legacy cycle was edited).

When an invoice choice is edited on a receipt, that receipt's cycle comes back in the next `updatedSince` sync: a cycle sorts at the later of its own `sourceUpdatedAt` and its receipts'. The fields are additive, so `schemaVersion` stays 1.

**Shiran and Yael (restricted):** no change. They see no form, no receipt line and no field. `reportPayment`, `updatePayment`, `savePayment` and `getPayments` are finance actions, so both Code.gs and server.js answer `forbidden` / 403.

## Rules, exactly

- **Validation (the same rule in UI and server).** `validateInvoiceChoice_` in Code.gs is the authority. `validateInvoiceChoice` in `lib/payment-report-rules.js` is its mirror, parity-tested on 19 cases. The two fields are kept outside `REPORT_FIELDS` / `validatePaymentReport_`, so the eight-field report contract and its 40-input parity suite do not change. `reportPayment_` concatenates the two issue lists, so you get every problem in one answer.
- **Stored values.** `'yes'` is stored with the name trimmed. `'no'` is stored with `''`.
- **The edit path (`savePayment` / `updatePayment`, `paymentInvoiceFields_`):**
  - A field that is not sent (undefined, null, or a blank `invoiceWanted`) keeps the stored value. Blank means "not sending", never "clear".
  - Sending back the stored values unchanged is not re-validated.
  - A real change is validated on the resulting pair. If it is refused (`validation`), nothing is written.
  - A change writes **one** AuditLog row, `payment_invoice_changed`, with `old`, `new` and `by`, the same pattern as `payment_received_date_changed`. The first choice is recorded in `payment_reported`.
- **Receipts** stay immutable except for void and this choice. A receipt save that changes nothing about the invoice is still `receipt_immutable`, and the receipt's other columns are always the stored ones.
- **Header clash.** If someone hand-added a column where an invoice column belongs, `reportPayment` refuses with `sheet_header_clash`, the same as for the other report columns. A save keeps the stored values, and a real invoice change is refused rather than silently dropped.
- **Display (`paymentInvoiceDisplay_` / `invoiceDisplay`, shared):** `yes` → «כן» plus the name; `no` → «לא» and «—»; anything else → «—» and «—».

## Code

| File | Change |
|---|---|
| `apps-script/Code.gs` | `PAYMENT_COLUMNS` gets `'invoiceWanted', 'invoiceTo'` appended. `PAYMENT_TEXT_COLUMNS` gets both. New: `PAYMENT_INVOICE_COLUMNS`, `INVOICE_*`, 4 messages, `invoiceToCode_`, `validateInvoiceChoice_`, `invoiceChoiceClean_`, `paymentInvoiceDisplay_`, `paymentInvoiceFeed_`, `invoiceHeaderClash_`, `paymentInvoiceFields_`, `logPaymentInvoiceChanged_`, `accountingInvoiceView_`, `cleanupInvoiceMissing_`. `reportPayment_` validates, stores and audits the choice. `upsertPayment_` accepts the invoice-only receipt edit, merges and audits. `digestRow_` / `digestCompose_` get the two columns. `billingControlReceipt_` gets the two fields. `accountingPaymentView_` / `accountingPayments_` add `invoices` and re-surface a cycle on a receipt edit. `CLEANUP_SECTION_KEYS` gets `'invoiceMissing'`. |
| `lib/payment-report-rules.js` | `INVOICE_CHOICES`, `INVOICE_FIELDS`, `INVOICE_TO_MIN/MAX`, `INVOICE_LABELS`, `INVOICE_NONE`, the 4 messages, `validateInvoiceChoice`, `invoiceDisplay`. |
| `public/app.js` | `normalizeReceipt` gets the two fields. New: `invoiceDisplayOf`, `receiptInvoiceHtml`, `invoiceFieldsHtml`, `invoiceValuesFrom`, `wireInvoiceFields`, `openInvoiceEditModal`, `saveReceiptInvoice`. The report form gets the radios and «על שם», and `paymentReportIssues` adds the invoice issues. The receipt line and the «בקרת גבייה» card show the choice. |
| `public/style.css` | The radio row (44px targets) and the receipt-line styles. |
| `lib/billing-control-xlsx.js` | «חשבונית» / «על שם» columns. |
| `lib/cleanup-xlsx.js` | The «קבלות ללא בחירת חשבונית» tab (optional in `isCleanupResponse`). |
| `public/sw.js` | v36. |

## Security

- `invoiceTo` is free text, so it is validated on the server: 1–120 characters, no control character, and no `= + @ -` lead-in. It is stored in a text-forced column. It is escaped everywhere it renders: `escapeHtml` on the page, `digestEsc_` in the email HTML, `digestPlain_` in the email text. In workbooks it goes into formula-guarded text cells.
- `invoiceWanted` is only ever `'yes'` or `'no'`.
- No new action, route, env var, Script Property, scope or trigger. The edit goes through the existing finance-gated `updatePayment`.
- No PII is logged. The AuditLog row holds the old and new choice and the actor, the same as other payment audits.

## Tests

`node --test`: **2160 tests, all green** (2141 before this PR). New files:

- `test/payment-invoice.test.js` (16 tests):
  - **Columns:** order and text formatting, plus the header clash.
  - **Rule:** server/client parity (19 cases) and the Hebrew messages.
  - **Report refused:** without the choice, and when כן has no or a bad name. Nothing is written in any refused case.
  - **Stored values:** what is written for כן and for לא, and the audit row.
  - **updatePayment:** validates, writes one audit row, and leaves other columns immutable; legacy cycles; blank means keep.
  - **Display:** legacy rows show «—» on both sides.
  - **Email:** the columns and escaping.
  - **Accounting feed:** `invoices`, and a cycle coming back after a receipt edit.
  - **Workbooks:** Ortal's queue and «ייצוא אימות», plus the cleanup tab.
  - **Restricted users:** cannot set it, cannot see it, and nothing is written.
  - **Client:** the line, escaping, the finance-only button, the form with no default, and `saveReceiptInvoice`.
- `test/payment-invoice-browser.test.js` (1 test, real Chromium at 360px):
  - The form has no default, and both errors show inline with nothing sent.
  - כן prefills the payer, and the targets are 44px.
  - The report is stored, and the line shows the escaped name.
  - «חשבונית ✎» switches the choice to לא, with one audit row.
  - Shiran: nothing shown, and 403.
- **Updated pins:** column lists and text formatting in 5 tests; the digest allow-list; the queue fields; the feed keys; the cleanup tabs plus a legacy-receipt fixture; the lock-busy write paths (`updatePayment`). Report fixtures now send `invoiceWanted`.

**Mutation check.** Four deliberate breaks, each caught and then reverted:

1. `reportPayment_` without the invoice validation → 2 tests fail.
2. The `payment_invoice_changed` audit dropped → 1 test fails.
3. The legacy display reads as «לא» → 3 tests fail.
4. «חשבונית ✎» shown without finance → 1 test fails.

## Live test (Vered)

1. In גבייה, open «דווח תשלום» and fill everything except «חשבונית?». Sending shows «חסר: האם להפיק חשבונית (כן / לא)», and nothing is saved.
2. Choose «כן»: «על שם» appears with the payer's name. Empty it and send: «חסר: על שם מי החשבונית».
3. Enter a name and send. The receipt line shows «חשבונית: כן · על שם …».
4. Tap «חשבונית ✎» on that receipt, choose «לא», and save. The line shows «חשבונית: לא». An older receipt shows «חשבונית: —».
5. The next morning, Ortal's email has the «חשבונית» / «על שם» columns, and «ייצוא אימות» has them too.
