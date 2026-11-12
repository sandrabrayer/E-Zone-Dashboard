# CHANGELOG — care-continuum identity feed (D-ID-1)

Date: 2026-10-30 · base `claude/build-ezone-dashboard-QOg5s`

Business decision: E-ZONE continuity of care begins before discharge from a house.
This PR adds the minimum existing identity needed for downstream linking; it does
not create a new identifier and does not alter any live Sheet schema.

## Change
- `getAdmittedRoster` now allow-lists `id` (Dashboard `Patients.id`: one stay)
  and `personId` (root first-stay id when this is a returning stay).
- `getDischargedRoster` adds the same two identifiers.
- A first stay legitimately has blank `personId`; consumers derive the person
  key as `personId || id`.
- No handoff write changes, no owner/status feedback yet, no Outpatient change.

## Safety
- Read-only projections only; no new endpoint, secret, permission, Sheet column,
  mutation or migration.
- Existing fail-closed secrets remain unchanged.
- Explicit allow-list tests pin the exact response fields and assert that
  financial/clinical source columns still do not leak.

## Release
Draft only. If separately approved later, the Apps Script change follows the
repository's existing automatic post-merge deployment. No Railway setting or
secret change is required.
