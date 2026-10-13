# CRM work queue — Dashboard lead slice, draft 2026-10-13

## User behavior

`/crm-work` is a protected Hebrew/RTL work screen for **Dashboard leads only**.
It lists retained open tasks, overall responsibility (Vered), current assignee,
original deadline, event date, observation time and missing/uncertain states.
Filtering is local to the authorized response. Links use the existing
`/#leads` and `/#meetings` screens, not guessed person/record deep links.
There is no task edit/close control; source applications remain the work surface.
The existing Dashboard navigation and service worker are unchanged.

The source adapter currently supplies no lead follow-up deadline. The UI shows
it as missing; it does not invent an SLA or turn the visit date into a deadline.
An established checkpoint deadline remains unchanged on reassignment/rescheduling.
The source observation time is always shown as an as-of snapshot, not proof of
current freshness. Dashboard has no general Leads.updatedAt, so that field is
explicitly unknown. No source version/cross-sheet atomicity is claimed.

- Opening/reloading the page performs `GET /api/crm/queue`: checkpoint read only.
- **עדכון מהמקור** performs `POST /api/crm/queue/refresh` with an empty JSON body.
  The server allocates a durable sequence BEFORE calling the existing dedicated
  source projection/adapter, then commits observations plus cursor together.
- Source failure is accepted as unavailable evidence, retaining unresolved work.
  Missing rows and partial/duplicate sources cannot silently clear the queue.
  An HTTP 200 in this case means the queue was read/saved, NOT that Google is up;
  source health/uncertainty are visible in the response and screen.
- Database/key/commit failure returns 503 with **no fabricated empty queue**.
  A fenced/late collector returns 409, no automatic epoch reacquisition. Reload
  may read the durable queue. A lost response never deletes a committed queue.
- No background timer, polling, auto-collection on page open, or source writes.

## Authority and browser privacy

The real Dashboard session resolver rechecks the existing active personal
registry and requires `staff`, excluding the controller. A display name is not
an identity grant. The authorized scope is the existing all-leads source scope;
retained/disappeared rows do not lose authority just because a new read omits them.
If house/record-level restrictions are introduced later, this all-scope policy
must be reviewed, rather than deriving historical grants from current row IDs.

The same policy gates page/assets/GET/POST. The server owns tenant, dataset,
epoch, source action and grants; browser parameters/observations are refused.
Current policy is rechecked after source I/O before accepting observations and
before/after reading the checkpoint. Existing controller locks remain intact.
POST additionally requires exact Origin (scheme + Host), same-origin fetch
metadata when present, JSON and a custom header; no CORS grant is added.

Responses are private/no-store, with restrictive CSP, no frame embedding and
no referrer. Browser rendering uses textContent, never source HTML. There is no
local/session storage or CRM service-worker cache. Failed/denied reads clear
names and counts. Hiding/leaving the page clears data; returning rereads under
current authorization. There is no claim of instant revocation while a user
keeps an already-rendered page visible; this slice does not introduce polling.

This does not grant Dashboard sessions access to Outpatient records. Outpatient
#114 remains unchanged, observation-only under its own current authority. No
unified identity, clinical data, finance calculations or role expansion.

## Disabled runtime and collector ownership

The following are a proposed configuration contract, **not instructions to
configure production now**. No values/resources were created or changed.

| Server setting | Required only for this queue |
| --- | --- |
| `CRM_QUEUE_ENABLED` | Exactly `1`; otherwise the queue is disabled |
| `CRM_READS` | Exactly `1`, in addition to the existing backend source gate |
| `CRM_QUEUE_DATABASE_URL` | Explicit PostgreSQL URL/namespace; no DATABASE_URL fallback |
| `CRM_QUEUE_KEY` | Separate canonical base64 encoding of a 32-byte encryption key; no READ_MODEL_KEY fallback |
| `CRM_QUEUE_TENANT` | Approved opaque scope, 1–80 ASCII letters/digits/underscore/hyphen |
| `CRM_QUEUE_EPOCH` | Positive safe integer returned by deliberate checkpoint provisioning |

Any missing/invalid setting disables the routes. The pool is created lazily only
after an authorized request with valid configuration; `pg@8.23.1` moves from
devDependency to dependency at the same version. Import/boot creates no schema,
claims no collector epoch and runs no source collection. Connection/query/lock
timeouts are bounded, and connection errors never print credentials.

A separately reviewed provisioning operation would create `SCHEMA_SQL` in the
approved database namespace and call `store.start(scope)` once, recording its
returned epoch. This app performs neither step. Runtime DB permissions should
be limited to the provisioned checkpoint table (SELECT/UPDATE for reserve,
accept and read), with the schema owner separate. Shared hosting/database roles,
search_path and cross-tenant isolation must be verified before live activation.

All serving replicas of the approved collector generation use the same fixed
epoch. Durable sequence allocation supports overlap, while late responses are
rejected. Explicitly advancing the epoch fences every old replica; an old
process cannot call start or adopt a newer epoch through HTTP. This avoids the
"old instance lazily starts later and steals ownership" race. There is at most
one active collection per Node process; another returns 409. This is not a
distributed request-rate limiter, and no automatic retry/claim loop is added.

## Verification and remaining release gates

Synthetic tests exercise the actual source adapter, Express routes, authorization,
same-origin guards, retained work, encrypted PostgreSQL and source failures.
Required Chromium scenarios exercise manual collection, reload/outage retention,
revocation clearing, escaped names, missing deadlines, reassignment and mobile
layout. Browser fixtures use in-memory checkpoints and are **not durability
evidence**. The separate real-PostgreSQL HTTP tests use the actual server and
personal session registry. The existing CI restart test still covers an actual
ephemeral PostgreSQL-container restart and fresh Node process.

Full serial no-DB and real-DB results and required browser results are reported
separately on the exact PR head. All DB fixtures require localhost and database
`crm_checkpoint_test`; source calls use synthetic responses, never live records.
This is self-review; no independent review, production validation or backup
restore drill is claimed.

Before production: independent review of the draft; approve DB namespace and
least-privilege role, separate key custody/recovery, retention/deletion and backup
restore policy; validate source and retained-record authority in approved staging;
provision a fixed generation; obtain separate merge/deploy/activation approval.
Existing Code.gs changes remain in their original isolated commit, untouched by
this UI slice. No Coordinators/PR3 files, flags, paid resources or schedules change.

Stopping this CRM queue means disabling its gate while preserving its encrypted
checkpoints/key for later recovery. Do not drop data or borrow this rule for
Coordinators' owned write-model flags. No live rollback is needed for this draft.
