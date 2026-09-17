# Permanent monthly occupancy snapshots (`OccupancySnapshots`)

Dashboard Apps Script. Adds a permanent, append-only monthly occupancy record
per house, a monthly trigger that captures it, editor-run backfill/preview
helpers, and a read-only `doGet` action to read the history back.

**No existing action's response shape changes.** This Apps Script is shared by
three consumers (Dashboard `SHEETS_URL`, Managers `APPS_SCRIPT_URL`, Therapists
`DASHBOARD_SHEETS_URL`); `getData`, `managersOverview`, `managersHouse` and every
other action return exactly what they returned before. The only routing change
is one new `if` branch for a brand-new action.

## Why

`managersOverview_` recomputes a month's occupancy from the **live** Patients
sheet on every call. That is correct for the running month, but it means a
finished month's numbers silently change whenever a historical patient row is
later edited, merged, repaired or discharged. This writes each finished month's
per-house occupancy down **once**, so settled history stays settled.

## The sheet — `OccupancySnapshots`

Header row, **append-only** (never reorder or remove a column; new columns go at
the end, where `getOrCreateSheet_` backfills them non-destructively):

| Column | Meaning |
| --- | --- |
| `month` | `YYYY-MM`, stored as **text** (the column is pinned to `@` before the value lands, so Sheets can never coerce `2026-06` into a date cell) |
| `houseId` | `raanana` · `ramot` · `arfoni` · `rehab` · `pardes` |
| `treatmentDays` | patient-days in the month, straight from `managersOverview` |
| `daysInMonth` | 28 / 29 / 30 / 31 |
| `avgDaily` | `treatmentDays ÷ daysInMonth`, stored at 2 decimals |
| `capacity` | pinned per house (below) |
| `occupancyPct` | `avgDaily ÷ capacity × 100`, rounded to **1 decimal** |
| `manager` | the manager active at month end |
| `capturedAt` | ISO 8601 UTC timestamp of the run that wrote the row, stored as text |

**Rows are never overwritten and never deleted.** The module contains exactly one
write call, and it targets `getLastRow() + 1` and below — there is no
`clearContent`, no row delete, no `setValue` anywhere in it (guard-tested). If a
`month` + `houseId` row already exists it is **skipped**, which makes every entry
point idempotent: a second run appends zero rows. The whole write is wrapped in
`LockService.getScriptLock()`, and the existing-key set is re-read **inside** the
lock, so the monthly trigger and a manual backfill can never double-write a month.

No financial data: the column contract carries occupancy only — no billing, debt,
rate, bonus or payment field (guard-tested).

## Houses and capacity

| `houseId` | `managersOverview` key | Capacity |
| --- | --- | --- |
| `raanana` | `raanana` | 14 |
| `ramot` | `ramot` | 20 |
| `arfoni` | `efroni` | 13 |
| `rehab` | `rehab` | 13 |
| `pardes` | `pardes` | 13 |

Capacity is **pinned in code**, not read from `BonusConfig`: a snapshot is a
permanent historical record, and a later edit to the config sheet must not change
what a past month's occupancy percentage meant.

`arfoni` is Efroni's backend house id (see `EZONE-ECOSYSTEM-STATUS.md` →
"Managers: house roster"); `managerHouse` is the key the row is read from in the
overview payload, so the two vocabularies stay explicitly mapped in one table.

## No duplicated math

`snapshotMonth_(yyyyMm)` does **not** recompute occupancy. It calls
`managersOverview_(ym)` — the exact computation the Managers app reads — and
projects its per-house `treatmentDays` / `avgDaily` / `manager` into snapshot
rows. If the occupancy math ever changes, snapshots follow it automatically;
there is no second implementation to drift. The guard test fails if the module
ever reaches for `computeMonthStats_`, `readPatientsForBonus_`, `parseDate_` or
a per-day walk of its own.

## Finished months only

The **running month is refused** (`{ ok:false, error:'month_not_finished' }`),
because its occupancy is still accruing — a snapshot taken mid-month would freeze
a partial figure permanently. Future and malformed months are refused too
(`bad_month`). Months are compared as `YYYY-MM` strings against `defaultMonth_()`,
which reads the project timezone (**Asia/Jerusalem**, pinned in
`appsscript.json`).

A house that is **absent from the month's overview**, or that had **zero
treatment days**, produces **no row** — an empty row would misrepresent a house
that simply had no data.

## Entry points

| Function | Where it runs | What it does |
| --- | --- | --- |
| `runMonthlyOccupancySnapshot()` | time-driven trigger | Snapshots the **previous** month (Asia/Jerusalem). |
| `installOccupancySnapshotTrigger()` | Apps Script editor | Idempotent. Deletes **every** existing trigger bound to `runMonthlyOccupancySnapshot`, then installs exactly one time-driven trigger on **day 1 of each month, 03:00–04:00**. Other jobs' triggers are never touched. |
| `backfillOccupancySnapshotsNow()` | Apps Script editor | Writes `2026-05` → the last finished month. Idempotent; logs one summary line per month plus a total. |
| `previewOccupancySnapshotsNow()` | Apps Script editor | Same walk, **dry run** — writes nothing, logs what it would write. |

`2026-05` is the same May 2026 anchor the Managers app uses for its quarterly
windows and history pickers.

None of these four is reachable over HTTP — `handle_`'s fixed action list never
names them (guard-tested).

## New read-only action

```
doGet?action=occupancySnapshots  →  { ok: true, rows: [...] }
```

Rows sorted by `month`, then `houseId`. **Same access model as
`managersOverview`** — no new Script Property, no new secret, no auth gate, no
financial data.

## Tests

`test/occupancy-snapshots.test.js` — 37 tests, `node --test`. Real-code
extraction (the `nightly-integrity.test.js` pattern): the module's functions are
pulled out of `Code.gs` by name and evaluated in one `vm` sandbox, so the tests
exercise the **actual deployed logic**. The sheet layer runs against a fake
Sheets grid that records every write op, so append-only and text-pinning are
directly observable.

Covered: `daysInMonth` 28 / 29 / 30 / 31 (incl. the 1900 and 2000 century
cases) · `occupancyPct = avgDaily ÷ capacity × 100` rounded to 1 decimal, and
never `NaN`/`Infinity` on a zero capacity · a second run of the same month
appends **0 rows and rewrites nothing** · a later month appends **below** the
existing block, which stays byte-identical · the running month, future months and
malformed months are refused with no write · a missing house and a zero-treatment
-day house yield **no row** · `month` is stored as a **string** in a cell pinned
to `@`, with the format applied before the value · idempotency survives a `month`
cell a human reformatted into a Date · the monthly trigger targets the previous
month and rolls the year at January · the trigger installer leaves exactly one
trigger (day 1, hour 3) and removes duplicates while keeping foreign triggers ·
backfill covers `2026-05` → last finished month and is a no-op on re-run ·
preview writes nothing · the feed's shape and sort order · plus source-scan
guards for append-only, `LockService`, the shared computation, no new secret, the
`doGet` routing, and `managersOverview_` / `managersHouse_` being untouched.

Full suite after this change: **983 tests green** (`node --test`).

## Deploy

Merging to `claude/build-ezone-dashboard-QOg5s` triggers the clasp CI workflow,
which redeploys the **existing** deployment (`clasp deploy -i <DEPLOYMENT_ID>`)
as a new version — **the `/exec` URL does not change**, so all three consumers
keep working. After the deploy, run `installOccupancySnapshotTrigger()` once and
then `backfillOccupancySnapshotsNow()` from the editor — see `DEPLOY.md` →
"Occupancy snapshots".
