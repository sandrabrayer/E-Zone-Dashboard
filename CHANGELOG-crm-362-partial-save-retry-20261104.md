# CRM #362 follow-up — lost response / partial save recovery (04 Nov 2026)

**DRAFT ONLY, not deployed.** This small follow-up is intentionally based on the already-merged Dashboard #362 (`dca53d5cdab4268ad5dfbe131572b7ab92a61762`). The preceding PR has already deployed to Railway and Apps Script; its synthetic CI did not simulate a lost response between the two writes in a patient-rescheduled or cancelled meeting.

## Real source risk on deployed code
1. `writeLead(id, patch)` saves the new meeting date/outcome to Leads, then a second independent `postLeadFlag(flag)` appends the Activity record saying the patient initiated the change. An HTTP error/lost reply after the second source append can mislead the user and leave the manager WhatsApp link unavailable until confirmation.
2. Prior UI created `newSubmissionId()` for every second-stage retry, defeating the Apps Script server's per-submissionId idempotency. A new click could create duplicate Activity rows; this is a code-path risk, **not proof of a duplicated production row**.

## Minimal fix in this draft
- `leadFlagPendingPlan` pins the exact first submission ID and payload. A changed flag after an uncertain reply fails closed; identical retry reuses the same original operation.
- `postLeadFlag` retains pending operations per lead+flag kind while the page session survives. It acknowledges only matching `leadId` and `kind` from the source; on unknown result it preserves the pending request and shows a clear partial-save warning.
- The patient-change form first checks a pending second-stage event and retries **only that Activity flag**, not `writeLead` again. The browser presents the manager WhatsApp action only after the source confirms the event; the user must deliberately tap to send.
- The in-memory retry guard does **not** persist after a full page reload. After unknown outcomes and reload staff must verify the original record. This PR does not claim end-to-end distributed transaction atomicity or source-verified client read-after-refresh.
- No Code.gs, schema, finance, permissions, secrets, Google workbooks, Apps Script source, or other app changes.

## Tests and required acceptance
The existing synthetic `test/crm-vered-feedback-1104.test.js` now exercises a real Apps Script source append with simulated lost reply and retry: source reports replay and contains one Activity event. Pure helper tests verify frozen original payload and refuse altered uncertain retries; a source-level UI guard test checks that pending second-stage recovery returns before a second Leads write.
Must run exact-head GitHub Tests + CRM browser + billing browser checks and sign-in acceptance (Vered/staff) against existing legitimate records. No fake live patient, receipt or message sent. Must reconcile with pending Dashboard performance DRAFT #361 before any separate merge/deploy approval.

**Release boundary:** No merge/deploy without Sandra's explicit authorization. Dashboard's Apps Script deploy workflow runs automatically for merged changes touching `apps-script/Code.gs`, though this PR changes UI/tests/docs only.
