# CRM Work acceptance — Vered Today remediation 2026-11-01

**Baseline:** live/default branch `claude/build-ezone-dashboard-QOg5s` at `ae9bfd1bde2e40637a31cbe39039e6d3fe3c5ac1`, matching the independently authored 6-page Work report. **Draft only. No merge, deploy or production writes are authorized.** See [CRM-ACC-01 #333](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/333).

## Duplication check
- #325 is merged and provides 2 counters but not the five gaps below.
- #326 remains draft and tests Dana export/backup; no source files changed here by #326.
- #332 remains docs-only E-ZONE One architecture and CRM consolidation.
- Outpatient CRM #142–#148 remain draft and entirely separate. This PR touches only the Dashboard CRM front-end projection and tests; no new task, customer or finance engine.

## Fix map (in requested priority)
| Work finding | Changed behavior | Original logic reused |
|---|---|---|
| F5 A14/A15 | Empty / `unknown` discharge continuity remains a **derived open exception even after day 14**, with accountable owner ורד; explicit `none` or `continued_*` remains a recorded outcome | `houseExceptions`, discharge audit, existing Tasks/Activity (no writable duplicate) |
| F2 A05–A08 | Collection KPI is `—` and described as loading/partial if ANY needed source (debt / Tasks / receipts) missing; known rows can remain. Contact-index failures no longer falsely label new leads or activity as `no contact`; triage fails closed | `myDay`, `newLeadsNoContact`, `triageQueue`, existing finance permissions |
| F1 A02 | Weekly projection reads all dated meetings from existing calendar read model; respects selected week / filters; does not duplicate today's meeting or create another calendar | `calendarRows`, `weekPlan` |
| F3 A19 | `ממתין לגורם אחר` row navigates using its own `subjectKind` and `open` (patient/account for receipt; lead/meetings for manager) | `rowButtons` conventions |
| F4 A16 | `reported` receipt stays on Ortal's verification queue; `flagged` / `partial` is assigned to Vered for family clarification without changing original verification audit | `verificationRows`, role-scoped filtering |

## Evidence
- New `test/crm-work-acceptance-20261101.test.js` covers A02 / A05–A08 / A14–A16 / A19 with synthetic records (including role Dana, filters and week selection).
- Adjusted older tests that encoded the prior false assumption `unavailable contact index = no contact`, and wrong flagged owner.
- Full CI result must be recorded from the **exact draft head**; no claim of a passed suite before it is visible.
- The 14-day condition was **retention of open follow-ups**, not an authorization for future business workflow automation. Persistent old exceptions are read-only until Sandra approves whether to show a separate overdue section and the cadence/closure rules.

## Unchanged
No Apps Script/Code.gs, no data schema, server finance computation, permissions/identity, stored records, email/WhatsApp, new task engine, account ledger, Railway/GAS deploy or migration. Revenue KPIs in Dashboard and Outpatient remain in place. The future cross-module executive read access is unrelated and not altered.

## Release gates
Independent review, exact-head tests, Vered / Ortal / Dana user acceptance in isolated environment, monthly/window boundary cases, backup and rollback evaluation; **Sandra's separate explicit merge and production deployment approval**.