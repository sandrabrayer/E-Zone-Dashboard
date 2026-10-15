# Changelog — Managers expected-discharge SAVE fix (backend) — 2026-10-15

## Symptom
In production, saving «שחרור משוער» in the Managers app failed with «השמירה נכשלה: upstream_error».
Reads (houseData, the date itself, the alerts) worked.

## Diagnosis (in the order asked)
- **(a) Which deployment Managers calls.** The Managers UI only shows the date picker when
  `houseData` says `expectedDischargeSupported: true`. That flag ships in the same commit as
  `dischargeSet` (#230). So the deployment behind Managers' `APPS_SCRIPT_URL` already runs code that
  has the save action. A stale deployment would also answer `unknown_op` (JSON), not
  `upstream_error`. Every «Deploy Apps Script» run since #223 is green (#97 for #230 … #102 for
  #235). `DEPLOYMENT_ID` and the Railway `APPS_SCRIPT_URL` are secrets/variables this session
  cannot read. A manual check is in the Managers final report.
- **(b) `MANAGERS_WORK_SECRET` mismatch.** Ruled out by the symptom. A mismatch answers
  `{ok:false,error:'unauthorized'}`, which Managers maps to 503 `upstream_unavailable`, and it
  breaks the reads too.
- **(c) Partial OAuth consent.** `upstream_error` means the Managers proxy got NO JSON: the reply
  was not JSON, or the fetch failed or timed out. Every exception inside `handle_` is already
  returned as JSON (`error:'exception'`). A Google HTML page («Authorization is required…») is
  therefore one of the two ways to get there. The first save also creates the
  `ManagersExpectedDischarge` sheet (insertSheet). New editor-run **`authorizeSheetsWriteNow()`**
  settles it once:
  1. its first, uncaught statement is `ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)`;
  2. then a real write → flush → read-back → delete on a temporary sheet;
  3. then a lock round-trip;
  4. then `ManagersExpectedDischarge` is ensured with its append-only header (verified equal to
     `MW_DISCHARGE_COLUMNS`, never rewritten), so the first save no longer inserts a sheet.

  Logs one summary line, no data. Not reachable over HTTP.
- **(d) Lock / guard / validation.** **Code bug found:**
  - `mwDischargeSet_` (and `mwLogAdd_` / `mwLogUpdate_`) took the script lock with
    `waitLock(10000)`;
  - that comes after a full Patients read, and `waitLock` THROWS on timeout;
  - every other Dashboard writer uses a checked `tryLock` (guard test);
  - with the lock held by another write, the save could run past the Managers proxy's 15 s
    `AbortSignal.timeout`, so the proxy aborted and answered `upstream_error` (the write might
    even land afterwards).

  Header guard and validation return JSON codes (`bad_date`, `before_admission`, `too_far`,
  `not_found`, `conflict`) and do not throw.

## Fix
- `mwDischargeSet_`, `mwLogAdd_`, `mwLogUpdate_`: `if (lock.tryLock(5000) !== true) return
  lockBusy_(…)`. A busy lock is now a JSON `lock_busy` well inside the proxy's budget. The lock is
  released on every path.
- `authorizeSheetsWriteNow()` (editor-run) as above.
- Managers side (separate PR in ezone-managers): specific Hebrew reasons instead of
  `upstream_error`, the technical class in its server log, a longer write timeout, and the save
  spinner.

## Security
- No new secret, Script Property, env var, endpoint or action; `MANAGERS_WORK_SECRET` stays
  fail-closed.
- `authorizeSheetsWriteNow` is editor-run only (not in `PROXY_KNOWN_ACTIONS` / `OPEN_ACTIONS`;
  nothing calls it). It writes only a temp sheet (deleted) and the existing header.
- Append-only: the `ManagersExpectedDischarge` header is unchanged and only created if missing.
- No patient names in logs.
- `npm audit`: 0 high / 0 critical (1 moderate in `qs`, pre-existing).

## Tests
2896 → 2905 (+9, `test/managers-discharge-save-fix.test.js`):
- lock busy → `lock_busy` for dischargeSet / logAdd / logUpdate, nothing written, 5 s wait,
  never `waitLock`;
- lock free → the save lands and the lock is released (also on `conflict`);
- `authorizeSheetsWriteNow`:
  - `requireAllScopes(FULL)` runs first;
  - temp sheet inserted, flushed and deleted;
  - discharge sheet header-only;
  - a partial grant throws at the first statement and nothing else runs;
  - a failed read-back throws and still deletes the temp sheet;
  - existing rows are untouched;
  - editor-only.

No asset under `public/` changed (SW stays v67).

## Deploy / manual step
Apps Script deploys automatically on merge (Code.gs changed). **Once after the deploy**, as the
account that owns the Web App deployment: Apps Script editor → `authorizeSheetsWriteNow` → Run →
tick EVERY box in the consent dialog → the log must read `authorizeSheetsWriteNow: OK`.
