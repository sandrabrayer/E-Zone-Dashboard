# C14 — «פגישות ושירותים» over real data; manager reports in the work queue — 2026-10-28

CRM restructure, Session C (eleventh PR). Flag-gated. No Code.gs, no server change, no SW bump.

## What
- The drawer tab now shows: the intake meeting (date, time, with whom, Vered's outcome); **the house
  manager's report** from `/meeting-report` (outcome label, companion label or free text, note,
  reporter, time in Asia/Jerusalem) with a «חדש» chip while unseen; for a patient, the lead's
  meeting (via `fromLead`) and the **discharge record** (exit date, disposition, continuity, note —
  matched by the audit row's `patientId`, else the legacy house / name / entry-date triple;
  restored and soft-deleted rows skipped). Services: «Therapists עדיין לא מחובר».
- Opening the tab marks the report seen exactly as the classic card does: `meetingSeen = '1'`
  through the one-lead `saveAll` (every other field travels untouched); never for the read-only view.
- «היום שלי»: an unseen report is a `today` row «לקרוא את דיווח המנהל/ת על הפגישה»; the card's
  next action reads «דיווח מנהל/ת חדש»; «בקרה» gains «דיווחי מנהל/ת שלא נקראו». A past meeting
  with a report but no outcome of Vered's now asks for *her* outcome («לעדכן תוצאת פגישה») instead
  of «לקבל דיווח מהמנהל/ת».
- `normalise` carries the six `meetingReport*` lead fields and a normalised `discharges` list.

## Tests
`test/crm-shell-ui.test.js` +1 (labels, local time, unseen, queue row / next action / metric,
discharge matching incl. legacy triple, restored / deleted skipped); `test/crm-shell-browser.test.js`
+1 Chromium scenario (queue row, card flag, tab content, ONE saveAll with `meetingSeen`, no double
save, flag gone). Files: `public/crm/crm.js`, tests, ESS, `docs/crm/ROLLOUT.md`.
