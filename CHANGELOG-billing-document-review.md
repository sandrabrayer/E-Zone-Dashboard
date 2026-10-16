# Read-only invoice-request review

October 16, 2026. Draft candidate based on `2a2f9b5`.

## Problem

The current queue records whether an invoice was requested, but does not record
issuance. Once a payment is verified, its request can be overlooked among older
verified receipts. A verified payment must not imply an issued document.

## Change

- Collapsed RTL request-review section within Billing Control, across all report
  periods, with independent house/request-kind filters and overall unknown count.
- Confirmed reports remain visible. Legacy/invalid choices stay unknown;
  every displayed issuance state says it is not recorded in this app.
- Existing queue only: no extra API call, write, permission change, money logic,
  export change, email change, attachment or Hashavshevet connection.
- Explicit stale/unavailable/malformed states, escaped output, and v71 cache
  update from verified live v70. The new static module is content-hashed and
  network-first under the existing asset contract.
- Source mapping and proposed completion contract in
  `docs/billing-document-evidence.md`. Evidence capture remains a separate step.

## Validation and release

Ten focused tests cover real read-only queue integration, confirmation and role
boundaries, privacy, legacy choices, filters, stale/malformed sources and escaping.
A synthetic Chromium scenario covers RTL at 360px/1280px, filters, confirmation
without disappearance, refresh failure and no write from viewing/filtering.
Full-suite/CI results are recorded in the PR. Audit: no high/critical issues;
one existing moderate, dependencies unchanged. No merge or deployment in this
candidate. Apps Script and the active reminder schedule are unchanged.
