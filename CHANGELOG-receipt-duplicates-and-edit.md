# Receipts — month-split label, duplicate receipts, editing a receipt's details

Three fixes in «בקרת גבייה» and the receipts on «גבייה» (Sandra, 2026-10-07).

**Railway + Apps Script.** `apps-script/Code.gs` changed (its own commit; the
clasp CI redeploys it on merge to `claude/build-ezone-dashboard-QOg5s`), plus
`public/app.js`, `public/style.css`, `public/sw.js`,
`lib/billing-control-rules.js`, `lib/billing-control-xlsx.js` and
`lib/finance-scope.js`. **No new column, sheet, Script Property, env var,
scope or trigger.** One new action (`editReceipt`) and one new decision value
(`confirmPayment` status `duplicate`). Both are additive. The actions shared
with ezone-managers and ezone-therapists (`OPEN_ACTIONS`) are unchanged.

## A. The «אומתו» line — a month-split receipt no longer reads as partial

**Before:** a confirmed receipt whose coverage spans two months showed
`₪36,774.19 (מתוך ₪38,000)` in October. That is the same shape as a partial
payment, so it read as «שולם חלקית».

**Now** (display only):

| Receipt | «אומתו» line |
|---|---|
| confirmed, spans months | `חלק אוקטובר: ₪36,774.19 · הקבלה המלאה ₪38,000 (תקופה 02/10–01/11) · שולם במלואו` |
| confirmed, one month | `₪38,000 · שולם במלואו` |
| partial (`שולם חלקית`) | `חלק אוקטובר: ₪x · אומת ₪v מתוך ₪38,000 (תקופה …) · שולם חלקית` |

The wording «שולם חלקית» appears **only** when the status is `partial`. The
line is built once, in `lib/billing-control-rules.js` → `confirmedMonthLine`,
and the page escapes it. The amounts are unchanged: they are the same
`verifiedForMonth` slices as before.

**«ייצוא אימות»**, sheet «אומתו» (each month section):
- `סכום הקבלה` → **«הקבלה המלאה»**
- `החלק בחודש` → **«חלק <חודש>»** (for example «חלק אוקטובר»), now placed
  before the full amount
- a new **«סטטוס»** column: «שולם במלואו», or «שולם חלקית» for a partial
  receipt only

## B. Duplicate receipts

### B1. When Vered reports (`reportPayment`)

A report is held back when **the same patient** already has a **live**
(non-void) receipt of **the same amount** (to the agora), received within
**14 days** before or after. The server answers:

```json
{ "ok": false, "error": "possible_duplicate", "message": "קיימת כבר קבלה דומה",
  "existing": { "id": "rcpt-…", "receivedDate": "YYYY-MM-DD", "reference": "…" } }
```

When this happens, **nothing is written**. The form then shows:

> קיימת כבר קבלה דומה (05/10, אסמכתא TRX-9). האם זו קבלה נוספת?
> [כן, קבלה נוספת] [ביטול]

- **«כן, קבלה נוספת»** sends the same report again with
  `confirmDuplicate: true` (only the boolean `true` counts). The receipt is
  written, and an AuditLog row **`payment_duplicate_override`** records the
  new receipt id, the existing id, its date and reference, the amount, and
  who and when.
- **«ביטול»** closes the prompt. Nothing more is sent, and the form stays
  open.
- Not flagged: a 15-day (or longer) gap, a different amount, a voided
  receipt, or a different patient. "Same patient" is `patientUid` when both
  rows have one, otherwise the billing `patientId`. This is the same rule
  that links a receipt to its cycle (`receiptSamePatient_`).

### B2. «כפילות» in Ortal's tab

The status dropdown now has a fourth option: **שולם · שולם חלקית · לא שולם ·
כפילות**.

- **«כפילות»** opens a reason box. The reason is **required, 2–300
  characters**, the same rule as «לא שולם». It is sent as
  `confirmPayment { ids:[one id], status:'duplicate', flagNote }`, and only
  one receipt can be marked at a time.
- On the server (`confirmDuplicate_`), the receipt is voided through the
  **PR #144 void path**: `upsertPayment_` sets `status 'void'`,
  `linkStatus 'duplicate'` and `linkNote` = the reason. It writes the same
  **`payment_link_duplicate`** audit row (actor = Ortal) and re-derives the
  receipt's cycle. So **«נגבה»** and every money figure stop counting it, and
  the receipt leaves her list.
- `duplicate` is a **decision, not a stored status**. `CONTROL_STATUSES` is
  unchanged, and the receipt's `confirmStatus` is not touched.
- **Who:** the controller (Ortal) or the approver (Sandra). The gate is the
  same as `confirmPayment`, enforced in server.js and Code.gs. Vered keeps her
  own «ביטול קבלה» (deleter).
- **The only live receipt of its cycle cannot be marked**. The refusal
  `duplicate_last_receipt` says:
  «זו הקבלה היחידה של המחזור — אי אפשר לסמן אותה ככפילות. אם הכסף לא התקבל,
  סמנו «לא שולם»». This is checked inside `upsertPayment_`, under the script
  lock, against the sheet. An unlinked receipt counts as "the only one".
- **Un-void is Sandra's alone**, unchanged (`unvoidPayment`, approver).

### B3. Existing data — `listDuplicateReceiptsNow()` (read-only)

An editor function that lists every patient with **2 or more live receipts of
the same amount within 14 days of each other**. The receipts are chained, so
each one is within 14 days of the previous one. It **reads Payments only**:
no lock, no write, no sheet created. Production rows are not changed. To run
it:

