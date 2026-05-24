# Changelog — "Phase 2a — buttons into action row"

This PR is a follow-up to PR #3 (`ae44b06` — "fix(retention): stack הסר button below לא רלוונטי on lead cards"). Live verification on the Railway deployment surfaced that the two absolute-positioned ghost buttons stacked at top-left of each lead card collided with the `.lc-meta` row (phone + house line), making the lead's contact data hard to read. Fix in this PR: move BOTH buttons (`לא רלוונטי ✕` and `הסר`) out of the absolute-positioned top corner and into the card's existing `.lc-actions` row at the bottom, alongside back/next/edit. Also re-flags Bug B (Apps Script `Code.gs` from PR #2 still not redeployed by Vered — soft-delete returns `unknown_action`).

## [Unreleased]

### Why this exists

1. PR #3 stacked both ghost buttons vertically at top-left of every lead card (`לא רלוונטי ✕` at `top: 8px`, `הסר` at `top: 34px`). On the live URL Vered confirmed that `הסר`'s rendered position overlapped the `.lc-meta` row (phone + `·` + house + `·` + source), making the lead's contact data hard to read. The fix from PR #2 → PR #3 (`right: 8px` → `top: 34px`) successfully escaped the RTL name-text collision but created a new collision with the meta row.
2. Root cause: `.lc-irrelevant` is `position: absolute`, which removes both stacked buttons from normal flow. As long as both buttons are absolute, ANY card content below y≈56px on the physical-left is vulnerable. A third tweak to the inline `top:` constant would just shift the collision somewhere else (next would be `.lc-created` or `.lc-note`).
3. Vered's decision: stop fighting the absolute positioning. Move both buttons into the card's existing `.lc-actions` row, where they flow inline with back/next/edit. No more positioning collisions are possible, because the flex row reserves its own space at the bottom of the card.

### Changed (public/app.js)

- `buildLeadCard` `innerHTML`: removed both standalone absolute-positioned `.lc-irrelevant` buttons from the top of the card. Appended both inside `<div class="lc-actions edit-only">` after the back/next/edit buttons. Source order: `back → next → edit → לא רלוונטי → הסר`. In RTL with `.lc-actions`'s `justify-content: flex-start`, this renders as: `הסר | לא רלוונטי ✕ | ✏️ | ← שלב הבא | שלב קודם →` (left → right visually).
- Dropped the inline `style="top: 34px;"` from the `הסר` button — no longer absolute-positioned, so no inline override needed.
- Dropped the redundant `edit-only` class from the inner `לא רלוונטי` button — the wrapping `<div class="lc-actions edit-only">` already provides identical gating.
- Wiring lines (`advanceLead`, `moveLead`, `markLeadIrrelevant`, `showConfirm`/`removeLead`, `openEditLeadModal`) — untouched. The `.lc-irrelevant:not(.lc-remove)` and `.lc-remove` selectors still match cleanly inside the new container.

### Changed (public/style.css)

- New rule added after the existing `.lc-irrelevant:hover` block:

      .lead-card .lc-actions .lc-irrelevant { position: static; top: auto; left: auto; }

- Higher specificity (`0,3,0` vs base `0,2,0`) overrides only the positioning when `.lc-irrelevant` is rendered inside `.lc-actions`. Ghost styling (background, border, color, font-size, padding, border-radius) and the `:hover` reddish state continue to inherit from the base `.lc-irrelevant` rule unchanged.

### Not changed (intentional)

- **`.lc-actions` container CSS** — unchanged. The existing `display: flex; justify-content: flex-start; align-items: center; margin-top: 12px; gap: 6px;` rule handles layout cleanly for the now-5 buttons.
- **All PR #2 / PR #3 behavior preserved**: `showConfirm` extension (`confirmLabel`, `danger`), `removeLead` orchestrator with optimistic UI + rollback snapshot, viewer-mode runtime guard (now defense-in-depth, paired with `edit-only` gating).
- **apps-script/Code.gs** — untouched. The Phase 2a backend additions from PR #2 (`REMOVED_LEADS_SHEET`, `removeLead_`, router case, `getData_` extension) remain on `origin/claude/build-ezone-dashboard-QOg5s`. See "Apps Script deploy note" below for the still-outstanding deploy step.
- **`.lc-irrelevant:not(.lc-remove)` selector refinement from PR #2** — still required for the `markLeadIrrelevant` wiring (line 816) to skip the `הסר` button. Both buttons share the `.lc-irrelevant` class.
- **Viewer-mode behavior of `הסר`** is intentionally changed: PR #2 deliberately rendered `הסר` in viewer mode (visible but inert via `removeLead`'s runtime guard `if (state.mode !== 'edit') return`). Moving it into `<div class="lc-actions edit-only">` now hides it in viewer mode via CSS. Treated as a normalization: consistent with back/next/edit/✏️ being hidden in viewer mode, removes a UX wart (a visible button that does nothing was confusing), and the runtime guard becomes defense-in-depth rather than the primary gate.

### Apps Script deploy note (Bug B — still outstanding, unchanged by this PR)

