# Leads require a full name and a valid Israeli phone (2026-10-19)

A lead can no longer be created (or have its name / phone changed) without:

- **שם מלא** — at least two words (first + last name);
- **טלפון** — a valid Israeli phone: `normalizePhone` → local `0XXXXXXXXX`, matching `/^0\d{9}$/`. The stored value is the normalized local form.

## Where it is enforced
- **UI (public/app.js):** «ליד חדש» and «עריכת ליד» show Hebrew **inline** errors under the field (`leadRequiredErrors`, `showFieldErrors`; `showModal` gained an opt-in `inlineError` slot and now passes the form to `onSubmit`). Nothing is sent while an error shows.
- **Server (apps-script/Code.gs) — the authority:** `mergeLeads_` runs `leadRequiredViolations_` right after the date guard. A violation refuses the whole `saveAll` before anything is written (`{ ok:false, error:'invalid_lead', message, invalidLeads }`), same shape as `bad_lead_date`. `createLeadFromTherapists_` uses the same two checks (`invalid_name` / `invalid_phone`).

## Existing incomplete leads are not blocked
On an existing lead only a **changed** field is checked (client and server compare with the stored value). An old lead with one name and no phone still saves a stage move, a note or a date. Completing it is allowed; changing it to another invalid value is not.

## Exempt
`source: 'direct_admin'` rows — the phone record of a directly-admitted patient built by the intake form (`buildIntakeLead`), which has its own required-phone check — are not sales leads and are exempt.

## Notes
- 9-digit landlines (`02-6543210`) are refused by the explicit `/^0\d{9}$/` rule.
- `createLeadFromTherapists_` previously accepted 9–10 digits and a 2-character name; ezone-therapists already shows its `invalid_name` / `invalid_phone` refusals.
- Service worker: v71 → **v72** (app.js / style.css changed; live v71 verified).
- Code.gs ships through the clasp CI on merge (no manual paste, no new deployment).

## Tests
`test/lead-name-phone-required.test.js` (13): UI validators, add/edit modals (inline refusal, legacy lead edit), server refusal / pass / legacy / exemption / whole-save refusal, therapists path. Fixtures in 5 older suites now use valid leads.
