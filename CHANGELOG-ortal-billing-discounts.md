# Ortal billing — accountant role + discount schema (foundation, PR 1)

October 22, 2026. Zero user-facing change: server rules, schema and the shared
cycle-balance math only. The screens come in PR 2 (`CHANGELOG-ortal-billing-ui.md`).

## Investigation (read-only, before any edit)

`claude/handoff-2026-10-01.md` does not exist in the repo (no `claude/`
directory, no commit mentions it). The 2026-10-01 decisions it refers to live
in `docs/billing-control-plan.md` §11 and in `lib/users.js`.

### Login, roles, PINs

- **APP_PIN is retired.** The shared code and `APP_PIN_UNTIL` were removed;
  `server.js` only warns once if either is still set (never the value). A
  cookie without a personal id resolves to no principal → 401.
- **Personal PINs already exist** (`lib/users.js`, PR A–C): `USER_PIN_HASHES`
  (Railway, a JSON array of `{id, name, roles, hash, pinVersion, status}`,
  salted scrypt hashes from `lib/pin-hash.js`). The startup validator refuses
  bad JSON, unknown ids/roles, a role outside the user's model, and any
  approver other than Sandra. `USER_MODEL.roles` is the MAXIMUM a user may
  hold; a record may only narrow it.
- **Ortal already has a personal login**: model `{ id:'ortal', roles:
  ['controller'] }`, active since Phase 4 (2026-10-04). Her session is the
  *controller view* (decided by stable id, `CONTROLLER_USER_IDS`): only the
  «בקרת גבייה» tab plus read-only «גבייה»; every other action → 403 in
  `server.js` and again in Code.gs `viewRefused_`.
- **Viewer mode** = the `viewer` role (Sandra) + the `restricted` view for
  users without the `finance` capability (Shiran, Yael: no money tabs).
- Roles reach Apps Script only from the signed session (`proxyRoles`,
  `proxyUserId`, `proxyAuth`, `proxyCaps`), never from the body; Code.gs
  re-derives and intersects them (`proxyActor_`, `hasRole_`).

**Decision:** the per-user PIN mechanism exists, so — per the task's own rule
— it is EXTENDED, not duplicated. There is **no `ORTAL_PIN`** variable: a
second credential path for one user would bypass the pinVersion reset /
revoke / validator that `USER_PIN_HASHES` already gives. The new `accountant`
role is added to Ortal's model; it is fail-closed because her live record
line does not carry it until Sandra adds it (see «Manual step»).

### Payments, gaps, debt, revenue

- **Payments sheet**: *cycle rows* (one per billing cycle, `amount` = what
  was billed, `amountPaid`/`status` DERIVED from receipts) and *receipt rows*
  (`rcpt-…`, one per money reported by Vered via `reportPayment`). Receipts
  are immutable except the void decision and the invoice choice.
- **Expected amount per cycle** (`lib/cycle-balance.js` = Code.gs
  `cycleBalanceState_`, parity-tested): a SETTLED cycle keeps its stamp; an
  OPEN cycle owes the per-month override (`BillingOverrides`, «סכום חודשי»,
  keyed `ovr::<houseId::name::entryDate>::<YYYY-MM>`), else the patient's
  agreed price (`Patients.pay`), else the stamp. Unrecorded cycles (no
  Payments row) use `recApplyOverride_` over `pay`.
