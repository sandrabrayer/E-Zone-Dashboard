# Changelog — committee date per patient «ועדה» (Apps Script) — 2026-10-15

## Why
House managers need to record a committee («ועדה») date for each patient. The Managers app shows
it and alerts on it (paired ezone-managers PR). The Dashboard card and the coordinators alert
follow in their own PRs.

## What
- **New op** `managersWork` `committeeSet` `{ house, patientName, entryDate, committeeDate, label,
  previousDate, previousLabel, correction, mode }`:
  - `mode` = `set` (default) | `clear`;
  - `label` is optional free text, at most **60** characters (e.g. the type of committee). It is
    cleaned: control characters, formula lead-ins and angle brackets are stripped.
- **New APPEND-ONLY sheet** `ManagersCommittee`. Columns: `id, house, patientName, entryDate,
  committeeDate, label, previousDate, previousLabel, editedAt, editedBy, editedById, state,
  pastCorrection`.
  - Key = Managers house + patient + admission date: one CURRENT date per stay (the last row
    wins).
  - A clear is a `cleared` row. Nothing is deleted; history stays in the rows.
  - Created on the first write; a read never creates it. Written as text cells.
- **Optimistic concurrency**: the date AND the label the screen showed. Either one stale →
  `conflict` + the current value. The same value → `unchanged`, no row.
- **Dates**:
  - strict `yyyy-MM-dd`, not before admission, at most 2 years ahead;
  - "today" is the calendar day in **Asia/Jerusalem** (`committeeToday_`); today or later is
    fine;
  - a **past date is refused** (`past_date`) unless it corrects an existing committee date
    (`correction: true` and a current value). Then it is stored with `pastCorrection = 1` and the
    answer carries `warning: 'past_date'`.
- **Authorization**: the same as `dischargeSet`:
  - the fail-closed `MANAGERS_WORK_SECRET`;
  - house / role / actor from the Managers server (a manager is pinned to their own house);
  - the patient must be in that house today with that admission date;
  - a stable actor id is required.
- **`houseData`**: `patients[].committee` = `{ date, label, editedAt, editedBy } | null`, plus
  `committeeSupported: true` and `committeeToday`.
- A busy lock → `lock_busy` (`tryLock(5000)`). No logging of names.
- Display-only: no bonus or occupancy figure reads it. Tested.

## Conservative readings
- "Committee" = any committee the house manager records for a patient (placement, continuation,
  treatment). The kind goes in the free-text label. No fixed list.
- "Past date allowed only when editing to correct": a past date needs BOTH an existing current
  date and the explicit `correction` flag. A brand-new committee date in the past is refused.

## Tests
`test/managers-committee.test.js` (+11, suite 2923 → 2934):
- the header pin;
- fail-closed;
- set / change / clear / re-set;
- concurrency on date and label;
- today / past / correction with a warning;
- validation (formats, 60-char label, cleaning);
- house authorization;
- Israel today;
- `lock_busy`;
- bonus unchanged.

## Deploy
- Code.gs deploys automatically on merge.
- No new Script Property, Railway variable or secret. The sheet is created by the first save.
- Merge BEFORE the Managers PR. Until then Managers hides the committee line (no
  `committeeSupported`).
