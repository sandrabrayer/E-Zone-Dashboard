# CHANGELOG — Care-continuum identity feed (D-ID-1)

Date: 2026-10-30 · Draft only — no production release authorized.

## What changes
- `getAdmittedRoster` and `getDischargedRoster` add two opaque, read-only identity fields:
  - `id`: Dashboard `Patients.id`, the stable stay/admission id.
  - `personId`: Dashboard `Patients.personId`, the root-person id for a returning stay; blank on a first stay.
- Consumers derive the cross-stay person key as `personId || id`.
- No Sheet header changes, no writes, no auth changes, no money/notes/source fields exposed.

## Why
The pre-discharge continuation flow and the discharge-to-Outpatient handoff currently identify the same person differently. Carrying the already-existing Dashboard ids is the first backward-compatible step toward one care continuum without inventing a new identifier.

## Release
This PR changes Apps Script source and therefore would auto-deploy if merged. It must remain draft/unmerged until Sandra separately approves release.

## 8 November 2026 — synchronized draft to current production

This *same existing PR #329* was re-integrated with Dashboard's current production source (after merged #371), preserving all current code and tests while applying only the additive fields and source-backed assertions. No release, Apps Script push, data migration or credentials change is authorized by this draft update. Outpatient #137/#138 and Dashboard #330 still need safe integration and standalone approval.
