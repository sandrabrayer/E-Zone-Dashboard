# Billing override: carry-row editor — the ✏️ was unreachable in practice

Fixes the live bug after #79: an unpaid patient's row (e.g. מעיין אברהמי,
₪30,000, לא שולם) showed no ✏️ — the override editor was unreachable.

## Root cause (investigated first)

Not CSS and not a render failure. The PR-2 editor was gated by
`!isCarryForward` (`buildBillingRow`), and the ONLY list that renders non-carry
rows — the due list — requires an **exact day-of-month match** between the
selected billing date and the patient's entry day (`patientsDueOn`). On any
other day, an unpaid row appears solely as a **carry-forward row** in
יתרות פתוחות — which rendered just the original date, no amount, no editor.
So for most unpaid rows there was nothing to click, ever, unless the user
manually navigated the date picker to the patient's exact due date.

## The fix

- **Carry rows now carry the full editor.** The cell's label line folds in the
  original due date — **"תאריך מקורי · \<date\>"** — and the value line shows
  the amount (override-aware) with the `מותאם` badge, ✏️ pencil, and ↩ clear,
  identical to due rows. `!isCarryForward` dropped from both `hasOverride` and
  `amountEditable`.
- **An edit targets the RECORD's own month.** Carry rows are built with the
  record's `dueDate` as `dueDateISO`, so `saveBillingOverride` keys the
  override to that month (e.g. a June row edits June) — never the selected
  date's month. Month isolation preserved automatically.
- **Orphan guard.** The editor renders only when the row's patient is really
  matched: `patientKey(patient) === payment.patientId`. The
  `findPatientForPayment` fallback pseudo-patient (released/renamed patient)
  gets no editor — an override written under its key could never overlay the
  record.
- **Consistency (approved addition), verified + pinned:** the carry row's
  displayed amount and its יתרה/aggregate contributions already flow through
  the same override-aware path — `renderBillingOpenList` overlays via
  `applyBillingOverride` before building the row (PR 2), and the monthly
  summary overlays before summing. New tests lock it: an overridden carry
  month shows the effective amount everywhere on the row, the base amount
  nowhere, badge + clear present.
- Paid/partial carry rows remain non-editable history. No CSS changes needed
  (all classes reused).

## Tests

`test/billing-override-carry-edit.test.js` — 5 new: matched unpaid carry row
renders the editor with the date-in-label; **an edit writes the record's own
month**; orphaned carry row gets no editor; **consistency** — overlaid carry
row displays the effective amount/balance with badge + clear, base amount
nowhere; paid/partial carry rows stay non-editable.

One intentional assertion update in `billing-override-ui.test.js`
("carry rows offer no editing" → "matched unpaid carry rows are editable
now") — documented change of behavior, not a regression.

Full suite: `npm test` — **455 pass, 0 fail** (450 + 5).

## Deploy + live verification

Frontend only. After merge: open גבייה on any date → מעיין אברהמי's unpaid
row in יתרות פתוחות now shows "תאריך מקורי · \<date\>" plus **₪30,000 ✏️** —
edit it → the override lands on that row's own month, badge appears, יתרה
follows; ↩ restores the base.
