# Restore-choice modal — restoring a discharged patient now offers an explicit choice

Fixes the reported regression "restoring a just-discharged patient always
created a new lead". Root cause (per the investigation): not a code break — the
two side-by-side buttons were a **label trap**. "שחזר מטופל" (rendered first)
actually created a NEW LEAD, while the real undo, "החזר לסטטוס פעיל", sat second
with the less obvious label. The house-view route (editing a released patient's
status back) had been removed by PR #16 (hide released from occupancy), leaving
this trap as the only restore surface.

## What changed

### The מטופלים משוחררים tab — one שחזר button → a choice modal

Each discharged row now has a **single שחזר button** opening
`showRestorePatientChoiceModal` (radio style, mirrors the closure modal):

- ⦿ **החזרה לסטטוס הקודם (\<status\>)** — pre-selected (the common case: undoing
  a discharge). Returns the patient to their house with their **pre-discharge
  status** — the label shows which one — via the existing
  `doRestorePatientToActive` path (`saveAll` flip-in-place + audit row flagged
  `restored='TRUE'`).
- ○ **פתיחת ליד חדש** — the original Phase 2e-2 path
  (`doRestorePatientAsNewLead`, extracted from the old `restorePatient`):
  a fresh lead at ליד חדש.

The modal **is** the confirmation — the old per-button `showConfirm` dialogs are
gone. Both workers keep their optimistic-UI + rollback + Hebrew error toasts.

### Restore to the PRIOR status, not hard-coded active

Previously even "החזר לסטטוס פעיל" forced `status:'active'`, wiping a
pre-discharge `trial`/`wait`. Now:

- **`dischargeAuditRow` captures `prior_status`** — the patient's status at the
  moment of discharge (it is built before the `released` flip).
- **`Code.gs`: `DISCHARGED_PATIENT_COLUMNS` appends `prior_status` LAST**
  (append-only; `getOrCreateSheet_` extends the header non-destructively;
  existing rows untouched, no backfill).
- **`priorStatusFromAudit`** (new, pure): honors `active`/`trial`/`wait`;
  anything else — blank (legacy rows), `released`, junk — falls back to
  `'active'`, preserving the old behavior for all pre-existing audit rows.
- `buildRestoredToActivePatients` / `reconstructActivePatientFromAudit` restore
  that status; the success toast names it ("המטופל הוחזר לסטטוס תקופת ניסיון").
- `normalizeDischargedPatient` round-trips the field (pickField pattern).

### EZONE-ECOSYSTEM-STATUS.md

Added the **orphan-snapshot** section documenting that the deploy branch's root
commit (`62f5f7b`, June 17) is parentless — the "50–64 commits not on the deploy
branch" counts on pre-June-17 branches are an artifact, not lost work (verified
by the Aug 9 audit) — so nobody launches a lost-work hunt or merges a stale
branch because of them.

## Tests — `test/restore-choice-modal.test.js` (12 new)

vm-sandbox, same harness as `restore-to-active.test.js` plus a minimal modal
DOM: `priorStatusFromAudit` (three live statuses; legacy/blank/junk/released →
active), matched-row flip to prior status (trial) + reconstruct with prior
status (wait), legacy-row fallback keeps old behavior, `dischargeAuditRow`
captures pre-flip status while the audit row itself still reads `released`,
normalizer round-trip, `DISCHARGED_PATIENT_COLUMNS` appends `prior_status` last,
modal renders both options with prior-status pre-selected showing the actual
status label, submit routes each choice to the right worker and closes, no
modal outside edit mode.

Full suite: `npm test` — **384 pass, 0 fail** (zero regressions; the existing
`restore-to-active.test.js` passes unchanged thanks to the active fallback).

## Deploy

- `Code.gs` (one appended column) deploys via clasp CI on merge — no manual
  paste. Existing discharged rows are unaffected; new discharges start
  populating `prior_status`.
- Post-merge check: discharge a `trial` patient → the discharged row's שחזר →
  modal defaults to "החזרה לסטטוס הקודם (תקופת ניסיון)" → confirm → patient is
  back in their house as תקופת ניסיון.
