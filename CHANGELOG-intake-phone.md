# Intake captures the patient's phone — the phone starts here and follows the patient (2026-10-18)

Root cause of the «28 patients without a phone»: «קליטת מטופל חדש» / «הוספת מטופל ישירות» created a patient with no phone and no lead link.

- **«קליטת מטופל חדש»:** new required field «טלפון המטופל» (valid Israeli number). **«הוספת מטופל ישירות»** (historical): phone optional, but validated when typed.
- A patient has no phone column, so the phone is kept where every feed already reads it: a **linked lead row** (`Patients.fromLead → Leads.phone`), created with the patient in the same proven `saveAll`: `stage: 'admitted'` (never on the board), `source: 'direct_admin'`, house, today.
- If the board already holds a lead for the SAME person (same phone AND same name) it is reused as the link — no duplicate row. Same phone, different name (family member) → separate row.
- Rollback removes both rows if the save is not proven.
- Flow: Dashboard (or OUT for people never in a house) → therapists app / alumni / OUT matching. Nothing downstream writes a phone back.
- Existing patients: PRs #247/#248 (name fallback + `PatientPhones` backfill).
- Tests: `coordinators-roster-ui.test.js`, `coordinators-roster-browser.test.js`.

## Old patients without a phone — edit form (same day)
✏️ «עריכת מטופל» now has «טלפון המטופל» (pre-filled from the linked lead). Typing a phone for an old patient: updates the linked lead's phone, or links the patient to the same person's existing board lead, or creates a linked `admitted` lead — all in the same proven `saveAll` (verified against the real Code.gs: the patient row is kept, `fromLead` is set). A house move and a NEW link in one save are refused (the sheet keeps its own link on a move): save the phone first. Rollback undoes the lead change. Backfill alternatives stay: `PatientPhones` tab, same-name fallback.
