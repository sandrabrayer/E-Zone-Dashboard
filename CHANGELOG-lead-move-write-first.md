# Lead moves write first — a failed write can never lose a lead

**What:** every path in `apps-script/Code.gs` that moves a lead between sheets
now writes the destination row FIRST, verifies it landed, and only then deletes
the source row. Code.gs only (clasp CI deploys it on merge). No `public/`
change, no SW bump.

Base: `claude/build-ezone-dashboard-QOg5s` at `34e03ab` (after #262, #264).

## The bug

| Path | Before | Risk |
| --- | --- | --- |
| `moveLeadIrrelevant_` (closure → «שימור לידים») | delete from Leads, **then** upsert to the irrelevant sheet | a failed / timed-out second write lost the lead |
| `restoreLead_` (back to «ליד חדש») | delete from the irrelevant sheet, **then** upsert to Leads | same, in the other direction |
| `removeLead_` (→ «לידים שהוסרו») | upsert first, then delete — but never checked the write landed | a write that did not land still deleted the lead |

The other row deletes in the file were checked and already write first:
`deletePatientRow_` (tombstone first) and the orphan-payment reconcile
(tombstones before `deleteRow`). Discharge does not delete. Billing-override
delete is not a move.

## The fix

New `moveRowWriteFirst_(fromSh, fromCols, toSh, toCols, record, fn, actor)`,
called under the script lock each path already takes:

1. `upsertRowById_` on the destination: by id, so a retry updates the same
   row and never adds a second one.
2. Read-back `countRowsById_(destination, id) ≥ 1`.
3. Only then `deleteRowsById_` on the source.

- The write throws, or it returns but nothing landed: the source row is left
  untouched. The call returns `{ ok: false, error: 'move_write_failed' }` and
  writes a console line plus an AuditLog `lead_move_failed` row (id and name
  only). The Dashboard already rolls the card back and shows «סגירת הליד נכשלה»
  / «שחזור הליד נכשל» on any `ok: false`, so there is no UI change.
- A failure after the write (the delete throws) leaves the lead on BOTH sheets,
  never on neither. The retry finishes the move with no duplicate row.
- `removeLead_` keeps its peek-first refusal and its lost-answer replay.

## Tests

`test/lead-move-write-first.test.js` (12 tests, the REAL Code.gs in the vm
sandbox). For each path, closure / restore / remove:

- the write → verify → delete order;
- the destination write throws;
- the destination write silently does not land;
- a failure between the two steps, then a retry: one row, no loss;
- an idempotent retry after a landed move;
- a busy lock writes nothing;
- wiring: no move function calls `deleteRowsById_` directly.

9 of the 12 fail on the parent commit.

## Security

No new endpoint or input. Same LockService lock and same id-keyed writes. The
failure log carries the lead id and name only, as the existing `lead_*` audit
rows do. `npm audit`: 0 high / 0 critical.
