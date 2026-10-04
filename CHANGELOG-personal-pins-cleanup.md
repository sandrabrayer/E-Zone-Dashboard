# Personal PINs — PR C: shared code removed, roles enforced, healthcheck token

Plan: `docs/billing-control-plan.md` §11 (status 04/10/2026) and §11.5
decisions 3–5. Builds on PR A (#162), PR B (#168), the restricted view (#169)
and #170/#171. Branch `feat/personal-pins-cleanup` → base
`claude/build-ezone-dashboard-QOg5s`. `apps-script/Code.gs` changes in its own
commit (clasp CI deploys it on merge). Service worker `CACHE_VERSION`
v28 → **v29**.

**What users see after this PR:**

- The login screen has no «כניסה עם הקוד המשותף» link, and nobody sees the
  «מי מתחבר/ת?» picker or the amber banner again.
- Shiran and Yael no longer see delete, void or cancel buttons. Vered and
  Sandra see them as before.
- Only Sandra sees «ביטול סימון הכפילות».

Nobody loses access: `APP_PIN_UNTIL` was never set in Railway, so the shared
code was already refused, and all four users have personal codes.

> ⚠️ **Do the "For Sandra" steps (below) right after merging.** Until
> `HEALTHCHECK_TOKEN` is in Railway **and** in GitHub, the Saturday
> healthcheck fails and emails you. It has been failing since #168 anyway.
> Nothing else depends on these steps.

## Read-only investigation (2026-10-04)

| Claim | Verified |
|---|---|
| The shared code is already refused in production | ✅ Sandra: `APP_PIN_UNTIL` was never set. On the base branch an unset window = `sharedPinWindow('')` → `closed (unset)`, so every `{ pin }` login answered `403 shared_pin_closed`, and every shared cookie answered 401. Removing the path changes nothing for a real user. |
| All four users have personal codes | ✅ Sandra (stated). `/api/login-users` lists only active records. |
| The weekly healthcheck fails since #168 | ✅ `scripts/healthcheck.js` posted `{ pin: APP_PIN }` → `403 shared_pin_closed` → no cookie → CRITICAL → exit 1. |
| Roles were defined but never enforced | ✅ `handle_` called no `roleAllowed_` (PR A pinned that with a test). Un-void was checked only by name (`סנדרה`) plus a verified proxy. |
| Which client controls perform each `DELETE_ACTIONS` operation | ✅ See the table below. No refund-exception or write-off UI exists yet (Phase 1/2). |
| The SW version on the deploy branch | ✅ `v28` (#170) → this PR `v29`. |

| Operation | Role | Client control |
|---|---|---|
| `removeLead` | deleter | lead card «הסר» |
| `deletePatientRow` | deleter | patient row «✕» (מחק לצמיתות) |
| `deleteBillingOverride` | deleter | גבייה row «↩» (back to the base amount) |
| `deleteMeetingReport` | deleter | «מחיקת דיווח» on the manager report block |
| `voidPayment` (savePayment, status void) | deleter | שיוך תשלומים «כפילות» |
| `cancelCredit` (saveCredit, status cancelled) | deleter | the credits modal's «בוטל» status option |
| `unvoidPayment` | approver | «ביטול סימון הכפילות» |
| `approveRefundException`, `writeOffOpeningBalance`, `acceptOpeningBalance` | approver | none yet (Phase 1/2) — refused by both servers already |

## What changed

### 1. The shared-code path is removed (`server.js`, `lib/`)

- **Removed:**
  - `APP_PIN`
  - `APP_PIN_UNTIL` and `lib/shared-pin-window.js` (the file is deleted)
  - `sharedLogin`
  - `validateSessionUser` / `sanitizeSessionUser` and `SESSION_USERS`, the
    picker's allow-list
  - `SHARED_SESSION_ROLES` / `SHARED_SESSION_CAPABILITIES`
  - the `shared` field of `/api/login-users` and `sharedUntil` on `/api/me`
- **A cookie without a personal id (`auth:'shared'`) → 401.**
  `lib/users.js resolvePrincipal` returns `null` for it, so `requireSession`,
  `/api/me`, `/api/sheets`, the exports and the admin routes all answer 401.
  The lookup now reads own properties only, so an id such as `constructor` is
  no record.
- **`POST /api/verify-pin` without `userId` → `400 user_required`.** No PIN is
  checked, no cookie is minted and nothing is counted: there is no shared code
  left to guess.
- **Startup:** the server starts with `APP_PIN` unset and says nothing about
  it. If `APP_PIN` or `APP_PIN_UNTIL` is still set in Railway, the log prints
  **one** warning, `[config] APP_PIN ... is set but ignored — the shared code
  was removed ... Delete it in Railway.` It names the variables, never a
  value.
- `lib/session.js` still reads the no-id token format, which the
  meeting-report scope cookie uses. The dashboard simply refuses it.
- **`/api/me`** now answers `{ ok, user, auth, approver, deleter, finance }`.

### 2. Roles enforced

**`apps-script/Code.gs` (own commit) is the authority:**

- `handle_` runs `roleOperationFor_` → `roleAllowed_` in front of every
  dispatch, right after the finance check:
  - a `DELETE_ACTIONS` operation needs a verified **`deleter`**
  - an `APPROVER_ACTIONS` operation needs a verified **`approver`**: only
    Sandra's personal session (`hasRole_`)
- **Refused** → `{ ok:false, error:'forbidden_role', message:'אין הרשאה לפעולה זו' }`
  before any read or write. The log line is
  `[role] forbidden_role user=<id> op=<operation>`: the id and the operation
  only.
- **The un-void** (`unvoidPayment`) is decided in `upsertPayment_` against the
  stored row. It now needs the verified approver role (`ctx.approver`, from
  `hasRole_` in `handle_`) **and** her cookie name. It gets the same
  `forbidden_role` answer and the same log line.
- **A stale `proxyAuth:'shared'`** is treated as `'none'`: no role and no
  capability (`proxyActor_`, `actorCaps_`).
- **A call without a valid `PROXY_SECRET`** holds no role. In log mode it can
  therefore never delete, void, cancel or approve.

**`server.js` mirrors the check first (defense in depth):**

- `lib/role-scope.js` holds the same two lists, pinned equal to Code.gs by a
  test, plus the same operation classifier.
- `requireRoleForAction` sits on `GET` and `POST /api/sheets`, after the
  finance check and before anything is proxied. A refusal answers
  **HTTP 403** with the same body, logged as
  `[role] 403 user=<id> op=<op> needs=<role>`.
- The un-void is the one operation only Code.gs can see, because it needs the
  stored row.

**Client (`public/app.js`, `public/style.css`):**

- `state.deleter` and `state.approver` come from `/api/me`. Both are `false`
  until it answers, so no control is offered early.
- Each control in the table above:
  - is rendered only when `canDelete()` (or `canReverseVoid()`) is true
  - carries `data-role="deleter"` or `"approver"`
  - is hidden by CSS unless `<body>` has `role-deleter` / `role-approver`
- Each handler re-checks and shows «אין הרשאה לפעולה זו».
- The credits modal offers «בוטל» only to a deleter, or when the line is
  already cancelled.
- `canReverseVoid()` = the approver session **and** Sandra's name.
- When `/api/me` changes the roles, the page re-renders once.

### 3. The healthcheck credential (`HEALTHCHECK_TOKEN`)

- **New route `GET /api/healthcheck?action=getData`**, with
  `Authorization: Bearer <HEALTHCHECK_TOKEN>`:
  - **Read-only:** the only action is `getData` (no action = getData; any
    other → `400 bad_action`).
  - **No principal:** it is proxied with no principal, so Code.gs and the
    server both serve the **restricted** getData (no `billingOverrides`,
    nothing billing).
  - **No session:** it never sets or reads a cookie, and the token opens no
    other route.
  - **Constant-time compare:** `lib/pin.js checkPin` (SHA-256 both sides,
    `timingSafeEqual`).
  - **Rate-limited:** 10 calls per IP and 20 in total per 15 min, counted on
    every call before the token is looked at → `429` with `Retry-After`.
  - **Never logged:** the request logger prints the path only, nothing prints
    a header, and the token never reaches Apps Script.
  - **Disabled** (`404 healthcheck_disabled`) when the variable is unset or
    shorter than 32 characters. The startup log says which.
  - **`Cache-Control: no-store`.**
- **`scripts/healthcheck.js`:**
  - It reads `HEALTHCHECK_TOKEN` (and refuses one shorter than 32 characters,
    without printing it).
  - It calls the new route instead of logging in.
  - A 401 says the GitHub secret does not match Railway; a 404 says the
    Railway variable is missing.
  - The expected top-level keys are the restricted getData's.
- **`.github/workflows/weekly-healthcheck.yml`** passes
  `secrets.HEALTHCHECK_TOKEN` instead of `secrets.APP_PIN`.

### 4. Docs

- `EZONE-ECOSYSTEM-STATUS.md`: a new section, plus the stale `APP_PIN` lines
  updated.
- `docs/billing-control-plan.md` §11: a status block, "the shared code was
  removed on 2026-10-04".
- `DEPLOY.md`: a new Railway variable table for the login and the healthcheck.

### 5. Service worker

`CACHE_VERSION` v28 → **v29**, so no phone keeps the shared login. Every
`/api/` route, including `/api/healthcheck`, stays network-only.

## Tests

- **New: `test/personal-pins-cleanup.test.js`**, 27 tests:
  - **The shared path:**
    - a shared cookie (named, unnamed, even "סנדרה") → **401** on `/api/me`,
      `/api/sheets` (GET and POST), the exports and the admin routes, with
      nothing proxied
    - `{ pin }` → **400 user_required**, no cookie, even with `APP_PIN` set
    - the server starts with `APP_PIN` unset, and set → **one** "ignored"
      warning, never the value
    - `resolvePrincipal` → `null`; no shared constant survives;
      `lib/shared-pin-window.js` is gone
  - **deleter (server):**
    - every `DELETE_ACTIONS` operation → **403** for Shiran and Yael, with
      nothing proxied (the billing ones meet the finance lock first)
    - logged as `user=<id> op=<op>`, with no names in the log
    - a narrowed Vered (no deleter) is refused the billing deletes by the
      role lock
    - Vered and Sandra are served every one
  - **approver (server):** `APPROVER_ACTIONS` pass for Sandra's personal
    session only (GET and POST).
  - **`/api/me`:** `deleter` / `approver` / `finance` per user.
  - **Code.gs, in log and enforce mode:**
    - every delete → `forbidden_role` for Shiran, Yael and a narrowed Vered,
      and **not one cell moves** (a full snapshot of every sheet)
    - logged with the id and the operation only
    - Vered and Sandra may delete, void and cancel
    - un-void: Sandra only. Refused for Vered, for Vered claiming approver,
      and for a Vered session carrying Sandra's name.
    - the other approver operations are refused before dispatch for everyone
      but Sandra
    - a stale `shared` auth → no role, no capability
    - **getData keys unchanged**
    - `lib/role-scope.js` equals Code.gs, list for list and classifier for
      classifier
  - **The healthcheck:**
    - the right token → 200, restricted getData, **no cookie**, no-store,
      proxied with no principal, the token never logged or forwarded
    - wrong / missing / truncated / extended / `Basic` / lower-case `bearer`
      → **401** with `WWW-Authenticate: Bearer`
    - a write action → 400
    - POST → 404
    - the token opens no other route (401)
    - disabled (404) when unset or short
    - 429 after 10 per IP, even with the right token
    - `bearerToken` / `healthcheckAuthorized` fail closed
    - the workflow references `secrets.HEALTHCHECK_TOKEN`
  - **UI:**
    - the `<body>` role classes per session and the CSS rule
    - nothing offered before `/api/me`
    - «מחיקת דיווח» for a deleter only (rendered)
    - every control gated and tagged, and every handler re-checks (source)
    - «בוטל» for a deleter only
  - **SW:** v29, and `/api/healthcheck` is network-only.
- **New helpers** (not tests):
  - `test/helpers/personal-session.js`: real `USER_PIN_HASHES` records and
    personal cookies, synchronously
  - `test/helpers/gs-sandbox.js`: the Code.gs vm harness, shared
- **Updated** (each pinned the shared path or an unverified delete on
  purpose):
  - **Server tests that used a shared cookie now use personal ones:**
    - `api-auth`
    - `debt-aging-ui`
    - `xlsx-export`
    - `meeting-report-server`
    - `proxy-secret-transition`
    - `patient-who-when`
    - `restricted-view`
  - **The shared-login, window, picker and banner tests now pin that they are
    gone:**
    - `personal-pins-foundation`
    - `personal-pins-login`
    - `name-picker-conflicts`
  - **Code.gs harness tests that call `handle_` directly now carry Vered's
    verified deleter actor:**
    - `audit-log-dedupe`
    - `house-move-lead-linked`
    - `meeting-report-guard-compat`
    - `patients-merge-dont-drop`
  - **Un-void and void UI tests:**
    - `duplicate-payment-void`: the approver context; the refusal is now
      `forbidden_role`; the server mirror classifies but never writes
    - `detached-payments`: «כפילות» needs `canDelete()`
    - `duplicate-payment-void-browser`: the seeded session carries the roles
      `/api/me` would give it
  - **vm/browser client tests set the deleter role, as `/api/me` does:**
    - `billing-override-*`
    - `meeting-report-edit-delete`
    - `meeting-report-leads-only`
    - `lock-busy-frontend`
    - `optimistic-gap` and `optimistic-gap-browser`
  - **The healthcheck tests use the token:**
    - `weekly-healthcheck` (also: the workflow uses the secret, the script
      knows no `APP_PIN`)
    - `healthz-deploy-identity`
  - **The browser suites** (real Chromium, 360 px):
    - `personal-pins-login-browser`: no shared path; Shiran logs in and gets
      no role class
    - `restricted-view-browser`: Vered and Sandra get the role classes;
      approver is Sandra only
  - **SW pins:** `cleanup-workbook` now pins "v28 or later".
- **Full suite: see the PR** (every browser test runs, 0 skipped).

## Choices I made (ambiguous points — the safest reasonable option)

1. **`POST /api/verify-pin` without `userId` → `400 user_required`**, and
   **nothing is counted** against the PIN limits. No PIN is checked, so a
   pin-only request cannot test anything. Counting it would only let anyone
   lock the IP bucket for real users.
2. **One warning for `APP_PIN` and `APP_PIN_UNTIL` together** (the ask named
   `APP_PIN`). Both are dead values worth deleting. The warning names the
   variables only, never a value.
3. **The healthcheck reads the *restricted* getData** (no principal → no
   `finance`). The token does not identify a person, so it gets no billing
   data (least privilege). The healthcheck therefore no longer checks for the
   `billingOverrides` key. Every other key, column and data-quality check is
   unchanged.
4. **A new route, `GET /api/healthcheck`**, rather than letting a bearer token
   into `requireSession`. The token opens exactly one read-only action and can
   never mint, replace or ride a session. It is disabled (404) without a token
   of at least 32 characters.
5. **Healthcheck limit: 10 per IP + 20 in total per 15 minutes, counted on
   every call**, before the token check (the job makes one call a week).
6. **The server mirror refuses with HTTP 403**, the same status as the finance
   lock, with Code.gs's exact body. The un-void stays Code.gs-only, because
   the server cannot see the stored row.
7. **Code.gs refuses a delete from a caller without a valid `PROXY_SECRET`**
   (log mode). Such a caller holds no role. Enforce mode is live and already
   blocks it at the gate, so no real caller is affected.
8. **The un-void needs the approver role *and* Sandra's cookie name.** The name
   check was the old rule and is kept as a second condition. Its refusal is now
   `forbidden_role` with «אין הרשאה לפעולה זו», replacing «החזרת כפילות מותרת
   לסנדרה בלבד».
9. **A stale `proxyAuth:'shared'` in Code.gs = `'none'`** (no role, no
   capability), rather than an error. The current server never sends it. A
   legacy body without `proxyAuth` keeps its old full view and holds no role,
   so it still cannot delete.
10. **«בוטל» (`cancelCredit`) is hidden from the credits modal for a
    non-deleter**, unless the line is already cancelled, so its stored state
    still shows. In practice only Vered and Sandra (both deleters) can open
    that modal.
11. **Only the existing controls are gated.** There is no refund-exception or
    write-off UI yet. When it is built, it must carry `data-role="approver"`
    (the CSS and the server already handle it).
12. **`lib/session.js` keeps the no-id token format**, which the
    meeting-report cookie uses. The dashboard refuses it in `resolvePrincipal`.
13. **The branch is `feat/personal-pins-cleanup`**, as asked. Its base is the
    deploy branch.

## For Sandra — after merging

> Keep the token only in Railway, GitHub and your password manager. Never
> put it in WhatsApp, email or a chat with Claude.

### 1. Make the token (Chrome, your computer)

1. Open any page. Press **F12** (Mac: **⌥⌘J**) and click the **Console** tab.
2. Paste this line and press **Enter**:

   ```js
   btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
   ```

3. It prints 64 letters and digits. Copy them **without the quotes**. This is
   the `HEALTHCHECK_TOKEN`.

(On a Mac, Terminal also works: `openssl rand -hex 32`.)

### 2. Railway — add it

1. **railway.app** → project **E-Zone Dashboard** → the **web service** →
   **Variables**.
2. **+ New Variable** → Name `HEALTHCHECK_TOKEN`, Value = the token → **Add**.
3. **Deploy** / **Apply changes**. The deploy log no longer shows
   `HEALTHCHECK_TOKEN is not set`.

### 3. GitHub — add the same token as an Actions secret

1. **github.com/sandrabrayer/E-Zone-Dashboard** → **Settings** → **Secrets and
   variables** → **Actions**.
2. **New repository secret** → Name `HEALTHCHECK_TOKEN`, Secret = **the same
   token**, character for character → **Add secret**.

### 4. Check it

1. Still in GitHub: **Actions** → **Weekly Healthcheck** → **Run workflow** →
   **Run workflow**.
2. After about a minute it should be **green**. If it is red:
   - `HTTP 401` → the two values differ. Paste the token again in both
     places.
   - `HTTP 404` → the Railway variable is missing or shorter than 32
     characters.

### 5. Remove `APP_PIN` from both places

1. **Railway** → **Variables** → `APP_PIN` → **⋮** → **Remove**. If
   `APP_PIN_UNTIL` is there, remove it too. Then **Deploy**. The log line
   `APP_PIN ... is set but ignored` disappears.
2. **GitHub** → **Settings** → **Secrets and variables** → **Actions** →
   `APP_PIN` → **Remove** → confirm.

Nothing else changes for you: logins, `USER_PIN_HASHES` and `PIN_PEPPER` stay
exactly as they are.

### Rotating the token later

Make a new one (step 1), then put it in Railway (step 2) and GitHub (step 3),
in either order. A run that happens between the two edits fails once.
