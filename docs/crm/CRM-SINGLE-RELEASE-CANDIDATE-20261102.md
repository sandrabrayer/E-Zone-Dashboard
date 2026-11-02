# CRM residential — one release candidate (02 Nov 2026)

**Owner:** E-ZONE One / Sandra. **State:** GitHub DRAFT only; not merged, not deployed and not business-accepted. Exact deployed baseline for this branch: `f7b5b0c378541b17d2bbf296d12deee55467df17`, with merged fixes #354, #355, #356 already present. This release candidate is a *replacement integration path*, NOT authorization to merge its source PRs separately.

## Scope and provenance (one target)

| Included | Source, without a separate implementation |
|---|---|
| Safe intake: shared names/phone do not auto-admit another person; independent case requires positive confirmation | reviewed DRAFT #346 |
| My Day: future visits, known vs unknown contact/payments, receiving/source filters, side actions and continuation never closed by `sent` | reviewed DRAFT #346 |
| Admission `saveAll → appendFunder`: exact submissionId acknowledgement, delayed completion/partial-save warning, finance reread | reviewed DRAFT #348 |
| Discharge audit → Patients save → Outpatient send: source reread on ambiguity and precise partial-phase status | reviewed DRAFT #348 |
| Single source-derived mismatch `ex:discharge-state:<auditId>`, not the duplicate alternate `ex:discharge-sync:<auditId>` | reviewed DRAFT #348, preserve single-row principle |
| Additional safety: source `duplicate:true` does NOT attest exact patientId (legacy stay-key uses house/name/date) and **cannot** promote Patients status | unique safeguard from reviewed DRAFT #353 |
| Manager `no_show` source report stays separate from actual meeting outcome; Vered gets real contact/reschedule follow-up, not a phantom meeting | reviewed DRAFT #352 |
| Cross-release admission/exit-day/debt synthetic guard | reviewed DRAFT #357 |

Existing baseline effects from #354–356 must remain: billing exit day is not a new cycle; current CRM date-based collection and classic display agree; admitted lead cannot be reopened by stale old data, with exact Patients.fromLead protection. The integration patches `public/crm/crm.js` only for runtime, on top of that baseline: **no change to backend Apps Script, package billing source, salary, accounts, service workers, secrets, authentication or permissions is in scope**.

## Tests and single review flow

- Exact-head normal suite, synthetic Chromium/Express acceptance suite (with mocked Google; zero real data), Billing follow-up Chromium, Validate Workflows.
- Source-specific tests kept from each reviewed candidate, plus a new synthetic **duplicate backend response / wrong patient update** scenario and the #357 cross-release test.
- A **green CI is not production E2E**. Before release, walk through with Vered/Dana/Ortal with *approved synthetic staging* data: a new lead → contact → visit/report and no-show → admission with funder → payment due/receipt → discharge → persistent continuation → outpatient receipt/ack; read-after-write, second user, 390/1024 desktop/mobile, connection failure and no duplicate on retry. Vered must be able to open every urgent card.
- Where a server commit is unknown, no fresh ID/retry; identify authoritative source entry and allow manual reconciliation. Do not mistake `sent` for `treatment_started`. Never present unavailable source as zero.
- STOP: no production change, data repair, merge, deploy or permissions changes without explicit Sandra approval and rollback evidence.

## Known hold boundaries — defer unrelated features

1. **Funder durable reconciliation after a lost response:** this candidate prevents false “complete” but does not install a persistent source-owned recovery outbox. Audit/patient/funder records require read/reconciliation without blind repeated write; finish as a *single* independently reviewed P0 small patch if synthetic acceptance reproduces a data-loss scenario.
2. **Outpatient status return and stable IDs:** #137/#138/#145 and Dashboard #329/#330 remain separate drafts; not covered by this residential-only candidate. Resident discharge stays safe while read-only continuation remains pending.
3. **Outpatient OP-03 native restore:** distinct approval/recovery gate; do not hold Dashboard *code review* for Outpatient feature work, but do hold any cross-app rollout that depends on it.
4. **P1 onward:** further color/layout/analytics/management dashboard/new engines are out of this release. No new PR per cosmetic defect.

**One owner / one decision:** this candidate replaces parallel #346/#348/#352/#353 for acceptance. Parent PRs remain review/evidence only, not independent releases. The merged code must be verified on the exact candidate SHA; any further correction is made **here**.
