# PatientPhones — manual phone book for house patients (2026-10-18)

House patients have no phone column (the phone comes from their lead). Those with no lead link / no phone on the lead could not be matched to OUT or the alumni list.

- New sheet **`PatientPhones`** (`name, house, phone, note, patientId`) — created automatically. Nothing but people typing in it touches it (`saveAll` never reads/writes it), so a typed phone can't be wiped.
- `getAdmittedRoster` appends one blank `(name, house)` row per admitted patient still without a phone (idempotent, short try-lock, fail-soft) — the to-do list. A person fills in `phone`.
- Phone resolution order (both rosters): lead-link phone → PatientPhones by `patientId` → PatientPhones by exact name (unique phone) → unique same-name lead phone (PR #247). Ambiguous → blank.
- A 9-digit phone starting with 5 (leading zero lost) is restored to 0XXXXXXXXX — also for lead phones.
- Phone column is text-forced. No existing sheet/column changed. Feed projections unchanged.
- Tests: `test/patient-phones-sheet.test.js`.
