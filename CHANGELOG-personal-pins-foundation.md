# Personal PINs — PR A: foundation (zero user-facing change)

Plan: `docs/billing-control-plan.md` §11.2, §11.3 and the new **§11.5** (every
decision Sandra locked on 2026-10-01/02). Branch `feat/personal-pins-foundation`
→ base `claude/build-ezone-dashboard-QOg5s`. No `public/` file changes, so there
is no `CACHE_VERSION` bump. `apps-script/Code.gs` is in its own commit (clasp CI
deploys it on merge).

**What users see after this PR: nothing.** Login is still the shared `APP_PIN`
and the name picker, exactly as before. The one thing that changes for real is
a security bug fix (below), and honest clients cannot tell.

## Read-only investigation (2026-10-01, re-verified 2026-10-02)

| Claim | Verified |
|---|---|
| The Dashboard PIN input is `maxlength="4"`, not 6 | ✅ `public/index.html:34`. Only `/meeting-report`'s PIN input is 6. `EZONE-ECOSYSTEM-STATUS.md` and plan §11.2 said 6. Both are corrected. |
| `pinClientIp` trusts the leftmost `X-Forwarded-For` | ✅ `server.js:844` (base). On the base branch, 12 wrong PINs with a fresh fake leftmost XFF were **all** `401`. None was ever `429`. With this PR the 11th is `429`. |
| The shared `APP_PIN` plus the name picker lets anyone act as any user | ✅ `/api/verify-pin` accepts any `SESSION_USERS` name with the one shared PIN. |
| `Code.gs` grants identity from `proxyUser` only for a valid `PROXY_SECRET` | ✅ `proxyGate_`: `p.user = trusted` only when `callerClass_ === 'proxy'`. Without a valid secret (log mode) the body `user` is kept. **It is not verified.** |

## What changed

### `server.js`: the XFF fix (ACTIVE)

- `app.set('trust proxy', 1)` (Railway's one hop). `pinClientIp` returns
  `req.ip`, which Express takes from the **rightmost** XFF entry (the one
  Railway appends). A client can still write anything to its left, but that
  is ignored now.
- `TRUST_PROXY_HOPS` (optional Railway variable, integer 0–5, default 1) is an
  escape hatch. You only need it if Railway ever adds a second hop.
- **Counter maps cleaned up.** The inline `Map`s for `/api/verify-pin` and
  `/api/meeting-report/verify-pin` are now `WindowCounter`s
  (`lib/rate-limit.js`). The semantics are the same: 10 per IP per 15 min, a
  success resets the counter, and the 429 shape and `Retry-After` header are
  unchanged. Two things are new: expired entries are swept, and the key count
  is capped at 10,000. Before, every spoofed address stayed in memory forever.

### `server.js`: foundation (not wired to login)

- **Startup validator** for `USER_PIN_HASHES` (`lib/users.js`
  `validateUserPinHashes`):
  - The variable may be unset or blank. That is today's state.
  - The server **refuses to start** on any of these: bad JSON, a non-array,
    an unknown or duplicate id, a name that doesn't match its id, an unknown
    role, a role outside the user's model (for example Shiran/Yael +
    `deleter`), **any approver other than Sandra**, a malformed hash, a bad
    `pinVersion` or `status`, or Ortal set active before Phase 4.
  - The error names the record index and the rule. It never includes a hash.
- **Principal → Apps Script.** `sheetsPost` now sends `proxyRoles`,
  `proxyAuth` (`shared` / `personal` / `none`) and `proxyUserId` from the
  signed session. Any client-sent copy is deleted first.
  - Today's shared APP_PIN session is **`staff` only**, whatever name it
    carries.
  - Meeting-report calls carry no role.
- **Cookie format with id + pinVersion**: `<expiry>.<userB64>.<id>-<v>.<sig>`
  (`lib/session.js`, `readSession`).
  - Current 2- and 3-part tokens still validate, unchanged.
  - A personal cookie is accepted only while its record is `active` with the
    **same `pinVersion`**. Reset = `pinVersion++`; revoke = `status`.
  - No route mints personal cookies yet.
