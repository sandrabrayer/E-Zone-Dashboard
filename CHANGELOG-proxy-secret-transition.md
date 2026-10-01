# Proxy secret — TRANSITION mode (Phase 0b-1)

Plan: `docs/billing-control-plan.md` §11.1 and §14 (phase 0b). Base branch
`claude/build-ezone-dashboard-QOg5s`. `public/app.js` changed (the busy-lock
handling below), so `CACHE_VERSION` in `public/sw.js` is bumped v18 → v19.

## Why

`appsscript.json` is `ANYONE_ANONYMOUS` and `server.js` sent no secret, so
anyone who knew the `/exec` URL could call `savePayment` directly with
`user: 'סנדרה'`. Once the billing phases start enforcing roles by `user`, that
would bypass the check. This PR adds the shared secret, but in **log mode**:
Managers and Therapists call the same backend without it, and we first need to
see exactly which actions they call before anything is blocked.

## What

### `server.js`

- New Railway variable **`PROXY_SECRET`**. It is attached in **one** place,
  `sheetsPost`, so **every** call to the Dashboard Apps Script carries it:
  `/api/sheets` GET + POST and both `/api/meeting-report/*` calls.
- **Body only, never a URL.** Apps Script exposes no request headers, so the
  browser's `GET /api/sheets?…` is now forwarded as a **POST** whose JSON body
  holds the same params (converted exactly as the old querystring was). `doGet`
  and `doPost` both run the same gate + `handle_`, so results are identical.
  The outgoing URL is `SHEETS_URL` with no querystring at all.
- `buildAppsScriptBody` puts the proxy-owned fields **last**: `user` and
  `proxyUser` (both = the user in the signed session cookie) and
  `proxySecret`. A browser can never override any of them.
- **Fail-closed.** `PROXY_SECRET` unset → a clear `[config] PROXY_SECRET is not
  set — the server REFUSES to proxy…` error at startup, every Apps Script route
  answers `503 proxy_not_configured`, and `sheetsPost` rejects **without** any
  network call.
- **Never in a log, response or error.** `PROXY_SECRET` joined
  `debugSecretList()`; every Apps Script error path goes through
  `safeErrorMessage` (all secrets redacted, capped at 500 chars); Apps Script
  responses are sent to the browser through `sendAppsScriptJson`, which
  redacts the secret (defense-in-depth — Code.gs already strips it). It is
  **not** sent to the Outpatient backend (a different app with its own secret).
- **Debug output stripped:** the request logger and the 404 log print the path
  only (no querystring); `[sheets GET]` logs the action name only (was the full
  query); `[sheets POST] ←` logs `{ok, error}` only (was the whole response —
  patient / payment data); `lastSave.response` on `/api/debug/last-save` is a
  truncated, redacted preview string instead of the raw response object.

### `apps-script/Code.gs` (separate commit — clasp CI deploys it on merge)

- `doGet` / `doPost` → `gatedEntry_` → `proxyGate_` → `handle_`.
- Constant-time compare (`constantTimeEquals_`: walks the full length of the
  longer input, folds every difference into one accumulator, no early exit)
  against Script Property **`PROXY_SECRET`**.
- The secret is read from the **POST body only**; `collectParams_` drops
  `proxySecret` / `proxyUser` from the querystring. `proxyGate_` deletes both
  fields from `params` before anything else runs, so no handler, response or
  `exception` message can contain them.
- Script Property **`PROXY_SECRET_MODE`**:
  - unset / `log` (**default for this PR**) — a request without a valid secret
    is served and recorded in the new append-only tab **`SecurityLog`**
    (`timestamp, action, method, secretPresent, callerType, hourKey` — never
    the value), **at most one row per action per hour** (CacheService fast
    path, then a re-check of the last 500 rows under a 2 s script lock; a busy
    lock skips the row, never the request). `callerType` = `no_secret` /
    `bad_secret`.
  - `enforce` — `{ok:false,error:'unauthorized'}`, no handler, **nothing
    written** (no tab, no lock, no row).
  - any other value → treated as `enforce` (a typo fails closed).
  - `PROXY_SECRET` unset → nothing can be valid (log: all logged; enforce: all
    refused).
- **Acting user.** With a valid secret the user is the proxy's `proxyUser`
  (from the session cookie); a body `user` that contradicts it is ignored and
  recorded once per action-hour as `user_mismatch` (no names written). Without
  a valid secret in log mode the legacy `user` field is kept, so a Code.gs that
  lands before the new server keeps stamping correctly.
- Not gated (they have their own fail-closed secret, and their callers never
  hold `PROXY_SECRET`): `getAdmittedRoster`, `meetingReportLeads`,
  `submitMeetingReport`, `accountingPayments`, `accountingCredits`.
