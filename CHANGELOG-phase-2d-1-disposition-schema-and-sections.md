# Changelog — "Phase 2d-1 — three-disposition schema + שימור לידים section split"

Foundation PR for the three-disposition closure model. Adds the disposition column to the backend schema, lazy-migrates existing rows via the read-side normalizer, and splits the שימור לידים tab's irrelevant section into three collapsible disposition sections. ZERO user-facing behavior change — the לא רלוונטי button and the closure flow stay exactly as they are. The actual user-facing change (closure modal with three disposition radios + button rename) ships in Phase 2d-2 as a separate PR.

## [Unreleased]

### Why this exists

1. Today's לא רלוונטי flow is a single bucket that conflates three real-world outcomes: never_relevant (cold lead), completed (סיים טיפול — successful), stopped_early (הפסיק לפני הזמן — started but stopped). This makes statistics misleading and prevents Vered from reporting on each category separately.
2. Phase 2d splits these into three first-class dispositions. To minimize risk, the split ships in TWO PRs: this foundation PR (schema + migration + section UI) ships with zero behavior change, and the user-facing modal change ships separately in 2d-2 after this is verified live.
3. Migration is lazy — no sheet rewrite needed. The read-side normalizer computes a row's disposition from existing fields (not_relevant_reason where present, fallback to not_relevant). Same pattern used throughout: Phase 2b legacy rows, PR #8 visitDate Date-object coercion.

### Migration approach

Stable disposition keys (never_relevant → not_relevant, stopped_from_house/stopped_new → stopped_early, missing → not_relevant) computed at read time in normalizeIrrelevantLead via the new computeDisposition helper. Existing rows persist untouched; new writes include an explicit disposition column. After enough new writes accumulate, the migration is effectively complete without any backfill script.

### Changed (apps-script/Code.gs)

- IRRELEVANT_LEAD_COLUMNS — append-only addition of 'disposition' column at the end.
- moveLeadIrrelevant_ — Object.assign extended with disposition: lead.disposition || 'not_relevant' default. Pre-2d-2 callers (which don't set disposition) get the sensible 'not_relevant' fallback that matches the existing button's semantics.

### Changed (public/app.js)

- DISPOSITION_LABELS map added near NOT_RELEVANT_REASON_LABELS — stable keys → Hebrew render-time labels.
- computeDisposition(lead) helper — three-branch fallback chain: explicit disposition field wins, else map from not_relevant_reason, else default to not_relevant.
- normalizeIrrelevantLead — pickField for 'disposition' added, then computeDisposition runs to fill from legacy fields if needed.
- renderIrrelevantLeads — refactored to group rows by lead.disposition and render three sections in spec order (not_relevant → completed → stopped_early), each with a heading + count + caret + collapsible body. Zero-count sections are hidden entirely. Existing #irrelevant-count pill kept showing total across all 3. Row markup unchanged (preserves Phase 2b meta block, restore button, all textContent patterns).
- markLeadIrrelevant — apiPost payload extended with disposition: 'not_relevant' (belt-and-suspenders; backend defaults the same value via moveLeadIrrelevant_'s fallback).

### Changed (public/style.css)

- .closure-section, .closure-section-heading, .closure-section-caret, .closure-section-count, .closure-section-body rules added. Uses existing palette vars (--text, --text-dim, --border). Caret rotates -90deg when section is collapsed.

### Not changed (intentional — deferred to 2d-2)

- Outer <h3>לא רלוונטים</h3> text on the section — stale once 2d-2 ships but kept untouched in 2d-1 for zero behavior change.
- Empty-state string "אין לידים לא רלוונטיים" — same reason.
- The לא רלוונטי button in the action row.
- showIrrelevantReasonModal (the Phase 2b reason capture).
- markLeadIrrelevant's overall flow (still uses the Phase 2b reason field; 2d-2 will replace the reason field with a disposition picker).
- Restore behavior — currently goes back to originSheet. 2d-2 will change this to always-ליד-חדש.

### Safety

- Append-only schema preserves all existing rows.
- Lazy migration runs entirely in the read-side normalizer — no batch update, no sheet rewrite, no risk to data.
- All three computeDisposition branches resolve to a valid disposition key, so no row will ever have an undefined disposition at render time.
- Section split happens after rows are normalized — same Phase 2b row markup, same textContent rules, same XSS protections.
- All-open default state ensures no data is hidden from Vered on first load.
- ZERO user-facing changes to closure flow — Vered's day-to-day is unchanged.
- Frontend + backend schema change → BOTH a Railway deploy AND an Apps Script redeploy are required for full effect. Without the Apps Script redeploy, the new disposition column won't exist in the sheet yet but lazy migration handles that gracefully (computeDisposition reads from existing fields).

### Manual test checklist

1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Switch to שימור לידים tab.
3. Confirm: existing rows render in three sections (לא רלוונטים / סיימו טיפול / הפסיקו), grouped by computed disposition. Most/all legacy rows should appear under לא רלוונטים since the Phase 2b reason field defaults to never_relevant for old rows.
4. Confirm: row markup (name, phone, house, reason+note from Phase 2b, restore button) appears unchanged in each row.
5. Click each section heading. Confirm: that section's body collapses; caret rotates. Click again — body expands.
6. Sections with 0 rows are hidden entirely (not shown with "(0)").
7. Confirm: #irrelevant-count pill at the section top shows the total across all 3 sections.
8. Confirm: existing לא רלוונטי button on a lead card still moves the lead correctly (zero user-facing behavior change). Refresh — the new row appears under לא רלוונטים section.
9. Hard refresh persists everything.
10. Open the Google Sheet directly. Confirm: לידים לא רלוונטיים tab has a new disposition column at the end. New rows written during step 8 should have 'not_relevant' in that column. Legacy rows have empty values in that column — that's correct, lazy migration handles them at read time.
11. DevTools → Network → sheets?action=getData → Response → confirm response includes the disposition field on each irrelevant lead entry.
