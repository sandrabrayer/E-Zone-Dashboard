# Patient exitDate no longer drifts −1 day (timezone fix + one-time repair)

Backend-only change (`apps-script/Code.gs`). **Zero UI change** — `public/app.js`
is untouched. clasp CI redeploys the Apps Script on merge to the deploy branch.

## Symptom

Patients `exitDate` cells held UTC timestamps such as `2026-05-06T21:00:00.000Z`
for a discharge entered as **2026-05-07** (Israel, UTC+3). Read back and
re-saved, the day walked −1.

## Root cause (Phase 1 findings)

- `replaceHousePatients_` text-forced the entry `date` column
  (`setNumberFormat('@')`) before its bulk write but **not `exitDate`**, so Sheets
  coerced the bare `"2026-05-07"` string into a date-typed cell at local
  midnight; `getValues()` returned a `Date`; JSON serialized it as UTC; the day
  drifted. Same pitfall previously fixed for `date` and for the leads'
  `visitDate`/`visitTime`.
- `asISODate_` formatted a **Date object** correctly (spreadsheet timezone,
  `Utilities.formatDate`), but **sliced an ISO-timestamp string** to its UTC day
  (`2026-05-06T21:00:00.000Z` → `2026-05-06`) — so a drifted value echoed back
  by the client was persisted on the wrong day.
- The discharge/restore writers (`dischargePatient_`, `restorePatient_`,
  `restorePatientToActive_`) go through `upsertRowById_`, which normalized and
  text-forced only the leads' date columns — `date` and `exitDate` landed raw on
  DischargedPatients with no text force at all.
- `appendPatientTombstones_` normalized `date` only; PatientsTombstones was
  text-forced for `date`/`droppedAt` but not `exitDate`.
- `getData_` serialized Patients / DischargedPatients rows raw, so a legacy
  date-typed cell reached the client as a UTC timestamp.
- `patientRowDiffCols_` already compared `exitDate` through `asISODate_`, which
  is why the drift never surfaced as `updatedAt` churn.
- `parseDate_` (bonus/occupancy reader) would misread a numeric Sheets serial as
  epoch milliseconds — relevant once a whole-column text force is applied to a
  legacy date-typed cell (see "Serial numbers" below).

## Phase 2A — Prevent

- **`asISODate_`** now yields the LOCAL (spreadsheet-timezone, Asia/Jerusalem)
  `yyyy-MM-dd` for every form: `Date` object; Sheets date **serial number**;
  ISO-timestamp **string carrying a timezone marker** (`Z` or `±hh:mm`) — parsed
  and formatted in the sheet tz instead of sliced; bare `yyyy-MM-dd` unchanged; a
  tz-less `yyyy-MM-ddT…` string keeps its leading (wall-clock) date; blank → blank.
  The timezone lookup is lazy, so a bare string never touches a GAS service.
- **Text-force `exitDate` wherever `date` is** — at sheet-ensure time
  (`getOrCreateSheet_`: Patients, DischargedPatients, PatientsTombstones now force
  `date` + `exitDate` whole-column) AND immediately before the bulk write in
  `replaceHousePatients_` (`exitDateColIdx`, exactly like `dateColIdx`).
- **Normalize on write** — `replaceHousePatients_` canonicalizes `exitDate` for
  every row (kept/preserved/new) via `asISODate_`; `upsertRowById_` (discharge +
  both restores) now treats `date` and `exitDate` as date-like columns
  (`DATE_LIKE_COLUMNS`): normalized and text-forced at the target row before
  `setValues`; `appendPatientTombstones_` snapshots `exitDate` normalized.
- **Normalize on read** — `getData_` runs Patients and DischargedPatients rows
  through `normalizePatientDates_` (`date` + `exitDate` via `asISODate_`), so a
  legacy Date cell can never reach the client as a UTC timestamp, even before the
  repair runs. `dischargedAt`/`updatedAt` are true timestamps and stay untouched.
- **`parseDate_`** reads a Sheets date serial as its exact calendar day.

### Serial numbers — why `date` rides along

