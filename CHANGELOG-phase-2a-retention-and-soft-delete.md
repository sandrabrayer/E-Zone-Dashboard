# Changelog — "Phase 2a — שימור לידים tab and הסר soft-delete"

This PR adds the in-app שימור לידים retention tab and the הסר soft-delete flow to the Dashboard, bringing it to parity with the Outpatient app on retention/audit behavior. The auto-route of לא רלוונטי leads to a separate sheet was already shipped in e6605d6 — this PR adds the in-app surface for viewing those rows plus a new soft-delete destination (`לידים שהוסרו`) for test entries, duplicates, and accidental creations. Net result: a single שימור לידים tab with two sections (לא רלוונטים supports view + restore; לידים שהוסרו is read-only), and a destructive הסר action on every active lead card.

## [Unreleased]

### Why this exists

1. Vered needs an in-app way to see leads that have been routed to side-sheets. e6605d6 introduced both the `לידים לא רלוונטיים` side-sheet and an in-app view for it. Phase 2a extends that retention surface to also cover a new soft-delete destination, consolidating all "non-active" lead destinations under a single שימור לידים tab.
2. A soft-delete (הסר) is needed for test entries, duplicates, and accidental creations — keeping an audit trail (`לידים שהוסרו` sheet) without cluttering the active kanban. Matches Outpatient PR #5's behavior shape and column layout.
3. Cross-app feature parity with Outpatient. After Phase 2a, both Dashboard and Outpatient expose the same retention-and-soft-delete vocabulary; later phases (2b reason capture, 2c duplicate-phone warning, 2d stage-distinction cleanup) build on this shared foundation.

### Added (apps-script/Code.gs)

- `REMOVED_LEADS_SHEET` constant (`'לידים שהוסרו'`).
- `REMOVED_LEAD_COLUMNS` array — `LEAD_COLUMNS` concatenated with `['removedAt', 'originSheet']`. `originSheet` always `'Leads'` in v1 but carried as a column so future flows can populate it without a schema change.
- `removeLead_(lead)` function — atomic via `LockService.getScriptLock()`, mirrors `moveLeadIrrelevant_`'s structure, uses the existing `upsertRowById_` / `deleteRowsById_` helpers, append-before-delete order, returns `{ok: true, removed: true, lead: record}`. Error codes: `missing_lead` only (matches Dashboard's existing pattern; no `not_found`).
- Router case `if (action === 'removeLead')` in `handle_()`, slotted between `restoreLead` and `managersOverview`.
- `getData_()` extended to open the removed-leads sheet via `getOrCreateSheet_`, read it via `readSheet_`, and return `removedLeads` alongside `leads` / `patients` / `irrelevantLeads`.

### Added (public/index.html)

- Tab rename `לידים לא רלוונטיים` → `שימור לידים` with `data-screen="retention"`.
- Screen container id rename: `screen-irrelevant` → `screen-retention`.
- Two sub-sections inside the screen: `לא רלוונטים` (wraps the existing `#irrelevant-list`) and `לידים שהוסרו` (new, contains the empty `#removed-list` div).
- Count-pill (`#irrelevant-count`) moved from the outer h2 down into the `לא רלוונטים` h3 — the id is unchanged so `renderIrrelevantLeads` still finds it.
- Outer h2 renamed to `שימור לידים` to match the tab label.

### Added (public/app.js)

