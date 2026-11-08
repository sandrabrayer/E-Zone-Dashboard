# CHANGELOG — «ניקוי חובות היסטוריים» (CRM «גבייה»)

## Why
Most of the open debt of patients who already left is not real debt: the
payment was made but never recorded in the app (Sandra, 08/11/2026). Closing
them one cycle at a time in the patient card takes dozens of clicks.

## What Vered / Sandra see
In «גבייה», under «חובות פתוחים לפי מטופל/ת», a collapsed section
**«ניקוי חובות היסטוריים — מטופלים משוחררים»** (with a count + total chip):
- Every OPEN cycle of a released patient who is not in a house, with a
  checkbox, the name (opens the patient on «חשבון»), house, cycle, balance and
  age. «בחירת הכל» at the top. A live line: «נבחרו N מחזורים של M מטופלים · ₪X».
- **Reason** (required): «שולם — לא נרשם באפליקציה» or «לא חויב בפועל / טעות
  רישום», plus an optional note (≤ 60 characters).
- «סגירת המחזורים שנבחרו» → a confirm with the count and the sum → the cycles
  are closed one after the other with progress «סוגר… k/n»; the area re-reads.
  The first refusal stops the run and says how many were closed.

## How it is written (no new server action, no Code.gs change)
Each ticked cycle is closed by a **discount for its whole open balance**
through the existing `setBillingDiscount` (finance only — `DISCOUNT_ACTIONS`,
server-enforced, one AuditLog row per write). One write per patient + month
with the month's TOTAL (existing discount + every ticked balance of that
month), because the action keeps one value per month. The reason is stored as
«ניקוי חוב היסטורי · <reason> · <note>», so every such close is identifiable
in Sandra's «חריגים פתוחים» and in the BillingOverrides sheet.

## Deliberate limits
- **Not revenue.** A discount never counts as income. Money that did arrive
  and can be identified should be reported with «דווח תשלום» (Ortal verifies
  it) — the section says so.
- **No write-off here.** Money that will never come is not offered as a reason:
  a write-off stays Sandra's own flow; this tool cannot dress one up.
- Only released patients out of a house; never active patients.
- Hidden from Ortal's controller view and from anyone without `canDiscount`.
- Ticking never re-renders, so a typed reason is never lost.

## Security
Server gate unchanged (finance capability + validation in
`billingDiscountRequestClean_`: key shape, month, amount ≤ 1,000,000 with ≤ 2
decimals, reason 2–120, formula lead-in stripped). Client limits mirror them.
Every rendered value through `esc()`. Sequential writes (the script lock is
never raced). No new route, secret or log.

## Files
`public/crm/crm.js` (`cleanupCandidates`, `cleanupPlan`, `cleanupBody`,
`CLEANUP_REASONS`, `renderCleanup`, `submitCleanup`, handlers),
`public/sw.js`, `test/historical-debt-cleanup.test.js` (new, 10),
`test/crm-shell-browser.test.js` (+1 Chromium scenario; `boot({ debt })`).
