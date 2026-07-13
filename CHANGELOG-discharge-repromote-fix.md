# Discharge re-promotion fix — released patient reappears after reload

## Symptom

A discharged patient (e.g. אלה אנגר) reappears as an active/trial patient after
a reload. Vered discharges her again, but it "doesn't stick" — she keeps coming
back, and each discharge writes another duplicate row into the
מטופלים משוחררים (discharged patients) sheet.

## Root cause

Frontend-only, in `public/app.js`. Two facts combine:

1. **Discharge never retired the source lead.** `dischargePatient()` sets
   `p.status = 'released'`, writes the exit date, and appends an audit row to the
   discharged-patients sheet — but it leaves the patient's SOURCE lead parked at
   `stage = 'entry'` / `'entered'`.

2. **Auto-promotion ignored discharged patients.** On every `loadAll()`,
   `promoteEnteredLeads()` re-creates a patient from any `entry`/`entered` lead
   that has no matching **active** patient. It consulted only `state.patients` —
   never `state.dischargedPatients`. If the released patient row was dropped from
   the sheet by the whole-house-replace path (`replaceHousePatients_`), the
   source lead is still `entry`, so she is re-promoted as `status = 'trial'` and
   returns to the active roster. Discharging again just repeats the cycle (this
   produced the duplicate audit rows seen in production).

## Fix — two guards (defense in depth)

### Guard 1 — load-side (`promoteEnteredLeads`)

`promoteEnteredLeads()` now also builds a lookup from `state.dischargedPatients`,
indexing every row whose `restored` is **not** `'TRUE'` / `true` by BOTH keys it
already uses for the active-patient match:

- `fromLead` → `String(d.fromLead)`
- `houseId::name` → `` `${d.houseId}::${String(d.name).trim()}` ``

Any `entry`/`entered` lead that matches a non-restored discharged row by either
key is **skipped** — no patient is created. `restored === 'TRUE'` rows are
deliberately left out of the index so the existing restore-to-lead flow still
re-promotes a restored patient.

This is the essential guard: it also covers **hand-entered** patients (no
`fromLead`) via the `houseId::name` key, which Guard 2 cannot.

### Guard 2 — discharge-time (`dischargePatient`)

In `dischargePatient()`'s `onConfirm`, after resolving the patient's `fromLead`
to a real lead in `state.leads`, the lead's `stage` is set to `'admitted'` — the
same terminal stage `retireAdmittedLeads()` uses, which drops the lead out of
`promoteEnteredLeads()`'s candidate pool entirely.

- The lead mutation is applied before `saveAll()`, so it persists in the same
  write as the release.
- The rollback path (`prev` now also captures the lead and its prior stage) is
  factored into a `rollback()` helper that restores the patient's `status` /
  `exitDate` **and** the lead's prior `stage`, and drops the optimistic audit
  row. It runs if either `saveAll()` or the `dischargePatient` POST fails.
- Only a `fromLead` that resolves to a real lead is touched; hand-entered
  patients (no `fromLead`) are left to Guard 1.

## Scope

- **Frontend only** — `public/app.js`. No change to `apps-script/Code.gs`; no
  Apps Script deploy is needed.

## Tests

New suite `test/discharge-repromote-fix.test.js` (node:test + vm-sandbox pattern,
same as the other suites — not Jest), exercising the real shipped functions:

- Guard 1 does NOT promote an entry lead matched to a non-restored discharged
  row by `fromLead`.
- Guard 1 does NOT promote when matched by `houseId::name` (no `fromLead` link).
- Guard 1 DOES still promote when the discharged row is `restored === 'TRUE'`
  (and `restored === true`), so restore-to-lead keeps working.
- Guard 1 still promotes an unrelated entry lead when other discharged rows
  exist.
- Guard 2 sets the source lead's stage to `'admitted'` when `fromLead` resolves.
- Guard 2 rollback restores the lead's prior stage if `saveAll` rejects, and if
  the `dischargePatient` POST rejects.
- A hand-entered patient (no `fromLead`) discharges without throwing, touches no
  lead, and is still blocked from re-promotion by Guard 1.

Full suite: **155 tests passing** (145 prior + 10 new).
