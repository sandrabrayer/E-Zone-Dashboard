# Personal PINs — foundation (Phase 0b-3, PR A)

Plan: `docs/billing-control-plan.md` §11.2–11.3 and §14.2 (decisions locked by
Sandra on 01/10/2026). Branch `feat/personal-pins-foundation` → base
`claude/build-ezone-dashboard-QOg5s`. `apps-script/Code.gs` changes are in their
own commit (clasp CI deploys them on merge). There is no `public/` change, so
there's no `CACHE_VERSION` bump.

**Zero user-facing change.** Login is still the shared `APP_PIN` plus the name
picker, exactly as before. Only one change is active: the rate-limit IP fix
below, which honest clients cannot notice.

## Decisions recorded (Sandra, 01/10/2026)

| Topic | Decision |
|---|---|
| Login | Tap your name, then a 6-digit PIN (not PIN-only). Per-user lockout. |
| Sandra (`sandra`) | `staff`, `deleter`, `approver`, `viewer`. She logs in only for approvals. Her separate code keeps the control "Vered cannot approve her own exceptions or un-void her own payments". |
| Vered (`vered`) | `staff`, `reporter`, `deleter` |
| Shiran (`shiran`), Yael (`yael`) | `staff`, `reporter`, **no** `deleter` |
| Ortal (`ortal`) | `controller` only (no `staff`), status `inactive`: no login until phase 4 |
| Deletes | Every delete or void needs `deleter`, and every delete records its actor. |
| Approver-only (Sandra) | Un-void a payment, refund exceptions, write-off / accept an opening balance. `approver` is pinned to `sandra`; any other approver → startup failure. |
| Storage | `USER_PIN_HASHES` (Railway), scrypt + 16-byte per-user salt + `PIN_PEPPER` |
| Lockout | 5 / user, 10 / IP, 30 global, each per 15 minutes |
| `APP_PIN` | 7-day dual-accept window: `staff` only, `auth:'shared'`, **no** `deleter` (PR B), then removed (PR C) |
| Reset / revoke | reset = `pinVersion++`; revoke = `status: "revoked"`. A Railway variable edit, no code deploy. |
| No local Node | PR A: a one-time bootstrap for Sandra's own record. PR B: a Sandra-only page «קוד אישי חדש». |

## What changed

### `server.js`

- **The X-Forwarded-For fix (ACTIVE).** `app.set('trust proxy', 1)` (Railway's
  one hop), and `pinClientIp` now returns `req.ip`.
  - An optional Railway variable, `TRUST_PROXY_HOPS` (1–5, default 1),
    corrects the hop count without a code deploy. Any other value falls back
    to 1, never to "trust all".
  - Before: the old code keyed the 10-per-15-minutes PIN counter on the
    **left-most** `X-Forwarded-For` entry, which the client writes. Sending a
    new fake value on each request opened a fresh window every time. That made
    a 4-digit `APP_PIN` brute-forceable.
  - Now: `req.ip` is the address Railway appended.
  - Applies to both `/api/verify-pin` and `/api/meeting-report/verify-pin`.
- **Bounded counters.** Both attempt `Map`s are now a `FixedWindowLimiter`
  (`lib/rate-limit.js`). Expired windows are pruned and keys are capped at
  10,000. The old maps were never cleaned. The semantics are unchanged:
  10 failures → 429 with `Retry-After`, and a correct PIN resets the counter.
- **Startup validator.** `USER_PIN_HASHES` may be unset. If it is malformed,
  the server refuses to start (exit 1). Malformed means: bad JSON, not an
  array, unknown role, a non-Sandra approver, a bad hash, a bad
  status/pinVersion/id, a name that differs from `lib/users.js`, duplicates,
  unknown fields, or records without a valid `PIN_PEPPER`. Railway's
  `/healthz` check then keeps the previous deployment serving. Errors name
  the record index and id only, never a hash.
- **`POST /api/bootstrap-pin`** (one-time, Sandra only). Body `{ token, pin }`.

  | Status | When |
  |---|---|
  | `404` | `BOOTSTRAP_TOKEN` is unset |
  | `429` | 5 wrong tokens per IP per 15 minutes |
  | `410` | An approver record already exists, or this process already created one (once only) |
  | `503` | The token is shorter than 32 characters, or `PIN_PEPPER` is missing |
  | `403` | Wrong or missing token. The compare is constant-time. |
  | `400 weak_pin` | The PIN is weak |
  | `200` | Returns `{ id:'sandra', record, value }`. `value` is the complete `USER_PIN_HASHES` line to paste. |

  The id is fixed to `sandra` and is not a request field. The PIN is hashed
  and dropped; it is never stored, logged or echoed. The startup log warns
  while the token is set.
- **`proxyRoles`.** Every Apps Script call carries the session's roles next to
  `proxyUser`. A shared-PIN (`APP_PIN`) session sends `['staff']`. A client
  `proxyRoles` / `_verifiedActor` is overwritten or dropped.
