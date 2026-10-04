# The strict payment-report form — live (Phase 3, PR 2 of 2)

Plan: `docs/billing-control-plan.md`, Phase 3 and §14.1. Builds on PR 1
(#173, `CHANGELOG-payment-report-foundation.md`). Branch
`feat/payment-report-form` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` changes are in their own commit (the clasp CI deploys
them on merge). Service worker `CACHE_VERSION` **v29 → v30**.

**What users see after this PR:**

- On every גבייה row, the status dropdown and the «שולם בפועל» box are
  **gone, for everyone**. The row shows its state (שולם / שולם חלקית / לא
  שולם / מבוטל), how much was paid, the balance, and a **«דווח תשלום»** button.
- «דווח תשלום» opens a strict form. It cannot be sent until every field is
  valid; each problem is shown in Hebrew under its own field.
- Under each row: the list of payments received for that cycle (date, amount,
  method, reference, who recorded it). Vered and Sandra can void a receipt
  («ביטול קבלה»).
- On the תפוסה patient row: **«גורם מממן»**, with a «שינוי» button.
- On the dashboard, «חידוש תשלום» now opens the same form.
- Shiran and Yael see none of this (no גבייה tab, no button, no form, no
  funder editor), and the server refuses them (403).

---

## What Sandra decided (2026-10-04)

| | Decision |
|---|---|
| A | **One row per money received.** A report always creates a NEW `Payments` row (a *receipt*). It never edits the amount of an existing row. The cycle row stays the *charge*; its `amountPaid` / `balance` / `status` are **derived** from its receipts and recomputed by the server. A legacy cycle with `amountPaid > 0` and no receipt counts as one legacy receipt. |
| B | **Strict.** The form cannot be sent until every field passes `lib/payment-report-rules.js`, with an inline Hebrew error per field. The server re-validates (`validatePaymentReport_`) and refuses an incomplete report: `{ok:false, error:'invalid_report', issues:[…]}`. **Nothing is written.** |
| C | The old status dropdown / «שולם בפועל» is removed for everyone. Un-doing a receipt = voiding it (`deleter`, the existing void flow). Never editing it. |
| D | Funder on the patient card: פרטי / ביטוח לאומי / משרד הביטחון / מכבי, with an effective-from date. Saving appends to `Funders` (action `appendFunder`). No row → «פרטי (ברירת מחדל)». |
| E | `receivedDate` required, not in the future, at most **90 days back** (older: Sandra only — «פנו לסנדרה»). Reference required for העברה בנקאית and צ'ק. |
| F | Restricted sessions (Shiran / Yael) never see the form, the button or the funder editor. |
| G | Ortal's digest: one line per receipt; «תאריך תשלום» = `receivedDate`; new «אסמכתא» column next to «אמצעי». |

---

## How it works

### The data model (`apps-script/Code.gs`)

**A receipt** is a `Payments` row whose `id` starts with `rcpt-`. The server
mints the id; a client can never create one.

| Column | Value on a receipt |
|---|---|
| `id` | `rcpt-<uuid>` |
| `status` | `paid` (or `void` once voided) |
| `amount` = `amountPaid` | the money received; `balance` 0 |
| `patientId`, `patientName`, `houseId`, `dueDate`, `patientUid` | copied from the cycle it pays |
| `coverageStart` / `coverageEnd` | from the report |
| `receivedDate`, `method`, `payer`, `funder`, `reference` | from the report |
| `recordedBy` / `recordedAt` | the signed session / server clock |
| `confirmStatus` | `reported` |
| `chargedAt` / `chargedBy` | stamped on creation (this is what Ortal's digest reads) |

**A cycle** is every other row: the charge, with a `dueDate` and the expected
`amount`.

**The link** (`linkReceiptsToCycles_`): a receipt pays the cycle with the same
patient (`patientUid` when both rows have one, else the `patientId` triple)
whose window contains the receipt's `coverageStart`. The window is the
recorded coverage, else `dueDate … dueDate + 1 month − 1 day` (the app's own
inferred cycle). Several candidates → the one with the receipt's own
`dueDate`, then the latest start. Void cycles are never candidates.

**The derivation** (`recomputeCycleFromReceipts_(cycleRow, receipts)`, pure):

- **No receipt row at all** → the stored figures, untouched (legacy).
- **Otherwise** → `amountPaid = legacyAmountPaid + Σ live receipts`,
  `balance = max(0, amount − amountPaid)`, status `paid` / `partial` /
  `unpaid` from those. A void cycle stays void.

**One new column, `legacyAmountPaid` (position 36, appended).** When a cycle
that already has legacy money gets its first receipt, its stored
`amountPaid` moves into `legacyAmountPaid`, **once**. Without it, the legacy
money would vanish from the derived total. Voiding every receipt falls back
to exactly the legacy figure. Server-owned (`PAYMENT_SERVER_COLUMNS`).

### `reportPayment` (new action)

`PROXY_SECRET`-gated (not in `OPEN_ACTIONS`), in `FINANCE_ACTIONS` and
`PROXY_KNOWN_ACTIONS`.

Body: `{ report: { cycle: { id, patientId, patientName, houseId, dueDate,
amount, coverageStart, coverageEnd }, report: { receivedDate, amount, method,
payer, coverageStart, coverageEnd, funder, reference } } }`.

1. **Validate first** (`validatePaymentReport_`, every field). For anyone
   but the verified approver (Sandra), a `receivedDate` more than 90 days back
   is refused too. An issue → `{ok:false, error:'invalid_report', message,
   issues}`, **nothing written**.
2. Under the script lock: refuse a header clash on `Payments`
   (`sheet_header_clash`), a void cycle (`cycle_void`), and a report whose
   `coverageStart` lies outside the cycle window
   (`coverage_outside_cycle`).
3. Find the cycle row, or **create it** (unpaid, from the payload) when the
   cycle was still a placeholder on screen.
4. An unpaid cycle's expected `amount` is frozen to its per-month override, if
   it has one — exactly what the old row save did.
5. Append **one** receipt row.
6. Re-derive the cycle from all its receipts and write it. The cycle's
   `paymentUid` and version follow the usual rules (`stampPaymentRow_`). A
   cycle that was already charged keeps its `chargedAt`, so the legacy part
   stays dated as before.
7. AuditLog **`payment_reported`** with the actor, the receipt and cycle ids,
   the amount, date, method, funder and the cycle's new status.

→ `{ ok:true, receipt (with cycleId), cycle, created }`.

### `appendFunder` (new action)

`PROXY_SECRET` + `FINANCE_ACTIONS`. Body `{ funder: { patientId, funder,
effectiveFrom } }`. Calls the existing `appendFunder_` (validation, lock,
append-only, AuditLog `funder_set`), `setBy` from the signed session.
→ `{ ok:true, row, current, history }`. The `Funders` tab is created on the
first save if it does not exist.

### `savePayment` (existing) — what changed

- **A receipt** can only be voided (or un-voided by Sandra). Everything else
  in the payload is ignored in favour of the stored row; any other change →
  `receipt_immutable`. A `rcpt-` id that is not on the sheet →
  `receipt_via_report_only`. After a void / un-void the server re-derives the
  cycle and returns it as `cycle`.
- **A cycle that has receipts**: `amountPaid`, `balance` and `status` are
  always re-derived; whatever the payload says is ignored. Voiding it while a
  live receipt pays it → `cycle_has_receipts`.
- **A legacy cycle (no receipts)** behaves exactly as before. See "Choices I
  made" 7.

### Every reader of `Payments`

| Reader | Now |
|---|---|
| `getPayments` | `payments` = the **cycles only**, derived. New keys `receipts` (each with `cycleId`) and `funders`. Every existing key kept. |
| `debtAging_` | Cycles only. Money received by the as-of date = the legacy part (dated as before) + each receipt **by its own `receivedDate`**. A partial payment topped up later is owed exactly the top-up between the two dates. This closes PR 1's known limitation. |
| Monthly revenue (`buildMonthlyRevenue`, app.js) | Unchanged code: it reads the cycles' derived `amountPaid`. A test checks that it agrees with `debtAging_` on one fixture. |
| `recModel_` (reconciliation report, cleanup workbook) | Cycles only, derived. `cleanupReport_` derives once so its parallel row indexes stay aligned. |
| `refundSuggestionsFor_`, `refundPayoutForecastFor_` | Cycles only, derived. |
| Accounting feed (`accountingPayments`) | Cycles only, with the derived total. Receipts are not exported, so the contract (one record per cycle) is unchanged. |
| Ortal's digest | One line per receipt. A cycle with receipts is never listed itself (that would count the money twice). A legacy row is listed as before. |

### `server.js`, `lib/`

- `lib/finance-scope.js`: `reportPayment` and `appendFunder` added to
  `FINANCE_ACTIONS`. Shiran and Yael get 403 before anything is proxied.
  Nothing new is open.
- `lib/payment-report-rules.js`:
  - `RECEIVED_DATE_STAFF_MAX_DAYS = 90`, `ctx.maxDaysBack`, and the message
    `received_date_too_old`. Code.gs has the same rule; the parity test
    covers it.
  - Wrapped in an IIFE. Node `require`s it as before; a browser gets one
    global, `window.PaymentReportRules`.
- New route `GET /payment-report-rules.js`. It serves that same file (rules
  and Hebrew messages only, no data), like `app.js`.

### The page (`public/`)

- **The form** (`openPaymentReportModal`):
  - RTL, works at 360px, and every field has its own error slot.
  - It opens prefilled: patient, house, cycle window, the expected amount
    (the remaining balance), today's date, and the patient's current funder.
  - Errors appear live once a field has been touched. Pressing «שמירת
    הדיווח» paints them all and focuses the first one. **No request is sent
    while any issue remains.**
  - The button shows a spinner while saving (busy state). A refusal from the
    server is painted under the same fields.
  - On success the toast says **«התשלום נרשם — יופיע אצל אורטל מחר
    בבוקר»**.
  - Nothing is applied optimistically: the money a row shows is always the
    server's.
- **The row** (`buildBillingRow`): the derived state, «שולם», «יתרה»,
  «דווח תשלום» (not on a void row, and not on a cycle already paid in full),
  and the receipts list.
- **Void a receipt** («ביטול קבלה», `deleter` only): asks for a reason, then
  uses the existing void flow (`savePayment`, status `void`, `linkStatus`
  `duplicate`). The re-derived cycle comes back from the server.
- **Funder** (`patientFunderCellHtml`, `openFunderModal`): finance sessions
  only. It shows the current funder (or «פרטי (ברירת מחדל)») and a «שינוי»
  modal with a dropdown, an effective-from date and the last five rows of
  history.
- **«חידוש תשלום»** (dashboard renewal alert) opens the form for the renewal
  cycle. It no longer marks the cycle paid.
- `index.html` loads `payment-report-rules.js` before `app.js`.
- `sw.js`: v30; `/payment-report-rules.js` is network-first.

---

## Tests

**New: `test/payment-report-form.test.js`** (39 tests). It runs the real
Code.gs, app.js and lib in vm sandboxes:

- **Every rule (19 cases)** gives an inline Hebrew error in the form (through
  the shared lib) **and** a server refusal with **nothing written**. The
  Payments and AuditLog grids are byte-identical before and after. The 19
  cases:
  - `receivedDate`: missing, not a date, in the future, more than 90 days back;
  - amount: missing, 0, `1,500`;
  - method: missing, unknown;
  - payer: missing, formula-like;
  - reference: missing (transfer), missing (cheque), malformed;
  - funder: missing, unknown;
  - coverage: start missing, end missing, reversed.
- **The 90-day rule:** Vered is refused («פנו לסנדרה»), Sandra is accepted,
  exactly 90 days is fine.
- A coverage window outside the cycle is refused.
- **One row per money received:**
  - A first report appends one row: the cycle becomes partial and its
    `amount` stays as it was.
  - A second report appends another row: the two receipts add up and the
    cycle is paid.
  - Every report field and stamp is checked, the audit rows too, and
    `getPayments` has exactly `ok / payments / receipts / funders`.
- A report on a placeholder cycle creates the cycle.
- An unpaid cycle's override amount is frozen.
- **Legacy:** a cycle with `amountPaid` and no receipts derives unchanged
  (pure, and through `getPayments`). Its first receipt keeps the legacy money
  in `legacyAmountPaid`. Voiding that receipt falls back to the legacy figure.
- **Void:** voiding a receipt re-derives the cycle (paid → partial), and the
  row stays as `void`. Shiran cannot void.
- **A receipt is protected:** it cannot be edited, cannot be created through
  `savePayment`, and its cycle cannot be voided while it is live. A stale
  cycle save cannot overwrite the derived money.
- **Restricted:**
  - both actions are in `FINANCE_ACTIONS`;
  - Code.gs refuses Shiran with nothing written;
  - enforce mode refuses a call without the secret;
  - the page shows no form, no button and no funder cell.
- **Funder:**
  - append (audited, `setBy` from the session) and history;
  - a bad funder is refused with nothing written;
  - `getPayments.funders`;
  - the page shows «פרטי (ברירת מחדל)», the current funder by date, and
    the form prefills it.
- **The page:**
  - a submit posts `reportPayment` once and adopts the receipt and the
    derived cycle;
  - a refusal throws its issues and changes nothing;
  - the toast text;
  - the row has no dropdown, shows the derived state and the receipts list;
    «ביטול קבלה» is offered to a deleter only;
  - a paid or void cycle offers no report;
  - the form opens prefilled.
- **Digest:** two receipts give two lines, and the paid cycle is not a third.
  Each line has `receivedDate`, method and reference. The HTML and the
  plain-text parts both have the «אסמכתא» column. A legacy row is still
  listed.
- **Agreement on one fixture.** The fixture: a legacy July cycle, August paid
  by one receipt, September topped up by two receipts.
  - The monthly revenue (app.js, from `getPayments`) adds up to the derived
    `amountPaid`.
  - `debtAging_` gives the same balance.
  - As of 10/09 only the first September receipt counts.
  - The cleanup workbook's gaps agree too.
- **Other readers:** the accounting feed and the refund readers see cycles
  only.
- **Scope and wiring:**
  - `OPEN_ACTIONS` is unchanged, and the lists are equal on both sides;
  - server.js names neither action;
  - the rules route exists and the page loads it before app.js;
  - SW v30.
- **The lib in a browser:**
  - it exposes one global, with no leaked names;
  - it gives the same answers as Node and as Code.gs, including the new age
    rule.

**New: `test/payment-report-form-browser.test.js`.** Real Chromium at 360px:
the real server.js and the page, with the **real Code.gs** answering behind
the proxy.

- **Vered:**
  - no status dropdown on the row;
  - «דווח תשלום» opens the form, prefilled with ₪30,000 and פרטי;
  - she sends a bank transfer without a reference: exactly one inline error,
    `aria-invalid` set, nothing sent, no sideways scroll (screenshot 1);
  - she adds the reference: the toast, the row «שולם» with the receipt,
    «ביטול קבלה», and no second «דווח תשלום» (screenshot 2);
  - Code.gs holds the cycle and **one** receipt;
  - the patient card shows «פרטי (ברירת מחדל)».
- **Shiran:**
  - no button, no form, no funder editor;
  - a direct POST of `reportPayment` / `appendFunder` gets 403;
  - nothing more is written.
- Screenshots: `docs/screenshots/payment-report-form/`.

**Updated** (they pinned the removed dropdown, the column list, the action
list or the SW version):

- `accounting-source-feed`, `orphan-payments-reconcile`,
  `payment-coverage-period`, `payment-report-foundation`: column 36 and the
  `reportPayment` / `appendFunder` actions.
- `detached-payments`, `duplicate-payment-void`: `reportPayment` added to the
  payment actions; the row has no `<select>`.
- `duplicate-payment-void-browser`: a void row offers no «דווח תשלום».
- `async-button-busy-states`: the row no longer has the controls it used to
  freeze.
- `renewal-confirm-and-spinner-fix`: «חידוש תשלום» opens the form, and an
  empty submit writes nothing.
- `lock-busy-frontend`: `reportPayment` and `appendFunder` get the busy-lock
  retry tests.
- `ortal-daily-digest`: `reference` added to the allow-list.
- `personal-pins-cleanup`: SW "v29 or later".
- `restricted-view`: `loadAll` also empties the receipts and the funders.

**Full suite: 2047 / 2047 passing** (2003 on the base + 44), every browser
test running.

---

## Choices I made (ambiguous points — the safest reasonable option)

1. **A receipt is recognised by its id** (`rcpt-`, server-minted), not by a
   new "kind" column. A client can never create one through `savePayment`.
2. **One appended column, `legacyAmountPaid`.** Otherwise, the first receipt
   on a cycle that already had legacy money would make that money disappear
   from the derived total.
3. **The link is the coverage window plus the patient**, as decided. The
   server refuses a report whose coverage starts outside the cycle it was
   opened from (`coverage_outside_cycle`), so a receipt always links to the
   intended cycle. A receipt also carries its cycle's `dueDate`, as the
   tie-breaker.
4. **A placeholder cycle is created by the report.** Today's cycles on the
   גבייה list often have no `Payments` row yet.
5. **An unpaid cycle's expected amount is frozen to its per-month override**
   at report time, as the old row save did. Otherwise ₪25,000 against an
   overridden ₪25,000 would read «שולם חלקית».
6. **`getPayments` keeps `payments` = one row per cycle** and adds
   `receipts` and `funders`. Every screen that sums `amountPaid` (revenue,
   growth, alerts) stays correct with no change. An old cached page also
   reads the right totals.
7. **The legacy money write on `savePayment` still works for a cycle with no
   receipts.** It is no longer offered anywhere in the page. Only an old
   cached page (until SW v30 loads) or a hand-built call can reach it.
   Refusing it would surface errors on stale pages during the rollout. Once
   a cycle has a receipt, the money there is always derived and the payload
   is ignored. If you want it closed completely, it is a one-line follow-up.
8. **Voiding a cycle that a live receipt pays is refused.** Void the receipts
   first, so money never hangs on a void row.
9. **A cycle that was already charged keeps its `chargedAt`.** It dates the
   legacy part in `debtAging_`; each receipt has its own `receivedDate`.
10. **The accounting feed exports cycles only**, with the derived total. Its
    contract (one record per cycle) is unchanged. Per-receipt export is a
    separate decision for the accounting app.
11. **The digest skips a cycle that has receipts**, so the money is listed
    once.
12. **«דווח תשלום» is hidden on a cycle already paid in full** (and on a
    void row). A second report there is almost always the same money twice.
    Voiding a receipt reopens it. An overpayment on an unpaid or partial
    cycle is accepted, as the plan says (an amount different from the
    expected one does not block). The cycle is then paid, balance 0.
13. **«חידוש תשלום» on the dashboard opens the form** for the renewal cycle.
    It used to mark the cycle paid with no report, which decision A rules out.
14. **The funder in the form is prefilled but editable.** The rules require a
    funder per payment, and Vered can correct one payment without changing
    the patient's funder.
15. **The funder editor is on the תפוסה patient row** (the patient card).
    Edit mode and finance only. The effective-from date defaults to today;
    the history shows the last five rows.
16. **A header clash refuses the report** (`sheet_header_clash`, «פנו
    לסנדרה»). A hand-added column where a report column belongs would
    otherwise misalign the receipt.
17. **The 90-day check uses the verified approver role** (Sandra's personal
    session). The page uses `state.approver` only to show the same answer.
18. **The rules file is served at `/payment-report-rules.js`, network-first,
    not precached.** Offline the form cannot be sent anyway.
19. **Voiding a receipt reuses the existing void flow**: `deleter`, a
    reason, `linkStatus` `duplicate`. The server already requires that pair
    for any void.
20. **Branch name:** `feat/payment-report-form`, as asked. The session's
    default branch was a different auto-generated name.

## For Sandra

- **Nothing to set in Railway** and no Script Property.
- The `Funders` tab is created by the first «שינוי» save if it does not exist
  yet (`setupFundersSheetNow` still works too).
- Before merging, glance at `Payments`. If column 36 (or 25–35) holds a
  hand-added header, tell Claude. Reports are refused until it is moved, and
  nothing is written into a misaligned sheet.

## For Vered

*(Simple English, for her guide.)*

**Recording a payment — «דווח תשלום»**

1. Open **גבייה**. Find the patient's row for the month.
2. Tap **«דווח תשלום»**. A form opens. Most of it is already filled in:
   the patient, the house, the month (תקופת כיסוי), the amount still owed,
   today's date and the patient's funder.
3. Check or fill each field:
   - **תאריך קבלת התשלום** — the day the money really arrived. Not a future
     date. If it was more than 90 days ago, ask Sandra (the form will say
     «פנו לסנדרה»).
   - **סכום** — what you actually received. It can be less than the full
     month (a partial payment).
   - **אמצעי תשלום** — העברה בנקאית / אשראי / צ'ק / מזומן / ביט / אחר.
   - **שם המשלם** — who paid (for example the family name).
   - **מספר אסמכתא** — the transfer or cheque number. **Required for a bank
     transfer and for a cheque.**
   - **גורם מממן** — usually already right. Change it only if this payment
     came from someone else.
4. Tap **«שמירת הדיווח»**. If something is missing, a red line appears under
   that field. Fix it and tap again. Nothing is saved until everything is OK.
5. When it is saved you will see: **«התשלום נרשם — יופיע אצל אורטל מחר
   בבוקר»**.

**What you will see after saving**

- The row shows **שולם** (paid in full) or **שולם חלקית** (part paid), the
  amount paid and the balance.
- Under the row: **«תשלומים שהתקבלו»**, one line per payment (date, amount,
  method, reference, who recorded it).
- Paid in two parts? Report each part separately, when it arrives. Each one
  is its own line, and the row adds them up.

**A mistake?**

- You cannot edit a payment. Tap **«ביטול קבלה»** on that line, write the
  reason, and report it again correctly. The cancelled line stays, crossed
  out, so everyone can see what happened.

**The patient's funder**

- In **תפוסה**, each patient shows **«גורם מממן»** (פרטי / ביטוח לאומי /
  משרד הביטחון / מכבי). «פרטי (ברירת מחדל)» means nobody has set it yet.
- To change it: tap **«שינוי»**, choose the funder and the date it starts
  from, and save. The old value stays in the history.

**«חידוש תשלום» on the dashboard** now opens the same form.
