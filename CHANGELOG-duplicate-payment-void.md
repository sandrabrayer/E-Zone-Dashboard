# כפילות — a payment entered twice, voided and never deleted

A patient is renamed after their first payment is recorded. The payment
detaches — it is keyed `houseId::name::entryDate` — nobody notices, and the
money is entered again under the new name. Three confirmed pairs in the live
sheet, all the same shape: same house, same entry date, same amount, a name
that grew.

| The duplicate | The original it duplicates |
| --- | --- |
| `arfoni::ערן::2026-08-09` — ₪35,000, entered 9/8 | `arfoni::ערן יצחק חונה::2026-08-09` — ₪35,000, entered 17/8 |
| `rehab::עדי::2026-09-14` — ₪35,000, entered 15/9 | `rehab::עדי עמית::2026-09-14` — ₪35,000, entered 17/9 |
| `arfoni::עמית יעקובי::2026-09-07` — ₪30,000, entered 8/9 | `arfoni::עמית בורנשטיין::2026-09-07` — ₪30,000, entered 15/9 |

The שיוך תשלומים screen already found these pairs and warned about them
(`CHANGELOG-detached-payments.md`). It could only offer two answers — link it,
or say it is not a patient — and **neither is true**. This adds the third.

---

## The row is never deleted

Deleting the duplicate is the obvious move and the wrong one. That row is the
**only evidence anyone will ever have** that ₪30,000 was *entered* twice rather
than *collected* twice. A year from now, with the row gone, nothing in the
sheet distinguishes the two.

So it is marked **void** — `status: 'void'` — and it keeps everything else
exactly as recorded: its `amount`, its `amountPaid`, its `balance`, its dates,
its coverage period and its stored triple. A test pins all ten fields as
byte-identical across the void, and asserts the write path contains no
reference to `amount:`, `amountPaid:`, `balance:` or `coverageStart:` at all.

### `void` is an *aliased* status, not an unknown one

`normalizePayment()` maps an unrecognized status to `'unpaid'`. Without the
alias, a void row read back from the sheet on the next load would **silently
un-void itself** and its money would walk straight back into every figure.
Both sides learned it:

```js
PAYMENT_STATUS_ALIASES  = { …, 'מבוטל': 'void', 'void': 'void' }   // app.js
PAYMENT_STATUS_ALIASES_ = { …, 'מבוטל': 'void', 'void': 'void' }   // Code.gs
```

It is deliberately **not** in `PAYMENT_STATUS`, the three-option גבייה
dropdown. Voiding is a decision taken against a named original, with a reason,
on the reconnect screen — never a fourth option one click away from "לא שולם".
A void row still renders its status on the גבייה row, pinned on as a disabled
option so it cannot fall back to whichever option happens to be first, and the
row's controls stay disabled: the way back is the screen where the decision was
taken and where the audit trail lives.

---

## Excluded from every revenue, debt and alert figure

One predicate, so "excluded everywhere" is a property of the code rather than a
promise in a changelog:

```js
function isVoidPayment(pay) { return !!pay && String(pay.status || '') === PAYMENT_VOID_STATUS; }
```

A test asserts it is declared exactly once (`app.js` is one flat script scope)
and that **eight named consumers** each call it:

| Where | What changes |
| --- | --- |
| **הכנסות חודשיות** — the payments pass | a void row contributes to no RECEIVED, EXPECTED, NET or per-house figure |
| **הכנסות חודשיות** — the billed-cycle index | a void row does not *claim* its cycle either. If the only row for a cycle was voided, that cycle has no payment behind it and returns to the projected pass — which is the honest answer |
| **credits ledger** | `suggestCredits` skips it: crediting against a void row would refund a patient for money they never paid twice |
| **גבייה KPI cards** | out of **סך לגבייה** *and* out of **נגבה**. Unlike the records cutoff — which leaves נגבה alone because a recorded payment really did arrive — a void row's `amountPaid` is the **second copy of a sum already counted on its twin** |
| **יתרות פתוחות** | filtered explicitly, not just by the status whitelist |
| **סיכום חודשי** | both figures and the per-house breakdown, with a muted line saying how many rows were set aside |
| **overdue + renewal alerts** | via a new shared `paymentCoversCycle()`, so the two alerts cannot drift apart |

