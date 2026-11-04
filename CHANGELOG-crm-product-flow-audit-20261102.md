# CRM-PRODUCT-FLOW-01 — documentation-only business workflow and feature inventory (2026-11-02)

**Business direction:** Sandra asked the ChatGPT CRM conversation to **always include professional features, end-to-end workflow logic and operational usability**, not just bug fixes. This is a standing part of the CRM mandate, tracked in [#350](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/350), and will not need to be re-explained in another chat.

## Deliverables
- `docs/crm/PRODUCT-CAPABILITY-GAP-MATRIX-20261102.md` — 32 source-anchored capabilities with status, gap, priority, ownership and existing PRs.
- `docs/crm/BUSINESS-JOURNEY-WORKQUEUE-BLUEPRINT-20261102.md` — 15 business stages, source-of-truth boundaries, Vered's Today screen, roles, exceptions and UI verification contract.
- `docs/crm/FEATURE-ROADMAP-ACCEPTANCE-20261102.md` — P0/P1/P2 implementation prerequisites, reuse, accountable owner and test/release plan.

## Notable grounded findings
- Dashboard CRM lead token `paid` displays ״בטיפול פעיל״ while Managers' `paid` label is ״שילם מקדמה״. Change stage UI semantics only after cross-app consumer mapping; do not change stored key.
- Managers' `/meeting-report` already supports a combined `no_show`/cancel outcome; CRM `meetingOutcome` has no separate no-show. Reuse report source; avoid a second meeting engine.
- `newLeadsNoContact` and `triageQueue` disagree in sort order, needing one SLA/priority decision.
- Paid-without-admission exceptions skip cases without an entry date; the condition is not proof of actual verified payment.
- A released client's historical debt and a new projected cycle are different concepts; old/new CRM parity must show the source and coverage. The **specific reported case is owned by Claude**, and no duplicate code fix is started here.
- Cross-app return status and shared roles remain separate draft work; role documents contain superseded D1/D5 rules needing governance reconciliation.

## Safety and scope
Source-read only; no patient identifiers/phones/clinical details or financial records written into this PR. No code, Sheets, Apps Script, schema, permission, price, credentials, environment, automation, application state, production merge or deployment changed. Existing CRM stabilization stays [Dashboard #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339), DRAFT #346→#348. Outpatient-specific product ownership stays [Outpatient #149](https://github.com/sandrabrayer/ezone-outpatient/issues/149); architecture is [Dashboard #331/#332](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/331). No duplicate task, finance, customer or meeting engine.

**Evidence label:** GitHub deployed branch code is not independent signed-in production proof. Any feature marked proposed must be approved before build; any production activation requires separate explicit approval by Sandra.
