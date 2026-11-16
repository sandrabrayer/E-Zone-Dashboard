# Managers feed — the patient's contact person in `houseData` (16 Nov 2026)

## Why

Sandra, 16 Nov 2026, for the Managers app: «תוסיף שדה אחרי מטופלים לשיחות עם בני משפחה שתהיה מתועדת כמו ב-CRM. תיקח את הנתונים מדשבורד, יש שם את כל המידע של איש הקשר».

## What

Through the existing `managersWork` action and its fail-closed `MANAGERS_WORK_SECRET` gate. No new action, Script Property, sheet, column or Railway variable.

- `houseData`: each patient in the house carries `contact` — `{ name, relation, phone, updatesPhone }` or `null` — and the reply carries `contactsSupported: true`.
- Source: the lead the patient came from, `Patients.fromLead` → the lead row (`contactName`, `contactRelation`, `contactPhone`, `billingPhone`).
- **By the lead id only.** There is no name fallback: one family's phone can never land on another patient. No linked lead, a lead that no longer exists, or a lead with nothing usable → `null`.
- Cleaned: text through `coordTextClean_` (80 / 40 characters), phones through `rosterValidPhone_` (a value that is not a local phone number is dropped).
- Nothing else of the lead leaves: no patient phone, notes, money or lead id. `fromLead` rides on the in-house row as a NON-enumerable property, so no other caller of `mwInHousePatients_` ships it.
- Scope is unchanged: only the caller's house (`mwCaller_`), decided by the Managers server.
- No extra sheet read: the lead sheets were already read for the visits; the same pass builds the id index.

## Family calls and committee notes

- No backend change. The `familyCalls` log (`ManagersFamilyCalls`) never left this backend; the Managers app re-enables it (ezone-managers #72).
- `committeeNotes` stays in the backend, unused: the Managers server refuses the write from #72 on. The sheet and its rows are kept.

## Security

- The contact is family personal data. It is served only to the manager of the patient's own house and to the admins, behind the work secret, and never logged.
- Fail-closed as before: a missing or wrong secret → `unauthorized`, nothing read.

## Tests

`test/managers-crm-backend.test.js` +2: the contact (cleaning, id-only join, no leak of lead fields, house scope, the secret gate) and the non-enumerable lead id. `test/managers-work-tool.test.js`: the patient shape now carries `contact`.

## Deploy

`apps-script/Code.gs` changed → the Apps Script deploy runs automatically on merge. No manual step.
