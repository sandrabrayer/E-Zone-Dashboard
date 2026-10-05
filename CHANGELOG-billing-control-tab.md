# «בקרת גבייה» — Ortal's verification tab and her login (Phase 4)

Plan: `docs/billing-control-plan.md`, Phase 4, §7, §11, §14.1. Builds on
Phase 3 (#173, #176). Branch `feat/billing-control-tab` → base
`claude/build-ezone-dashboard-QOg5s`. `apps-script/Code.gs` changes are in
their own commit (the clasp CI deploys them on merge). Service worker
`CACHE_VERSION` **v32 → v33** (built as v31; rebased onto PR #178,
which shipped v32 — the patient funder on the Funders sheet).

**What users see after this PR:**

- **Ortal** can log in with her own code. She sees **one tab, «בקרת גבייה»**,
  and «יציאה». Nothing else exists on her page.
- **Vered and Sandra** get a new tab «בקרת גבייה», right after «גבייה».
  Vered sees it read-only. Sandra can also confirm, and sees the extra
  section «חריגים פתוחים» (read-only).
- **הכנסות חודשיות** has a new card, **«מאומת»**, next to «נגבה».
- **Shiran and Yael:** nothing changes. They never see the tab.
- An old cached page that still tries to type a paid amount gets a clear
  message: «יש לדווח תשלום דרך ״דווח תשלום״».

---

## What Sandra decided (2026-10-04)

| | Decision |
|---|---|
| A | Ortal gets a personal code with role `controller` only. She sees ONLY «בקרת גבייה» (plus logout). |
| B | Per receipt: `reported` → `confirmed` / `flagged`, by controller or approver only. `flagged` needs a 2–300 character note. Append-only: `confirmedBy/At` stamped once; every later change is an AuditLog row (old, new, actor). |
| C | The tab: the queue, «סומנו כבעיה» (with «הסר דגל»), «אומתו» by month and house = «הכנסה מאומתת», four summary cards, two exports. |
| D | הכנסות חודשיות gains «מאומת» next to «נגבה». Shared revenue rules unchanged; Outpatient untouched. |
| E | Sandra's read-only «חריגים פתוחים» inside the tab. |
| F | Ortal's digest: «ממתינים לאימות: N» with a link to the tab. |
| G | `confirmPayment` and `billingControlQueue`, both `PROXY_SECRET`, not open; `/api/export/billing-control.xlsx`. Shiran / Yael and staff-only sessions → 403. |
| H | The old direct `amountPaid` write is refused for cycles with no receipts too (`use_report_payment`). |

---

## How it works

### Who sees what

| Session | `/api/me` `view` | Tabs | May confirm / flag |
|---|---|---|---|
| Ortal | `controller` | «בקרת גבייה» only | ✓ (`controller` role) |
| Sandra | `full` | all 12 | ✓ (`approver`), plus «חריגים פתוחים» |
| Vered | `full` | all 12 | ✗ (read-only queue) |
| Shiran, Yael | `restricted` | 7, no «בקרת גבייה» | ✗ (403) |

`/api/me` adds `capabilities`, `billingControl`, `view` and `canConfirm`.
Display only — every decision is made again on the server and in Code.gs.

### `lib/`

- **`lib/users.js`:**
  - `ortal` is `active`, roles `['controller']` (no staff).
  - New capability `billingControl`: Vered and Sandra (`['finance',
    'billingControl']`) and Ortal (`['billingControl']`). Derived by stable
    id, like `finance`, so no live `USER_PIN_HASHES` line changes.
  - `isControllerView(principal)` and `principalView(principal)`.
- **`lib/finance-scope.js`:** `BILLING_CONTROL_ACTIONS`
  (`billingControlQueue`, `confirmPayment`), and Ortal's **exact
  allow-list**:
  - `CONTROLLER_ACTIONS`: `billingControlQueue`, `confirmPayment`,
    `debtAging`. `debtAging` is there only because the «חובות פתוחים» export
    the tab links to reads it.
  - `CONTROLLER_ROUTES`: `/api/me`, `/api/logout`, `/api/verify-pin`,
    `/api/login-users`, `/api/sheets`, `/api/export/billing-control.xlsx`,
    `/api/export/debt-aging.xlsx`.
- **`lib/role-scope.js`:** `confirmPayment` needs `controller` **or**
  `approver`.
- **New `lib/billing-control-rules.js`:** pure. Used by the page (served at
  `/billing-control-rules.js`) and by the workbook. It holds:
  - the queue order and the status views;
  - the summary cards;
  - the flag-note check;
  - **«הכנסה מאומתת»** — confirmed receipts allocated to a month by their
    coverage window, day by day, with the same arithmetic as `revenueAllocate`.
- **New `lib/billing-control-xlsx.js`:** the «ייצוא אימות» workbook. Four
  sheets: סיכום, ממתין לאימות, סומנו כבעיה, and אומתו — one section per month
  with that month's total.

### `server.js`

- **`controllerRouteLock`** runs before every route. For Ortal's session,
  any `/api/` path outside `CONTROLLER_ROUTES` → `403`, before any handler
  runs. That also covers routes added in the future. Pages and static files
  pass.
- **`requireBillingControlForAction`** on GET and POST `/api/sheets`:
  - Ortal: any action outside `CONTROLLER_ACTIONS` → `403`. That includes
    `getData`.
  - `BILLING_CONTROL_ACTIONS` without `billingControl` (Shiran, Yael) → `403`.
  - Nothing is proxied in either case.
- `confirmPayment` from Vered → `403 forbidden_role` (role check before
  proxying).
- New route `GET /api/export/billing-control.xlsx` (`requireSession` →
  `requireBillingControl` → `requireProxySecret`). It is `no-store`, and the
  log carries the outcome only.
- `/api/export/debt-aging.xlsx` now allows finance **or** the controller
  view.
- `index.html` is served with `<body class="view-controller">` to Ortal.
  Nothing from another tab ever paints.
- The old cookie and legacy paths are untouched.

### `apps-script/Code.gs` (own commit)

- **The second lock:**
  - `viewRefused_` (in `handle_`, before any read or write): Ortal's actor
    reaches only `CONTROLLER_ACTIONS`.
  - The tab's actions need `billingControl`.
  - The controller view is decided by **id** (`CONTROLLER_USER_IDS`), never
    by caps. A forged `proxyCaps` cannot widen her, and a narrowed one leaves
    her with nothing.
- **`confirmPayment`** — body `{ ids: [rcpt-…] (1–200), status, flagNote }`.
  - Needs the verified `controller` or `approver` role.
  - **Atomic:** every id is checked first (it exists, is a receipt, is not
    void, and has a `receivedDate`). One problem → refused, and nothing is
    written.
  - Only the four confirm cells move.
  - `confirmedBy/At` are stamped at the **first** confirmation and are never
    re-stamped or cleared.
  - Each change writes one AuditLog row `payment_confirm_<to>`, with `from`,
    `to`, the old and new note, `by`, `at` and the actor.
  - «הסר דגל» clears the note on the row. The AuditLog keeps it.
- **`billingControlQueue`** — read-only: no lock, no write, no sheet
  created. It returns:
  - every live receipt (allow-listed fields, newest first);
  - the counts and ₪ per status;
  - `debt60`: the 61+ bucket of `debtAging_` as of today, recorded and
    unrecorded kept apart;
  - for the approver only, `exceptions`:
    - receipts flagged more than 7 days ago (flag time from AuditLog,
      falling back to `recordedAt`);
    - debts over 60 days;
    - refund exceptions: the forecast's «ממתין להחלטה» stays, and pending
      credits above their `calculatedAmount`.
- **Item H:** `legacyMoneyWriteRefused_`. On the HTTP save path (`savePayment`
  / `updatePayment`), a request that changes a cycle's `amountPaid` or its
  paid / partial / unpaid status → `{ok:false, error:'use_report_payment'}`,
  with nothing written. These still work:
  - linking;
  - the coverage period;
  - an unpaid placeholder;
  - a void, and Sandra's un-void.
- **The digest** gains the line «ממתינים לאימות: N · לטאב «בקרת גבייה»»,
  linking to `/#billing-control`, in both the HTML and the text part. It is
  a count only — no name, no amount.

### The page (`public/`)

- **The tab** is built for phones: one card per receipt (date received,
  patient, house, amount, method, reference, payer, funder, recorded by).
  - Ortal and Sandra get ✓ «אושר בבנק», ⚑ «לא נמצא / בעיה» (opens a note
    field with an inline Hebrew error), a «סמן» box per card, «סמן הכל» and
    «אשר את כל המסומנים».
  - Flagged cards have «הסר דגל».
  - «אומתו» has month and house filters and the «הכנסה מאומתת» total.
  - Sandra also sees «חריגים פתוחים», with no control in it.
  - The tab badge shows the waiting count.
- **The controller view:** every other tab button, screen and billing widget
  is **removed from the DOM**, and `loadAll` asks only for
  `billingControlQueue`.
- **הכנסות חודשיות:** `buildMonthlyRevenue` returns a new, separate
  `verified` field. It is not part of «נגבה», «נטו» or the breakdown. The
  «מאומת» card shows it ex-VAT, like the other cards.
- `#billing-control` deep link (the digest's link) opens the tab.
- `sw.js` v33; `/billing-control-rules.js` network-first (next to #178's
  `/funder.js`, which stays).

---

## Tests

**New: `test/billing-control-tab.test.js`** (32 tests). They run the real
Code.gs, server.js, app.js and the libs.

- **Lists:** Code.gs and `lib/` hold the same lists. `OPEN_ACTIONS` is
  unchanged. `confirmPayment` is in neither `DELETE_ACTIONS` nor
  `APPROVER_ACTIONS`.
- **Gate:** without `PROXY_SECRET` (enforce) both actions are refused, with
  nothing written.
- **Transitions and audit:**
  - confirm (stamps, one audit row, amount untouched);
  - re-confirm is a no-op;
  - stamps are never re-stamped by a later change;
  - flag → «הסר דגל» → flagged → confirmed;
  - **the note rule**: missing, blank, 1 character, formula-only and 301
    characters are refused; exactly 300 is accepted;
  - **bulk** confirm, and atomicity: an unknown, void or non-receipt id, an
    empty list or 201 ids refuse the whole batch with nothing written;
  - who decides: Ortal and Sandra yes; Vered `forbidden_role`; Shiran
    `forbidden`; a forged body role and a narrowed Ortal are refused.
- **The queue:**
  - newest first;
  - counts and ₪;
  - voids left out;
  - the exact allow-listed keys;
  - read-only (no lock, no write);
  - exceptions for the approver only.
- **«חובות מעל 60 יום»:** the pure rule.
- **«חריגים פתוחים»:**
  - flagged older than 7 days, by the AuditLog time (10 days listed, 3 days
    not, exactly 7 not);
  - over-policy credit;
  - the forecast's «ממתין להחלטה».
- **The controller view in Code.gs:** a scan over `PROXY_KNOWN_ACTIONS`. Every
  action except her three is refused, with nothing written. `getData` is
  refused. A forged finance cap does not help her, and a narrowed cap leaves
  her nothing.
- **Item H:**
  - new paid / partial rows, `updatePayment`, an amount move and a status
    move are all refused with nothing written;
  - a placeholder, the coverage period, linking, a void and Sandra's un-void
    still work;
  - plus the pure rule.
- **Digest:**
  - the count (a confirmed or void receipt and the cycle row are not
    counted);
  - the line and the link in the HTML and the text, in both mail shapes;
  - no line when the count is unknown;
  - the real preview run.
- **«מאומת»:**
  - the lib allocation equals `revenueAllocate` day for day on four windows;
  - real Code.gs → `getPayments` → app.js `buildMonthlyRevenue`: 0 before
    any confirmation, exactly the receipt's slice after one, and **equal to
    «נגבה» in both months** once all are confirmed;
  - the tab's lib figure agrees;
  - NET is unchanged;
  - `null` without receipts.
- **lib views:** order, house filter, voids, summary cards, note check,
  months.
- **The page:**
  - the controller view opens only the tab;
  - restricted sessions never get it;
  - the decision controls appear only with `canConfirm`;
  - Sandra's section has no button, input, textarea, select or decision
    attribute;
  - the cards;
  - the wiring (HTML, the route, SW v33, CSS);
  - «קוד אישי חדש» labels אורטל «(חדש)».
- **server.js:**
  - Ortal → 403 on **every** non-allowed action (GET and POST, over
    `PROXY_KNOWN_ACTIONS` plus an unknown and a blank action) and on **every**
    non-allowed Express `/api/` route (a scan of `app._router`), with nothing
    proxied;
  - her three actions reach Apps Script with her principal;
  - `/api/me`; the xlsx; `body.view-controller`;
  - the debt-aging export works for her;
  - Shiran and Yael get 403 on both actions and the export;
  - Vered: queue 200, `confirmPayment` `forbidden_role`;
  - Sandra decides; Vered and Sandra keep every other route;
  - a narrowed Ortal record keeps the view but cannot decide; a revoked one
    gets 401.
- **Workbook:** the four sheets, RTL, the columns, formula-guarded, a section
  per month with its total, `Content-Disposition`, and a bad answer → 502 /
  403 / 503 with no half file.

**New: `test/billing-control-tab-browser.test.js`.** Real Chromium at 360px,
with the real Code.gs behind the proxy.

- **Ortal:**
  - exactly one tab and one screen in the DOM, no `getData`;
  - the queue newest first, with every column;
  - ✓ one: it moves to «אומתו», the card counts it, and the toast shows;
  - ⚑ the other with an empty note: an inline error, `aria-invalid`, nothing
    sent;
  - with a note: it moves to «סומנו כבעיה» and «הסר דגל» appears;
  - Code.gs holds both decisions, stamped «אורטל», with two audit rows;
  - a direct `fetch` of `getData`, `getPayments` or the cleanup export → 403;
  - no sideways scroll and no page errors.
- **Sandra:** «חריגים פתוחים» with no control; ✓ in the queue; «מאומת» on
  הכנסות חודשיות.
- **Vered:** read-only.
- **Shiran:** no tab, and the deep link falls back.
- Screenshots: `docs/screenshots/billing-control-tab/`.

**Updated** (they pinned the old lists, Ortal inactive, the caps, the tab
count, SW v30 or the old money path):

- `accounting-source-feed`, `payment-coverage-period`,
  `payment-report-foundation`, `personal-pins-cleanup`,
  `personal-pins-foundation`: item H. The money now goes in the way legacy
  data sits on the sheet (a direct `upsertPayment_`), or the test asserts the
  refusal.
- `detached-payments`, `duplicate-payment-void`, `payment-coverage-period`,
  `payment-report-foundation`: `confirmPayment` in the payment action list.
- `meetings-tab-shell`, `detached-payments`, `restricted-view-browser`: the
  tab order (12 tabs).
- `personal-pins-foundation`, `personal-pins-login`: Ortal is active; she
  appears in «קוד אישי חדש» and her line validates; `/api/me` fields.
- `restricted-view`, `cleanup-export-finance`: the `billingControl` cap.
- `ortal-daily-digest`: the second link.
- `lock-busy-frontend`: `confirmPayment` gets the busy-lock retry tests.
- `payment-report-form`: SW "v30 or later".

**Full suite: 2083 / 2083 passing** (2047 on the base + 36), every browser
test running.

---

## Choices I made (ambiguous points — the safest reasonable option)

1. **Ortal's view is decided by her stable id, not by caps or roles.** A
   narrowed record can only take things away (no `controller` role → she
   still sees only the tab, but cannot decide). A forged `proxyCaps` cannot
   widen her.
2. **`getData` is refused for Ortal**, on both sides. `billingControlQueue`
   is the whole payload her tab needs (no patient or lead list).
3. **The route lock is an allow-list on every `/api/` path**, so a route
   added later is closed to her by default. The meeting-report micro-app has
   its own cookie and lock, so it is left alone.
4. **`debtAging` is on Ortal's allow-list**, because the «חובות פתוחים» export
   she is linked to reads it. It is read-only.
5. **Sandra (approver) may confirm and flag too** (decision B). Vered sees the
   tab read-only.
6. **`confirmedBy/At` = the first confirmation only.** Flagging does not
   stamp them. The flag time comes from the AuditLog (used for the 7-day
   rule, with `recordedAt` as the fallback). No new column was added.
7. **Every transition is allowed to controller / approver**, including
   un-confirming (confirmed → reported / flagged), and each one is audited.
   The page does not offer «בטל אישור» — only «הסר דגל» on flagged cards, as
   asked. If needed, that button is a small follow-up.
8. **«הסר דגל» clears the note on the row.** The AuditLog keeps the old note.
9. **Bulk confirm is atomic** (all or nothing), and at most 200 ids.
10. **Month and house filters on «אומתו» allocate by coverage**, like «נגבה».
    A receipt that spans two months appears in both, with its share.
    Amounts in the tab include VAT (as reported). The «מאומת» card on
    הכנסות חודשיות is ex-VAT, like its neighbours.
11. **Ex-VAT «מאומת» is rounded per receipt** (the screen's per-row rule), so
    it can differ from «נגבה» by agorot on the same money. Incl. VAT, the two
    are exactly equal.
12. **«חובות מעל 60 יום»** shows recorded debt as the main figure, with
    unrecorded cycles on a second line, never added together (the
    debt-aging rule).
13. **Refund exceptions** are the forecast's «ממתין להחלטה» stays, plus
    *pending* credits whose amount is above their stored `calculatedAmount`.
14. **Item H applies to the HTTP path** (`savePayment` / `updatePayment`
    through `handle_`). An editor-run direct call has no HTTP caller and keeps
    its behaviour. Echoes of the stored figures pass (linking, coverage,
    an override frozen on an unpaid cycle). A void and Sandra's un-void are
    not money writes.
15. **The digest line is a count only** (no name, no amount). It sits right
    after the heading, so the existing «אין תשלומים חדשים» stays first.
16. **The tab loads when opened**, not on every page load, for Vered and
    Sandra. Ortal's page loads it at start.
17. **Branch name:** `feat/billing-control-tab`, as asked. The session's
    default branch was a different auto-generated name.

## For Sandra

1. **After the merge** (the clasp CI deploys Code.gs; Railway deploys the
   rest), open the dashboard → **«קוד אישי חדש»** → choose **אורטל (חדש)** →
   type a 6-digit code twice → **«יצירת שורה»** → **«העתקה»**.
2. Railway → the dashboard service → Variables → `USER_PIN_HASHES` → add a
   comma after the last record and paste the line before the `]` → save.
   Railway restarts.
3. Give Ortal the code **in person or by phone** (not WhatsApp, not email).
4. Tell her: «בכניסה לדשבורד לוחצים על השם שלך (אורטל) ומקלידים את הקוד. יש לך
   טאב אחד, בקרת גבייה. כל תשלום שוורד מדווחת מופיע שם; בודקים בבנק ומסמנים
   אושר או בעיה.»
5. Nothing else to set: no env var, no Script Property, no column, no trigger.
   Her morning email gains a «ממתינים לאימות» line by itself.
6. Your own view: in «בקרת גבייה», the section **«חריגים פתוחים»** at the
   bottom is read-only. It lists problems open more than 7 days, debts over
   60 days, and refunds waiting for your decision.

## For Ortal

*(Simple English, for her guide.)*

**Logging in**

1. Open the dashboard. Tap your name, **אורטל**.
2. Type your 6-digit code (Sandra gives it to you). You see one tab:
   **«בקרת גבייה»**.

**Every morning**

1. The four boxes at the top tell you:
   - **ממתין לאימות** — how many payments wait for you, and how much money;
   - **סומנו כבעיה** — the ones you marked as a problem;
   - **אומת החודש** — the money you confirmed this month (this is the real
     income);
   - **חובות מעל 60 יום** — old debts. «ייצוא חובות לאקסל» downloads the
     list.
2. Under **«ממתין לאימות»** each payment shows: the date received, patient,
   house, amount, method, reference, payer, funder, and who recorded it. The
   newest is on top.
3. Check each one **in the bank's website** (outside the dashboard).
   - Found it, same amount → tap **✓ «אושר בבנק»**. It moves to «אומתו».
   - Not found, or a different amount → tap **⚑ «לא נמצא / בעיה»**, write
     what is wrong (for example «הגיע 29,500 ולא 30,000»), and tap **«שמירת
     הבעיה»**. A note is required (2 to 300 characters).
4. Many payments OK at once? Tick **«סמן»** on each one (or **«סמן הכל»**)
   and tap **«אשר את כל המסומנים»**.

**Problems («סומנו כבעיה»)**

- Vered fixes them: she cancels the payment and reports it again. The new
  report comes back to your queue. The old one stays in the history.
- Marked by mistake? Tap **«הסר דגל»** — it goes back to «ממתין לאימות».

**Confirmed («אומתו»)**

- Choose the **month** and the **house**. The total at the top is the
  confirmed income for that month («הכנסה מאומתת»).

**Excel**

- **«ייצוא אימות»** (top of the tab) downloads one file with three lists:
  waiting, problems, and confirmed by month.

**Email**

- Your morning email now starts with **«ממתינים לאימות: N»** and a link
  straight to this tab.
