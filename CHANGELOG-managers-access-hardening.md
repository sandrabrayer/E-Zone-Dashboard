# Managers protocol 2 — October 14, 2026 (pending coordinated deployment)

The old read feeds bypassed the Managers login, and private-note ownership
compared display names. Managers health also could not detect a mismatched
Apps Script secret/version before deployment activation.

- `managersOverview`, `managersHouse`, `occupancySnapshots`, and `managersWork`
  now require the existing `MANAGERS_WORK_SECRET` in a JSON POST body, even in
  proxy log mode. GET and query-string credentials cannot authenticate them.
  Their gate does not create SecurityLog rows or touch Sheets on refusal.
- The three read feeds are scoped to the session-derived role and house.
  Cross-house intake credits preserve bonus counts but omit other houses'
  patient details for a manager. Admins retain the complete authorized view.
- Work calls require a stable `actorId`; the log schema appends `authorId`.
  Display names never grant read/update permissions. The backend returns
  `canEdit`; historical private notes without an ID remain admin-only, and
  only admins can update any legacy row. No data is migrated by name.
- Authenticated `managersWork / capabilities` reports protocol 2 and required
  capabilities without accessing sheets, locks, caches or logs. The companion
  Managers change uses it to gate Railway activation.
- Therapists/Coordinators secrets and Dashboard proxy/finance permissions are
  unchanged. Existing read contract keys and bonus calculations are preserved.

Deployment is intentionally blocked pending verified account configuration and
coordinated staging: see `docs/managers-hardening-rollout.md`. This is not a
claim of production activation. Existing anonymous URLs remain exposed until
all active historical deployments are updated or safely retired.

Tests cover missing/wrong/query credentials, both proxy modes, same-name users,
renaming, legacy rows, house/alias scoping, cross-house patient details and a
readiness probe with all data/write services configured to throw on use. The
companion Managers repository includes an opt-in real HTTP → Code.gs integration
check; no production business records are written by these tests.
