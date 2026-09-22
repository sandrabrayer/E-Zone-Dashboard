# Every displayed date is DD/MM/YYYY

**Why:** dates were shown two different ways, and neither was the Israeli form.
`formatDate()` produced `he-IL`'s locale default — dots, no zero padding
(`9.5.2026`) — and the two coverage-period ranges printed raw ISO with an arrow
(`2026-09-22 → 2026-10-21`), left-to-right, in a right-to-left screen.

**Display only.** Nothing stored, posted to `/api/sheets`, written to Sheets, or
put in an `<input type="date">` changed. `isoDate()` / `isoTime()` remain the
canonical converters and every sort and comparison still runs on ISO strings.

---

## 1. Where dates are rendered (the full inventory)

Every hit found by grepping `public/app.js` and `public/index.html`. **26 of the
28 display sites already funnelled through two helpers**, so converting those
two covered most of the surface; five raw sites needed individual work.

### Via `formatDate()` — 20 sites, format changed `9.5.2026` → `09/05/2026`

| file:line | what |
|---|---|
| `public/app.js:3060` | renewal chip — `חידוש <date>` |
| `public/app.js:3106` | renewal confirm modal text |
| `public/app.js:3764` | irrelevant lead — `תאריך העברה` (`movedAt`) |
| `public/app.js:3908` | removed lead — `תאריך הסרה` (`removedAt`) |
| `public/app.js:3997` | discharged patient — `תאריך כניסה` |
| `public/app.js:4001` | discharged patient — `תאריך שחרור` (`exitDate`/`dischargedAt`) |
| `public/app.js:5061` | patient row — `תאריך כניסה` |
| `public/app.js:5077` | patient row — released badge suffix (`exitDate`) |
| `public/app.js:7314` | detached-payment card — `dueDate` chip |
| `public/app.js:7318` | detached-payment card — `linkedAt` |
| `public/app.js:7351` | reconnect candidate — `dueDate` chip |
| `public/app.js:7375` | reconnect candidate — `כניסה <date>` |
| `public/app.js:7378` | duplicate-cycle warning tooltip (`dueDate` list) |
| `public/app.js:7480` | גבייה pre-records note — `RECORDS_COMPLETE_FROM` |
| `public/app.js:7540` | גבייה pre-records pill — `עד <date>` |
| `public/app.js:7603` | carry-forward row — `תאריך מקורי · <date>` |
| `public/app.js:7662` | pre-records badge tooltip |
| `public/app.js:7663` | outside-stay badge tooltip (entry + discharge) |
| `public/app.js:7888` | KPI sub-label — `RECORDS_COMPLETE_FROM` |
| `public/app.js:8615` | revenue pre-records tooltip |

### Via `formatDateDDMMYYYY()` — 8 sites, already DD/MM/YYYY, now call `formatDateHe`

| file:line | what |
|---|---|
| `public/app.js:1593` | WhatsApp meeting-invite text |
| `public/app.js:1661` | WhatsApp invite body — meeting date |
| `public/app.js:2150` | meeting-report byline — `DD/MM/YYYY HH:MM` |
| `public/app.js:2709` | meetings board — week range label |
| `public/app.js:2730` | meetings board — day heading |
| `public/app.js:3353` | lead card — `נוצר` (view mode) |
| `public/app.js:9110` | week-picker option label |
| *(the helper itself, now deleted)* | |

### Raw ISO renders — 5 sites, converted individually

| file:line | what | now |
|---|---|---|
| `public/app.js:5927` | credit editor — `ישולם ב־<payoutDate>` | `formatDateHe(...)` |
| `public/app.js:6021` | credit editor — the same line recomputed live as the user types | `formatDateHe(...)` |
| `public/app.js:6178` | credits ledger — payout-group header | `formatDateHe(...)` in a `<bdi>` |
| `public/app.js:7632` | **גבייה — תקופת כיסוי** range | `dateRangeHeHtml(...)` |
| `public/app.js:8645` | **הכנסות חודשיות — חלון כיסוי** range | `dateRangeHeHtml(...)` |

### Found and deliberately NOT changed

