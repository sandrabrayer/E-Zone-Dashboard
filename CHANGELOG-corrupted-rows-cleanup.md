# Corrupted-rows cleanup utilities (U+FFFD Hebrew-name corruption)

## Background

The server.js UTF-8 chunk-split bug (fixed in PR #102) corrupted Hebrew free
text with U+FFFD replacement characters from 2026-07-27 until the fix, and —
because `name` is part of Patients row identity (`houseId::name::entryDate`)
— the name changes also spawned duplicate rows. A live
`findDuplicatePatientIdsNow` run showed 4 duplicate fromLead pairs across
156 Patients rows; some corrupted rows have clean twins, some pairs are
both-corrupted, and at least one pair (released 2026-01-12 + active
2026-08-15) is a legitimate READMISSION, not a duplicate. Therefore nothing
is auto-deleted or auto-repaired: every change goes through an explicit,
row-by-row approved plan. (The outpatient Clients sheet is a separate
session in ezone-outpatient — out of scope here.)

## Phase 1 findings

1. **Conventions matched.** Manual-repair functions are PUBLIC (no trailing
   underscore → Run dropdown) and unreachable over HTTP: `handle_`
   dispatches only a fixed action allow-list (guard-tested for the new
   functions, same as `findDuplicatePatientIdsNow`). Read-only utilities use
   `getSheetByName`, never the `getOrCreateSheet_` ensure path, so they
   cannot even create a sheet.
2. **Free-text Hebrew scan targets** (stable-key/date/number columns
   excluded):
   - `Patients`: name, notes
   - `Leads`: name, house, source, note, assignedTo, meetingWith,
     meetingCompanion (holds raw free text for non-preset keys),
     meetingNote, meetingReporter, contactName, contactRelation
   - `לידים לא רלוונטיים` (irrelevant): the Leads set + not_relevant_note
   - `לידים שהוסרו` (removed): the Leads set
   - `מטופלים משוחררים` (discharged): name, notes, discharge_note
   - `PatientsTombstones`: name, notes
   - `Payments`: patientName
   - `Managers`: manager_name
   - `Outpatients`: patient_name, house_of_origin, therapy_type, notes
3. **Cross-reference sources for a corrupted name** (priority order):
   (a) a clean same-`fromLead` twin Patients row — per-column;
   (b) the Leads-family row with the same lead id (`Patients.fromLead` /
   `discharged.fromLead` / a leads sheet's own `id` — a corrupted lead can
   never propose itself since its own name fails the clean check);
   (c) a phone match: Leads-family rows carry phone / contactPhone /
   billingPhone; the Patients sheet has NO phone column, so a patient's
   phone is recovered via `fromLead` → `Leads.phone` (the admitted-roster
   precedent). Phones are matched by a LOCAL `corruptionPhoneKey_`:
   `normalizePhone_` (strip non-digits, 972→0) + the Sheets-dropped-leading-
   zero heal (9 digits not starting with 0 → prepend '0'), accepted only on
   a full `/^0\d{9}$/` match. `normalizePhone_` itself (the roster
   contract) is untouched.
   `Payments.patientId` is the client's session-local patient id, NOT a
   lead id — Payments names have no cross-source and classify as manual.

## What shipped (utilities only — zero UI, zero getData changes)

All three functions are public (Run dropdown), NOT wired into `handle_`
(source-scan guard test), and follow the existing manual-repair
conventions.

### `scanCorruptedRowsNow` — dry run, read-only

Scans every target sheet/column for U+FFFD and Logger.logs each hit with
sheet, row number, column, current value, and a PROPOSED action + source:
`repair from twin` / `repair from lead` / `repair from phone match` /
`no source — manual`. Also runs the duplicate-pair analysis on Patients:

- **`delete corrupted twin`** is proposed ONLY for the exact-duplicate
  signature: same fromLead + houseId + entryDate + status, one side
  corrupted and the other clean.
- A pair differing in **entryDate or status** (the readmission pattern) or
  with **both sides corrupted** is flagged **`repair only, keep both`** —
  NEVER a delete proposal. More than 2 rows per fromLead → manual review.

Ends with a summary count. Performs ZERO writes (getSheetByName only).

### `writeRepairPlanNow` — populate the approval gate

Ensures the new hidden **`RepairPlan`** sheet (hidden via `hideSheet()`;
`newValue`/`oldValue`/`approved` whole-column text-forced) and fills it
from the scan with **approved=FALSE** on every row. Columns — APPEND-ONLY
contract, order pinned by a guard test:

`sheet | row | column | newValue | action | approved | oldValue`

(`oldValue` is appended at the END per the append-only rule; it is what
makes the drift guard exact.) `no source — manual` findings are written
with a blank `newValue` for Sandra to fill in by hand. Sandra reviews and
flips `approved` to TRUE per row. Re-running does a full rewrite
(write-then-trim) and RESETS approvals — run once, review, apply.

### `applyCorruptedRowRepairsNow` — approved rows only

Under `LockService.getScriptLock()`. Executes only rows with
approved=TRUE; repairs run before deletes (a delete rewrites the Patients
sheet and shifts row numbers — the drift guard then rightly skips stale
plan rows).

- **repair** — re-verifies the target cell still holds EXACTLY `oldValue`
  AND is still corrupted before writing `newValue` to that single cell.
  Any mismatch (row drift / already repaired), unknown sheet or column, or
  blank/corrupted `newValue` → SKIP + log, nothing touched.
- **delete** — Patients only. The stored row number is only a hint: the
  name cell there must still equal `oldValue`; the row is then deleted BY
  IDENTITY through the existing `deletePatientRow_` flow (peek →
  tombstone reason 'user-delete' written FAIL-HARD before any mutation →
  write-then-trim), so history is preserved and a shifted sheet can never
  delete the wrong row.
- Every applied change is audit-logged via `logAudit_`
  (`corruption_repair` / `corruption_delete`, old→new in details) —
  fail-soft: a broken AuditLog can never break the run. Deletes also carry
  the standard `patient_deleted` entry from `deletePatientRow_`.

## Tests

`test/corrupted-rows-cleanup.test.js` — 11 vm-sandbox tests on the shipped
Code.gs: all four proposal classifications with zero writes; exact-duplicate
delete proposal vs the readmission/both-corrupted keep-both rules (the live
released-2026-01-12 + active-2026-08-15 pair is the fixture); phone-key
normalization incl. the dropped-leading-zero heal; RepairPlan populated
hidden with approved=FALSE; apply skips approved=FALSE, drift-mismatched
cells, blank newValue and unknown sheets; identity-keyed delete writes the
tombstone before the Patients mutation and leaves the clean twin; audit
fail-soft; RepairPlan column order pinned; handle_ dispatch guard.

Full suite: **754/754 pass** (`node --test`).

## Operating procedure (for Sandra, from the Apps Script editor)

1. Run `scanCorruptedRowsNow` → read the log (dry run, nothing written).
2. Run `writeRepairPlanNow` → unhide/open RepairPlan, review each row,
   fill blank `newValue`s, flip `approved` to TRUE on rows to execute.
3. Run `applyCorruptedRowRepairsNow` → check the log + AuditLog trail.
4. Re-run `scanCorruptedRowsNow` / `findDuplicatePatientIdsNow` to verify.

## Deploy

`apps-script/Code.gs` only — deploys automatically via clasp CI on merge to
`claude/build-ezone-dashboard-QOg5s`. No manual Apps Script steps.
