# «מטופלים»: «חסר טלפון» + inline «הוסף טלפון», and the «הגדר גורם מממן» fix (2026-10-19)

## «חסר טלפון»
- New problem chip `no_phone` «חסר טלפון» (appended last to `PATIENT_PROBLEMS`, so it is counted in the «בעיות פתוחות» summary, the tab badge and the «בעיות בלבד» filter).
- A patient's phone lives on their lead (`fromLead` → Leads.phone, or the name+house match). The chip shows when there is no lead, the linked lead is gone, or the lead has no valid phone (`intakeLocalPhone`). An **ambiguous** lead match is never flagged (same rule as «ללא ליד»). Released patients have no chips.
- Waiting leads («ממתינים לקליטה») with no valid phone show the same red chip.
- Known gap: phones typed only in the server-side `PatientPhones` book (#248) are not in the dashboard state, so such a patient still shows the chip. Adding the phone here links it properly.

## «הוסף טלפון» (edit mode)
- An inline input under the chip. It validates (10 digits, Israeli: `patientPhoneInput`, the same rule as leads) and stores the normalized `0XXXXXXXXX` form.
- **Patient:** `addPatientPhone` reuses `planPatientPhoneChange`, the plan the ✏️ form already uses. It either updates the linked lead, reuses the same person's lead, or creates an `admitted` / `direct_admin` phone-record lead linked by `fromLead`. All of it goes through the existing per-row upsert (`saveAll` → `mergeLeads_` / patients by id), proven for both the lead and the patient.
- **Waiting lead:** `addLeadPhone` → `updateLead` (already optimistic with rollback).
- Optimistic: the chip disappears at once. A refused or unproven save restores the lead phone, removes the created lead, restores `fromLead`, and shows a Hebrew error.

## «הגדר גורם מממן» bug — root cause
`patientListRowHtml` rendered the «הגדר גורם מממן» button whenever **edit mode** was on (`edit ? '<button …>הגדר גורם מממן</button>' : ''`). The funder value was never consulted, so the button stayed after a funder was set. The cell's text also came from a second code path (`currentFunderFor`), not the one the «ללא גורם מממן» chip uses (`patientFunderKey` / funder.js).

Fix: one helper, `patientFunderState`, built on `patientFunderKey` (the chip's source), drives the cell:
- unset → amber «לא הוגדר» + «הגדר גורם מממן»;
- set → the funder's name + a «✏️ שינוי» edit button (same `openFunderModal`).

## Other
- No Code.gs change.
- SW v73 → **v74** (stacked on #252).
- Tests: `test/patients-phone-funder-fix.test.js` (11). Six older patients-tab suites were updated to expect `no_phone` where their fixture has no lead or phone, and to expect the new funder markup (the old test asserted the buggy button on a set funder).
