# Auto-deploy Apps Script via clasp in CI (on merge to the deployed branch)

## Why
Until now every `apps-script/Code.gs` change had to be pasted into the Apps Script
editor by hand and redeployed as a **new version of the existing deployment** — a
manual step that has been forgotten and, worse, occasionally done wrong (a *new*
deployment, which changes the `/exec` URL and breaks consumers; see the pitfalls
in `EZONE-ECOSYSTEM-STATUS.md`). This automates the exact-and-only-correct path
for the shared "ezone dashboard" backend that serves Dashboard + Managers +
Therapists.

## What changed
- **`.clasp.json`** (new): `scriptId` of the "ezone dashboard" Apps Script
  project; `rootDir: apps-script`. The Script ID is an identifier, not a secret.
- **`apps-script/appsscript.json`** (new): the manifest clasp requires in
  `rootDir` — V8, `Asia/Jerusalem`, `executeAs: USER_DEPLOYING`,
  `access: ANYONE_ANONYMOUS`.
- **`.github/workflows/deploy-apps-script.yml`** (new): push to
  `claude/build-ezone-dashboard-QOg5s` touching `apps-script/**` → `clasp push -f`
  → `clasp deploy -i <DEPLOYMENT_ID>` (new version of the existing deployment; same
  `/exec` URL). clasp `3.3.0` on Node 22; `workflow_dispatch`; fails loudly if a
  secret is missing / not JSON; requires the `Deployed …@<ver>` line and dumps
  `clasp list-deployments` on failure; `concurrency` guard.
- **`.github/workflows/validate-workflows.yml`** (new): PyYAML parse + `on:`/`jobs:`
  check for every workflow.
- **`.gitignore`**: ignore `.clasprc.json` / `.clasp.local.json` (OAuth tokens).
- **`DEPLOY.md`** (new): flow, one-time secret setup, token refresh, manifest +
  security caveats, and the managers-only-consumes note.

## Security
Credentials live only in GitHub Secrets (`CLASPRC_JSON`, `DEPLOYMENT_ID`) — never
committed, never printed; the runner's `~/.clasprc.json` is deleted at job end.

## ⚠️ Post-merge prerequisite
The workflow **fails until both secrets are added** (`CLASPRC_JSON`,
`DEPLOYMENT_ID`) — see `DEPLOY.md`. CI/tooling + docs only; no app code change.