| file:line | what | why |
|---|---|---|
| `public/app.js:5691`, `:5695`, `:5703` | `creditBasisText()` — the `חלון כיסוי … → …` calculation trail | **Persisted verbatim to the Sheets `reason` column.** Reformatting it would change stored data, which this change must not do. |
| `public/app.js:2835`, `:3332`, `:3356`, `:4765`, `:5926`, `:5936`, `:7640`, `:7641` | `<input type="date">` values | Must stay ISO — the browser rejects anything else. |
| `public/app.js:5900` | `<input type="month">` value | Same. |
| `public/app.js:5901`, `:6124` | `allocationMonth` display (`2026-09`) | A **month**, not a `DD/MM/YYYY` date. Left alone; converting it would need its own decision about `MM/YYYY`. |
| `public/app.js:7900`, `:8013` | `toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })` | Month-year headings (`ספטמבר 2026`) — already Hebrew, not a date. |
| `public/app.js:6499`, `:6506`, `:6521` | `patientKey` / `paymentId` identity strings | Stored keys, never displayed. |
| `public/index.html` | — | **No date is rendered as text in the shell.** Its only date markup is `<input type="date">` (`:191`) and `<input type="month">` (`:258`), both of which stay ISO, plus static `תאריך` labels. |
| `public/meeting-report.js` | `mrPickerDate()` | Out of the scope grepped here; already renders `DD/MM` (deliberately year-less in that compact picker). |

---

## 2. The helper

```js
function formatDateHe(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const bare = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (bare) return `${bare[3]}/${bare[2]}/${bare[1]}`;
  }
  const iso = isoDate(value);
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return typeof value === 'string' ? value : '';
}
```

- **A bare `YYYY-MM-DD` is split on its own digits and never reaches
  `new Date(...)`**, which parses that form as **UTC midnight** and renders the
  *previous* day for Israel (UTC+2/+3). That is the −1-day drift this repo has
  already fixed twice (`exitDate`, the coverage period); it must not come back
  at the display layer. A test proves it by counting `Date` constructions during
  the call — the count must be **0**.
- Anything else goes through `isoDate()`, which reads a timestamp's **local**
  calendar day — the rule every other reader in the file follows.
- Blank → `''`. An unparseable **string** comes back **unchanged**, so a
  corrupted cell is visible rather than disguised as a plausible date. A
  non-string with no honest text form (an invalid `Date`, `NaN`, an object)
  renders **blank** — `String()` would print `Invalid Date` / `[object Object]`,
  which is exactly the output this must never produce.

`formatDate(s)` is kept as a thin wrapper that adds the `—` placeholder for a
blank date (~20 call sites read better with it built in) and delegates here.
`formatDateDDMMYYYY()` is **deleted** — it was the same thing under a second
name.

## 3. Ranges read right-to-left

```js
function dateRangeHeHtml(startValue, endValue) {
  const a = formatDateHe(startValue);
  const b = formatDateHe(endValue);
  if (!a && !b) return '';
  if (!a || !b) return `<bdi>${escapeHtml(a || b)}</bdi>`;
  return `<bdi>${escapeHtml(a)}</bdi> – <bdi>${escapeHtml(b)}</bdi>`;
}
```

The **start is written first**, so in the app's RTL flow it lands on the
**right**:

```
    <bdi>22/09/2026</bdi> – <bdi>21/10/2026</bdi>
     ←———————— reads this way ————————
```

Each date sits in its own `<bdi>`, so the bidi algorithm treats its digits and
slashes as one isolated run and can never reorder them against the Hebrew
around them. Both call sites **dropped their `dir="ltr"`** — that attribute was
papering over digit reordering at the cost of flipping the whole range to
start-on-the-left, which is the wrong reading order in a Hebrew screen.

The helper returns **already-escaped** HTML, so the two call sites interpolate
it without re-escaping. Its escaping is asserted directly, including an
`<img onerror>` payload.

## 4. Tests

### `test/date-format-he.test.js` — 19 tests

- **A** bare ISO date, ISO timestamp, `Date` object, blank, and five
  unparseable values (each returned unchanged, none matching `NaN|Invalid`).
- **B** no timezone shift: the bare path constructs **zero** `Date`s (counted,
  with a positive control proving the counter works); 00:30 and 23:45 local both
  keep their own day; `2026-09-21T21:30:00.000Z` renders `22/09/2026` in Israel
  and `2026-01-14T22:30:00.000Z` renders `15/01/2026` (both offsets); and a bare
  date is re-checked under `UTC`, `Pacific/Kiritimati` (+14) and
  `Pacific/Pago_Pago` (−11).
