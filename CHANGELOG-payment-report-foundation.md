# The strict payment report — foundation (Phase 3, PR 1 of 2)

Plan: `docs/billing-control-plan.md`, Phase 3 and §14.1. Branch
`feat/payment-report-foundation` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` changes in its own commit (the clasp CI deploys it on
merge).

**No user-facing change.** Nothing in `public/`, no service-worker bump, no
new HTTP action, no new env var or Script Property. The one thing a person can
see is a new tab, «חסר גורם מממן», in the «ייצוא רשימת תיקונים» workbook.

This PR adds the **data model and the server rules** for the strict payment
report. It does **not** enforce them on the existing save path. Phase 3 PR 2
wires the «דיווח תשלום» form and turns the rules on.

---

## What Sandra decided (2026-10-04)

Every payment carries:

| Field | Rule |
|---|---|
| `receivedDate` | The day the money actually arrived. DD/MM/YYYY in the UI, `YYYY-MM-DD` stored, Asia/Jerusalem. Not in the future. **Append-only.** |
| `amount` | ₪, greater than 0, at most 2 decimals. On a Payments row this is `amountPaid`. |
| `method` | One of: העברה בנקאית / אשראי / צ'ק / מזומן / ביט / אחר |
| `payer` | Free text, required |
| `coverageStart` / `coverageEnd` | Already existed (#135). Required for new reports. |
| `funder` | One of: פרטי / ביטוח לאומי / משרד הביטחון / מכבי. Taken from the patient's current funder. |
| `reference` | Transaction or cheque number. Required for העברה בנקאית and צ'ק, optional otherwise. |
| `recordedBy` / `recordedAt` | From the verified session. Stamped by the server. |

Ortal's confirmation per payment: `confirmStatus` (reported / confirmed /
flagged), `confirmedBy`, `confirmedAt`, `flagNote`. Written **only** by the
`controller` role (Ortal, Phase 4) or by Sandra (`approver`).

---

## What changed

### 1. `Payments`: eleven columns appended (`apps-script/Code.gs`)

`PAYMENT_COLUMNS` grows from 24 to **35**. The new columns are at the end, so
nothing moves (`readSheet_` reads by position):

| # | Column | Written by |
|---|---|---|
| 25 | `receivedDate` | client (append-only, see below) |
| 26 | `method` | client |
| 27 | `payer` | client |
| 28 | `funder` | client; on the first report with no funder, the server fills it from `currentFunder_` |
| 29 | `reference` | client |
| 30 | `recordedBy` | **server**, from the signed session, once |
| 31 | `recordedAt` | **server**, Israel time with offset, once |
| 32 | `confirmStatus` | `reported` set by the server on the first report; anything else needs controller / approver |
| 33 | `confirmedBy` | **server**, when `confirmStatus` changes |
| 34 | `confirmedAt` | **server**, when `confirmStatus` changes |
| 35 | `flagNote` | controller / approver |

All eleven are in `PAYMENT_TEXT_COLUMNS`, so the whole column is formatted as
plain text (`'@'`). A date-typed cell would drift a day for Israel. A cheque
number such as `000123` would lose its zeros.

**No manual step and no backfill.** `getOrCreateSheet_` adds the header cells
on the first read after deploy. Existing rows stay blank. A blank row reads
exactly as it did before.

**Header-clash guard.** If someone has hand-added a column where a report
column belongs (for example `אמצעי תשלום` in column 25), the guard
`paymentReportHeaderClash_` detects it. `upsertPayment_` then leaves all
eleven cells exactly as stored and logs one warning. Without the guard, the
hand-typed values would be read and validated as `receivedDate`.

### 2. How `savePayment` treats the new columns (`paymentReportFields_`)

`paymentReportFields_` is a pure function, called inside the lock and checked
against the **stored** row:

- **A payload without the new fields changes nothing.** If a key is missing
  (or `null`), the stored value is kept. Today's client never sends these
  fields, so its saves behave exactly as before. The response shape is also
  unchanged: `{ok, payment, created|updated}`.
- **A value equal to the stored one is carried, not re-validated.** A cell
  someone typed by hand into the sheet never blocks an unrelated save.
- **A value that changes a column must be well-formed.** A real date that is
  not in the future, a method or funder from the list, a sane payer, a valid
  reference. Otherwise the save is refused with
  `{ ok:false, error:'validation', message, fields:[{field, code, hebrewMessage}] }`,
  and nothing is written. Missing required fields are **not** refused in this
  PR.
- **`receivedDate` is append-only.**
  - It is set once.
  - A blank or an omitted value never erases it.
  - Re-saves and amount corrections never re-stamp it. Only `chargedAt`
    moves.
  - A deliberate change is allowed and writes **one** AuditLog row,
    `payment_received_date_changed`, with the old date, the new date and the
    actor.
  - The same date in the other notation (`18/09/2026` against `2026-09-18`)
    does not count as a change.
- **`recordedBy` / `recordedAt`** are stamped when the row first gets a
  `receivedDate`, and never again. Any value in the payload is dropped.
- **The confirm fields:**
  - A changed, non-blank `confirmStatus` or `flagNote` from anyone who is not
    controller or approver gets `forbidden_role`. The response body is the
    same as for un-void. It is logged as `[role] forbidden_role user=<id>
    op=confirmPayment`, with no names.
  - A blank value means "not sending". So Vered saving an older copy of a row
    cannot wipe Ortal's decision.
  - Echoing `reported` on a first report is not a decision.
  - `flagged` needs a `flagNote` of 2 to 300 characters.
  - A row with no `receivedDate` cannot be confirmed.
  - Each decision stamps `confirmedBy` and `confirmedAt` and writes an
    AuditLog row `payment_confirm_<status>`.
  - `privileged` is computed in `handle_` from `hasRole_('controller')` or
    `hasRole_('approver')`. It never comes from the payload.
- **`reportIssues`** is for information only. When the saved row has a
  `receivedDate`, the response also lists what the report still lacks
  (`validatePaymentReport_`). Nothing is refused because of it.

### 3. `validatePaymentReport_` and `lib/payment-report-rules.js`

- `validatePaymentReport_(report, ctx)` returns `[{ field, code,
  hebrewMessage }]` in a fixed field order. An empty list means valid.
  `ctx.todayIso` pins "today". Otherwise "today" is today in
  Asia/Jerusalem.
- `lib/payment-report-rules.js` has the same rules as pure functions, plus
  the shared lists (`PAYMENT_METHODS`, `PAYMENT_FUNDERS`,
  `REFERENCE_REQUIRED_METHODS`, `CONFIRM_STATUSES`) and the Hebrew messages.
  The form will use it in PR 2.
- A parity test runs **both** on 40 inputs and requires the same answer for
  every one.

| Code | Hebrew |
|---|---|
| `received_date_missing` / `_invalid` / `_future` | חסר: תאריך קבלת התשלום / תאריך קבלת התשלום לא תקין / …לא יכול להיות בעתיד |
| `amount_missing` / `_invalid` / `_not_positive` | חסר: סכום / סכום לא תקין / הסכום חייב להיות גדול מאפס |
| `method_missing` / `_invalid` | חסר: אמצעי תשלום / אמצעי תשלום לא מוכר |
| `payer_missing` / `_invalid` | חסר: שם משלם / שם משלם לא תקין |
| `coverage_start_missing` / `coverage_end_missing` / `coverage_invalid` / `coverage_reversed` / `coverage_too_long` | (תקופת הכיסוי) |
| `funder_missing` / `_invalid` | חסר: גורם מממן / גורם מממן לא מוכר |
| `reference_missing` / `_invalid` | חסר: מספר אסמכתא (חובה בהעברה בנקאית ובצ'ק) / מספר אסמכתא לא תקין |
| `confirm_status_invalid` / `confirm_without_report` / `flag_note_missing` | server only (the confirm fields) |

### 4. `Funders` tab and `currentFunder_`

- **Columns:** `patientId` (the patient's stable id, `Patients.id`, which is
  also `Payments.patientUid`), `funder`, `effectiveFrom`, `setBy`, `setAt`.
  All five are text-formatted.
- **Append-only:** a change of funder is a new row with a later
  `effectiveFrom`. A row is never edited.
- **`currentFunder_(patientId, asOfIso)`** returns the funder of the row with
  the latest `effectiveFrom` on or before the date. On the same day, the later
  `setAt` wins. A row with an unknown funder or an unreadable date is skipped.
  With no matching row, the answer is **פרטי**. It is read-only (it never
  creates the tab) and fail-soft. `currentFunderFrom_` is the pure core.
- **`appendFunder_(patientId, funder, effectiveFrom, ctx)`** checks the
  input, appends one row under the lock, and writes an AuditLog `funder_set`
  row. **It cannot be reached over HTTP in this PR.** Until a funder UI
  exists, rows are typed into the tab by hand.
- **`setupFundersSheetNow()`** is run from the editor. It creates the tab
  (headers, frozen row, text format) and can be run again safely.

### 5. `debtAging_` and the Ortal digest use `receivedDate`

- **`debtAgingReceivedOn_(raw, fallback)`** dates the money by
  `receivedDate` when the row has one. Otherwise it uses `chargedAt` (the
  old rule). With neither, the date is unknown, as before. Each recorded
  cycle now carries `receivedDateSource` (`receivedDate` / `chargedAt` /
  `''`).
  - *Why:* `chargedAt` is re-stamped whenever `amountPaid` moves. A partial
    payment topped up later was therefore dated to the top-up, so a
    historical as-of date showed the whole cycle as owed.
- **Digest:**
  - «תאריך תשלום» shows `receivedDate` (DD/MM/YYYY) when present, and the due
    date for an older row.
  - «אמצעי» reads the new `method` column first, then the hand-added column
    as before.
  - **Which rows are listed does not change.** It is still "recorded since
    the last digest", by `chargedAt`.
  - The allow-list of fields is the same.

### 6. Cleanup workbook: «חסר גורם מממן»

- **In Code.gs:** a new section `noFunder` lists every patient who is **not
  released** and has **no Funders row at all**. `cleanupReportAction_` reads
  the Funders tab with `getSheetByName` and never creates it. It is not added
  to `recTargets_`, so a Funders tab that does not exist yet is not reported
  as "missing".
- **In `lib/cleanup-xlsx.js`:**
  - New kind `no_funder`, fixed by ורד.
  - New tab «חסר גורם מממן», placed last.
  - `isCleanupResponse` accepts a response **without** `noFunder`, because
    Railway and the clasp CI deploy separately. A `noFunder` that is present
    but not a list is still refused.

---

## Known limitation (by design until PR 2)

One Payments row has **one** `receivedDate`, and it dates the row's whole
`amountPaid`. If a partial payment is topped up later, the top-up is dated to
the first payment. As of a date between the two payments, the debt is
therefore **understated**. Before this PR, `chargedAt` **overstated** it.

Getting both right needs one dated record per payment received (the
`PaymentReports` design in plan §5.1). That decision belongs to PR 2. Until
then, the fixture in the tests documents the behaviour.

---

## Tests

New file `test/payment-report-foundation.test.js`, 28 tests:

- **Columns:**
  - the original 24 do not move, and the eleven are appended and
    text-forced;
  - an existing 24-column sheet is extended in place;
  - the header-clash guard.
- **Rules:** 40 cases, run through Code.gs and lib, compared field by field:
  - each required field missing;
  - bad dates (`2026-02-30`, `30/02/2026`, text, `2026-9-1`) and tomorrow;
  - amount 0, -5, `abc`, 1.234, `1,5`;
  - reference required for העברה and צ'ק, optional for the others;
  - a bad method or funder;
  - the geresh form צ׳ק;
  - a payer that starts like a formula;
  - a coverage period that is reversed or too long.
- **Shared lists and messages:** identical word for word on both sides.
- **Save path:**
  - a legacy payload behaves exactly as before, with the same response keys;
  - an incomplete report is not refused yet;
  - the first report stamps `recordedBy` and `recordedAt`, sets `reported`
    and fills the funder;
  - a blank or omitted `receivedDate` never erases it;
  - a change writes one audit row with old, new and the actor;
  - a bad new value is refused with nothing written;
  - a stored hand-typed value is carried, not re-validated.
- **Confirm:**
  - Vered gets `forbidden_role`, it is logged, and nothing is written;
  - Sandra can confirm and flag (a note is required, each decision audited);
  - the controller role can confirm;
  - a row with no report cannot be confirmed;
  - a stale or blank copy cannot undo a decision;
  - echoing `reported` is allowed.
- **Funders:**
  - history, future rows, same-day ties, bad rows, the default;
  - a read never creates the tab;
  - `appendFunder_` only appends, audits, refuses bad input, and is not in
    `handle_`.
- **`debtAging_`:**
  - partial then top-up: at a historical as-of date it no longer overstates;
  - the money is still owed before `receivedDate`;
  - older rows give an identical result whether the key is absent or blank.
- **Digest:** shows `receivedDate` and method; the allow-list is unchanged;
  rows are still selected by `chargedAt`.
- **Cleanup:**
  - the `noFunder` section;
  - the new workbook tab;
  - an older Code.gs response still renders.
- **Scope:**
  - no new HTTP action or role-list entry;
  - the accounting feed does not leak any new column.

Existing column pins were updated to list the appended columns, with the
original positions unchanged: `accounting-source-feed`, `detached-payments`,
`orphan-payments-reconcile`, `payment-coverage-period`. The tab list in
`cleanup-workbook` was updated too.

Full suite: **2003 tests, all passing** (was 1975).
