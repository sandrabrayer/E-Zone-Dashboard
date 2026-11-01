# CRM Work business acceptance — 2026-11-01

Source: independent Work acceptance report of Vered's Dashboard CRM `היום` at `ae9bfd1`, 19 synthetic acceptance scenarios (10 passed and 9 exposed five categories of gaps). Program: E-ZONE One ARCH-01, issue #331, and remediation issue #333.

This draft is a **source-level view/model correction only**. No production data, Apps Script, financial ledger, access grants, customer identity, separate task engine or deploy configuration changed.

- **F5**: treat blank and literal `unknown` continuity as unresolved, even after the earlier 14-day discharge lookback. No automatic closure by age; `none` remains a documented distinct outcome. Derived row is not a persisted task.
- **F2**: require all 3 independent sources for a complete collection work count; display partial/loading, never misleading zero; contact failure cannot create a false "no contact" lead or label.
- **F1**: render dated meetings for the selected work week through the existing Calendar projection; no duplicate meeting rows on today.
- **F3**: side waiting row opens its correct entity and tab, not a hard-coded lead meeting.
- **F4**: family payment clarification is in Vered's visible work queue, while Ortal remains the owner of receipt verification history and reported receipts awaiting her approval.
- **Tests**: `test/crm-work-acceptance-20261101.test.js` and updates to `test/crm-my-day.test.js`, `test/crm-ortal-day.test.js`; CI must be checked against draft head.

**Business checkpoint:** the recent-discharge 14-day visibility window is not a closure rule. A later product decision may choose reminders, escalation cadence or archived/active treatment, but these are not implemented in this draft.

**Explicit safety:** draft PR only — no merge, Apps Script/Railway deployment, live test write, schema adjustment or finance/role modification without Sandra's separate sign-off.
