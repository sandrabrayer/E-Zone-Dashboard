# Managers protocol 2 — coordinated activation

Status: prepared code, **not a verified production activation**. The Managers
and Dashboard changes must be reviewed together. Do not close the original GET
feeds until a compatible Managers deployment is serving through the candidate.

## Checkpoint — 15 October 2026 (steps 6–7 still pending)

- GitHub confirms Managers PR #37 merged as `7a6ea76` and Dashboard PR #223
  remains an open draft at reviewed backend commit `88635fc`. Dashboard CI is
  green. The additional versioned candidate is reported byte-identical to that
  commit's `apps-script/Code.gs`; the original deployment and CI
  `DEPLOYMENT_ID` are reported unchanged.
- Sandra's rollout report records Railway SUCCESS with Managers `7a6ea76`
  using the candidate, `/healthz` 200, and unauthenticated Managers data routes
  returning 401. She reports own-house access, other-house refusal, admin
  all-house access, private-note visibility, team/shift and house-cost reads
  working. Railway deployment history and signed-in results are operator-reported.
  This review independently reproduced (15 October, approximately 05:25–05:28 UTC)
  public `/api/version` = `7a6ea76`,
  `/healthz` 200 and all three unauthenticated route refusals (401).
- Existing personal codes, account IDs and the shared secret are reported
  unchanged. Do not repeat steps 3–4 or replace the existing configuration.
- The reported candidate refusals for `getData`, `getPayments`, `getCredits`
  cover Dashboard actions, **not the three Managers feeds**. This review also
  directly checked all four Managers actions listed below on the supplied
  candidate URL: GET, JSON POST without a secret, POST with a deliberately
  invalid body secret and POST with only an invalid query secret. All 16 checks
  returned exactly `{ok:false,error:"unauthorized"}` (HTTP 200). No credentials
  or business records were used. These checks do not verify historical URLs.
- No disposable live write/read/soft-delete check was run. Synthetic write
  tests do not establish live persistence. Step 5's signed-in report does not
  itself authorize step 6: **Sandra's explicit go is still required**.

Keep the status line above until step 7 and its completion record are verified.
This checkpoint records progress; it is not a fresh configuration instruction.

## Required configuration (retain the existing secret and codes)

An authorized configuration owner must inspect the current `MANAGER_ACCESS`
inside Railway. Add one unique, immutable `id` per person without changing their
code, name or optional `user` alias. The existing username + personal-code
login remains. Use 3–64 ASCII letters/digits/underscore/hyphen, starting with a letter or
digit. Never derive an ID from a name/code, reuse an old person's ID, or combine
Sandra and Ron into one account. Keep the ID when rotating codes or renaming.

Check every manager's `house` against their assignment: `raanana`, `ramot`,
`efroni`, `rehab`, or `pardes`. Sandra and Ron each need `role: "admin"`.
Keep `NODE_ENV=production`. `MANAGERS_WORK_SECRET` must match the existing
Dashboard Script Property; never paste either value into logs, chat or a PR.
Do not replace the current access array with sample data. The connector exposes
variable names but redacts values. Use an authorized Railway UI session for
this edit, preserving all existing fields.

## Order that preserves the current service

1. Review both PRs and require green CI. Record the currently serving Managers
   commit, Railway deployment and original Apps Script version/deployment in the
   private operations record. Do not change the Dashboard CI `DEPLOYMENT_ID`.
2. In the **same Dashboard Apps Script project**, create an additional versioned
   Web App deployment from the reviewed backend commit. Use the current web-app
   execution/access settings. Keep the original deployment on its existing
   version. An authorized Apps Script operator must do this: the ordinary
   `Deploy Apps Script` workflow updates the original deployment and must **not**
   be run from the PR branch for this step. The candidate shares the existing
   Script Properties and sheets. No live note creation is needed for readiness.
3. Merge the Managers PR after CI passes. With the original protocol-1 backend,
   its candidate deployment fails readiness and the old service remains active.
   Missing IDs also fail local startup. Verify this before changing variables.
4. In one Railway configuration update, set `MANAGER_ACCESS` to the verified
   array with IDs and `APPS_SCRIPT_URL` to the candidate Web App URL. Keep the
   shared secret unchanged. Deploy the merged Managers commit. Do not disable
   `/healthz`: it must verify protocol 2, the shared secret and all required
   capabilities before Railway promotes the new deployment.
5. Verify Railway SUCCESS, `/api/version` equals the Managers merge SHA,
   `/healthz` is 200, and unauthenticated `/api/me`, `/api/sheets` and the
   read-only `houseData` operation return 401. With authorized personal sessions,
   check a manager's own house, refusal for another house, Sandra/Ron's all-house
   view, and private-note visibility. Also check the newly added team/shift and
   house-cost views; their optional source configuration is separate from
   protocol readiness. Keep the initial live checks read-only.
   Synthetic integration covers write logic but does not prove live persistence;
   a disposable write/read/soft-delete acceptance check needs explicit approval.
