# CHANGELOG — discounts belong to Vered; Ortal's «בקרת גבייה» tab trimmed

## Why
Discounts are given by Vered (and Sandra), not Ortal. Ortal must see a
discounted cycle as «not a debt, not expected from the bank, not revenue» and
can cancel an amount Vered reported incorrectly. Her tab should show only what
she works on.

## Permissions (server.js first, Code.gs again — fail-closed)
- `setBillingDiscount` now needs the `finance` capability (stable user id:
  Vered, Sandra). Ortal — with or without the `accountant` role — Shiran and
  Yael get 403 `forbidden_role`; nothing is written. A forged actor with a
  `finance` cap is still refused by Ortal's controller allow-list.
- `ACCOUNTANT_ACTIONS` is now `['voidUnpaidClaim']` only; new `DISCOUNT_ACTIONS`
  (lib/role-scope.js = Code.gs, pinned by tests). Removed from `CONTROLLER_ACTIONS`.
- `/api/me`: `canAccount` = may cancel; new `canDiscount` = may give a discount.
- `billingControlQueue` returns `problems` also to the `finance` capability so
  Vered can see the unpaid cycles and press «הנחה».
- No Railway variable change is needed (finance is decided by stable id).
- Revenue is unchanged: only actual confirmed payments count; a discounted
  cycle lowers the expected amount (floored at 0), it never becomes income.

## Ortal's tab
- «בעיות גבייה» is first; «שחרורים צפויים» and «ועדות קרובות» are removed for
  the accountant (other roles unchanged).
- Two subsections with counts: reported-but-unconfirmed amounts (buttons
  «שולם - אשר», «הסכום שדווח שגוי - בטל») and unpaid cycles with no reported
  payment (no buttons for Ortal; Vered gets «הנחה»).
- «הסכום שדווח שגוי - בטל» also on every unconfirmed row of the main queue
  and flagged lists; never on confirmed / partial rows. Reason 2–120 required;
  undo stays Sandra-only.
- Render race fixed: `applySessionInfo` redraws the tab when `canAccount` /
  `canDiscount` arrive after the first render.
- Sandra's «חריגים פתוחים» still lists every discount and cancellation with who
  and why.
- Service worker `CACHE_VERSION` v85 (live was v84).

## Apps Script
Deployed automatically by clasp CI on merge. Never paste Code.gs; no new
deployment.

## Tests
test/ortal-billing-discounts.test.js, ortal-billing-ui.test.js,
billing-control-tab.test.js, personal-pins-login.test.js,
restricted-view.test.js, dashboard-perf-assets.test.js updated; new cases for
Vered allowed / Ortal denied (server + Code.gs), canDiscount, cancel buttons by
status, layout and race fix.
