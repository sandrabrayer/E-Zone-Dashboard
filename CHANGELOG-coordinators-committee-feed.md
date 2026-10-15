# Changelog — committee feed for the coordinators (read-only) — 2026-10-15

## Why
Sandra (PR 4): the coordinators app alerts the house's רכזת from 2 days before a patient's
committee («ועדה») through the day itself. The dates live in this backend (`ManagersCommittee`,
set by the house managers — CHANGELOG-managers-committee.md). The coordinators need a read-only
view.

## What
- **New action `getCommitteesForCoordinators`** (READ-ONLY: no sheet, cell or lock):
  - called by the coordinators Apps Script directly, server to server;
  - in `OPEN_ACTIONS` (no Dashboard session), gated INSIDE `handle_` by its own Script Property
    **`COORDINATORS_COMMITTEES_SECRET`**;
  - the secret is constant-time compared and **fail-closed**: unset, missing or wrong →
    `{ok:false, error:'unauthorized'}`, nothing read;
  - it is separate from every other secret, so `COORDINATORS_PATIENTS_SECRET` and
    `MANAGERS_WORK_SECRET` unlock nothing here.
- **Answer**: `{ ok, today, committees: [{ id, name, house, date, label }] }`, with exactly those
  keys:
  - `id` = the patient's Patients id (the one the coordinators' roster feed uses), or `''` when
    it is not uniquely resolvable;
  - `name` = the name exactly as the roster feed shows it (already shown to coordinators);
  - `house` = the canonical coordinators id.
- **Data minimisation**: only patients in the house today whose current committee is today …
  +3 (Israel time; the alert window is 2 days, plus one spare day across midnight). No phone,
  money, notes, admission date or who-set-it.

## Tests
`test/coordinators-committee-feed.test.js` (+5): fail-closed (unset / missing / wrong / another
app's secret), the exact contract, the window, past and cleared not sent, an ambiguous id → `''`,
gate wiring, read-only, no logging. The `OPEN_ACTIONS` pins were updated in
`open-actions-gate`, `billing-control-tab` and `payment-report-form`. **2954 → 2959**.

## Deploy — manual step (Sandra)
- Code.gs deploys automatically on merge.
- Then set the Script Property **`COORDINATORS_COMMITTEES_SECRET`** (Dashboard Apps Script →
  Project Settings → Script Properties) to a new random value of 32+ characters.
- Set the SAME value as `DASHBOARD_COMMITTEES_SECRET` on the coordinators Apps Script (see the
  coordinators PR).
- Until both are set, the coordinators show the amber «לא סונכרן» notice and no alerts.
- No Railway variable.
