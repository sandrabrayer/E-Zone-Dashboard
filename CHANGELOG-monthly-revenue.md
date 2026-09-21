# Monthly revenue screen (הכנסות חודשיות)

A new tab answering **"how much revenue belongs to month X"**, independent of
when the cash arrived. Added **alongside** the daily גבייה worklist, which is
not modified.

This is the Dashboard half of a **cross-app contract**. The outpatient app
shipped the same view in `ezone-outpatient` PR #109 (`public/monthly-revenue.js`).
The two sets of figures are meant to be added into a network total, so the
allocation rule, the four figures, the never-blend rule and the ex-VAT basis
**must agree exactly**. Divergences forced by this repo are listed at the
bottom and marked `>>> DIVERGES <<<` in the source.

---

## The problem

The daily גבייה screen's `סיכום חודשי` panel does aggregate by month, but it
buckets rows by `monthKey(p.dueDate)` — the month a cycle *started* in, not the
month the money was *earned* in. A patient billed on the 20th has two thirds of
every cycle falling in the following month, so that panel is systematically
wrong about which month owns the revenue, and silent about revenue not yet
collected.

That panel is **deliberately left exactly as it is**. Anything reading it today
keeps reading the same numbers; the new screen is a separate answer to a
separate question.

## The allocation rule

> **Superseded in part — see `CHANGELOG-payment-coverage-period.md`.** The
> window below is now the **default**, not the only answer. A payment row can
> RECORD what it actually covered (`coverageStart` / `coverageEnd`), and
> `paymentCoverage()` honours that when present. Rows written before that
> change carry blank cells and still read exactly as described here, so every
> figure and worked example on this page is unchanged. The pass over stored
> payment rows in `buildMonthlyRevenue` now hands `paymentCoverage()` the whole
> row rather than a `{ dueDate }` stub; the projected pass still uses the stub,
> having no row to read.

A payment's coverage window is `[dueDate, dueDate + 1 month − 1 day]` — the
window `paymentCoverage()` already computes for credits. A window straddling a
month boundary contributes to **both** months, split by the number of its days
in each:

```
₪3,000 covering 20 Jan – 19 Feb  (31 days)
  → January   12/31 × 3,000 = ₪1,161.29
  → February  19/31 × 3,000 = ₪1,838.71
```

`monthKey(dueDate)` takes **no** part in the allocation.

## Reuse — the window is not reimplemented

`paymentCoverage()`, `localDateFromISO()`, `isoFromLocalDate()`,
`diffWholeDays()`, `addMonthsClamped()`, `addDays()`, `roundMoney()` and
`monthKey()` are **called**, not copied. `app.js` is one flat script scope, so a
second `function foo()` is not a second function — the later declaration
silently overwrites the earlier at hoist time.

**That is not hypothetical: `monthKey` had exactly that problem.** It was
declared twice (the old lines 6231 and 6917). The later, `isoDate`-routed
version had always been the one running; the earlier copy looked authoritative
and was dead code. **This PR removes the dead twin** (a pure no-op on
behaviour — the surviving body is unchanged) and leaves a note where it stood.

A guard test now pins **each shared primitive to exactly one declaration**, so
the coverage rule cannot fork between the credits ledger and this screen, and
the twin cannot come back.

## The four figures

| | meaning | certainty |
|---|---|---|
| **נגבה בפועל** (RECEIVED) | cash collected, allocated by the window | money in hand |
| **צפוי** (EXPECTED) | contracted money for the month, not yet in hand | an assumption |
| **זיכויים** (CREDITS) | refunds allocated to the month, as a negative | — |
| **נטו** (NET) | received + expected − credits | a projection |

**RECEIVED and EXPECTED are never summed into one figure.** Separate fields with
no combined accessor (a test asserts no `total`/`revenue`/`combined` key
exists), separate cards coloured apart — green for money, blue for forecast —
and NET is the one place they meet, labelled as the projection it is, in words,
on the screen.

### No double counting — the day-level partition

Each day of the month is **either** a paid coverage day **or** a
scheduled-but-unbilled day, never both:

- On a partly-paid row, `amountPaid` goes to RECEIVED and the shortfall to
  EXPECTED **over the same window with the same day weights**, so the two
  partition the row's contracted amount exactly.
- A cycle that already has a Payments row is never *also* projected. Without
  that skip a fully-paid January would read as ₪6,000 of revenue on ₪3,000 of
  money.

Tested directly: with December paid and January unrecorded, the 19 paid days
and the 12 unbilled days sum to exactly 31.

### EXPECTED has three kinds, and they are not equally believable

Summed into one figure, kept separable in `.rows` and in sub-buckets, and broken
out on screen under **הרכב הצפוי**:

