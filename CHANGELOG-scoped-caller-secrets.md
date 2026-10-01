# Scoped caller secrets — Phase 0b-2a (LOG mode)

Plan: `docs/billing-control-plan.md` §11.1 ("the same backend serves Managers
and Therapists… map which actions they call and give them the secret").
Branch `feat/scoped-caller-secrets` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` only (its own commit); no `public/` change, so no
`CACHE_VERSION` bump.

**Nothing is rejected by this PR.** It adds two secrets, classifies every
request, and logs the class. Enforcement is Phase 0b-3.

## 1. Investigation (read-only, 2026-10-01)

### a. The PR #153 mechanism this builds on

| Item | Value |
|---|---|
| Field and transport | `proxySecret`, **POST JSON body only**. `collectParams_` drops it from the querystring, so a secret in a URL counts as missing. `server.js` also sends `proxyUser` (the session user). |
| Compare | `constantTimeEquals_` against Script Property `PROXY_SECRET`. |
| Mode | Script Property `PROXY_SECRET_MODE`: unset or `log` → serve and log. `enforce` → `{ok:false,error:'unauthorized'}` and nothing written. Any other value → `enforce`. |
| Exempt (own secret) | `getAdmittedRoster`, `meetingReportLeads`, `submitMeetingReport`, `accountingPayments`, `accountingCredits`. Never refused by the gate. |
| `SecurityLog` | Append-only. Columns: `timestamp, action, method, secretPresent, callerType, hourKey`. `callerType` = `no_secret` / `bad_secret` / `user_mismatch`. At most one row per action per hour. Action names outside `PROXY_KNOWN_ACTIONS` are logged as `(unknown)`. |
| `securityCallersReportNow()` | Editor-run and read-only. 7-day summary by action × callerType. |

### b. What each consumer calls on this backend

Read from the **deployed** branch of each repo. Neither repo was changed.

| Consumer | Repo @ deployed branch | Calls | How |
|---|---|---|---|
| **Managers** | `ezone-managers` @ `main` (b779e22) | `managersOverview`, `managersHouse`, `occupancySnapshots` | `public/app.js` `fetchJson('/api/sheets?action=…')` → `server.js` `GET /api/sheets`. That handler forwards **GET** with a query-**key** allowlist (`action`, `house`, `month`) to `APPS_SCRIPT_URL`. The repo has no `apps-script/`, so there is no `UrlFetchApp`. |
| **Therapists** | `ezone-therapists` @ `claude/inspiring-tesla-jipobw` (95195e3) | `getAdmittedRoster` | `server.js:1438` `proxyGet(DASHBOARD_SHEETS_URL, 'getAdmittedRoster', OCCUPANCY_SECRET, …)`, a **GET** with `?secret=` in the URL. The README notes it has no UI consumer since the inpatient tab was removed. Its `apps-script/Code.gs` has 10 `UrlFetchApp.fetch` calls, all to `OUTPATIENT_SHEETS_URL` (9) or `STAFFING_SHEETS_URL` (1), **none to this backend**. |

Findings for later phases. They are not fixed here, to keep this PR in scope:
1. **The Managers proxy is open to any action.** It allowlists query *keys*,
   not `action` *values*, so a browser can send `?action=getData` through it.
   Phase 0b-3 closes that: with a scoped secret it becomes `out_of_scope` and
   will be refused.
2. **Both consumers use GET.** The scoped secret uses the same transport as
   `PROXY_SECRET` (POST body), so each consumer needs a small change to send
   it (Phase 0b-2b, in their repos).
3. **The own-secret checks** (`admittedRosterAuthOk_`, `meetingReportAuthOk_`,
   `accountingAuthOk_`) compare with `got === expected`, which is not
   constant-time. Therapists also sends its `getAdmittedRoster` secret in the
   URL.
4. **`claude/handoff-2026-10-01.md` does not exist** on any branch of this
   repo. The work used `EZONE-ECOSYSTEM-STATUS.md`, the plan and the code.

## 2. What changed (`apps-script/Code.gs`)

- Two new Script Properties, in `CALLER_SECRET_PROPS`:
  - `MANAGERS_CALLER_SECRET`
  - `THERAPISTS_CALLER_SECRET`

  Each unlocks **only** its own list in a single constant:
  ```js
  const CALLER_SCOPES = {
    managers:   ['managersOverview', 'managersHouse', 'occupancySnapshots'],
    therapists: ['getAdmittedRoster'],
  };
  ```
- `PROXY_SECRET` is unchanged: full access, for the Dashboard only.
- The scoped secrets use the **same field and transport** (`proxySecret`,
  POST body only), so a client sends one value either way.
- `callerClass_(action, presented, props)` classifies every request:

  | Class | Meaning |
  |---|---|
  | `proxy` | `PROXY_SECRET` |
  | `managers` | `MANAGERS_CALLER_SECRET` on an action in `CALLER_SCOPES.managers` |
  | `therapists` | `THERAPISTS_CALLER_SECRET` on an action in `CALLER_SCOPES.therapists` |
  | `out_of_scope` | a valid scoped secret on any other action, including Dashboard-only ones such as `getData` and `saveAll` |
  | `wrong` | a secret that matches nothing |
  | `none` | no secret |

  It always compares against **every** configured secret, in constant time
  and with no early exit, so the time taken doesn't reveal which one matched.
  An **unset or blank** property is skipped: it never matches, not even an
  empty value (fail closed).
- **`SecurityLog` gains an appended `callerClass` column.** The existing
  columns are never reordered, and `getOrCreateSheet_` adds the header cell on
  existing tabs. Logging rules:
  - **Proxy traffic stays unlogged**, as in 0b-1.
  - Every other class is logged, at most once per (bucket, action, hour).
  - `none` and `wrong` share one bucket ("one row per action per hour", as
    before).
  - Each scoped class has its own bucket, and so does `user_mismatch`.
  - `callerType` keeps its meaning (`no_secret` / `bad_secret` /
    `user_mismatch`) and gains `scoped_secret`.
  - **Own-secret (exempt) actions are now classified and logged too.** That is
    how Therapists' `getAdmittedRoster` becomes visible. They are still never
    refused by the gate.
- **`securityCallersReportNow()`** groups by **action × callerClass**. A row
  written before this PR has no class, so it is derived from `callerType`
  (`no_secret` → `none`, `bad_secret` → `wrong`, `user_mismatch` → `proxy`,
  counted in `userMismatchHours`).
- **No secret value is ever logged.** The class is derived before the secret
  is stripped from the params, and only the class name is written.
- **LOG mode only: serving is unchanged for every class.** A scoped secret is
  not a proxy secret, so its requests take exactly the path they took before:
  - in `log` mode they are served, and their body `user` is not trusted;
  - in `enforce` mode they are refused on gated actions, exactly as any
    non-proxy request already was.
- New editor-run **`generateCallerSecretsNow()`**:
  - For each of the two properties that is **unset**, it stores a fresh
    secret: 32 bytes from SHA-256 over two v4 UUIDs, URL-safe base64, 43
    characters.
  - It shows the value **once**, in `SpreadsheetApp.getUi().alert`.
  - It **never overwrites** an existing property, and never shows its value.
  - It **never writes a value** to Logger, console or a sheet; only names
    and counts are logged.
  - If the dialog can't open, it logs (without the value) that the values are
    in Project Settings → Script Properties.

## 3. Tests

- **New:** `test/scoped-caller-secrets.test.js` (15 tests). It covers:
  - every class is detected
  - the appended column, with the header order unchanged
  - a scoped secret on the other scope's action, or on Dashboard actions →
    `out_of_scope`
  - unset or blank property → no match
  - every configured secret is compared, every time
  - log mode never rejects
  - serving is unchanged per class, enforce mode included
  - no secret in any log line, `SecurityLog` row, cache key, response or
    report
  - report grouping by action × class
  - the generator: creates both, never overwrites, never logs, and handles a
    missing UI
  - `CALLER_SCOPES` equals the lists found in 1b
  - `getData` keeps every key

  12 of the 15 fail against the previous `Code.gs`. The other 3 are guards
  that must hold before and after: log mode never rejects, no secret leaks,
  `getData` keys intact.
- **Updated** (`test/proxy-secret-transition.test.js`, 4 assertions, all for
  the contract changes above):
  - the `SecurityLog` header has 7 columns
  - exempt actions are now logged
  - the constant-time guard follows the compare into `callerClass_`
  - the report shape is grouped by class
- **Full suite:** 1674/1674.

## For Sandra

1. **Generate the two secrets.**
   1. Open the Dashboard spreadsheet, then Extensions → Apps Script.
   2. In the function list pick **`generateCallerSecretsNow`** → **Run**.
   3. A dialog appears **in the spreadsheet tab**; switch to it. It shows
      `MANAGERS_CALLER_SECRET` and `THERAPISTS_CALLER_SECRET`.
   4. Copy each value **now**, into your password manager. The dialog won't
      show them again.
   5. If no dialog appears, the Execution log says so. The values are under
      ⚙️ **Project Settings → Script Properties**.
2. **Where each value goes:**

   | Value | Goes to | Name there |
   |---|---|---|
   | `MANAGERS_CALLER_SECRET` | Railway → the **ezone-managers** service → Variables | `DASHBOARD_CALLER_SECRET` (proposed) |
   | `THERAPISTS_CALLER_SECRET` | Railway → the **ezone-therapists** service → Variables | `DASHBOARD_CALLER_SECRET` (proposed) |

   **Neither app sends the value yet.** Each needs a small PR in its own repo
   (Phase 0b-2b) to send it as `proxySecret` in a POST body. Until then the
   variables are unused and nothing changes. Setting them now is harmless.
3. **Don't** paste a value into WhatsApp, email, GitHub or a chat. **Don't**
   reuse `PROXY_SECRET` for them: that one stays with the Dashboard only.
4. **After the 0b-2b PRs deploy**, run **`securityCallersReportNow`** after a
   few days. You should see `managers` and `therapists` rows, and no
   `out_of_scope`, before anything is enforced (Phase 0b-3).
5. **To rotate one:** delete that property in Script Properties, run
   `generateCallerSecretsNow` again (it fills only the missing one), and
   update the matching Railway variable.
