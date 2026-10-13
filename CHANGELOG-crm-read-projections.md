# CRM-02: dormant read-only source projections — 2026-10-13

Status: draft only. No merge, deployment, flags, permissions, paid resources or
production record reads. See [contract, authority and rollback](docs/crm-read-projections.md).

- Add dedicated Apps Script projections with fail-closed body-only credentials,
  an explicit disabled default and no sheet creation/formatting/backfills/logging.
- Connect the CRM-02 v0.2 operational adapters behind existing same-app session
  authority. Minimize data twice; reject client-supplied grants and generic-proxy
  access to the new actions. No persistent queue or user-facing portal yet.
- Distinguish unavailable, partial and confirmed empty sources. Preserve source
  semantics: an onward decision is not destination acceptance.
- Keep the Apps Script reader and its mutation/auth regression tests in their
  own commit, separate from server transport, routes, adapters and documentation.

Validation details and exact CI head are recorded in the draft PR description.

## Local verification

`TZ=UTC npm test -- --test-concurrency=1`, Node 24.19.0: 2806 tests,
2747 passed, 59 skipped (browser tooling unavailable), 0 failed.
The local default TZ was America/Los_Angeles and the first full run exposed
timezone-sensitive existing date tests; the final run uses UTC as in CI.
The new routes also retain explicit per-route requireSession so the existing
auth-route guard recognizes them, in addition to the protected route prefix.
No financial calculations or existing tests were changed.

`npm audit --json`: 0 high/critical; 1 existing moderate `qs` advisory.
No dependency or lockfile changes. This is not a zero-vulnerability claim.
No live Google/production, database or restoration test was run. The dedicated
CRM tests use synthetic in-memory Sheets, real handlers and mocked transport.
