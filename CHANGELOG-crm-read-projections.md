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

## Checkpoint follow-up — 2026-10-13

- Add a dormant PostgreSQL checkpoint library for the three operational datasets.
  Persist queue and cursor together; fence old collectors, reject late responses
  and conflicting retries, and preserve unresolved work through source loss.
- Encrypt stored payloads; recheck current policy before returning filtered
  rows/counts. Preserve original deadlines across reassignment/rescheduling.
- Add logic and real-PostgreSQL tests plus CI database/process restart checks on
  synthetic records. `pg@8.23.1` is a test-only devDependency.
- No Code.gs, source-reader, server-route, role or production changes in this
  follow-up. See `docs/crm-checkpoint-review.md` for boundaries and open gates.
- Counts above refer to the original projection slice. Updated no-DB/real-DB
  counts and exact-head CI links are recorded in the draft PR description.

## Work-screen follow-up — 2026-10-13

- Wire Dashboard leads to the retained checkpoint through a separate, default-off
  `/crm-work` screen, GET queue read and explicit same-origin refresh POST.
- Require current personal staff authority on every path; the controller remains
  excluded. Reject browser grants/observations, recheck in-flight authority and
  clear sensitive UI data on denied/failed reads or when the page is hidden.
- Display overall responsibility, assignee, original deadline, source observation
  time, missing/partial/unavailable states and fixed existing source-screen links.
  Preserve open work on disappearance/outage; no source edits or invented SLAs.
- Configure a fixed provisioned collector epoch; HTTP cannot claim/reclaim it.
  No implicit migration, source collection on GET, scheduler or production change.
- Promote pg 8.23.1 to runtime dependency at the same pinned version. Add actual
  server/PostgreSQL HTTP and required synthetic Chromium tests. Full serial suites
  and exact-head CI counts are recorded in the PR, separately from browser cases.
- Outpatient #114 and the isolated Code.gs commit remain unchanged. See
  `docs/crm-queue-integration.md` for remaining release gates and limits.
