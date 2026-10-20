# «חתכי מטופלים» foundation — length of stay + «המשך טיפול» (PR 1 of 3)

**What:** the data and rules for the patient-retention report. **Zero
user-facing change**: nothing new is rendered, the discharge modal is
unchanged, and the new module is not loaded by the page yet (PR 2 wires it).

Base: `claude/build-ezone-dashboard-QOg5s`. Code.gs **changed** (deployed by
the clasp CI on merge). SW `v76` → `v77` (live `/sw.js` read v76 on
20/10/2026; v17 never reused).

## Data — append-only

- New column **`continuity`** appended LAST to `DISCHARGED_PATIENT_COLUMNS`
  (sheet «מטופלים משוחררים»). `getOrCreateSheet_` appends the header on the
  first write; no existing column is renamed, moved or deleted.
- Stable keys (the Hebrew is render-time only):

  | key | label |
  | --- | --- |
  | `continued_outpatient` | המשיך באמבולטורי (E-ZONE) |
  | `continued_other` | המשיך במסגרת טיפולית אחרת |
  | `none` | לא המשיך |
  | `unknown` | לא ידוע — the default for every legacy (blank) row |

  The map lives in `lib/patient-retention.js` (`CONTINUITY_LABELS`). Code.gs
  `CONTINUITY_KEYS` and app.js `DISCHARGE_CONTINUITY_KEYS` mirror the keys; a
  guard test pins all three lists equal.

## Code.gs

- `dischargePatient_` validates `patient.continuity` **before** the lock:
  absent / blank → `'unknown'`; a known key is stored; anything else →
  `{ok:false, error:'bad_continuity'}` and nothing is written.
- New action **`setDischargeContinuity { id, continuity }`** (added to
  `PROXY_KNOWN_ACTIONS`; not a Patients write, not a delete):
  - validated before the lock: `id` required (≤ 200 chars, string/number);
    `continuity` must be one of `continued_outpatient` / `continued_other` /
    `none` — `'unknown'` is not a choice;
  - under `LockService`: the row is found by the id column only; missing →
    `not_found`, soft-deleted → `row_deleted`;
  - per-row write: the `continuity` cell + `updatedAt` / `updatedBy` (single
    cell / 1×2 ranges on that row, never a sheet rewrite); one AuditLog row
    `discharge_continuity_set` with the previous value; the same value again
    writes nothing (`unchanged: true`).
- The restore paths (`restorePatient_`, `restorePatientToActive_`) upsert a
  whole client copy of the row: `carryDischargeDeleteStamps_` now also keeps
  a recorded key when the copy carries `'unknown'`, blank, or junk (an older
  cached bundle never blanks or downgrades it).
- The coordinators discharge (`recordDischargeFromCoordinators_`) writes
  `'unknown'`.

## app.js

`normalizeDischargedPatient` carries `continuity` through `pickField`
(aliases `continuity`, `המשך טיפול`); blank or unknown values read
`'unknown'`. The discharge payload does **not** send it yet (PR 2).

## `lib/patient-retention.js` (pure, UMD — `window.PatientRetention` later)

- `stayDays(patient, today?)` — **not inclusive**: discharge day − entry day
  (same-day discharge = 0; 01/10 → 31/10 = 30). Active stays count to
  today. Dates use the same rule as app.js `isoDate`: a bare `YYYY-MM-DD` is
  taken as is, a timestamp becomes its **Asia/Jerusalem** calendar day; the
  arithmetic is `Date.UTC` on the three numbers (no DST drift).
- The discharge day = audit `exitDate`, else the day of `dischargedAt`, else
  the Patients row's `exitDate` (the order the discharged tab already shows).
- `bucketFor(days, customThreshold)` → `{ bucket: 'upTo30'|'d31to60'|'over60',
  custom: 'atOrBelow'|'above'|null }` (0–30 / 31–60 / 61+; custom split ≤ N /
  > N; N must be a whole number 1–3650, else no split).
- `computeRetention({ patients, discharged, from, to, customThreshold, today })`
  — the cohort is every **stay** whose entry date is in `[from, to]`
  (inclusive). Returning stays (`personId`) count by their own dates. An open
  audit row = a discharged stay (a duplicate open row counts once); a restored
  row is ignored; a released Patients row without an audit row is a
  discharged stay with continuity `unknown`. Returns bucket counts, «עדיין
  בטיפול» with its own days-so-far buckets, the custom split, continuity
  counts and the bucket × continuity cross table (discharged only),
  percentages as fractions (length cards: of the cohort; continuity: of the
  discharged), and the row list behind every number.
- «נתונים חסרים» — never silently dropped: `no_entry_date`,
  `no_discharge_date`, `discharge_before_entry`, `entry_in_future`.

## Tests

- `test/patient-retention.test.js` — the pure module (boundaries, same-day,
  DST, timestamps → Israel day, missing data, restored / duplicate / returning
  stays, invalid thresholds, empty input, purity).
- `test/patient-retention-foundation.test.js` — real Code.gs + app.js:
  schema, key parity, discharge default / refusal, the update op (validation,
  single-row writes, lock, deleted row, idempotent, audit), restore carry,
  normalizer, SW bump.
- Schema pins updated: `cross-app-payload-guard`, `patient-identity-foundation`,
  `restore-choice-modal`, `duplicate-discharges`; SW pin in `dashboard-perf-assets`.

## Security

Server-side validation of every key; fail-closed (unknown key → refused,
nothing written); no new route; no secret; `npm audit`: 0 high / 0 critical
(1 pre-existing moderate in express's tree).
