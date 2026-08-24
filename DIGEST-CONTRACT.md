# DIGEST-CONTRACT — ActivePatients feed (E-Zone Dashboard → Coordinators)

The E-Zone Dashboard publishes a small, read-only **digest** spreadsheet that
the coordinators app consumes. This file is the authoritative, verbatim copy of
the schema. The producing code lives in
[`apps-script/Code.gs`](apps-script/Code.gs) (the "Coordinators digest" section)
and the contract is locked by
[`test/coordinators-patients-digest.test.js`](test/coordinators-patients-digest.test.js).

## Ownership

- The digest lives in its **own dedicated spreadsheet**, separate from the main
  dashboard spreadsheet.
- The Dashboard Apps Script is the **sole writer**. Consumers (coordinators)
  read only. The spreadsheet is shared **read-only** with `brayersandra@gmail.com`.
- The spreadsheet id is stored in the Script Property `DIGEST_SPREADSHEET_ID`.

## Tab

- Tab name: **`ActivePatients`** (row 1 is a frozen header).

## Contents

- One row per **patient currently in active treatment in a house** — a
  `Patients`-sheet resident whose status is **`active`** (בטיפול פעיל / פעיל).
  This is the same population the dashboard's per-house occupancy board shows,
  so the digest's per-house row counts match the board.
- The digest is **rebuilt in full** on every rebuild — never incremental. A rows
  set that no longer qualifies simply disappears on the next rebuild.

> **History.** The digest originally sourced from the pre-admission `paid`
> kanban leads — the column labelled "בטיפול פעיל". That was wrong: that column
> holds a handful of leads who have paid an advance but are **not yet in a
> house** (most with no house set), so the feed was near-empty and skewed to a
> single house. The patients coordinators need — "in active treatment, in every
> house" — are the admitted residents, which is what the digest now exports.

## Columns (FROZEN CONTRACT — append-only; never reorder or remove)

| # | Column        | Description                                                        |
|---|---------------|--------------------------------------------------------------------|
| 1 | `house`       | Canonical house id: `ramot` \| `raanana` \| `efroni` \| `rehab` \| `pardes`. |
| 2 | `patientName` | Patient display name.                                              |
| 3 | `patientId`   | Stable per-patient key. The `Patients` sheet has **no** persisted id column, so this is derived deterministically from the patient's identifying fields (`houseId` + name + entry date) — the same patient yields the same id across rebuilds. |
| 4 | `updatedAt`   | ISO 8601 **UTC** timestamp of the rebuild that produced the row.   |

**Append-only rule:** new columns may only be added to the right of column 4.
Existing columns are never renamed, reordered, or removed, so consumers can map
by position or by header safely.

### HARD RULE — no financial fields

The digest carries **no** financial data of any kind: no billing, debt, rates,
advance, or payment fields. Each row is projected from exactly the four columns
above and nothing else.

## House encoding

A patient's house comes from the `Patients` sheet `houseId` (a dashboard
internal id). It is encoded as a canonical id. Only these five houses are
exported; any house outside them (e.g. `sde`, or an unknown/blank value) is
**excluded**, not renamed. A Hebrew display name is also accepted so
mixed/legacy rows still resolve.

| Dashboard internal id | Hebrew display name | Canonical digest id |
|-----------------------|---------------------|---------------------|
| `asher`               | רעננה אשר            | `raanana`           |
| `ramot`               | רמות השבים          | `ramot`             |
| `arfoni`              | קיסריה עפרוני        | `efroni`            |
| `rehab`               | קיסריה ריהאב         | `rehab`             |
| `pardes`              | רעננה הפרדס          | `pardes`            |
| `sde`                 | שדה אליעזר           | *(excluded)*        |

> `pardes` (רעננה הפרדס) became canonical in 2026-08 when the house went live.
> A canonical house with **zero** active residents simply has no rows in the
> feed — consumers (coordinators) render their own empty state for it; absence
> of rows is a valid, honest result, never an error.

## Rebuild cadence

- **On change:** rebuilt (best-effort, fail-soft) at the end of every request
  that can change the active-resident population — `saveAll` (admissions and
  patient status/house changes ride this), `dischargePatient`, `restorePatient`,
  `restorePatientToActive`, plus the lead paths (`moveLeadIrrelevant`,
  `restoreLead`, `removeLead`). A digest failure can never break the primary
  read/write path.
- **Backstop:** an hourly time-based trigger (`rebuildActivePatientsDigest`)
  rebuilds the digest even if a mutation path is ever missed.
- **Diagnostics:** run **`diagnoseActivePatientsDigest`** from the editor to see,
  read-only, the resident count per status and — among active residents — the
  per-house kept count plus every dropped row with its exclusion reason (so a
  missing/unknown house is visible, never silently dropped).

## One-time setup

Run **`setupActivePatientsDigest`** once from the Apps Script editor. It:

1. Creates the digest spreadsheet (or reuses the recorded one) and stores its id
   in the `DIGEST_SPREADSHEET_ID` script property.
2. Creates the `ActivePatients` tab with the frozen header row.
3. Shares the spreadsheet read-only with `brayersandra@gmail.com`.
4. Installs the hourly backstop trigger.
5. Does an initial rebuild.
6. Prints the spreadsheet id, URL, tab name, and column schema to the execution
   log (`View → Logs`).

> The setup function and the rebuild use `SpreadsheetApp` (open-by-id),
> `DriveApp` (share), and `ScriptApp` (trigger), which require broader OAuth
> scopes than the base dashboard. Running `setupActivePatientsDigest` from the
> editor triggers the consent prompt for the deploying account; the web-app
> deployment must be re-authorized once so its request-path rebuilds succeed
> (until then they are silently skipped by the fail-soft guard).
