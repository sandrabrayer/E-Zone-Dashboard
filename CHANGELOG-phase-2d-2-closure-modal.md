# Changelog — "Phase 2d-2 — closure modal with three dispositions"

Phase 2d-2 ships the user-facing change for the three-disposition closure model. The לא רלוונטי ✕ button in lead cards is renamed to סגירת ליד, and the Phase 2b reason-capture modal is replaced with a new closure modal that captures one of three dispositions (לא רלוונטי / סיים טיפול / הפסיק לפני הזמן) plus the existing פירוט free-text note. Restore behavior changes to always send the lead back to ליד חדש. Phase 2d-1's foundation (schema, lazy migration, section split) now becomes fully end-to-end functional.

## [Unreleased]

### Why this exists
1. Phase 2d-1 added the disposition schema + UI section split but kept the user-facing flow unchanged (לא רלוונטי button + Phase 2b reason modal still active). This was deliberate — risk-isolating the schema change from the UX change.
2. With 2d-1 verified live (sections render correctly, lazy migration works, both Apps Script deployments updated), 2d-2 ships the actual user-facing change.
3. Restore-to-ליד-חדש is correct because returning patients/leads are functionally new engagements (new commitment, new schedule, new payment). Their history is preserved in the Phase 2b reason+note metadata.

### Changed (public/app.js)
- Button at buildLeadCard's .lc-actions: label "לא רלוונטי ✕" → "סגירת ליד", title "סמן כלא רלוונטי" → "סגור ליד", click handler markLeadIrrelevant → closeLead.
- New showCloseLeadModal({ onConfirm }) helper added — mirror of Phase 2b's showIrrelevantReasonModal but driven by DISPOSITION_LABELS instead of NOT_RELEVANT_REASON_LABELS. Title "סגירת ליד". onConfirm payload: { disposition, note }.
- New closeLead(lead) function added — mirror of markLeadIrrelevant. Builds the moved payload with disposition from the modal (no longer hardcoded). Drops not_relevant_reason and not_relevant_note writes for new rows. apiPost still hits action: 'moveLeadIrrelevant' (backend name unchanged).
- restoreIrrelevantLead refactored: removed originSheet validation. Always sends stage: 'new'. Updated confirm copy and success toast accordingly.
- Empty-state string: "אין לידים לא רלוונטיים" → "אין לידים סגורים".
- Old showIrrelevantReasonModal and markLeadIrrelevant kept in place but tagged /* @deprecated 2d-2 — remove in cleanup PR */. Behavior unchanged, no longer wired into any caller. Safety net for hot-revert.

### Changed (public/index.html)
- Outer h3 text: "לא רלוונטים" → "סגורים". Element id #irrelevant-count unchanged (still referenced at app.js).

### Not changed (intentional)
- apps-script/Code.gs — fully ready since 2d-1. moveLeadIrrelevant_ already accepts explicit disposition. restoreLead_ never inspected originSheet — restore-to-new is purely a frontend change.
- Phase 2b columns not_relevant_reason and not_relevant_note in the sheet — left in place. Legacy rows keep values. New rows leave them blank. Read-side display in renderIrrelevantLeads still shows them per-row for legacy data.
- NOT_RELEVANT_REASON_LABELS map — still used by renderIrrelevantLeads to display legacy reasons on rows. Not deleted.
- Phase 2b showIrrelevantReasonModal and markLeadIrrelevant — kept as deprecated dead code for one PR. Will be removed in a follow-up cleanup PR after 2d-2 is verified live.
- Section headings inside שימור לידים already render singular labels from DISPOSITION_LABELS (set up in 2d-1). No change needed.
- The הסר button alongside (Phase 2a) — untouched.
- restore button on rows — still works, behavior changed transparently (always-to-new).
- Patient שחרר flow — separate, addressed in Phase 2e (next session).

### Safety
- closeLead's optimistic UI + rollback mirrors markLeadIrrelevant's existing pattern exactly.
- showCloseLeadModal's submit-disabled-until-radio-picked discipline preserved from showIrrelevantReasonModal.
- @deprecated tags on old code paths — explicit signal that they're dead, while keeping them readable for emergency revert.
- Backend coalescing (|| '') on the now-unsent fields means new rows just have blank cells in those columns — no errors, no schema corruption.
- Restore-to-new behavior verified safe at the backend level — restoreLead_ never inspected originSheet, so the existing copy-from-LEAD_COLUMNS pattern handles stage='new' identically to any other stage.

### Manual test checklist (run on live URL after Railway deploy)
1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Switch to לידים tab. Find any active lead. Confirm the button in the action row now says "סגירת ליד" (was "לא רלוונטי ✕").
3. Click "סגירת ליד". Confirm modal opens with title "סגירת ליד", 3 radio options (לא רלוונטי / סיים טיפול / הפסיק לפני הזמן), פירוט textarea, אישור button DISABLED.
4. Click ביטול. Modal closes, lead stays in active board.
5. Click "סגירת ליד" again. Pick "סיים טיפול". Confirm: אישור becomes enabled.
6. Optionally type something in פירוט. Click אישור.
7. Switch to שימור לידים tab. Outer header should read "סגורים" (was "לא רלוונטים"). Find the lead — should appear under the "סיים טיפול" section (not "לא רלוונטי").
8. Test "הפסיק לפני הזמן" — same flow, different disposition. Should land in the הפסיק לפני הזמן section.
9. Test "לא רלוונטי" — same flow. Should land in the לא רלוונטי section.
10. Find one of the leads in any section and click "שחזר ליד". Confirm copy says something about ליד חדש. Confirm. Lead should return to לידים tab at the "ליד חדש" stage (NOT at its previous stage like before).
11. Open Google Sheet > לידים לא רלוונטיים tab. Confirm new rows have explicit disposition value in the disposition column. not_relevant_reason and not_relevant_note columns are blank for new rows (correct — dead-but-readable for legacy data).
12. Switch to viewer mode if available. Confirm "סגירת ליד" button is hidden (it's in .lc-actions edit-only wrapper — same gating as before).
