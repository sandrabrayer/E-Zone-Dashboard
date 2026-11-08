# E-ZONE One — Work acceptance integrated candidate (unreleased)

**Date:** 1 November 2026. **Source:** old Dashboard Work issue #333/DRAFT #334, updated for current deployed-source base merged #337/#338 and integrated safety fixes #345. Draft review only.

## Changes
- Reuse existing calendarRows to show future meetings in the selected week, without creating new meetings or double-counting today's meeting (F1).
- Missing/degraded contact-index, Tasks, debt and receipts are **unknown/partial**, never zero/no contact. Individual source-proven debt rows remain accessible (F2).
- "Waiting for another owner" opens the right subject and pane (lead/meeting or patient/account), not always the lead pane (F3).
- Reported receipt stays in Ortal's verification queue; flagged/partial is Vered's clarification task. No changes to the payment ledger (F4).
- F5 long-lived unresolved continuation remains the stronger integrated implementation from #345: sent/disposition is not treatment-start evidence, even after day 14. No third task store. This is intentionally different from the old pre-#337/#338 Work branch.
- Existing CRM-ID-01 guard prevents automatic fuzzy matching of lead to patient at direct intake.
- New synthetic independent acceptance tests imported from #334 and adapted to the current code, plus dedicated Chromium tests from #345.
- Cache v111 → v112; no source/Apps Script, finance, permission, data or schema changes.

## Integration guard
PR #334 must not be merged alongside this branch: both touch the same CRM functions with older baseline assumptions. Supersede it only after exact-head CI and manual verified UX acceptance. Outpatient product suite #142–148 and status return #145 remain DRAFT, so this does not claim complete cross-module acknowledgment.
