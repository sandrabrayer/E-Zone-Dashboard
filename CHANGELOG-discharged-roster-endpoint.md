# `getDischargedRoster` — alumni feed for the Therapists app (read-only)

## Why
The outpatient restructure adds a read-only «בוגרים» (alumni) follow-up list in the Therapists app.
The Dashboard owns discharge data, so it exposes a minimal read-only feed.

## What (apps-script/Code.gs)
- `getDischargedRoster_()` — patients released within `ALUMNI_WINDOW_DAYS` (730) days, phone recovered via
  `Patients.fromLead → Leads.phone` and normalized (`''` when unlinked — never guessed).
- Explicit allow-list projection, EXACTLY `{ sourceApp, name, phone, house, entryDate, exitDate }`. No id, lead,
  stage, note, payment, advance, refund or discharge reason.
- `alumniSourceAuthOk_` — own Script Property `ALUMNI_SOURCE_SECRET`, constant-time, **fail-closed**.
- `handle_` dispatch behind that gate; the action is added to `OPEN_ACTIONS` and `PROXY_KNOWN_ACTIONS`
  (same model as `getAdmittedRoster`). No write surface.

## Tests
`test/discharged-roster.test.js` (fail-closed matrix, no-leak contract, selection/window, wiring + read-only);
pinned open-action lists updated in `open-actions-gate`, `billing-control-tab`, `payment-report-form` tests.
Full suite 3005 pass; `npm audit` 0 high/critical (1 moderate `qs`, pre-existing, not in the changed code).

## Manual step
Set Script Property `ALUMNI_SOURCE_SECRET` (32+ random chars) — see DEPLOY.md.
