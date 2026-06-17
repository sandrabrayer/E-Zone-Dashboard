# Patient entry-date no longer clobbered by lead re-promotion

Frontend-only (`public/app.js`). No `apps-script/Code.gs` change, no Apps Script
redeploy.

## The bug

A patient's תאריך כניסה (entry date), once edited via the patient edit (pencil)
UI, would revert to the original lead date on the next page load. The edit was
written to the Patients sheet correctly — but something kept re-introducing the
lead's date.

## Root cause

The patient `date` field round-trips correctly through edit → `serializePatients`
→ `replaceHousePatients_` → `getData_` → `normalizePatient`; that path is sound.
The revert came from **`promoteEnteredLeads()`** (`public/app.js`), which on every
load re-creates a patient from `lead.entryDate` for any lead at stage
`entry`/`entered` that it can't match to an existing patient.

Two facts made it fire against already-admitted, already-edited patients:

1. **The originating lead was never retired.** `openEntryModal` set
   `lead.stage = 'entry'` on admission and left the lead there permanently, so it
   stayed a re-promotion candidate on every subsequent load.
2. **The patient↔lead dedup is fragile.** Patients carry no persisted `id`
   (`PATIENT_COLUMNS` omits it), so the only durable link is `fromLead`, backed
   up by an exact `houseId::name` match. When that link breaks (e.g. a lead whose
   `id` was never persisted and is regenerated each load) and the name/house
   don't match exactly, the dedup misses and a fresh patient stamped with
   `lead.entryDate` is appended (and auto-persisted) — overwriting the edit.

## Fix — Option A: retire the lead to a terminal `admitted` stage on admission

Four changes, all in `public/app.js`:

1. **Retire lead on promotion.** In `openEntryModal`, on successful patient
   creation the originating lead is now set to `stage = 'admitted'` instead of
   `'entry'`. The change persists through the same `saveAll` write as before
   (rollback restores the previous stage on save failure). An `admitted` lead is
   no longer in `promoteEnteredLeads`' candidate pool, so it can never overwrite
   its patient again.

2. **Register `admitted` in `STAGE_ALIASES`.** `'admitted'` (plus Hebrew
   `'נקלט'` / `'אושפז'`) → `'admitted'`. Without this, `normalizeStage` would hit
   its unknown-stage default and reset the value to `'new'` on the next load —
   resurrecting the lead at the top of the pipeline and re-arming the bug.
   `normalizeStage('admitted')` now returns `'admitted'` unchanged.

3. **Excluded from board and counts (verification — no code change needed).**
   `renderKanban` iterates `STAGES` and the pipeline pills iterate
   `ALL_STAGES_FOR_PIPELINE`; neither contains `admitted`, so an admitted lead
   renders in no kanban column and is excluded from every pipeline/count bucket.
   `promoteEnteredLeads` already filters out anything that isn't `entry`/
   `entered`, so admitted leads are not re-promotion candidates.

4. **One-time, idempotent self-heal.** New `retireAdmittedLeads()` runs on load
   right after `promoteEnteredLeads`. For every lead still at `entry`/`entered`
   that already has a matching patient (by `fromLead`, or by `houseId::name` —
   the same keys the promote dedup uses), it sets the lead's stage to
   `'admitted'`. This retires the leads currently clobbering existing patients
   (e.g. פרק מוסקוביץ) so they stop overwriting on the next load. It **never**
   creates a patient and **never** alters a patient's `date`. It persists through
   the existing post-load `saveAll` (now triggered when either promotions or
   retirements occurred). Once leads are `admitted` they fall out of the
   entry/entered filter, so re-running it every load is a no-op.

## Not changed

- Patient `date` write/read logic — that path was already correct. The only
  patient-facing effect is that the edited entry date stops being overwritten.
- `apps-script/Code.gs` — `stage` is a passthrough column written by
  `mergeLeads_` from whatever the client sends; the new `'admitted'` value
  persists through the normal `saveAll` path with no backend change.

## Tests

`test/patient-entrydate-admit.test.js` (run via `npm test`, node:test + vm
sandbox, exercising the real shipped functions):

- A promoted lead does not re-stamp an edited patient's date on a second
  `promoteEnteredLeads` run; after `retireAdmittedLeads` the lead is `admitted`
  and the edited date survives.
- Self-heal matches by `houseId::name` when the `fromLead` link is broken.
- Self-heal leaves an `entry` lead with no matching patient alone (still a valid
  pending admission).
- `normalizeStage` round-trips `'admitted'` (and `'נקלט'`) instead of resetting
  to `'new'`.
