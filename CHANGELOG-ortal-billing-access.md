# Ortal: read access to «גבייה» + partial confirmation and a note (PR 1 — server + schema)

Extends Phase 4 (`CHANGELOG-billing-control-tab.md`, PR #179). Nothing in
Phase 4 is rebuilt. Base: `claude/build-ezone-dashboard-QOg5s` (the
Railway / clasp deployed branch). `apps-script/Code.gs` deploys through the
clasp CI on merge.

**Zero UI change in this PR.** The page, `index.html`, `app.js`, `style.css`
and `sw.js` are untouched (the service worker stays **v39**). PR 2
(`CHANGELOG-ortal-verification-status.md`) adds the dropdown, the amount
field, the remaining balance, the note field and Ortal's «גבייה» tab.

---

## What Sandra decided (2026-10-06)

| | Decision |
|---|---|
| A | Ortal's `controller` role also gets **read** access to the full «גבייה» tab, enforced on the server. No delete, no void, no approvals. Shiran and Yael stay blocked. |
| B1 | Every «בקרת גבייה» row gets an optional free-text note: up to 500 characters, editable at any time, separate from the «לא שולם» note. |
| B2 | A status dropdown replaces ✓ / ⚑: **שולם** (the full reported amount), **שולם חלקית** (amount > 0 and < reported; the rest stays open debt), **לא שולם** (the existing flow, note required). |
| — | Only confirmed money reduces debt in «בקרת גבייה». Shared revenue rules and Outpatient are unchanged. Every change is appended to the audit trail (at, by, prev, next). |

---

## The Phase 4 code this extends (the map)

| Piece | Where | Phase 4 behaviour |
|---|---|---|
| Ortal's user | `lib/users.js` | `ortal`, roles `['controller']`, caps `['billingControl']`, by stable id |
| View | `lib/users.js` `isControllerView` / `principalView` | `'controller'` → the page shows only «בקרת גבייה» |
| Route lock | `server.js` `controllerRouteLock` | Any `/api/` path outside `CONTROLLER_ROUTES` → 403 |
| Action lock | `server.js` `requireBillingControlForAction` | Ortal: only `CONTROLLER_ACTIONS` |
| Finance lock | `server.js` `requireFinanceForAction` | `FINANCE_ACTIONS` need `finance`. For Ortal: only `CONTROLLER_ACTIONS`, with `billingControl` |
| Role lock | `lib/role-scope.js` | `confirmPayment` needs `controller` or `approver` |
| Second lock | `Code.gs` `viewRefused_`, `financeRefused_`, `isControllerActor_` | The same decisions, by id |
| Columns | `Code.gs` `PAYMENT_COLUMNS` 31–34 | `confirmStatus`, `confirmedBy`, `confirmedAt`, `flagNote` |
| Statuses | `Code.gs` `CONFIRM_STATUSES` | `reported`, `confirmed`, `flagged` |
| Decision | `Code.gs` `confirmPayment_` | Atomic, `tryLock(10000)`. Stamps once. One AuditLog row `payment_confirm_<to>` |
| Queue | `Code.gs` `billingControlQueue_` | Receipts, counts, `debt60` from `debtAging_`, Sandra's exceptions |
| Verified money | `lib/billing-control-rules.js` `verifiedForMonth` | Confirmed receipts, split over months by coverage |
| Debt math | `Code.gs` `recomputeCycleFromReceipts_`, `debtAging_` | A cycle's paid amount = the sum of its live receipts (reported money). Not changed here. |

The brief mentions `receivedAmount` and `invoiceNumber` on the confirm. The
code has neither:
- Ortal's confirm writes only the status cells.
- `receivedDate` is part of Vered's report.
- The invoice fields are `invoiceWanted` / `invoiceTo`, also on Vered's report.

All three stay exactly as they are.

---

## How it works

### A. Ortal reads «גבייה» (server-side)

- **`lib/finance-scope.js`**:
  - New **`CONTROLLER_BILLING_READ_ACTIONS`**: `getData`, `getPayments`,
    `getCredits`, `refundPayoutForecast`, `debtAging`, `cleanupReport`.
  - **`CONTROLLER_ACTIONS`** grows (append-only): the Phase 4 three, then
    those reads.
  - **`CONTROLLER_ROUTES`** adds the two «גבייה» exports:
    `/api/export/refund-forecast.xlsx` and `/api/export/cleanup.xlsx`.
  - **`CONTROLLER_GETDATA_KEYS`** = `ok`, `patients`, `billingOverrides`.
  - **`controllerGetDataView`** is an allow-list cut. A key added to getData
    later never reaches Ortal.
- **`server.js`**:
  - `viewFilteredResponse` cuts Ortal's getData.
  - The two exports use `requireFinanceOrController`.
  - `/api/me` adds `billingRead` (display only).
- **`Code.gs`** (second lock):
  - The same lists.
  - `getDataForActor_` → `controllerGetData_` for the controller actor, by id.
  - `financeRefused_` already admits `CONTROLLER_ACTIONS` with
    `billingControl`.
- **Writes stay refused.** These are on neither list, so they get 403 on
  the server and `forbidden` in Code.gs, even with a forged `finance` cap:
  - savePayment / updatePayment (and so void / un-void);
  - reportPayment;
  - the monthly override;
  - credits (`saveCredit`, `suggestRefunds`);
  - the funder (`appendFunder`).

  Her roles are still `['controller']` only.
- **Shiran and Yael:** unchanged. They get 403 on every «גבייה» read, on
  both tab actions and on all three exports.

### B. The status dropdown and the note (`confirmPayment`)

**Two columns are appended at the end of `Payments`.**

| Column | Content | Written by |
|---|---|---|
| `confirmedAmount` | **שולם**: the full reported amount. **שולם חלקית**: the partial amount. Otherwise: blank. | `confirmPayment_` only |
| `controlNote` | Ortal's note, text-forced | `confirmPayment_` only |

`upsertPayment_` pins both to the stored row, so savePayment and
updatePayment can never write them.

**New statuses.** `CONTROL_STATUSES` = `reported`, `confirmed`, `partial`,
`flagged`. The savePayment path keeps `CONFIRM_STATUSES` (no `partial`).

**The body:**

```
{ ids, status, flagNote, confirmedAmount, controlNote }
```

- `partial`:
  - one receipt only;
  - `confirmedAmount` must be a finite number, at most two decimals,
    greater than 0 and less than the reported amount.
  - Refusals: `partial_single`, `partial_amount_invalid`,
    `partial_amount_range`.
- `controlNote`:
  - one receipt only;
  - text only, 0–500 characters;
  - one line: control characters become spaces, and a formula lead-in
    (`= + - @`) is dropped;
  - a longer note is refused, never cut;
  - `''` clears the note;
  - it can be sent without a status (a note-only edit).
- **Atomic** as before: any refusal writes nothing.
- **`tryLock`** is checked: a busy lock → `lock_busy`, with nothing written.
- **Header:** `paymentControlHeaderClash_` refuses the write if a
  hand-added column sits where the new columns belong. Blank header
  names are filled in.

**The audit trail.** Every change appends a row. Nothing is overwritten
silently.

- **`payment_confirm_<to>`** (a status or amount change). The details hold:
  - `at`, `by`;
  - `prev` and `next`, each `{ status, confirmedAmount, flagNote }`;
  - `confirmedAmount` and `openAmount`;
  - the Phase 4 fields (`from`, `to`, `oldFlagNote`, `flagNote`,
    `amount`).
- **`payment_control_note`** (a note change). The details hold `at`, `by`,
  and `prev` / `next` as `{ controlNote }`.
- `confirmedBy` / `confirmedAt` are still stamped **once**, at the first
  `confirmed` or `partial`.

**Debt — only confirmed money counts in «בקרת גבייה».**

- `receiptVerifiedAmount_` (verified money):
  - `confirmed` → `confirmedAmount`, or the full amount when blank (a
    receipt confirmed before this PR);
  - `partial` → `confirmedAmount`;
  - anything else → 0.
- `receiptOpenAmount_` (the open rest):
  - `partial` → reported − verified;
  - `flagged` → the whole amount;
  - `reported` (still waiting) and `confirmed` → 0.
- The queue's receipts add `verifiedAmount`, `openAmount`, `confirmedAmount`
  and `controlNote`.
- `counts.partial` = `{ count, amount, verified, open }`.
- New `openDebt` = `{ partial, notReceived, total }`.
- **Unchanged:**
  - the reported amount (`amountPaid`);
  - the cycle's derived money;
  - `debtAging_` / «חובות פתוחים» / «חובות מעל 60 יום»;
  - «נגבה»;
  - the accounting feed;
  - Outpatient.

**`lib/billing-control-rules.js`** (the same file runs on the page and in
the workbook):
- New: `CONTROL_STATUSES`, `DECISION_OPTIONS` (שולם / שולם חלקית / לא
  שולם), `verifiedAmountOf`, `openAmountOf`, `openDebt`,
  `partialAmountCheck`, `controlNoteCheck`.
- `verifiedForMonth` / `verifiedMonths` count a partial receipt's confirmed
  amount only.
- `summaryCards` adds `partial` and `openDebt`.
- A parity test runs these against Code.gs.

**«ייצוא אימות» workbook:**
- A fifth sheet, «שולם חלקית»: reported, confirmed, the open rest, the note.
- A «הערת בקרה» column on every receipt row.
- A «יתרה פתוחה לפי אימות» section in «סיכום».

---

## Tests

**New: `test/ortal-billing-access.test.js`** (18 tests). They run the real
Code.gs and server.js.

- **Permissions, Code.gs:**
  - Ortal reads all six «גבייה» actions;
  - getData = `billingOverrides`, `ok`, `patients` only (no lead);
  - every «גבייה» write and the void are `forbidden`, even with a forged
    finance / deleter / approver cap, with nothing written;
  - Shiran and Yael are refused every read and both tab actions.
- **Permissions, server.js:**
  - Ortal gets 200 on every read (GET and POST), proxied with her
    principal, never `finance`;
  - getData is cut again on this side;
  - Ortal gets 403 on every write and on the debug routes, with nothing
    proxied;
  - Shiran and Yael get 403 on every read and all three exports, with
    nothing proxied;
  - Ortal gets both exports;
  - `/api/me` `billingRead`.
- **Status enum:**
  - the four statuses;
  - `paid`, `PARTIAL`, `Confirmed`, `void`, `null` and `7` are refused;
  - no status and no note is refused;
  - savePayment cannot set `partial`.
- **Partial bounds:**
  - refused: 0, negative, blank, `null`, `abc`, `1e3`, `NaN`, `Infinity`,
    three decimals, an object, = reported, > reported, two receipts;
  - accepted: 0.01 and reported − 0.01;
  - the lib check agrees.
- **Remaining-debt math:**
  - partial 6,000 of 10,000 → verified 6,000, open 4,000;
  - flagged → open in full;
  - confirmed → 0;
  - `openDebt` total;
  - lib = Code.gs on projected and raw rows;
  - «הכנסה מאומתת» = 8,500 (the flagged 4,000 is not income);
  - a receipt confirmed before this PR counts in full, and re-confirming it
    is a no-op.
- **Audit:**
  - six changes → six rows, each with `at`, `by`, `prev` and `next`;
  - the same partial again is a no-op;
  - a new amount is a change;
  - stamped once.
- **The note:**
  - separate from `flagNote`;
  - a status change keeps it;
  - Sandra may edit it, Vered may not;
  - a note on two receipts at once is refused.
- **Escaping:**
  - 500 characters stored, 501 refused, non-text refused;
  - the formula lead-in and control characters are dropped;
  - HTML is stored verbatim as text;
  - the lib check = Code.gs;
  - the workbook holds the note as a string cell, never a formula.
- **Write path:**
  - savePayment cannot write either column (a receipt, an existing cycle, a
    new row);
  - a busy lock writes nothing;
  - the header names are filled in, and a clash refuses the write.

The new tests catch each of these mutations (checked by hand):
- dropping the partial upper bound;
- un-pinning the columns in savePayment;
- not cutting getData in server.js;
- skipping the note audit row;
- adding `savePayment` to Ortal's list.

**Updated:** these tests pinned the old lists, columns or answers.

- `billing-control-tab`:
  - `CONTROLLER_ACTIONS`;
  - `counts.partial` and the four new receipt keys;
  - Ortal's getData is now the cut answer, not 403;
  - the route scan's minimum count (two exports opened);
  - `/api/me` `billingRead`;
  - a narrowed Ortal can read but not write;
  - the workbook has five sheets.
- `billing-control-tab-browser`: the direct-fetch check now tries writes
  (403) and getData (200, three keys).
- `accounting-source-feed`, `orphan-payments-reconcile`,
  `payment-coverage-period`, `payment-invoice`,
  `payment-report-foundation`: the two appended columns.
- `personal-pins-login`: `/api/me` `billingRead: false`.

**Full suite: 2263 / 2263 passing** (2245 on the base, plus 18).

---

## Choices I made (ambiguous points — the safest reasonable option)

1. **«Read access to the full גבייה tab» = the tab's reads and its two
   exports.** This includes `cleanupReport` («ייצוא רשימת תיקונים»).
   `suggestRefunds` is not included: it belongs to the discharge flow, not
   the tab.
2. **getData is cut to `patients` + `billingOverrides`** with an allow-list
   on both sides. The tab needs the patient rows; it needs no lead and no
   discharge record. (getData_ still heals blank ids, as it does for every
   caller. That is not a user write.)
3. **`confirmed` stores the full amount in `confirmedAmount`.** A receipt
   confirmed before this PR (blank cell) reads as its full amount, so
   nothing changes for it.
4. **Open debt in the tab = partial remainders + «לא שולם» receipts.**
   Receipts still waiting are shown as waiting, not as debt. The shared
   debt engine is not changed (decision: shared rules unchanged).
5. **Partial and the note are one receipt at a time.** A bulk ✓ (שולם) still
   works for many.
6. **The note is refused at 501 characters, never cut.** Cutting would
   silently drop text.
7. **Partial counts as a confirmation for the once-only stamp**
   (`confirmedBy` / `confirmedAt`).
8. **Sandra (approver) may set the dropdown and the note too**, like the
   Phase 4 confirm. Vered still cannot.
9. **SW v39 is unchanged in this PR.** No UI file moves. The live `/sw.js`
   could not be fetched from this environment (proxy 403), so the deployed
   branch's `v39` (after #186) is the reference.

## For Sandra

Nothing to set after the merge. There is no new env var, Script Property or
trigger. The clasp CI deploys Code.gs, and the two new columns write their
own header names on the first decision. Ortal sees no change until PR 2.
