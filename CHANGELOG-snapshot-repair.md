# Snapshot-based auto-repair for corrupted rows (tiers 1–3)

## Why

PR #105 shipped the corrupted-rows cleanup (`scanCorruptedRowsNow` →
`writeRepairPlanNow` → `applyCorruptedRowRepairsNow` with the hidden,
approval-gated RepairPlan sheet). The live scan then found ~100+ U+FFFD cells
across Patients and Leads — and almost all classified `no source — manual`,
because in-spreadsheet cross-references (clean twins, lead rows, phone
matches) are scarce. Manually retyping 100+ Hebrew values is not acceptable.

The key fact this change exploits: the corrupting bug (server.js UTF-8
chunk-split, PR #49) went live **2026-07-27** and was fixed **2026-08-31**
(PR #102). Rows created before 7/27 were **written clean** and corrupted later
by full-house rewrites — their clean values still exist in a pre-bug copy of
the spreadsheet. Sandra creates that copy manually (File → Version history →
pick a pre-7/27 version → **Make a copy**) and names it **`EZONE-SNAPSHOT`**.

## What changed

`writeRepairPlanNow` (and the shared scan engine behind
`scanCorruptedRowsNow`) now auto-fills `newValue` through tiered proposals.
The first tier that produces a proposal wins; everything still lands in
RepairPlan as `approved=FALSE`, and `applyCorruptedRowRepairsNow` is
**unchanged** (same drift guards, tombstone-first deletes, audit logging).

### Tier 0 — in-spreadsheet cross-references (PR #105, unchanged)

`repair from twin` / `repair from lead` / `repair from phone match`, exactly
as before.

### Tier 1 — snapshot repair (`repair from snapshot`) — the workhorse

- **Discovery**: every Drive spreadsheet whose name **starts with**
  `EZONE-SNAPSHOT` (so `EZONE-SNAPSHOT-JULY` etc. also count), found via
  `DriveApp.searchFiles` (fallback `getFilesByName`), opened with
  `SpreadsheetApp.openById`. **Read-only — snapshots are never written.**
  Priority order is oldest-modified first (newest last): an older copy is the
  more likely to pre-date the corruption. The live spreadsheet itself is
  excluded.
- **Row matching**:
  - Patients family (Patients / DischargedPatients / PatientsTombstones): by
    `fromLead` when non-empty, else by `houseId + entryDate + pay`. The live
    row's own sheet is searched first, then the other family sheets (a
    discharged row may have been an active patient at snapshot time).
    **2+ candidates → ambiguous → no proposal**, with the reason logged and
    recorded on the finding.
  - Leads family: by lead `id`, own sheet first then the sibling sheets (the
    lead may have moved since the snapshot).
  - Payments: skipped (`patientId` is session-local per the PR #105
    findings) — the roster tier covers `patientName` instead.
- **Column mapping** follows the snapshot's **own header row**, so a snapshot
  with fewer (pre-append) columns still repairs the columns it has — safe
  because every schema is append-only.
- **Scope**: ALL scanned text columns, notes/free text included (a free win —
  row identity, not value shape, carries the confidence).
- **Sanity guard**: the snapshot value must be *compatible* with the
  corrupted one — the corrupted cell's surviving character segments must
  appear in order in the proposal, each U+FFFD run standing for 1+
  characters, anchored at both ends. A clean-but-incompatible value means the
  live cell was edited after the snapshot: the cell is classified
  **`snapshot mismatch — manual`** and the weaker tiers do NOT get a turn.

### Tier 2 — closed-set repair (`repair from enum`)

For closed-value columns only — `house`, `source`, `assignedTo`,
`meetingWith`, `meetingReporter` (Leads family), `manager_name` (Managers),
`house_of_origin` (Outpatients). Legal sets are seeded from the in-code
constants (`MANAGER_HOUSE_NAMES`, `HOUSE_MANAGERS`, `MANAGER_PHONES`) and
extended with every clean value observed in those live columns. A corrupted
value whose surviving characters match **exactly one** legal value (same
wildcard rule) is repaired to it; zero or 2+ matches stay manual.

### Tier 3 — roster matching (`repair from roster`) + twin-merge

- **Roster**: every clean person name pooled from all sheets' name columns
  (Patients, Leads family, discharged, tombstones, `Payments.patientName`,
  Managers, Outpatients) **and from every snapshot**. A corrupted name-column
  value matching exactly one roster name (wildcard rule; each U+FFFD run must
  consume ≥1 char, so length-incompatible names never match) is repaired.
- **Twin-merge bonus** (`repair from twin-merge`): two Patients rows for the
  same logical entity (same `fromLead`) corrupted in *different* positions —
  when their union reconstructs a full clean string (same length, no
  overlapping corruption, no clean-char conflicts), both rows are proposed
  that string.

Enum and roster **never** touch notes / meetingNote / long-free-text
columns — those repair only from a snapshot or by hand.

### RepairPlan: appended `source` column

`REPAIR_PLAN_COLUMNS` gained `source` **at the end** (append-only contract;
the pinned-order guard test was updated). It records the proposing tier plus
provenance, e.g. `repair from snapshot — EZONE-SNAPSHOT Patients row 12`, so
Sandra can judge each proposal while reviewing. Informational only — apply
never reads it. Existing RepairPlan sheets get the header backfilled
non-destructively by `getOrCreateSheet_`.

### Logging

Both `scanCorruptedRowsNow` and `writeRepairPlanNow` now state clearly which
snapshots were used (in priority order) — or that **no snapshot was found**
(with the how-to-create-one instruction), in which case tiers 2–3 still run.
The scan summary includes a per-tier proposal breakdown, and each finding's
log line carries the why (`ambiguous`, `2 roster names match`, …) when a
tier declined to propose.

## Security / safety posture

- Snapshots are opened read-only and never written — guard-tested.
- No new HTTP surface: all helpers are `_`-suffixed (private); the three
  entry points remain Run-dropdown-only and are still absent from `handle_`'s
  allow-list (existing guard test still passes).
- Nothing is auto-applied: every proposal lands as `approved=FALSE`; the
  apply step's re-verify-oldValue drift guard, tombstone-first deletes, and
  audit logging are byte-for-byte unchanged.
- Ambiguity anywhere (2+ row candidates, 2+ enum/roster matches) always
  degrades to manual — the machine never guesses.

## Tests

`test/snapshot-repair.test.js` (new, 18 tests, vm-sandbox on the real shipped
`Code.gs` per repo convention, with a `DriveApp` stub): wildcard/compatibility
rule; snapshot match by `fromLead` incl. notes free-win and the RepairPlan
`source` column; lead-id matching; fromLead ambiguity → no proposal;
houseId+entryDate+pay fallback (unique vs ambiguous); column-position
tolerance (snapshot with fewer columns); compatibility guard →
`snapshot mismatch — manual` with weaker tiers suppressed; snapshot priority
order (oldest first) with a corrupted newer snapshot skipped; enum
exactly-one (constants and derived-from-clean-rows), enum 2+ → manual, enum
never touches free text; roster exactly-one across sheets + snapshots with
length-compatibility; Payments.patientName roster repair and 2+ → manual;
twin-merge reconstruction and refusal cases; snapshot-beats-enum priority;
no-snapshot logging with tiers 2–3 still running; end-to-end
plan-write → approve → apply on the 8-column plan with snapshots untouched
throughout.

`test/corrupted-rows-cleanup.test.js`: pinned column-order guard updated for
the appended `source` column; all other PR #105 contracts pass unchanged.

Full suite: **772 tests, all green** (`node --test`).

## Operating instructions (Sandra)

1. In the live spreadsheet: **File → Version history → See version history**,
   pick a version dated **before 2026-07-27**, choose **Make a copy**, and
   name the copy exactly `EZONE-SNAPSHOT` (any `EZONE-SNAPSHOT…` prefix
   works).
2. Run `scanCorruptedRowsNow` from the Apps Script Run dropdown — the log
   shows, per corrupted cell, exactly what the plan-writer will propose and
   from which tier.
3. Run `writeRepairPlanNow`, review the hidden RepairPlan sheet (the new
   `source` column says where each `newValue` came from), fill any remaining
   blank `newValue`s, flip `approved` to TRUE per row.
4. Run `applyCorruptedRowRepairsNow`.

Deployment is automatic via clasp CI on merge to the deploy branch — no
manual Apps Script steps beyond the Run-dropdown functions above.