- `SCREENS` array: `'irrelevant'` → `'retention'`. All other `'irrelevant'` literals (the lead **stage** id in `STAGE_IRRELEVANT`, `STAGE_ALIASES`, pipeline counting, board filter, `markLeadIrrelevant`) intentionally left untouched — they refer to a distinct namespace.
- `state.removedLeads = []` initialization.
- `normalizeRemovedLead(l)` — mirrors `normalizeIrrelevantLead` minus the `stage = 'irrelevant'` decoration; safe defaults for `removedAt` and `originSheet`.
- `renderRemovedLeads()` — imperative DOM build with `textContent` for all user-entered fields; 4 cells (שם / טלפון / גיליון מקור / תאריך הסרה); empty-state shows `'אין לידים שהוסרו'`; no restore button in v1.
- Wired `renderRemovedLeads()` into `renderAll()` next to `renderIrrelevantLeads()`.
- Wired `state.removedLeads` population from `data.removedLeads` inside `loadAll()` using the same defensive `Array.isArray` pattern as `irrelevantLeads`.
- `removeLead(lead)` orchestrator — optimistic UI (filter out of `state.leads`), `apiPost({action: 'removeLead', lead})`, on success `unshift` into `state.removedLeads` (newest-first, matches `markLeadIrrelevant`), on failure rollback via `prev = state.leads.slice()` snapshot. Viewer-mode silently inert via `if (state.mode !== 'edit') return` guard.
- `הסר` button on `buildLeadCard` — `className="lc-irrelevant lc-remove"`, inline `style="left: auto; right: 8px;"` to sit at the opposite top corner from `לא רלוונטי` in RTL. No `edit-only` class (visible in viewer mode by design; behavior is guarded at runtime). Click handler opens the extended `showConfirm` with text `'להסיר את הליד? פעולה זו תסיר אותו מהמערכת.'`, `confirmLabel: 'כן, הסר'`, `danger: true`.
- Selector refinement: `.lc-irrelevant` → `.lc-irrelevant:not(.lc-remove)` for the existing `markLeadIrrelevant` wiring. Without this, `querySelector('.lc-irrelevant')` would return the first match (now ambiguous) and the new הסר button could silently inherit the wrong handler.
- `showConfirm({text, onConfirm, confirmLabel = 'אישור', danger = false})` — backward-compatible extension. When `danger === true`, the confirm button gets `className="btn danger"` (the existing two-class form, leveraging the pre-existing `.btn.danger` CSS rule).

### Not changed (intentional)

- **e6605d6's existing auto-move + restore for `לא רלוונטי`** — kept exactly as-is. This PR adds AROUND that infrastructure, not on top of it. `moveLeadIrrelevant_`, `restoreLead_`, `markLeadIrrelevant`, `restoreIrrelevantLead`, `renderIrrelevantLeads`, the `#irrelevant-list` div, the `#irrelevant-count` count-pill, the `.lc-irrelevant` CSS class — all untouched in behavior.
- **No in-app restore for soft-deleted (`לידים שהוסרו`) rows in v1** — manual restore via the Google Sheets UI is the documented recovery path. The `הסר` flow is intentionally one-way to discourage casual misuse.
- **No reason capture modal or `פירוט` note on `לא רלוונטי`** — deferred to Phase 2b.
- **No duplicate-phone soft warning** — deferred to Phase 2c.
- **No stage-distinction cleanup between `לא רלוונטי` / `סיים טיפול` / `הפסיק לפני הזמן`** — deferred to Phase 2d.
- **public/style.css** — completely untouched. The `הסר` button reuses `.lc-irrelevant` for its styling base; the `showConfirm` danger mode reuses the existing `.btn.danger` two-class CSS rule (style.css:94-100); the new `#removed-list` rows reuse `.irrelevant-row` for grid layout.
- **Lock-timeout behavior in `removeLead_`** — matches the house convention (`tryLock(10000)` with boolean return ignored), same as all four existing locked writers (`saveAll_`, `moveLeadIrrelevant_`, `restoreLead_`, `upsertPayment_`). Hardening this is a candidate for a future cross-codebase PR, not introduced here.
- **Naming conventions** — used Dashboard's trailing-underscore / `_COLUMNS` suffix style (`removeLead_`, `REMOVED_LEAD_COLUMNS`), not Outpatient's leading-underscore / `_HEADERS` style.

### Safety

