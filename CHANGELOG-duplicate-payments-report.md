# Duplicate-payment report — `duplicatePaymentsReportNow()` (read-only)

Branch `feat/duplicate-payments-report` off `claude/build-ezone-dashboard-QOg5s`.
**Code.gs only.** The clasp CI deploys it on merge. There is no UI change, no
SW bump, no new column, sheet, Script Property or env var.

## What it is

`duplicatePaymentsReportNow()` is a function you run from the Apps Script
editor (Run menu). It lists the Payments rows that look like the same money
recorded twice. The result goes into ONE new, private Google Doc titled
"E-Zone דוח תשלומים כפולים YYYY-MM-DD HH:mm", written right-to-left, and the
function logs the Doc URL. It follows the same pattern as
`reconciliationReportNow()` and reuses `recReadSheet_`, `recDocPara_` and
`recDocTable_`.

## The rule (`dupPaymentsFind_`, pure)

A row is checked when all of these are true:

- **It records money.** That means a receipt (`rcpt-…`), or a legacy cycle
  marked `paid` / `partial` that has no receipt linked to it. A cycle that has
  receipts carries their derived total, so comparing it with them would flag
  every report.
- **It is not voided** (status `void` / `מבוטל`).
- **It was created on or after 30/09/2026**, Israel time. The creation time is
  `recordedAt`, falling back to `timestamp` and then `chargedAt`.

Two such rows are a suspected duplicate when all three hold:

1. They share the patient (`patientUid`, else `patientId`) **or** the cycle
   (a receipt's linked cycle id, or a cycle's own id).
2. They have the **same amount**.
3. They have the **same payment date** (`receivedDate`, else `dueDate`)
   **or** were created **within 10 minutes** of each other.

Matching pairs are grouped, so a chain of three rows is one group. Columns:
group, sheet row, patient, house, amount, date, method, reference, receipt id,
created.

## Security

- **The spreadsheet is never written.** The function only uses
  `getSheetByName` and `getValues`. It takes no lock, writes no AuditLog row
  and sets no property.
- **The only write is the Doc itself.** The Doc is not shared or moved; it
  lands in the runner's own My Drive.
- **Not reachable over HTTP.** No `handle_` action names it.

## Tests

`test/duplicate-payments-report.test.js` has 9 tests and runs the real
Code.gs in a vm. It covers:

- the same-date match and the 10-minute window (an 11-minute gap is not
  flagged);
- the shared-`patientUid` case, and a name variant with no shared key, which
  is not grouped;
- the cases that must not be flagged: a different amount, a different patient,
  a voided row (the נועם שני case), and a row created before the cutoff;
- the receipt-versus-cycle exclusion, legacy paid cycles, chains of three, and
  Date-typed cells;
- an end-to-end run against a sheet whose every mutator throws: one Doc, the
  URL logged, nothing written;
- a run when the Payments tab is missing;
- a source scan for writers in the new functions.

## How to run it

In the Apps Script editor, choose `duplicatePaymentsReportNow` → Run. Open
the Execution log and click the Doc URL.
