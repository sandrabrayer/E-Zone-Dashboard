# Weekly automated healthcheck (scheduled live-app probe)

## What

A GitHub Actions workflow that probes the LIVE dashboard every Saturday
evening (Israel time) and fails — which makes GitHub email Sandra — ONLY on
real breakage. Data-quality issues are collected as warnings in the job
summary and never fail the run.

- `scripts/healthcheck.js` — standalone Node script, no dependencies beyond
  built-ins (global fetch, Node 20+).
- `.github/workflows/weekly-healthcheck.yml` — `cron: '0 18 * * 6'`
  (Saturday 18:00 UTC = 20:00 winter / 21:00 summer Israel) plus
  `workflow_dispatch` for manual runs.
- `test/weekly-healthcheck.test.js` — 27 `node --test` tests against injected
  fixtures; the live URL is never touched by tests.

## How it checks (replicates the real frontend flow)

1. `GET /` → expects HTTP 200 + the `E-ZONE Dashboard` marker from
   `public/index.html`.
2. `POST /api/verify-pin` with `{pin}` (the exact login route in `server.js`)
   → expects HTTP 200 + the `ezone_session` HttpOnly session cookie the
   server mints on a correct PIN.
3. `GET /api/sheets?action=getData` riding that cookie (the same path
   `app.js` `loadAll()` uses through the server proxy).

### CRITICAL (any → exit 1 → workflow failure → email)

- App shell down / marker missing.
- PIN login rejected, or 200 without a session cookie (SESSION_SECRET
  fail-closed state).
- getData non-200, an HTML page instead of JSON (the Google Apps Script
  error-page signature — response starting with `<`), unparseable JSON, or
  `ok` ≠ `true`.
- Missing top-level keys — the exact return set of `getData_` in
  `apps-script/Code.gs`: `ok, leads, patients, irrelevantLeads, removedLeads,
  dischargedPatients, billingOverrides, houseManagers, managerPhones`.
- Column presence: a sampled lead must carry every `LEAD_COLUMNS` field and a
  sampled patient every `PATIENT_COLUMNS` field (lists duplicated from
  `apps-script/Code.gs` with a sync test that parses Code.gs so drift fails
  CI). Catches a stale Apps Script deployment missing newly merged fields.
  Empty arrays are skipped with a note, never failed.

### WARNINGS (reported, never fail)

- Blank/missing persisted ids (leads, discharged-patient audit rows — the
  Patients sheet has no id column by design, per the `PATIENT_COLUMNS`
  comment in Code.gs, so active patients are exempt).
- Non-empty date fields (`entryDate`, `visitDate`, patient `date`/`exitDate`,
  `created` date-part) failing anchored `^\d{4}-\d{2}-\d{2}$` — the Sheets
  Date-coercion leak signature.
- Duplicate non-restored discharged-patient audit rows, grouped by `fromLead`
  and by `houseId::name` (restored = `'TRUE'`/`true`, matching the frontend).

## Output & security

- Human-readable summary to stdout; when `GITHUB_STEP_SUMMARY` is set the
  same markdown is appended to the job summary.
- `APP_PIN` and the session-cookie value are never printed. Patient NAMES
  never appear in CI output — offending rows are referenced by id /
  houseId+position only.
- The script fails with a clear, secret-free message if `APP_PIN` is unset.

## Not touched

- `apps-script/Code.gs` is NOT modified — no Apps Script deploy needed.
- The workflow must NEVER be added to branch-protection required checks; it
  probes a live deployment on a schedule and must not gate merges.

## Manual step (one-time)

Add the `APP_PIN` repository secret: repo Settings → Secrets and variables →
Actions → New repository secret → name `APP_PIN`, value = the dashboard login
PIN. Then verify via Actions → Weekly Healthcheck → Run workflow.