The Phase 2a `apps-script/Code.gs` (`REMOVED_LEADS_SHEET` constant, `REMOVED_LEAD_COLUMNS` array, `removeLead_` function, `removeLead` router case, `getData_` extension to return `removedLeads`) has been on `origin/claude/build-ezone-dashboard-QOg5s` since PR #2's merge — but Apps Script has NOT been redeployed. Confirmed during PR #3 live verification: clicking `הסר` returned toast `שגיאה: הסרת הליד נכשלה — unknown_action` (the OLD `doPost` router doesn't recognize the new `removeLead` action). The optimistic UI rollback worked correctly — the row reappeared on the board after the error — proving the frontend pipeline is sound and the gap really is on the Apps Script side.

Required manual step (out of scope for this PR):

1. Open the Apps Script editor for the Dashboard project (the Web App whose URL is configured in the frontend's `API_URL`).
2. Paste the current `apps-script/Code.gs` from `origin/claude/build-ezone-dashboard-QOg5s` into the editor.
3. `Ctrl+S` to save the file in the Apps Script project.
4. **Deploy → Manage deployments → click the pencil ✏️ icon on the existing Web App deployment (NOT "New deployment")** → Version dropdown → **New version** → Deploy. Using the same deployment ID is critical — a new deployment creates a new URL that the frontend won't hit.
5. Verify on the live URL: DevTools → Network → find the `sheets?action=getData` response → confirm `removedLeads` field is present in the JSON (likely `[]` if no removals have happened yet).
6. Click `הסר` on any test lead. Confirm the toast reads `הליד הוסר` (not `unknown_action`), the row disappears from the active board, AND opening the Google Sheet shows a new `לידים שהוסרו` tab with the row appended (columns: existing `LEAD_COLUMNS` + `removedAt` + `originSheet`).

### Safety

- **CSS specificity carefully chosen** (`0,3,0` > base `0,2,0`) — the new rule applies ONLY to `.lc-irrelevant` inside `.lc-actions`, leaving any future use of `.lc-irrelevant` elsewhere (or any legacy callers that might still absolute-position the class) untouched.
- **`top: auto; left: auto;` redundant** once `position: static` (those properties are ignored on static elements); both included for defensive clarity and to neutralize any inline override that future edits might add.
- **No behavioral changes to the soft-delete pipeline** (PR #2's `removeLead_`) or the destructive confirm flow (PR #2's `showConfirm` `danger`/`confirmLabel` extension).
- **The `.lc-irrelevant:not(.lc-remove)` selector still works after the move** (both buttons share the `lc-irrelevant` class; the `:not` qualifier is unaffected by container).
- **No new user-data rendering surface** — the two relocated buttons render only static Hebrew strings (`לא רלוונטי ✕`, `הסר`) and `title` attributes; no `textContent`-vs-`innerHTML` concern is engaged.
- **Viewer-mode runtime guard inside `removeLead`** remains in place even though `הסר` is now CSS-hidden in viewer mode. Belt-and-braces: if some future flow (keyboard shortcut, programmatic call, devtools click) ever bypasses the CSS, the runtime guard still catches it.

### Manual test checklist (run on live URL after Railway deploy)

1. Hard refresh `https://ezone-dashboard.up.railway.app`.
2. Switch to the `לידים` tab. Inspect any lead card.
3. Confirm both ghost buttons are now in the action row at the bottom of the card, NOT at the top:
   - In RTL, visual order left → right: `הסר | לא רלוונטי ✕ | ✏️ | ← שלב הבא | שלב קודם →`
4. Confirm the top-right of the card now shows only the lead's name, clean — no buttons.
5. Confirm the phone + house line (`.lc-meta`) is also unobstructed — no buttons overlap the contact data anymore.
6. Click `לא רלוונטי ✕` on a test lead. Confirm the existing `markLeadIrrelevant` flow still runs (lead moves to `לא רלוונטים` section in `שימור לידים` tab; row appears in the `לידים לא רלוונטיים` side-sheet).
7. Click `הסר` on a different test lead. Confirm:
   - The confirm modal opens (text `להסיר את הליד? פעולה זו תסיר אותו מהמערכת.`)
   - Click `ביטול` — modal closes, no action.
   - Click `הסר` again, then `כן, הסר`.
   - Expected (with Apps Script deployed): toast `הליד הוסר`, row disappears from active board, row appears in `לידים שהוסרו` section of `שימור לידים`.
   - Expected (Apps Script NOT yet deployed): toast `שגיאה: הסרת הליד נכשלה — unknown_action`, row reappears on board (rollback worked).
8. Switch the app to viewer mode (if applicable). Confirm: `לא רלוונטי ✕` and `הסר` buttons are now HIDDEN (the `.lc-actions edit-only` wrapper gates them, just like back/next/edit). This is a normalization vs PR #2's behavior.
9. Hover both ghost buttons in the action row. Confirm they still show the reddish ghost hover from the existing `.lc-irrelevant:hover` rule (reddish text, reddish border, faint reddish background).
