# FIN-01.2 — Read-only billing follow-up queue

October 15, 2026. Review candidate; not deployed.

## Problem and behavior

The existing receipt lists show reported, partial and flagged receipts, but do
not provide one chronological work list alongside every open billing cycle.
The over-60-day exception list also omits younger collection work.

The new «להמשך טיפול» section in «בקרת גבייה» shows original dates, calendar
age, responsible person, next action and a link to the existing source view.
It supports house and owner filters, oldest first. Missing dates stay unknown.
Receipt age uses the Israel calendar day of the original recordedAt stamp;
flagging never restarts it. Collection age starts at the original due date.

- Reported and partial receipts: Ortal checks the bank and the verification gap.
- Flagged receipts and open cycles: Vered investigates collection/reporting.
- Institutional cycles inside the existing 30-day grace period: neutral waiting
  state, followed by Ortal. Day 31 resumes ordinary collection work.
- Ortal remains responsible for overall monitoring. The list creates no stored
  assignments, task records, notifications, bank imports or new write actions.

For a 10,000 bill, 6,000 reported and 4,000 verified, the list displays **4,000
collection remainder** and **2,000 verification gap** as separate work items.
There is deliberately no summed total. Fully verifying the 6,000 removes only
the receipt item; the 4,000 collection remainder stays.

## Implementation and safety

`billingControlQueue` projects existing `debtAging_` results and the already-read
cycle due dates. There is no second debt engine, extra sheet read or change to
balances, funder history, pro-bono exclusions, cutoff rules or permissions.
The new cycle projection excludes patient keys, UIDs and clinical details.
The browser recomputes receipt work from current confirmation echoes. Voiding a
duplicate invalidates cycle context and uses the existing guarded queue refresh.
A missing/failed aging result or an older server response is visibly incomplete,
never an empty-success claim. A failed refresh labels retained data as stale.

Source actions only focus an existing receipt or open the existing debt report;
the latter opens the report, not an exact patient row. All variable HTML is
escaped. Filters wrap and controls have a minimum 44px height.

The worker cache moves from v63 (read from production /sw.js on October 15) to
v64. The corresponding version assertion and transition comment are updated.
Recheck the live cache version before eventual deployment if it has moved.

## Verification and release boundary

- 15 synthetic endpoint, rule and interaction tests in
  `test/billing-followup.test.js` cover the example, no-payment cycles, day 30/31,
  pro-bono/future exclusions, failures, missing dates, Israel midnight, voids,
  XSS escaping, filters/navigation, receipt echoes and unchanged authorization.
- Full local suite on deployed base `0d9790a`: **2,793 passed, 0 failed, 66 browser
  tests skipped** (2,859 total, including the new browser case).
  `git diff --check` and JavaScript syntax checks passed.
- `npm audit`: 0 high/critical; 1 existing moderate `qs` finding. No dependency
  or lockfile changes.
- Local browser execution was blocked by socket restrictions. An escalated
  launch was rejected by the approval policy. A dedicated PR-only GitHub Actions
  check now runs the actual server, UI and Apps Script sandbox in Chromium with
  synthetic data, captures 360px/desktop screenshots and retains them for seven
  days. Playwright 1.62.1 is isolated under the runner's temporary directory;
  production dependencies, deployment workflows and secrets are unchanged.
  The check exercises filters, navigation, partial-confirmation echoes, neutral
  funder grace, role boundaries, page errors and horizontal overflow. No live
  patient data is used.
- The first Chromium run passed all three cases, but screenshot review exposed
  a light waiting-row background under dark-theme text and a long confirmed
  partial-payment month line overflowing to the left at 360px. Use a neutral
  dark waiting background and wrap confirmed amount details. Browser assertions
  now require 4.5:1 contrast for every waiting-row text role and check visible
  card/text bounds on both sides, including RTL overflow missed by scrollWidth.
  Corrected screenshots at 360px and 1280px were reviewed: waiting text and
  amounts are legible, and the confirmed line wraps inside the mobile viewport.
- [Browser run #2](https://github.com/sandrabrayer/E-Zone-Dashboard/actions/runs/38721101578)
  passed **3 tests, 0 failures, 0 skips** on code head
  `bdde29e97e4599b25b70e32f030ab0967f5c9563`. Tests #339 and Validate Workflows #36
  also passed. The CI merge tree `a584359b9feb8f8e12a58984bb18544939a20e14`
  matches local commit `692e3eb1373a3bafea65e6d672f0287237fa9fae`, which passed
  the full local suite again with 2,793 passes and 66 browser skips. Screenshots
  and TAP report are artifact 11965470408 (retained until October 22, 2026).
  The deployed branch and live API still reported `0d9790a`; live cache v63 was
  rechecked after browser QA. Final documentation-only changes do not alter this
  tested code.

This feature remains separate from payment-write recovery PR #229, which Sandra
authorized and which is deployed as `0d9790a51f10ce914cf3bc9d84b41373f504991d`.
The candidate now includes that deployed base and Managers #231. No merge or
deployment of the follow-up feature is authorized yet. No flags, credentials,
production data or financial permissions were changed. Before release: obtain
the separate deployment authorization in the work plan and recheck the live
base and cache version if another change has shipped meanwhile.