6. **Only after step 5 succeeds and Sandra explicitly approves**, merge the
   Dashboard PR. Recheck green CI on its final head. Compare `apps-script/**`
   with the candidate's reviewed source (`88635fc` at this checkpoint); any
   runtime or manifest difference requires review and candidate revalidation.
   Documentation-only changes do not require a new candidate.
   Confirm `Deploy Apps Script` succeeds **for the Dashboard merge commit** on
   `claude/build-ezone-dashboard-QOg5s`, updating the existing deployment ID.
   Record the run URL and the resulting Apps Script version. A green test run
   or Railway deploy is not evidence of Apps Script deployment. Leave Managers
   on the candidate if the original deployment or any checks below fail.
7. After the original URL passes the backend checks below, an authorized
   operator may point **only** Managers `APPS_SCRIPT_URL` back to that recorded
   original production URL. Keep account IDs, codes, `MANAGER_ACCESS`, secrets
   and healthcheck settings unchanged. Record the approved Managers commit
   before this redeploy (it may have advanced beyond `7a6ea76`). Require Railway
   SUCCESS, matching `/api/version`, `/healthz` 200 and all step 5 reads again.
   Verify Dashboard, Therapists and Coordinators' existing authorized reads.
   Archive the temporary candidate only after these checks pass and no consumer
   still uses it. Future Dashboard auto-deploys then update the URL Managers uses.

### Exact backend checks and completion evidence

Run these on the candidate before step 6 and on the **original URL after its
step 6 deployment, before step 7's switch**. Use a secure operator session for
the authenticated probe; never place a real secret in a URL, transcript or log.

| Check | Required result |
|---|---|
| JSON POST `action: managersWork`, `op: capabilities`, existing body secret | `ok: true`, `protocol: 2`, capabilities include `stableActorId`, `scopedReads`, `privateLegacyAdminOnly`; no business data |
| GET and JSON POST without a secret, for each of `managersOverview`, `managersHouse`, `occupancySnapshots`, `managersWork` (`op: capabilities`) | Exactly `{ok:false,error:"unauthorized"}`, no data |
| Same actions with a deliberately invalid secret in the POST body, and a POST with only an invalid query-string secret | Same refusal; valid query-string-secret rejection is covered by synthetic tests, never put the live secret in a URL |

Check the JSON body: Apps Script can return HTTP 200 for a refusal. A current
Managers `/healthz` 200 proves its configured candidate, not the original URL.
Keep only timestamps, deployment/version references and pass/fail results in
the operations record; do not copy response data or credentials.

Inventory **every active historical Web App deployment** in the same project,
including the original and candidate. Record its version, known consumers and
the four-action refusal results above. An old URL must be updated and retested,
or archived after its consumers are accounted for. An untested active deployment
leaves this audit incomplete; do not infer that it is protected from another
URL's success. Do not archive an unknown consumer's deployment blindly.

After step 7 passes, record Sandra's approval, Dashboard merge SHA/deploy run,
original Apps Script version, Managers SHA/Railway deployment, dated read-check
results with who verified them, candidate retirement and historical-deployment
disposition. Then update this document's status line and its Managers-repository
copy to **verified production activation (read checks)** with the date and
evidence references. Keep **live write persistence unverified** until a separately
approved disposable acceptance check succeeds. Do not mark unperformed checks
as passed or publish secrets/personal records as evidence.

Apps Script supports multiple active versioned deployments:
https://developers.google.com/apps-script/concepts/deployments
Railway switches traffic only after the healthcheck succeeds:
https://docs.railway.com/deployments/healthchecks
Railway's deployment check is not continuous monitoring; monitoring may poll
`/healthz` without credentials. Do not configure an unauthenticated patient-data
feed as a health check. The Helpdesk monitoring docs contain such an older
Managers example; its actual variable configuration was not verified here.

## Legacy notes and rollback

Existing columns remain in their original order; new writes append `authorId`.
Private staff talks without an ID are readable only by admins. All legacy rows
are editable only by admins. No name-based migration runs; even identical names
are insufficient evidence of ownership. Preserve old rows for an administrator
to review. Any reassignment is a separate, explicitly reviewed data operation.

During step 3, a failed Managers candidate leaves the previous deployment serving.
After step 4 succeeds, the active service is the protocol-2 Managers/candidate
pair. Keep that known-good pair available through steps 6–7. If the original
backend fails verification, stop before switching; if a switch has already
failed, an authorized operator can restore the known-good protocol-2 candidate
URL and redeploy with readiness enabled. Do **not** roll the backend back to name-based authorization:
that would restore the original privacy defect and ignore the new ownership
column. Keep a known-good protocol-2 deployment available during promotion.

## Reproducible local verification

All accounts, notes and sheets used in these checks are synthetic:

```sh
# Managers checkout (Node 22, same as CI)
TZ=UTC npm test
DASHBOARD_CHECKOUT=/absolute/path/to/reviewed/E-Zone-Dashboard TZ=UTC node --test test/managers-backend-integration.test.js

# Dashboard checkout
TZ=UTC node --test
```

The integration check runs real Managers HTTP routes against the real Code.gs
in-memory sandbox. Standard Managers CI skips that check unless a reviewed
Dashboard checkout is explicitly supplied. Readiness proves compatibility and
secret equality; it does not validate the person's assigned house or live writes.
