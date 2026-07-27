# ActivePatients digest — fix the source population (active residents, not paid leads)

The coordinators `ActivePatients` digest was near-empty and skewed: it contained
only patients from a single house, while every house visibly has patients in
active treatment on the dashboard board. This fixes the root cause.

## Root cause

The digest sourced its rows from the **pre-admission `paid` kanban leads** — the
column labelled **בטיפול פעיל**. That label is misleading: the `paid` column
holds leads who have paid an advance but are **not yet admitted into a house**.
In the live data there were only 3 such leads, and 2 of them had **no house set**
(the preferred-house field is optional), so they were silently dropped by the
canonical-house mapper. The one remaining lead happened to be `efroni`, so the
whole feed collapsed to a single `efroni` row.

The patients coordinators actually need — "in active treatment, in every house" —
are the **admitted residents** in the `Patients` sheet whose status is `active`.
That is exactly the population the dashboard's per-house occupancy board shows.

Investigation on the live spreadsheet (`דשבורד איזון`):

- **Stage counts in `Leads`:** `new` 61, `admitted` 43, `visit` 22,
  `irrelevant` 6, **`paid` 3**. The `בטיפול פעיל` label is the `paid` column, and
  the old filter *was* matching `paid` correctly — the population itself was wrong.
- **Houses of the 3 `paid` leads:** `קיסריה עפרוני` → `efroni` (kept); two with a
  **blank** house → dropped. So the mapper was byte-correct; the drops were
  house-less rows, not mis-mapped ones.
- **Active residents (`Patients`, status `active`):** 41, across every house —
  `efroni` 9, `raanana` 10, `ramot` 13, `rehab` 9.

## The fix

- `buildActivePatientsRows_` now projects **patients** (not leads): a resident is
  exported when their status is **active** (`active` / `פעיל`) and their `houseId`
  maps to one of the four canonical houses.
- `rebuildActivePatientsDigest_` reads the **`Patients`** sheet.
- `patientId` is a deterministic derived key (`ap:<house>:<name>:<entryDate>`)
  because the `Patients` sheet has no persisted id column; the same patient
  yields the same id across rebuilds.
- The rebuild now fires on the request paths that change the resident population:
  `saveAll` (when patients are present — admissions and status/house changes),
  `dischargePatient`, `restorePatient`, and `restorePatientToActive`, in addition
  to the existing lead paths. The hourly backstop trigger is unchanged.
- New **`diagnoseActivePatientsDigest`** editor function reports, read-only, the
  resident count per status and — among active residents — the per-house kept
  count plus every dropped row with its exclusion reason. Exclusions are no
  longer silent.
- The **4-column contract is unchanged** (`house`, `patientName`, `patientId`,
  `updatedAt`) and the no-financial-leak rule still holds — `pay`/`adv` and every
  other `Patients` field are provably absent from the projection.

## Before / after (live data)

| House    | Board (active residents) | Digest before | Digest after |
|----------|--------------------------|---------------|--------------|
| efroni   | 9                        | 1             | 9            |
| raanana  | 10                       | 0             | 10           |
| ramot    | 13                       | 0             | 13           |
| rehab    | 9                        | 0             | 9            |
| **Total**| **41**                   | **1**         | **41**       |

## Tests

`test/coordinators-patients-digest.test.js` was updated to lock the new contract:
the active-status filter (`active`/`פעיל` in, `released`/`trial`/`wait`/blank
out), the house-encoding map (incl. exclusions), the deterministic stable
`patientId`, the four-column no-financial-leak projection, the whole-tab replace
(stale rows disappear on discharge), and the not-configured no-op. Full digest
suite green.
