# CRM pilot preparation — 2026-10-14

The runtime/source code independently reviewed at `06c93b8b` is unchanged.
This preparation adds operator helpers, synthetic regression cases and a CI
backup/restore drill. No production access, deployment, configuration, database
role, backup schedule or patient/source edit is performed by this work.

## Source preflight

`scripts/crm-source-preflight.js` exports `inspectCrmSource(spreadsheet)`.
It is outside the Apps Script deployment directory, has no entrypoint and is not
imported by the app. It requires a spreadsheet object supplied in an explicitly
approved operator/staging context. Do not paste it into or deploy the live project
as an incidental smoke test. No automatic production access is configured.

The helper reads only sheet dimensions, the header row and the ID column of
`Leads`, `לידים לא רלוונטיים` and `לידים שהוסרו`. Its result contains counts and
fixed diagnostic codes, never names, IDs, header contents, notes, URLs or raw
errors. It performs no create/ensure/backfill/write/logging calls. IDs are held
transiently only to count duplicates across sheets.

Checks include sheet existence, required header uniqueness, ID type/length,
blank IDs, trimmed duplicates and both per-sheet/combined bounds. The row span
is a **conservative upper bound**, not an exact count of populated rows: blank
gaps are flagged for review without reading other columns. A passing result does
not validate non-ID field values, a live source response, permissions, growth,
or atomicity across sheet reads. It is not activation approval. If rows move
during a scan, repeat in the approved setting; no snapshot lock is taken.

If an archive does not exist, the report fails. Do not manufacture a removal of
a real lead to create it. Any necessary empty-sheet creation with canonical
headers is a separate source change requiring approval.

## Restricted database permissions

`test/crm/checkpoint-permissions.test.js` creates a random role and schema **only**
inside the explicit localhost `crm_checkpoint_test` fixture. A provisioner owns
the schema/table and initializes its checkpoint. The runtime role receives:

- required database connection and schema usage;
- `SELECT` on the checkpoint table;
- `UPDATE (issued, accepted, accepted_hash, payload)` on that table only.

Positive cases verify reserve/accept/read with that role. Negative cases require
PostgreSQL to reject schema/table creation or deletion, INSERT/DELETE/TRUNCATE,
unrelated-table reads, taking the owner role, and changes to epoch/key fingerprint.
The runtime cannot call `start()` or alter the generation through raw SQL.

These are fixture grants, not changes to production accounts. A production
namespace must be approved and isolated from other apps/tenants; its exact
search_path, PUBLIC grants and role memberships need verification. The app's
unqualified table name makes an explicit safe search_path part of provisioning.
This narrows the earlier generic table-UPDATE proposal; it does not add runtime
permission-changing code or a provisioning endpoint.

## Actual backup/restore drill

The existing real-PostgreSQL CI job now additionally:

1. Seeds a separate synthetic schema with two open and one closed task, source
   dates, accepted cursor and an unaccepted old-generation ticket.
2. Generates a random 32-byte fixture key in a private runner file, outside the
   database dump. It never uses CRM_QUEUE_KEY, READ_MODEL_KEY or production URLs.
3. Runs `pg_dump` in custom format for that schema.
4. Creates a distinct disposable database, `crm_checkpoint_restore_test`, and
   uses `pg_restore --exit-on-error` there. It never restores over the source DB.
5. In a fresh Node process, checks the restored ciphertext hash, key fingerprint,
   epoch and cursors against an external fixture manifest; opens the encrypted
   data with the separately held key and checks task count/original dates.
6. Proves a wrong key cannot read/reset state; advances the generation deliberately
   in the restored fixture, rejects the old ticket and verifies outage retention
   plus partial evidence not reopening a closed task.
7. Removes fixture key/manifest/dump material. No recovery artifacts are published.

`scripts/crm-fixture-config.js` rejects non-loopback addresses, unexpected DB names
and URL option overrides. Seed accepts only `crm_checkpoint_test`; verify accepts
only `crm_checkpoint_restore_test`. This is a synthetic logical-backup recovery
drill. It does **not** prove production backup scheduling, provider snapshots,
retention, key custody, recovery staffing, RPO/RTO or live source freshness.

## History and activation remain separate

Proposed pilot: 14 days of Dashboard leads under the existing four staff IDs,
led by Vered. Keep all encrypted queue history during the pilot and delete no
source rows. End-of-pilot review is manual; no recurring task is created here.
The PR body records proposed capacity margins, which are not runtime guards.
Before activation, actual source counts and **all** retained checkpoint tasks
(including closed tasks) must be measured, with an owner and a usable stop rule.
Open-task UI totals are not checkpoint capacity. This helper does not decrypt
or inspect a production checkpoint, and no live counts are claimed.

For a separately approved operator context, `scripts/crm-checkpoint-preflight.js`
accepts an explicit pool/key/scope and returns total/open/closed counts only.
It has no environment defaults or HTTP endpoint. It uses `BEGIN READ ONLY`,
parameterized scope selection and the authenticated v1 encrypted payload format;
records are decrypted transiently in process memory and never returned/logged.
Wrong keys, unreadable state and DB errors return unavailable, not empty success.
Tests use the real store to create encrypted fixtures and prove count accuracy,
no record output and PostgreSQL refusing an injected write during inspection.
It has not been run against production; executing it there needs the appropriate
administrative authority and separate approval for this aggregate inspection.

Permanent operation still needs a policy/design for history and growing source
archives. Simple TTL deletion would not fix this: source archive IDs are reread,
and loss of closure evidence can affect reopening safety. Do not raise limits,
delete source archives or reset the checkpoint to bypass a capacity failure.

Remaining evidence: approved staging with actual source contract/authority,
production count-only preflight permission/results, approved DB namespace and key
custody, verified production backup/restore arrangements, collector provisioning,
and separate merge/deploy/activation approval covering both Apps Script endpoints.
The existing merge automation deploys Apps Script; confirm gates are off before
any approved merge and confirm v2 before enabling Node collection.