Applying a plain-text format to a cell that already holds a **date value** makes
Sheets return that cell as a numeric serial (days since 1899-12-30). Because this
change adds the whole-column force on `date` for the discharged sheet (never
forced before), such legacy cells are read defensively (`asISODate_`/`parseDate_`
convert serials) **and** the one-time repair rewrites them as text in the same
pass as `exitDate`.

## Phase 2B — One-time repair (Run dropdown only, not HTTP-reachable)

- **`previewPatientExitDatesNow`** — same scan, **zero writes** (no format, no
  values, no audit row); logs per sheet what would change.
- **`repairPatientExitDatesNow`** — for Patients, DischargedPatients,
  PatientsTombstones: every `exitDate` (and `date`) cell that is a `Date` object,
  a Sheets serial, or text matching `/^\d{4}-\d{2}-\d{2}T/` is rewritten as the
  local `yyyy-MM-dd`; the column is forced to `@` first, then each drifted cell
  alone gets `@` + the string (never a whole-column value rewrite). Runs under
  `LockService`. Idempotent — a second run rewrites 0 cells and adds no audit
  row. `Logger` summary per sheet (scanned / rewritten per column / up to 5
  examples). One `logAudit_('exit_date_repaired', …)` event with the counts.
- **`updatedAt`/`updatedBy` are deliberately NOT re-stamped** — this is a storage
  format fix, not an edit; the discharge day the user chose does not change.
  The audit details carry `stampsRestamped: false`.
- Neither function is named in `handle_`'s action allow-list (guard-tested), same
  non-exposure argument as `repairLeadVisitTimes`.

## Sandra's run order

1. Merge this PR into `claude/build-ezone-dashboard-QOg5s` (merge commit). clasp
   CI redeploys the Apps Script.
2. Apps Script editor → Run dropdown → **`previewPatientExitDatesNow`** → read
   the Logger summary (what would change, per sheet).
3. Run **`repairPatientExitDatesNow`** → Logger summary + one
   `exit_date_repaired` row in the hidden AuditLog sheet.
4. Re-run **`previewPatientExitDatesNow`** → expect `total … 0 would be
   rewritten`.

## Tests (`node --test`, vm-sandbox on the shipped `Code.gs`)

New `test/exitdate-timezone.test.js` (14 tests) with a **timezone-aware**
`Utilities.formatDate` stub (the sibling suites' UTC-slice stub could not
exercise the local-day path):

- `asISODate_`: Date at 21:00Z → next local day (summer and winter); tz-marked
  timestamp string re-localized; bare string unchanged; blank → blank; serial →
  its day; `parseDate_` on a serial.
- `replaceHousePatients_` writes `exitDate` as `yyyy-MM-dd` from a timestamp
  payload and from a Date-typed kept cell; blank stays blank; `exitDate` column
  text-forced before `setValues`; a storage-form-only difference does not
  re-stamp `updatedAt`; source-scan guard for the `exitDateColIdx` force (like the
  `date` one).
- `getData_` serializes Date-typed `exitDate`/`date` as `yyyy-MM-dd` (Patients +
  DischargedPatients).
- `dischargePatient_` normalizes + text-forces `date`/`exitDate` at the target
  row; tombstones snapshot `exitDate` normalized; sheet-ensure forces the whole
  `date`/`exitDate` columns on the three sheets.
- Repair: converts Date, serial and ISO-timestamp cells, leaves clean strings
  alone, stamps untouched, audit row with counts, idempotent (second run = 0
  writes, no second audit row), preview writes nothing, fresh spreadsheet no-op,
  neither function dispatchable via `handle_`.

Updated `test/visittime-text-columns-and-quarter-select.test.js`: its
`Utilities.formatDate` stub returned a constant, which only passed because the
old `asISODate_` sliced timestamp strings; it now uses the timezone-aware stub and
expects the correct local day (`…07-27T21:00Z` → `2026-07-28`).

Full suite: 868 passing.

## Not changed

- No new columns (append-only contract untouched). No HTTP action added.
- `public/app.js` untouched (zero UI change); its `isoDate`/`formatDate` already
  handle both bare dates and timestamps.
- `dischargedAt`, `droppedAt`, `updatedAt` remain true ISO timestamps.
