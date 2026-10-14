# Managers protocol 2 — coordinated activation

Status: prepared code, **not a verified production activation**. The Managers
and Dashboard changes must be reviewed together. Merging Dashboard first would
close the GET feeds used by the current Managers deployment. Do not do that.

## Required configuration (retain the existing secret and codes)

An authorized configuration owner must inspect the current `MANAGER_ACCESS`
inside Railway. Add one unique, immutable `id` per person without changing their
code. Use 3–64 ASCII letters/digits/underscore/hyphen, starting with a letter or
digit. Never derive an ID from a name/code, reuse an old person's ID, or combine
Sandra and Ron into one account. Keep the ID when rotating codes or renaming.

Check every manager's `house` against their assignment: `raanana`, `ramot`,
`efroni`, `rehab`, or `pardes`. Sandra and Ron each need `role: "admin"`.
Keep `NODE_ENV=production`. `MANAGERS_WORK_SECRET` must match the existing
Dashboard Script Property; never paste either value into logs, chat or a PR.
Do not replace the current access array with sample data. The connector exposes
variable names but redacts values, so it cannot safely perform this edit.

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
   view, and private-note visibility. Keep the initial live checks read-only.
   Synthetic integration covers write logic but does not prove live persistence;
   a disposable write/read/soft-delete acceptance check needs explicit approval.
6. **Only after step 5 succeeds**, merge the Dashboard PR. Confirm its existing
   Apps Script deployment workflow succeeds. On the original URL verify protocol
   2 through authenticated POST; unauthenticated GET/POST for the three feeds
   must return `{ok:false,error:"unauthorized"}` without data. Repeat on any
   other active historical Web App deployments; update or archive obsolete ones
   only after confirming they have no active consumers. Protecting one URL does
   not protect an older version still published at another URL.
7. Point Managers `APPS_SCRIPT_URL` back to the original production URL and let
   Railway redeploy with readiness enabled. Check version, health and authorized
   reads again. Future Dashboard auto-deploys then update the URL Managers uses.
   Retire the temporary candidate only after this succeeds. Verify Dashboard,
   Therapists and Coordinators' existing authorized reads still work.

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

Before step 6, a failed Managers candidate leaves the old deployment and original
backend serving. Once protocol-2 notes exist, keep protocol 2 when repairing or
rolling forward. Do **not** roll the backend back to name-based authorization:
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