- `billed_unpaid` — a Payments row exists and is short.
- `projected` — a future cycle, no row written yet. The honest forecast.
- `unbilled_past` — a cycle whose date has **passed** with no row at all.

The last is usually a recording gap rather than future income, so it is flagged
amber in both the composition panel and the detail rows. It stays *inside*
EXPECTED because the money is genuinely owed for those days — hiding it would
understate the month and bury the leak — but it is named apart so nobody reads
it as a forecast.

### EXPECTED respects BillingOverrides

The contracted rate is **not** a naive `p.pay`. Every projected cycle is run
through `applyBillingOverride()` against the same `BillingOverrides` rows the
גבייה tab writes, so a per-month amount Sandra edited there is the figure this
screen forecasts against. The override drives the billed-unpaid half too, and an
overridden row carries a `סכום מותאם` chip so the forecast never differs from
the גבייה tab without saying why. An override for a different month cannot leak
into this one (tested).

### Credits

Split by the span they actually refund, **not** by `allocationMonth` — which
`suggestCredits()` documents as reporting metadata that never enters the math,
so using it here would contradict the module that wrote it:

- `prepaid_return` → the whole coverage window.
- `days_unused` → only the credited tail, `creditedFrom..coverageEnd`. The days
  before the exit were used and were never refunded.
- No usable basis (a manual `other` credit, or a legacy row) → falls back to
  `allocationMonth` and lands whole in it. `spanSource` records which path was
  taken and the drill-down shows a `לפי חודש שיוך` chip rather than implying a
  precision it does not have.

`pending` and `paid` both reduce the month; `cancelled` counts for nothing.

## VAT

`pay`, `PRICE_FALLBACKS` and every Payments amount are stored **VAT-inclusive**;
displays divide by `VAT_RATE` (1.18). Same basis and same divisor as the
outpatient app, so a consolidated total is sound. Every bucket carries **both**
`.inclVat` (stored, untouched) and `.exVat`.

**Ex-VAT is taken per row at 2dp** and a bucket total is the **sum of its rows**,
so a drill-down always adds up to the figure printed above it. Only the
*printed* value rounds to whole shekels (via `revMoney()`), matching every other
figure in this app and `money()` in #109. Rounding the data instead would drift
a drill-down from its own header by up to half a shekel per row.

## Breakdown and drill-down

By **house** — the same dimension the גבייה monthly summary and the נקודת איזון
tab use, and the one the outpatient app's `location` breakdown lines up with per
site. Sorted by NET descending; all-zero houses dropped; payments whose patient
record is gone bucket under **ללא בית** rather than `''` (an unlabelled
breakdown row reads as a rendering bug) — money is money even when the patient
row is not.

The drill-down lists every payment with its coverage window, the fraction of it
that landed in this month (`12 מתוך 31 ימים`), the full amount and the month's
share — so the arithmetic is visible rather than asserted.

---

## Divergences from ezone-outpatient #109

All four are forced by this repo, and none changes the allocation rule.

1. **Structure.** #109 put the calculation in its own module,
   `public/monthly-revenue.js`, because `credits-ledger.js` was already a module
   there and tests can `require()` it. Here the coverage primitives live *inside*
   `app.js`, so the allocation lives beside them in the same file and tests
   vm-sandbox it — the pattern `dashboard-revenue-exvat.test.js` already uses.
   Extracting a module from a 7,700-line script to mirror #109's file layout
   would have been a large, risky refactor for no behavioural gain.

2. **No payment-date column.** `PAYMENT_COLUMNS` is `id, patientId, patientName,
   houseId, dueDate, amount, status, amountPaid, balance, timestamp` —
   `timestamp` is the row's *write* time, not when money changed hands. #109 has
   a real `paymentDate` and shows it in the drill-down with an explicit "this
   never moved a shekel" label. Here there is nothing to show, and nothing that
   could have leaked into the maths. The rule is identical; only the
   reassurance is missing.

3. **Cycle anchor.** #109 reads a stored `nextBillingDate` per client. Here the
   schedule *is* the patient's **entry day-of-month**, recurring monthly — the
   same anchor `patientsDueOn()`, `nextBillingDayOnOrAfter()` and
   `lastBillingDayOnOrBefore()` use, so this screen and the גבייה tab agree on
   when a cycle falls due. Re-clamped from the original entry date every month
   (entry day 31 → Feb 28/29 → back to Mar 31), never walked forward from the
   previous occurrence, which would migrate the cycle earlier for good.

4. **No extra charges.** The outpatient app has ad-hoc charges and needed a
   one-time-charge special case (a one-off lands wholly in its own month rather
   than being smeared over 30 days). This repo has no such rows, so that branch
   is absent. If extra charges are ever added here, that rule must come with
   them.

