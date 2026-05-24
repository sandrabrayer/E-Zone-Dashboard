# Changelog — "Phase 2a bugfix — הסר button position + Apps Script deploy note"

This PR is a follow-up to PR #2 (`33b7c28` — "Phase 2a — שימור לידים tab and הסר soft-delete"). Two bugs surfaced during live verification on the Railway deployment:

- **Bug A (code fix in this PR):** the new `הסר` button on every active lead card was positioned at the physical-right edge of the card via inline `style="left: auto; right: 8px;"`. Because the Dashboard is RTL, the lead's name (`.lc-name`) text begins flush against the physical-right padding — exactly where the `הסר` button sat. The button rendered correctly in the DOM but was visually hidden behind the name text. Reproduced on Dashboard live URL (`https://ezone-dashboard.up.railway.app`) with realistic lead names of any length.
- **Bug B (out-of-band, NOT fixed by this PR):** the `לידים שהוסרו` sheet is not appearing in the Google Sheet. This is a deploy gap, not a code gap — see the "Apps Script deploy note" section below.

## [Unreleased]

### Why this exists

1. PR #2 introduced the `הסר` soft-delete button but the inline-style placement at physical-right collided with the start of the RTL lead-name block. The button was reachable only by tab-key or pixel-perfect click on the visible sliver around the badge corner. Vered reported it as "missing" during live verification.
2. The fix needs to keep both destructive ghost buttons (`לא רלוונטי ✕` and `הסר`) discoverable without competing with the lead name, without adding a new CSS class, and without touching `public/style.css`. Vered's chosen layout: stack both buttons VERTICALLY on the physical-left side of the card, since the existing `.lc-irrelevant` base rule already positions the first one at `top: 8px; left: 8px`.
3. Bug B (Apps Script not deployed) needs to be documented explicitly so future sessions don't mistake the missing sheet for a code problem and don't merge yet another no-op PR trying to "fix" it.

### Changed (public/app.js)