1. Open the Dashboard spreadsheet → **Extensions → Apps Script**.
2. In the toolbar's function dropdown, choose **`listDuplicateReceiptsNow`**.
3. Click **Run**. The first run may ask for the existing authorization. It
   needs no new scope.
4. Open **Execution log** (or **View → Logs**). The log shows one line per
   patient group, `• <name> (<house>) ₪<amount> × <n>`, followed by one line
   per receipt: `date · id · אסמכתא · method · confirmStatus · recordedBy`.
   The first line says `READ-ONLY: nothing was changed`.
5. Decide each group in «בקרת גבייה» («כפילות») or with Vered («ביטול קבלה»).

## C. ✏️ Editing a receipt's non-money fields (`editReceipt`)

Each live receipt in the «תשלומים שהתקבלו» list on «גבייה» has a **✏️**
button for **Vered and Sandra** (finance, edit mode). It opens a form with:

**אסמכתא · אמצעי תשלום · שם המשלם · חשבונית? / על שם · תקופת כיסוי**, and an
optional **סיבה** (0–300 characters, written to the audit log).

The form has **no amount, receivedDate, status or funder field**. The server
refuses any key outside
`RECEIPT_EDIT_FIELDS = [reference, method, payer, invoiceWanted, invoiceTo,
coverageStart, coverageEnd]` with `field_not_editable` (and lists the keys),
and nothing is written.

- **Validated like `reportPayment`.** The edited fields go through
  `validatePaymentReport_` and `validatePaymentInvoice_`. A bank transfer or
  cheque still needs its reference. The payer and reference cannot start with
  a formula lead-in, and control characters are refused. A coverage change
  must keep the receipt on **the same cycle** (`coverage_outside_cycle`), so
  money never moves between cycles here.
- **Only the changed cells are written.** There is no restamp: `recordedAt`,
  `sourceVersion`, `chargedAt` and the rest stay as they are. **A confirmed
  receipt stays confirmed**: `confirmStatus` and `confirmedAmount` are never
  touched.
- **One AuditLog row `receipt_edited`** per real change, with `fields`,
  `prev`, `next`, `reason`, `by` and `at`. An edit that changes nothing
  writes nothing.
- **Ortal has no edit rights.** `editReceipt` is in `FINANCE_ACTIONS`
  (appended) and **not** in `CONTROLLER_ACTIONS`. Her session gets **403**
  from server.js and `forbidden` from Code.gs, even with a forged finance
  capability. Shiran and Yael get 403 as well. Ortal's «גבייה» view shows no
  ✏️. She decides the status only.

## Lists and versions

- `FINANCE_ACTIONS` (Code.gs and `lib/finance-scope.js`, equality pinned by
  a test): `editReceipt` **appended**. `PROXY_KNOWN_ACTIONS`: `editReceipt`
  appended after #193's `deleteDuplicateDischarge`. This PR does not change
  `OPEN_ACTIONS`, `CONTROLLER_ACTIONS`, `DELETE_ACTIONS` (which keeps #193's
  `deleteDuplicateDischarge`) or `APPROVER_ACTIONS`.
- `PAYMENT_COLUMNS` is unchanged. No column was needed.
- SW `CACHE_VERSION` **v43 → v44**. v43 shipped with the duplicate-discharges
  PR #193, which merged first. v17 stays burned. The pin tests in
  `test/dashboard-perf-assets.test.js` and
  `test/receipt-duplicates-and-edit.test.js` were updated.

## Tests

- `test/receipt-duplicates-and-edit.test.js` (31 tests) covers:
  - A: the label against a real partial, and the workbook headers
  - B1: detection, the override and its audit row, and the 15-day gap /
    other amount / void / other patient cases that are not flagged
  - B2: role gates, the required note, a single receipt only, last-receipt
    protection, «נגבה» dropping (the `buildMonthlyRevenue` model from
    `getPayments`), and un-void staying Sandra's
  - B3: read-only, with groups
  - C: the allow-list, forbidden fields refused server-side, validation, the
    audit row, controller 403 in both server.js and Code.gs, and escaping
  - **7 mutation checks**: a mutated Code.gs or lib must fail its check (B1
    check removed, window widened to 15 days, last-receipt guard dropped,
    note check dropped, allow-list bypassed, audit row removed, and the
    partial shape printed for a confirmed receipt)
- `test/receipt-duplicates-and-edit-browser.test.js` (real Chromium, 360px)
  covers:
  - Vered's duplicate prompt («ביטול» / «כן, קבלה נוספת»)
  - ✏️: no money field, an inline error, only the changed field sent, the
    audit row
  - Ortal's «כפילות»: the note is required, the row leaves the list, the
    sheet row is void, the cycle is re-derived, and the last-receipt refusal
    shows in Hebrew; she sees no ✏️ on «גבייה»
- Updated to the new spec:
  - the dropdown now has 4 options (`ortal-billing-access`,
    `ortal-verification-status`, and its browser test)
  - the partial «אומתו» wording (`ortal-verification-status`)
  - the SW pins (`dashboard-perf-assets` → v44; #193's
    `duplicate-discharges` pin now reads "v43 or later, never v17")
  - a lock-busy case for `editReceipt` (`lock-busy-frontend`, required for
    every write path)
  - `funder-probono`: the second report in its loop had the same amount on
    the same day, which is now correctly a possible duplicate, so it uses
    ₪5,001
- `test/helpers/gs-sandbox.js` gained an optional `src` (a mutated Code.gs
  for the mutation checks).
