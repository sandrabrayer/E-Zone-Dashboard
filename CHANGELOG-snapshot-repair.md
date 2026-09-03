# Snapshot-based auto-repair (follow-up to the PR #105 cleanup utilities)

## Why

A live `scanCorruptedRowsNow` run found ~100+ U+FFFD cells across Patients
and Leads, almost all classified `no source — manual` — in-spreadsheet
cross-references (clean twin / lead row / phone match) are scarce. Manual
retyping is not acceptable. Key fact: the corrupting bug (server.js
chunk-split, PR #49) was live 2026-07-27 → 2026-08-31 (fixed PR #102);
rows created BEFORE 7/27 were written clean and corrupted later by
full-house rewrites — their clean values exist in a pre-bug copy of the
spreadsheet. Sandra creates that copy via File → Version history → Make a
copy, named starting with **`EZONE-SNAPSHOT`**.

## The three auto-proposal tiers

`writeRepairPlanNow` / `scanCorruptedRowsNow` now classify each corrupted
cell through a pipeline — first tier that produces a proposal wins.
Priority order: the #105 exact-key tiers (`repair from twin`, `repair from
lead`) → **Tier 1 snapshot** → the #105 phone tier → **Tier 2 enum** →
**Tier 3 roster / twin-merge** → `no source — manual`.

### Shared wildcard-compatibility rule

A candidate is compatible with a corrupted value when the corrupted
value's SURVIVING characters appear in order, anchored at both ends, and
every maximal U+FFFD run stands in for **1+ characters** (run LENGTH is
meaningless — one U+FFFD can replace a multi-byte char and one split char
can produce several U+FFFDs). Implemented as a compiled regex
(`corruptionMatcherFor_` / `corruptionPatternMatches_`), used by the
snapshot sanity guard and as the match rule of tiers 2–3.

### Tier 1 — Snapshot repair (the workhorse)

- `corruptionSnapshots_()` locates snapshot spreadsheets via
  `DriveApp.searchFiles` (title contains, not trashed, spreadsheet MIME),
  keeps only names **starting** with `EZONE-SNAPSHOT`, and sorts
  **oldest-modified first** — newest-modified last in priority (an older
  copy is closer to the pre-corruption state). Opened read-only with
  `SpreadsheetApp.openById`; **snapshots are NEVER written** (only
  `getRange().getValues()` is ever called on them — locked by test).
- Snapshot sheets are read **by schema position**, tolerant of a snapshot
  that pre-dates appended columns (only the first
  min(live, snapshot) columns are mapped; missing trailing columns are
  simply absent).
- Row matching (`snapshotKey` per target):
  - **Patients / PatientsTombstones** (`'patient'`): by `fromLead` when
    non-empty, else by `houseId + entryDate + monthly pay`;
  - **Leads family + discharged** (`'id'`): by the sheet's own id column;
  - **Payments / Managers / Outpatients** (`'none'`): no trustworthy key
    (`Payments.patientId` is session-local per the #105 findings) —
    tiers 2–3 still apply.
  **2+ candidate rows in a snapshot → ambiguous → no snapshot proposal,
  reason logged** (no shopping across snapshots — ambiguous identity is
  never guessed).
- The matched value must be clean; it then passes the compatibility
  guard → `repair from snapshot`. **Incompatible → the cell TERMINATES as
  `snapshot mismatch — manual`** (logged): an incompatible history means
  the match is not this row — weaker tiers must not guess either.
- All text columns participate — notes/meetingNote included (free win).
- Missing snapshot → tier 1 inactive, tiers 2–3 still run, and the log
  states clearly: `NO SNAPSHOT FOUND — …` with the creation instructions.

### Tier 2 — Closed-set (enum) repair

- Enum columns per target (never name/notes/long text): Leads family
  `house, source, meetingWith, assignedTo, meetingReporter`; Managers
  `manager_name`; Outpatients `house_of_origin, therapy_type`.
- Legal values are DERIVED from the clean values observed live + in
  snapshots (the app's authoritative lists live in the frontend; clean
  data is the server-side mirror). A set that exceeds 40 distinct values
  is clearly not closed → the tier is disabled for that column that run
  (logged) — fail-safe manual instead of a guess.
- A corrupted value whose surviving characters match **exactly ONE** legal
  value → `repair from enum`. Zero or 2+ → manual.

### Tier 3 — Roster / twin-merge (name columns only)

- Roster = every clean person name across all live sheets AND snapshots
  (Patients.name, Leads-family name, discharged.name, tombstones.name,
  Payments.patientName, Outpatients.patient_name).
- Exactly ONE roster name matches → `repair from roster`; 0 or 2+ →
  manual. The 1+-chars-per-run rule makes a too-short name unmatchable.
- Bonus — **twin-merge**: two same-`fromLead` Patients rows corrupted in
  DIFFERENT positions; where exactly one side is clean its character
  wins, clean positions must agree, lengths must be equal (run length
  does not track char count, so only position-aligned pairs merge
  safely); a fully clean union → `repair from twin-merge` proposed for
  both rows.

## RepairPlan: appended `source` column

`REPAIR_PLAN_COLUMNS` grew by one column **at the END** (append-only rule;
pinned-order guard test updated):
`sheet | row | column | newValue | action | approved | oldValue | source`
`source` records the winning tier (plus the snapshot's name for tier 1)
so Sandra can weigh each proposal's provenance while approving. Everything
still lands `approved=FALSE`; **`applyCorruptedRowRepairsNow` is byte-for-
byte unchanged** — it re-verifies `oldValue`, tombstones deletes, audit-
logs, and simply ignores the new column (a pre-upgrade 7-column RepairPlan
reads back with `source: ''`).

## Tests

`test/snapshot-repair.test.js` — 11 vm-sandbox tests on the shipped
Code.gs with a fake DriveApp: the wildcard rule (anchoring, 1+ chars per
run, corrupted candidates never match); snapshot match by fromLead (name +
notes) with the plan's `source` column and a snapshots-never-written
assertion; the houseId+entryDate+pay fallback; ambiguity → no proposal +
logged; column-position tolerance (6-column pre-append Leads snapshot);
the compatibility guard terminating as `snapshot mismatch — manual` even
with a compatible roster name available; snapshot priority (oldest first)
+ prefix filtering (a `BACKUP-EZONE-SNAPSHOT` decoy is ignored); enum
exactly-one vs 2+ → manual, with the NO-SNAPSHOT-FOUND log asserted;
roster exactly-one and length rule; roster 2+ → manual; twin-merge
reconstruction + the primitive's refusal cases.

`test/corrupted-rows-cleanup.test.js` — pinned RepairPlan order updated to
include `source`; the plan-writer test now asserts the tier lands in
`source`. All other #105 tests pass unchanged.

Full suite: **765/765 pass** (`node --test`).

## Operating procedure (for Sandra)

1. File → Version history → pick a version dated **before 2026-07-27** →
   Make a copy → name it `EZONE-SNAPSHOT` (more copies allowed, any
   `EZONE-SNAPSHOT…` name; older-modified copies take priority).
2. Run `scanCorruptedRowsNow` — the log now shows which snapshot(s) were
   used and what each tier proposes.
3. Run `writeRepairPlanNow`, review RepairPlan (the new `source` column
   says where each value came from), fill blanks, flip `approved` to TRUE.
4. Run `applyCorruptedRowRepairsNow` (unchanged), verify via re-scan +
   AuditLog.

## Deploy

`apps-script/Code.gs` only — clasp CI deploys on merge to
`claude/build-ezone-dashboard-QOg5s`. Note: the script now calls DriveApp;
if Apps Script prompts for a Drive authorization scope on first manual run
of the scan, approve it once.
