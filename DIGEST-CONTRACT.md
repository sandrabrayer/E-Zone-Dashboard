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

- One row per lead currently in stage **`בטיפול פעיל`** (stable id `paid` — the
  last kanban column: patients in active treatment who have not yet been
  admitted into a house).
- The digest is **rebuilt in full** on every rebuild — never incremental. A rows
  set that no longer qualifies simply disappears on the next rebuild.

## Columns (FROZEN CONTRACT — append-only; never reorder or remove)

| # | Column        | Description                                                        |
|---|---------------|--------------------------------------------------------------------|
| 1 | `house`       | Canonical house id: `ramot` \| `raanana` \| `efroni` \| `rehab`.   |
| 2 | `patientName` | Lead display name.                                                 |
| 3 | `patientId`   | The lead's stable id (`Leads.id`).                                 |
| 4 | `updatedAt`   | ISO 8601 **UTC** timestamp of the rebuild that produced the row.   |

**Append-only rule:** new columns may only be added to the right of column 4.
Existing columns are never renamed, reordered, or removed, so consumers can map
by position or by header safely.

### HARD RULE — no financial fields

The digest carries **no** financial data of any kind: no billing, debt, rates,
advance, or payment fields. Each row is projected from exactly the four columns
above and nothing else.

## House encoding

House labels are encoded as canonical ids. Only these four houses are exported;
any house outside them (e.g. `pardes`, `sde`, or an unknown value) is
**excluded**, not renamed.

| Dashboard internal id | Hebrew display name | Canonical digest id |
|-----------------------|---------------------|---------------------|
| `asher`               | רעננה אשר            | `raanana`           |
| `ramot`               | רמות השבים          | `ramot`             |
| `arfoni`              | קיסריה עפרוני        | `efroni`            |
| `rehab`               | קיסריה ריהאב         | `rehab`             |
| `pardes`              | רעננה הפרדס          | *(excluded)*        |
| `sde`                 | שדה אליעזר           | *(excluded)*        |

## Rebuild cadence

- **On change:** rebuilt (best-effort, fail-soft) at the end of every
  lead-mutating request — `saveAll` (kanban stage changes ride this),
  `moveLeadIrrelevant`, `restoreLead`, `removeLead`. A digest failure can never
  break the primary read/write path.
- **Backstop:** an hourly time-based trigger (`rebuildActivePatientsDigest`)
  rebuilds the digest even if a mutation path is ever missed.

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
