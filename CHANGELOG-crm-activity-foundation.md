# B1 — `Activity` sheet + writer (foundation, not wired) — 2026-10-27

CRM restructure, Session B (`docs/crm/ROLLOUT.md` §B1; SPEC §7 «ציר זמן»). **Zero user-facing
change, zero production rows**: the writer has no caller until B2.

## What ships
- `ACTIVITY_SHEET = 'Activity'`, `ACTIVITY_COLUMNS` (append-only from day one):
  `eventId, occurredAt, recordedAt, kind, source, actorId, actorName, leadId, patientId, personId,
  paymentUid, dischargeId, houseId, summary, detailsJson, supersedesEventId`.
  Ids and ISO timestamps are text-forced at sheet-ensure time (never re-typed by Sheets).
- `activityRow_(event, nowIso)` — pure validation + normalisation:
  `eventId` required (`[A-Za-z0-9:_.-]`, ≤ 120); `kind` snake_case; `source` ∈ `manual` /
  `system:<fn>` / `app:<sibling>`; `occurredAt` strict ISO, else = `recordedAt`; `details` a
  JSON object ≤ 4000 chars; every text cell cleaned (control chars, formula lead-in, `<>`, caps).
- `appendActivity_(event)` — under the script lock (`tryLock(5000)`), **idempotent by `eventId`**:
  an id already on the sheet → `{ok:true, written:false, duplicate:true}` and zero writes. Never
  updates or deletes a row. Invalid input → `{ok:false, error}` before the lock.
- The sheet is created only on the first write; a read never creates it.

## Not in B1 (by design)
No action in `handle_` / `PROXY_KNOWN_ACTIONS`, no caller, no `getData` change, no kill switch
yet. B2 dual-writes system events from the existing writers behind a Script Property (default
off); B3 adds the permission-filtered read.

## Files
`apps-script/Code.gs` (clasp CI on merge — inert), `test/activity-foundation.test.js` (11 tests,
incl. the append-only header pin and the NOT-WIRED guard), `EZONE-ECOSYSTEM-STATUS.md`,
`DEPLOY.md` (nothing to configure), `docs/crm/ROLLOUT.md` §B1 marked built.
No SW bump, no secret, no Railway variable.

## Rollback
Revert. No sheet exists until a writer runs, so there is nothing to clean up.
