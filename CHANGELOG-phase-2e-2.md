# Changelog — "Phase 2e-2 — patient discharge modal + restored flag"

Phase 2e-2 ships the user-facing change for patient discharge. The שחרר button on patient rows now opens the closure modal (refactored to accept dispositions + title parameters) with 2 disposition radios (סיים טיפול / הפסיק לפני הזמן) and the free-text פירוט. On confirm, the existing release flow (status='released' + exitDate) still runs, AND an audit row is written to מטופלים משוחררים with the disposition + note. Restore now marks the audit row with a restored flag instead of leaving it for re-discovery.

## [Unreleased]

### Why this exists
1. Phase 2e-1 set up the discharge schema + tab but left the user-facing flow unchanged. This PR ships the actual UX change.
2. Audit-additive design: existing release semantics (status='released' on the patient row) are preserved — the discharged sheet is purely additive audit data. No existing code that reads patient.status breaks.
3. The restored flag closes the rough edge where restored rows reappeared on reload — audit truth preserved, UI hidden.

### Changed (apps-script/Code.gs)
- DISCHARGED_PATIENT_COLUMNS: append 'restored' column (schema is append-only, existing rows unaffected).
- restorePatient_: after creating the new lead, ALSO marks the source discharged row with restored: 'TRUE' via upsertRowById_. The audit row stays, just gets the flag.

### Changed (public/app.js)
- showCloseLeadModal({ onConfirm, dispositions, title }): refactored to accept dispositions filter and custom title. Defaults preserve existing closeLead caller (3 dispositions, title 'סגירת ליד').
- New dischargePatient(patient) function: opens modal with { completed, stopped_early } and title 'שחרור מטופל'. On confirm, runs BOTH the existing release flow (status='released', exitDate=today, saveAll) AND the new audit write (apiPost dischargePatient with disposition + note). Optimistic UI for both. Atomic rollback on either failure.
- שחרר button wiring: releaseBtn.onclick → dischargePatient(p). Old releasePatient function deleted.
- normalizeDischargedPatient: extended to pickField the new 'restored' field with aliases.
- renderDischargedPatients: filters out rows where restored === 'TRUE' OR restored === true (handle both string and bool from Sheets coercion).

### Not changed (intentional)
- exitDate: auto-set to todayISO() on discharge. No UI capture (replaced by disposition modal).
- The old exitDate capture modal: deleted as part of releasePatient deletion.
- Patient deletion (X button): untouched.
- saveAll's existing path through replaceHousePatients_: unchanged.
- CSS: no changes needed.
- Lead closure flow: unchanged (defaults make refactor invisible).

### Safety
- showCloseLeadModal refactor is backward compatible: closeLead's existing call works unchanged thanks to defaults.
- dischargePatient is additive — the release mutation still happens, audit row is extra.
- Restored flag filtered at render time; backend always writes it; legacy rows have empty value (renders as not-restored, correct).
- Both Apps Script deployments need redeploy (Code.gs touched).
- Railway redeploy after merge.

### Manual test checklist (after Railway + Apps Script redeploys)
1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Switch to תפוסה tab. Find any active patient (status not released). Click שחרר.
3. Confirm: modal opens with title שחרור מטופל, 2 radios (סיים טיפול / הפסיק לפני הזמן), פירוט textarea, אישור disabled.
4. Click ביטול — modal closes, patient unchanged.
5. Click שחרר again. Pick סיים טיפול. Optionally fill פירוט. Submit.
6. Patient should disappear from active תפוסה list (status='released' filter removes them).
7. Switch to מטופלים משוחררים tab. Confirm patient now appears with disposition סיים טיפול, dischargedAt = today, פירוט shown if any.
8. Test הפסיק לפני הזמן on another patient — same flow.
9. Click שחזר מטופל on a discharged-patient row. Confirm: a new lead appears in לידים tab at ליד חדש stage with the patient's name and phone.
10. Hard refresh. Confirm: the restored patient ROW IS HIDDEN from מטופלים משוחררים (was the rough edge before; now filtered out).
11. Open Google Sheet → מטופלים משוחררים. Confirm: the new restored column at end. Restored rows have 'TRUE' there; non-restored rows are blank.
12. Regression check: Lead closure via סגירת ליד button still works (refactored modal still serves it correctly with 3 dispositions).
