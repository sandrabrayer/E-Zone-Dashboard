# CHANGELOG — house pardes (רעננה הפרדס) added to every backend house enumeration

## Why

רעננה הפרדס went live across the ecosystem (coordinators, staffing, managers
frontend), but this repo's shared Apps Script still treated it as an unknown
house:

- The managers app (`/#pardes`) proxies this backend's `managersHouse` action,
  which returned `{ ok: false, error: 'unknown_house' }` because `pardes` was
  missing from `MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID`.
- The ActivePatients digest (consumed by ezone-coordinators' לוח טיפולים)
  deliberately excluded `pardes` from its canonical house set, so pardes
  residents could never appear in the feed.

## What changed

### `apps-script/Code.gs` (isolated commit — triggers a clasp CI redeploy on merge)

- **Managers/bonus side** — `pardes` added to `MANAGER_HOUSES`,
  `MANAGER_HOUSE_NAMES` (label `רעננה הפרדס`), and
  `MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID` (patients-sheet id `pardes` — same id on
  both sides, no historical rename to bridge). `managersHouse('pardes')` and
  `managersOverview` now return the house with honest empty values (no
  BonusConfig/Managers rows yet → bep/capacity/bonus 0, manager '', patientsNow
  0). `unknown_house` for pardes is resolved.
- **ActivePatients digest** — `pardes` added to `DIGEST_CANONICAL_HOUSES` and
  `DIGEST_INTERNAL_TO_CANONICAL` (canonical id `pardes`). Active pardes
  residents now export; with zero residents today the feed simply carries no
  pardes rows — a clean empty state per DIGEST-CONTRACT.md, never an error.
  `sde` and unknown houses remain excluded.
- **`HOUSE_MANAGERS` intentionally unchanged** — no manager is named for pardes
  yet; every consumer renders a blank manager for a missing key (locked by
  `test/meetings-board.test.js`).

### No sheet changes required

Patients live in a single `Patients` sheet keyed by the `houseId` column, and
Managers/BonusConfig/Outpatients are row-keyed by house — there are no
per-house tabs anywhere, so a new house needs no tab and no seeding. Optional
(not required): adding a `pardes` row to `BonusConfig`/`Managers` later
activates bonus tracking and the manager name.

### This repo's own UI

Already fully enumerated pardes before this change (`HOUSES`,
`serializePatients`, break-even defaults, price fallbacks) — no frontend change
needed. The break-even default for pardes stays `active: false` with zero
expense figures until real figures exist; it is user-toggleable in the UI.

### Docs + tests

- `DIGEST-CONTRACT.md` — house-encoding table updated: `pardes` → canonical
  `pardes`; documented that a canonical house with zero residents has no rows
  (absence is valid, not an error).
- `test/house-id-guard.test.js` — expectations updated to the five-house
  canonical set, plus a new guard test asserting **every** house enumeration
  (digest canonical set, internal→canonical map values, `MANAGER_HOUSES`,
  `MANAGER_HOUSE_NAMES`, `MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID`) covers the full
  canonical house list including pardes.
- `test/coordinators-patients-digest.test.js` — pardes now included in
  projection/rebuild fixtures (`sde` takes over as the excluded-house case),
  plus a new test proving a zero-resident pardes yields no rows and no error.

## Deploy

Merging to `claude/build-ezone-dashboard-QOg5s` auto-deploys both halves:
Railway redeploys the Node app, and the `deploy-apps-script.yml` workflow
publishes a **new version of the EXISTING Apps Script deployment** (same
deployment ID — the `/exec` URL never changes). No manual deploy step.

## Verification

- Managers app `/#pardes` loads without `unknown_house` (all-zero month view).
- Coordinators לוח טיפולים shows the pardes empty state (digest carries no
  pardes rows until residents are admitted).
