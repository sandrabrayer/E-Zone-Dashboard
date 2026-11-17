# Managers feed — a worker's birth date in `houseStaffCost` (17 Nov 2026)

## Why

Sandra, 17 Nov 2026, on the managers app: «תוסיף תאריכי לידה בפרטי העובד, עכשיו בסטאפינג מוסיפים אז צריך שזה ישאב משם נתונים».

## What

- `managersWork` op `houseStaffCost`: every worker carries `birthDate` — `'YYYY-MM-DD'` or `''`.
- Source: the staffing feed `getHouseWorkerCostsForManagers` (ezone-staffing #138), which reads «תאריך לידה» from the worker's card.
- Cleaned here again: a real calendar date, not in the future and not before 1900. Anything else is `''`.
- `pardes` + `hapardes` merge: one date when the entries agree or only one has it; two different dates → `''`. The unnamed remainder is always `''`.
- With an older staffing deploy the value is `''`. Everything else in the reply is unchanged.

## Security

- Same fail-closed `MANAGERS_WORK_SECRET`; only the caller's house, decided by the Managers server.
- A birth date is personal data: it is served to the worker's own house manager and the admins only, and never logged.
- Nothing else of the staffing contract data arrives or is passed on.
- No new action, Script Property, sheet, column or Railway variable.

## Tests

`test/managers-crm-backend.test.js` +1 (real date only, own house only, merge rule, no leak, the secret gate); two existing shapes updated.

## Deploy

`apps-script/Code.gs` changed → the Apps Script deploy runs automatically on merge. No manual step.
