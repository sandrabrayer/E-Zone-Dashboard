# CRM-02 read projections — draft, 2026-10-13

The current bulk reads can create sheets, repair headers or backfill IDs. CRM
must not call them for a read-only view. This change adds dedicated source
projections and connects the CRM-02 v0.2 pure adapters to same-app, authenticated
HTTP routes. Nothing is deployed or enabled by this draft.

## Scope and boundaries

- Operational lead follow-up and the existing continuation workflow only.
- No money, phone numbers, free-text notes, clinical records, transfer writes,
  new person identity, permission expansion or Coordinators changes. The separate
  queue screen is documented in `crm-queue-integration.md`.
- A continuation decision `to_outpatient` is a destination-link review task,
  not proof of acceptance, a scheduled visit, attendance or a client match.
- The old lead/continuation/save routes and existing sheet schemas are unchanged.
- All source/HTTP readers are dormant unless `CRM_READS=1` is configured on the
  relevant server AND Script Properties. No variables/properties were changed.

## HTTP contract

`GET /api/crm/leads` returns this app's lead observations. Outpatient also has
`GET /api/crm/continuation` for its saved workflow and the existing Dashboard
admitted population. No body, query filters, user IDs or grants are accepted.
Every response is `private, no-store`; there is no cache or stale bulk fallback.
The adapters operate on server-derived source scope before output.

Successful response: `ok`, `contract=crm-observations-v1`, `persistence=none`,
`dataset`, `health`, `complete`, `observedAt`, `records`, `diagnostics`.
Only allowlisted fields survive source collection and adapter normalization.
`observedAt` is the server's observation time, not a source modification time.
`fresh/complete` describes this read, not an SLA or cross-sheet transaction.
Dashboard lead records keep `sourceUpdatedAt=null` because no general stamp exists.
Event dates do not become deadlines; missing deadlines remain missing.

- Unauthorized session: existing app 401 policy (Dashboard without session
  configuration retains its existing 503). Denied staff scope: 403.
- Feature disabled: 503, with no upstream call.
- Missing/duplicate headers, blank IDs, malformed values, missing sheet, old
  deployment, failed auth/transport, more than 10,000 rows: unavailable/503.
- Empty result is complete only after the required source(s) actually succeeded.
- Workflow failure: unavailable, never invented blank continuation decisions.
- Roster failure: available saved workflow remains partial, never silently closed.
- Unknown statuses and duplicate IDs remain explicit adapter uncertainty.
- Responses are observations, **not a durable task queue**. A consuming CRM must
  preserve previously authorized tasks on missing rows, incomplete sources,
  outages and restarts, and enforce ordering/current authority. This endpoint
  stays observation-only; the separate queue routes provide persistence/UI.

## Apps Script and transport

`crm-source-v2` for Dashboard leads includes all three required sources: `Leads`,
`לידים לא רלוונטיים` and `לידים שהוסרו`. The server requires explicit
`leadLifecycle=active|irrelevant|removed`; v1/unknown/missing lifecycle fails closed.
Archive projections contain only IDs and lifecycle, with other row fields blank.
Archive membership retires both operational reminders, with a persisted
`resolutionBasis=archived_irrelevant|archived_removed`. It does not prove attendance
or recorded meeting results. Overlapping IDs across sheets are quarantined as
partial, never chosen by precedence. Missing/malformed archives make the whole
snapshot unavailable; they are never created or treated as empty. The 10,000-row
bound applies to the combined source; long archive retention needs a release plan.

The roster and Outpatient contracts remain `crm-source-v1`. Both versions include
dataset, health, complete, observation time and projected rows. Each reader uses
existing sheets only. Exact header names are required;
column ordering is irrelevant. One range read per sheet is projected inside Apps
Script. No `_ensureSheet`, `getOrCreateSheet_`, migration/backfill, audit log,
CacheService, lock, Script Property write or background job is called.

