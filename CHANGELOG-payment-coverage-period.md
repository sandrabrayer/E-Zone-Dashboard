# תקופת כיסוי — the payment's coverage period, recorded instead of assumed

A payment row now **records** the period it pays for, in two appended columns:
`coverageStart` and `coverageEnd`. Both default to the cycle that was
previously inferred, so the normal case is unchanged and costs the recorder no
extra clicks — but when the money covered something else, that can now be
said.

---

## The problem

A payment's coverage period was **inferred**: the patient's entry
day-of-month, recurring monthly, plus an assumption of *one month paid in
advance*. Nothing on the row recorded what the payment actually covered.

Every figure on **הכנסות חודשיות** rests on that assumption. The credits
ledger rests on it too — a refund is "the days of the coverage window after
the exit". When the assumption was wrong the money landed in the wrong month,
the refund was computed against the wrong window, and **no screen could tell
you**: the inference produced a confident-looking window either way.

The three places that ask "what period does this payment pay for" are the
credits ledger, the monthly revenue view, and — new here — the גבייה row
itself.

## The change

`coverageStart` / `coverageEnd` are **appended** to `PAYMENT_COLUMNS`
(positions 11 and 12). Append-only is the standing contract for this sheet:
`readSheet_` maps by **position**, so inserting or reordering a column
silently re-reads every historical row against the wrong field. Guard-tested
in two places (`test/orphan-payments-reconcile.test.js` pins the full list and
asserts the original ten are unmoved; `test/payment-coverage-period.test.js`
asserts the append).

### One primitive, extended — not a second path

`paymentCoverage()` was already the single window function shared by the
credits ledger and the revenue screen. It is still the single one; it now
answers from a **choice**:

```js
paymentCoverage(payment)
  → recorded period, when the row stores a usable one   → source: 'recorded'
  → dueDate … dueDate + 1 month − 1 day, otherwise       → source: 'inferred'
```

It is built from four small helpers — `recordedCoverage()`,
`inferredCoverage()`, `coverageDateISO()` and `coveragePeriodError()` — and
**all six** are now in the no-fork guard's exactly-once list, alongside
`coverageDiffersFromDefault()` and `withDefaultCoverage()`. `app.js` is one flat script scope, so a second
`function foo()` silently overwrites the first at hoist time; a second copy of
any of these would be a second answer to "what did this payment cover", which
is precisely the fork the guard exists to stop.

The guard also got stricter about the revenue screen. It used to assert that
`buildMonthlyRevenue` calls `paymentCoverage({ dueDate: dueISO })`. That stub
**throws the recorded period away** — so the pass over stored payment rows now
passes the whole row (`paymentCoverage(raw)`), and the guard asserts exactly
that, plus that no `{ dueDate }` stub survives in that pass. The *projected*
pass keeps the stub and the guard says why: a projected cycle has no payment
row, so there is nothing recorded to honour.

A new guard test drives both consumers off one row and proves they agree: a
payment recorded as covering March moves the revenue allocation to March
**and** makes the credit a `prepaid_return` on a February discharge.

### Nothing is backfilled

A row with blank coverage cells reads exactly as it did before this change —
the period is **derived on read**, never written back. No historical row is
rewritten, no migration runs, no script touches the sheet. A test asserts the
input object is byte-identical after being read by `paymentCoverage()`,
`suggestCredits()` and `buildMonthlyRevenue()`.

`withDefaultCoverage()` — the one stamper — returns a **copy**, and is called
only on the write path.

### The default costs nothing

`savePayment()` is the single write path for a payment row (the גבייה status
and שולם בפועל controls, the חידוש renewal write, and the new period editor
all funnel through it). It stamps the inferred cycle onto any payment that
records no period, **before** the optimistic local upsert, so state and sheet
agree.

Because the default *is* what was being inferred, a recorder who never looks
at the field gets the same window they always got — now stored as a fact
rather than re-derived from an assumption on every read.

## Decisions (these were delegated)

### Where the fields appear

**Its own cell on the גבייה row, immediately after the amount.** The two facts
a recorder decides together — *how much*, and *for what period* — sit side by
side, and the row already carries the due date, so the period reads as a
refinement of it rather than a new concept somewhere else. The row grid grew
from six columns to seven; the coverage cell is the widest, since it prints
two ISO dates.

**When it is editable:** edit mode, and the payment row actually exists in the
sheet. That differs from the amount-override editor in two deliberate ways:

