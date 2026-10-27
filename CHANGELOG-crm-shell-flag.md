# C1 — CRM shell behind a flag (`CRM_ENABLED` + `/?view=crm`) — 2026-10-27

CRM restructure, Session C, first PR (`docs/crm/ROLLOUT.md` §C1). **Default off: with
`CRM_ENABLED` unset, every response is byte-for-byte unchanged** (pinned by
`test/crm-shell-flag.test.js`).

## What ships
- `lib/crm-shell-flag.js` — pure: `crmShellEnabled(env)` (exactly `'true'`), `wantsCrmShell(query)`
  (`view=crm`), `crmShellAllowed(principal)` (verified personal session), `serveCrmShell(...)`.
- `server.js` — `/` serves `public/crm/crm.html` only when all three hold; otherwise `sendIndex`
  exactly as before. `/index.html` never serves the shell. The shell is read per request, `no-store`,
  the session name HTML-escaped. No new asset: `sw.js` untouched (still v93), nothing added to
  `ASSETS`.
- `public/crm/crm.html` — a dark, RTL placeholder shell (title, the six areas, «חזרה לדשבורד הרגיל»).
  C2 replaces it with the side menu and real areas.

## Matrix (tested on the real server)
| CRM_ENABLED | session | `/?view=crm` |
| --- | --- | --- |
| unset / `TRUE` / `1` / `yes` | any | the normal page (same bytes as `/`) |
| `true` | none | the PIN page, as today |
| `true` | shared / sibling | the normal page |
| `true` | personal (Vered, Sandra, Ortal, Dana) | the shell |

Ortal's `/api` controller lock is unchanged. `/healthz`, `/api/version` unchanged.

## Turning it on (Sandra only — Claude never sets Railway variables)
Railway → project `zucchini-hope` → service `web` → Variables → New → `CRM_ENABLED` = `true` →
Deploy. Rollback: delete the variable (or revert). Theme decision (2026-10-27): the shell stays
**dark**, matching the live app.

## Files
`lib/crm-shell-flag.js`, `server.js`, `public/crm/crm.html`, `test/crm-shell-flag.test.js` (7),
`DEPLOY.md`, `EZONE-ECOSYSTEM-STATUS.md`, `docs/crm/ROLLOUT.md` §C1. No Code.gs, no SW bump.
