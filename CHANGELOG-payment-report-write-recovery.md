# Payment report recovery after an interrupted Sheets write

Prepared October 15, 2026 from Dashboard `5bec39633350d19c158d8bae0ab1ed238e19b060`.
Draft change only; no production data was inspected or changed for this work.

## Failure and resulting behavior

`reportPayment_` previously saved the cycle's new total before appending the
receipt. If the first receipt append failed, the cycle retained money with no
receipt. Retrying the same submission treated that money as a legacy payment
and added the report again: a synthetic 10,000 cycle with one 6,000 report became
12,000 paid, with only one 6,000 receipt. A script lock does not make multiple
Sheets writes atomic.

The write now proceeds under the existing lock:

1. For a first receipt, persist the cycle identity and its OLD money/legacy
   baseline. Already receipt-backed cycles do not need this preparation write.
2. Append the receipt, including its existing submission ID.
3. Materialize the cycle total derived from the durable receipts.

If the receipt committed but its acknowledgement or the summary write failed,
reads derive the correct total from that receipt. Retrying the same submission
repairs a stale stored summary without appending another receipt. A settled
replay performs no Payments write. Successful summary recovery records
`payment_report_recovered` through the existing audit helper.

No changes to UI, columns, permission gates, receipt verification, environment
variables, deployment configuration or dependencies. The first receipt requires
one additional cycle write; production latency has not been measured.

## Validation

`test/payment-report-write-recovery.test.js` executes the real Apps Script in
the existing mocked Sheets harness with synthetic fixtures. Its 11 cases cover
failures before and after receipt append for new, unpaid, legacy-paid and
receipt-backed cycles; failures before/after the derived summary write; repeated
append failures; stable cycle identity; and a write-free settled replay.

- Negative control on the original implementation: 6 failures, 5 passes.
- All 11 regression cases pass with the change.
- Focused recovery, persistence, report-form and money-write tests: 79 passed.
- Full suite: `npm test -- --test-concurrency=1 --test-reporter=tap`:
  2,760 passed, 0 failed, 65 skipped (Chromium unavailable), 2,825 total.
- `npm audit`: 0 high/critical; 1 existing moderate `qs` dependency finding.
  Dependencies are unchanged. This is not a clean-audit claim.

## Limits and rollout

These are fault-injection tests, not evidence that live customer data suffered
this failure. No live writes or browser checks were performed. Keep the PR a
draft; merging would automatically deploy Apps Script and requires separate
authorization under the current work plan.

The current report UI supplies the submission ID. Legacy callers without a key
do not gain a same-submission replay guarantee. No historical balances are
rewritten: identifying and correcting already affected rows needs a separate,
reviewed reconciliation. AuditLog remains best effort, not transactional with
Payments; a lost acknowledgement immediately after receipt persistence can
leave the original `payment_reported` event absent. Recovery does not promise an
atomic multi-sheet transaction.