- Action names are caller-controlled, so `SecurityLog` records only names in
  `PROXY_KNOWN_ACTIONS` (a test keeps it equal to `handle_`'s dispatch list);
  anything else is `(unknown)` — no spam rows, no formula injection.
- **Every `LockService` `tryLock` result is now checked** (21 sites were
  unchecked and carried on without the lock):
  - request-path writers (`saveAll_`, `upsertPayment_`, `upsertCredit_`,
    `deletePatientRow_`, `dischargePatient_`, the lead/restore/override/meeting
    writers) return `{ok:false, error:'lock_busy'}` with nothing written;
  - the read-path one-time backfills (`backfill*Locked_`) skip that pass and
    retry on the next read;
  - editor-run / trigger jobs throw `could not acquire the script lock — try
    again.`
- New editor-run **`securityCallersReportNow()`** — read-only (no cell, tab,
  lock or property). Summarises `SecurityLog` for the last 7 days by
  `action × callerType`: hours seen, GET/POST, first and last seen.

### Tests

- New `test/proxy-secret-transition.test.js` (32 tests): valid secret → OK;
  missing / wrong in log mode → OK and logged once per hour (also after a cache
  eviction, and a new row the next hour); enforce → rejected and nothing
  written; enforce with no `PROXY_SECRET` and unknown modes fail closed; exempt
  actions still work; spoofed body user ignored and logged without names; the
  secret never appears in a handler param, sheet, cache, log, response, error,
  or the server debug store (even when the far side echoes it); constant-time
  compare (char reads independent of mismatch position, no early exit); every
  `tryLock` checked and a busy lock fails cleanly; the report is read-only;
  `server.js` sends the secret in the POST body of every call, never the URL,
  logs no request/response bodies or query values, and fails closed.
- 20 existing vm sandboxes stubbed `tryLock: noop` (returns `undefined`). The
  real API returns a boolean, and `undefined` now (correctly) reads as "not
  acquired", so those stubs now return `true` — no assertion changed.

### Frontend: busy lock (`public/app.js`, `public/sw.js` v18 → v19)

**Before:** `apiPost` threw on any `{ok:false}`, so a busy lock reached every
write path's `catch` as the server's English text (`…נכשלה — could not acquire
the script lock — try again.`). The optimistic change was rolled back at once,
nothing was retried, and two background `saveAll` paths (the loadAll
auto-promote save and the meetingWith autosave) failed with **no message at
all**. The autosave also blacklisted the lead for the rest of the session.

**Now:**
- `apiPost` sees `error:'lock_busy'`, waits **2 s** (`LOCK_BUSY_RETRY_MS`)
  and re-sends the **identical** body **once**. This is safe because Code.gs
  answers `lock_busy` before writing anything. If the retry succeeds, the user
  sees nothing.
- If the lock is still busy, it throws **«המערכת עסוקה, נסו שוב»**
  (`LOCK_BUSY_MESSAGE_HE`, flagged `lockBusy:true`). Every caller's existing
  `showError(prefix + e.message)` shows it, e.g. «שגיאה: שמירת גבייה נכשלה —
  המערכת עסוקה, נסו שוב». The server's English text never reaches the user.
- Other refusals (`conflict`, `exception`, …) are not retried and behave
  exactly as before.
- The two background paths now show the message on a busy lock. The
  auto-promoted rows stay in state for the next save. The autosave no longer
  blacklists a lead for a busy lock, so the next pass retries it.

What the user sees when the lock is still busy after the retry:

| Write | Result |
|---|---|
| Edit lead / edit patient / add lead / admit / direct add (`saveAll`) | Hebrew message; the **modal stays open with the typed values** (handler returns `false`); local state rolled back to what the sheet holds |
| `dischargePatient` | Hebrew message; the **discharge modal stays open** (onConfirm rethrows); nothing was persisted, so the rollback is truthful |
| `moveLeadIrrelevant` (close lead) | Hebrew message; the **close modal stays open** |
| `saveCredit` | Hebrew message; the **credits modal stays open with every line** (`render(); return;`) |
| `savePayment`, `upsertBillingOverride`, `deleteBillingOverride` | Hebrew message; row back to its saved value; re-enter and save again |
| `restorePatient`, `restorePatientToActive`, `restoreLead`, `removeLead`, `deletePatientRow`, `deleteMeetingReport` | Hebrew message; the item is back where it was (nothing was written); press again |
| meetingWith autosave (background) | Hebrew message; retried on the next pass |
| loadAll auto-promote (background) | Hebrew message; rows stay on screen and ride the next save |

`test/lock-busy-frontend.test.js` (34 tests) drives the real `app.js` per
write path, each with two cases:
- busy → ok: retried once after 2000 ms with a byte-identical body, the change
  lands, no error
- busy → busy: exactly two sends, the Hebrew message shown, no English text

It also checks that no other code reaches `/api/sheets`, that every
`apiPost({action:…})` site has a test, and the `apiPost` contract. Against
the previous `app.js`, 33 of the 34 fail.

## Deploy

See `DEPLOY.md` → **"Proxy secret (Phase 0b-1, TRANSITION mode) — Sandra's
steps"**. Order: generate → **Railway variable before merging** → Script
Properties → merge → check → run `securityCallersReportNow` after a few days.
Do **not** set `enforce` in this phase.

## Not in this PR (next phases)

- Giving Managers / Therapists the secret (or a separate read-only
  deployment), then `PROXY_SECRET_MODE=enforce` — needs the
  `securityCallersReportNow` data first.
- Personal PINs (§11.2) and `USER_ROLES` (§11.3).
- Known, pre-existing, unchanged: `applyCorruptedRowRepairsNow` (editor-run)
  calls `deletePatientRow_` while holding the script lock, and the inner
  `finally` releases it. Now that the inner `tryLock` result is checked, a
  non-reentrant lock makes that delete skip with `lock_busy` (nothing written)
  instead of running unlocked.