- **`POST /api/bootstrap-pin`**: the one-time setup of Sandra's own record.
  - **When it is open:** only while all of these hold:
    - `BOOTSTRAP_TOKEN` is set and at least 32 characters
    - `PIN_PEPPER` is set
    - `USER_PIN_HASHES` has **no** approver
    - it has not already succeeded since the server started
  - **What it returns:** `{ ok:true, record:'<one JSON line>' }`. The record
    is always Sandra's (`id:'sandra'`, her model roles, `pinVersion:1`). The
    request cannot pick another user.
  - **Once it is closed:** `404 bootstrap_disabled`.
  - **Wrong token:** `403`. Wrong tokens count against a limit of 5 per IP and
    20 globally per 15 min, and past it the endpoint answers `429`.
  - **Weak PIN:** `400 weak_pin`. This does not count as an attempt and does
    not use up the bootstrap.
  - **Token comparison:** constant-time.
  - **The PIN** is never stored, logged or echoed.
  - **Startup warning:** the log warns on every start while `BOOTSTRAP_TOKEN`
    is set.

### `lib/` (new / extended)

- `lib/pin-hash.js`:
  - **Format:** `scrypt$16384$8$1$<salt>$<key>`, with a fresh 16-byte salt per
    hash. The key is `scrypt(HMAC-SHA256(PIN_PEPPER, pin))`.
  - **`verifyPin`** always runs exactly **one** derivation, even for a
    missing or malformed record, and compares with `timingSafeEqual`.
  - **Tampered work factors** are rejected, both downgrades and memory
    blow-ups.
  - **No pepper:** hashing throws and verification fails, so it fails closed.
- `pinPolicyError` (weak-PIN rejection): anything but 6 ASCII digits, all the
  same digit (`000000`), or a sequence up or down (`123456`, `654321`).
- `lib/users.js`:
  - the user/role model with stable ASCII ids (`vered`, `sandra`, `shiran`,
    `yael`, `ortal`)
  - `SHARED_SESSION_ROLES = ['staff']`
  - `resolvePrincipal`
  - `recordLine`
  - `SESSION_USERS` (the name picker list) is unchanged.
- `lib/rate-limit.js`:
  - `WindowCounter`
  - **`PinLockout`**: 5 failures per user → 15 min; 10 per IP per 15 min; 30
    globally per 15 min. A success never resets the global brake. **Built and
    tested, not wired.**

### `apps-script/Code.gs` (own commit)

- **Roles only from the verified proxy.**
  - `proxyGate_` strips `proxyRoles`, `proxyAuth` and `proxyUserId` (and any
    client-sent `__actor`) on every request. It sets the actor only for a
    valid `PROXY_SECRET`. Every other caller gets
    `{ verified:false, roles:[] }`. That covers no secret, a wrong secret, an
    open action, or values in the querystring.
  - `collectParams_` drops all six proxy-only fields from the querystring.
- **Role helpers:**
  - `actingUser_(params)` and `hasRole_(params, role)`.
  - Defense in depth on this side too: a shared session is capped to
    `staff`, and `approver` counts only on Sandra's personal session
    (`APPROVER_USER_ID = 'sandra'`).
- **`DELETE_ACTIONS`** (needs `deleter`):
  - `removeLead`
  - `deletePatientRow`
  - `deleteBillingOverride`
  - `deleteMeetingReport`
  - `voidPayment` (a `savePayment` / `updatePayment` that sets status `void`)
  - `cancelCredit` (a `saveCredit` that sets status `cancelled`)
- **`APPROVER_ACTIONS`** (Sandra only):
  - `unvoidPayment`
  - `approveRefundException`
  - `writeOffOpeningBalance`
  - `acceptOpeningBalance`
- **Defined, NOT enforced:** `roleOperationFor_`, `requiredRoleFor_` and
  `roleAllowed_` exist, but `handle_` calls none of them (a test pins that).
- **`AuditLog` gains an appended `actor` column.** Its value is the acting
  user's name, plus ` (unverified)` when the request had no valid
  `PROXY_SECRET`.
  - `logAudit_` takes it as an optional 6th argument. Existing 5-argument
    calls write `''`.
- **Actor stamps:**

  | Action | Stamp |
  |---|---|
  | `upsertBillingOverride_` | `updatedBy`, from the session, never the payload |
  | `deleteBillingOverride_` | `billing_override_deleted` |
  | `moveLeadIrrelevant_` | `lead_moved_irrelevant` |
  | `restoreLead_` | `lead_restored` |
  | `removeLead_` | `lead_removed` |
  | `deleteMeetingReport_` | `meeting_report_deleted` |
  | `deletePatientRow_` | `patient_deleted`, now with actor |
  | The duplicate-void marking (`payment_link_duplicate`) | `actor` |
  | The un-void (`payment_void_reversed`) | `actor` |

