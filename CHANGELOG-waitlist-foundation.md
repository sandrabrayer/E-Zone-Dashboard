# CHANGELOG — Waitlist stage foundation (PR 1 of 2, zero UI change)

## What this is

Foundation for the upcoming רשימת המתנה (waitlist) kanban stage in the leads
pipeline. A lead in that stage is a potential patient waiting for a spot; the
lead's existing `house` field is the house they are waiting for.

This PR is schema + constants only. **There is zero user-facing change**: the
kanban board and pipeline strip render exactly as before. PR 2 wires the stage
into the UI.

## Backend (`apps-script/Code.gs`)

- Appended `waitlistedAt` to the **end** of `LEAD_COLUMNS` (append-only —
  `readSheet_` maps cells to keys by position, so nothing was reordered or
  inserted mid-array). It stores an ISO timestamp string recorded when a lead
  enters the waitlist stage.
- **Derived schemas inherit automatically:** `IRRELEVANT_LEAD_COLUMNS` and
  `REMOVED_LEAD_COLUMNS` are `LEAD_COLUMNS.concat([...extras])`, so the new
  column flows into both with no further change.
- **Text-forced column:** `getOrCreateSheet_` now includes `waitlistedAt` in
  the Leads-sheet `forceColumnsText_` list (alongside `visitDate` /
  `visitTime`), formatting the whole column as plain text (`@`). This prevents
  the known pitfall where Sheets coerces date-like strings into Date objects
  with the Jerusalem LMT offset.
- Pre-existing sheets are extended non-destructively: `getOrCreateSheet_`
  appends the missing header on the next read; legacy rows stay blank
  (`objectToRow_` defaults missing keys to `''`). No backfill.

## Frontend (`public/app.js`)

- New `STAGE_WAITLIST` constant (`{ id: 'waitlist', label: 'רשימת המתנה' }`),
  deliberately **not** added to `STAGES` or `ALL_STAGES_FOR_PIPELINE` — the
  least invasive gate that guarantees the board and pipeline render
  identically. Mirrors the `MEETING_OUTCOME_LABELS` ship-now/render-later
  precedent.
- `STAGE_ALIASES` gains `waitlist` / `רשימת המתנה` / `רשימת_המתנה` →
  `'waitlist'`, following the `admitted` precedent: a stored waitlist value
  round-trips on load instead of resetting to `'new'` (the unknown-stage
  default).
- `normalizeLead` passes `waitlistedAt` through verbatim (no `isoDate`
  munging — the full timestamp is preserved), defaulting to `''` on legacy
  rows. `normalizeIrrelevantLead` / `normalizeRemovedLead` inherit it since
  they build on `normalizeLead`'s output.

## Tests (`test/waitlist-foundation.test.js`)

`node:test` + vm-sandbox pattern, matching the existing suite:

- `LEAD_COLUMNS` order guard: `waitlistedAt` is last, appears once, and the
  entire pre-existing prefix is byte-for-byte unchanged.
- Derived irrelevant/removed schemas carry the new column.
- `getOrCreateSheet_` on a legacy sheet appends the missing header
  non-destructively and `setNumberFormat('@')`s the whole column.
- `normalizeLead` preserves `waitlistedAt` (present, blank-default,
  round-trip — no silent drop).
- `normalizeStage` round-trips `waitlist` (and the Hebrew label) instead of
  resetting to `'new'`; unknown values still default to `'new'`.
- Zero-UI-change gate: `STAGES` / `ALL_STAGES_FOR_PIPELINE` exclude waitlist,
  and the **actual rendered kanban** (via the DOM stub) shows exactly the
  three pre-existing columns — a lead parked at `stage='waitlist'` renders no
  column and no label.

## Deployment

Nothing manual. Apps Script deploys automatically via clasp CI on merge.
