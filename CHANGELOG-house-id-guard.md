# House-id guard test

## What

Adds `test/house-id-guard.test.js`, a unit test that locks the house-id
contract shared between `public/app.js` and `apps-script/Code.gs`. No product
code changes — this is a regression guard only.

## Why

The dashboard's internal house ids in `public/app.js` (`HOUSES`) diverge from
the canonical ids used by the bonus dashboard and the ActivePatients digest in
`apps-script/Code.gs`:

| internal id (`app.js`) | Hebrew label   | canonical id (`Code.gs`) |
| ---------------------- | -------------- | ------------------------ |
| `arfoni`               | קיסריה עפרוני  | `efroni`                 |
| `asher`                | רעננה אשר      | `raanana`                |
| `ramot`                | רמות השבים     | `ramot`                  |
| `rehab`                | קיסריה ריהאב   | `rehab`                  |
| `pardes`               | רעננה הפרדס    | — (excluded)             |
| `sde`                  | שדה אליעזר     | — (excluded)             |

This divergence is **intentional** — `Code.gs` reads residence data from a
Patients sheet that was set up with the older ids, and the mapping tables let it
do so without forcing a historical rename (see `Code.gs:59-63`). The two files
are wired together only by three hand-maintained tables:

- `DIGEST_HOUSE_NAME_TO_INTERNAL` — Hebrew label → internal id
- `DIGEST_INTERNAL_TO_CANONICAL` — internal id → canonical digest id
- `MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID` — canonical bonus id → internal id

Nothing else breaks if someone renames a `HOUSES` id, edits a Hebrew label, or
drops a house from one of these maps. The digest would simply — and silently —
stop emitting that house. This test makes such drift a CI failure instead.

## What it locks

The test evaluates both sources in a `vm` sandbox (same pattern as
`coordinators-patients-digest.test.js` / `lead-assignedto.test.js`) and reaches
the real shipped values, then asserts against an **explicit, fully enumerated**
key set (no wildcards, nothing derived from the source):

- `HOUSES` is exactly the six houses, in order, with their Hebrew labels.
- `'arfoni'` is the internal key and `קיסריה עפרוני` its label — and
  `canonicalDigestHouse_('arfoni') === 'efroni'`.
- The set of ids `Code.gs` accepts equals the `app.js` id set exactly.
- `Code.gs`'s Hebrew-name → internal-id map mirrors `HOUSES` id ↔ label exactly.
- `DIGEST_INTERNAL_TO_CANONICAL` is exactly the four canonical houses;
  `pardes`/`sde` resolve to `''` (excluded, never renamed).
- The manager/bonus side maps `efroni`/`raanana` back to `arfoni`/`asher`.

## Test

`node --test` — full suite: **181 passing, 0 failing** (6 new).
