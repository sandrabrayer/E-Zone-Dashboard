# Refunds computed automatically by policy — one list «זיכויים לתשלום» (Sandra, 14/10/2026)

**What:** a refund is now computed by policy and **created by the server at
discharge**. There is no decision step. The «ממתין להחלטה — לא לתשלום» section
and its flow are gone, and so is the separate «זיכויים ממתינים לתשלום» list.
The bookkeeper (Ortal) now reads one list: **«זיכויים לתשלום»**.

## Why 7 rows had amount 0 and type «ימים שלא נוצלו» (investigation)

`refundSuggestionsFor_` always returns one `days_unused` line, even when the
policy gives 0. The comment there says "no refund owed is a recorded decision".
The old flow opened the «זיכויים» modal after every discharge and saved every
line it showed, so every stay whose policy refund was 0 left a Credits row with
`amount 0`, `calculatedAmount 0` and `creditType days_unused`, labelled
«ימים שלא נוצלו». These rows are bug artefacts, not decisions.

**Fix, with no data deleted:**
- **Never created:** the automatic path writes only positive lines.
  `upsertCredit_` refuses a CREATE with amount 0 (`zero_amount_credit`), for
  Sandra too.
- **Hidden:** a zero-amount credit **without** an approved `overrideReason`
  (`refundZeroCredit_`):
  - is never listed;
  - is never counted as a decision, so its stay is recomputed by policy;
  - is only counted, as `zeroCreditsHidden` in the response.
