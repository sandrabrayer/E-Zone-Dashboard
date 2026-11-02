# CRM-PRODUCT-FLOW-01 — Manager-reported no-show as a call back, not a held meeting

**2026-11-02 | P1 business-correctness / UX** | Product and feature issue https://github.com/sandrabrayer/E-Zone-Dashboard/issues/350 | source comparison only, DRAFT.

## Verified source-flow discrepancy
- The existing separate /meeting-report form sends meetingReportOutcome = no_show (displayed there as "לא הגיע / בוטל") to the existing Leads columns. Its combined outcome does NOT independently prove whether the visit was cancelled or the client failed to attend.
- The CRM meetingBuckets and myDay previously put all seen reports with empty meetingOutcome in a generic "להחליט אחרי דיווח המנהל/ת" item. This made a no-show follow the same path as a completed professional meeting.
- The older compute fallback described any past scheduled meeting as "הפגישה התקיימה לפני X ימים", even when no manager report existed. A calendar date is NOT evidence of attendance.
- The real logContact and next-action form already exists; no second task or manager report action is justified.

## Implementation, same existing source records only
1. The original, source-derived row ID f:decide:leadId becomes kind meeting_no_show_followup when the seen source manager report is no_show and no family decision has been recorded. It displays "לברר היעדרות / ביטול ולתאם מועד חדש" rather than "להחליט אחרי דיווח". It opens the EXISTING תיעוד שיחה form, where Vered/Dana can schedule a callback or explain why none is needed. Opening the form does not close the row.
2. While the no-show report remains unread, the original report_unseen row takes precedence and names the original "לא הגיע / בוטל" result. It does not imply attendance.
3. The lead card's פגישות ושירותים tab shows a caution when the manager result is no_show and the family decision is still missing. It retains the original report.
4. The older compute read-only row no longer says a past meeting took place without proof; it says the date passed and occurrence is unverified.

## Tests — synthetic only
- test/crm-meeting-no-show-followup.test.js: source outcomes, unread-before-followup, normal meeting outcome unchanged, documented family cancellation, exact lead ID, no duplicated projected row, output escaping.
- test/crm-today-card-open.test.js: actual local Express and Chromium with dummy data, Vered desktop 1024px and Dana mobile 390px; source-backed work row opens the EXISTING contact form and the manager report; no write when opening or cancelling.

## Explicit non-changes
No Leads schema, new state machine, stage ID, write action, finance calculation, scheduled messages, role permission, Outpatient data, Apps Script, real patient data or deployment. Do not auto-reschedule, auto-close or add another Tasks ledger; the combined manager outcome is not split into two invented source facts. Separating no-show and cancellation remains PROPOSED, not authorized here.

### Release and ownership gates
Stacked on Dashboard DRAFT #346 → #348, not production-ready. Needs CI, authorized source read/reload, security review, then Sandra's separate explicit merge and deploy approval. The patient-specific collection display discrepancy stays with Claude. Green CI only proves synthetic checks, not production behavior.
