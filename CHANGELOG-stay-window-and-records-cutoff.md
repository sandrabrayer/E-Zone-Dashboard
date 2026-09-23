# Who was due when — the stay window, and a records cutoff

Two questions this app was answering wrong, both of them about **time**, and
both of them landing money in the wrong month on screens already in use.

---

## 1. A patient was "due" on a date they were not here

Being due was decided by **day-of-month alone**:

```js
patientsDueOn(dateISO) → activePatients().filter(p => dayOfMonth(p.date) === dayOfMonth(dateISO))
```

Nothing asked whether the patient's stay covered the date. So **עמית בורנשטיין**,
who entered עפרוני on **7.9.2026**, appeared on the גבייה list for
**07/07/2026** — two months before he arrived — and was counted in that day's
סך לגבייה. **ניר כהן, אבי משען, בן שלום, שחר חיון** and **גיל**, every one of
them a September admission, did the same on July dates. The day matched; the
stay did not.

### The rule

One function, shared by every screen that asks "was this patient in the house
then":

```js
patientStayCoversDate(patient, date)  // entryDate <= date AND (exitDate empty OR exitDate >= date)
patientStayOverlapsRange(patient, from, to)   // the month-level form
patientDueOnDate(patient, date)       // the stay AND the billing anchor
```

Both ends are **inclusive**: the entry day and the exit day are stay days.

Applied in: the **daily גבייה list**, the **KPI cards** that recompute from it,
**יתרות פתוחות**, the old **סיכום חודשי**, and **הכנסות חודשיות**.

### Every date goes through `isoDate()`

`dayOfMonth()` used to slice the raw string, which is right only for a value
already stored as bare `YYYY-MM-DD`. A date-**typed** sheet cell reaches the
client as `"2026-09-06T21:00:00.000Z"` — whose calendar day in Israel is the
**7th**. Sliced, it reads day 6, and because the entire billing schedule hangs
off that number, the patient's every due date, every renewal and every inferred
coverage window would be one day early.

`dayOfMonth()` is now `isoDate()`-routed, as are all three stay helpers. This is
the same one-day drift already fixed in `exitDate`, `visitTime`, `isoDate`
itself and the coverage columns; here it would have moved a first or last cycle
by a whole **month** at the boundaries.

### The conservative choice, flagged

A patient marked **released with no exit date recorded** is the one case the
dates cannot answer. They are treated as **no longer in the house** — status is
then the only signal there is, and inventing a stay would re-create the exact
"billed for a period they were not here" this change exists to stop. The
consequence: such a patient contributes nothing to a past month either. The fix
is to record their exit date, and the screen will then count them correctly.

`isBillablePatient()` remains the single statement of "released stops billing";
the stay rule *calls* it for that fallback rather than keeping a second copy of
the comparison.

---

## 2. A patient discharged in August was in the house in July

**הכנסות חודשיות** built EXPECTED from `isBillablePatient(patient)` — "is this
patient active **today**". That silently erased a discharged patient's whole
billing history: somebody discharged on 20.8.2026 spent all of July in the
house, and their July cycles are **July's** revenue no matter what their row
says in September.

The pass now admits any patient whose **stay overlaps the month**.

Nothing else moved. `projectedCycleDueDates()` already clipped each cycle at
entry and exit, and `revenueAllocate()` already truncated a straddling cycle at
the exit day **without shortening the denominator** — so the days after a
discharge still earn nothing, and the days before it still earn their true daily
rate. What was missing was letting the patient into the pass at all.

---

## 3. RECORDS_COMPLETE_FROM — the cutoff

Payments were not entered in this app before **July 2026**: of the **27
patients admitted in June, not one has a first payment recorded**. The cycles
are real — the patients were here and the money was collected — but the **rows**
were never created, and every screen that infers a cycle from an entry day was
reading that absence as **unpaid debt**.

```js
const RECORDS_COMPLETE_FROM = '2026-07-01';
```

One constant, one date, deliberately configurable: when the historical rows are
eventually backfilled, moving this line earlier is the whole migration. Bare
`'YYYY-MM-DD'`, compared as a string against `isoDate()`-normalized dates, so no
timezone can move it. Written **once** — a test asserts the literal appears
nowhere else.

