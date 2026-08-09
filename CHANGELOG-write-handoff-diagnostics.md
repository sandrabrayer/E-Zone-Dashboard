# Write & handoff diagnostics — /api/debug/last-save answers by itself

Replaces the manual DevTools Network repro from the write-persistence
investigation: the next time symptom 1 (patient save doesn't stick) or
symptom 3 (Outpatient handoff doesn't happen) occurs, one visit to
`/api/debug/last-save` shows what actually happened.

## What changed

### `server.js`

- **`writes` ring buffer** — the last **20** write attempts that passed auth
  (newest first), in memory. Each entry: `at`, `route`, `action`, the **HTTP
  status returned to the client**, backend `ok`, an `error` if any, and a
  truncated + redacted `responsePreview`.
  - **`saveAll` entries** additionally carry per-house patient counts **sent**
    (`summary.byHouse`) vs **acknowledged** by the backend (`acknowledged`,
    from the new `written` echo below), plus a `countsMatch` verdict with
    per-house `countMismatches`. A `false` verdict pinpoints a silent
    serialize/houseId drop — the symptom-1 hypothesis — without a live repro.
    Until the matching Code.gs deploys, `countsMatch` is `null` (no verdict),
    never a false alarm.
- **`authFailures` counter** — every `requireSession` **401** is recorded
  (total, per-path counts, last-20 timestamps). A write rejected at the auth
  gate never reaches a route handler — this counter is the only trace it
  leaves, and it detects the rejected-cookie hypothesis without a repro.
- **`/api/outpatient-lead` records the far side's actual response** — the full
  (truncated to 2000 chars, secret-redacted) body from the Outpatient Apps
  Script, including the failure signatures that used to be invisible:
  `{ok:false,...}` (e.g. `unauthorized` on a secret mismatch), non-2xx
  (`Apps Script HTTP <status>: <body>`), and the Google-HTML-page case
  (`returned non-JSON…: <html>…`). The 503 `outpatient_not_configured` and 502
  `outpatient_unreachable` outcomes are recorded too.
- **Redaction** — `redactSecrets` strips every occurrence of
  `OUTPATIENT_LEAD_SECRET` and `SESSION_SECRET` from anything stored
  (split/join, no regex). Applied to all previews and stored error messages.
- **`/api/debug/last-save`** now returns
  `{ lastSave, writes, authFailures }` — the legacy record is preserved under
  `lastSave`. Endpoint remains behind `requireSession`; store is in-memory and
  capped (resets on redeploy, like before).
- No change to what is returned to the *client* on any route — response
  bodies/statuses are identical; this PR only records.

### `apps-script/Code.gs` (the cheap backend-truth half)

- **`saveAll_`** response now includes `written` — per-house counts of patient
  rows actually written (`{ ok: true, written: { arfoni: 12, ... } }`).
- **`replaceHousePatients_`** returns the number of rows written for its house
  (previous sole caller ignored the return value — backward-compatible).
- Deploys via clasp CI on merge; until it deploys, the server-side comparison
  reports `countsMatch: null`.

## Tests — `test/write-handoff-diagnostics.test.js`

Requires `server.js` directly (no socket — `app.listen` is main-module-gated),
same approach as `api-auth.test.js`; Code.gs half uses the vm-sandbox fakeSheet
harness:

- `redactSecrets`: replaces all occurrences, ignores empty secrets/bad input;
  `responsePreview` truncates AND never lets a configured secret survive.
- Ring buffer: newest first, capped at `WRITE_LOG_MAX` (20); records an
  outpatient response-body entry verbatim.
- **A 401'd write leaves a trace**: `requireSession` with no cookie → 401 AND
  `authFailures` total/byPath/recent all update; `recent` is capped.
- `compareSaveAllCounts`: match, dropped-house mismatch, one-sided-house
  mismatch, and the older-backend `null` verdict.
- `saveAll_` echoes `written` per house; `replaceHousePatients_` returns its
  row count.

Full suite: `npm test` — 361 pass, zero regressions (+12 new).

## How Sandra reads it (after merge)

Open `https://ezone-dashboard.up.railway.app/api/debug/last-save`:

- **Symptom 1** (status change doesn't stick): find the `saveAll` entry in
  `writes` → `countsMatch:false` = serialize/houseId drop (see
  `countMismatches`); no entry at all + `authFailures` climbing = the cookie
  hypothesis; entry with `okFromBackend:false` = Apps Script refused.
- **Symptom 3** (handoff): find the `createOutpatientLead` entry → read
  `outpatientResponse` verbatim — it is exactly what the Outpatient side said.
