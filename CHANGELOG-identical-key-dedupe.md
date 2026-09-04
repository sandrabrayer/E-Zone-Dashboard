# Identical-key patient duplicates — scanner, collapse, and guards

**Live symptom:** the patient אלה פליישר appears THREE times in house
קיסריה עפרוני — identical name, entryDate 2026-06-29, monthly 35,000,
advance 0.

## Root cause (confirmed by code reading, Phase 1)

1. Patients rows have no id column; row identity is
   `patientKey_(houseId, name, entryDate)` = `houseId::name::entryDate`.
2. The server.js UTF-8 chunk-split bug (fixed PR #102) created extra rows for
   the same person under corrupted names (e.g. `�לה פלײשר`, `��לה פלײשר`) —
   different keys, so they coexisted with the clean row.
3. The corruption-repair pipeline (PRs #105/#107/#108) repairs names
   cell-by-cell and had **no key-collision check**. Repairing the corrupted
   twins back to the clean name produced 2–3 rows with the IDENTICAL key.
4. `replaceHousePatients_` indexes sheet rows `byKey` as queues; a payload row
   consumes ONE queued row and every remaining same-key row falls into
   `preservedRows` ("rows the payload did not carry: KEEP them"). The
   duplicates therefore survived every save — immortal through normal use.
5. `findDuplicatePatientIdsNow` groups by `fromLead` only; these rows have
   blank/differing `fromLead`, so the scanner never reported them.
6. `deletePatientRow_` deletes EVERY row matching the key — Vered's ✕ on one
   card would have deleted all three rows at once.

## What changed (`apps-script/Code.gs`)

### A. `findDuplicatePatientKeysNow` — new, read-only (Run dropdown)

Scans the Patients sheet and logs every group of 2+ rows sharing the same
identity key: key, row numbers, fromLead, status, whether the rows are
**byte-identical** (all columns equal under the same date normalization the
saveAll changed-columns diff uses), and which row a collapse would KEEP.
Zero writes. `findDuplicatePatientIdsNow`'s log now points at it so the two
scanners are discoverable together.

### B. `collapseDuplicatePatientKeysNow` — new, writes (Run dropdown)

For each same-key group, keeps exactly one row — the first row (sheet order)
with a non-empty `fromLead`, else the first row — and removes the rest:

- every removed row is tombstoned FIRST via
  `appendPatientTombstones_(rows, 'dedupe-identical-key',
  'collapseDuplicatePatientKeysNow')` — **fail-hard**, the same contract as
  `deletePatientRow_`: if the tombstone write throws, nothing is removed;
- the sheet is rewritten without them (existing write-then-trim pattern);
- one `patient_dedupe_collapsed` audit event per group (key, kept row,
  removed count); groups that are NOT byte-identical are still collapsed but
  the differing columns are named in the audit details — nothing is lost,
  the tombstones hold the full rows;
- runs under `LockService.getScriptLock()`; idempotent (second run: 0).

### C. Key-collision guard in the repair pipeline

- **Plan time** (`scanCorruptedRowsNow` / `writeRepairPlanNow`): for a
  Patients `name`/`date` repair, the post-repair key is computed. If it
  already exists on another Patients row, the repair is NOT proposed:
  - other row has the same houseId + entryDate + status → propose `delete`
    of the corrupted row instead (source `key collision — delete corrupted
    twin`; no repair row is written for it);
  - otherwise → classified `key collision — manual` with no newValue.
- **Apply time** (`applyCorruptedRowRepairsNow`): the same check re-runs
  against the live sheet (which may have changed since the plan was written,
  including by earlier repairs in the same run — e.g. two twin-merge repairs
  converging on the same clean name). A repair whose resulting key already
  exists is skipped with reason `key collision`. **A duplicate key is never
  written.**

### D. `replaceHousePatients_` stops immortalizing exact duplicates

When building `preservedRows`, a leftover sheet row that (a) shares its key
with a row consumed in this save and (b) is byte-identical to that consumed
row's ORIGINAL sheet content is tombstoned (`'dedupe-identical-key'`,
`'replaceHousePatients_'`), audit-logged (`patient_dedupe_collapsed`), and
dropped instead of preserved. If the tombstone write fails, the row is
preserved as before (nothing is destroyed without its recovery copy; an
audit failure never fails the save). Same-key leftovers that DIFFER in any
column keep today's preserve behavior — the utility in B handles them
explicitly. The `preserved` response field semantics are unchanged for
everything else.

## No schema / UI / payload changes

Append-only columns everywhere (no new columns needed — the tombstone and
audit sheets already carry `reason`/`details`). No UI changes, no getData
payload changes, no new HTTP actions (`handle_`'s allow-list is untouched;
guard-tested).

## Sandra's run order (after the merge auto-deploys via clasp CI)

1. **`findDuplicatePatientKeysNow`** (Run dropdown) — dry run. Read the log:
   every duplicate-key group with row numbers, byte-identical flag, and the
   row a collapse would keep. No writes.
2. **`collapseDuplicatePatientKeysNow`** — collapses every group to one row
   (the אלה פליישר triple becomes one). Removed rows land in
   PatientsTombstones (`dedupe-identical-key`); per-group trail in AuditLog.
3. Re-run **`findDuplicatePatientKeysNow`** — should report 0 groups.
4. The repair pipeline (scan → plan → approve → apply) can now be used
   safely: it refuses to mint identical keys at both plan and apply time.

## Tests

`test/identical-key-dedupe.test.js` (12 tests, vm-sandbox on the real
shipped Code.gs): scanner grouping/flags/keep-row/read-only; collapse keep
rules, fail-hard tombstone ordering, audit details with differing columns,
idempotency; collision guard at plan time (delete only for
house+date+status twin, else manual) and apply time (skip, including
twin-merge convergence); saveAll drops byte-identical leftovers and still
preserves differing ones (fail-soft on tombstone failure); dispatch guard
(PR #105 precedent). One existing test in
`test/corrupted-rows-cleanup.test.js` was updated: the exact-twin scenario
now yields a delete-only plan (the old repair+delete pair is precisely what
minted the duplicates). Full suite: **793 passing**.
