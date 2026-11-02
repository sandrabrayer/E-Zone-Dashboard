# CRM-E2E — Partial discharge client/read-model guard (DRAFT, 2026-11-02)

**Not a production fix or approval.** A small **stacked draft** on Dashboard integrated CRM-E2E candidate #346, exact base SHA `248362bc188600bc1adf9b83fff125493ca799ba`. See [PW-01–PW-12 test contract](https://github.com/sandrabrayer/E-Zone-Dashboard/blob/codex/crm-e2e-acceptance-audit-20261101/docs/crm/CRM-E2E-PARTIAL-COMMIT-ACCEPTANCE-20261102.md). No Apps Script, source schema, payment calculation, permissions, live data or deployment modified.

## Actual patch, not only a specification

- A **read-only source-derived** `discharge_sync` exception appears under `היום שלי → מה דחוף בבתים` when a non-restored discharge audit contains a verified exact `patientId`, but that exact Patients record remains `active/trial/wait`. A former audit with no exact ID or an ambiguous record match cannot be automatically linked by name/phone.
- Opening the matching patient card remains possible. The exceptional row retains the **audit ID** and the original owner; it does not issue another discharge, credit, task or cross-app handoff. It disappears after authoritative Patients state is `released`, irrespective of whether the separate continuation follow-up is finished.
- The discharge UI checks for an already-known exact matching audit and **blocks a fresh discharge request** if the Patients status remains non-released. This is a defensive client check, NOT authoritative server-side deduplication.
- When discharge audit/Patients save returns an error, the client now shows a **blocking status requiring reload and reconciliation**; if audit already confirmed, it says the discharge was registered but patient status unverified; otherwise it explicitly says write outcome unknown. This avoids telling the operator all steps failed, and avoids encouraging blind retries with fresh IDs.
- New synthetic tests `test/crm-partial-discharge-guard.test.js` cover exact vs fuzzy identity, still-active vs released, restored/soft-deleted, independent continuation, source guards.

## Known remaining P0 blockers (do not merge solely based on this patch)

1. **Back-end side effects**: `dischargePatient` may create a rule-based credit. This PR does not establish server-side exactly-once behavior under lost responses. The server must read/prove the audit and credit operation before any re-execution; duplicate/unknown outcome is a safety hold. Test PW-04–PW-06 with synthetic Apps Script and native restore.
2. **The funder multi-write flow** `saveAll → appendFunder` still has a transient warning only. PW-01–PW-03 require durable source-owned reconciliation, original submission ID reuse and role-safe manual resolution. No new task engine or ledger may be added.
3. **Cross-app continuation**: `sent` does not prove `accepted` or `treatment_started`; Outpatient status #145 and exact IDs #137/#138/#329/#330 are still drafts. Existing #346 derived continuation warning remains.
4. **Legacy discharge rows** without `patientId`, unresolvable ID, or missing Patients record are not auto-flagged. Manual source audit required; do not infer identity by phone/name.
5. **No confirmed live UAT or CI yet on this branch** until check results on exact new head; release also requires current deployment SHA/SW, staging read-after-write, server-side permission negatives and verified backup/rollback.

## Explicit acceptance
- Test a confirmed audit plus failed Patients save: no misleading successful completion, the *next* loaded model contains `ex:discharge-sync:D1`, no second audit POST is allowed from that source-visible state, second user sees the same exception.
- Test first-stage response loss: no automatic repeat; reload and inspect original audit/financial side effects.
- Test successful discharge and failed Outpatient send: completed residential discharge with a **separate** pending continuation obligation, not a false source reversal.
- Test normal happy path: exactly one audit, released Patients row, no `discharge_sync`; unresolved continuation may remain independently.
- Test Vered/Dana authorization and protect against finance fields in operations responses. A UI warning is not a substitute for server-side permissions.

**Release policy:** Do not merge/auto-merge/deploy this or base #346 without Sandra's separate explicit approval. This is a narrow mitigation; it is **not** the complete durable workflow recovery requested by E-ZONE One.