Credentials are accepted in POST bodies only. The dedicated Dashboard dispatch
precedes the general gate because its transition-mode logging can write a sheet.
Its replacement guard is always fail-closed, even in `PROXY_SECRET_MODE=log`.
Legacy proxy routes reject the new action names to prevent bypass or cache reuse.
The transport accepts configured Google `/exec` URLs only, has a 20-second
abort, and accepts only Google's 302/303 response redirect to
`script.googleusercontent.com`; the redirected GET contains no credential body.
307/308 credential replay and unexpected destinations are refused.
A source timestamp must fall within the request window plus/minus 60 seconds
(clock tolerance only). This is not a durable sequence, content hash or SLA.

## Source authority and deployment dependency

Dashboard lead access requires a currently valid personal session with the
existing `staff` role and the same explicit four IDs as Apps Script, and excludes
the controller. A semantic parity test prevents source/server ID-list drift.
`USER_REGISTRY` is process-static: changing `USER_PIN_HASHES` takes effect after
restart, not during a request in the old process. Cookie expiry is rechecked per
request; tests that change policy during I/O use an injected resolver. Apps Script
rechecks the verified proxy secret, personal ID and staff role. No registry or
finance/controller permissions are changed.

Outpatient retains its existing shared-PIN signed-session authority for leads
and continuation. User-selected display names are audit labels, not personal
permissions. This slice does not claim viewer/editor or per-house isolation
that the existing server does not implement. No Dashboard personal session or
lead data is forwarded to Outpatient. A unified multi-app CRM needs a separately
reviewed principal/scope contract before launch.

Outpatient's own new backend actions require a proposed dedicated
`CRM_READ_SECRET` in the server environment and Script Properties. It is
currently unconfigured; no secret was generated, read, copied or stored here.
The roster action reuses ONLY the existing admitted-roster authority:
Outpatient `OCCUPANCY_SECRET` -> Dashboard `ADMITTED_ROSTER_SECRET`. It returns the
same admitted population (not released, no exit date), omits phones and never
reads Leads. It does not expose Dashboard leads, billing or a global person ID.
Outpatient continuation therefore depends on the paired Dashboard Apps Script
change. An older/missing counterpart yields explicit failure, not a legacy read.

## Review, release and rollback (proposed only)

1. Review both draft diffs and exact-head CI; keep Code.gs changes isolated.
2. Obtain separate production approval. Merging these deployed branches can
   automatically deploy Apps Script and Railway, so merge is not a harmless step.
3. Under that approval only: deploy source code with CRM disabled; validate the
   contract against synthetic staging sheets. No production records were read.
4. Before any live CRM connection, approve its actual user/scope policy,
   dedicated Outpatient secret provisioning and a bounded source validation.
   Verify permissions on the real deployed sources without copying patient data.
5. If approved later, enable only the required server/Script flags. This is not
   part of the current task and not an instruction to change them now.
6. Stop this read-only slice by disabling CRM_READS at the server and backend.
   Existing application operations remain on their original paths. Revert the
   two commits together if a code rollback is approved. No data migration or
   reconciliation is required. This rule does not apply to Coordinators' owned
   write-model flags, which must not be removed as a stop procedure.

The observation endpoints above still use `persistence: none`. The separate
default-off [Dashboard work queue](crm-queue-integration.md) now persists their
normalized lead observations and displays retained/partial states and source
links. Its GET reads only the checkpoint; only its explicit same-origin POST
collects and stores observations. Neither source endpoint has gained writes.
See [checkpoint foundation and review](crm-checkpoint-review.md) for ordering,
encryption and CI recovery coverage. Cross-app identity, live production/restore
validation, retention and key custody remain unapproved/unimplemented gates.

## Provenance and verification

The source adapters are the already tested CRM-02 v0.2 implementation from
2026-10-13, with only the import of `isDate` split into a tiny runtime module.
The previous queue implementation lives under `test/crm` solely as a synthetic
adapter-test oracle. It is not imported by the server. No new financial logic
is introduced into the runtime. Adapter fixtures contain invented records only.
New tests execute the real Code.gs with mutation traps (including auth failures),
and the actual Express app with signed sessions and mocked Google transport.
