# תקופת כיסוי on גבייה: human dates, and the month split stated on the row

Two changes to the coverage-period cell PR #135 added. Both are **display
only** — no stored data, no payment, no credit and no arithmetic on
הכנסות חודשיות changed. `apps-script/Code.gs` is untouched.

---

## 1. The period reads like a date, not a database field

It printed ISO: `2026-09-06 → 2026-10-05`.

It now prints `6.9.2026 → 5.10.2026` — through the **same `formatDate()`**
(`app.js:8524`) that תאריך כניסה already goes through on תפוסה
(`app.js:3953`, `app.js:5017`). No second formatter was written; the no-fork
guard now pins `formatDate` to a single definition alongside the other shared
primitives.

Two new one-line helpers, so the two screens that print a window cannot drift
into different formats:

| | |
| --- | --- |
| `coverageDateText(v)` | one date, `app.js:5459` |
| `coverageWindowText(start, end)` | both ends and the arrow, `app.js:5465` |

`coverageDateText` converts a bare ISO string to a **local** Date before
handing it over. `formatDate`'s own `new Date('2026-09-06')` parses as UTC
midnight, which renders a day early anywhere west of Greenwich —
`localDateFromISO` reads the parts instead. The גבייה row already holds local
Dates and passes them straight through; the drill-down holds ISO strings and
goes the other way. A test asserts the two routes produce the identical string.

### Applied everywhere a coverage window is *displayed*

| site | source | |
| --- | --- | --- |
| גבייה row | `app.js:6994` | ✅ changed |
| הכנסות חודשיות drill-down | `app.js:8038` | ✅ changed |
| `creditBasisText` | `app.js:5662` | ❌ deliberately left on ISO |

**Why the credits audit trail keeps ISO.** `creditBasisText`'s output is not
display — it is **persisted** into the Credits row's `reason` column at
creation (`app.js:5838`, pinned by `test/payment-coverage-period.test.js` §E).
Reformatting it would rewrite stored audit text, which this change explicitly
does not do. A test in the new file says so out loud so the omission reads as
a decision rather than a miss.

### Storage is untouched

The claim is asserted directly, because it is the whole safety story:

- the stored pair stays bare `YYYY-MM-DD` (`withDefaultCoverage` unchanged);
- the native `<input type="date">` values stay ISO — formatting them would
  blank the control silently, the one way a display change could break
  editing;
- `Code.gs` has no formatter, and `PAYMENT_TEXT_COLUMNS` is unchanged.

---

## 2. The month split, on the row

A payment is one number but almost never buys one calendar month. Until now
the row said nothing about where the money actually lands — you had to open
הכנסות חודשיות to find out. It is now stated where the decision is made:

```
תקופת כיסוי   6.9.2026 → 5.10.2026  ✏️
              │ ספטמבר 2026 · 25 ימים · ₪ 24,167
              │ אוקטובר 2026 · 5 ימים · ₪ 4,833
```

### It does not divide anything itself

`coverageMonthSplit(amount, win)` (`app.js:7476`) takes **every slice from
`revenueAllocate()`** — the same function, the same window, the same
`revenueMonthBounds()` that הכנסות חודשיות calls for the identical payment. It
owns no day arithmetic at all; a test greps its body for `diffWholeDays` /
`86400000` and fails if any appears.

So the denominator is the **window's own length**, not the calendar month's —
25/30 and 5/30 above, never 25/31. And the two screens cannot disagree: a
change to the split rule lands on both at once.

`coverageMonthKeys(win)` (`app.js:7434`) enumerates the months the window
touches. Its 14-iteration bound is a guard, not a limit — `COVERAGE_MAX_DAYS`
caps a window at 366 days (13 months at worst), so a longer walk means a pair
that reached the renderer corrupted, and a corrupted pair must not spin the
render loop.

### What it does add: display rounding that reconciles

`revenueAllocate` rounds each slice to 2dp independently. The row prints whole
shekels, so three slices of 9,666.66… would read 9,667 ×3 = **29,001** directly
beneath an amount of 29,000.

`amount` is therefore the largest-remainder reconciliation of `exact`: floor
every slice, then hand the leftover shekels to the largest fractions, **ties by
month order** so a re-render can never move a shekel between months (the split
repaints on every keystroke — a flickering allocation would be worse than none).
The slices sum to the payment exactly, swept across 7 window shapes × 11
amounts in the tests.

`exact` is kept on each part and is what the cross-check compares, since it is
literally `revenueAllocate`'s own output on both sides.

### VAT