- **`BILLING_OVERRIDE_COLUMNS` gains an appended `updatedBy`.** Columns are
  append-only; existing rows stay blank.
- **One tightening, which no user can see.** An un-void whose body only
  *claims* to be Sandra, without a valid `PROXY_SECRET`, is now refused.
  - In log mode anyone with the `/exec` URL could do this before.
  - Sandra has no dashboard session today, so no real user is affected.

## Tests

- **New:** `test/personal-pins-foundation.test.js`, 32 tests:
  - APP_PIN login exactly as before: cookie shape, user-bearing token,
    `/api/me`, unknown name → user-less token, 10 → `429`, success resets,
    unset → `401`
  - XFF spoofing no longer resets the counter (the meeting-report route uses
    the same address)
  - `pinClientIp` reads `req.ip` only
  - the maps sweep and cap
  - hash/verify: correct, wrong, wrong pepper, no pepper, the constant-work
    and timing-safe guard, tampered params
  - weak PINs
  - every validator case, and the server refusing to start without a hash in
    the log
  - the role model: Shiran/Yael have no `deleter`, a shared session has no
    `deleter`, Sandra is the only approver
  - personal-session resolve / reset / revoke
  - `PinLockout`, and that it is not wired
  - the cookie formats, including tamper cases
  - `proxyRoles` from the session only
  - the bootstrap:
    - works once only
    - closed once an approver exists, even a revoked one
    - closed without a token, with a short token, or without a pepper
    - wrong token → `403`, then `429`
    - weak PIN → `400`, not consumed
    - the PIN and token are never logged
  - roles never granted to a non-proxy caller: no secret, wrong secret,
    querystring, a forged `__actor`, open actions, enforce mode
  - verified roles, capped
  - `DELETE_ACTIONS` / `APPROVER_ACTIONS`, defined and not enforced
  - the **scan guard**: every delete/remove/void action `handle_` dispatches,
    and every action whose handler deletes rows, is in `DELETE_ACTIONS` or
    is a documented move
  - the appended columns
  - every actor stamp
  - the spoofed un-void
  - `getData` keys pinned
  - the PIN input is still `maxlength="4"`
- **Updated** (each pinned an old column list or call shape; no behavior
  change):
  - `test/audit-log-dedupe.test.js`: the `AuditLog` columns now end in
    `actor`.
  - `test/billing-override-foundation.test.js`: the columns now end in
    `updatedBy`.
  - `test/detached-payments.test.js` and `test/duplicate-payment-void.test.js`:
    the `upsertPayment_(payment, requestUser_(params)` source regex now
    allows the new third argument.
- **Full suite: 1766 / 1766** (1734 on the base `553b8ab` + 32 new).

## Choices I made (ambiguous points — the safest reasonable option)

1. **`cancelCredit` is in `DELETE_ACTIONS`.** Cancelling a credit is a
   void-like status. It is not enforced yet, so remove it before the
   enforcement PR if Shiran/Yael should keep cancelling credits.
2. **`moveLeadIrrelevant` / `restoreLead` are not deletes.** The row survives
   in the other tab and can be restored. They still get an actor stamp.
3. **USER_PIN_HASHES roles can only narrow the model**, never widen it. A
   role outside the user's model is a startup failure, so the decisions above
   cannot be bypassed by an env edit.
4. **Ortal `active` is a startup failure** until the code is changed for
   Phase 4.
5. **The actor value is the display name, plus ` (unverified)`.** That is the
   same convention as `updatedBy` elsewhere, and it is honest about log-mode
   calls.
6. **A personal cookie with a stale `pinVersion` or a non-active status gets
   `401`** on the data routes already. No such cookie can exist before PR B.
7. **Bootstrap "once only" means once per server process, AND closed for good
   once an approver record exists, even a revoked one.**
   - `BOOTSTRAP_TOKEN` must be at least 32 characters, or the endpoint stays
     closed.
   - Disabled answers `404`, not `403`.
   - The bootstrap has its own limit: 5 per IP and 20 globally per 15 min.
