# CRM-E2E-01 — Partial commit / ambiguous write release gate (02.11.2026)

**Status: code-confirmed risk + exact synthetic acceptance plan, NOT an executed test and NOT a code fix.**
Scope: Dashboard draft [#346](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/346), reviewed at exact SHA `248362bc188600bc1adf9b83fff125493ca799ba`. Tracks existing [CRM-E2E-01 #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339), within [60-scenario audit #340](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/340). Uses synthetic IDs only. No production accounts, HTTP calls or patient data.

## Source evidence, not an assumption of a live incident

1. `public/crm/crm.js` near `saveFunderBestEffort` (about lines 1903–1954): `admitLead` and `directAdd` call `postAction(saveAll ...)` and **then** `appendFunder`. On error/refusal/null response from the second write, `saveFunderBestEffort` displays a transient failure toast, but resolves without error; the outer `.then(() => true)` reports admission success. The patient has been saved while payer/funder registration may be incomplete. There is no persistent follow-up or proof of repair in this path.
2. `public/crm/crm.js` near `dischargePatient` (about lines 2036–2075): first `POST action=dischargePatient` stores a discharge audit entry and may create an automatic rule-based credit/refund. Second `POST action=saveAll` changes the Patients house status. On an error after step one, the generic `catch` restores **the former browser row** `loc.arr[loc.idx]=before`, despite the possibility that the authoritative discharge audit/credit has already committed. A new attempt creates a new `randomId()` audit ID. **Duplicate finance effects are a risk to test, not a confirmed event**; actual source deduplication must be read and tested independently.
3. If steps one and two succeed but `POST /api/outpatient-lead` fails, the code displays a failed-send warning yet the overall discharge returns true. This must remain classified as **discharged, handoff pending**, not verified Outpatient treatment start. The existing #346 read-only persistent `houseExceptions` row is useful but does not prove receipt by Outpatient.
4. The reusable generic `postAction` pessimistically undoes a local optimistic change on any thrown/failed response; when an upstream timeout happens **after** commit, it cannot infer the authoritative state. Existing `proven` save IDs help successful responses but do not resolve ambiguous ones. Do not automatically retry uncertain writes with a fresh key.

## Precise synthetic test matrix / acceptance evidence (not yet run)

| Test | Injected failure and initial state | Required observable result for release |
|---|---|---|
| PW-01 | `saveAll` returns a valid authoritative `proven` patient/lead; `appendFunder` returns `{ok:false}` | Patient exists; **funder pending** survives browser restart and is visible to the owning staff user; no "fully complete" classification |
| PW-02 | `saveAll` succeeded; `appendFunder` network times out **before** source write | Keep stable patient ID, original submission/operation ID, outstanding reconciliation; one approved retry only after status read |
| PW-03 | `appendFunder` source committed, response lost | Reconcile by stable funder submission ID; retry cannot append second funder or incorrectly advance effectiveFrom |
| PW-04 | `dischargePatient` source confirms audit/credit, `saveAll` returns `{ok:false}` | UI must not imply "no discharge happened"; durable **partial discharge** status with audit ID/patient ID; authorized recovery of Patients status, no second credit |
| PW-05 | `dischargePatient` source commits but its response is lost before step two | Re-read authoritative discharge ledger by operation ID before retry; no new discharge ID/credit by blind click |
| PW-06 | `saveAll` Patients status committed, response times out | Re-read Patients + discharge audit before rollback/retry; no duplicate discharge or refund |
| PW-07 | Both discharge stages succeed, Outpatient handoff returns 5xx/unknown | Residential discharge remains complete, **handoff open**, Vered's follow-up survives 14+ days, no false "treatment started" |
| PW-08 | Handoff send accepted but destination acknowledgment is delayed/unavailable | `sent ≠ accepted ≠ actual treatment_started`; original obligation remains pending; no third writable task store |
| PW-09 | Two browser tabs attempt the same admission/discharge | At most one authoritative stay/discharge; conflict detected and surfaced; source-owned operation key survives reread |
| PW-10 | Sandra/Vered authorized, Dana unauthorized for funder/money; retry as alternate user | No unauthorized read/write/exception state leakage; approval/execution remain in proper roles |
| PW-11 | Source 503/non-JSON/stale cache during reconciliation | Display explicit `unknown/pending verification`, not successful/failed/zero by inference; local controls avoid blind retry |
| PW-12 | Reload, second authorized user, mobile 390px | Same outstanding operation and recovery action visible in source-backed queue and account; no toast-only state |

Each test must collect: exact deployment/branch SHA, tested route and principal, synthetic request ID, authoritative source record IDs, response/loss stage, browser reload, second role read, downstream ack, audit/refund count, timestamp, and outcome. Green CI on #346 does **not** cover these injected two-step failures by itself.

## Minimum remediation contract (to avoid architecture drift)

- Do not create an independent CRM task engine or shadow financial ledger; use the existing Dashboard Tasks/Activity or a source-owned **reconciliation state** tied to exact operation IDs and business records.
- Persist the workflow's `operationId` (and, where relevant, `submissionId`, `dischargeId`) **before** possible irreversible actions. Reuse the exact key for a verified retry. If write outcome is unknown, **read status and stop**, not auto-retry/auto-rollback.
- Treat the business record, financial credit, payer registration and outbound handoff as individually acknowledged phases. The UI shows `completed` only for the phase actually verified; partial state must survive refresh.
- Run negative role tests (Dana without finance, Ortal verifier only, Sandra exception approver); do not extend permissions as a quick fix.
- Before release, inspect the actual authoritative Apps Script actions for idempotency and recovery; ensure OP-03 / Dashboard restore evidence covers new reconciliation fields, if any.
- For this gate do **not** alter Outpatient #142–148, cross-app ID PRs, or deployed Apps Script silently. Any implementation should be one small, separately reviewed Dashboard draft patch; no existing release candidate is approved automatically.

## Ownership / release decision

**Priority P0 release blocker**, not a claim that a data corruption incident has occurred. ChatGPT owns review/test specification. A narrowly scoped implementation may be assigned to Claude only after overlap review, with exact failed-case tests and an isolated draft PR. Sandra separately authorizes any merge, deploy, new production state, source data change or money/permission change.
