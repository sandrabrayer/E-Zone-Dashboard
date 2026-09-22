# תקופת כיסוי, part two — the period as people read it, and the month split

PR #135 put the coverage period on the **גבייה** row. It printed the pair as
two bare ISO dates and said nothing about what the period *does* to the money:

```
תקופת כיסוי   2026-09-22 → 2026-10-21
```

Both gaps are closed here, matching the contract **ezone-outpatient PR #110**
already settled on:

```
תקופת כיסוי        22.9.2026 – 21.10.2026   [מותאמת] ✏️ ↩
פיצול לפי חודשים   ספטמבר · 9 ימים · ₪ 11,100      אוקטובר · 21 ימים · ₪ 25,900 [נדחה]
```

**Display only.** Not one stored value, validation rule or posted field
changes. No figure on any screen moves.

---

## 1. The dates read like every other date in the app

A coverage window is now printed through **`formatDate()`** — the formatter
the app already uses for a person's dates (תאריך כניסה on **תפוסה**, תאריך
שחרור on **שחרורים**). It was **reused, not twinned**: `app.js` still declares
exactly one `formatDate`, and a test pins that, because a second date
formatter is a second answer to "how does this app write a date".

The new `coveragePeriodText(win)` does nothing but read the two ends and hand
them to it. A **single-day period prints once** — `22.9.2026 – 22.9.2026`
reads as a bug — and a row with no window says `—` rather than printing an
empty range.

Applied in all three places a coverage date is shown:

