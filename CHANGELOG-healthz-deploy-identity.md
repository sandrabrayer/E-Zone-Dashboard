# Issue #120 investigation + deploy identity on `/healthz` (stale-Railway-build warning)

Node/Express + CI change (`server.js`, `scripts/healthcheck.js`,
`.github/workflows/weekly-healthcheck.yml` comment). **Zero UI change**, zero
Apps Script change (`apps-script/Code.gs` untouched), no column-list change.
Railway auto-deploys on merge to the deploy branch
(`claude/build-ezone-dashboard-QOg5s`); no clasp run is triggered.

## The report (GitHub issue #120)

Staff report from אולגה: «לא ניתן להיכנס לרובריקת "ממתין לאישור אולגה"» —
cannot open the "pending Olga's approval" rubric. The helpdesk triage attributed
the report to this repo (E-Zone-Dashboard) and pointed at the previous day's
merges (PR #118 / PR #119, the orphan-Payments reconciler) as the likely cause.

## Findings (read-only investigation — the attribution is wrong)

1. **The rubric does not exist in the Dashboard.** The string
   «ממתין לאישור אולגה» (and any «ממתין לאישור» / «אולגה» variant) appears
   nowhere in `public/`, `server.js`, `lib/` or `apps-script/Code.gs`. The
   Dashboard's screens are דשבורד, לידים, לוח פגישות, תפוסה, מטופלים משוחררים,
   גבייה, נקודת איזון, גרף צמיחה, שימור לידים — there is no approval rubric and
   nothing in this app is approved by a named person.
2. **It is the Logistics app's board column.** In
   `sandrabrayer-ezone-logistics` → `src/dashboard.html`, the request board
   groups requests by status and its first group is
   `{ key: 'pending', title: 'ממתין לאישור', statuses: [דרישה, ממתין לאישור] }`.
   The helpdesk's own Logistics guide (`ezone-helpdesk/guides/logistics.md`)
   uses the exact wording «משאירים ב"ממתין לאישור אולגה"» and names אולגה as
   the sole approver. That app's board page is served at **`/dashboard`** and
   the guide calls the screen «דשבורד» — the reporter said "דשבורד", and the
   helpdesk's `guessRepoFor('dashboard')` maps that word to `E-Zone-Dashboard`.
3. **PRs #115 / #117 / #118 / #119 cannot affect it.** #117, #118 and #119
   changed only `apps-script/Code.gs` (Patients `exitDate` normalisation, the
   Payments orphan reconciler) plus tests and changelogs; #115 added one
   `<link rel="icon">` line to `public/index.html`. The Logistics app owns its
   own Google Sheet and Apps Script (`schema.js`: house list "NOT fed from
   Dashboard"; its README: independent of the Dashboard/Managers `Code.gs` and
   deployments) and never reads this backend's Payments / Patients sheets. No
   data re-keyed or deleted by #118/#119 feeds that rubric — so this is **not**
   a data-repair situation in this repo, and no repair is proposed.
4. **Where to look instead (for whoever owns Logistics).** In that board a
   status group with zero requests is simply not rendered
   (`if (items.length === 0) return ''`), and a failed load replaces the whole
   board with «שגיאה בטעינת הדרישות». Logistics merged a large overhaul on
   2026-09-04 (its PRs #101–#103: read cache with stale fallback, one-call
   pages, budget panel, notifications) — two days before the report. The repo's
   approver logic also names רועי / sandra, while the helpdesk guide describes
   an «קוד מאשר (אולגה)» gate, so the deployed Logistics build and its repo may
   differ. That investigation belongs in the Logistics repo; nothing here is
   changed for it.
5. **Railway deploy verification could not be completed from this session.**
   The live URL is blocked by the session's egress policy (HTTP 403 from the
   proxy), and — the real gap — the app exposed no build identity at all:
   `/healthz` returned `{ ok: true }` and the served HTML carries only a random
   per-process `BUILD_ID`. Whether Railway runs the deploy-branch head could not
   be told from outside by anyone. That gap is what this change closes.

## What shipped