None applied, deliberately. The גבייה screen is **VAT-inclusive** — the ₪29,000
the split sits under is — so the split is stated in that basis and a test
asserts no `revenueExVat` / `VAT_RATE` appears inside it. הכנסות חודשיות shows
the identical slices ex-VAT through `revenueExVat()`: same arithmetic, one
conversion at the edge, which is where it belongs.

### Live, before save

Editing a period answers "what does this do to my months?" while the period is
still being chosen. The preview is **not a second opinion**: it runs the typed
pair through `withDefaultCoverage()` + `paymentCoverage()` — the exact pair
`savePayment()` would store and the exact window every consumer would then
read. A blank pair therefore previews the inferred cycle, which is what the ↩
reset writes.

A half-typed or invalid pair repaints nothing and leaves the last good split on
screen: the row must not flash between two keystrokes, and
`coveragePeriodError()` already owns saying what is wrong. A browser test
confirms that typing a period persists **nothing** — no POST, no state change.

The split renders as a sibling of `.bill-cov-view`, not inside it: that span is
hidden when the editor opens, and a split nested in it would vanish at exactly
the moment it is most useful.

### Reading it

- **Current month** → `--primary`, the accent this row already uses.
- **Any other month** → `--warning`, this screen's existing "later" language
  (carry rows, overdue rows and the יתרה figure are all amber), at `.88`
  opacity with a matching accent bar.

14px / 600–700 weight — just under the row's own `.p-val` (14.5px): a primary
fact, not a footnote. No new colour tokens; a test asserts the block contains
no raw hexes.

---

## Decisions taken without asking

1. **"Current" is the month the גבייה screen is showing**
   (`monthKey(state.billingDate)`), not the row's due month. That is the
   context you are actually looking at, so the split directly answers "how much
   of this counts for the month on my screen?". When a recorded period sits
   entirely outside it, every line reads deferred — the honest answer, and the
   מותאמת badge above already explains why.
2. **The month label carries its year** — `ספטמבר 2026`, not `ספטמבר` as in
   the brief's mock. It comes from the existing `revenueMonthLabel()`, so no
   new code and the same wording as הכנסות חודשיות; and a December→January
   split is ambiguous without it.
3. **`₪ 24,167` with a space**, matching the `₪ 29,000` in the amount cell
   directly beside it.
4. **A zero-amount payment still shows its split** (days, ₪ 0) rather than
   rendering nothing — where the days fall is still information.

## Files

| file | change |
| --- | --- |
| `public/app.js` | +166 / −3 — the two display helpers, `coverageMonthKeys`, `coverageMonthSplit`, `coverageSplitHtml`, the row wiring and the two call sites |
| `public/style.css` | +49 / −1 — the split block, and the grid comment it invalidated |
| `public/sw.js` | `CACHE_VERSION` v14 → v15 |
| `test/coverage-month-split.test.js` | new — 32 tests, runs in CI |
| `test/coverage-month-split-browser.test.js` | new — 8 tests, skipped without a browser |
| `test/monthly-revenue.test.js` | +31 — the no-fork guard's new consumer |
| `test/payment-coverage-period-browser.test.js` | display assertions ISO → human; storage assertions unchanged |
| `test/monthly-revenue-browser.test.js` | same |

## Tests

**`test/coverage-month-split.test.js`** — 32 tests. The brief's 25/5 case; a
single-month period; a three-month span; rounding that sums exactly across 77
combinations; determinism and tie-breaking; the VAT basis; **the cross-check**,
which builds the identical payment into `buildMonthlyRevenue()` for each month
its window touches and asserts `daysInMonth`, `windowDays` and `amountInMonth`
are the ones the row prints; the date format and its two call sites; and the
display-only guarantees (storage, the native inputs, `Code.gs`, the persisted
credits audit string).

**`test/coverage-month-split-browser.test.js`** — 8 tests in real Chromium:
the split on screen, the deferred month resolving to `rgb(255,176,32)` against
the current month's `rgb(91,139,255)`, one line for a single month, three lines
summing to ₪29,000, the live repaint persisting nothing, a half-typed period
leaving the last good split up, cancel restoring both, and the split surviving
the editor opening. Skipped unless playwright *and* a Chromium binary are
present, so it is inert under `npm ci`.

**`test/monthly-revenue.test.js`** — the no-fork guard grows: `coverageMonthSplit`
and `coverageMonthKeys` join the "declared exactly once" list as the fourth
consumer of `revenueAllocate`, `coverageDateText` / `coverageWindowText` /
`formatDate` join it for the display format, and a new §H test asserts the
split calls the shared allocator and owns no day arithmetic.

Full suite: **1,329 passing** (1,323 + 6 skipped where no browser is available).

## Service worker

`CACHE_VERSION` v14 → v15. `app.js` and `style.css` both changed and are the
offline fallback for any device that installed v14.
