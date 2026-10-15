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

Sandra's 15 October checkpoint reports the merged Managers app serving through
the versioned protocol-2 candidate and successful signed-in read checks. The
Dashboard merge and return to its original deployment remain pending her go:
see `docs/managers-hardening-rollout.md`. Historical deployment coverage and
live write persistence remain unverified; this is not a claim of final activation.

15 October documentation review: preserve the candidate's exact runtime source;
require the merge-specific Apps Script deploy, explicit Managers-feed refusal
checks, original-URL capability probe before switching, protocol-2 fallback,
historical-deployment inventory and a dated completion record. No runtime,
workflow, credentials or configuration changed; test count delta: 0.

Tests cover missing/wrong/query credentials, both proxy modes, same-name users,
renaming, legacy rows, house/alias scoping, cross-house patient details and a
readiness probe with all data/write services configured to throw on use. The
companion Managers repository includes an opt-in real HTTP → Code.gs integration
check; no production business records are written by these tests.