### A. `/healthz` reports the deployed commit and branch (`server.js`)

- `deployIdentity(env)` — pure. Reads **only** `RAILWAY_GIT_COMMIT_SHA` and
  `RAILWAY_GIT_BRANCH` (Railway injects both at build time). The commit is
  accepted only as a 7–40 hex-character sha (lower-cased); the branch is
  trimmed and capped at 200 characters. Anything else → `''`. Outside Railway
  (local, tests) both are blank.
- `healthzBody(env)` — `{ ok: true, commit, branch, build }`. `ok` is
  unchanged (Railway's `healthcheckPath` and the helpdesk monitor key on it);
  `build` is the per-process `BUILD_ID` that the served HTML already exposes,
  so a restart without a redeploy is visible.
- `GET /healthz` now returns that body. Verifying the Redeploy-doesn't-pull
  quirk is now: open `/healthz`, compare `commit` with the deploy branch head
  on GitHub.

**Security:** the route is unauthenticated (it always was). A commit sha and a
branch name are public facts of a public repository; the helper cannot surface
any other environment value (locked by a test that seeds `SESSION_SECRET`,
`APP_PIN`, `MEETING_REPORT_SECRET`, `SHEETS_URL`, `RAILWAY_DEPLOYMENT_ID` and
asserts none of them reaches the body). Values are validated, not echoed.

### B. Weekly healthcheck: stale-Railway-build **WARNING** (`scripts/healthcheck.js`)

- New step 0 in `run()`: `GET /healthz`, then `checkDeployIdentity(status,
  body, GITHUB_SHA)`. On a scheduled run `GITHUB_SHA` is the deploy-branch head
  the workflow checked out (`actions/checkout`); no workflow change is needed.
- Outcomes — **never critical**, in keeping with "fail only on real breakage":
  | Case | Result |
  |---|---|
  | live commit ≠ `GITHUB_SHA` | ⚠️ warning: `Railway is running a STALE build…` naming both shas + branch |
  | live commit = `GITHUB_SHA` (prefix match, case-insensitive, so short and full shas agree) | note |
  | `/healthz` has no commit (older server, `RAILWAY_*` unset) / not JSON / no `GITHUB_SHA` | note |
  | `/healthz` non-200 or the request fails | warning (the shell check already covers "app down") |
- Header comment in `weekly-healthcheck.yml` lists the new warning; the
  workflow steps are unchanged.

## Rules worth remembering

- `/healthz` must keep `ok: true` as its first, unconditional field — external
  monitors depend on it.
- `deployIdentity` must never be widened to pass arbitrary env through; add a
  field only with the same validate-don't-echo treatment and a leak test.
- A stale-build finding is a WARNING by design (Sandra reads the job summary);
  escalate to CRITICAL only by explicit decision, since it would e-mail on
  every scheduled run until Railway is redeployed.
- Staff reports that say «דשבורד» can mean the Logistics board (`/dashboard`)
  — check the wording of the rubric before assuming this repo.

## Tests (`node --test`, no network)

`test/healthz-deploy-identity.test.js` (17 tests):

- `deployIdentity`: valid sha + branch pass through lower-cased/trimmed; blank
  outside Railway (no / empty / non-object env); non-sha values rejected (7-char
  short sha is the minimum); oversized branch capped; **secrets never ride
  along** (seeded env, keys asserted, values asserted absent).
- `healthzBody`: `ok:true` kept, fields present, blank identity outside
  Railway, build id stable within a process.
- `checkDeployIdentity`: mismatch → one warning naming both shas and the
  branch, no `criticals` key; match → note; prefix/case-insensitive
  comparison; no live commit / legacy `{ok:true}` body → note; no `GITHUB_SHA`
  → note; non-JSON → note; non-200 → warning.
- `run()` end-to-end with an injected fetch: stale build → exit 0 and the
  warning appears in the `GITHUB_STEP_SUMMARY` report; matching build → "none"
  warnings + match note; `/healthz` fetch throwing → still exit 0.

Full suite: 913 tests pass (896 before this change + 17).
