# Partial receipt verification — narrow checkpoint (#395)

Base: `claude/build-ezone-dashboard-QOg5s` @ `a6e597d` (#394). Draft only; no merge/deploy.

## Done
- «אימות חלקי» beside «אמת» in «תקבולים» (same `canVerifyReceipt` guard: Ortal/Sandra). Inline form shows reported / verified-so-far, previews verified and remaining; no payment or discount inputs.
- Wire: existing `{action:'confirmPayment',confirm:{ids:[receiptId],status:'partial',confirmedAmount}}` — one receipt, `0 < amount < reported`, ≤2 decimals, amount is the TOTAL verified so far. Server guards unchanged.
- The UI updates only on `ok===true` AND the exact receipt, `partial` status AND exact `confirmedAmount`. Anything else leaves state unchanged.
- Full «אמת» after partial sets `confirmedAmount` to the receipt amount. Full toast no longer says the whole debt closed; partial toast states verified amount and the rest still open.
- #394 mismatch hint: now «potential period mismatch» — do not report again, do not discount to hide it, reconcile existing receipt and coverage. No reassignment action.
- Service worker v138 → v139.

## NOT fixed (open in #395 / #393)
Late-read-vs-verification race, failed-readback stale state, receipt-source missing shown as zero, refund-navigation, historical payment reallocation, classic/exports/forecast/aging still using reported money (source policy). This is not a claim that billing is stable.

## Evidence
`node --test test/partial-verify-checkpoint.test.js` plus the directly changed suites. Full suite/Chromium: left to CI.

## Surgical correction
- `applyVerified` now also sets `verifiedAmount` (full receipt amount) and `openAmount` (0) when those derived fields are present, so `BillingControlRules.verifiedAmountOf` no longer trusts a stale partial value after a partial → full verification. Receipts without them keep their shape. Replace, never add.
- `partialVerifyBody` / `partialAccepted`: finite, positive, ≤2-decimal amounts only; exact equality, no rounding-based acknowledgement.
- `savePartial` failure/malformed acknowledgement now says the verification result is UNKNOWN (refresh and check; do not report a new payment). No automatic retry.
- Tests: unit regressions in `test/partial-verify-checkpoint.test.js`; one real-click browser test in `test/crm-shell-browser.test.js` (synthetic fixture, not real GAS/bank UAT). Chromium was not installed in this worker, so the browser test was NOT run here — CI executes it.
- #393 (late-read overwrite, silent readback, missing-source false zero, refund navigation) remains open.
