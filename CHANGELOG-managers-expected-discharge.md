# Changelog — Managers: expected discharge date per patient (2026-10-15)

## What
- New `managersWork` op **`dischargeSet`** `{ house, patientName, entryDate, expectedDate, previousDate }`
  → `{ ok, expectedDischarge: { date, editedAt, editedBy } }`.
- `managersWork` `houseData` now returns, for every patient in the house, `expectedDischarge`
  (`{ date, editedAt, editedBy }` or `null`) plus a top-level `expectedDischargeSupported: true`
  (the Managers app shows the date picker only when this flag is present).
- New **append-only** sheet `ManagersExpectedDischarge`:
  `id, house, patientName, entryDate, expectedDate, previousDate, editedAt, editedBy, editedById`.

## Why
Sandra, 15 Oct 2026: house managers set and change «שחרור משוער» on the «מטופלים בבית» list.

## How (security)
- Same fail-closed gate as every `managersWork` op: Script Property `MANAGERS_WORK_SECRET`
  (unset / missing / wrong → `unauthorized` before any read). **No new Script Property** —
  the conservative reading of "a Script Properties secret".
- House / role / actor come from the Managers server (manager pinned to their own house,
  admin names one) and are re-validated (`mwCaller_`).
- The patient must be **in that house today with exactly that admission date** → else `not_found`.
- Dates: strict `yyyy-MM-dd` real calendar dates (`bad_date`), `expectedDate ≥ entryDate`
  (`before_admission`), at most 730 days ahead (`too_far`).
- **Audit trail, no silent overwrite**: every set/change appends a NEW row with who (name +
  immutable id), when, and the value it replaced. The caller sends `previousDate` (what it saw);
  if the stored value moved on, the write is refused with `conflict` + the current value.
  Setting the same value is a no-op (`unchanged: true`, no row).
- Cells are written as text (`@`), so dates are never coerced and names are never formulas.
- Key = Managers house + patient name (cleaned, spaces collapsed) + admission date.
- Display-only: no bonus / occupancy figure reads it (tested).
- `capabilities` is unchanged (protocol 2 list pinned by tests).

## Tests
2814 → 2822 (`test/managers-expected-discharge.test.js`, 8 new; `managers-work-tool.test.js`
patient shape updated with `expectedDischarge: null`).
