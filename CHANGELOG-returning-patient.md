# «מטופל חוזר» — returning patient + clearer «ללא ליד» (2026-10-19)

## The flow (תפוסה)
1. «מטופל חוזר» (next to «+ הוסף מטופל ישירות», edit mode) opens a search by **phone** and/or **full name** over the discharged patients and the closed leads.
2. **Unique match:** the card shows the person's history (previous stays, entry and discharge dates, discharge dispositions and notes, closed-lead dispositions and notes, and for finance only, payments linked **by id**). «המשך — טען פרטים» opens the direct-add form **pre-filled** with the name, phone, house and monthly amount of the latest stay.
3. **Confirm** creates **one new active stay** (a new Patients row) linked to the same person by `personId` (the root patient id of the first stay). No second person is created:
   - the old stay's lead is **not** re-used, since the server's promotion guard would refuse it or overwrite the old stay;
   - no new phone-record lead is created when the typed phone is already a known phone of the person.
4. After the save is proven, the person's open discharge rows get **`restored='TRUE'`** (the same `restorePatientToActive` write every restore uses). The new stay goes into `state.patients`, so «מטופלים» shows it at once.
5. **Zero / several matches, or a phone whose name differs** («conflict»): **fail closed**. Nothing is linked automatically. Candidates are offered for a manual pick, and «הוסף כמטופל חדש» falls back to the normal form.

Exact rules: `docs/returning-patient.md`.

## «היסטוריית שהיות» on the patient card
A closed `<details>` on each «מטופלים» row whose person has other stays or closed leads. Money (payments by id) appears only in a finance session.

## «ללא ליד» is now explicit
- «ללא ליד · נוסף ישירות» for a direct add (`source: 'direct_admin'`);
- «ללא ליד · מטופל חוזר» for a returning stay (`personId`);
- plain «ללא ליד» otherwise.

This applies to both the chip and the «פרטי הליד» section. The summary still counts `no_lead`.

## Data (append-only)
- `PATIENT_COLUMNS` gains **`personId` LAST**. `DISCHARGED_PATIENT_COLUMNS` and the tombstone columns are separate literal lists, so their layouts do not move. The sheet header is extended non-destructively. `scripts/healthcheck.js` mirror updated.
- Server (`replaceHousePatients_`):
  - `personId` is sanitized (`patientPersonId_`);
  - an appended row's `personId` must name an existing Patients id, otherwise it is dropped and audit-logged;
  - once on the sheet it is **immutable** (`keepPersonId_` on id / key / rename / move matches), so an old open tab that does not know the column cannot blank it.
- Client: `normalizePatient` / `serializePatients` carry `personId`.

## Implementation
- `lib/returning-patient.js` (new, pure UMD → `window.ReturningPatient`): `buildPersons`, `findMatches`, `history`, `prefill`. Served like the other lib assets.
- `public/app.js`: `openReturningPatientSearch`, `returningResultsHtml`, `openReturningAdd`, the `returning` option of `openDirectAddPatientModal`, `closeReturningDischarges`, `patientStayHistoryHtml`, `patientNoLeadLabel`.
- Code.gs ships through the clasp CI on merge.
- SW v75 → **v76** (stacked on #254).

## Tests
- `test/returning-patient.test.js` (20): unique / none / multiple / conflict, active excluded, joins, history, prefill, end-to-end add + restored flag + rollback, card history (finance gating), labels, server append / validation / immutability, wiring.
- Schema pins in 7 suites updated for the appended column.
