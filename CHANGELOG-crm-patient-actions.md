# C7 — patient actions inside the CRM: edit, house move, discharge — 2026-10-27

CRM restructure, Session C (write actions, fourth PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no SW bump (hashed assets).

## Actions (patient drawer, «מטופלים»)
- **עריכה** — entry date, monthly pay, advance, status (ניסיון / פעיל / בהמתנה), notes → the house
  as read with the changed row (id match → in-place replace; a stale save is a refused conflict).
- **העברה לבית אחר** — the TARGET house as read + the patient with `houseId = target` and
  `movedFrom = current` (the classic ✏-modal intent `collectHouseMoves_` resolves): the server
  moves the row, keeps its id and lead link, audits `patient_moved_house`; a `conflicts[].move`
  answer is shown as «עודכן בינתיים». Confirm dialog first.
- **שחרור** — disposition (סיים טיפול / הפסיק לפני הזמן / משוחרר לטיפול חוץ), discharge date
  (default today), «המשך טיפול», note. Same two-step as the classic flow: `dischargePatient` with
  the audit row (`dischargeAuditRow`: fresh id, `patientId`, `prior_status`, `exitDate`,
  `dischargedAt`, `continuity`; a `duplicate:true` answer is accepted), then the house as read with
  the row released. A `refund.created` answer shows «נוצר זיכוי לפי הכלל». For «משוחרר לטיפול
  חוץ» the existing `/api/outpatient-lead` handoff is called with the audit id (toast with the
  result; retry stays in the classic dashboard).
- Optimistic with rollback; the payload is serialised before the optimistic apply.

## Not yet
Returning patient («מטופל חוזר» matching), restore of a discharged patient, delete — classic.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+1, write-action allow-list now includes
`dischargePatient`), `test/crm-shell-browser.test.js` (+1 real-Chromium scenario), ESS.
Rollback: flag off, or revert.
