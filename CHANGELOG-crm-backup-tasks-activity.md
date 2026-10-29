# CHANGELOG — Nightly backup covers `Tasks` and `Activity`

Date: 2026-10-29 · Branch `claude/backup-tasks-activity` → base `claude/build-ezone-dashboard-QOg5s`
Source: Sandra's work package (29/10) §4 «גיבוי»: the task record and the activity history were
not in the nightly snapshot (only Patients and Leads were).

## What

`nightlyIntegrityJob` (Code.gs, 02:00–02:30 Asia/Jerusalem, already installed) now also writes
`dashboard-tasks-YYYY-MM-DD` and `dashboard-activity-YYYY-MM-DD` sheets into the shared
`EZONE-Backups` spreadsheet — the full grid of each sheet (every task id, status, assignee, due
date / window, reschedule history is in Activity, submission ids), read with `getSheetByName`
only (never created by the job), same 30-day retention, same strict matcher
(`INTEGRITY_SNAPSHOT_RE`) so the outpatient app's snapshots stay untouchable.

Restore stays the existing manual path: copy the snapshot sheet's rows back (append-only columns
guarantee the shape); no automatic restore.

## Evidence

- `test/nightly-integrity.test.js`: the matcher accepts / expires the two new names, ignores
  `outpatient-*`; the job reads both sheets via `getSheetByName` and snapshots both; the
  read-only guard (no write primitive against the live spreadsheet) still passes.
- **Not verified yet**: a real nightly run with the two new tabs present in `EZONE-Backups` —
  check the morning after the deploy (Drive → `EZONE-Backups` → tabs `dashboard-tasks-…`,
  `dashboard-activity-…`). Until then the status is «טרם אומת», not «הושלם».

## Deploy

Nothing to set; the clasp CI deploys on merge; the installed trigger picks the new code up.