| Screen | Was | Is |
| --- | --- | --- |
| גבייה row | `2026-09-22 → 2026-10-21` | `22.9.2026 – 21.10.2026` |
| הכנסות חודשיות drill-down (חלון כיסוי) | `2026-09-22 → 2026-10-21` | `22.9.2026 → 21.10.2026` |
| Credits UI (the window inside a refund's calculation trail) | `חלון כיסוי 2026-09-22 → 2026-10-21` | `חלון כיסוי 22.9.2026 → 21.10.2026` |

### What did NOT change

`coverageStart` / `coverageEnd` are still stored as **bare `YYYY-MM-DD`
text**, force-formatted `'@'` on the sheet exactly as #135 built them. The
native `<input type="date">` controls still take and return bare ISO — a
formatted value would be rejected by the control outright. `coveragePeriodError()`
still refuses `22.9.2026` as *input*: the formatting is **one-way, and one
layer deep**. Tests assert that `savePayment`, `withDefaultCoverage` and
`saveCoveragePeriod` contain no reference to the formatter at all.

**One thing this does touch, flagged deliberately.** The credits UI's only
rendering of a coverage window is `creditBasisText()`, whose output is *also*
persisted into a credit row's `reason` column — the human-readable audit
trail beside the machine-readable `basis` JSON. So a credit **created from
here on** records `חלון כיסוי 22.9.2026 → 21.10.2026` in that sentence instead
of the ISO pair. Nothing parses that column, no amount, date field, month or
classification changes, and no historical row is rewritten. The alternative —
leaving the credits screen reading ISO while the other two read dates — is the
inconsistency this PR exists to end.

---

## 2. The month split under the period

Under the period, the row now prints the automatic split of the payment across
the calendar months its coverage window touches.

* **The denominator is the window's own length**, never the calendar month's.
  9 of a 30-day window on ₪37,000 is ₪11,100, whatever September is worth.
* **VAT-inclusive**, matching the amount printed beside it on the row.
  (הכנסות חודשיות is the one screen that divides by VAT, and it labels every
  figure it does that to.)
* **A period inside one month shows that month only.**
* **The later month reads as deferred** — muted, tagged **נדחה**: the money is
  collected now and earned then. Deliberately *clock-independent*: a row's
  split must not change meaning because the calendar turned over, so "deferred"
  means "after the month the window starts in", never "after today".
* **Visually prominent**, not a tooltip: its own full-width strip
  (`grid-column: 1 / -1`) beneath the seven columns, one pill per month, days
  and shekels spelled out. This is the figure that decides which month the
  money lands in.
* **Live while editing**: the strip follows the two date inputs as they are
  typed, and an impossible period shows the shared refusal reason in place of a
  window. The preview builds a **copy** of the row, so a half-typed period can
  never leak into the object the save path would send.

### It is not a second opinion — it is the monthly view's own arithmetic

`splitByMonth(amount, win)` divides the payment through **`revenueAllocate()`**,
literally the function **הכנסות חודשיות** allocates with, walking the months
with `revenueMonthBounds()` / `revenueShiftMonth()`. `paymentMonthSplit()`
reads the window from **`paymentCoverage()`**, the one window function the
credits ledger and the revenue screen already share. Nothing here re-derives a
day-split.

The **no-fork guard** (`test/monthly-revenue.test.js`, section H) was widened
to this third consumer:

* `splitByMonth`, `paymentMonthSplit`, `coverageSplitHtml` and
  `coveragePeriodText` must each be declared **exactly once** — `app.js` is one
  flat script scope, so a second `function foo()` silently overwrites the first
  at hoist time;
* `splitByMonth` must call `revenueAllocate(total, win, bounds)`, and must
  contain **no day arithmetic of its own** (`getDate()`, `86400`, `/ 30` … are
  all refused by the guard);
* `coverageSplitHtml` displays a split, it does not compute one;
* and a new test drives both consumers off one row and asserts they agree
  month for month: same shekels, same days, same denominator.

### Rounding sums exactly to the payment

Each month carries two figures:

* **`allocated`** — exactly what the monthly view puts in that month;
* **`amount`** — what is *displayed*: the same figure, except that the last
  agora of rounding drift is absorbed by the **longest** month.

Independently rounded shares can leave ₪0.01 unaccounted for (₪100 over three
equal months → 33.33 × 3 = 99.99), and a split that does not add up to the
row's own amount reads as a bug to whoever is checking it. Both are returned so
neither truth is hidden: `allocated` reconciles with **הכנסות חודשיות**,
`amount` reconciles with the row. Ties go to the earlier month, so the same
payment always splits identically.

### Simplest-choice decisions (delegated, flagged here)

* **The split belongs to the row, so it is gross.** Showing it ex-VAT would
  match the revenue *screen* but contradict the ₪ printed two centimetres to
  its right. `allocated` is the gross slice; the revenue screen divides it
  downstream, as it always has.
* **`amount` is passed in, not read off the row.** The גבייה row shows the
  *effective* amount (the per-month **סכום מותאם** override layer), and the
  split must match the figure printed beside it.
* **Every billing row gets the strip**, carry-forward rows included — a
  carry row's money covered a period too, and the row already prints that
  period.
* **A window crossing December names the year** (`דצמבר 2026` / `ינואר 2027`);
  inside one year the bare month name reads cleanest.

---

## What did not change

* **No stored value, anywhere.** A test asserts the row object handed to the
  split is byte-identical afterwards, and that none of the four new functions
  mentions `savePayment`, `apiPost`, `state.payments` or `localStorage`.
* **The monthly view's arithmetic.** Same `revenueAllocate`, same
  received/expected partition, same per-row 2dp ex-VAT.
* **Payments and credits.** No amount, status, balance, classification, cap or
  allocation month moves.
* **`server.js` and `apps-script/Code.gs`.** Not one line — asserted, token by
  token.
* **`index.html`.** No new static markup; the strip is built by the renderer.

---

## Files

| File | Change |
| --- | --- |
| `public/app.js` | `coveragePeriodText()`; `splitByMonth()` / `paymentMonthSplit()` on top of `revenueAllocate()`; `coverageSplitHtml()`; the row prints the formatted period + the split strip and previews it live; the drill-down and `creditBasisText()` format their window |
| `public/style.css` | the `.bill-cov-split` strip, the month pills, the deferred styling, the refusal line |
| `test/coverage-period-split.test.js` | **new** — 25 tests |
| `test/coverage-period-split-browser.test.js` | **new** — 5 Playwright/Chromium tests (skipped without a browser) |
| `test/monthly-revenue.test.js` | the no-fork guard widened to the split, plus the row/view agreement test |
| `test/payment-coverage-period.test.js` | the display-format contract on the cell it pins |
| `test/payment-coverage-period-browser.test.js`, `test/monthly-revenue-browser.test.js` | the on-screen assertions now expect the app's date format, and assert no ISO reaches the drill-down |

## Tests

`test/coverage-period-split.test.js` — 25 tests, vm-sandboxed on the real
shipped `app.js`, TZ pinned to `Asia/Jerusalem`:

* **A** the display format — the quoted 22 Sep → 21 Oct pair, the formatter is
  reused not twinned, a single-day period prints once, the row keeps ISO in its
  inputs, the same format in the drill-down and the credits UI, and storage +
  validation are untouched.
* **B** the split — the 9 / 21 example on ₪37,000, the window's own
  denominator (proved against February, where a calendar denominator would
  differ), single-month, three-month and 13-month windows, clock-independent
  deferral, and exact rounding with the residual parked on the longest month
  while `allocated` still equals `revenueAllocate`'s own answer.
* **C** it is the monthly view's arithmetic — the row's split equals that
  screen's allocation month for month, a recorded period moves both together,
  VAT-inclusive, and the effective amount is what gets split.
* **D** the strip — placement and CSS, month · days · money per line, the year
  named when a window crosses December, the live preview wiring, and the shared
  refusal reason instead of a window.
* **E** scope + security — display only, the input row untouched, no backend
  learned anything, everything escaped.

`test/coverage-period-split-browser.test.js` — 5 Chromium tests: the strip
renders with the deferred month visibly muted, the printed lines sum to the
row's own ₪3,000 to the agora, typing a period redraws the split without
saving (and cancelling restores it), a backwards period shows the refusal, and
a recorded period splits by its own months.

Full suite: **1,313 passing**.

## Deploy note

Front-end only — `public/app.js` and `public/style.css`. **No Apps Script
deploy, no sheet change, no migration.**
