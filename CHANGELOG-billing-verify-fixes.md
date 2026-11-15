# «גבייה»: verification that works, payment kind, search, Ortal's account, speed

Sandra, 15/11/2026 — five fixes in the CRM «גבייה» area. Browser + tests only:
**no Code.gs change, no new server action, no new permission.**

## 1. Verification («אומת») — Ortal

**Was:** the CRM showed the verification status as a coloured pill that looked
like a button. Clicking it did nothing — the CRM had no verification action at
all (it lived only in the classic «בקרת גבייה» tab).

**Now:**
- Only a **confirmed** receipt is green («אומת ✓»). Waiting = amber
  («ממתין לאימות»), partial = amber («אומת חלקית»), flagged = red («סומן לבירור»).
- A session that may confirm (Ortal, Sandra — `canConfirm`) gets a real **«אמת»**
  button next to every unverified receipt: in «תקבולים», in the «סקירה» search
  results, on the waiting rows of her «היום שלי», and in the patient's «חשבון».
- Click → the button shows a spinner («מאמת…») → `confirmPayment`
  (`{ ids: [id], status: 'confirmed' }`, the classic contract) → the row turns
  green and leaves «ממתינים לאימות»; the menu badge and her day card drop by one.
- Proof, not hope: the row turns green only when the server's answer names
  that receipt as confirmed. A refusal says why and the receipt keeps waiting.
- The «דיווחים לאימות» card now opens **all dates** (it used to hide waiting
  receipts older than 30 days). Void receipts are no longer counted as waiting.
- Partial / not received / duplicate decisions stay in the classic tab (linked).

**What verification does to the debt:** the cycle's debt drops when the payment
is *reported* (that is the existing engine, unchanged). Verification confirms
the money and clears the item from the waiting list. Making the debt stay open
until verification would be a Code.gs engine change — not done here.

## 2. «סוג התשלום» in «דווח תשלום»

The form now asks, whenever the cycle has a balance:
- **תשלום מלא** — the whole balance; the cycle closes.
- **תשלום חלקי** — less than the balance; **the rest stays an open debt**.
- **תשלום בהנחה** — less than the balance; the rest is written as a discount
  (reason required) and **no debt stays**. Offered as before only to a user who
  may discount, on an open cycle (it replaces the «שולם עם הנחה» checkbox).

An amount under the balance is no longer saved by accident as a plain payment:
the user must choose partial or discount. A live line says what will remain.

## 3. Search in «גבייה»

- **Was:** a name typed while on «סקירה» changed nothing (the overview has no
  list), and the section box «חיפוש מטופל/ת» searched only after Enter / leaving
  the field.
- **Now:** on «סקירה» a typed name shows results — open debts, receipts of any
  date (with verification status), refunds to pay, and patients with nothing
  owed; a row opens the patient's «חשבון». An unknown name says so. The section
  box searches while typing and keeps the caret.

## 4. Ortal sees the patient's «חשבון» like Vered

Her «חשבון» pane said «אין הרשאה לנתוני גבייה». The server already answers her
the same reads (`CONTROLLER_ACTIONS`), so the pane now shows open cycles,
stamped cycles, receipts, credits and the funder. **Read-only:** no «דווח תשלום»,
no discount, no receipt edit / void, no credit edit, no patient-record actions,
no contact log — the server refuses those for her anyway. Her actions: «אמת»,
«שנה סכום» (accountant role, as before) and «סמן כשולם» on refunds.

## 5. Speed

Apps Script reads (2–8 s each) are the slow part. What changed:
- After a billing save the screen **stays** with a small «מעדכן נתונים…» note —
  no blank «טוען…» for the whole area.
- A save re-reads **only what it changed**: a payment / discount / receipt fix
  → debt + payments (2 reads, was 4); a refund step → debt + credits + refunds.
- A verification re-reads **nothing** (the rows are patched from the answer).
- A write during a refresh triggers another refresh — an answer that began
  before the write is never shown as its result.
- «תקבולים» paints the first 200 rows of a long list («הצג את כולם» for the
  rest); the totals are always of the whole list.

## Security

- No new action, route, role or capability. `CONTROLLER_ACTIONS` is unchanged
  (a test pins that `reportPayment`, `setBillingDiscount`, `editReceipt`,
  `saveCredit`, `saveAll` stay refused for the controller view).
- The verify button is display-gated on `canConfirm === true` (fail-closed);
  the server and Code.gs enforce the role themselves.
- Receipt ids are validated before posting (prefix, length, no control chars);
  every rendered value goes through `esc()`.
- `npm audit`: 0 high / critical.

## Files

- `public/crm/crm.js`, `public/crm/crm.css`
- `public/sw.js` — cache `v135 → v136` (from the live v135)
- Tests: `test/billing-verify-fixes.test.js` (new, 14), four new browser
  scenarios + updates in `test/crm-shell-browser.test.js`, pinned-source
  updates in `test/paid-with-discount.test.js`, `test/cashflow-refunds.test.js`,
  `test/historical-debt-cleanup.test.js`, `test/ortal-crm-default.test.js`,
  `test/crm-shell-ui.test.js`, `test/crm-pwa.test.js`,
  `test/dashboard-perf-assets.test.js`
- Docs: `EZONE-ECOSYSTEM-STATUS.md`

## Manual check after deploy

1. Ortal → «גבייה» → card «דיווחים לאימות» → «אמת» on a row → spinner → green.
2. Vered → patient → «חשבון» → «דווח תשלום» with a lower amount → the form
   demands «חלקי» or «בהנחה».
3. «גבייה» → «סקירה» → type a name → results appear.
