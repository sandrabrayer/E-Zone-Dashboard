# CHANGELOG — Nightly data-integrity job (detection + backup)

## Summary
A time-driven nightly job (`nightlyIntegrityJob`, ~2:30 AM Asia/Jerusalem —
offset from the outpatient app's 2:00 job to stagger load) that DETECTS
silent patient-row loss and keeps a daily off-spreadsheet backup of Patients
AND Leads — the second layer of defense after the merge-don't-drop guard
(CHANGELOG-patients-merge-dont-drop.md), independent of any save path. One
Hebrew alert email per run, ONLY when something is wrong. Mirror of the
outpatient app's job, adapted to this app's data model.

## Problem
Merge-don't-drop closed the stale-tab clobber channel, but nothing watches
the Patients sheet itself, and nothing backs it up outside Sheets version
history. A row lost through any yet-unknown path would surface only when its
orphaned Payments rows confuse גבייה — or never.

## Data-model adaptations (vs the outpatient job)
- Patients rows have NO id column — identity is the triple key
  `houseId::name::entryDate` (`patientKey_`, reused, not duplicated).
- Recorded removals live in the `PatientsTombstones` sheet; a tombstone with
  ANY reason (`user-delete` or `saveAll-omitted-preserved`) clears a
  disappearance. Verified in code: discharge is a status flip
  (`dischargePatient_` is append-only to the discharged audit sheet — the
  Patients row stays), and a client-side rename appends a new-key row while
  the merge KEEPS the old one, so `deletePatientRow_` — which tombstones
  fail-hard BEFORE deleting — is the ONLY legitimate row removal. No other
  whitelist exists.
- The orphan sweep covers this app's `Payments` AND `BillingOverrides`
  sheets, both keyed by `patientId` = the same triple key (built by
  `patientKey()` in app.js); a blank `patientId` cell is healed from the
  deterministic row id (`pay::…`/`ovr::…`), mirroring app.js
  `normalizePayment` / `normalizeBillingOverride`.
- The previous-run roster is stored as the FULL key list, CHUNKED across
  Script Properties (`INTEGRITY_LAST_PATIENT_KEYS_CHUNKS` +
  `INTEGRITY_LAST_PATIENT_KEYS_0..N-1`, 3000 chars per chunk): measured
  live, the list is already ~6.6KB UTF-8 at 144 rows and grows monotonically
  (released rows never leave the sheet), so a single property would cross
  the ~9KB per-value limit. Keeping the full list (vs count+hash) lets the
  alert name each missing patient directly from the key itself.

## Changes
- apps-script/Code.gs — new `/* ===== Nightly integrity job ===== */`
  section, appended at the end. `PATIENT_COLUMNS` and all existing code
  untouched; no new doGet/doPost actions — the job is trigger-driven only,
  so nothing HTTP-facing changes for any of the three consumer apps.
  - `nightlyIntegrityJob()` — READ-ONLY vs the live Patients / Leads /
    Payments / BillingOverrides / PatientsTombstones sheets (all live reads
    via `getSheetByName`, never `getOrCreateSheet_`, so not even a header
    backfill; locked by a source-scan test). Three checks in a FIXED order,
    each in its own try/catch so one failure never silences the rest;
    internal errors join the alert:
    1. **Patient-roster sentinel** — previous run's key list (chunked
       properties) vs live keys; every key gone WITHOUT a PatientsTombstones
       entry goes into the alert as house — name — entry date (the date
       segment disambiguates duplicate names). A missing/corrupt baseline →
       the diff is SKIPPED (never treated as "everything vanished"). State
       persists at end of run, only off a successful Patients read. Runs
       BEFORE check 3 so a same-day snapshot overwrite can never mask what
       yesterday's backup still holds (ordering locked by test).
    2. **Orphan sweep** — every unique patient key across Payments and
       BillingOverrides must match a live Patients row or a tombstone;
       unmatched → alert, per-sheet sections.
    3. **Daily snapshot** — values-only copies of the Patients and Leads
       grids (Leads covers the lead-resurrection blind spot for cheap) into
       the SAME `EZONE-Backups` spreadsheet the outpatient job owns: stored
       `INTEGRITY_BACKUP_SSID` first, then DriveApp lookup BY NAME
       (persisting the found id), `SpreadsheetApp.create` only if truly
       absent — never forking a second backups file. Sheets named
       `dashboard-patients-YYYY-MM-DD` / `dashboard-leads-YYYY-MM-DD`;
       same-day re-run clears + rewrites in place (idempotent). Retention:
       30 days, deleting ONLY names STRICTLY matching the `dashboard-`
       prefixed format — the outpatient app's `outpatient-*` sheets and any
       non-conforming name are untouchable by construction (negative-cased
       in the tests).
  - Alerting: ONE `MailApp` email per run, only when something is wrong, to
    the `ALERT_EMAIL` Script Property; Hebrew subject
    `⚠️ E-ZONE Dashboard: אי-התאמה בנתוני מטופלים`. Fail-open: missing
    property or send failure → `Logger.log`, never throw.
  - `setupIntegrityTrigger()` — idempotent installer: deletes every trigger
    bound to `nightlyIntegrityJob`, then creates one
    `everyDays(1).atHour(2).nearMinute(30)` trigger (~2:30), falling back to
    plain `atHour(2)` if the runtime rejects `nearMinute`.
- test/nightly-integrity.test.js — real-source extraction of every pure
  helper (key normalization + diffing, orphan matching incl. the id-heal
  fallback, chunk store round-trips + stale-chunk cleanup, snapshot naming,
  strict retention with `outpatient-*`/unprefixed/malformed negatives,
  Hebrew alert body incl. the house — name — entry date format) plus
  source-scan guards: read-only job body (and `clearBody_` stays gone),
  lookup-by-name-before-create, sentinel-before-snapshot ordering,
  persist-after-alert and only-off-successful-read, any-reason tombstone
  matching, fail-open alerting, idempotent trigger install, pinned property
  keys, `PATIENT_COLUMNS` untouched, no handle_ routing changes, and the
  `appsscript.json` timezone locked to Asia/Jerusalem.

## Post-merge steps (manual, one-time — in THIS Apps Script project)
This is a DIFFERENT Apps Script project from the outpatient app's — its
Script Properties do not carry over:
1. Apps Script editor → Project Settings → Script Properties → add
   `ALERT_EMAIL` = the address that should receive integrity alerts.
   (Without it the job still runs and logs the full report via
   `Logger.log`; it just cannot email.)
2. Apps Script editor → run `setupIntegrityTrigger()` once. Safe to re-run;
   it replaces any existing `nightlyIntegrityJob` triggers.

No redeploy of the web app is required for the trigger itself, but the code
must be in the project (deploys via the usual clasp path on merge).

## Verification
- `npm test` — full suite green (713 tests), including the 42 new
  nightly-integrity tests.
- Read-only contract, check ordering, retention strictness and the shared
  EZONE-Backups lookup-before-create are all locked by source-scan tests so
  a future edit cannot silently regress them.
