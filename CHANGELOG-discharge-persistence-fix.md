# CHANGELOG — Discharge persistence fix

## Symptom

Discharging a patient (שחרור) appears to work — modal closes, patient leaves
the active list — but after leaving and returning to the app, the patient is
back in the active list. The discharge did not persist.

## Root cause (two proven mechanisms, one shared weakness)

The Patients sheet is written by `saveAll` → `replaceHousePatients_`
(Code.gs) — a **whole-house replace, last writer wins**. The discharge is a
dual-write: status flip via `saveAll` + audit row via the `dischargePatient`
action. Both mechanisms were reproduced end-to-end against the real shipped
frontend + backend code in a vm sandbox:

- **M1 — audit-write failure poisoned the sheet.** The old order was
  `saveAll` first (persists `status='released'`), audit write second. When
  the audit write failed, `rollback()` re-activated the **local** patient —
  but the sheet already said released. The session's very next `saveAll`
  (any unrelated edit) re-sent the rolled-back `active` status and silently
  erased the persisted discharge. The only trace was one 6-second toast.

- **M2 — stale-session clobber.** Any session holding pre-discharge state (a
  second browser tab, the PWA resumed from hours in the background) that
  saved *anything* re-sent the whole house roster with the patient still
  `active` — resurrecting her. The discharged-audit row survived (it lives on
  its own sheet, written by keyed upsert, untouched by `saveAll`), but
  nothing on the read side ever reconciled the two sheets.

Bonus bug found on the same path: the persisted audit payload was
`{ ...p, disposition, discharge_note }`, which **dropped `prior_status`**
(captured only on the local `dischargeAuditRow`) — so restore-to-previous-
status always fell back to 'active' after a reload.

## Fix (frontend only — `public/app.js`; Code.gs unchanged)

1. **Write order reversed** in `dischargePatient`: the audit row goes FIRST
   (it is the durable, clobber-proof record of intent), `saveAll` second.
   - Audit write fails → full rollback, loud error — nothing was persisted,
     local and sheet agree, nothing can be silently erased later.
   - `saveAll` fails after the audit persisted → UI rolls back to mirror the
     Patients sheet, a "partial save" error is shown, and the load-time heal
     (below) completes the release on the next load. Every failure mode now
     converges to the user's intent instead of losing it.
   - The payload is now the full `auditRow`, so `prior_status`, `exitDate`
     and `dischargedAt` persist correctly.

2. **Load-time self-heal** — new `healClobberedDischarges()`, run by
   `loadAll` after `promoteEnteredLeads`/`retireAdmittedLeads` (same
   self-heal precedent): any ACTIVE patient matching a **non-restored**
   discharged-audit row is flipped back to `released`, with `exitDate`
   restored from the audit row; healed rows are persisted via loadAll's
   existing conditional `saveAll`.
   - Matching uses the established patient identity key
     (`houseId + name + date`, exactly `matchActivePatientIndex`). The
     `date` component keeps a genuine **re-admission** safe: a new stay has
     a new entry date, so the old audit row never touches it.
   - `restored === 'TRUE'` (or boolean `true`) audit rows are skipped, so
     both restore paths keep working — a restored patient stays active.

## Tests (`test/discharge-persistence-fix.test.js`)

node:test + vm-sandbox on the real shipped functions:

- Write order: audit before `saveAll`; audit payload carries
  `prior_status`/`exitDate`/`dischargedAt`.
- M1 regression: audit-write failure → rollback with **zero** `saveAll`
  fired; a later save re-sends `active`, which matches the sheet (no
  divergence, nothing silently lost); failure is loud.
- Partial-save path: `saveAll` failure after the audit persisted → UI
  rollback + explicit partial-save error.
- Heal: clobbered patient flipped back to released with exitDate restored
  and removed from the active list; idempotent; skips restored rows (string
  and boolean); never touches a re-admission (new entry date).
- End-to-end: a stale-session clobber is healed and the healed state
  persisted.
- Source guard: `loadAll` invokes the heal and persists when `healed > 0`.

Full suite: 497/497 green.

## Deployment

Frontend-only. `apps-script/Code.gs` is untouched, so the clasp CI deploy is
a no-op for this fix — Railway picking up the merge is sufficient.
