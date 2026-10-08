# CLAUDE.md — E-Zone Dashboard

Rules for fully autonomous Claude Code work in this repo. They override defaults.

## Repo facts

| Fact | Value |
| --- | --- |
| **Deployed branch** (Railway production) | `claude/build-ezone-dashboard-QOg5s` — there is **no `main`**. Every PR's base is ALWAYS this branch. |
| **Production URL** (Railway) | `https://ezone-dashboard.up.railway.app` (Railway auto-deploys the deployed branch) |
| **Apps Script deploy** | **Automatic on merge**: `.github/workflows/deploy-apps-script.yml` runs on `push` to the deployed branch touching `apps-script/**`, `.clasp.json` or the workflow itself. It also has `workflow_dispatch` (manual re-run only). |
| **Apps Script source** | `apps-script/Code.gs` (+ `apps-script/appsscript.json`) |
| **Test command** | `npm test` (`node --test`, fully mocked, no secrets; CI: `.github/workflows/test.yml`) |
| **Deploy probe** | `GET /api/version` → `{ commit, builtAt }` (public, `no-store`; `commit` = `RAILWAY_GIT_COMMIT_SHA`, `builtAt` = process start). `GET /healthz` also reports `commit` / `branch`. |
| **Changelog convention** | One `CHANGELOG-<topic>.md` per change at the repo root (no single CHANGELOG.md). |
| **Ecosystem / deploy docs** | `EZONE-ECOSYSTEM-STATUS.md`, `DEPLOY.md` |

Sibling E-Zone repos' deployed branches (for cross-repo work): outpatient = `claude/youthful-volta-laarnk`, E-Zone-Dashboard = `claude/build-ezone-dashboard-QOg5s`, therapists = `claude/inspiring-tesla-jipobw`, all others = `main`.

## Rules

1. **Language.** Talk to Sandra in English — concise, action-first. Hebrew UI text is RTL. Code and comments are in English.

2. **Every change** ships with:
   - tests added/updated, and the full suite (`npm test`) green;
   - a CHANGELOG entry (`CHANGELOG-<topic>.md`);
   - docs updated (`DEPLOY.md`, `EZONE-ECOSYSTEM-STATUS.md`, this file — whichever the change touches);
   - security best practices: no secrets in code or logs, fail-closed auth, parameterized queries, input validation, and `npm audit` with **0 high/critical**.

3. **Git.**
   - Fresh branch off the deployed branch (`claude/build-ezone-dashboard-QOg5s`); one PR at a time.
   - `git add` with explicit paths only (never `git add -A` / `.`).
   - Never force-push the deployed branch.
   - Check the PR state before pushing — never push to a merged PR's branch.

4. **Merging.** You are authorized to MERGE your own PRs when ALL CI checks are green. Never merge on red or pending. After merging:
   - a. If `apps-script/**` or `Code.gs` changed: the deploy workflow here is **automatic on merge** — find the "Deploy Apps Script" run for the merge commit and wait for it to be green. (Only if it did not fire, trigger it via `workflow_dispatch` on the deployed branch.) Never paste Code.gs; never create a new Apps Script deployment.
   - b. Poll `https://ezone-dashboard.up.railway.app/api/version` every 30s (max 10 min) until `commit` equals the merge SHA. If it never matches, the Railway deploy was likely SKIPPED — report it.
   - c. Time 3 requests to `https://ezone-dashboard.up.railway.app/` and report the status codes and times.

5. **Append-only / monotonic.** Google Sheets headers are append-only (never rename, reorder or delete a column). Service-worker cache version bumps are monotonic from the LIVE version (check what production serves, not just the repo).

6. **Never:** change Railway settings or variables, read Railway logs, subscribe to PRs, or schedule check-ins. If a Railway change is needed, give Sandra exact click-steps and values.

7. **Final report to Sandra:** PR link, merge SHA, tests count, Apps Script deploy run (if any), `/api/version` result, timings, and ONLY the manual steps left for her (with links). No step-by-step narration.
