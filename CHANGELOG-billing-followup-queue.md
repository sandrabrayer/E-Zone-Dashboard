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
- Full suite on the updated base: **2,772 passed, 0 failed, 65 browser tests
  skipped** (2,837 total). `git diff --check` and JavaScript syntax checks passed.
- `npm audit`: 0 high/critical; 1 existing moderate `qs` finding. No dependency
  or lockfile changes.
- Browser execution was blocked by local socket restrictions. An escalated
  launch was rejected by the approval policy. No visual/mobile QA is claimed;
  existing browser tests remain skipped. Live patient data was not inspected.

This is separate from payment-write recovery PR #229. It is based on deployed
branch commit `dfce382baa3b47b2c8fb489f43a7e89df246cc21`, including Managers #230.
No merge, deployment, flags, credentials, production data or financial
permissions were changed. Before release: complete browser QA and obtain the
separate deployment authorization recorded in the work plan.