- **Kept:** the sheet rows stay untouched.
- **An approved zero** (Sandra's exception, with a reason) is a real decision.
  It is not listed, because there is nothing to pay, and it is not recomputed.

## The policy — `REFUND_POLICY_CUTOVER = '2026-10-07'`, by the ENTRY date

The constant is defined **once**, in `apps-script/Code.gs`.
`test/refunds-auto-policy.test.js` fails on any other copy of the literal in
`Code.gs`, `server.js`, `lib/` or `public/`.

| Entry date | Rule | `ruleVersion` |
|---|---|---|
| on or after 07/10/2026 | **New rule, the same for all houses:** the entry day is day 1. An exit on stay day 14 or later gets no refund for the current cycle. An exit before day 14 gets a pro-rata refund of the unused days, with the existing calculation (paid ÷ 30 × days not stayed, capped at the amount paid). | 2 («חדש») |
| before 07/10/2026 | **The old per-house rule, exactly as before:** an exit in the cycle's last 7 days gives 0 for אשר / רמות, and an exit from stay day 14 gives 0 for the others. The same helpers (`refundCurrentCycleRule_`, `computeRefund_`) run unchanged. | 1 («ישן») |

- **Both rules:** a fully prepaid later cycle that starts after the exit is
  refunded in full (`prepaid_return`).
- **Replaces the exit-date selection of `CHANGELOG-refund-rule-v2.md`:** that change chose the rule by the **exit** date with
  `REFUND_RULE_V2_FROM`. That constant is removed.
- **`lib/refund-rules.js`:** no longer holds the date. `currentCycleRule`
  takes `ruleVersion` from the server.

## Created at discharge, no approval step

- **Where:** `dischargePatient_` and `recordDischargeFromCoordinators_` call
  `autoRefundOnDischarge_` → `writeAutoRefundsLocked_`, under the discharge's
  own lock.
- **What it writes:** one Credits row per **positive** policy line:
  - `status pending`;
  - `approvedBy 'מדיניות אוטומטית'`;
  - `decidedDate` = the exit date;
  - `payoutDate` = `refundPayoutDate_(exit)`;
  - `basis.auto = true`.
- **Payment date:** an exit on or before the 10th is paid on the 15th of the
  same month. An exit after the 10th is paid on the 15th of the next month.
- **Idempotent:** a stay that already holds a decision gets nothing. A retry or
  duplicate discharge never adds a second refund.
- **When the policy gives 0:** nothing is written, and the Credits tab is not
  even created.
- **Fail-soft:** a refund that cannot be computed (for example
  `unknown_house`) never blocks the discharge. The answer carries
  `refund.error` (a code only), and the stay shows in «לא ניתן לחשב».
- **On screen:** the client no longer opens the «זיכויים» modal after a
  discharge. It shows one toast with no amount, or a Hebrew error.
- **Older stays:** a stay discharged before this change, with no saved
  refund, is computed into the list as an `auto` row. «סמן כשולם» or an
  exception writes it first, under the lock, and then acts on it.

## The exception — Sandra only, enforced on the server

**Action `approveRefundException`:**
- **Input:** `{ creditId }`, or for a computed row
  `{ patientKey, creditType, allocationMonth }`; plus `amount` (0 – 1,000,000;
  0 cancels the refund) and `reason` (required, 2–300 characters, cleaned).
- **Gate:** it was already on `APPROVER_ACTIONS` in `Code.gs` and in
  `lib/role-scope.js`. `server.js` and `handle_` both refuse everyone except
  Sandra's personal session (`forbidden_role`), and the controller view gets
  `forbidden`.
- **What it writes:** `amount`, `overrideReason` and `approvedBy`.
  `calculatedAmount` never changes.

**`saveCredit` — the server recalculates the policy itself (follow-up):**
- **On every save from the browser**, `upsertCredit_` recalculates the policy
  figure with `refundPolicyLineFor_`:
  - it finds the stay's latest open discharge by the credit's `patientKey`;
  - it recomputes the lines from the Payments rows (`autoRefundLines_`);
  - it picks the line with the same `creditType` + `allocationMonth`.
- **The client is never trusted.** Its `calculatedAmount`, `basis`, rule label
  and `approvedBy` are ignored. A create stores the server's figure and basis:
  0 and `{manual:true}` when the policy has no such line.
- **Amount equal to the policy figure:** saved with **no approval** (Vered
  too). The server writes its own trail, `approvedBy 'מדיניות אוטומטית'`, and
  `decidedDate` = the exit date, so the payment date follows the exit.
- **A different amount, a line the policy doesn't have, or a manual
  (`other`) credit:** needs **Sandra's personal approver session plus a
  reason** (`override_requires_approver` / `override_reason_required`). For a
  manual credit, its reason is the override reason. `approvedBy` is stamped
  with the approver.
  - Only a manual create is refused up front, as `approveRefundException` in
    `roleOperationFor_` on both servers. `server.js` can't recalculate the
    policy, so every other create is decided by `Code.gs`.
- **An EDIT that changes the stored amount:**
  - back to the recalculated policy figure → no approval;
  - anything else → Sandra.
- **Vered** can still edit status, paid date and notes.

## «סמן כשולם» — action `settleRefund`

- **Who:** Vered, Sandra **and Ortal**. Shiran and Yael are refused (403 in
  `server.js`, `forbidden` in `Code.gs`, nothing read or written).
  - It is on `FINANCE_ACTIONS` and, appended, on `CONTROLLER_ACTIONS` in both
    copies, so Ortal's controller view reaches it. That is her only write on
    «גבייה».
  - She never reaches `approveRefundException` or `saveCredit`.
- **A row that isn't saved yet:** the server writes it from its own policy
  calculation first. Any amount, `calculatedAmount` or rule sent in the body is
  ignored.
- **The answer** carries only `id`, `status`, `paidDate` and `updatedAt`: no
  amount and no free text.
- **Input:**
  - `paidDate`: a real day, not in the future;
  - `method`: 1–40 characters, with any formula lead-in stripped.
- **Rule:** the row must be `pending` with an amount above 0.
- **Audit row:** ids only.

## One list on screen (גבייה → «זיכויים לתשלום»)

**Above the list:** a table of totals per payment date (date, number of
refunds, total ₪) and a grand total.

**Each row shows:**
- patient and house;
- total paid (non-void cycles);
- entry and exit dates;
- the reason for leaving: the disposition label plus the discharge note;
- days stayed and refund days;
- the refund amount, marked «חריגה מאושרת» when overridden;
- the rule applied: «חדש (אחיד)» or «ישן (לפי בית)», plus the rule label;
- the payment date;
- the «סמן כשולם» button.

Sandra also sees «חריגה». A computed row has a dashed edge.

**Ortal** (the controller view) sees the whole list, with every row column, and
can mark refunds paid.
- **Reason for leaving:** she sees the **disposition label only** («סיים
  טיפול» / «הפסיק לפני הזמן» / «לא רלוונטי» / …). The free-text discharge note
  is cut from her answer (`dischargeNote` is not in
  `CONTROLLER_FORECAST_SCHEMA`, in either `Code.gs` or `lib/finance-scope.js`),
  so no discharge free text reaches her. Vered and Sandra still see the note.
- **Sandra's free-text `overrideReason`** stays out of every list row.

**What stays as it was:** the grey «לא ניתן לחשב» block and the muted
"no recorded payment → «חובות פתוחים»" line.

**The .xlsx export** now has three sheets: «סיכום», «זיכויים לתשלום» and «לא
ניתן לחשב».

## Server response (`refundPayoutForecast`, read-only)

`{ ok, today, recordsCutoff, policyCutover, toPay:{count,total,byPayoutDate,rows},
missing_payment_data, unresolved, zeroByPolicyCount, preCutoffExcludedCount,
zeroCreditsHidden }`.

The `decided` / `awaiting_decision` / `payoutDateIfDecidedToday` keys are
removed. `CONTROLLER_FORECAST_SCHEMA` was updated in both `Code.gs` and
`lib/finance-scope.js`.

## Other changes

- **«בקרת גבייה»** refund exceptions: only `over_policy` remains. Nothing
  "awaits a decision".
- **«רשימת תיקונים»:** the `credit_awaiting` kind is removed. «זיכויים לבדיקה»
  lists only the stays that cannot be computed.
- **The «זיכויים» modal** (from מטופלים משוחררים) only shows and edits saved
  credits. The amount is read-only unless the user is Sandra, and «+ זיכוי
  ידני (חריגה)» is Sandra-only. `fetchRefundSuggestions`,
  `pendingCreditsByPayout`, `showMarkCreditPaidModal` and
  `openCreditsForCredit` are removed. The `suggestRefunds` server action stays
  (read-only).

## Security

- **Inputs:** every input is validated on the server (dates, amounts, reason
  length, method, creditType, month).
- **Rendered text:** escaped with `escapeHtml`.
- **Logs:** no financial data. The `console.warn` lines carry error codes only,
  and the new AuditLog rows carry ids and rules, no amounts.
- **Permissions:** the exception is enforced in both `server.js` and `Code.gs`,
  and fails closed. A call without a proxy secret holds no role.
- **Dependencies:** `npm audit` reports 0 high / 0 critical (1 moderate in
  `qs`, already there before this change).

## Service worker

`CACHE_VERSION` v61 → **v62**. The follow-up changed `public/app.js` again.
Production still served v61 and no other branch was above it, so v62 (this
unmerged PR) is still the next free number. No further bump. Production `/sw.js` served v61 on 14/10/2026,
and every remote branch was at v61 or lower. v17 stays burned.

## Tests

- **New:** `test/refunds-auto-policy.test.js`. It covers:
  - the literal guard;
  - entry the day before, on and after the cutover;
  - exits on stay day 13, 14 and 15 in every house;
  - the old rule per house;
  - the prepaid full refund;
  - the payment date for exits on the 10th and 11th, and across the year end;
  - creation at discharge, idempotent, with no zero rows;
  - zero-amount credits hidden and kept on the sheet;
  - the server-side exception permissions (Vered, Ortal and Sandra), for a
    saved row and for a computed row;
  - «סמן כשולם», including a forged amount or rule that is ignored;
  - follow-up, policy recalculation:
    - Vered saves a policy-matching amount with no approval, and the server
      keeps its own figure, basis, trail and dates;
    - a different amount, a line the policy doesn't have, or a manual credit
      needs Sandra plus a reason;
    - an edit back to the policy figure needs no approval;
  - follow-up, «סמן כשולם» permissions per role on both servers: Vered, Ortal
    and Sandra allowed; Shiran and Yael refused with nothing written or
    proxied;
  - follow-up, Ortal's view: the disposition label only; the discharge note's
    free text reaches her nowhere (Code.gs and lib cut);
  - the screen, escaped;
  - no modal after a discharge.
- **Updated** for the new shape: refund-payout-forecast, credits-ledger,
  refund-rule-v2, refund-logic-wiring, xlsx-export, billing-tab-section-colors
  (+browser), cleanup-workbook, cleanup-export-finance, billing-control-tab,
  duplicate-discharges (+browser), lock-busy-frontend, restricted-view,
  ortal-billing-access, monthly-revenue, accounting-source-feed,
  write-path-hardening-money, receipt-duplicates-and-edit, cycle-balance,
  dashboard-perf-assets.

## Deploy

- **Apps Script:** `Code.gs` changes, and clasp CI deploys it on merge.
- **Railway:** serves `app.js`, `index.html`, `style.css` and
  `/refund-rules.js`.
- **No new** Script Property, env var, column or trigger. The Sheets headers
  are unchanged (append-only respected).
- **Order on merge:** if Railway lands before Apps Script, the list shows the
  explicit Hebrew load error, never an empty list, until clasp finishes.
