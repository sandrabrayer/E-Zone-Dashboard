# Coordinators ActivePatients digest — read-only patients feed

Adds a read-only **digest export** so the coordinators app can consume the
currently-active patient population without coupling to the main dashboard
spreadsheet. Follows the digest pattern proven with logistics + kitchen: a small,
separate spreadsheet that this app creates and owns as the **sole writer**,
shared read-only with the coordinators reviewer.

> **Superseded (source fix):** the digest originally read the pre-admission
> `paid` kanban leads; it now reads the active resident population. See
> [`CHANGELOG-activepatients-digest-source-fix.md`](CHANGELOG-activepatients-digest-source-fix.md).
> The sections below describe the original feature.

## What it does

- Maintains an **`ActivePatients`** tab in a dedicated digest spreadsheet,
  rebuilt in full to contain every lead currently in stage **`בטיפול פעיל`**
  (stable id `paid`) with its house.
- **Rebuilds on lead-stage change** — best-effort, fail-soft at the end of every
  lead-mutating request (`saveAll`, `moveLeadIrrelevant`, `restoreLead`,
  `removeLead`) — plus an **hourly time-based trigger** as a backstop.
- The in-request rebuild can never break the primary read/write path: any digest
  error is caught and logged, and the rebuild silently no-ops until setup runs.

## Frozen column contract (append-only)

| Column        | Meaning                                                    |
|---------------|------------------------------------------------------------|
| `house`       | Canonical id: `ramot` \| `raanana` \| `efroni` \| `rehab`. |
| `patientName` | Lead display name.                                         |
| `patientId`   | The lead's stable id (`Leads.id`).                         |
| `updatedAt`   | ISO 8601 **UTC** timestamp of the rebuild.                 |

- **HARD RULE — no financial fields.** Rows are projected from exactly these four
  columns; no billing, debt, rates, advance, or payment data is ever written.
- **House encoding** maps internal ids / Hebrew names to canonical ids
  (`asher→raanana`, `ramot→ramot`, `arfoni→efroni`, `rehab→rehab`); houses
  outside the four (`pardes`, `sde`, unknown) are **excluded**, not renamed.

The authoritative schema lives in [`DIGEST-CONTRACT.md`](DIGEST-CONTRACT.md) at
the repo root.

## Setup (one-time)

Run **`setupActivePatientsDigest`** once from the Apps Script editor. It creates
(or reuses) the digest spreadsheet, stores its id in the `DIGEST_SPREADSHEET_ID`
script property, creates the frozen `ActivePatients` tab, shares it read-only
with `brayersandra@gmail.com`, installs the hourly trigger, does an initial
rebuild, and prints the spreadsheet id / URL / tab / columns to the log.

> The setup + rebuild use `SpreadsheetApp` (open-by-id), `DriveApp` (share), and
> `ScriptApp` (trigger), which need broader OAuth scopes than the base dashboard.
> Running setup from the editor prompts for consent; the web-app deployment must
> be re-authorized once for its request-path rebuilds to succeed (until then the
> fail-soft guard skips them).

## Tests

`test/coordinators-patients-digest.test.js` evaluates the shipped `Code.gs` in a
vm sandbox and locks: the stage filter, the house-encoding map (incl. exclusions),
the four-column no-financial-leak projection, the whole-tab replace (stale rows
disappear), and the not-configured no-op. Full suite: 175 tests green.