- `buildLeadCard` line 795 — `הסר` button inline style changed from `style="left: auto; right: 8px;"` to `style="top: 34px;"`. Removes the physical-right override so the base `.lc-irrelevant` rule (`top: 8px; left: 8px`) takes effect on the `left`/`right` axis; the inline `top: 34px` shifts this second button down to sit directly below `לא רלוונטי ✕` on the physical-left edge.
- `className="lc-irrelevant lc-remove"` retained — both `.lc-irrelevant` (base positioning + ghost styling) and `.lc-remove` (selector hook keeping `.lc-irrelevant:not(.lc-remove)` from PR #2 working) are required.

### Not changed (intentional)

- **public/style.css** — untouched. No new CSS class, no override of `.lc-irrelevant`. The 34px offset is computed from the base rule's `top: 8px` + the rendered `.lc-irrelevant` height (~22px: 11px font with `line-height: normal` ≈ 13px text line + 6px vertical padding + 2px border) + ~4px visual gap.
- **`.lc-irrelevant:not(.lc-remove)` selector refinement from PR #2** — still required and still in place. The `markLeadIrrelevant` wiring continues to skip the `הסר` button via this selector; no change here.
- **`removeLead` handler, `showConfirm` extension, `renderRemovedLeads`, `state.removedLeads` plumbing** — all untouched. PR #2's soft-delete pipeline is correct end-to-end. This PR fixes only the button's CSS placement.
- **apps-script/Code.gs** — untouched. PR #2's Code.gs is already on `origin/claude/build-ezone-dashboard-QOg5s` (verified via `git show … | grep REMOVED_LEADS_SHEET`). See Bug B note below — the gap is in the deploy step, not the source.
- **Doc comment block in public/app.js (~line 1018) describing the unconditional `הסר` render** — left as-is. The comment describes runtime behavior (viewer-mode guard), not button position.

### Safety

- Single-line CSS-only change to one inline style attribute. No new DOM, no new event wiring, no new state.
- No new user-data rendering surface, so the `textContent`-over-`innerHTML` convention isn't engaged here.
- The 34px constant is hand-tuned for `.lc-irrelevant`'s current rendered height. If `font-size`, `padding`, or `border` on `.lc-irrelevant` change in a future style.css edit, the two buttons may visibly overlap or gap; reviewers should re-tune the inline `top` at that point. Documented inline-of-review here rather than as a code comment because (a) the inline style is self-evidently positional and (b) the project convention is no decorative comments.

### Manual test checklist (run on live URL after Railway redeploys)

1. Hard refresh `https://ezone-dashboard.up.railway.app`.
2. Confirm every lead card on the `לידים` board now shows TWO ghost-style mini-buttons stacked vertically on the physical-left edge of the card: `לא רלוונטי ✕` on top (at y≈8px), `הסר` directly below it (at y≈34px). Both transparent until hover.
3. Hover each. Confirm both adopt the reddish ghost hover (existing `.lc-irrelevant:hover` rule, `--danger` text + border + bg tint).
4. Confirm the lead name (`.lc-name`) is no longer overlapped or obscured by any button — the physical-right top corner of every card is now clear.
5. Confirm with a long lead name (e.g. ≥30 chars) that the name still wraps correctly and does not overlap the left-stacked buttons. If it does, the name padding-inline-start in style.css may need a follow-up; not expected based on PR #2's already-shipping layout.
6. Click `לא רלוונטי ✕`. Confirm it still marks the lead as irrelevant (PR #2 behavior unchanged).
7. Click `הסר`. Confirm the PR #2 confirm modal opens (`להסיר את הליד? פעולה זו תסיר אותו מהמערכת.` / `כן, הסר` / red button) and the soft-delete flow completes end-to-end **once Apps Script is deployed** (see Bug B note).
8. In viewer mode (if applicable), confirm both buttons remain visible but `הסר` click is inert (PR #2 runtime guard unchanged).

### Apps Script deploy note — Bug B (not fixed by this PR)

The `לידים שהוסרו` sheet is still missing from the Google Sheet at the time of writing. Investigation:

- `apps-script/Code.gs` on `origin/claude/build-ezone-dashboard-QOg5s` contains every Phase 2a addition: `REMOVED_LEADS_SHEET` constant (line 32), `REMOVED_LEAD_COLUMNS` array, `removeLead_` function (line 550), the `removeLead` router case (line 168), and the `getOrCreateSheet_(REMOVED_LEADS_SHEET, …)` call inside `getData_` (line 301).
- Apps Script does NOT auto-deploy from GitHub. The updated `Code.gs` must be pasted manually into the Apps Script editor for this project and re-deployed as a Web App (same deployment ID, new version), OR a `clasp push` must be run against the project. PR #2's CHANGELOG step 9 ("Open the Google Sheet. Confirm: New tab `לידים שהוסרו` exists with headers matching `REMOVED_LEAD_COLUMNS`") was reported as "בוצע" but never verified via DevTools network tab.
- Until the deploy happens, `getData_` (old version) returns `data` without a `removedLeads` field, and the lazy `getOrCreateSheet_` call inside the new `removeLead_` never runs because the router doesn't yet know about the `removeLead` action.
- **This follow-up PR alone does NOT and CANNOT deploy Apps Script.** Only the source-of-truth `Code.gs` move (editor paste OR `clasp push`) will surface the sheet.

Recommended verification after Vered re-deploys Apps Script:

1. Open the Dashboard with DevTools → Network tab open.
2. Trigger a data load. Inspect the `getData` response JSON; confirm a `removedLeads` array key is present (even if empty `[]`).
3. Open the Google Sheet. Confirm the new tab `לידים שהוסרו` is now present with the `REMOVED_LEAD_COLUMNS` headers.
4. Soft-delete a test lead via `הסר`. Confirm the row appears in `לידים שהוסרו` with `removedAt` populated and `originSheet=Leads`.
