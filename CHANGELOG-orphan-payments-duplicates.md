# Orphan Payments follow-up: delete confirmed stray twins, re-key date-mismatched rows

Backend-only change (`apps-script/Code.gs`). **Zero UI change**; no change to
`LEAD_COLUMNS`, `PATIENT_COLUMNS`, `PAYMENT_COLUMNS` or
`PATIENT_TOMBSTONE_COLUMNS`. Extends the reconciler shipped in
`CHANGELOG-orphan-payments-reconcile.md` (PR #118). clasp CI redeploys the
Apps Script on merge to the deploy branch (`claude/build-ezone-dashboard-QOg5s`).

## Context

`reconcileOrphanPaymentsNow` was run on production. Two skip categories were
left over, because PR #118 deliberately refused to touch them:

1. `canonical payment id already exists — duplicate row` (4 rows: Payments
   rows 26, 30, 62, 72) — the corrupted-name payment row is a stray twin of an
   already-clean payment row for the same patient / due date.
2. `name matched at a different entry date` (1 row: rehab / אביעד חביבאן,
   payment keyed 2026-08-16, the live patient's `date` differs).

## Phase 1 findings (read-only)

- `plan.skipped` entries are `{key, rowNumber?, reason, detail}`; renames are
  `{rowNumber, key, newKey, oldName, newName, cells:[{column, from, to}]}`.
  The collision guard lived inside the rename branch (`idsOnSheet[newId]` →
  skip); the different-date case lived in `matches.length === 1 &&
  !m.sameDate` → skip. Both are replaced here, not duplicated.
- `PAYMENT_COLUMNS` = `id, patientId, patientName, houseId, dueDate, amount,
  status, amountPaid, balance, timestamp`. Payments has **no**
  `updatedAt`/`updatedBy`; `timestamp` is the client's write stamp
  (`savePayment`), i.e. a stamp column, not content.
- Canonical id: `pay::houseId::name::entryDate::dueDate` (app.js
  `paymentId()` over `patientKey()`); the client's `paymentForPatientOnDate`
  finds the row **by id**, and `findPatientForPayment` matches `patientId`
  against `patientKey(p)` first, then house + exact name.
- `status` semantics (app.js `PAYMENT_STATUS_ALIASES`): `שולם`/`paid`,
  `שולם חלקית`/`partial`, `לא שולם`/`unpaid`. `paid`/`partial` rows are
  history (not editable, skipped by the overdue alerts). `amountPaid` and
  `balance` are numeric; `balance` blank means `amount − amountPaid`.
- `orphanPaymentCandidates_` already tagged every candidate with its `source`
  sheet; the planner ignored it. It is now what decides whether a name match
  may supply a rekey date.

## What shipped — same entry points, two new plan buckets

`previewOrphanPaymentsNow` / `reconcileOrphanPaymentsNow` remain the ONLY
entry points (Run dropdown, never routed by `handle_`). Same script lock, same
`orphan_payments_reconciled` audit event.

### A. `duplicates` bucket (replaces the skip "canonical payment id already exists")

When a rename's (or rekey's) target id is already held by another row — on the
sheet, or claimed by a same-key twin renamed earlier in the same run — the
corrupted row and the twin are compared on **every `PAYMENT_COLUMNS` field
except** `ORPHAN_PAYMENT_DUP_IGNORE` = `id, patientId, patientName, timestamp,
updatedAt, updatedBy` (identity + stamps). Comparison (`orphanPaymentFieldKey_`):

| Column | Compared as |
|---|---|
| `amount`, `amountPaid`, `balance` | `Number(v) \|\| 0` (so `'5000'`, `5000`, `5000.0` agree; blank = 0) |
| `dueDate` | `asISODate_` (Date cell / ISO text / `YYYY-MM-DD` agree) |
| `status` | trimmed + the client's alias table (`שולם` = `paid`) |
| everything else (`houseId`, …) | `normalizeNameKey_` (trim, NFC, whitespace) |

- **All equal** → the corrupted row is a stray twin: planned **delete**
  (`{rowNumber, twinRowNumber, key, twinId, values}`; `values` is the full row
  in `PAYMENT_COLUMNS` order). Execution collects the row numbers and calls
  `deleteRow` **bottom-up** (highest row first) **after** every single-cell
  rewrite and the tombstone append, so no planned row number goes stale. The
  deleted values ride in the audit payload (`deletedRows`) — recoverable.
- **Any difference** → stays in `skipped` with reason **`duplicate row differs`**
  and `detail` = `twin row N (id): field "row" vs "twin"; …`. Never deleted,
  never merged.

### B. `rekeys` bucket (replaces the skip "name matched at a different entry date")

When exactly one canonical name matches (exact-normalized or U+FFFD wildcard)
but no candidate carries the payment's entry date:

- the matching **live Patients** rows (source = `Patients`; discharged and
  tombstone rows never count) are collected; if they agree on **exactly one**
  entry date, the payment is **re-keyed** to it: `patientId`, `patientName`,
  `id` rewritten by single-cell `setValue` (same collision guard as renames —
  a target id that already exists goes through the bucket-A rules). `dueDate`
  and every other column are untouched; the id keeps its own `dueDate`
  segment. The log and the audit carry `old key → new key`.
- only a DischargedPatients row / a tombstone matches → **skipped**
  (`… only a discharged / tombstone row, review manually`).
- live rows disagree on the date (a readmission) → **skipped**
  (`… live rows disagree on the date (d1, d2), review manually`).

### C. Logging / audit

- Preview and execute logs gain `rekeys:` (row, old key → new key, columns)
  and `duplicates:` (row deleted / would be deleted, twin row, twin id) lines,
  and the summary line counts renamed / re-keyed / deleted / tombstoned /
  skipped.
- The `orphan_payments_reconciled` audit payload adds `rekeyed`, `deleted`,
  `deletedRows: [{rowNumber, twinRowNumber, values}]`,
  `rekeys: [{rowNumber, from, to}]` and example lines for both buckets.
- **Idempotent**: after a delete the stray row is gone; after a rekey the key
  is live — a second run plans and writes nothing and logs no audit row
  (locked by test).

### Execution order inside `reconcileOrphanPaymentsNow`

1. single-cell rewrites of `renames` + `rekeys` (row numbers as planned);
2. `PatientsTombstones` append;
3. `deleteRow` for `duplicates`, bottom-up.

## Rules worth remembering

- Only a **byte-equivalent** stray twin is ever deleted, and its full row is in
  the AuditLog first. A twin that differs in any content field is reported,
  never touched.
- Reconcile still does **not** re-stamp anything (Payments has no `updatedAt`;
  `timestamp` is left as-is and ignored by the comparison).
- Tombstone reason value is unchanged: `legacy_orphan_payment`.
- Run-dropdown-only; no new HTTP surface.

## Run sequence (Apps Script editor → Run dropdown)

1. `previewOrphanPaymentsNow` → Execution log: `renames`, `rekeys`,
   `duplicates` (each with the twin row), `tombstones`, `skipped`. No writes.
2. Check the `duplicates` lines name rows 26 / 30 / 62 / 72 and the `rekeys`
   line names the אביעד חביבאן payment (`rehab::…::2026-08-16 → …::<current
   date>`). Anything under `skipped` (`duplicate row differs`, discharged-only
   match, disagreeing live dates) stays for manual review.
3. `reconcileOrphanPaymentsNow`.
4. `previewOrphanPaymentsNow` again → expect `0 orphan key(s)` apart from the
   logged skips.
5. Deleted rows are recoverable from the AuditLog row's `deletedRows`.

## Tests (`node --test`, vm-sandbox on the real `Code.gs`, no Jest)

`test/orphan-payments-reconcile.test.js` (28 tests, +7 / 3 rewritten):

- duplicate with identical non-key fields → delete planned, twin never in a
  write bucket; a same-key corrupted twin compares against its renamed sibling;
- duplicate differing in `amount` → skipped `duplicate row differs`, detail
  names `amount 4500 vs 5000` and nothing else;
- the comparison ignores `timestamp`, coerces `'5000'`/`5000.0`, aliases
  `שולם`/`paid`, normalizes whitespace; a status difference is a difference;
- two deletes in one run → executed bottom-up (`[6, 2]`), after the rename's
  cell writes; both rows gone, the survivors keep their own values; the audit
  carries `deletedRows` with the deleted ids/status; second run = 0 writes;
- rekey: name match at another date on a live patient → the three key cells
  (only two written when `patientName` is already canonical), `dueDate` /
  `amount` / `status` untouched, `old → new` in the log and in
  `details.rekeys`; preview writes nothing; second run = 0 writes;
- rekey blocked when the only match is discharged or a tombstone (same-date
  discharged still renames); live rows disagreeing on the date → skipped;
- a rekey whose target id already exists → duplicate rules (equal → delete,
  differing → `duplicate row differs`);
- the delete guard: exactly one `deleteRow(` call site, fed from the
  `duplicates` bucket sorted bottom-up, after the cell writes and the
  tombstone append; no `clearContent` / `deleteRowsById_` / `setValues` on
  Payments; `ORPHAN_PAYMENT_DUP_IGNORE` pinned.

Full suite: 896 pass / 0 fail.

## Security

- No new HTTP surface; both entry points still require editor access.
- Deletes are bounded to rows the plan proved byte-equivalent to an existing
  canonical row, run under the script lock, and are audited with their
  values before the run returns.