A cycle whose due date falls before it is **neither EXPECTED nor DEBT**. It is
not hidden either — hiding it would be the same silent assumption in the other
direction — it goes to its own bucket, **לפני תחילת הרישום**, which no total
sums:

| Screen | What the cutoff does |
| --- | --- |
| **הכנסות חודשיות** | its own `preRecords` bucket, with its own drill-down group and a line on the הרכב הצפוי panel reading *לא נכלל בצפוי ובנטו*. Out of EXPECTED, out of NET, out of the per-house breakdown. |
| **גבייה — daily list** | the row is still listed, with a neutral **לפני תחילת הרישום** badge, and a note under the cards names the date and how many cycles were excluded |
| **גבייה — KPI cards** | **סך לגבייה** (a debt figure) leaves them out. **נגבה** does not: money that was recorded arrived. |
| **יתרות פתוחות** | listed under their own heading, *after* the real balances, never above the line |
| **סיכום חודשי** | **יתרה** honours the line, **נגבה** does not; a muted breakdown line says how many rows were set aside |

### The conservative choice, flagged

The cutoff suppresses **inferred** cycles — the ones nobody ever created a row
for. A payment row that **exists** was entered by somebody, so it is evidence of
recording and stays in RECEIVED / EXPECTED whatever its date. No such row exists
in the live sheet (that is the premise of the cutoff), so this changes no figure
today; it is written down so that *hiding real money* can never become the rule.

### And a fourth flag: rows that should not exist

A recorded payment row whose due date falls **outside** its patient's stay is
the residue of the day-of-month-only due list — a placeholder that got saved.
Such a row is never hidden or rewritten (it may be money somebody really took);
it is **flagged** on the גבייה row with an amber **מחוץ לתקופת השהות** badge
naming the entry and exit dates, so Sandra can correct it.

---

## The figures this moves — before and after

**Both changes move numbers already in use on הכנסות חודשיות, in opposite
directions.** For July 2026:

| Movement | Direction | Why |
| --- | --- | --- |
| June cycles leave EXPECTED (§3) | **down** | a 20 Jun cycle covers 1–19 July; it was counted as July debt, and it is a recording gap, not a debt |
| Discharged patients' July cycles enter EXPECTED (§2) | **up** | they were in the house; their cycles are July's |
| September admissions leave July entirely (§1) | **down** | they were not here; their "July cycle" never existed |

### Worked, exactly (the browser test's own roster)

Three patients in עפרוני, all at ₪30,000/₪35,000 incl. VAT:

| Patient | Entry / exit | July EXPECTED before | July EXPECTED after |
| --- | --- | --- | --- |
| יוני | entered 20.6.2026 | **20 Jun cycle** 30,000 × 19/30 = **₪19,000** + **20 Jul cycle** 30,000 × 12/31 = ₪11,612.90 | ₪11,612.90 only — the June cycle moves to לפני תחילת הרישום |
| רות | entered 10.7, discharged 20.8 | **₪0** (released today ⇒ excluded) | 30,000 × 22/31 = **₪21,290.32** |
| עמית בורנשטיין | entered 7.9.2026 | listed on 07/07 גבייה; ₪0 on the revenue screen | ₪0, and gone from the July list |

July EXPECTED: **₪30,612.90 → ₪32,903.22** incl. VAT for that roster — down
₪19,000 from the cutoff, up ₪21,290.32 from the discharge. The ₪19,000 is not
lost: it is printed, in its own bucket, on the same screen.

### On the live sheet

**This session cannot read the production spreadsheet**, so the live July figure
is not quoted here as if it were measured. What the change does to it is exact
and can be read off the screen the moment this ships: **the July
לפני תחילת הרישום bucket IS the amount that left EXPECTED**, and the difference
between the old and new צפוי card is that figure minus the discharged patients'
July cycles.

Order of magnitude, from the one fact in hand — 27 June admissions, a June cycle
covering on average about half of July: at ~₪35,000 incl. VAT each, roughly
**₪450,000–500,000 incl. VAT (~₪380,000–420,000 ex-VAT) leaves July EXPECTED**.
That is an estimate from the entry count and nothing else, and is explicitly
**not** a measured number.

