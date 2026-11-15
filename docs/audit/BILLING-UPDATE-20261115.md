# Independent Dashboard billing update acceptance — 15 November 2026

## Decision and scope

The ordinary paths of #391/#392 work in the isolated acceptance suite, but the update is NOT fully accepted: four current UI/workflow defects were independently reproduced. No production payment was reported, verified, edited or discounted. This branch contains only audit tests/documentation, NOT runtime repairs or a release candidate.

Baseline: deployed branch `claude/build-ezone-dashboard-QOg5s`, commit `f03a3b7bd38550521edf96f0d6948256ac8b159c`, merged #391/#392. Read-only Railway verification: project `af74cb91-0ea9-4d1f-918e-2c98055a58f2`, service `dfb23ce1-a6d0-4249-b5c4-7ab2c4c45152`, production environment `ffe4a1b3-e2c0-4da0-af55-70211edc4f62`. The service owns `ezone-dashboard.up.railway.app`; deployment `2773905b-d148-486d-8563-3adecd11d2bb` reports SUCCESS at the exact baseline. Public live GETs were inaccessible to this environment, so no live-browser timing or personal-account acceptance is claimed.

## Exact executed evidence

Audit test-code head: **d458e4fd46b813a9d054f48b216f4169f29f1e3d**, draft PR **#393**.
- Full Node Tests **43703271203**, job **132778815563**: SUCCESS, independently checked.
- CRM synthetic browser acceptance **43703271271**, Chromium job **132778815827**: SUCCESS. Its artifact **14156934926**, `crm-e2e-browser-85afd3601e7dc19d9002ccc84377f448bce80d41`, was downloaded and its `browser.tap` inspected: **87 tests, 87 pass, 0 fail, 0 skipped**. This workflow includes browser and supporting acceptance tests; do not describe all 87 as independent browser journeys.
- Artifact SHA-256: `d0691e255436e8b5438e4a42145461b57eb6c6d062e870d60adf96893f63bdce`. PR combined tree `85afd3601e7dc19d9002ccc84377f448bce80d41` uses the pinned production base and the audit head.
- Browser cases 73–77 are the five NEW probes: four GAP reproductions and one role-enforcement control. GAP assertions deliberately prove CURRENT wrong behavior; green does NOT mean the defect is fixed.
- Original `crm-shell-browser.test.js` was preserved byte-for-byte as `crm-shell-browser.billing-audit-baseline`, blob `0c93df5574853da7831cddb03e87cfc4e70f7a11`. A test-only loader appends probes to the existing workflow; no original assertions, workflow or production code were changed.

The browser uses the actual CRM and Node server with synthetic Google replies. It proves browser/server behavior under controlled replies, NOT full Apps Script persistence, bank reconciliation, real user credentials or correctness of every live financial record. No new paid agent, TinyFish or extra subscription was used for the Dashboard audit.

## What passed

- Receipt verification in receipts, Ortal's Today and patient account: amber pending, spinner during request, exact receipt-specific source acknowledgement, green only after proof. Explicit refusal/missing proof does not falsely turn the row green. A confirmed receipt leaves the waiting list and normal debt overlay.
- Full/partial/discount selection and lower-than-balance validation; discount reason required; the report is posted before its separate discount, and discount failure does not erase the saved-payment warning. Existing browser tests retain these flows.
- Actual pure-model totals agree across collection list and patient account: charge 5,000 / full reported 5,000 => 5,000 pending before verification, 0 afterwards; partial reported 2,000 => 5,000 total pending/open before verification, 3,000 afterwards; 4,000 payment + 1,000 discount => 4,000 pending before verification, 0 afterwards. These are synthetic inputs, not new financial writes.
- Name search while typing, debts/receipts/people results, caret retention and ordinary account navigation. Refund rows have the exception below.
- Ortal reads account cycles, receipts and funder. The actual Node server refused her reportPayment, setBillingDiscount, editReceipt and savePayment attempts with HTTP403 before the synthetic source. Vered's confirmPayment was also HTTP403. This is not merely hidden UI buttons.
- Normal successful post-save refresh keeps the account on screen and reloads debt/payments rather than all four sources. Desktop/mobile and role-switching baseline journeys remain intact.

## Four reproduced defects

### BILL-AUDIT-01 / P1 — an old read can resurrect an already verified receipt

