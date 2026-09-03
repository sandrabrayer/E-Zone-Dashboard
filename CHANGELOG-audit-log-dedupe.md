# AuditLog sheet + promotion dedupe guard

## The bug (root-cause finding, Phase 1 investigation)

The Patients sheet contained two rows for the same lead id
`id-tzxpotqwmth4fh15` — names **"הדס"** and **"הדס חלמיש"**, both
`source=lead`, both `entryDate=2026-09-01`, both active.

**Root cause — the Patients sheet has no id column, and no server-side
promotion guard existed.**

1. **Row identity on the Patients sheet is `houseId::name::entryDate`**
   (`patientKey_`). The "id" both rows share is the **`fromLead`** column —
   the source lead's id. `upsertRowById_` is NOT in this path at all: it
   serves the Leads / discharged / payments sheets (which have real `id`
   columns). Patients writes go through `saveAll_` →
   `replaceHousePatients_`, which matches payload rows by the name-keyed
   triple and **appends anything that doesn't match**.
2. **Promotion is 100% client-side.** `promoteEnteredLeads` (public/app.js)
   runs on every load and creates a patient from every stage
   `entry`/`entered` lead — guarded by two Sets built from the promoting
   tab's **in-memory** state only: patients-by-`fromLead` and
   patients-by-`houseId::name` (plus the same two keys against
   dischargedPatients). The server never re-checks either.
3. **The duplicate mechanism.** The lead was promoted once as "הדס". Its
   name was then edited to "הדס חלמיש" — which is what dates the two
   promotions apart (a single race would have produced two identical
   names). A second session whose in-memory state did not contain the
   first patient row (a stale tab / PWA resumed from background, a load
   racing the first save, or a save whose patients-half failed) promoted
   the renamed lead again:
   - the client `fromLead` guard missed — its state had no row carrying
     that `fromLead`;
   - the client name+house guard missed — the name had changed;
   - the server matched by `houseId::name::entryDate`, the name differed →
     **append**. Merge-don't-drop kept the old row (by design), so both
     rows survived.

   A sibling mechanism produces the identical end state with no second
   promotion: editing the *patient's* name via עריכת מטופל changes the
   identity key, so the edit lands as an appended row and the old row is
   preserved — the trade-off documented on `replaceHousePatients_`. Either
   way, the missing invariant is the same: **nothing prevented two
   Patients rows from carrying the same `fromLead`.** (To tell the two
   apart for the live הדס case: if the *Leads* sheet row is now
   "הדס חלמיש", it was a re-promotion; if it still says "הדס", it was a
   patient-name edit.)
4. **Locking is not the gap.** `saveAll_` already holds
   `LockService.getScriptLock()`; the second writer's *state* was stale,
   not its write. (Residual note: `tryLock(10000)`'s return value is
   unchecked repo-wide, so a >10s lock wait proceeds unlocked — unchanged
   here, and now harmless for this bug class because the guard below reads
   the sheet at write time.)

## The fix

### A. Server-side promotion dedupe guard (`replaceHousePatients_`)

A payload row that would be **appended** (no `patientKey_` match) and
carries a non-empty `fromLead` is refused when:

- that `fromLead` already exists on **any** current Patients row — all
  houses, released included (reason `existing_patient_row`), or on a row
  appended earlier in the same save; **or**
- that `fromLead` has a **non-restored** discharged-audit row — the
  discharge-loop guard, mirroring the client's `dischargedByFromLead`
  (reason `discharged_not_restored`). `restored='TRUE'` rows do not block,
  so both restore paths keep re-promoting.

Skips are excluded from the response's `written` counts (the sent-vs-written
diagnostics flag such a save), echoed per house in a new additive
`promoteSkipped` response field, and audit-logged as
`promote_skipped_duplicate`. Because the guard reads the sheet **at write
time inside the existing script lock**, a stale tab can no longer create a
second row for an already-promoted lead — the exact הדס mechanism.

**Documented consequence:** a name/entry-date edit of a *lead-linked*
patient no longer lands as an appended duplicate — the append is refused
(visible in the audit log and response; the existing preserved-rows resync
already reloads such a stale tab). Hand-entered patients (`fromLead` blank)
keep the old rename trade-off unchanged, locked by the existing
merge-don't-drop test.

### B. `AuditLog` sheet (append-only, hidden)

- New hidden sheet `AuditLog`, ensured by the existing
  `getOrCreateSheet_` pattern, hidden via `hideSheet()`; `timestamp` and
  `details` columns whole-column text-forced (same coercion guard as the
  tombstones' `droppedAt`).
- Columns — **APPEND-ONLY contract, same rule as LEAD_COLUMNS, never
  reorder** (guard-tested):
  `timestamp | action | fn | patientId | name | details`
  (`patientId` is the row's `fromLead` lead-id when it has one, else the
  discharge-audit id, else '' — the Patients sheet itself has no id
  column; `details` is a compact JSON string.)
- Single helper `logAudit_(action, fn, patientId, name, details)` —
  **fail-soft by hard contract**: every failure is swallowed; audit
  logging can never break or fail the main operation (locked by test).
- Logged events, one-line calls at every Patients write path:
  - `promote_created` — appended row carrying a `fromLead`
  - `promote_skipped_duplicate` — dedupe-guard skip (both reasons)
  - `patient_added` — appended row with no `fromLead` (direct add)
  - `patient_edited` — key-matched replace whose values actually changed
    (changed column names in `details`; steady-state saves log nothing)
  - `patient_discharged` / `patient_deleted` /
    `patient_restored_to_lead` / `patient_restored_active`
- No UI changes, no getData payload changes — Vered sees nothing new.

### C. `findDuplicatePatientIdsNow` (read-only utility)

Public (no trailing underscore → visible in the editor's Run dropdown;
`handle_`'s action allow-list never routes to it, so it is unreachable
over HTTP — same non-exposure argument as `repairLeadVisitTimes`). Scans
the Patients sheet via `getSheetByName` (never the ensure path) and
`Logger.log`s every `fromLead` appearing on more than one row, with
1-based sheet row numbers, names, statuses and entry dates. **Zero
writes.** Use it to clean the existing הדס duplicate (and any others) by
hand: run it, then delete the surplus row via the dashboard ✕
(deletePatientRow keeps its tombstone recovery copy).

## Tests

`test/audit-log-dedupe.test.js` — 12 tests, vm-sandbox on the real shipped
`Code.gs` per repo convention:

- the הדס scenario: re-promotion under a new name with an existing
  `fromLead` is skipped, echoed, audit-logged
- guard scope: released rows and other houses block; non-restored
  discharged rows block; `restored='TRUE'` does not; same `fromLead`
  twice within one payload dedupes
- normal flows unaffected: key-matched replace, hand-entered append,
  fresh promotion all land (and log)
- `logAudit_` fail-soft: a broken AuditLog sheet never breaks the save
- AuditLog column order pinned (append-only guard test)
- `findDuplicatePatientIdsNow` reports duplicates with row numbers and
  performs zero writes; source-scan proves `handle_` never dispatches it

Full suite: **735/735 pass** (`node --test`).

## Deploy

`apps-script/Code.gs` only — deploys automatically via clasp CI on merge
to `claude/build-ezone-dashboard-QOg5s`. No secrets, no manual Apps
Script steps, no consumer re-pointing.