---

## What did not change

* **No stored value.** Nothing here writes; a test asserts the patient row is
  byte-identical after every new function has read it.
* **The allocation arithmetic.** Same `revenueAllocate`, same denominators, same
  per-row 2dp ex-VAT, same received/expected partition.
* **Credits, payments, overrides.** Untouched.
* **`server.js` and `apps-script/Code.gs`.** Not one line — asserted, token by
  token. No new endpoint.
* **`index.html`.** One label corrected (the צפוי card no longer claims to count
  "מטופלים פעילים"); no new static markup — the note, the badges and the bucket
  are all built by the renderer.

---

## Files

| File | Change |
| --- | --- |
| `public/app.js` | `RECORDS_COMPLETE_FROM` + `isPreRecordsCycle()`; `patientExitISO` / `patientStayCoversDate` / `patientStayOverlapsRange` / `patientDueOnDate`; `dayOfMonth()` routed through `isoDate()`; `patientsDueOn` rewritten; the KPI cards, open balances, monthly summary and row badges; `buildMonthlyRevenue`'s EXPECTED pass reads the stay and routes pre-cutoff cycles to `preRecords`; the composition panel and drill-down group |
| `public/style.css` | the `pre-records` and `warn` badges, the note, the muted drill-down row and headings |
| `public/index.html` | the צפוי card's sub-label |
| `test/stay-window-records-cutoff.test.js` | **new** — 19 tests |
| `test/stay-window-records-cutoff-browser.test.js` | **new** — 3 Playwright/Chromium tests |
| `test/monthly-revenue.test.js` | `build()` pins `recordsFrom` before its January 2026 fixtures (see below) |
| `test/monthly-revenue-browser.test.js` | the cash-vs-forecast fixture moved to a post-cutoff month |

### Why the existing suites needed a date

`buildMonthlyRevenue` takes an optional `recordsFrom`, defaulting to the
constant. It exists for the **tests**: that suite is about the allocation, and
its January 2026 fixtures predate the cutoff, so every projected cycle in it
would land in the לפני תחילת הרישום bucket and it would stop testing the
arithmetic. **Nothing in the app passes it** — `renderMonthlyRevenue()` hands
over no override and `app.js` contains no `recordsFrom:` at all, both asserted,
so production can only ever read the constant.

## Tests

`test/stay-window-records-cutoff.test.js` — 19 tests, vm-sandboxed on the real
shipped `app.js`, TZ pinned to `Asia/Jerusalem`:

* **A** the stay window — the עמית בורנשטיין case and all five other reported
  September admissions, a discharged patient due inside their stay and not
  after, both ends inclusive, the released-without-exit-date fallback, the
  UTC-timestamp drift at an anchor *and* at a boundary, and one rule shared by
  both screens (each helper declared exactly once).
* **B** discharged patients in past months — July EXPECTED includes an August
  discharge (22 of 31 days), the stay still ends, and an active patient's figure
  is unchanged.
* **C** the cutoff — one constant written once, the boundary day is *inside* the
  records, timestamp normalization, a June cycle in its own bucket and in no
  total (EXPECTED, NET, byHouse all checked), the **before/after delta computed
  on the same data**, a recorded pre-cutoff row still counting, and nothing in
  the app overriding the constant.
* **D** the cutoff on all four screens, the row badges, and the drill-down group.
* **E** the daily list and the monthly view agree about July — same people, same
  due dates, walked day by day.
* **F** scope + security — read-only, nothing mutated, no backend touched,
  everything escaped, no new static markup.

`test/stay-window-records-cutoff-browser.test.js` — 3 Chromium tests: the
September admission is gone from the 07/07 list (and present on 07/09), a
pre-cutoff cycle is listed + badged + noted but outside סך לגבייה, and July's
revenue screen counts the August discharge while bucketing the June cycle apart
— with the ex-VAT figure asserted against the arithmetic.

Full suite: **1,304 passing**.

## Deploy note

Front-end only — `public/app.js`, `public/style.css`, `public/index.html`.
**No Apps Script deploy, no sheet change, no migration.**
