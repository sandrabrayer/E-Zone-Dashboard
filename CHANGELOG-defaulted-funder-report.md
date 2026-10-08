# Payments the old default funder decided — read-only report

Follow-up to #178 (`CHANGELOG-patient-funder-on-funders.md`). Branch
`claude/defaulted-funder-report` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` deploys through the clasp CI on merge. Do not paste it
by hand. **No `public/` change, no SW bump, no new HTTP action.**

## Why

Before #178, a payment report that named no funder, for a patient with no
`Funders` row, was written as «פרטי» by the server's default. The report
form also pre-selected «פרטי», so a receipt could carry it without anyone
choosing. #178 removed both. This PR **finds the rows already written that
way**, so a person decides on each one. Nothing is changed automatically.

## The rule (`defaultedFunderPayments_`, pure)

A Payments row (a cycle row or a receipt) is listed when **all** of these hold:

1. `funder` is exactly «פרטי».
2. It has a readable `receivedDate`. The default only ran on a report, and a
   report always has one; a Date cell is read by its Israel day.
3. It is not void. A voided row has nothing left to fix.
4. Its patient (`patientUid`, else `linkPatientUid`) had **no `Funders` row
   with a recognized label and `effectiveFrom` ≤ `receivedDate`**. This is the
   old `currentFunderFrom_` rule, so the old default is exactly what decided
   the row. A row whose label was unrecognized did not count back then either.
   A payment with no patient id cannot have a Funders row, so it is listed.

The rule can't tell the server default apart from a person who left the
form's pre-selected «פרטי» as it was. Both are listed, because neither was a
decision. A row that really is private is cleared by adding a «פרטי» row in
Funders, dated on or before its received date.

## 1. `defaultedFunderPaymentsReportNow()` — editor-run, dry run

- **Read-only on the spreadsheet.** It opens `Payments` and `Funders` with
  `getSheetByName` (a missing tab reads as empty and is never created) and
  reads them with `getValues`. There is no lock, no AuditLog row and no
  property.
- **Its only write is one new private Google Doc**, «E-Zone תשלומים עם גורם
  מממן ברירת מחדל YYYY-MM-DD HH:mm». It is RTL, not shared and not moved, and
  uses the same writers as `reconciliationReportNow()`.
  - Columns: מזהה תשלום, סוג (מחזור / קבלה), מטופל, בית, תאריך קבלה, סכום,
    תיקון.
  - The amount is the receipt's `amount`; for a cycle row, `amountPaid`, or
    `amount` when nothing was paid.
- **Logger:** the URL, the row count, the receipt count and the total. **No
  patient names (no PII in logs).**
- It is public (in the Run dropdown) and **not reachable over HTTP**:
  `handle_` never names it.

## 2. The cleanup workbook

- A new section `defaultedFunder` in `cleanupReport_`, built from the same
  rows (cycles and receipts).
- A new tab **«גורם מממן ברירת מחדל»**, titled **«תשלומים שקיבלו גורם מממן
  ברירת מחדל»**. Excel caps sheet names at 31 characters, so the full phrase
  is the title row.
- Columns: מזהה תשלום, סוג, תאריך קבלה, סכום.
- Who fixes it: **Vered**.
- **How to fix, by row type:**
  1. Set the funder in גבייה ← «השלמת גורם מממן» (from the entry date).
  2. Then:
     - **Cycle row** → correct the payment's funder with `updatePayment`.
     - **Receipt (`rcpt-…`)** → it **cannot** be edited (`receipt_immutable`
       since #176). Void it («ביטול קבלה») and report it again with the
       right funder.

  The spec said "updatePayment" for every row. The server refuses that for
  receipts, so the text names the path that actually works.
- `defaultedFunder` is optional in `isCleanupResponse`, so a Railway deploy
  that runs ahead of Code.gs shows an empty tab instead of failing.

## Also

- `test/patient-funder-on-funders.test.js` pinned `CACHE_VERSION = 'v32'`
  exactly. It now requires ≥ v32 and still checks the `v31 → v32:` entry.
  Open PR #177 can move to v33 without touching #178's tests (checked by
  running the suite with a simulated v33).

## Tests

`test/defaulted-funder-report.test.js` (8 tests). Its fixture has **11
Payments rows; 4 are caught**:

| Caught | Not caught |
|---|---|
| `c-1` cycle, no Funders row | `c-3`: a real «פרטי» row covers its date |
| `c-9` no patient id at all | `c-4`: «מכבי» |
| `c-7` only row has an unrecognized label | `rcpt-5`: void |
| `rcpt-2` receipt; its row starts after the received date | `c-6`: no `receivedDate` |
| | `c-8`: the linked patient had a row |
| | `c-10`: a row effective on the received day itself, as a Date cell |
| | `c-11`: «פרטית» is not the exact label |

The tests also check:

- the dry run touches nothing: zero sheet attempts, one doc, no names in the log;
- the source of everything the report reaches;
- `handle_` answers `unknown_action`;
- the cleanup section and the workbook tab (title, ≤ 31 characters, fix text by row type).

`test/cleanup-workbook.test.js` gained one defaulted row and the new tab
name. **Mutation check:** four breaks, each caught and then reverted:

1. void rows kept → 6 fail;
2. `<=` made exclusive → 4 fail;
3. unrecognized labels counted → 4 fail;
4. a receipt told to use updatePayment → 1 fail.

Full suite: **2076/2076**.

## Run it

Open the Apps Script editor, choose `defaultedFunderPaymentsReportNow` in
the Run dropdown, and run it. Open the Doc URL from the execution log.

## Brought up to date with the deploy branch (October 8, 2026)

This PR was opened on 5 October. Today the current deploy branch was merged
into it (with a merge commit, so no history was rewritten), and these
conflicts were resolved:

- **Tab order.** The deploy branch had meanwhile shipped the «מטופלי
  פרו-בונו» cleanup tab (CHANGELOG-funder-probono.md). Both tabs are kept.
  Pro-bono shipped first, so «גורם מממן ברירת מחדל» is appended **after**
  it, in `CLEANUP_SECTION_KEYS` and in the `TABS` / `OPTIONAL_SECTION_KEYS`
  lists in `lib/cleanup-xlsx.js`.
- **Ortal's view.** Her cleanup-report field allow-list,
  `CONTROLLER_CLEANUP_SCHEMA` (kept identical in Code.gs and
  `lib/finance-scope.js`), now carries `defaultedFunder` with
  kind / houseId / name / paymentId / receipt / receivedDate / amount / fix.
  It deliberately leaves out `patientUid`.
- **Test fixture.** The fixture now has a pro-bono Funders row from
  15/09/2026, so the defaulted-funder row is the 15/08 payment instead.
- **SW.** No `public/` file changed, so `CACHE_VERSION` stays at the live
  **v48** with no bump.
