# Managers feed — the patient's contact person, a worker's end date (16 Nov 2026)

## Why

Sandra, 16 Nov 2026, for the Managers app:

- «תוסיף שדה אחרי מטופלים לשיחות עם בני משפחה שתהיה מתועדת כמו ב-CRM. תיקח את הנתונים מדשבורד, יש שם את כל המידע של איש הקשר»;
- «הנתונים על עובדים שמסיימים צריכים גם להופיע מסטאפינג באפליקציה הזו וזה צריך גם לחשב ולקזז את ההורדה של העובד».

## What

Both through the existing `managersWork` action and its fail-closed `MANAGERS_WORK_SECRET` gate. No new action, Script Property, sheet, column or Railway variable.

### `houseData` — `contact` on every patient, `contactsSupported: true`

- Each patient in the house carries `contact`: `{ name, relation, phone, updatesPhone }` or `null`.
- Source: the lead the patient came from, `Patients.fromLead` → the lead row (`contactName`, `contactRelation`, `contactPhone`, `billingPhone`).
- **By the lead id only.** There is no name fallback: one family's phone can never land on another patient. No linked lead, a lead that no longer exists, or a lead with nothing usable → `null`.
- Cleaned: text through `coordTextClean_` (80 / 40 characters), phones through `rosterValidPhone_` (a value that is not a local phone number is dropped).
- Nothing else of the lead leaves: no patient phone, notes, money or lead id. `fromLead` rides on the in-house row as a NON-enumerable property, so no other caller of `mwInHousePatients_` ships it.
- Scope is unchanged: only the caller's house (`mwCaller_`), decided by the Managers server.
- No extra sheet read: the lead sheets were already read for the visits; the same pass builds the id index.

### `houseStaffCost` — `endDate` on a worker

- A worker's `endDate` (the last day of their placement) passes through when the staffing feed sends a real `YYYY-MM-DD`.
- `pardes` + `hapardes` merge: the key is set only when EVERY merged entry has an end date, and it is the latest one. The unnamed remainder never has one.
- An absent key means «no end date known». Everything else in the reply is unchanged.
- Needs the ezone-staffing PR that adds `endDate` to `getHouseWorkerCostsForManagers`. Without it nothing breaks: the key is simply absent.

### Family calls

- No backend change. The `familyCalls` log (`ManagersFamilyCalls`) never left this backend; the Managers app re-enabled it on 16 Nov 2026.
- `committeeNotes` stays in the backend, unused: the Managers server refuses the write since 16 Nov 2026. The sheet and its rows are kept.

## Security

- The contact is family personal data. It is served only to the manager of the patient's own house and to the admins, behind the work secret, and never logged.
- Fail-closed as before: a missing or wrong secret → `unauthorized`, nothing read.

## Tests

`test/managers-crm-backend.test.js` 10 → 13: the contact (cleaning, id-only join, no leak of lead fields, house scope, the secret gate), the family-calls log for the house, `endDate` (bad value dropped, merge rule). `test/managers-work-tool.test.js`: the patient shape now carries `contact`. Suite 4078 → 4081.

## Deploy

`apps-script/Code.gs` changed → the Apps Script deploy runs automatically on merge. No manual step.
