# CHANGELOG — CRM Stage 2b: verification states on «היום שלי»; Ortal's day

Date: 2026-10-29 · Branch `claude/s2b-ortal-day` → base `claude/build-ezone-dashboard-QOg5s`
Spec: §5 (Ortal's cards reflect verification / gaps / documents / control), §6 «גבייה היום»
(«דווח ≠ אומת ≠ מסמך הונפק»; waiting on Ortal shows the owner). UI only, SW v100 → v101.

## Vered / Sandra — «גבייה לטיפול»

- `getPayments` is read at boot (progressive, fail-soft; «גבייה» reuses it, a billing write
  resets it). Its receipts add rows to the collection domain:
  - **reported** → «דווח — ממתין לאימות — ₪…», owner **אורטל**, listed under «ממתין לגורם אחר» —
    not Vered's task;
  - **flagged / partial** → «סומן לבירור» / «אומת חלקית» with Ortal's note — an **exception**
    waiting for a decision.
  - confirmed and void receipts are not rows.
- The card hint adds «N ממתינים לאימות אורטל» («טוען…» / «המידע אינו זמין» per source).

## Ortal — «היום שלי» rebuilt (same layout as Vered's)

Reads at boot: `billingControlQueue`, `getTasks` (Code.gs gives her **money tasks only**),
`getCredits`. Never debt, payments or lead data.

| Card | Rule |
| --- | --- |
| דיווחים לאימות | `reported` receipts; older than 3 days = late |
| אימותים חלקיים / לבירור | `flagged` + `partial` — exceptions |
| חשבוניות מבוקשות | **verified** receipts with `invoiceWanted = yes` in the last 60 days — the card says plainly that issuance is not recorded here (חשבשבת is the source) |
| משימות כספיות שלך | her money tasks due (late + today) — «סיום» / «שינוי מועד» work here |
| זיכויים לתשלום | pending credits, late after their payout date |

Urgent band = exceptions + late items. Her decisions (confirm / flag / settle) stay in the
classic «בקרת גבייה» / «גבייה» — every verification row links there. A failed queue shows «תור
האימות לא נטען» + retry; a card whose source failed shows «—», never 0. House filter applies.

## Files

- `public/crm/crm.js`: `VERIFY_LABELS`, `verifyStatus`, `verificationRows`, `ortalDay`;
  `myDay(..., payments)`; `renderControllerToday` rebuilt; boot reads; `receiptsOf` +
  `flagNote`, `recordedBy`; `resetBilling` / `loadBilling` reuse `state.payments`.
- `public/sw.js` (v101).
- Tests: `test/crm-ortal-day.test.js` (2), `test/crm-shell-browser.test.js` (Ortal + C8
  scenarios updated; the queue fixture now carries `confirmStatus`), SW guards.

## Security

No new action. Ortal's reads are her existing `CONTROLLER_ACTIONS`; the money-task scope is
server-side. `npm audit`: 0 high / critical. Nothing to set.
