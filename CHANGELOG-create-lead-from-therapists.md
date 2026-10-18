# createLeadFromTherapists — alumnus → new Dashboard lead (2026-10-18)

E-Zone Therapists «בוגרים» can convert an alumnus who wants to return into a lead.

- New Apps Script action `createLeadFromTherapists` (in `OPEN_ACTIONS` + `PROXY_KNOWN_ACTIONS`), gated INSIDE `handle_` by its own **fail-closed** Script Property `CREATE_LEAD_SECRET` (constant-time compare; unset/blank/wrong → `{ok:false,error:'unauthorized'}`, nothing read or written).
- Allow-listed input: `name`, `phone`, `house`, `program`, `by`, `note`, `assignedTo` (only ורד/שירן/יעל, else blank). `id`, `stage` (`new`), `source` (`alumni_therapists`), `created` are set server-side.
- Idempotent: an existing lead with the same normalized phone → `{ok:true,alreadyExists:true,leadId}`, no second row.
- Formula-injection neutralised; control chars stripped; lengths capped; written under the script lock via `upsertRowById_` (text-forced date columns); audit-logged. `LEAD_COLUMNS` untouched (append-only respected).
- Tests: `test/create-lead-from-therapists.test.js`; pinned action lists updated.

Setup: Apps Script → Project Settings → Script Properties → add `CREATE_LEAD_SECRET` (long random value).
