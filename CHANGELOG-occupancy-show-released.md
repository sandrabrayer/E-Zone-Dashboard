# תפוסה: "הצג משוחררים" — session-only display toggle + restore from the house view

PR-R2 of the restore-fix plan. Restores the house-view restore affordance that
disappeared with PR #16 (hide released from occupancy) — without un-hiding
released patients by default and **without letting them near any count**.

## What changed

### The toggle (session-only, display-only)

- New checkbox **"הצג משוחררים"** in the תפוסה header (`index.html`), wired to
  `state.showReleasedPatients` — **session-only by design**: plain in-memory
  state, no localStorage read or write, so every fresh load starts hidden.
- Toggle ON reveals released patients **in the list only**, dimmed via the
  existing `.patient-row.released { opacity: .50 }` rule, with their
  "שוחרר · date" badge.

### Counts and KPIs are untouchable

- New pure helper **`houseOccupancyCount(patients, houseId)`** — the single
  source of truth for the house-tab `(N/capacity)` figures — excludes released
  **always**; it does not even take the toggle as an input.
- New pure helper **`visibleOccupancyRows(patients, houseId, query, showReleased)`**
  — the list filter; the ONLY consumer of the toggle. Search + house isolation
  apply in both modes.
- Dashboard KPIs, billing, renewal, and growth aggregations already filter
  `status !== 'released'` independently and are untouched by this PR.

### Restore from the house view — same modal as the discharged tab

- A released row (visible only under the toggle) shows a **שחזר** button in
  place of שחרר, opening the **same restore-choice modal** shipped in PR-R1
  (prior-status default / new lead).
- New pure bridge **`auditRowForReleasedPatient(p, dischargedPatients)`**:
  prefers the row's matching **non-restored** discharged-audit record (same
  `houseId+name+date` key as `matchActivePatientIndex`), so `prior_status` and
  the audit id come from the real record. A released row with **no** audit match
  (legacy release predating Phase 2e) gets a synthesized audit object with
  `prior_status: ''` → restores to active; the `restorePatientToActive` write
  then appends a `restored='TRUE'` audit row for it — invisible in the tab
  (restored rows are filtered) and simply documents the restore.

### RTL

The toggle is `inline-flex` + `gap` (no directional margins) and lives inside
the existing `.actions` flex row — RTL-safe by construction.

## Tests — `test/occupancy-show-released.test.js` (9 new)

- `visibleOccupancyRows`: released hidden with the toggle off; revealed (own
  house only) with it on; search applies in both modes; house isolation.
- `houseOccupancyCount`: released never counted; defensive on empty/null.
- `auditRowForReleasedPatient`: prefers the non-restored audit match
  (prior_status flows to the modal); skips `restored='TRUE'` rows; synthesizes
  the legacy fallback (blank prior_status → active); date mismatch does not
  match the wrong audit row.
- Session-only: `showReleasedPatients` defaults to false and no localStorage
  key ever involves the toggle.

Full suite: `npm test` — **393 pass, 0 fail** (zero regressions).

## Stacking

Built on `feature/restore-choice-modal` (PR #73) — it reuses PR-R1's
`showRestorePatientChoiceModal` and `prior_status`. Open/merge its PR **after**
#73 merges. Frontend-only (no `Code.gs` change beyond what #73 carries).