**It is still listed.** The גבייה row renders with a struck-through **מבוטל**
badge. A row that vanished from every screen would be indistinguishable from
one that had been deleted, and deleting is precisely what this refuses to do.

---

## The decision, and what is shown before it

### כפילות leads exactly where the warning is

A candidate that already has a payment for the same cycle carries the
double-entry warning from the previous change. On that candidate **כפילות
becomes the primary action and שייך steps down to secondary** — offered, never
removed, because the pair *can* be a rename whose first row was simply never
linked. Only a person knows which.

### Side by side, before anything is written

Clicking כפילות opens a comparison, not a confirmation. Both payments are
rendered **field for field in the same order** — name as recorded, house, due
date, amount, amountPaid, status, row id, stored triple — because the only way
to tell a duplicate from two genuine payments in the same month is to read them
against each other. The panel to be voided is amber; the survivor is green.

Two derived flags sit underneath: **אותו סכום** and **אותו מחזור**, each turning
amber when it is *not* true. Those are the two ways a "duplicate" turns out not
to be one.

The note is pre-filled with a sentence naming the original — its id, the
patient, the due date and the amount — so the pair can be reconstructed from
the sheet alone long after this screen has forgotten them. It is editable, and
required.

---

## Reversible by Sandra only

Marking a duplicate is ordinary daily work. **Unmarking one puts a second
payment back into every revenue and debt figure**, which is a money decision.

```js
const PAYMENT_VOID_REVERSERS = ['סנדרה'];   // mirrored in app.js and Code.gs
```

The **server is the authority**. `upsertPayment_()` compares the row the sheet
actually holds against the name in the **signed session cookie** (via
`requestUser_`, never the request body) and refuses before a single cell moves:

```
prev.status is void  AND  incoming status is not  AND  user not in the list
  → { ok: false, error: 'החזרת כפילות מותרת לסנדרה בלבד' }
```

The client's copy of the list only decides whether the control is **offered**.
Everyone else sees `לביטול הסימון — פנו לסנדרה` instead of a button that would
be refused — the repo's own existing idiom (`meeting-report.js`,
`CREDIT_RULE_LABELS`'s "חריגה באישור סנדרה").

The restored status is **derived from the money still on the row**
(`paid` / `partial` / `unpaid` from `amountPaid` against `amount`), which is
exact precisely because voiding never touched those fields. No column was added
to remember it.

### ⚠️ Sandra is not currently a session user — flagged

`SESSION_USERS` is `['ורד', 'שירן', 'יעל']`. `'סנדרה'` is not among them, so as
shipped **no current login can reverse a void through the UI**. That is the
literal reading of "reversible by Sandra only", and it is deliberate: adding
her to `SESSION_USERS` is a separate decision about who may log into the whole
app, and not one to take unilaterally inside this change. It is one line in
`public/app.js` and one in `lib/users.js` when you want it. Until then the
reversal exists, is enforced and is tested — it simply has no one to run it.

---

## Every decision is logged

Two audit actions, both fail-soft by the `logAudit_` contract:

* `payment_link_duplicate` — the void, with the payment id, its uid, the
  triple, house, due date, **amount**, the note, and who/when.
* `payment_void_reversed` — its own row on an un-void, carrying the restored
  status and the note that was cleared. Un-voiding is the rarer and more
  consequential of the two; searching the log for it should not mean filtering
  link decisions by what they used to be.

`linkedBy` / `linkedAt` are in `PAYMENT_SERVER_COLUMNS`, so whatever the
payload carried is dropped before anything reads it, and they are re-stamped
**only when the decision itself changed** — an unrelated save must not turn the
audit trail into a record of the last time anybody touched the row.

---

## Server refusals (PR #124 parity)

**No new endpoint** — every write rides the existing `savePayment`; `server.js`
is untouched. Three refusals, each returned verbatim, each checked *before the
lock is taken*:

| Refused | Why |
| --- | --- |
| `status: 'void'` without `linkStatus: 'duplicate'` | a void with nothing behind it reads, a year later, exactly like a mistyped status |
| `linkStatus: 'duplicate'` without `status: 'void'` | the two are one decision and may never be separated |
| `duplicate` with no note | a decision nobody can audit |
| an un-void by anyone but Sandra | see above |

Everything the new UI renders is escaped, including both names printed
verbatim; the note is set as an input **value**, never interpolated into
markup. No new static markup in `index.html` — the modal and the badge are
built by the renderer.

