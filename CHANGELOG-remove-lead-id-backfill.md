# removeLead blank-id fix — id backfill on read

Fixes the confirmed **symptom 2** from the write-persistence investigation:
removing a lead didn't stick — it reappeared after reload, while still showing
up in the "removed" tab.

## Root cause (recap)

A Leads row with a **blank `id` cell** makes the client's `normalizeLead` invent
a random `cryptoId()` (`public/app.js:1166`). `removeLead_` then deletes by that
random id (`deleteRowsById_`) — which matches **nothing** on the sheet, so the
delete silently no-ops. The old append-**before**-delete order meanwhile appended
the lead to the removed sheet unconditionally. Net result: a phantom "removed"
row **and** the still-present active row → the lead reappears on reload.

## Fix — id backfill on read, not fuzzy matching

### `apps-script/Code.gs`

- **`backfillMissingIds_(sh, columns)`** (new): heals an id-keyed sheet in place.
  Any row that has content but a blank `id` cell gets a freshly generated
  `id-<Utilities.getUuid()>` written back to **that single cell** (per-row
  single-cell write — never a whole-sheet rewrite), and the cell is text-formatted
  (`@`) so the opaque id can't be coerced. Idempotent (all-ids-present → zero
  writes); fully-empty trailing rows are skipped (`readSheet_` ignores them).
- **`getData_`** calls `backfillMissingIds_` on the **Leads** and **irrelevant-leads**
  sheets **before** reading them, so the ids returned to the client are exactly
  the ones now stored — client and sheet agree on the delete/update key from then
  on.
- **`countRowsById_(sh, columns, idValue)`** (new): read-only count of rows
  matching an id — the peek that opens the sequence below.
- **`deleteRowsById_`** now **returns the number of rows removed** (was `undefined`).
  Backward-compatible — every existing caller ignored the return value.
- **`removeLead_`** now runs the safe **peek → append → delete** sequence, all
  under the script lock:
  1. **Peek first** (`countRowsById_`, read-only): 0 matches → return
     `{ ok: false, error: 'lead_id_not_found' }` and touch **nothing** — no
     phantom "removed" append, no delete. The frontend already rolls back the
     optimistic removal and shows the error toast on any `ok:false`, so **no UI
     change** is needed.
  2. **Append** to the removed sheet — before the delete, so if the append
     throws the active row is still intact (nothing is ever lost).
  3. **Delete** the matched row(s) from Leads (`deleteRowsById_`).

### Which sheets get backfilled — the audit the task asked for

Delete/update-**by-id** call sites (`deleteRowsById_`):

| Sheet | id-keyed op | Backfilled? | Why |
| --- | --- | --- | --- |
| **Leads** | `removeLead_`, `moveLeadIrrelevant_` (delete-by-id) | ✅ yes | primary blank-id exposure — rows can be created/edited outside the dashboard |
| **לידים לא רלוונטיים** (irrelevant) | `restoreLead_` (delete-by-id) | ✅ yes | restore matches by id; a blank-id row would fail to restore |
| **לידים שהוסרו** (removed) | none — terminal, no in-app restore | ❌ no | never a delete/update-by-id target |
| **מטופלים משוחררים** (discharged) | `restorePatientToActive` (upsert-by-id) | ❌ no | rows are only ever written with a client-stamped id (`dischargePatient_`), so there is no blank-id write path; update-by-id, not delete-by-id |
| **Patients** | — | ❌ n/a | `PATIENT_COLUMNS` has **no `id` column** (grouped by `houseId`); nothing to backfill |

Both Leads-side delete paths (`removeLead_`, `moveLeadIrrelevant_`) are healed by
the single Leads backfill, so fixing symptom 2 also hardens the "mark irrelevant"
path against the same class of bug.

## Tests — `test/remove-lead-id-backfill.test.js`

`node:test` + vm-sandbox, fakeSheet + registry harness (mirrors
`billing-override-foundation.test.js`):

- `backfillMissingIds_`: writes an id into a blank-id content row (existing ids
  untouched); **stable** — a second pass fills 0 and keeps the same id; skips a
  fully-empty trailing row; no-ops when every row already has an id.
- `countRowsById_` counts matches without modifying the sheet (read-only).
- `deleteRowsById_` returns the removed count (1 on match, 0 on miss).
- `removeLead_`: matched id → deletes + appends to removed sheet; **appends to
  the removed sheet BEFORE deleting from Leads** (asserted on a cross-sheet
  ops log); **unmatched id → `{ok:false, error:'lead_id_not_found'}`, deletes
  nothing, appends nothing**; `missing_lead` guard unchanged.
- End-to-end: a blank-id lead is unremovable with the client's random id, then
  removes cleanly after the backfill assigns a real id.

Full suite: `npm test` — 360 pass, zero regressions (+11 new).

## Deploy

- `Code.gs` deploys via the clasp CI on merge — no manual Apps Script paste.
- The backfill runs on the **next `getData`** each client makes, so live sheets
  self-heal without a migration step.
