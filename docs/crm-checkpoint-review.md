# CRM-02 checkpoint foundation and review — 2026-10-13

This records the foundation review. A later draft slice now wires ONLY
Dashboard leads to a protected, default-off work screen. See
[queue integration](crm-queue-integration.md) for the current runtime, fixed
collector generation, authority, tests and remaining production gates. The
historical "not connected" section below describes the foundation commit.

## Reviewed scope

Self-review of Dashboard #220 at `9f4b547d6d77603f42a2230ede1f66fe5b29c746`
and Outpatient #114 at `4d464d5d323496d7a86dde289335d063649ea401`.
This is not independent reviewer sign-off or production approval. Both remain
drafts. No further source-reader, Code.gs, UI, role or Outpatient change was
needed for this slice. The source readers retain their existing authority and
avoid sheet mutation paths; the new work addresses their explicit lack of history.

Before a live queue, disappearance, outages and restart must not erase unresolved
work. Deriving retained-record permissions from the IDs in the latest source
response would also discard disappeared tasks. A CURRENT server policy must
explicitly authorize the retained source scope or individual record IDs.

## Implemented foundation

`lib/crm/checkpoint-state.js` reconciles only the three operational datasets
already covered by the adapters. No financial or clinical domains are added.

- Missing rows and repeated source failures retain unresolved work.
- Only a fresh, complete, explicit resolution closes its own reason. Admission
  does not close meeting-result work; continuing/stopping does not prove that
  an earlier transfer was accepted. Known closed tasks stay closed on outages.
- A later explicit active state can reopen a task; unknown states remain visible
  for review. Native IDs are source-record references, never global person IDs.
- The first concrete source deadline survives reassignment and rescheduling;
  missing deadlines remain missing. Audited deadline correction is not yet built.
- Current authorization is checked before and after asynchronous I/O. Revocation
  or an in-flight policy change returns no data. Filter records before counts.
  Hide composite identifying keys/names without name access; give record-limited
  grants no global source metadata or hidden-row counts.

`lib/crm/checkpoint-postgres.js` persists queue AND cursor in one PostgreSQL
transaction using one checked-out client. It requires an injected pool and a
separate 32-byte encryption key. No implicit migration, pool creation, environment
read, timer, HTTP handler or collector starts when this library is imported.

- `start(scope)` advances a durable epoch, fences previous collectors and retains
  the authenticated stored queue.
- `reserve(scope, epoch)` allocates a persistent sequence BEFORE a source request.
  Responses arriving backwards cannot replace a later accepted response.
- `accept(scope, ticket, normalizedEnvelope)` validates/project inputs and commits
  state plus cursor together. Exact retries are idempotent; conflicting retries
  fail. A lost COMMIT acknowledgment can be retried without duplicating work.
- This orders COLLECTOR requests, not Google source versions. It does not prove
  cross-sheet atomicity or order manual edits where source versions are absent.
- AES-256-GCM encrypts the payload and binds tenant/dataset as authenticated data.
  Names, assignees and native IDs are not plaintext DB columns. Wrong keys and
  corrupt/swapped ciphertext fail closed without resetting the checkpoint.
- Capacity/DB failures return errors, never silent eviction or successful empty
  queues. The limit is 25,000 historical task keys. Retention/archival/deletion
  policy and key rotation/recovery are not implemented or enabled.

## Foundation commit boundary (superseded runtime wiring)

Neither `server.js` nor `lib/crm/read-routes.js` imports the checkpoint store.
Existing source routes still return `persistence: none`. No new HTTP ingestion
endpoint, background worker, runtime flag, production DB or on-boot migration.
`pg@8.23.1` is a test-only devDependency; a future integration must supply a pool.

A future ingestion caller must use a trusted collector scope and authenticated
source adapters, never browser-submitted observations/grants. The authorization
callback is a policy boundary, not a personal identity system. Outpatient's
shared-session model still is not a personal-role registry.

## Verification boundaries

Pure tests cover disappearance, repeated failures, reason-specific closure,
deadline preservation, scope filtering/redaction and the real continuation
adapter. Real-PostgreSQL tests cover rollback, lost commit reply, replay conflict,
concurrent allocation, old-collector fencing, late responses, reconnection,
encryption/wrong keys and revocation during a read.

CI also commits a synthetic checkpoint, restarts ONLY its disposable PostgreSQL
container and reads it in a new Node process. It then injects a source outage;
the task and original deadline must survive. The DB test guard accepts only a
localhost database called `crm_checkpoint_test`. It never uses DATABASE_URL or
production credentials. The required DB job fails if its fixture URL is absent.

This workspace cannot start PostgreSQL as a non-root user: OS restrictions
refused a local attempt. No local DB tests are reported as passed. No-DB and
actual PostgreSQL CI results are recorded separately in the PR after completion.
A database/process restart is not backup restoration or disaster recovery;
production backup coverage and a true restore drill remain unverified here.

## Gates before connection

Review the checkpoint implementation, then select/approve a CRM DB namespace,
least-privilege DB role, separate encryption-key custody and backup/retention
policy. Define actual collector ownership and current per-source user grants,
including revocation. Then wire observations to checkpoints and build the
user-facing missing, partial and retained-task states. Production requires its
separate approval; these gates do not block completing this code draft.

Rollback now is removal of this isolated checkpoint commit: no live schema/data
or runtime behavior changed. A future stop must preserve stored checkpoints.

References: [node-postgres transactions](https://node-postgres.com/features/transactions)
and [PostgreSQL transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html).
