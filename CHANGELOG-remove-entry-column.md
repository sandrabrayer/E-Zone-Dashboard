# Remove the כניסה לבית (entry) kanban column; re-anchor admit to the paid stage

Frontend-only (`public/app.js`). No `apps-script/Code.gs` change, no Apps Script
redeploy.

## Why

The כניסה לבית (entry) column was the last board stage and always sat empty: a
בטיפול פעיל (paid) lead enters תפוסה directly via the admit modal, which creates
the patient and retires the lead to the terminal `admitted` stage — it never
rested at `entry`. The column was a redundant holding bay showing 0.

## The risk that was fixed (positional coupling)

The admit action (`openEntryModal`, the only patient-creating path) was **not**
tied to the entry column — it was reached through `advanceLead`'s positional
index math (`STAGES.length - 2` → admit, `STAGES.length - 1` → no-op). Naively
deleting the entry element would have shifted those indices: `visit` would have
become `length - 2` and triggered admit, while `paid` would have become a
dead-end no-op. So the admit trigger had to be re-anchored to the `paid` stage
**by id** before the column could be removed.

## Changes (all in `public/app.js`)

1. **Decoupled `advanceLead` from array position.** Replaced the
   `STAGES.length - 1 / - 2` branches with explicit stage-id checks:
   `lead.stage === 'paid'` → `openEntryModal(lead)` (admit);
   `entry` / `entered` / `admitted` → no-op (defensive, for any stray legacy
   lead that no longer renders a column); otherwise advance to the next board
   stage by id. The back button and new→visit→paid forward flow are unchanged.

2. **Relabeled the paid card's advance button by stage id.** A paid card's
   advance button now reads **"כניסה לבית"** (the removed column's name, so the
   admit action stays findable for Vered); all other stages keep "← שלב הבא".
   The label is driven by `lead.stage === 'paid'`, not by the old `isLast`
   position flag (which was removed).

3. **Removed the entry column from `STAGES`.** Deleted
   `{ id: 'entry', label: 'כניסה לבית' }`. `ALL_STAGES_FOR_PIPELINE` derives from
   `STAGES`, so the pipeline pill for entry drops automatically; no pill or
   render path references `entry` by id. `STAGE_ALIASES` (including
   `'entry'`/`'entered'` and the `admitted` aliases) is **untouched**, so a
   stored `entry`/`entered` value still normalizes and is still caught by
   `promoteEnteredLeads` / `retireAdmittedLeads`.

4. **Verified no orphaned positional references.** `stageLabelById('entry')`
   now returns `''`, and its only caller (the irrelevant-lead origin display)
   falls back to `'—'` — no crash. Restore of an irrelevant lead forces
   `stage: 'new'` regardless of origin, so a former `entry`-origin lead restores
   cleanly. The `isLast` variable was removed (its sole use was the button
   label).

## Not changed

`promoteEnteredLeads`, `retireAdmittedLeads`, `STAGE_ALIASES`, and
`openEntryModal`'s patient-creation / `stage = 'admitted'` logic are all
untouched — they key on the stage string, not the board column. The only
behavioral change: the empty holding column is gone, and admit is triggered by
an explicitly-labeled "כניסה לבית" button on the paid card.

## Tests

`test/remove-entry-column.test.js` (node:test + vm sandbox; `openEntryModal` /
`moveLead` replaced with spies so `advanceLead` is exercised without DOM /
network):

- `STAGES` is exactly `['new', 'visit', 'paid']` — no `entry`.
- `advanceLead` on a **paid** lead triggers admit (`openEntryModal`).
- `advanceLead` on a **visit** lead moves it to **paid**, never to admit — the
  exact regression the positional-coupling trace warned about.
- `advanceLead` on a **new** lead moves it to visit.
- `advanceLead` on `entry` / `entered` / `admitted` is a no-op.

`npm test` → 28/28 pass.
