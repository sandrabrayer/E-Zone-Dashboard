# Managers work tool — backend (October 13, 2026)

**What**: one new action, `managersWork`, for the ezone-managers app's new
work tabs. Called by the managers **server** only (POST body), gated by its
own fail-closed Script Property **`MANAGERS_WORK_SECRET`** — unset or
mismatched → `{ ok:false, error:'unauthorized' }` before anything is read
(the `getAdmittedRoster` / coordinators model). It is in `OPEN_ACTIONS`
(no PROXY_SECRET, like the other cross-app actions) and `PROXY_KNOWN_ACTIONS`.

The managers server authenticates the person (personal code) and passes
`{ house, role: 'manager'|'admin', actor }`; this backend validates them
(Managers house key, one of the two roles, non-empty actor).

| op | returns / does |
|---|---|
| `houseData` `{ month }` | patients in the house today (name, entry date, days, status) · outpatients from the house active today (name, package, start) · intake visits this month (lead meetings: date, time, name, meetingWith, outcome) · admissions this month · the three logs · follow-ups due (date ≤ today, not done) |
| `logAdd` `{ log, entry }` | a new row in `familyCalls` / `staffTalks` / `events` (id, author, createdAt stamped; required fields enforced; dates/times validated; text cleaned) |
| `logUpdate` `{ log, id, patch }` | `followUpDone: true` or `deleted: true` (soft) — author or admin only, never across houses |

**Logs** — new sheets, append-only headers, rows never physically deleted,
written as text cells under LockService:
- `ManagersFamilyCalls`: patientName, contactName, relation, callDate,
  callTime, summary + follow-up/stamps
- `ManagersStaffTalks`: employeeName, talkDate, talkTime, summary +
  follow-up/stamps — **private**: a manager sees only talks they wrote;
  admins (Sandra, Ron) see all
- `ManagersEvents`: eventDate, eventTime, patientName, whatHappened,
  actionTaken + follow-up/stamps

**Setup (manual, once)**: set Script Property `MANAGERS_WORK_SECRET` (same
value as the managers app's Railway variable). Until then the action refuses
— nothing else changes.

**Tests**: 2718 → 2726 (`test/managers-work-tool.test.js`: fail-closed
secret, caller validation, house scoping, privacy of staff talks, author /
admin rules, soft delete, validation, no leak into managersHouse /
managersOverview). Pinned open-action lists updated on purpose. Mutation
(dropping the privacy filter) fails the privacy test.
