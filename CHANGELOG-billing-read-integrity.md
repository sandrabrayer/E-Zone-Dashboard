# Billing read integrity — Stage 1 (verification vs. in-flight reads)

- `public/crm/crm.js`: new `obsoleteBillingReadAfterProof()`, called from BOTH `verifyReceipt` (full) and `savePartial` after the exact receipt-specific source acknowledgement passed, before the local patch. If a billing read (`debtAging`/`getPayments`…) is in flight it began before the confirmation: the generation advances, so the existing `loadBilling` mismatch path discards it and fetches fresh. Nothing in flight = no extra GET.
- Refused/unknown/missing proof never advances the generation. No permanent overlay; later genuine source changes stay visible. Full/partial arithmetic unchanged. SW139 kept.
- Tests: `test/partial-verify-checkpoint.test.js` (helper run from actual source in vm + source-order checks). NOT a browser test.
- NOT in this stage (still pending): stale/unknown marking after failed readback, missing-source ≠ zero, Chromium probes.

## Stage 2A (incomplete checkpoint — loader only)

- `loadBilling`: new strict `billingSourcesValid` (debt `ok`+`byPatient[]`, payments `ok`+`receipts[]`+`payments[]`; healthy empty arrays valid). An invalid/failed REQUIRED bundle keeps the previous bundle and sets `state.billingStale=true` (only after the generation check, so an obsolete failure cannot mark newer state stale); a valid read clears it. While stale the next `loadBilling` forces debtAging/getPayments GETs (no cache/boot reuse). Optional credits/refunds failures are caught individually and are not required failures. No auto-retry.
- Tests: `test/billing-read-integrity.test.js` (loader extracted from actual source, vm, stubbed `api`). Not browser, not run against Chromium.
- NOT done yet: stale warning UI, finance-action guards, missing-source ≠ zero rendering.

## Stage 2B — consume the stale flag (finance quarantine)
- While `state.billingStale`, `renderBilling` and `renderAccount` show one warning panel (`data-billing-stale`, button `data-billing-read-retry`) instead of balances, debt-free text or finance controls. Page shell, patient drawer and navigation stay open. No write is claimed as failed or succeeded.
- Retry runs `loadBilling` (forced debt/payments GETs) and repaints the open account; it never POSTs. A failed refresh repaints an open account even with no waiters.
- `requireFreshBilling()` guards the entry of full/partial verify, report, discount/amount (small), link, cleanup, credit, refund action and receipt edit — open forms and Today actions are blocked too.
- Tests: vm helper + source-wiring tests in `test/billing-read-integrity.test.js` (not browser). Pending: missing-source-is-not-zero (Stage 3) and integrated Chromium tests. SW139 unchanged.

## Stage 3 (partial) — unknown source is not zero
- `collectionDebtors` now returns `ok:false` and `total:null` unless `debt.ok===true` with `byPatient[]` and `payments.ok===true` with `receipts[]`. Healthy empty arrays remain a valid 0; valid-source arithmetic unchanged. The Debts list already renders its "not loaded" panel on `ok:false`.
- Reviewer-authored `test/billing-read-integrity-browser.cjs` wired at the end of `test/crm-shell-browser.test.js` (unmodified).
- Tests: `test/billing-unknown-source.test.js` (actual helper). Chromium probes not run in the worker; CI runs them.
- NOT done: explicit availability flags in `patientAccount` / `billingOverview`, search debt-free classification from unknown sources, Today stale-total hiding after `billingStale` (Today card already shows partial when payments are unavailable).