## Decisions taken without asking (flagged)

1. **The amounts are kept, not zeroed.** Zeroing would make the row tidy and
   destroy the evidence that a second ₪30,000 was ever entered.
2. **A void row still appears on the גבייה daily list**, badged and locked,
   rather than being treated as absent. The alternative — returning a fresh
   placeholder for its cycle — risks a later save overwriting the void row at
   the same id and silently destroying an audited decision.
3. **The accounting source feed (#139) still sees void rows.** They carry
   `status: 'void'`, and the accounting app may already have reconciled that
   money; hiding the row would hide exactly what it needs to know.
4. **Un-voiding restores a derived status** rather than a remembered one — no
   new column, and exact because the money was never touched.

---

## Files

| File | Change |
| --- | --- |
| `public/app.js` | `PAYMENT_VOID_STATUS` / `PAYMENT_VOID_LABEL` / `PAYMENT_VOID_REVERSERS`; the `'void'` alias; `isVoidPayment`, `paymentCoversCycle`, `canReverseVoid`, `statusFromAmounts`; exclusions in the revenue pass, the billed-cycle index, credits, all three debt screens and both alerts; `markPaymentDuplicate`, `reversePaymentVoid`, `duplicateVoidNote`, `duplicatePanelHtml`, `showDuplicateConfirm`; the candidate's primary-action swap; the void badge and locked controls on the גבייה row; the כפילויות section; `state.sessionUser` |
| `public/style.css` | the void badge, the locked note, the side-by-side comparison |
| `apps-script/Code.gs` | `PAYMENT_VOID_STATUS`, `PAYMENT_VOID_REVERSERS`, the alias + `isVoidStatus_`, `'duplicate'` on `PAYMENT_LINK_STATUSES`, the three refusals, the reversal guard, `logPaymentVoidReversed_` |
| `test/duplicate-payment-void.test.js` | **new** — 24 tests |
| `test/duplicate-payment-void-browser.test.js` | **new** — 6 Playwright/Chromium tests |
| `test/loading-feedback-rollout.test.js` | the coverage guard learns `showDuplicateConfirm` as a modal opener, plus a behavioural assertion that its confirm button carries the busy state |
| `test/detached-payments.test.js`, `test/stay-window-records-cutoff.test.js` | the pinned handler markup and KPI filters, updated where the void clause joined them |

## Tests

`test/duplicate-payment-void.test.js` — 24 tests, vm-sandboxed on the real
shipped `app.js` **and** `Code.gs`, TZ `Asia/Jerusalem`:

* **A** `void` survives the round-trip on both sides (and the unknown-status
  fallback is still there, which is *why* the alias matters); it is not a
  dropdown option; one predicate, eight consumers.
* **B** the revenue screen counts ₪24,000 instead of ₪48,000 for the September
  pair; a void row does not claim its cycle; a voided payment refunds nothing.
* **C** all three debt screens, and the row still listed.
* **D** a void row never silences an alert, and voiding the only payment for a
  cycle brings the overdue alert back.
* **E** all three live pairs recognised; the row's ten fields byte-identical
  across the void; the note naming the original; the three server refusals;
  the audit row.
* **F** the server refuses an un-void from ורד and allows it for סנדרה, the
  reversal's own audit row, and the client offering the control to neither
  more nor fewer people.
* **G** the primary-action swap, the side-by-side panels and their flags, the
  decided section.
* **H** no new endpoint, everything escaped, inputs byte-identical.

`test/duplicate-payment-void-browser.test.js` — 6 Chromium tests, driving the
עמית יעקובי / עמית בורנשטיין pair: כפילות leading with שייך still offered, the
comparison rendering with nothing written until confirmed (and cancel leaving
the row alone), **the revenue figure moving ₪40,678 → ₪20,339 on screen** while
the POST body keeps `amount` and `amountPaid`, the voided row leaving the
worklist and locking its undo for ורד, Sandra getting the button and the money
coming back, and the גבייה row rendering מבוטל with its controls disabled.

Full suite: **1,441 passing**.

## Deploy note

`apps-script/Code.gs` changed, so the Apps Script backend **must deploy**. No
new columns, no migration, no backfill — `status` is an existing column and
every historical row keeps whatever it already holds.