- **Paid and partial rows *are* editable here.** The amount override is
  refused on them because it would rewrite settled money. The period is the
  opposite — a payment already taken is exactly the one whose period must be
  correctable, because that is the row the revenue screen allocates.
- **An unsaved placeholder row is *not* editable.** A due-list row with no
  persisted payment is an in-memory object from `paymentForPatientOnDate()`;
  writing a period to it would conjure an unpaid Payments row that does not
  exist today. Record the payment first, then adjust its period. The period is
  still *displayed* (inferred) on such a row — only the pencil is withheld.

No `patientMatched` guard is needed: unlike an override, these columns live
**on the payment row** and are keyed by `payment.id`, so even an orphaned
carry-forward row can say what its own money covered.

The editor writes through `savePayment()` — optimistic upsert, rollback and
the existing `שמירת גבייה נכשלה` toast on failure — and changes **only** the
two columns. `amount`, `status`, `amountPaid` and `balance` ride through
untouched, so a period edit can never move money, only say which month it
belongs to. A test asserts that.

### How an edited period is validated

The rule is one shared function, `coveragePeriodError()`, mirrored as
`coveragePeriodError_()` in `Code.gs`, each built on a normalizer
(`coverageDateISO()` / `coverageDateISO_()`) that is likewise a mirror. Both
return `''` or the Hebrew reason, and a **parity sweep** asserts the two agree
message for message across all 441 pairings of a deliberately nasty value set
(blank, whitespace, `null`, both DST switches, leap and non-leap 29 February,
`2026-02-30`, month 13, loose forms, timestamps).

That sweep earned its keep immediately: it caught the server accepting
`'2026-1-5'` (via a bare `new Date()`) where the client refused it. Both sides
now accept **three shapes only** — a bare `YYYY-MM-DD` naming a real day, a
full ISO timestamp read by its local parts, and a `Date` object — and refuse
everything else rather than hand it to `new Date()`, whose tolerance for loose
strings is engine-dependent. A number, a boolean and `5/1/2026` are all
refused on both sides.

**Refused** — things that cannot be true of a single row:

| Case | Reason |
|---|---|
| Half-filled pair | `יש למלא גם תאריך התחלה וגם תאריך סיום לתקופת הכיסוי` |
| Malformed date | `תאריך לא תקין בתקופת הכיסוי` |
| Impossible date (`2026-02-30`, month 13) | same — the parts must survive a round-trip, not merely match `\d{4}-\d{2}-\d{2}` |
| End before start | `תאריך הסיום מוקדם מתאריך ההתחלה` |
| Span > 366 days | `תקופת כיסוי ארוכה מדי (N ימים, המקסימום 366)` |

A **zero-length** period cannot be expressed: `start === end` is one day, the
shortest honest period, and is allowed. `end < start` is the only "zero or
less" and is refused.

The 366-day cap is a typo guard — a mistyped year (`2027-01-05` for
`2026-01-05`) would otherwise quietly swallow a year of allocation.

**Not refused — overlaps and gaps between rows.** All three are real: two
months paid at once overlap nothing wrongly, a patient who skipped a month
leaves a genuine gap, and a re-dated cycle legitimately overlaps its
neighbour. The credits ledger already de-duplicates overlapping days
(`creditedThrough`), so an overlap costs nothing there — a test proves that
still holds on *recorded* windows. Refusing one would force the recorder to
lie about what the money bought, which is the disease, not the cure.

A **blank pair is legal** and means "use the inferred cycle" — it is what
every historical row carries.

### Whether an edited period is visually marked

**Yes, in both places it can be seen.**

- On the גבייה row: a `מותאמת` badge (the same informational blue as the
  existing `סכום מותאם` badge), plus a `↩` button to return to the billing
  cycle.
- In the הכנסות חודשיות drill-down: a `תקופה מותאמת` chip on the row.

A row that records *exactly* the default is **not** marked. The badge means
"somebody decided otherwise"; a badge on every row would mean nothing.

The revenue chip matters most: without it, a row's window would silently
contradict the due date printed beside it — which is the very "money in the
wrong month with no way to tell" this change exists to end.

Resetting does **not** write blanks. `savePayment()` re-stamps the inferred
cycle, so the row keeps an explicit period rather than reverting to a cell
somebody would have to interpret later.

## What did not change

- **The credits calculation.** The divisor is still `amountPaid / 30`, the
  classification is still by where the window starts relative to the exit, the
  cap is still `amountPaid`, `allocationMonth` is still reporting metadata.
  Only where `[start, end]` comes from changed.
