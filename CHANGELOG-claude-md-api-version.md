# CLAUDE.md + GET /api/version (2026-10-08)

## What

- **`CLAUDE.md`** (new, repo root): rules for fully autonomous Claude Code work —
  repo facts (deployed branch `claude/build-ezone-dashboard-QOg5s`, production
  URL `https://ezone-dashboard.up.railway.app`, Apps Script deploy is automatic
  on merge, `npm test`, `/api/version`) and the working rules (language, per-change
  checklist, git hygiene, self-merge on green + post-merge verification,
  append-only Sheets headers / monotonic SW cache versions, Railway hands-off,
  final report format).
- **`GET /api/version`** (server.js): the post-merge deploy probe. Public, no
  session, nothing proxied, `Cache-Control: no-store`. Body is exactly
  `{ commit, builtAt }`:
  - `commit` — `RAILWAY_GIT_COMMIT_SHA` through the existing `deployIdentity()`
    validation (7–40 hex chars, lower-cased; `''` when unset or malformed);
  - `builtAt` — ISO-8601 time the Node process started. Railway exposes no build
    timestamp, and every deploy starts a new process, so this is the deploy time.
  - A controller-view session (Ortal) still gets the `controllerRouteLock` 403,
    like every `/api/` route outside `CONTROLLER_ROUTES`; the probe is called
    anonymously.
- **`package-lock.json`**: `npm audit fix` — `proxy-addr` 2.0.7 → 2.0.8
  (critical, GHSA-jqcg-44mw-7w3h), `body-parser` 1.20.4 → 1.20.8 (low),
  `qs` bumped. `npm audit --audit-level=high` now exits 0 (one moderate `qs`
  advisory remains, no fix in express 4's range).

## Security

- Reads only `RAILWAY_GIT_COMMIT_SHA` from the environment (via `deployIdentity`),
  so no other env value (secrets included) can surface; the sha is validated, not
  echoed. No cookie is read or minted.

## Tests

- `test/api-version.test.js` (4 tests): exact body shape, sha validation, public
  200 + `no-store` + no `Set-Cookie`, no env leak, `builtAt` stable across calls.
- Full suite: 2495/2495 pass.
