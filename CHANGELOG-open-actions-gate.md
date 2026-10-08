# Open-actions allowlist + caller classes — Phase 0b-2 (LOG mode)

Plan: `docs/billing-control-plan.md` §11.1. Branch `feat/scoped-caller-secrets`
(PR #155) → base `claude/build-ezone-dashboard-QOg5s`. Only
`apps-script/Code.gs` changes code (its own commit). There is no `public/`
change, so no `CACHE_VERSION` bump.

**Decision (PR #155 review): Managers and Therapists need ZERO changes.** The
earlier scoped caller secrets (`MANAGERS_CALLER_SECRET`,
`THERAPISTS_CALLER_SECRET`, `CALLER_SCOPES`, `generateCallerSecretsNow`) were
dropped. Instead, a fixed list of actions stays open without `PROXY_SECRET`,
and everything else will need `PROXY_SECRET` once enforcement is switched on
(Phase 0b-3). **In log mode, nothing is refused by this PR.**

## Why these four actions

Read-only investigation on 2026-10-01 of each consumer's **deployed** branch.
Neither repo was changed.

| Consumer | Repo @ deployed branch | Calls on this backend | How |
|---|---|---|---|
| Managers | `ezone-managers` @ `main` (b779e22) | `managersOverview`, `managersHouse`, `occupancySnapshots` | `public/app.js` → `server.js` `GET /api/sheets` proxy → `APPS_SCRIPT_URL`, no secret. The repo has no Apps Script. |
| Therapists | `ezone-therapists` @ `claude/inspiring-tesla-jipobw` (95195e3) | `getAdmittedRoster` | `server.js:1438` `proxyGet(DASHBOARD_SHEETS_URL, 'getAdmittedRoster', OCCUPANCY_SECRET, …)`, a GET with `?secret=`. Its `apps-script/Code.gs` `UrlFetchApp` calls go to Outpatient (9) and Staffing (1) only, none here. |

`claude/handoff-2026-10-01.md` does not exist on any branch of this repo. The
work used `EZONE-ECOSYSTEM-STATUS.md`, the plan and the code.

## What changed (`apps-script/Code.gs`)

- **One constant:**
  ```js
  const OPEN_ACTIONS = ['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster'];
  ```
  These are served **without `PROXY_SECRET` in both log and enforce mode**,
  exactly as they are served today. `getAdmittedRoster` still requires its own
  `ADMITTED_ROSTER_SECRET` inside `handle_`.
- **Every other action is gated by `PROXY_SECRET` under
  `PROXY_SECRET_MODE`.** That covers GET or POST, `getData`, every write and
  every future billing action:
  - `log`: served and logged.
  - `enforce`: `{ok:false,error:'unauthorized'}`, and nothing is written.
- `PROXY_SECRET_EXEMPT_ACTIONS` is **removed**. Its other four actions are no
  longer exempt:

  | Actions | Effect |
  |---|---|
  | `meetingReportLeads`, `submitMeetingReport` | No change in practice: Dashboard `server.js` already sends `PROXY_SECRET` on these calls. |
  | `accountingPayments`, `accountingCredits` | **⚠ Will be refused in enforce mode** unless the accounting app sends `PROXY_SECRET`, or they are added to `OPEN_ACTIONS`. **Decide before 0b-3.** Log mode is unaffected, and the report below counts these calls. |

  All four keep their own secret check inside `handle_`.
- **Caller classes** (`callerClass_`):

  | Class | Meaning |
  |---|---|
  | `proxy` | a valid `PROXY_SECRET` (the Dashboard) |
  | `open` | no valid `PROXY_SECRET`, on an `OPEN_ACTIONS` action |
  | `none` | no secret, on a gated action |
  | `wrong` | a secret that isn't `PROXY_SECRET`, on a gated action |

  `PROXY_SECRET` is compared in constant time; when it is unset, nothing is
  `proxy`.
- **`SecurityLog`:**
  - It gains an **appended** `callerClass` column. Existing columns are never
    reordered, and `getOrCreateSheet_` adds the header cell on the existing
    tab.
  - Open-action traffic is logged as `open`, one row per action per hour, so
    the other apps' calls are visible.
  - `none` and `wrong` on gated actions share the 0b-1 bucket, one row per
    action per hour.
  - Proxy traffic stays unlogged; `user_mismatch` is logged as before.
  - `callerType` keeps its meaning: `no_secret` / `bad_secret` /
    `user_mismatch`.
  - **No secret value is ever written.**
- **`securityCallersReportNow()`** groups by **action × callerClass**. Rows
  written before this PR have no class; it is derived (an open action →
  `open`, `user_mismatch` → `proxy`, otherwise `none`/`wrong`). It also prints:

  > `non-open actions without a valid secret: N`

  N is the number of `none`/`wrong` hours in the last 7 days on actions
  outside `OPEN_ACTIONS`. Every one of those requests would be refused in
  enforce mode, so **N must be 0 before Phase 0b-3.**
- **Every own-secret check is now constant-time**
  (`constantTimeEquals_(got, expected)`): `admittedRosterAuthOk_`,
  `meetingReportAuthOk_` and `accountingAuthOk_`. They previously used
  `got === expected`. Each still fails closed when its Script Property is
  unset.

## Known items for later phases (not changed here)

1. **The Managers proxy `getData` passthrough is closed by enforcement in
   0b-3.** The Managers `server.js` proxy allowlists query *keys*, not
   `action` *values*, so a browser can send `?action=getData` (or any action)
   through it to this backend. Today that is served. With
   `PROXY_SECRET_MODE=enforce` every non-open action without `PROXY_SECRET`
   is refused, which closes the hole with no change to Managers.
2. **Therapists still sends the roster secret in the URL**
   (`?secret=` on `getAdmittedRoster`). This is a known item for a later
   Therapists PR (send it in a POST body). It is not changed here, so
   Therapists keeps working untouched.
3. **The accounting feed** (`accountingPayments`, `accountingCredits`): see
   the warning above.

## Tests

- **New:** `test/open-actions-gate.test.js` (11 tests). 8 fail against the
  previous `Code.gs`; the other 3 are guards that must hold before and after
  (`getAdmittedRoster` open with its own secret, no secret leaks, `getData`
  keys). It covers:
  - `OPEN_ACTIONS` pinned to exactly those 4, and the dropped scoped-secret
    names are gone
  - the 4 open actions are served without a secret in log **and** enforce,
    GET and POST, and logged as `open`
  - `getAdmittedRoster` still requires its own secret
  - `getData`, `saveAll` and `savePayment` without a secret: logged in log
    mode, refused with nothing written in enforce mode, served with
    `PROXY_SECRET`
  - every non-open action, and any future one, is gated
  - `getData` via GET is gated, and a secret in the URL doesn't count
  - the 4 classes
  - the report, including the exact summary line
  - no secret in any log, row, cache key, response or report
  - `getData` keeps every key
- **Updated:** `test/proxy-secret-transition.test.js`, 5 tests, all for the
  contract above:
  - the 7-column header and class `open`
  - the meeting-report and accounting actions are gated in enforce mode
  - the "no plain `===`" guard now covers **all of `Code.gs`** and asserts
    the three own-secret checks are constant-time
  - `OPEN_ACTIONS` is a subset of the known actions
  - the report is grouped by class, with N = 0
- **Removed:** `test/scoped-caller-secrets.test.js` (its feature was dropped).
- **Full suite:** 1670/1670.

## For Sandra

**Nothing to set now.** No new Script Property, no Railway variable, and no
change to Managers or Therapists.

Before Phase 0b-3, run **`securityCallersReportNow`** from the Apps Script
editor and read the last line: `non-open actions without a valid secret: N`.
It must be **0**. If it isn't, the lines above it show which action and class.
For example, `accountingPayments · none` means the accounting app still calls
without `PROXY_SECRET`.