- **The monthly view's arithmetic.** Same day-by-day split, same
  received/expected partition, same never-blend rule, same per-row 2dp ex-VAT.
- **The daily גבייה `סיכום חודשי` panel.** Untouched, as always.
- **`server.js`.** Not one line. A test asserts the proxy has never heard of
  `coverageStart`.
- **`index.html`.** No new static markup — the cell is built by the renderer,
  so there is nothing to drift out of sync.

### Does any existing figure move?

**No.** Every row in the sheet today has blank coverage cells, and a blank
pair reads as the inference that was already in force. The December + January
worked example still produces ₪3,000 for January from 19 + 12 days; the
`2,542` ex-VAT cross-app number is unchanged and still asserted in Chromium.

A figure moves only when somebody **deliberately edits a period**, which is
the point of the change and is flagged on both screens where it happens.

## Security (PR #124 parity)

- **Server-side validation of the dates.** `upsertPayment_()` calls
  `coveragePeriodError_()` **before the lock is taken and before a single cell
  is written**, and returns `{ ok: false, error }` with the reason verbatim.
  The client checks the same rule only to spare a round-trip; `savePayment` is
  reachable by anything holding the API key, so the server is the authority. A
  test drives five hand-built payloads (half-filled, `<script>`, a number, a
  boolean, a four-year span) straight at `upsertPayment_` and asserts the
  sheet still holds nothing but its header.
- **No new endpoint.** `getPayments` / `savePayment` / `updatePayment` are the
  only actions that touch a payment row, exactly as before. Asserted.
- **Backend errors surfaced explicitly.** A refusal reaches the user as
  `שמירת גבייה נכשלה — <reason>` and the optimistic local row rolls back —
  proven in Chromium against a 500-ing stub, asserting the local row returns
  to what the sheet actually holds.
- **Stored as text.** The two new columns are force-formatted `'@'` at
  sheet-ensure time. A `YYYY-MM-DD` in a date-*typed* cell reads back as a
  Date, serializes as a UTC timestamp and drifts −1 day for Israel — the
  `exitDate` bug class, which here would move revenue between months. Only the
  **new** columns are forced; re-formatting a live column is a migration, not
  a guard. Reads go through `isoDate()`, which takes local parts.
- **Everything interpolated is escaped.** The rendered window and both input
  values pass through `escapeHtml()`, belt-and-suspenders over values that
  come out of `isoFromLocalDate()` and cannot carry markup.

## Tests

`test/payment-coverage-period.test.js` — 35 tests, vm-sandboxed on the real
shipped `app.js` and `Code.gs`, TZ pinned to `Asia/Jerusalem`:

- **A** the schema is append-only; only the new columns are text-forced.
- **B** one primitive, two answers — inferred, recorded, no-due-date,
  half-filled/unusable fallback, single-day vs. backwards, and both DST
  switches.
- **C** the default is stamped and never overwrites a recorded period; the
  badge marks only a real difference; `normalizePayment` carries the pair and
  normalizes a UTC timestamp to its local day.
- **D** nothing is backfilled — a blank row reads as it always did, and the
  input object is byte-identical after every read path.
- **E** all three consumers on one window — an edited period moves the
  allocation and nothing else; identical figures when the same window is
  expressed inferred vs. recorded; the credits ledger reads the recorded
  window; overlapping recorded windows still credit no day twice.
- **F** validation, client and server, asserted for parity case by case AND
  by a 441-pair sweep; the normalizer's accepted and refused shapes pinned on
  both sides; `upsertPayment_` refuses and writes nothing; a good period
  round-trips as bare text.
- **G** the UI — cell placement, editability rules, the shared-rule write
  path, the badge and the chip.
- **H** scope + security.

`test/monthly-revenue.test.js` — the no-fork guard widened to the five new
primitives and the stricter reuse assertion, plus a cross-consumer agreement
test.

`test/payment-coverage-period-browser.test.js` — 7 Playwright/Chromium tests
(skipped unless a browser is present, same contract as the other browser
suites): the cell renders with the inferred default, editing persists both
columns without moving money and marks the row, the recorded period moves the
money on הכנסות חודשיות and is flagged there, reset returns to the cycle, an
impossible period is refused at the keyboard with no round-trip, a backend
refusal surfaces and rolls back, and the editor is withheld in view mode and
on an unsaved placeholder row.

Full suite: **1,267 passing**.
