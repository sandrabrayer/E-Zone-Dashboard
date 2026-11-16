# «בטל זיכוי» — cancelling a refund that should not be paid

Sandra, 16/11/2026: in «זיכויים לתשלום» there was no way to cancel a refund that
has not gone out and should not. «ורד תבטל».

## What is new

Every row of «גבייה» → «זיכויים לתשלום» has a **«בטל זיכוי»** button for Vered
and Sandra.

1. Click «בטל זיכוי» on the row.
2. Write why (required, 2–300 characters).
3. «בטל את הזיכוי».

The refund leaves «זיכויים לתשלום», its total and «צפי תזרים». It is **kept** in
the Credits sheet as «בוטל» with the reason, who cancelled and when — nothing is
deleted, and the amounts on the row are untouched.

It works for both kinds of row:
- a **saved** refund (a month in the «חודש» column);
- a refund the policy only **computed** at discharge («מחושב — טרם הוחלט»): the
  server first saves the stay's policy lines, then cancels this one — so
  cancelling one line never hides another line of the same stay, and the
  policy does not compute the cancelled one again.

A refund already marked paid cannot be cancelled. A payout request / approval on
the row is cleared by the cancellation.

## Who

`finance` + `deleter`: **Vered and Sandra**. Not Ortal (she pays refunds — her
view has no button and the server refuses her), not the ops view.

## Server (Code.gs — deploys automatically on merge)

New action `cancelRefund` (`cancelRefund_`):
- on `DELETE_ACTIONS` (role `deleter`, enforced by `handle_`, repeated inside
  the function with the verified personal session), `FINANCE_ACTIONS` and
  `PROXY_KNOWN_ACTIONS`; **not** on `CONTROLLER_ACTIONS`;
- mirrored in `lib/role-scope.js` (`DELETE_ACTIONS`) and `lib/finance-scope.js`
  (`FINANCE_ACTIONS`) — the guard tests pin the lists equal;
- input `{ creditId }` or `{ patientKey, creditType, allocationMonth }`, plus
  `reason`; under the script lock; row must be `pending`;
- writes `status: 'cancelled'`, appends «בוטל: <reason>» to `notes`, clears the
  payout request/approval, stamps `updatedAt/By`; AuditLog `credit_cancelled`;
- the answer carries only `{ id, status, updatedAt }` — no amount, no text.
No sheet column added.

## Security

Fail-closed role checks on three layers (server.js via the scope lists,
`handle_`, the function). Reason cleaned of control characters and of a leading
`= + - @` (formula injection). The CRM turns the row green only on the server's
proof (`ok` + a credit that is `cancelled`). `npm audit`: 0 high / critical.

## Files

`apps-script/Code.gs`, `lib/role-scope.js`, `lib/finance-scope.js`,
`public/crm/crm.js`, `public/sw.js` (v142 → v143, from the live v142),
`test/cancel-refund.test.js` (new, 7 — incl. the server function against a fake
sheet), a browser scenario in `test/crm-shell-browser.test.js`,
`test/personal-pins-foundation.test.js`, `test/receipt-duplicates-and-edit.test.js`,
`test/crm-shell-ui.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.
