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