8. **The 7-day `APP_PIN` dual-accept window starts with PR B.** In PR A, the
   APP_PIN session already maps to `auth:'shared'` and `staff` only. The
   window itself is wired in PR B.
9. **The un-void spoof is closed now** (see Code.gs above). It is a live hole
   in log mode, and it changes nothing for real users.
10. **`TRUST_PROXY_HOPS` exists as an escape hatch** (default 1) in case Railway
    ever adds a hop. Without it, all users would share one IP bucket.
11. **The `.xlsx` export route (PR #160) sends no roles.** It is a read
    (`refundPayoutForecast`), so it goes through `sheetsPost` with the
    no-role principal.
12. **The branch is `feat/personal-pins-foundation-v2`.** The remote
    `feat/personal-pins-foundation` still holds an earlier attempt (PR #158,
    closed unmerged). It is kept as-is, not overwritten.

## For Sandra

**Nothing needs to be set for this PR.** Merge it whenever you like. The
dashboard keeps working with `APP_PIN` exactly as today. The steps below are
for **later**, when you're ready to create your own personal PIN (before PR B
goes live).

### Step 1 — generate two random values (no Node needed)

On your computer, in **Chrome**:

1. Open any page and press **F12** (Mac: **⌥⌘J**).
2. Open the **Console** tab.
3. Paste this line and press Enter:

   ```js
   Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
   ```

It prints 64 characters. Run it **twice**:

- **First value** = `PIN_PEPPER`. It must **never** change after the first
  PIN is created. Changing it makes every personal PIN stop working.
- **Second value** = `BOOTSTRAP_TOKEN`. It is temporary.

On a Mac, Terminal also works: `openssl rand -hex 32`.

Keep both only in Railway (and your password manager). Never put them in
WhatsApp, email, GitHub or a chat with Claude.

### Step 2 — Railway

1. Railway → **E-Zone Dashboard** → the web service → **Variables**.
2. **New Variable** `PIN_PEPPER` = the first value. No quotes, no spaces.
3. **New Variable** `BOOTSTRAP_TOKEN` = the second value.
4. Save. Railway redeploys. The deploy log shows
   `BOOTSTRAP_TOKEN is still set — delete it in Railway once Sandra's
   USER_PIN_HASHES line is pasted.` That warning is expected.

### Step 3 — create your record (once)

1. Open the dashboard in Chrome (your normal address).
2. Press **F12** → **Console**.
3. Paste the line below. Before pressing Enter, replace `TOKEN` with the
   second value and `PIN` with **your new 6-digit PIN**.
   - Not `000000`, not `123456`, not all one digit, not a run up or down.

   ```js
   fetch('/api/bootstrap-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'TOKEN', pin: 'PIN' }) }).then(r => r.json()).then(console.log)
   ```

4. The console prints `{ ok: true, record: '{"id":"sandra",...}' }`.
   - Copy **only** the text inside `record` (from `{"id"` to the closing `}`).
   - If it says `weak_pin`, choose another PIN and run it again.
5. Close the tab, so the PIN does not stay in the console.

### Step 4 — paste it into Railway

1. Railway → Variables → **New Variable** `USER_PIN_HASHES`.
2. Its value is the record inside square brackets:
   `[{"id":"sandra",...}]`
3. **Delete** the `BOOTSTRAP_TOKEN` variable.
4. Save. Railway redeploys.
   - If the deploy **fails** with `[config] USER_PIN_HASHES is invalid`, the
     paste is broken (a missing bracket or quote). Fix the value or delete
     it; the dashboard will start again.
   - With your record present, `/api/bootstrap-pin` is closed for good.

Your PIN does nothing yet; PR B adds the login and the «קוד אישי חדש» page,
where you create everyone else's PIN.

## Not in this PR (next)

- **PR B:**
  - the name → 6-digit PIN login using `PinLockout`
  - the Dashboard PIN input widened to 6
  - the 7-day dual-accept window for `APP_PIN`
  - the Sandra-only «קוד אישי חדש» page
  - a service-worker bump
- **The enforcement PR:**
  - calling `roleAllowed_` in front of every `DELETE_ACTIONS` /
    `APPROVER_ACTIONS` write
  - after `PROXY_SECRET_MODE=enforce` (Phase 0b-3)