**Not a divergence:** `revenueExVat()` is a new 2dp helper sitting beside the
existing `exVat()`, which rounds to whole shekels. `exVat()` is **left exactly
as it is** — the credits UI depends on it — and changing it would have silently
altered figures on a shipped screen. The new screen uses the precise helper so
its drill-downs reconcile.

## Security (PR #124 parity)

- **No new endpoint; `server.js` and `Code.gs` are unchanged** — guard-tested,
  including that neither mentions the screen. Every figure is derived in the
  browser from data already loaded for the other tabs.
- **Read-only.** No `apiPost`/`apiGet`/`fetch`/`saveAll`/`savePayment`/
  `saveBillingOverride`/`saveCredit` in any function of the screen, asserted per
  function. Nothing is gated on edit mode because nothing can edit.
- **Everything interpolated is escaped.** Every sheet-sourced field goes through
  `escapeHtml`; a test walks the template interpolations in each renderer and
  fails on an unescaped one.
- The allocation is **pure** — no `document`, no `state`, no `fetch`, no
  `localStorage` — asserted against each function's source with comments
  stripped first. `today` is injected rather than read from the clock, so a
  report reruns identically.
- Junk input is refused rather than guessed at: an unusable month key returns
  `null`, and unreadable patient/payment/credit/override rows are skipped
  without taking the month down.

## Tests

Two new files. Suite **1133 → 1178, all green** (the 2 pre-existing skips are
unchanged).

**`test/monthly-revenue.test.js` — 42 tests**, vm-sandboxing the shipped
`app.js`, TZ pinned to Asia/Jerusalem. Covers the split arithmetic and that the
halves sum to the whole; 28/29/30/31-day months and **both** DST switches; the
month key being ignored; RECEIVED/EXPECTED partitioning a partly-paid cycle and
the day-level partition summing to 31; the never-also-projected skip; the three
EXPECTED kinds either side of `today`; the entry-day anchor with short-month
clamping; BillingOverrides on both halves of EXPECTED and non-leakage across
months; all four credit paths including `allocationMonth` losing to the window;
NET's sign; the absence of any blended field; the VAT basis, the 2dp/display
split and per-row reconciliation; the house breakdown and its `ללא בית` bucket;
**the no-fork guard**; the dead-`monthKey`-twin removal; the daily view being
untouched; and every security guard above.

It also asserts **#109's worked example numerically**: ₪2,542.37 ex-VAT for
January from two straddling cycles, with the same `12/31` and `19/31` fractions.
If the two apps ever disagree, this test goes red.

**`test/monthly-revenue-browser.test.js` — 3 tests**, real Chromium via
Playwright, skip-guarded exactly like `test/spinner-glyph-browser.test.js` (the
repo has one dependency; a browser in `npm ci` would cost minutes per run). It
loads the real `index.html` + `app.js`, seeds the state the app would have
loaded from Sheets, opens the screen and reads the figures off the rendered DOM:
**₪2,542** in נגבה בפועל, `12 מתוך 31 ימים` and `19 מתוך 31 ימים` in the
drill-down, both coverage windows printed, the house resolved to its display
name, February showing cash and forecast as distinct figures, and the daily
גבייה screen still rendering with its own date untouched. It caught two real
bugs this PR would otherwise have shipped: a seed race that made the screen
paint zeroes, and the KPI cards printing agorot.

### Two pre-existing assertions were updated

- `test/meetings-tab-shell.test.js` — `EXPECTED_TAB_ORDER` gains `'revenue'`
  after `'billing'`. That constant is a deliberate structural lock (order,
  retention last, SCREENS mirroring the nav), so registering the new tab there
  keeps it meaningful.
- `test/mobile-tabs-and-edit-mode.test.js` — asserted **exactly 9** tab buttons.
  A tenth tab is not a regression in the mobile tab strip, and an equality there
  fails every future PR that adds a screen. It now asserts each of the nine tabs
  that PR owned is still present and that none was dropped — same intent, no
  false failure. This is the discipline the sw-cache assertions in this repo
  already use, and the one `ezone-outpatient` #109 applied for the same reason.

## Deploy

**No Apps Script redeploy needed** — no new action, no schema change, no new
sheet. It is a client-side screen over data the app already loads.

## Files

| file | change |
|---|---|
| `public/app.js` | dead `monthKey` twin removed; allocation + 5 renderers + state + router entry + 2 event handlers |
| `public/index.html` | new tab button, new `#screen-revenue` section |
| `public/style.css` | the screen's styles, appended |
| `test/monthly-revenue.test.js` | **new** — 42 tests |
| `test/monthly-revenue-browser.test.js` | **new** — 3 Chromium tests, skip-guarded |
| `test/meetings-tab-shell.test.js` | new tab registered in the order lock |
| `test/mobile-tabs-and-edit-mode.test.js` | tab-count pin → presence + floor |
| `CHANGELOG-monthly-revenue.md` | this file |
