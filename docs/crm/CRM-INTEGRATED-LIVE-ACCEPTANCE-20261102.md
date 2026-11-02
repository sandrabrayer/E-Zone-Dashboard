# CRM-INT-01 — One integrated, non-deployable CRM candidate against actual live head

**Date:** 2026-11-02. **User:** Sandra. **This branch is DRAFT-only.** No merging, deploying, production data repair, Apps Script modifications, permissions, price rules, automatic communications, or real customer writes are approved.

## Why this exists
The live Dashboard branch moved to `f7b5b0c378541b17d2bbf296d12deee55467df17` after independent, **already deployed** Claude PRs **#354 (discharge on billing anniversary), #355 (daily collection in new CRM), and #356 (exact-ID admitted-lead stale-save protection)**. Prior CRM DRAFTs #346 (identity/follow-up), #348 (funders, partial write), and #352 (no-show workflow) targeted a pre-#354 base; separate DRAFT #353 contains overlapping partial-discharge safeguards. Merging them independently would risk overwriting working CRM/billing and duplicating exception rows.

This branch is one **fresh candidate from the real deployed commit**, preserving the shipped #354–356 source and ALL existing domain ownership. It carries the reviewed `public/crm/crm.js` hunks of **#346 → #348 → #352**, with a manual conflict resolution for the live #355 `dueOnDate` exports and #356 `normalise` exact-`fromLead` admission guard. No live `public/app.js`, `apps-script/Code.gs`, `lib/cycle-balance.js` or fee/refund rules were replaced.

## Reconciliation of overlapping discharge changes
- Keep **ONE** source-derived exception for a discharge audit with an **exact** `patientId` and an authoritative Patients row that is not released: `ex:discharge-state:<auditId>`. Do not also create #353's `ex:discharge-sync:<auditId>`. Existing continuity/unverified-handoff work remains independent but should not create a duplicate row for the same incomplete discharge.
- Preserve #348's exact-ID `pendingDischargeAudit` guard: another new discharge action cannot be sent when a visible un-restored source audit already exists for this exact patient.
- Add #353's **stronger fail-closed duplicate response** semantics: the Apps Script source duplicate key is based on a house/name/entry-date tuple, not a verified global patient ID. A response `duplicate:true` is **NOT** a verified patient match and **MUST NOT** trigger a Patients status update.
- Record `auditConfirmed` only when the server returned the same **new audit ID**; after a timeout/failed second-stage write, show a **blocking uncertain-source UI** until an explicit authoritative refresh. This prevents the original browser-only optimistic rollback from being misconstrued as a source rollback.
- Carry #353's real-browser/synthetic source partial-write/second-role/duplicate-response tests, aligned to the **single** row ID and duplicate fail-closed behavior, plus #348's source-level finance/write tests. The independently authored #348 browser file could not be carried through the connector in this session; the reconciled #353 browser suite is the actual required browser evidence. Any omissions remain visible to the reviewer.

## Integrating business workflow
- Preserve #346's explicit intake identity decision and no name/phone auto-closing, source-unverified Outpatient referral work, updated task card destinations and available-source state semantics.
- Preserve #348's **admit-then-appendFunder** explicit partial-success warning and exact `submissionId` acknowledgement, with `getPayments` read refresh after verified write.
- Preserve #352's manager-source `no_show` → **call/reschedule** rather than pretending the meeting occurred. Unread report remains unread. Existing `logContact` and NextTask are reused (no task engine duplication), with source-backed save/reload browser regression.
- On the live baseline, the CRM already has #355's `לגבייה בתאריך` function `dueOnDate` and #356's `normalise` admission guard. The integration must retain both unchanged and run the new cross-release synthetic regression from **#357**.
- PWA `public/sw.js` moves **v112 → v113**, with explicit acknowledgement of live v110–v112 history and `test/crm-pwa.test.js` / `test/dashboard-perf-assets.test.js` updated. No existing cache version reused.

## Acceptance evidence and unresolved gates
**Synthetic/unit checks required on EXACT latest PR HEAD:**
- Full `npm test` / GitHub Tests; source-only new tests against identity, funder refusal, task/meeting outcomes, discharge source/read/duplicate response, day-of-exit billing and historical arrears.
- Real Chromium synthetic browser acceptance with mocked Apps Script `getData` and `saveAll`: Vered/Dana role handling and two-session reload, no-show call + next task, discharge audit committed but Patients save refused, `duplicate:true` cannot silently promote a possibly different patient, no in-app false "started Outpatient" state.
- Billing follow-up browser + Validate Workflows, if triggered. Preserve full test artifacts; if any suite red, **do not merge**.

**Blocking before any production deployment** even after green CI:
1. Signed-in, privacy-preserving staging journey: lead→call→visit→manager report→family decision→admission→funder→debt/credit→discharge→Outpatient, source read-after-write and second authorized user for each write. The 60-case checklist in docs-only #340 was **not** 60 successful UAT cases.
2. Durable retry/reconciliation on admission's first `saveAll` when the response is lost, and the cross-app Outpatient accepted/contacted/started acknowledgement. No new ledger or automatic retry has been authorized.
3. Authenticated role/server projection tests, including Dana without money, Ortal verification only, managers own-house, and identical Sandra/Ron executive read with distinct write permissions, as governed by ARCH-01.
4. OP-03 recovery/restore proof for Outpatient Tasks/Activity and existing Dashboard/finance backup. **No real production test writes**.
5. Specific ledger/financial discrepancies, refunds, credits, user-reported clinical records and billing-policy decisions remain with their responsible owners. Claude's already deployed #354–356 must not be reverted by this candidate.
6. Separate **explicit** Sandra authorization for any merger, deployment, permissions or source data change.

## Ownership & status
Dashboard stabilization master: [Issue #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339). Product/UX feature master: [Issue #350](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/350). Central E-ZONE One architecture: [Issue #331](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/331). Outpatient source stays [Outpatient #149](https://github.com/sandrabrayer/ezone-outpatient/issues/149); no overlapping Outpatient implementation. This integrated PR is the **single candidate for technical review, not release approval**.