- `PIN_PEPPER` and `BOOTSTRAP_TOKEN` are redacted from every error and debug
  record, like the other secrets.

### New `lib/` modules

- **`lib/pin-hash.js`**
  - The hash is `scrypt$v1$32768$8$1$<salt>$<hash>` over
    `HMAC-SHA256(PIN_PEPPER, "ezone-pin.v1.<id>.<pin>")`.
  - Each user gets a random 16-byte salt.
  - Verify is constant-time (`timingSafeEqual`) and fail-closed.
  - A weaker cost than N=2^14 is refused.
  - `pinWeakness` rejects non-6-digit PINs, all-same digits, and sequences up
    or down (wrapping 9↔0, so `789012` and `210987` are weak too).
- **`lib/users.js`**
  - New: `USERS` (the model above, frozen), `ROLES`,
    `APPROVER_USER_ID = 'sandra'` and `SHARED_SESSION_ROLES = ['staff']`.
  - `SESSION_USERS` (the shared-PIN picker) is unchanged.
- **`lib/user-pins.js`**: the validator, `hasApprover`, `buildUserRecord` and
  `withRecord`.
- **`lib/rate-limit.js`**
  - `FixedWindowLimiter`.
  - `createLoginLimiter` (5/user, 10/IP, 30 global per 15 minutes). It is
    **built but not wired**; PR B wires it into the name + PIN login.
- **`lib/session.js`**
  - New personal token: `p1.<expiry>.<userId>.<pinVersion>.<sig>`, with
    `createPersonalToken` / `readPersonalToken`.
  - Legacy tokens are unchanged and still valid.
  - `verifySessionToken` / `readSessionUser` do **not** accept the new
    format, so it can authorize nothing until PR B adds the pinVersion and
    status check.

### `apps-script/Code.gs` (separate commit)

- **Roles only from the verified proxy.**
  - `proxyGate_` strips `proxyRoles` and `_verifiedActor` from every request.
  - Only when `PROXY_SECRET` verifies does it set
    `_verifiedActor = { user, roles }`. The roles are filtered to
    `KNOWN_ROLES`, and `approver` is dropped unless the user is
    `APPROVER_USER_NAME` (סנדרה).
  - `collectParams_` drops a querystring `proxyRoles` and any caller
    `_verifiedActor`.
  - New `actingUser_(params)` and `hasRole_(params, role)`. A request with no
    secret, a wrong secret, or on an open action has no identity and no
    roles.
