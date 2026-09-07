# CI: hardened `@claude` GitHub Actions workflow (owner-only trigger)

## Read-only review (done first)

- **Deploy branch confirmed:** `claude/build-ezone-dashboard-QOg5s` — it is
  both the Railway-deployed branch (`EZONE-ECOSYSTEM-STATUS.md`) and the
  GitHub **default** branch, so the two agree and an agent PR here targets
  what production actually serves.
- **This repo has no `main` branch** (confirmed: 90 remote branches, none
  named `main` or `master`). The new workflow never references one — it is
  branch-agnostic, triggering on issue/PR events rather than on a push.
- **Existing workflows untouched:** `deploy-apps-script.yml`, `test.yml`,
  `validate-workflows.yml` and `weekly-healthcheck.yml`. The YAML sanity
  check in `validate-workflows.yml` picks the new file up automatically.
- **No test enumerates `.github/workflows`**, so adding a file cannot break
  the suite (checked before writing).

## What changed

### `.github/workflows/claude.yml` (new)

Copied **byte-for-byte** from `ezone-helpdesk` (blob `ec00836`) with no
adaptation, so all six E-ZONE copies stay diffable against one original.
It runs `anthropics/claude-code-action@v1` when `@claude` is mentioned on an
issue or pull request.

- **Owner-only trigger.** The job's `if:` gates on
  `github.actor == 'sandrabrayer'`, `&&`-ed *in front of* the four `@claude`
  mention checks (`issue_comment`, `pull_request_review_comment`,
  `pull_request_review`, `issues`), so any other account is refused before
  the mention matters. E-ZONE staff reach the helpdesk through its own
  intake, never through GitHub.
- **A skipped job is not a failed job.** A non-owner `@claude` mention
  produces no run at all. That is the intended outcome — do not "fix" a
  missing run later by loosening the `if:`.
- **Minimal permissions**, declared once at workflow level and nothing
  beyond these five: `contents: write` (push the agent's branch),
  `pull-requests: write`, `issues: write`, `id-token: write` (OIDC exchange)
  and `actions: read` (read CI results on a PR).
- **Cost cap:** `claude_args: '--max-turns 15'` — a runaway conversation
  stops on its own.
- **Credential:** referenced only as
  `${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`. No value is hard-coded and no
  other secret is named in the file.

## Setup required after merge

**`CLAUDE_CODE_OAUTH_TOKEN` is not yet set on this repo** — its Actions
secrets currently hold only `APP_PIN`, `CLASPRC_JSON` and `DEPLOYMENT_ID`.
Until it is added the workflow is inert: a run starts and the action fails
to authenticate. Add it under **Settings → Secrets and variables → Actions →
New repository secret**, name exactly `CLAUDE_CODE_OAUTH_TOKEN`, value from
`claude setup-token` (run it in a terminal; the value should not be pasted
into a chat or a file). The GitHub App itself is already installed
account-wide, so there is nothing else to install.

## Scope

Workflow file plus this changelog. **No application code, no
`apps-script/Code.gs` change (so no clasp redeploy), no frontend asset (no
SW cache bump), no new dependencies, no new env vars, no other file.**
Railway is untouched and unaffected — this workflow never deploys anything.

The full contract and rationale — trigger table, why owner-only, the
permission set line by line, secret rotation, and the replication checklist —
live in `docs/github-actions.md` in `ezone-helpdesk`. That path does not
exist here; the copied file's header comment points at it deliberately, so
the contract has one home rather than six drifting copies.