Browser test 73. On Sandra's synthetic account, a successful report triggers two refresh reads. The test captures both old responses BEFORE verification and delays their arrival. The existing receipt is then successfully verified, with one confirmPayment POST and a green source-proven result. Releasing the older refresh responses makes the same receipt pending again and restores its Verify button.

Cause: `verifyReceipt` patches current payment/queue state but does not advance/coordinate `billingGen` with in-flight `loadBilling` reads. The older result replaces the newer verification evidence.

This proves a misleading UI rollback, not reversal of the stored bank-verification decision. Required repair: invalidate/supersede older reads or merge proof at a monotonic revision; source readback after verification must not allow old state to win. Reproduce from patient account and Today/receipts, with concurrent refresh and reversed response order. Do not issue a second verification POST to repair the display.

### BILL-AUDIT-02 / P1 — accepted save plus failed reload leaves old actionable data without warning

Browser test 74. The payment-report reply is accepted; both subsequent debt/payments reads are aborted. The account remains visible, but the refresh indicator disappears, there is no stale/readback warning, and old report-payment buttons remain enabled.

Cause: `loadBilling` catches the failed refresh and returns `prev` without marking that it is stale. This defeats the truthful-state requirement even though the no-blank-screen performance goal works.

Required repair: retain accepted-write evidence, visibly mark source state unknown/stale, provide a READ-only retry and guard relevant stale mutations. Do not say the payment failed or invite a new payment with a new submission ID. A successful later refresh must clear the warning only after authoritative readback.

### BILL-AUDIT-03 / P1 — unavailable receipts can become 'no open debts'

Actual model and browser test 75. The debt engine still nets reported payments. When debtAging is valid but getPayments is unavailable, `collectionDebtors` takes its `ok` solely from debtAging and adds no pending money. The model changes a known pending 5,000 balance to `{ok:true,total:0}` for missing/failed/malformed payment data. The real debts section displays 'אין חובות' with the failed receipt source.

Required repair: the verification-dependent total/list/search/account cannot be certified without valid receipt data. Show unavailable/partial data, not an authoritative zero or debt-free patient. Preserve separately proven amounts with clear scope, but do not make pending money disappear. Cover first load, refresh, malformed success envelopes and subsequent recovery.

### BILL-AUDIT-04 / P2 — refund search rows do not open the patient's account

Browser test 77. Search returns a refund row; the row has no stable-patient navigation target and clicking its name does not open the account, unlike debt/person results. The release note's blanket account-navigation claim is therefore incomplete.

Required repair: pass a verified stable patient identity through the refund view and navigation. Where unavailable, expose a truthful section/detail action instead. Never resolve by name alone to satisfy the click.

## Additional discrepancies, not unproven live-data allegations

1. **Two debt definitions remain, even inside the overview.** The documented CRM-only overlay does not change the Apps Script engine. Classic screens, exports, due-date collection, forecast, historical cleanup AND the overview aging buckets retain reported-payment netting. This last exception is omitted from the supplied user note. Label/reconcile the overview so its total and age buckets do not appear to be the same population. No engine-policy migration is authorized by this audit.
2. **'Ortal read only' needs qualification.** Source review shows the existing `accountant` role may invoke `upsertBillingOverride` and CRM `renderAccount` displays the amount-change action when `me.canAmount` is true. Her maximum user model includes accountant, but her LIVE role record may narrow it and was NOT read. Report/discount/receipt-edit prohibitions are proven; do not assert that all amounts are universally read-only or remove pre-existing permissions without a product decision.
3. **The generic 'החוב נסגר' toast overstates partial verification.** A verified partial payment correctly leaves the unpaid remainder. Wording should distinguish the verified amount from closure of the entire account/cycle.
4. Model-only inconsistent partial-confirmation/overpayment inputs were observed. Their reachability through actual source validation was not established, so they are NOT counted among the four confirmed workflow defects and are not claims about live records.

## Next work order / handoff

Repair BILL-AUDIT-01/02/03 together as one coherent read/verification-state change on a reviewed draft, preserving current working paths and server permissions. Convert the four GAP characterizations to desired-behavior regression assertions; do not retain a green test that expects wrong behavior as a fix. Then add identity-safe refund navigation and clarify the debt/role/toast wording. Keep the original test-only audit branch unmerged; no runtime change, live receipt mutation or deployment occurred in this review.

Therapists work is separately checkpointed in its #129/#156; do not mix its code or PR numbers with Dashboard #393. This documentation update follows the tested audit commit and does not change runtime or test code. No independent background work is implied.
