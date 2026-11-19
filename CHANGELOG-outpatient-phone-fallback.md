# Outpatient handoff: find the phone in billingPhone / contactPhone too

Sandra, 19/11/2026: a released patient (מיכל גרנט) could not be moved to Outpatient
because «אין טלפון» — the transfer asked her to type one even though the number was
in the system.

## Cause

A patient's phone lives on their linked lead (`fromLead`). The Outpatient handoff
resolved it from the lead's **main `phone`** field only. When the number is stored
in **`billingPhone`** («טלפון לגבייה ועדכונים») or **`contactPhone`** (the contact
person) — common for a lead taken through a parent — the handoff found nothing and
fell back to asking for a manual phone.

Those two fields are already treated as reachable numbers elsewhere: the
house-manager family card (`mwPatientContact_`) shows exactly `contactPhone` +
`billingPhone`, and the transfer form itself says «טלפון של X (או של איש הקשר)».

## Change (Code.gs only)

New `leadBestPhone_(lead, valid)` → the first valid of `phone`, `billingPhone`,
`contactPhone`. Used where a patient's phone is resolved from their **exact** source
lead:

- `dischargeLeadPhone_` — the «העבר לאמבולטורי» send (via `leadHandoffPhone_`,
  mobile or 9-digit landline).
- `buildLeadPhoneIndex_` byId — the discharged / admitted rosters (via
  `rosterValidPhone_`).

The main phone still wins. The fallback applies **only** to the direct `fromLead`
link — never to the name-match fallback — so one person's billing/contact number can
never land on another patient. No column, no new action, no UI change. A patient with
no number in any of the three is still asked to type one, as before.

## Security

Read-only resolution; same validators and same refusal paths. No phone reaches any
log (the handoff logs a digit count only). `npm audit`: 0 high / critical.

## Tests

`test/outpatient-handoff-phone.test.js`: billingPhone → contactPhone fallback, main
phone precedence, landline accepted, junk refused, truly-empty still asked; and the
same fallback through `getDischargedRoster_`. Full suite 4143 green.

## Files

`apps-script/Code.gs`, `test/outpatient-handoff-phone.test.js`.

## Deploy

Apps Script auto-deploys on merge (`Code.gs` changed). No SW bump, no Railway env.