- **C** the range is start-first, two `<bdi>`s, an en dash; half-blank and fully
  blank cases; markup is escaped; both call sites dropped `dir="ltr"`.
- **D** the **source scan**: every `${…}` interpolation in `app.js` naming a
  date identifier must go through a formatter. Legitimate raw uses — `<input>`
  values, identity keys, `isoFromLocalDate`, the persisted `creditBasisText` —
  are allowlisted **explicitly, one line each**, and a further test asserts every
  allowlist entry still exists so a stale exemption cannot linger. A planted
  `${payment.dueDate}` is caught, so the guard is not vacuously green.
- **E** what must not have changed: `isoDate`/`todayISO` still emit ISO, the two
  coverage `<input>`s are still fed ISO, `formatDate` keeps its `—`, the bare
  `toLocaleDateString('he-IL')` call is gone while the two month-year headings
  remain, and the service-worker version was bumped.

### Existing tests updated

| file | why |
|---|---|
| `test/meeting-whatsapp-invites.test.js` | exported `formatDateDDMMYYYY` by name; now exports `formatDateHe` (assertions unchanged — the output was already `DD/MM/YYYY`) |
| `test/meetings-polish.test.js` | same — the epilogue alias and both call sites now use `formatDateHe` directly |
| `test/payment-coverage-period.test.js` | the escaping guard asserted `escapeHtml(covText)`; now asserts the window comes from `dateRangeHeHtml` **and** that no raw ISO reaches the markup outside an `input value=` |
| `test/monthly-revenue.test.js` | same guard, same treatment, for `windowHtml` |
| `test/payment-coverage-period-browser.test.js` | real-Chromium assertions on the rendered window: `20/01/2026 – 19/02/2026`, **two `<bdi>` elements**, and the **first one in source order is the start date**. The POSTed payload assertions (`coverageStart: '2026-01-20'`) are untouched — that is what proves this is display-only. |
| `test/monthly-revenue-browser.test.js` | the drill-down window, plus a new assertion that **no `YYYY-MM-DD` appears anywhere on the screen** |
| `test/stay-window-records-cutoff-browser.test.js` | the pre-records note now names `01/07/2026` instead of `1.7.2026` |
| `test/sw-install-fix.test.js` | its two `v15` pins were version-specific; now version-agnostic (`≥ v15`, name derived from the version), so a routine bump no longer breaks them |

### Pre-merge review

Three checks before merge, each with a change behind it:

1. **`git grep -n "formatDateDDMMYYYY" -- ':!CHANGELOG*'` must be empty.** It
   was not: `test/meetings-polish.test.js` still aliased the deleted name in
   its epilogue (`formatDateDDMMYYYY: (v) => formatDateHe(v)`) and called it
   twice, and two explanatory comments mentioned it. All five references are
   gone — the epilogue now exports `formatDateHe` and the two call sites use
   it directly. The grep is now empty (exit 1).

2. **Every value `dateRangeHeHtml` interpolates goes through `escapeHtml`.**
   Confirmed by reading the helper and now pinned two ways: a test that walks
   every `${…}` in the helper's source and asserts each contains
   `escapeHtml(`, and a payload test below.

3. **The escaping test now uses `<img src=x onerror=alert(1)>` on BOTH sides
   at once**, so neither position can be the one that leaks, plus each side
   alone and the single-date branch. It asserts the output contains no
   `<img`, that the payload appears escaped **twice**, and — a tag census —
   that the only tags in the output are the two `<bdi>` pairs the helper
   writes itself:

   ```js
   assert.deepEqual(both.match(/<[^>]+>/g), ['<bdi>', '</bdi>', '<bdi>', '</bdi>']);
   ```

   The payload's *characters* do survive as text (`&lt;img src=x
   onerror=alert(1)&gt;`) — that is correct and harmless: with `<` and `>`
   escaped it can never become a tag or an attribute.

### Full suite

```
npm test  →  1438 tests, 1438 pass, 0 fail, 0 skipped
```

## 5. Service worker

`CACHE_VERSION` **`v15` → `v16`**. `public/app.js` is the only shipped file that
changed, and the v15 copy is the offline fallback on any device that installed
it — evict it so no phone keeps rendering ISO dates.

## 6. Deployment

Push to the deploy branch; Railway redeploys `public/`. No env var, no Script
Property, no Apps Script deploy, no data migration.
