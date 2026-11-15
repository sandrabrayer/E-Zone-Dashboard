# Billing read integrity — Stage 1 (verification vs. in-flight reads)

- `public/crm/crm.js`: new `obsoleteBillingReadAfterProof()`, called from BOTH `verifyReceipt` (full) and `savePartial` after the exact receipt-specific source acknowledgement passed, before the local patch. If a billing read (`debtAging`/`getPayments`…) is in flight it began before the confirmation: the generation advances, so the existing `loadBilling` mismatch path discards it and fetches fresh. Nothing in flight = no extra GET.
- Refused/unknown/missing proof never advances the generation. No permanent overlay; later genuine source changes stay visible. Full/partial arithmetic unchanged. SW139 kept.
- Tests: `test/partial-verify-checkpoint.test.js` (helper run from actual source in vm + source-order checks). NOT a browser test.
- NOT in this stage (still pending): stale/unknown marking after failed readback, missing-source ≠ zero, Chromium probes.

## Stage 2A (incomplete checkpoint — loader only)

- `loadBilling`: new strict `billingSourcesValid` (debt `ok`+`byPatient[]`, payments `ok`+`receipts[]`+`payments[]`; healthy empty arrays valid). An invalid/failed REQUIRED bundle keeps the previous bundle and sets `state.billingStale=true` (only after the generation check, so an obsolete failure cannot mark newer state stale); a valid read clears it. While stale the next `loadBilling` forces debtAging/getPayments GETs (no cache/boot reuse). Optional credits/refunds failures are caught individually and are not required failures. No auto-retry.
- Tests: `test/billing-read-integrity.test.js` (loader extracted from actual source, vm, stubbed `api`). Not browser, not run against Chromium.
- NOT done yet: stale warning UI, finance-action guards, missing-source ≠ zero rendering.
