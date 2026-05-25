# Changelog — "Phase 2b — reason capture + פירוט note on לא רלוונטי"

Dashboard's לא רלוונטי flow previously moved a lead to the irrelevant sheet with no reason captured — once gone, there was no record of *why* Vered marked it. This PR adds a reason-capture modal (3 radio options + optional free-text note) that opens before the move, persists the reason key and note to the irrelevant sheet, and surfaces both on each card in the שימור לידים → לא רלוונטים section. Mirrors Outpatient PRs #3/#4.

## [Unreleased]

### Why this exists

1. Previous behavior: Vered clicks לא רלוונטי, lead silently disappears into the irrelevant sheet. No way to know later why it was marked irrelevant. Disposition data lost.
2. Three reasons cover the real-world cases: `never_relevant` (cold lead, wrong fit), `stopped_from_house` (was active in retention but stopped), `stopped_new` (new lead that started and stopped before commitment).
3. Free-text פירוט lets Vered capture nuance the radio buttons can't (specific reasons, follow-up notes, name of a competitor, etc.).
4. Reason keys persist (not the Hebrew labels) so a UI label rename never invalidates historical rows.
5. Cross-app feature parity with Outpatient PRs #3/#4 — same UX pattern, same schema shape, same defensive-normalize fix.

### Changed (apps-script/Code.gs)

- `IRRELEVANT_LEAD_COLUMNS` extended with `not_relevant_reason` and `not_relevant_note` (appended at end — append-only per the `ensureSheet` rule; legacy rows stay valid with empty values).
- `moveLeadIrrelevant_(lead)` `Object.assign` extended to pass-through both fields with `|| ''` defaults. No other backend changes — `upsertRowById_` / `deleteRowsById_` handle the rest based on the columns array.

### Changed (public/app.js)

- `NOT_RELEVANT_REASON_LABELS` map added near `STAGE_IRRELEVANT` (lines ~24–33). Keys: `never_relevant` / `stopped_from_house` / `stopped_new`. Hebrew labels render-time only.
- `normalizeIrrelevantLead` extended with `pickField` pass-through for `not_relevant_reason` and `not_relevant_note`. **NO `'note'` or `'reason'` fallbacks** — Dashboard's `LEAD_COLUMNS` already has a general-purpose `note` field for lead הערות, and a fallback would conflate the two concepts on legacy rows.
- `showIrrelevantReasonModal({ onConfirm })` helper added before `showToast`. Mirrors `showConfirm`'s standalone modal pattern — did NOT extend the shared `showModal` because radio fields aren't supported there and the wiring (disable-submit-until-radio-picked) is feature-specific. Submit button disabled until a radio is picked. Backdrop click + ביטול close. `throw`-on-error keeps modal open for retry.
- `markLeadIrrelevant` refactored: no longer `async` at the top level. Opens `showIrrelevantReasonModal` first. The entire optimistic UI + `apiPost` + rollback logic moved inside `onConfirm`. `throw e` after rollback keeps the modal open if the backend write fails — allows retry without re-entering reason+note.
- `renderIrrelevantLeads` extended with an optional `.irrelevant-meta` div appended after the existing row grid. Built imperatively with `textContent` (per the project rule for new user-data renders). Reason displayed via `NOT_RELEVANT_REASON_LABELS` lookup. Note displayed verbatim. Meta block skipped entirely when both reason and note are empty (legacy-row friendly).

### Changed (public/style.css)

- Single `.irrelevant-meta` rule appended after the `.irrelevant-row` block. Uses `grid-column: 1 / -1` to span the meta as an implicit second grid row — no `grid-template-rows` override needed on the row itself. Dashed top border for visual separation. `var(--text-muted)` + `var(--border)` for palette consistency.

### Not changed (intentional)

- `showModal` — NOT extended with a radio field type. 5+ callers, invasive change. Dedicated modal scoped to this feature is cheaper.
- `showConfirm` — untouched.
- Other CSS class names introduced by the modal (`.reason-radio`, `.reason-fieldset`, `.irrelevant-meta-label`, `.irrelevant-meta-reason`, `.irrelevant-meta-note`) — left to browser defaults. Minimal CSS footprint per spec.
- הסר flow (Phase 2a soft-delete) — NO reason captured, intentionally. Different concept; soft-delete is a one-way drop, irrelevant is a disposition.
- Edit-reason-after-the-fact — out of scope. v1 = set once at לא רלוונטי time.
- `restoreLead_` + `restoreIrrelevantLead` flows — untouched. Restore deletes the irrelevant row entirely, so the reason+note are dropped with it (intentional — the restored lead is back in the active pipeline and the disposition no longer applies).
- Required textarea — NO. פירוט is optional. Only the reason radio is required (enforced by the disabled-submit UI).

### Safety

- Backend writes empty strings for legacy invocations missing the new fields (`|| ''` defaults).
- `normalizeIrrelevantLead` is now defensive against silent-drop on getData round-trip — same bug pattern Outpatient hit in commit `1d2436c`. Without this, the backend would write the columns but the next `getData()` would silently drop them on normalize.
- `showError` surfaces backend failures; `throw e` keeps the modal open so Vered can retry without losing her reason+note entry.
- `textContent` on the user-entered note prevents HTML injection from sheet entries.
- `escapeHtml` on static radio labels even though they're from a static map — consistency rule for new `innerHTML` rendering.
- Reason persisted as a stable key (`never_relevant` etc.) — Hebrew UI label can be renamed any time without invalidating historical rows.
- Submit button disabled state prevents accidental submission of an empty reason.

### Manual test checklist

1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Switch to לידים tab. Find any active lead.
3. Click לא רלוונטי ✕. Confirm: reason modal opens with title "סימון כלא רלוונטי", 3 radio options visible, פירוט textarea visible, אישור button disabled.
4. Click ביטול. Confirm: modal closes, lead stays in active board, no error toast.
5. Click לא רלוונטי ✕ again. Click any radio option. Confirm: אישור button becomes enabled.
6. Click אישור without typing in פירוט. Confirm: lead moves to לא רלוונטים section in שימור לידים tab.
7. Open שימור לידים → לא רלוונטים. Find the lead. Confirm: meta block shows "סיבה: [Hebrew label]" below the existing card info. No פירוט line shown (empty).
8. Mark another lead as לא רלוונטי. This time fill פירוט with "לקוח בקש להתקשר חזרה בעוד חודש" (or any text). Submit.
9. Confirm in שימור לידים the row shows both "סיבה: ..." and "פירוט: ..." lines.
10. Try long פירוט text (~500 chars). Confirm textarea stops accepting at 500.
11. Open Google Sheet directly. Confirm: לידים לא רלוונטיים tab has two new columns at the end (`not_relevant_reason`, `not_relevant_note`). Values from the test marks above are populated.
12. Restore one of the test leads via the restore button. Confirm: lead returns to active board. Re-mark it irrelevant — modal opens fresh (not pre-filled with prior reason). Expected.
13. (Apps Script deploy verification) Open DevTools → Network → `sheets?action=getData` → Response → search for `"not_relevant_reason"`. Confirm the field is present in `irrelevantLeads` array entries (even on legacy rows it'll be an empty string).
