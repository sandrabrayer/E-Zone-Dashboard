# Billing read integrity — Stage 1 (verification vs. in-flight reads)

- `public/crm/crm.js`: new `obsoleteBillingReadAfterProof()`, called from BOTH `verifyReceipt` (full) and `savePartial` after the exact receipt-specific source acknowledgement passed, before the local patch. If a billing read (`debtAging`/`getPayments`…) is in flight it began before the confirmation: the generation advances, so the existing `loadBilling` mismatch path discards it and fetches fresh. Nothing in flight = no extra GET.
- Refused/unknown/missing proof never advances the generation. No permanent overlay; later genuine source changes stay visible. Full/partial arithmetic unchanged. SW139 kept.
- Tests: `test/partial-verify-checkpoint.test.js` (helper run from actual source in vm + source-order checks). NOT a browser test.
- NOT in this stage (still pending): stale/unknown marking after failed readback, missing-source ≠ zero, Chromium probes.
