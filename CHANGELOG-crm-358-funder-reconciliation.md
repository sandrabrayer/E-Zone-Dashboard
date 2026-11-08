# CRM #358 — source-backed funder reconciliation and acceptance coverage

2026-11-02. DRAFT only; no merge, deployment, source-data, role or finance-policy change.

## Problem and behavior

Admission saves the patient/lead before writing Funders. A refused funder write previously left only a transient warning, which disappeared on reload. A committed funder write whose HTTP reply was lost also remained unverified even when the source could prove the requested state.

- Read `getPayments` after an unacknowledged funder write. Confirm only one row with the exact patient ID, effective date and requested funder. The production projection intentionally omits `submissionId`; this confirms source state, not receipt of the original response. Conflicting rows remain unresolved. Never repeat either write.
- Derive a finance-only clarification from Patients plus Funders when a linked in-house admission has no verified funder covering its entry date. It persists across refresh and a second authorized login, links to the existing account tab, and is absent from Dana's view. It is not a new task ledger or a claim that an empty source proves a failed write. Legacy patients without a source lead are not automatically classified or changed.
- Invalidate an already opened billing/account snapshot after admission/funder completion, so it cannot show pre-admission data.
- Reuse the concurrent admission-source reconciliation in `964f8dd` and funder request flow/fault modes through `3bc3034`; correct the latter’s read contract rather than installing a second implementation.

## Validation

- Stateful local Express/Chromium fixtures: refused funder, reload, separate Sandra login, Dana negative view, lost funder HTTP reply after source commit, one admission and one funder attempt, and a preloaded account refreshed with the verified funder.
- Pure negative controls: another patient/date/value, conflicting rows, unavailable response and invalid date. One test uses the actual `fundersForClient_` Apps Script projection.
- Extend the existing synthetic browser workflow with the existing full CRM shell journey and actual user-switch suite. Respect `CHROMIUM_PATH` in those suites and require zero skipped tests. Correct the shell test's obsolete direct-admission success-text expectation while retaining payload assertions.
- Exact-head counts and CI links are recorded on PR #358; see the acceptance checkpoint below. Browser mocks are not native Google/staging acceptance.

## Remaining release boundary

This patch does not provide a transaction outbox, automatic payer repair, a payer editor, native Google restore evidence, new role grants or Outpatient reciprocal status. Corrections use the existing authorized source workflow. No production approval is implied.
