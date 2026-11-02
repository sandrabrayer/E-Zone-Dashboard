# CRM-SAVE-01 — honest admission/funder save, discharge-source mismatch (DRAFT; 2026-11-02)

Refs: [P0 acceptance #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339); stacked on [integrated CRM draft #346](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/346). This candidate is **DRAFT ONLY**; source code reviews and synthetic tests do not certify production readiness.

## Verified root causes on the merged Dashboard baseline
1. `postAction()` emitted `… — בוצע` as soon as the admission's `saveAll` returned, before `appendFunder`. `saveFunderBestEffort()` swallowed a refused/unconfirmed second write, so both `admitLead` and `directAdd` returned `true` regardless. When the second write failed, only a temporary toast identified a partial admission. The unchanged `state.payments` projection could also leave a stale account after successful funder save.
2. A discharge is multi-stage: `dischargePatient` audit → Patients `saveAll` → optional Outpatient handoff. The catch block rolled back the optimistic browser state without checking whether the audit had committed. A failed Outpatient handoff displayed a warning but returned `true`.
3. Prior [merged fix #338](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/338) corrected `bad_submission_id` for NEW CRM funder writes, but its changelog notes possible missing historical funder rows for CRM admissions from **2026-10-28 onward**. This is a **read-only reconciliation priority**, not a proven list of affected production patients.

## Scope of this draft
- Admission's first step still must have its original exact `saveAll` acknowledgement; it no longer shows *full completion* before funder acknowledgement. A finance user's second step validates the exact `appendFunder.row.submissionId` and returns `false` on refusal, invalid response or timeout. It explicitly states that admission may already exist and MUST NOT be submitted again.
- After a verified funder response, a read-only `getPayments` refresh updates the finance view. An unavailable refresh is distinguished from an unacknowledged funder write.
- Discharge error path re-reads the authoritative state rather than asserting a UI rollback of already-committed server work. An Outpatient send/refusal is labelled *discharge saved, referral unverified* and returns incomplete rather than global success.
- Existing `houseExceptions` derives **one** unresolved integrity row when a discharge audit and a still-active Patients row share an exact stable `patientId`. It suppresses the duplicate continuation row until status is reconciled. No fuzzy name/phone matching, new writable task store, status alteration or automatic retry.
- Synthetic negative controls exercise exact-ID finance acknowledgement, discharge/audit mismatch, restored/deleted safety, no inferred patients, and a Chromium admission with a deliberately refused funder write.

## Known limitations — BLOCKERS before any production release
- This frontend patch does **not** provide a durable source-side admission/funder operation journal or safe cross-session retry. On uncertain `saveAll` admission responses, the original optimistic rollback can still occur. A new admission must **not** be re-submitted to repair only its funder.
- An `appendFunder` response proves acknowledgement of the matching request key, but a full signed-in source-row read-after-write and independent user read are not yet proven. The `getPayments` refresh improves screen freshness; it is not a substitute for an isolated staging restore and authenticated acceptance.
- A discharge with a missing/ambiguous `patientId` cannot safely be auto-reconciled. Source-backed persistent exception is limited to an exact patient ID mismatch; unresolved source IDs require manual triage.
- The two-way Outpatient accepted/contacted/started status, exact care identity drafts and backup/recovery OP-03 are separate DRAFT workstreams. No automatic handoff replay is added here.
- The historical funder audit must check CRM admissions and authoritative Funders records for Oct 28–Nov 2 with stable IDs + legacy keys; identify missing/duplicate funders; document counts without PII. Do **not** add fake funders, auto-backfill, change financial history or publish names in an issue.
- No actual production writes, merge/deploy, Apps Script source, schema, permissions, automation triggers, finance rules or credentials changed. Deployment requires Sandra's separate approval **after** all P0 gates, rollback evidence and stage testing.

## Test gate
`npm test` and required CRM Chromium acceptance on the exact draft commit; source-backed fail/retry read-after-write using synthetic staging, including two sessions and mobile widths, remains mandatory. CI success alone is NOT a release approval.
