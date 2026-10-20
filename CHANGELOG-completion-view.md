# «השלמת תקופת טיפול» — completion view in «חתכי מטופלים»

**What:** a new section in «חתכי מטופלים» that answers "of the stays that
entered in the period, how many reached N days?" — one card per threshold
(30, 60, plus an optional custom one), with the patient list behind every
number, a CSV section and an Excel sheet.

Base: `claude/build-ezone-dashboard-QOg5s` at `40250c3` (after #257–#259).
Code.gs is **unchanged**. No new file, no new route. SW `v79` → `v80` (live
`/sw.js` read v79 on 20/10/2026; v17 never reused).

## Rules (`lib/patient-retention.js` → `computeCompletion`)

`computeCompletion({ patients, discharged, from, to, thresholds = [30, 60], today })`

- **Cohort** = the same as the rest of the panel: stays whose **entry date** is
  in `[from, to]` (inclusive). No cohort-mode toggle.
- **stayDays** = the same rule as today: discharge day first (audit `exitDate`
  → `dischargedAt` day → Patients `exitDate`), **not inclusive** (same day = 0);
  an active stay counts to `today`. It reuses `computeRetention`'s placement,
  so every number agrees with the bucket cards.
- Per threshold N:

  | Count | Rule | In the rate? |
  | --- | --- | --- |
  | «הגיעו לסף» `reached` | discharged with days ≥ N, **or** active with days ≥ N | yes (numerator + base) |
  | «עזבו לפני הסף» `leftEarly` | discharged with days < N | yes (base) |
  | «מוקדם לקבוע» `tooEarly` | active with days < N | **no** |

  `evaluable = reached + leftEarly`; `rate = reached / evaluable`, or **`null`**
  when evaluable is 0 — rendered «אין מספיק נתונים», never 0% or NaN.
- Thresholds: whole numbers 1–3650; invalid ones dropped, duplicates once.
- Missing / unplaceable rows (no entry date, no discharge date, discharge
  before entry, entry after today) go to «נתונים חסרים» with the same reasons
  and rows as `computeRetention`; they are never counted.
- Every count is the length of the list behind it (`results[i].rows[key]`).

New exports: `computeCompletion`, `completionResult`, `completionListFor`,
`formatRate`, `normalizeThresholds`, `completionTable`, `completionListRows`,
`completionToCsv`, `completionCsvFilename`, labels/constants. `validSelection`
and `listTitle` accept `{ kind: 'completion', threshold, key }`.

## UI (`public/app.js`, `public/style.css`)

- Section «השלמת תקופת טיפול» under the cross table: one card per threshold
  with the rate, "מתוך X שניתן להעריך", and three clickable counts that open the
  patient list below (same table, CSV and «ייצוא לאקסל» of the list).
- «סף נוסף (ימים)» input adds a third threshold (separate from the existing
  «לתקופה מסוימת» split, which is untouched).
- Note: «מטופלים שטרם הגיעו לסף אינם נספרים באחוז».
- The existing bucket / continuity cards are **unchanged** (a test pins the
  HTML byte-for-byte with and without the new section).
- Every rendered value goes through `escapeHtml`; selection JSON is escaped.
  All controls ≥ 44px.

## Export

- **CSV** — «ייצוא CSV» on the section: the numbers table (same values as the
  cards; null rate = «אין מספיק נתונים»), the note, every row behind every
  number, and the «נתונים חסרים» rows. Same formula guard / BOM / CRLF as the
  other CSVs.
- **Excel** — new sheet «השלמת טיפול» (`lib/report-xlsx.js completionSheet`):
  numbers table (rate as a `0.0%` cell, or the text «אין מספיק נתונים»), the
  note, the row list, the missing count. Included in «ייצוא הכל לאקסל» (now 8
  sheets, inserted after «המשך טיפול») and as section export `completion`
  («השלמת טיפול» + «נתונים חסרים»). Values are read from the report the screen
  renders — never recomputed.

## Tests

`test/completion-view.test.js` (14): boundary at exactly N, active above /
below N, discharged same day, evaluable = 0, custom threshold, missing dates,
list-behind-number identity, CSV numbers + formula guard, page cards + note +
unchanged bucket cards, escaping, stale selection fallback, Excel values equal
screen values (section + full export), formula-looking names, wiring (no
Code.gs change, SW v80). Updated: `report-xlsx*.test.js` (7 → 8 sheets),
`dashboard-perf-assets.test.js` (v80).

## Security

No server change, no new input reaches the backend. Thresholds are validated
to integers 1–3650. HTML escaped; CSV/Excel cells formula-guarded; download
filenames ASCII-sanitized. `npm audit`: 0 high / 0 critical.