- **Role lists, DEFINED, NOT ENFORCED.**
  - `DELETE_ACTIONS` = `removeLead`, `deleteMeetingReport`, `deletePatientRow`,
    `deleteBillingOverride`.
  - `DELETE_OPERATIONS` = `payment_void`, `credit_cancel`.
  - `APPROVER_ACTIONS` = `payment_unvoid`, `credit_exception`,
    `opening_balance_write_off`, `opening_balance_accept`.
  - `roleCheck_(params, key)` returns `{ok:false, error:'requires_deleter' |
    'requires_approver'}`. `handle_` does not call it yet.
  - `PAYMENT_VOID_REVERSERS` (the name check from PR #144) is unchanged and
    still enforced.
- **`AuditLog.actor`** is appended as the 7th column, and the existing tab
  grows the header cell. `logAudit_` takes an optional `actor`. When it is
  omitted, the actor comes from the `updatedBy` / `by` / `deletedBy` the call
  already logs, so the existing call sites fill it too: patient deletes,
  discharges, restores, payment link and void decisions, un-voids and credits.
- **`BillingOverrides.updatedBy`** is appended as the 6th column. It is
  server-owned: a payload value is ignored.
- **Actor stamps.** `upsertBillingOverride_`, `deleteBillingOverride_`,
  `moveLeadIrrelevant_`, `restoreLead_`, `removeLead_` and
  `deleteMeetingReport_` now receive `requestUser_(params)`. Each writes an
  `AuditLog` row with its actor:

  | AuditLog action | From |
  |---|---|
  | `lead_moved_irrelevant` | `moveLeadIrrelevant_` |
  | `lead_restored` | `restoreLead_` |
  | `lead_removed` | `removeLead_` |
  | `meeting_report_deleted` | `deleteMeetingReport_` |
  | `billing_override_created`, `billing_override_updated` | `upsertBillingOverride_` |
  | `billing_override_deleted` | `deleteBillingOverride_` |

- All columns are append-only. `getData` keeps every key, and the override
  rows gain `updatedBy`.

### Docs

- **The PIN box limit is corrected.** The Dashboard PIN box is **4** digits
  (`public/index.html` `maxlength="4"`), not 6. Fixed in
  `EZONE-ECOSYSTEM-STATUS.md` and plan §11.2.
- Plan §11.2 / §11.3 are rewritten to the locked decisions, with a new §14.2
  status table. A new section is added to `EZONE-ECOSYSTEM-STATUS.md`.

## Tests

- **New:** `test/personal-pins-foundation.test.js` (35 tests).
  - **Hash and verify:** correct, wrong PIN, wrong pepper, other user,
    tampered, malformed, weakened cost, plus a constant-time guard.
  - **Weak PINs:** all-same, sequential up/down with wrap, and bad formats.
  - **The role model:** Shiran/Yael have no deleter, a shared session has no
    deleter, approver is Sandra only, and `Code.gs` `KNOWN_ROLES` /
    `APPROVER_USER_NAME` equal `lib/users.js`.
  - **The validator:** 15 failure cases, plus a real `node server.js` that
    exits 1 on invalid values.
  - **The cookie format:** legacy tokens still valid, and a personal token
    authorizes nothing yet.
  - **APP_PIN login exactly as before:** 200 + the legacy cookie, the picker
    name, the shared PIN still can't claim Sandra, 401, 429 after 10, and a
    reset on success.
  - **X-Forwarded-For:** a forged left-most entry no longer resets the counter,
    on both PIN routes. This test fails when the old `pinClientIp` is
    restored.
  - **Limiters:** bounded maps, and the per-user limiter's 5 / 10 / 30.
  - **Bootstrap:** 404 / 503 / 403 + 429 / 400 / 200 / 410. It runs once
    only, is disabled by an approver, and never logs the PIN.
  - **Roles never granted to a non-proxy caller:** no secret, wrong secret,
    open action, querystring.
  - **Approver pinning.**
  - **Role lists:** pinned, plus a **scan guard** — every delete-like action
    `handle_` dispatches must be in `DELETE_ACTIONS`, and `handle_` must not
    enforce anything yet.
  - **Not enforced:** Shiran can still remove a lead.
  - **Actor stamps:** for all six functions, plus the appended columns on
    existing tabs.
  - **`getData` keys.**
- **Updated (append-only contract extensions):**

  | File | Change |
  |---|---|
  | `test/audit-log-dedupe.test.js` | The AuditLog header now ends with `actor` |
  | `test/billing-override-foundation.test.js` | `BILLING_OVERRIDE_COLUMNS` ends with `updatedBy` |
  | `test/proxy-secret-transition.test.js` | The proxy body also carries `proxyRoles` |

- **Full suite: 1724 / 1724.**

## For Sandra

**Nothing breaks if you do nothing.** Every new variable is optional until
PR B. Do these steps whenever you're ready to create **your own** personal
code. You need no Node and no terminal, only Railway and a browser.

> ⚠️ Set `PIN_PEPPER` **once** and never change it. Changing it makes every
> personal code stop working.

1. **Generate two long random values.** Either:
   - use a password manager's generator, at least 40 characters, letters and
     digits only; or
   - in Chrome on a computer, open any page, press F12, open **Console**,
     type `crypto.randomUUID() + crypto.randomUUID()` and press Enter. Run it
     twice, once for each value.

   Keep them only until step 2. Do not email them.
2. **Railway** → project → the **E-Zone Dashboard** service → **Variables** →
   **New Variable**:
   - `PIN_PEPPER` = the first value.
   - `BOOTSTRAP_TOKEN` = the second value.

   Save. Railway redeploys by itself. Wait until the deployment is green.
3. **Create your record.** Open the dashboard in Chrome on a computer (you do
   not need to log in). Press F12 → **Console**, and paste one line,
   replacing the two placeholders. The PIN must be 6 digits, not
   `000000`/`123456`, not all the same digit, and not a sequence:

   ```js
   fetch('/api/bootstrap-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'PASTE-BOOTSTRAP_TOKEN',pin:'YOUR6DIGITS'})}).then(r=>r.json()).then(d=>console.log(d.ok?d.value:d))
   ```

   - It prints one line that starts with `[{"id":"sandra"`. **Copy that whole
     line.**
   - `weak_pin` means choose a different PIN.
   - `bootstrap_disabled` means it was already used. Change `BOOTSTRAP_TOKEN`
     in Railway (that restarts the server) and repeat this step.
   - Close the tab afterwards.
4. **Railway** → **Variables** → **New Variable** `USER_PIN_HASHES` = paste the
   line. Save, and wait for the redeploy.
   - If that deployment **fails**, the line was pasted wrong (the server
     refuses a bad value on purpose, and the old deployment keeps serving).
     Open the deploy log: it names the problem, never the code. Fix the value
     and save again.
5. **Delete `BOOTSTRAP_TOKEN`** from Railway right away and let it redeploy.
   The deploy log should no longer mention `BOOTSTRAP_TOKEN`.

Your personal code starts working only in **PR B**. Until then, everyone,
you included, logs in exactly as today. If you ever forget your code: delete
your record from `USER_PIN_HASHES`, set a new `BOOTSTRAP_TOKEN`, and repeat
steps 3–5.

**Quick check after this PR deploys** (the IP fix): 10 wrong PINs on one phone
block that phone for 15 minutes, but someone else on a different network can
still log in. If **everyone** gets blocked together, Railway has more than one
proxy hop. In that case, add the Railway variable `TRUST_PROXY_HOPS` = `2` (no
code deploy needed) and tell Claude.