- **Debt** = `debtAging_` (Code.gs): recorded cycles' `expected − received
  by D` plus unrecorded cycles at their expected amount, never summed.
  Pro-bono cycles are excluded; funder-grace cycles are counted but owed.
- **Missing-payment gaps** = the cleanup workbook `gaps` section and
  «חובות פתוחים» — both read the same expected rule.
- **Revenue**: «הכנסות חודשיות» RECEIVED = `amountPaid` allocated over the
  coverage window; the EXPECTED half is `billed − paid` through
  `applyBillingOverride`. «הכנסה מאומתת» (`revenueVerified`) counts only
  receipts Ortal confirmed. Note: the plain RECEIVED figure counts a receipt
  as soon as Vered reports it; voiding a never-paid claim is what removes it.
  This PR does not change either revenue figure.
- **Confirmation** already exists: `confirmPayment` (controller or approver
  role) sets `confirmStatus` confirmed / partial / flagged («לא שולם»), or
  «כפילות» (voids one receipt via the PR #144 path, refused when it is the
  cycle's only live receipt).

### The void-duplicate flow (#144), server-side

- A void is `status:'void'` + `linkStatus:'duplicate'` + a required
  `linkNote`; the row is never deleted (`upsertPayment_`). `linkedBy` /
  `linkedAt` are server-stamped from the signed session; AuditLog
  `payment_link_duplicate`.
- `voidPayment` is in `DELETE_ACTIONS` (needs `deleter`: Vered, Sandra) on
  the savePayment path; Ortal's «כפילות» rides `confirmPayment`.
- **Un-void** (`unvoidPayment`, `APPROVER_ACTIONS`) is decided in
  `upsertPayment_` against the stored row: Sandra's personal session only.
- `lib/role-scope.js` mirrors the lists; `server.js` refuses first (403),
  Code.gs refuses again. Guard tests pin the lists equal.

## What PR 1 adds

### `accountant` role (extends the existing personal PINs)

- `lib/users.js` `ROLES` and Code.gs `KNOWN_ROLES` gain `accountant`
  (appended). Ortal's model: `['controller', 'accountant']`. No one else may
  hold it (the validator refuses it on any other record). Ortal still never
  holds `deleter` or `approver`.
- New `ACCOUNTANT_ACTIONS = ['voidUnpaidClaim', 'setBillingDiscount']`
  (lib/role-scope.js + Code.gs, pinned equal). Each needs `accountant` OR
  Sandra's `approver`. `server.js` refuses first (403 `forbidden_role`);
  Code.gs `handle_` refuses again before any read or write.
- `/api/me` gains `canAccount` (display only).

### Void an UNPAID payment claim («לא שולם — בטל תביעה»)

- `confirmPayment` with `status:'not_received'`, ONE receipt, reason in
  `flagNote`, 2–120 characters after cleaning (control characters → space,
  formula lead-in dropped; a longer reason is refused, never cut).
- Soft delete: the receipt gets `status:'void'`, `linkStatus:'not_received'`
  (appended to `PAYMENT_LINK_STATUSES`), `linkNote` = the reason, and the
  server-stamped `linkedBy` / `linkedAt`. The row is kept; the cycle's money
  is re-derived, so the claim leaves «נגבה» and the cycle is owed again.
  AuditLog `payment_link_not_received`.
- Refused (`receipt_confirmed`) when the receipt is already confirmed or
  partially confirmed — enforced inside `upsertPayment_`, so it also binds
  the savePayment path (Vered / Sandra).
- Undo = Sandra only: the existing un-void (`unvoidPayment`).
- A retry with the same reason replays the stored answer; nothing is written
  twice.

### Discount schema (append-only)

- `BillingOverrides` (the per-cycle expected-amount record) gains four
  columns APPENDED after `updatedBy`: `discountAmount`, `discountReason`,
  `discountBy`, `discountAt` (text-forced). Existing rows read blank = no
  discount. A guard test pins the order.
- A discount-only row has a BLANK `amount`: every reader now treats a blank
  amount as «no override» (`recOverride_`, `recOverrideFor_`,
  `receiptOverrideAmount_`, `billingOverrideFor` in app.js).
- `upsertBillingOverride_` keeps the discount cells of the row it replaces;
  `deleteBillingOverride_` on a row that carries a discount clears only the
  amount and keeps the row (a discount is never hard-deleted).
- New action `setBillingDiscount { patientId, month, discountAmount,
  discountReason }`: accountant or approver; the patient must exist; amount
  0–1,000,000 (agorot; 0 clears it); reason 2–120; `discountBy` / `discountAt`
  server-stamped; LockService; AuditLog `billing_discount_set` with prev /
  next. Added to `FINANCE_ACTIONS` and `CONTROLLER_ACTIONS`.

### Math

- **Effective expected = base − discountAmount, never below 0**, where base
  is the existing rule (override → agreed `pay` → stamp). Applied in
  `lib/cycle-balance.js` `cycleExpected` / `cycleState` and Code.gs
  `cycleBalanceState_` (parity-tested), `recApplyOverride_` /
  `applyBillingOverride` (unrecorded cycles, the due list, the forecast).
- A SETTLED cycle is untouched (history). `priceExpected` for the
  under-stamped check is net of the discount, so a cycle stamped at the
  discounted price is not flagged.
- A fully discounted open cycle: balance 0, status `paid`, `discount` on the
  state — it is never debt.
- **Revenue is unchanged**: RECEIVED is still `amountPaid`; a discount moves
  no money and creates no receipt.
- `debtAging_` cycles carry `discount` and the override `month` (its
  `byPatient` rows already carry `patientKey`, which Ortal's controller view
  already reads). The «בקרת גבייה» follow-up queue is unchanged — it never
  carries a patient key.
- Controller allow-list: `CONTROLLER_OVERRIDE_FIELDS` gains the four discount
  fields (Ortal needs them for the same math).

### Scope notes

- The discount is applied at READ time (the shared rule). The STORED cycle
  row (`amount`, `amountPaid`, `status`) is not rewritten, so the
  accounting feed and other raw readers of the Payments sheet see the
  billed figures, as they do for a monthly override today.
- «שולם — אשר» needs nothing new: `confirmPayment` status `confirmed`
  already exists for Ortal (controller role).

## Security

- No secret in code or logs; refusals log the user id + operation only.
- Fail-closed: without `accountant` (or Sandra's `approver`) both new
  operations are 403 / `forbidden_role` with nothing read or written.
- Input validated server-side; formula lead-ins and control characters never
  reach a cell; HTML is escaped at render (PR 2).
- `npm audit`: 0 high / critical.

## Tests

`test/ortal-billing-discounts.test.js`: role enforcement (Ortal allowed,
Vered / Shiran / Yael denied, Ortal without `accountant` denied = fail-closed,
server 403 before proxying), void rules (unpaid only, reason 2–120, row kept,
who / when, audit, Sandra-only undo, Ortal cannot hard-delete or touch
settings), discount math (lib + Code.gs parity, floor at 0, settled
untouched), debt reduced and revenue unchanged by a discount, append-only
column guard.

## Manual step (Sandra, Railway)

Add `"accountant"` to Ortal's record in `USER_PIN_HASHES` — her roles become
`["controller","accountant"]`. Nothing else changes (same hash, same
pinVersion). Until then the new actions are refused for her (fail-closed).
