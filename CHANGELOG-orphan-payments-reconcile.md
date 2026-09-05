# Orphan Payments reconcile + hardened `nightlyIntegrityJob`

Backend-only change (`apps-script/Code.gs`). **Zero UI change** — `public/app.js`
is untouched; no change to `LEAD_COLUMNS`, `PATIENT_COLUMNS`,
`PAYMENT_COLUMNS` or `PATIENT_TOMBSTONE_COLUMNS`. clasp CI redeploys the Apps
Script on merge to the deploy branch (`claude/build-ezone-dashboard-QOg5s`).

## Symptom

`nightlyIntegrityJob` kept alerting a long list of *"Payments rows with no live
Patients row and no PatientsTombstones row"*. The list was dominated by three
causes, none of which is a real data loss:

1. **U+FFFD spelling left in Payments** — e.g. `אביב שבתא��`, `ט��יה שוחט`. The
   name-repair pipeline (PRs #105/#107/#108) rewrote Patients but never touched
   Payments (its rows have no relocatable identity, so they were classified
   `manual`).
2. **Whitespace drift** — `אורנה  אשכנזי` (double space) vs `אורנה אשכנזי`; the
   checker compared exact strings.
3. **True legacy orphans** — patients deleted / collapsed before the
   PatientsTombstones sheet existed.

## Phase 1 findings (read-only)

- **Payments identity is the triple**, not an opaque id: the checker keys every
  Payments row by its `patientId` cell = `houseId::name::entryDate` (app.js
  `patientKey()`), healed from the deterministic row id
  `pay::houseId::name::entryDate::dueDate` when blank
  (`integrityParsePaymentPatientId_`, mirroring app.js `normalizePayment`).
  Both sides were compared through `patientKey_` = **trim only**, so a double
  space or a U+FFFD in the name segment made the key unmatched.
- **Sheets checked**: Patients (live) and PatientsTombstones (any reason).
  DischargedPatients (`מטופלים משוחררים`) was **not** consulted.
- **`PAYMENT_COLUMNS`** = `id, patientId, patientName, houseId, dueDate, amount,
  status, amountPaid, balance, timestamp` — there is a `patientId` **and** a
  display `patientName`, and the name is ALSO embedded in `id`. The client's
  `paymentForPatientOnDate` looks payments up **by id**, so a rename that left
  the id stale would hide the row from its patient and mint a duplicate on the
  next billing action.
- **Tombstone writer**: `appendPatientTombstones_` maps values **by name** via
  `objectToRow_` into `PATIENT_TOMBSTONE_COLUMNS` (which already has `reason`
  and `savedByAction` columns — reasons in use: `user-delete`,
  `saveAll-omitted-preserved`). `deletePatientRow_` tombstones fail-hard before
  deleting; the checker treats a tombstone with ANY reason as "recorded".
- **Name-repair matcher** (`corruptionWildcardRegex_`, PR #105+): splits the
  corrupted value on runs of U+FFFD and lets each run stand for **1+**
  characters, anchored. Its `corruptionMatchOne_` returns a value only on
  exactly one hit. Reused here in spirit, with a tighter bound (see below).

## What shipped

### A. Shared normalizer — `normalizeNameKey_(s)`

NFC → collapse every internal whitespace run to one space → trim. Used by the
checker (`integrityKey_`) and the reconciler. **Not** used for row identity:
`patientKey_` / the saveAll merge still compare the raw trimmed name, so nothing
about saving or renaming a patient changes.

### B. Reconciler — Run dropdown ONLY

Two public functions (no trailing underscore → visible in the Apps Script
editor's Run dropdown). **Not reachable via `doGet`/`doPost`**: `handle_`'s fixed
action allow-list never names them (guard-tested, same non-exposure argument as
`scanCorruptedRowsNow` / `repairPatientExitDatesNow`).

- `previewOrphanPaymentsNow()` — **zero writes**; logs the exact plan.
- `reconcileOrphanPaymentsNow()` — the same plan, executed under `LockService`.
  **Idempotent**: a second run plans and writes nothing (no cell, no tombstone
  row, no AuditLog row — locked by test).

Detection = the checker's rule on **raw** keys (a payment's triple that matches
no Patients ∪ DischargedPatients ∪ PatientsTombstones key). Raw on purpose: the
hardened checker tolerates whitespace drift, but the drifted cells stay wrong on
the sheet and the client's exact-string `patientKey()` still can't match them —
the reconciler fixes the cells.

Per orphan key, candidates = rows of the **same house** from
Patients ∪ DischargedPatients ∪ PatientsTombstones whose name is **clean** (a
U+FFFD candidate can never be canonical — this also stops a
`legacy_orphan_payment` tombstone carrying an as-is corrupted name from
polluting the pool). Names compare through `normalizeNameKey_`:

| Outcome | Action |
|---|---|
| exact normalized match (whitespace-only drift) **or** U+FFFD-wildcard match → **exactly one** canonical name, with a candidate at the payment's entry date | **Rename** — single-cell writes of `patientId` (new triple), `patientName` (canonical), and `id` when the deterministic id embeds the old name. `amount` / `dueDate` / `status` / `amountPaid` / `balance` / `timestamp` untouched. |
| exactly one canonical name but **no candidate at that entry date** | **Skipped** (logged `name matched at a different entry date — review manually`) — could be an entry-date edit or a readmission; a machine must not pick. |
| a rewritten `id` would **collide** with another row's id (the client already minted the canonical payment for that month) | That row is **skipped untouched** (`duplicate row, review manually`). Never silently merged. |
| **zero** or **2+** canonical names | **Tombstone** — one PatientsTombstones row per orphan key: `houseId`, the payment's name **as-is**, the payment's entry `date`, `droppedAt` = now, `reason` = **`legacy_orphan_payment`**, `savedByAction` = `reconcileOrphanPaymentsNow`, `notes` = why (`no candidate` / `ambiguous: a \| b`) + the payment ids. Existing columns only, mapped by name — **no schema change, nothing reordered**. |

**Nothing is ever deleted.** One `orphan_payments_reconciled` AuditLog event per
run that wrote anything (counts + examples, `stampsRestamped: false`).

**Wildcard rule** (`orphanPaymentNameRegex_`): every clean character is escaped
and matched literally; a run of **N** U+FFFD stands for **1..N** characters,
anchored. This is `corruptionWildcardRegex_`'s run rule with an upper bound —
each lost byte produced ONE replacement character and a character is at least
one byte, so a run can never stand for more characters than its length.
`ט��יה שוחט` matches `טליה שוחט` (two U+FFFD, one lost 2-byte Hebrew char) and
not `טרובביה שוחט`.

### C. Hardened checker — `nightlyIntegrityJob`

- Every key set it builds (live Patients, PatientsTombstones, and now
  DischargedPatients) and every key it looks up (sentinel list, Payments /
  BillingOverrides `patientId`) goes through **`integrityKey_`** =
  `patientKey_` over `normalizeNameKey_(name)`. Whitespace drift alone can no
  longer read as an orphan or a lost row.
- **DischargedPatients rows are "known"** for the orphan sweep (check 2). NOT
  for the sentinel (check 1): discharge is a status flip that keeps the Patients
  row, so a vanished live row is still a loss even when a discharge audit row
  exists for it.
- Payments carrying a **`legacy_orphan_payment`** tombstone are **silent** — a
  tombstone with any reason already clears a key; the reconciler writes the
  tombstone under the payment's own house/name/date so the keys line up
  (locked by test).
- Still strictly **read-only** vs live sheets (the sibling suite's forbidden
  write-primitive scan still passes; the new read is `getSheetByName` only).

## Rules worth remembering

- **Reconcile does NOT re-stamp `updatedAt`** — Payments has no `updatedAt`;
  its `timestamp` is left as-is; the tombstone row carries `droppedAt` and
  `savedByAction`, with `updatedAt`/`updatedBy` blank (not a user edit).
- **Tombstone reason value**: `legacy_orphan_payment`
  (`ORPHAN_PAYMENT_TOMBSTONE_REASON`).
- **Run-dropdown-only**: `previewOrphanPaymentsNow` /
  `reconcileOrphanPaymentsNow` are never routed by `handle_`; no HTTP request
  can trigger them.
- The reconciler rewrites `id` as well as `patientId`/`patientName` because the
  client upserts and looks payments up **by id** — the deterministic id embeds
  the name.

## Run sequence (Apps Script editor → Run dropdown)

1. `previewOrphanPaymentsNow` → **Execution log**: renames / tombstones /
   skipped, with examples. No writes.
2. Read the log. Anything under *skipped* stays for manual review (different
   entry date, or a duplicate row whose canonical id already exists).
3. `reconcileOrphanPaymentsNow` → executes the same plan under the script lock.
4. `previewOrphanPaymentsNow` again → expect `0 orphan key(s)` apart from the
   skipped ones (the second reconcile run would write 0 cells).
5. Next night's `nightlyIntegrityJob` alert should list only the skipped keys
   (if any). The AuditLog sheet has one `orphan_payments_reconciled` row.

## Tests (`node --test`, vm-sandbox on the real `Code.gs`, no Jest)

`test/orphan-payments-reconcile.test.js` (21 tests):

- `normalizeNameKey_`: double space → single, trailing/leading trim, tabs/NBSP,
  NFC (`Å` decomposed → precomposed), blanks.
- Wildcard regex: run of N U+FFFD = 1..N chars, anchored, metacharacters
  escaped, built from the normalized name.
- Plan (pure): `ט��יה שוחט` → `טליה שוחט` renames `patientId` + `patientName`
  + `id`; `אורנה  אשכנזי` → `אורנה אשכנזי`; two candidates → tombstone
  (`ambiguous: …`); wrong house → tombstone (`no candidate`); corrupted with no
  candidate → ONE tombstone per key; clean legacy orphan → tombstone; different
  entry date → skipped; id collision → skipped; blank `patientId` healed from
  the id; unattributable rows ignored.
- Preview: zero writes, no AuditLog sheet.
- Reconcile on fake sheets: only `setValue` ops on `id`/`patientId`/
  `patientName`; every other column and every untouched row byte-identical;
  tombstone row shape + reason; one audit row; **second run = 0 writes and no
  audit row**.
- Checker: `integrityKey_` normalizes the name segment; whitespace drift is not
  an orphan; the `legacy_orphan_payment` tombstone silences; corruption still
  alerts; source-scan: every key set via `integrityKey_`, DischargedPatients
  read as known for the orphan sweep only, still read-only.
- Guards: both entry points public but never dispatchable via `handle_`; the
  reconciler contains no delete/clear/whole-row write; column contracts pinned.

`test/nightly-integrity.test.js`: its helper-extraction list now includes
`normalizeNameKey_`, `integrityKey_`, `integritySplitKey_` (the real
`integrityNormalizeKey_` depends on them). No assertion changed.

## Security

- No new HTTP surface: nothing added to `handle_`; both entry points require
  editor access to the Apps Script project.
- Writes are bounded (single cells of the three identity columns, appended
  tombstone rows), under the script lock, audited, and never destructive.
- No secrets, no external calls, no new sheets beyond the existing
  PatientsTombstones / AuditLog ensure paths.
