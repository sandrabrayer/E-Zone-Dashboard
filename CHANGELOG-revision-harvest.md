# Automated revision harvesting (feeds tier-1 snapshot repair)

## Why

PR #107's tier-1 snapshot repair works (verified live), but a single pre-bug
snapshot covers only rows created before 2026-07-27. Corruption happened on
read→rewrite cycles throughout 2026-07-27 → 2026-08-31, so each row's last
clean value lives in a DIFFERENT revision — the one just before that row's
first corrupting rewrite. After one manual snapshot, 150+ cells were still
classified manual. Creating many Version-history copies by hand is
unacceptable; this automates it.

## What changed

### `harvestRevisionSnapshotsNow` (new — Run dropdown, never HTTP-reachable)

1. **Lists revisions** of the container spreadsheet: the Drive **advanced
   service** (`Drive.Revisions.list`, enabled as v3 in `appsscript.json`;
   the code also tolerates the v2 response shape) with a `UrlFetchApp`
   fallback against the Drive v3 REST API using the script's own OAuth token
   (`ScriptApp.getOAuthToken()`). Paginated; revision metadata normalized to
   `{id, modified, exportLinks}`.
2. **Selects target revisions** (pure, directly unit-tested
   `selectHarvestRevisions_`): the newest revision dated BEFORE 2026-07-27
   (clean baseline), plus the latest revision inside each ~6-day bucket
   across 2026-07-27 → 2026-09-01, plus the newest pre-fix revision — deduped
   by revision id, then one per calendar day (latest wins; the file name
   encodes only the date), **capped at 10** by evenly thinning the middle
   while always keeping the baseline and the newest pre-fix. Revisions may be
   sparse (Google consolidates old ones) — empty buckets are skipped, the
   selection takes what exists, and the log lists exactly what was selected.
3. **Exports each selected revision** as xlsx via the revision's
   `exportLinks` (re-fetching the single revision with `fields=*` when the
   listing came without links), fetched with the OAuth bearer token.
4. **Rebuilds each as a real Google Sheet** via the Drive advanced service
   (v3 `Files.create` with the Sheets mimeType converts on upload; v2
   `Files.insert` + `convert:true` also handled), named
   **`EZONE-SNAPSHOT-AUTO-<yyyy-MM-dd>`** (the revision's date). These match
   the existing `EZONE-SNAPSHOT` name-prefix discovery, so
   `scanCorruptedRowsNow` / `writeRepairPlanNow` consume them with no further
   steps.
5. **Idempotent**: a date whose `EZONE-SNAPSHOT-AUTO-<date>` file already
   exists is skipped — re-running only fills gaps, never duplicates.
6. **Robust**: per-revision try/catch — one failed export logs and continues;
   the final summary logs revisions found / selected / harvested / skipped /
   failed.

### `deleteAutoSnapshotsNow` (new — Run dropdown, never HTTP-reachable)

Trashes every `EZONE-SNAPSHOT-AUTO-*` file (trash, not hard delete —
recoverable for 30 days) for cleanup after the repair is done. The manually
created `EZONE-SNAPSHOT` (no `-AUTO-`) is **never** touched: only names
starting with the full `EZONE-SNAPSHOT-AUTO-` prefix qualify (guard-tested).

### Snapshot discovery ordering (adjusted)

`corruptionSnapshots_` now orders by the **date encoded in the name** when
present (`…-yyyy-MM-dd` suffix): harvested files are all CREATED at harvest
time, so their `lastUpdated` says nothing about content age. A snapshot
without an encoded date (the manual copy) keeps `lastUpdated` as its key.
Oldest content still gets first priority.

### Tier-1 fallback matcher improvement

Live finding: the fallback row match (`houseId + entryDate + pay`) often hit
"2–3 rows share key — ambiguous". When multiple snapshot rows share the
fallback key, the corrupted NAME's surviving characters now disambiguate,
under the same in-order wildcard rule the enum/roster tiers use: **exactly
one** candidate with a clean, compatible name → that candidate is the match;
zero or 2+ compatible → unchanged ambiguous behavior (no proposal). Applies
only to the fallback key — `fromLead` matching is untouched.

## appsscript.json — ⚠️ first run triggers a re-authorization prompt

- Enabled the **Drive advanced service** (`Drive`, v3).
- Declared explicit **`oauthScopes`** (declaring any scope disables
  auto-detection, so the list names everything the script uses — minimal and
  explicit):
  - `spreadsheets` — SpreadsheetApp (live sheet + snapshot reads)
  - `drive` — DriveApp discovery/cleanup, revision listing/export, snapshot
    file creation
  - `script.external_request` — UrlFetchApp (REST fallback + xlsx export)
  - `script.scriptapp` — the existing digest/nightly trigger installers
  - `script.send_mail` — the existing integrity-alert email

**The first run of ANY function after this deploys will show Google's
authorization screen again** (new scope set). Approve it once; everything
then runs as before.

## Security / safety posture

- Both new entry points are absent from `handle_`'s allow-list
  (source-scan guard test) — Run dropdown only, unreachable over HTTP.
- The live spreadsheet is only READ (revision metadata + exports); harvest
  writes only new `EZONE-SNAPSHOT-AUTO-*` files.
- Cleanup can only trash the full-`-AUTO-`-prefix names, and uses trash (not
  permanent delete).
- OAuth token is used only against `www.googleapis.com` Drive endpoints.
- RepairPlan contract and `applyCorruptedRowRepairsNow` are untouched.

## Tests

`test/revision-harvest.test.js` (new, 11 tests, vm-sandbox on the real
shipped `Code.gs` with Drive advanced service / UrlFetchApp / ScriptApp
stubbed): selection windowing on sparse revisions with post-window exclusion;
dense-revision cap with baseline-first / newest-pre-fix-last / one-per-day;
no-baseline tolerance; end-to-end harvest (export → convert → discovery →
tier-1 repair); idempotent skip incl. full-re-run no-op; per-revision
failure isolation with logged summary; AUTO-only deletion never touching
manual snapshots; encoded-date discovery ordering with inverted lastUpdated;
fallback disambiguation (one compatible name → match; two → still
ambiguous); dispatch guard for both new functions. Every Drive REST fetch is
asserted to carry the OAuth bearer token.

Full suite: **783 tests, all green** (`node --test`).

## Sandra's run order (Run dropdown only — deploy is automatic via clasp CI on merge)

1. Run any function once → approve the **re-authorization prompt** (new
   Drive scope).
2. Run `harvestRevisionSnapshotsNow` — check the log's summary (found /
   selected / harvested / skipped / failed). Re-run freely; it only fills
   gaps.
3. Run `scanCorruptedRowsNow` — the dry run now proposes from all harvested
   snapshots (oldest content first).
4. Run `writeRepairPlanNow`, review the hidden RepairPlan (`source` column),
   flip `approved` to TRUE per row.
5. Run `applyCorruptedRowRepairsNow`.
6. When the repair is fully done: run `deleteAutoSnapshotsNow` to clean up
   the harvested files (your manual `EZONE-SNAPSHOT` is never touched).
