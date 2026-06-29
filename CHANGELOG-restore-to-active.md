# Restore to active — one-click undo for an accidental discharge

Adds a second restore action to the discharged-patients tab (מטופלים משוחררים):
**"החזר לסטטוס פעיל"** (restore to active). The existing **"שחזר מטופל"** sends a
discharged patient back into the LEADS pipeline as a NEW LEAD; there was no way
to return someone to ACTIVE patient status short of editing the Google Sheet by
hand. This closes that gap.

Built on `claude/build-ezone-dashboard-QOg5s` @ `4a68205`, i.e. on top of the
renewal alert (#22), the third `released_outpatient` disposition + optional
discharge date (#23), and the discharge → Outpatient lead write (#24).

## What a discharge does (recap)

`dischargePatient` does NOT delete the patient row — it flips `status` to
`released` and sets `exitDate`. The original row survives in the Patients sheet
with every field intact (`houseId, name, date, pay, adv, fromLead, source,
notes`), and a full audit row is appended to the discharged sheet
(`DISCHARGED_PATIENT_COLUMNS`). So "restore to active" only has to:

1. flip the patient's existing row back to `status='active'` and clear `exitDate`, and
2. set `restored='TRUE'` on the discharged audit row so it leaves the tab.

## Locked design decisions

- **New button "החזר לסטטוס פעיל"** in the discharged-tab edit-mode actions,
  beside the existing "שחזר מטופל".
- **Hebrew confirm dialog:** "להחזיר את המטופל לסטטוס פעיל?".
- **Match key = `houseId + name + date`, NOT `id`.** Patient ids are
  session-local: the Patients sheet has no `id` column, so `normalizePatient`
  mints a fresh `cryptoId` on every load. The audit row's stored id will not
  match any `state.patients` id after a reload — matching by id would miss the
  existing row and create a duplicate. The three-field key flips the existing
  row **in place** (no duplicate, even across a reload).
- **Reconstruct-only-when-no-match.** If no row matches all three fields (e.g.
  the original row was hard-deleted), reconstruct an active patient from the
  audit row and append it.
- **Audit row is KEPT.** `restored='TRUE'` hides it from the tab (via the
  existing `renderDischargedPatients` filter); it is never deleted.
- **Optimistic UI + rollback**, mirroring `restorePatient` / discharge flow.
  Two persisted writes in order: (1) `saveAll()` re-activates the patient row
  via `replaceHousePatients_` (the important record, first); (2) the
  `restorePatientToActive` action flags the audit row (cosmetic, second). Any
  failure rolls back both optimistic changes. A flag-only failure after (1)
  persisted is benign: the patient is already active and re-clicking restore is
  idempotent (it flips an already-active row in place — still no duplicate).
- **Outpatient cleanup note is ACTIVE on this base.** Restoring to active does
  NOT remove any Outpatient lead. When the discharge disposition was
  `released_outpatient` (#23) — the same trigger that created a cross-app
  Outpatient lead (#24) — a Hebrew toast reminds the operator to remove that
  lead manually in the Outpatient app. Because this branch already carries
  #23/#24, the note genuinely fires for outpatient-discharged patients.

## Files changed

- `public/app.js`
  - `renderDischargedPatients` — second button "החזר לסטטוס פעיל" (static label
    via `textContent`; patient text already rendered via `textContent`).
  - Pure helpers (unit-tested): `matchActivePatientIndex`,
    `reconstructActivePatientFromAudit`, `buildRestoredToActivePatients`,
    `restoreNeedsOutpatientCleanup`.
  - `restorePatientToActive` (confirm wrapper) + `doRestorePatientToActive`
    (optimistic handler with rollback).
- `apps-script/Code.gs`
  - New `restorePatientToActive` action registration in `handle_`.
  - New `restorePatientToActive_` — flags the audit row `restored='TRUE'` via
    `upsertRowById_` (matched by the persisted audit `id`). Creates NO lead and
    does NOT touch the Patients sheet (the patient row is re-activated by the
    client's `saveAll` path). The two match paths are independent: audit row by
    `id`, Patients row by `houseId+name+date`.
- `test/restore-to-active.test.js` — vm-sandbox suite (10 tests): in-place flip
  with no duplicate; post-reload restore (audit id != patient id) does not
  duplicate; reconstruct-only-when-no-match; input array never mutated;
  `released_outpatient` surfaces the cleanup note (others do not); successful
  restore flips status + clears exitDate + flags audit `restored='TRUE'`;
  rollback on failed `apiPost`; rollback on failed `saveAll`.

## ⚠️ Deploy surface — DUAL Apps Script deploy required

`apps-script/Code.gs` was touched (new `restorePatientToActive` action), so BOTH
Apps Script deployments must be redeployed:

- `AKfycbyScn2vcaOb` — Dashboard
- `AKfycbxkUs27ZOJdK` — ezone-managers

Redeploy each via **pencil ✏️ → New version on the EXISTING deployment** — never
"New deployment" (a new deployment changes the `/exec` URL). The frontend
(`public/app.js`) ships with the Railway redeploy on merge; the new action is
inert until both Apps Script deployments carry the updated `Code.gs`.

## Commits

- _(pending)_ feat(discharge): restore-to-active for accidental discharges