- `LockService.getScriptLock()` with 10s wait wraps the entire move operation in `removeLead_`.
- Append-before-delete ordering in `removeLead_`: if `upsertRowById_` throws, the active row in `Leads` stays intact rather than the lead being lost entirely. Documented inline.
- Optimistic UI rollback on POST failure: `removeLead` snapshots `state.leads` to `prev` before the optimistic filter and restores it on `catch`. The user sees the card reappear plus a Hebrew error toast.
- Viewer-mode runtime guard inside `removeLead` — prevents soft-delete actions when `state.mode !== 'edit'` even though the `הסר` button is visible in viewer mode. Matches `markLeadIrrelevant`'s behavior on the same row.
- `textContent` (not `innerHTML`) used in `renderRemovedLeads` for all user-entered fields (`name`, `phone`, `originSheet`, formatted `removedAt`) — XSS-safe even if a name or phone in the sheet contains markup.
- `showConfirm` extension is backward-compatible — the sole existing caller (`restoreIrrelevantLead`) keeps its previous `'אישור'` / `.btn.primary` rendering because the new parameters fall back to defaults.
- The selector refinement `.lc-irrelevant:not(.lc-remove)` prevents the new `הסר` button from silently inheriting the `markLeadIrrelevant` handler. Caught during diff review, fixed before merge.
- Backend error codes (`missing_lead`) match the existing Dashboard pattern. No `not_found` introduced — `deleteRowsById_` is a no-op on absent ids, which mirrors the codebase's forgiving stance.

### Manual test checklist (run on live URL after Railway deploy completes)

1. Open the app, hard refresh. Confirm the tab at position 3 now reads `שימור לידים` instead of `לידים לא רלוונטיים`.
2. Click `שימור לידים`. Confirm the screen shows TWO sections: `לא רלוונטים` (with count-pill, existing data preserved) and `לידים שהוסרו` (new, likely empty: shows `אין לידים שהוסרו`).
3. Switch back to `לידים` tab. Confirm `לא רלוונטי ✕` button still appears on the top-left of each card (physical left, where `.lc-irrelevant` lives), and the existing mark-as-irrelevant flow still works (click → row moves to `לא רלוונטים` section).
4. Confirm a new `הסר` button appears at the top-right of each card (physical right, from the `right: 8px` inline style), styled as a destructive ghost button (transparent until hover, then reddish).
5. Click `הסר` on any active lead. Confirm:
   - Confirm modal opens with text `להסיר את הליד? פעולה זו תסיר אותו מהמערכת.`
   - Confirm button reads `כן, הסר` and is styled red (`.btn.danger` gradient)
   - Cancel button reads `ביטול`
6. Click `ביטול`. Confirm modal closes, lead remains on the active board.
7. Click `הסר` again on the same lead, then `כן, הסר`. Confirm:
   - Modal closes
   - Toast `הליד הוסר` appears
   - Lead disappears from the active board
   - Switch to `שימור לידים` → the lead is now in the `לידים שהוסרו` section (showing שם / טלפון / גיליון מקור = `Leads` / תאריך הסרה = today)
8. Reload the page. Confirm the lead is still in `לידים שהוסרו` and not on the active board.
9. Open the Google Sheet. Confirm:
   - New tab `לידים שהוסרו` exists with headers matching `REMOVED_LEAD_COLUMNS`
   - The removed lead's row is present with `removedAt` populated as ISO timestamp and `originSheet=Leads`
   - The original `Leads` tab no longer contains the removed lead's row
10. Switch the app to viewer mode (if applicable). Confirm the `הסר` button is still visible BUT clicking it does nothing (runtime guard).
11. Click `הסר` on a second lead while temporarily disconnected from network (or with the Apps Script URL broken). Confirm:
    - Lead disappears from the board optimistically
    - Error toast `הסרת הליד נכשלה — ...` appears
    - Lead reappears on the board (rollback worked)
    - `שימור לידים` → `לידים שהוסרו` section does NOT contain this lead
