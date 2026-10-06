# «בקרת גבייה»: status dropdown, partial amount, remaining balance, note + Ortal's read-only «גבייה» (PR 2 — UI)

The UI half of `CHANGELOG-ortal-billing-access.md`. Stacked on PR 1 (#187),
so merge PR 1 first. Base: `claude/build-ezone-dashboard-QOg5s`. Service
worker `CACHE_VERSION` **v39 → v40** (v39 is the deployed one, from #186).
`apps-script/Code.gs` is not touched in this PR.

**What users see after this PR:**

- **Ortal:**
  - **A new tab, «גבייה», read-only.** It sits next to «בקרת גבייה» and
    shows the same rows, receipts, credits, debt aging and exports Vered
    sees.
  - It has no «דווח תשלום», no ✏️ amount or coverage edit, no «ביטול
    קבלה», no «סמן כשולם» / «ערוך» on credits and no «השלמת גורם מממן».
  - «בקרת גבייה» still opens first.
- **«בקרת גבייה», every row** (Ortal and Sandra):
  - **A status dropdown** replaces ✓ / ⚑:
    - **שולם** saves at once;
    - **שולם חלקית** opens «כמה התקבל בפועל?» with the reported amount and
      a live «יתרה פתוחה: ₪…» line;
    - **לא שולם** opens the existing note form («מה הבעיה?», required).
  - **«+ הערה» / «✎ עריכת הערה»:** an optional note, up to 500 characters,
    with a counter. It can be saved at any time and is separate from the
    «לא שולם» note.
- **New list «שולם חלקית»**, with its open total in the heading. Each row
  shows «אומת ₪x מתוך ₪y · יתרה פתוחה: ₪z».
- **New card «יתרה פתוחה»**: partial remainders + «לא שולם».
- **«אומת החודש» / «אומתו» / «מאומת»** (on הכנסות חודשיות) count only the
  confirmed part of a partial receipt.
- **Vered:** the same rows, notes and remaining balances, read-only. She
  has no dropdown and no note editor.
- **Shiran and Yael:** nothing changes. They see neither tab.

---

## How it works

### The page (`public/`)

**`app.js`, «בקרת גבייה»:**
- `bcStatusSelectHtml`: the three options come from
  `DECISION_OPTIONS` (PR 1). The current status is preselected; a waiting
  row starts on «בחרו סטטוס…».
- `onBcStatusChange`:
  - `confirmed` → `confirmPayment` at once;
  - `partial` → the amount form;
  - `flagged` → the note form.
  - Until a form is saved, the dropdown shows the saved status again, so
    nothing changes silently.
- `bcPartialFormHtml`:
  - `inputmode="decimal"`, `dir="ltr"`;
  - the live remaining balance uses the shared `partialAmountCheck`;
  - a bad amount gets an inline Hebrew error with `aria-invalid` and is
    never sent;
  - the error clears as soon as she types again.
- `bcControlNoteHtml`: textarea with `maxlength=500` and a counter.
  `controlNoteCheck` runs before sending. A note-only save sends no status.
- `confirmReceipts(ids, status, extra)` takes `{ flagNote,
  confirmedAmount, controlNote }`; a string third argument still works. The
  server's refusal codes have Hebrew messages (`BC_ERRORS`).
- **Every value is escaped** (`escapeHtml`): the note, the flag note, ids
  and fields. HTML-looking text shows as text.
- A partial receipt is also listed by month under «אומתו». There it is
  display-only, so no element id is drawn twice (the browser test caught
  this).
- `normalizeReceipt` keeps `confirmedAmount` / `controlNote`, so «מאומת» on
  הכנסות חודשיות counts only confirmed money.

**`app.js`, Ortal's read-only «גבייה»:**
- `allowedScreens(finance, view, billingRead)`: the controller view gets
  `['billing-control', 'billing']` only with `billingRead`.
- `applyControllerView` keeps the «גבייה» tab and screen, removes
  «השלמת גורם מממן», and sets `state.mode = 'view'`. `enterApp` keeps
  `'view'` for her.
- Every write control in «גבייה» is already drawn only when
  `state.mode === 'edit'`, so none is drawn for her. CSS hides them again
  as a second line.
- `loadBillingRead()` reads `getData` (the server cuts it to patients and
  overrides), `getPayments` and `getCredits`, each fail-soft.
  `billingTabView()` gates `renderBilling`, the credits, the forecast and
  the fix-list export.
- If `/api/me` says `billingRead` but the page was drawn without «גבייה»,
  the page reloads once (the server then serves the right body class).
- **Pro-bono patients** (found while building #187's field allow-list):
  - `loadBillingRead` keeps the Funders rows from `getPayments`;
  - `isProbonoOn` also answers for `billingReadView()`.

  Without this, Ortal's «גבייה» would have listed a pro-bono patient as
  owing. The patient rows she receives are now cut to `id, houseId, name,
  date, exitDate, status, pay, adv` (#187); the funder joins on `id`.

**`index.html`:**
- The «שולם חלקית» section (`#bc-partial`, `#bc-partial-count`,
  `#bc-partial-open`).
- The queue help text names the three statuses.

**`style.css`:**
- `body.view-controller.view-billing-read` shows the «גבייה» tab and
  screen.
- Write controls are hidden for the controller view.
- Dropdown, amount field and note styles:
  - 44px touch targets;
  - the amount is typed LTR in an RTL page;
  - at ≤480px the dropdown takes the full row;
  - nothing scrolls sideways at 360px.

**`sw.js`:** `CACHE_VERSION` **v40** (never v17).

### `server.js`

`sendIndex` serves Ortal `<body class="view-controller view-billing-read">`
when she has `billingControl`, so «גבייה» paints before `/api/me`. The
server-side permissions are PR 1's and are unchanged.

---

## Tests

**New: `test/ortal-verification-status.test.js`** (9 tests, app.js + the
lib + funder.js in a vm):
- **Status enum:** exactly שולם / שולם חלקית / לא שולם plus the blank
  option; the values are in `CONTROL_STATUSES`; every refusal code has
  Hebrew.
- **Partial / remaining:**
  - the form shows the reported amount and the live remaining balance;
  - an out-of-range draft shows the whole amount open;
  - the partial row shows verified / of / remaining;
  - «לא שולם» shows the whole amount open.
- **Remaining-debt math:**
  - the «יתרה פתוחה» card = `openDebt` (8,000 = 4,000 + 4,000);
  - «אומת החודש» = 8,500;
  - `normalizeReceipt` keeps the new fields.
- **Escaping:** the note, the flag note, fields and a hostile id; for Ortal,
  for Vered and in the editor.
- **The note:**
  - «+ הערה» on every row type for a decider;
  - none for Vered, who still reads the note;
  - nothing in Sandra's exceptions.
- **No duplicate ids:** a partial receipt in the month list has no control.
- **Permissions (page):**
  - Ortal: «בקרת גבייה» first, «גבייה» only with `billingRead`;
  - a restricted session never gets either.
- **Wiring:** index.html, CSS (read-only, RTL, mobile), the body class, SW
  v40.
- **Pro-bono in Ortal's read-only «גבייה»:**
  - the same answer as for Vered, before and after the funder's start;
  - none for a restricted session;
  - `loadBillingRead` keeps the Funders rows.
  - Two hand mutations — the old gate restored, and the funders not loaded —
    each fail this test.

**New: `test/ortal-verification-status-browser.test.js`.** Real Chromium at
360px, with the real server.js and Code.gs.
- **Ortal, «גבייה»:**
  - the row and its receipts are shown;
  - zero write controls;
  - no sideways scroll.
- **Ortal, «בקרת גבייה», «שולם חלקית»:**
  - the dropdown labels;
  - the amount field is LTR, the dropdown RTL;
  - 18,000 of 18,000 → an inline error and nothing sent;
  - 5,000 → «יתרה פתוחה: ₪ 13,000» live, and the stale error clears;
  - saved → the «שולם חלקית» list, the card and the heading total;
  - Code.gs holds `partial` / 5,000 / אורטל.
- **The note:**
  - `<img src=x onerror=…>` is saved and shown as text;
  - no `<img>` in the DOM, the handler never ran;
  - stored verbatim;
  - the status is unchanged;
  - the audit rows are `payment_confirm_partial` and
    `payment_control_note`.
- **«שולם» on the other receipt** saves at once.
- **Vered:** read-only, sees the remaining balance and the escaped note.
- **Shiran:** neither tab; `getPayments` / `getCredits` → 403.
- No page errors.
- Screenshots: `docs/screenshots/ortal-verification-status/`.

**Updated** (they pinned the ✓ / ⚑ UI, Ortal's single tab, the body class
or SW v39):
- `billing-control-tab-browser`:
  - Ortal's tabs are now «גבייה» + «בקרת גבייה»;
  - only her allow-listed actions are called;
  - the dropdown drives «שולם» / «לא שולם»;
  - Sandra and Vered selectors.
- `billing-control-tab`:
  - the queue card has the dropdown, not ✓ / ⚑;
  - the confirmed list has controls for a decider and none without the
    role;
  - the body class.
- `dashboard-perf-assets`: SW v40.

**Full suite: 2278 / 2278 passing** (2268 after PR 1, plus 10), every
browser test running.

---

## Choices I made (ambiguous points — the safest reasonable option)

1. **«שולם» saves on selection.** «שולם חלקית» and «לא שולם» need a value,
   so they open a form. The dropdown never shows an unsaved status.
2. **Bulk «אשר את כל המסומנים» stays.** It is bulk «שולם».
3. **«הסר דגל» stays on «לא שולם» rows** (Phase 4). It moves the receipt
   back to waiting.
4. **The dropdown and the note are on every row type** (queue, «לא שולם»,
   «שולם חלקית», «אומתו»). A partial receipt in the «אומתו» month list is
   display-only; it is edited in its own list.
5. **Ortal's «גבייה» is the same screen in view mode**, not a copy. Write
   controls are never drawn, and CSS hides them as a second line. The
   server refuses them regardless (PR 1).
6. **«השלמת גורם מממן» is not shown to Ortal.** It is data entry.

## For Sandra

Nothing to set. After both PRs are merged, Railway deploys, and the clasp
CI deploys PR 1's Code.gs.

## For Ortal

*(Simple English, for her guide.)*

**New tab: «גבייה»**

- You can look at everything there: who owes, what was received, credits,
  old debts, and the Excel exports.
- You cannot change anything there.

**In «בקרת גבייה», each payment now has a «סטטוס» list:**

- **שולם** — the full amount is in the bank. It saves at once.
- **שולם חלקית** — only part arrived.
  1. Type how much arrived. The box shows the rest that is still open.
  2. Tap **«שמירת תשלום חלקי»**.
  3. The payment moves to **«שולם חלקית»**, and the open rest is counted
     in **«יתרה פתוחה»**.
  4. When the rest arrives, choose **שולם**.
- **לא שולם** — nothing arrived. Write what is wrong (required).

**Notes**

- **«+ הערה»** adds your own note to any payment, for example «העברה שנייה
  צפויה ביום ה׳». It is optional, up to 500 characters, and you can edit it
  any time.

Every change is saved in the history (who, when, before, after).
