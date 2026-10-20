# «ייצוא לאקסל» for every חתך — leads funnel + patient retention (PR 3 of 3)

**What:** a real Excel export of «חתכים בלידים» and «חתכי מטופלים», built in the
browser. The CSV buttons stay.

Base: `claude/build-ezone-dashboard-QOg5s`, stacked on PR #258, which is
stacked on #257. Merge them in order. Code.gs is **unchanged**. There is **no
server export route**. SW `v78` → `v79` (live v76 verified 20/10/2026; v17
never reused).

## Why no library

The app loads every script from its own server: there is no CDN and no
`express.static`, so each file gets an explicit route. A vendored xlsx library
would have meant a large third-party file plus a licence to track. The common
browser one (SheetJS on npm, 0.18.x) also carries known advisories. Instead,
`lib/report-xlsx.js` is a small, dependency-free OOXML writer: a stored ZIP
with CRC-32, plus the minimum SpreadsheetML parts. The tests read every file
back with **exceljs** (already a pinned dependency) and the output was also
checked with openpyxl. No new npm dependency, no vendored file, no licence
note needed.

## `lib/report-xlsx.js` (pure, `window.ReportXlsx`)

- `writeXlsx({ sheets })` returns a `Uint8Array`. Its output is deterministic:
  the same input gives the same bytes.
- **Numbers are never recomputed.** Each sheet reads the report objects the
  panels render: `LeadsFunnel.funnel(...)` and
  `PatientRetention.computeRetention(...)`, with their counts, percentage
  fractions and row lists. A count cell is `report.counts.x`, never a re-count.
- **Formatting:**
  - right-to-left sheet view;
  - the header row is bold, on a `#D9E2F3` fill, and frozen;
  - column widths come from the spec;
  - dates are real Excel dates (`dd/mm/yyyy`), and an invalid date stays text;
  - percentages are numbers with a `0.0%` format; an empty base leaves the
    cell empty, never 0% or NaN;
  - integers are numbers;
  - phones and all text are string cells with the `@` format, so leading zeros
    are kept.
- **Security:**
  - Every text cell is formula-guarded with **the CSV rule exactly**: a value
    starting with `=` `+` `-` `@`, a tab or a CR gets a leading `'`. A test
    pins it to `LeadsFunnel.csvCell`.
  - No cell is ever a formula.
  - Characters XML forbids are dropped, everything else is escaped, and a CR
    is kept as `&#13;`.
- **Sheet names** are made safe (≤ 31 characters, no `: \ / ? * [ ]`, no edge
  apostrophes, never blank) and unique.

## The files

**«ייצוא הכל לאקסל»** (on both panels) produces one file,
`ezone-chitukim-<from>_<to>.xlsx`. It holds both reports for the panel's
period (the retention custom split is the one set on its panel):

| # | Sheet | Content |
|---|---|---|
| 1 | «סיכום» | Period (real dates); both cohort-rule labels; how days are counted; «הופק ב־» (Israel time); every headline count and percentage from both reports |
| 2 | «לידים – חתך» | לא רלוונטי / הגיעו לפגישה ולא נכנסו / נכנסו לבית, plus the period total |
| 3 | «לידים – רשימה» | The lead rows behind each count, with «קטגוריה» |
| 4 | «שהות – חתך» | Bucket counts plus % of the cohort; עדיין בטיפול with its breakdown; custom split (% of the discharged); a «בסיס האחוז» column |
| 5 | «המשך טיפול» | Continuity counts plus % of the discharged; then the bucket × continuity cross table |
| 6 | «מטופלים – רשימה» | Every placed stay once, with «קטגוריית שהות» and «המשך טיפול» (and «מטופל חוזר») |
| 7 | «נתונים חסרים» | The stays excluded for missing or invalid dates, with the reason |

**Section exports** («ייצוא לאקסל»), each with only its own sheets:

| Button | File | Sheets |
|---|---|---|
| On the leads funnel | `ezone-leads-funnel-<from>_<to>.xlsx` | 2 + 3 |
| On the retention summary | `ezone-retention-<from>_<to>.xlsx` | 4 + 6 + 7 |
| On the continuity view | `ezone-continuity-<from>_<to>.xlsx` | 5 + 6 |

**List exports:** every click-a-count list (patients, missing data, and the
funnel's lead list) has its own «ייצוא לאקסל». It exports only that list, as
one sheet named after the list (`ezone-patients-list-…` /
`ezone-leads-list-…`).

## Wiring

- `server.js`: `/report-xlsx.js` is a static code asset, served by the same
  `sendLibAsset` route as `/leads-funnel.js`. It carries no data and is not an
  `/api/` route. The workbook is built in the page.
- `index.html`: the script loads after `leads-funnel.js` and
  `patient-retention.js`, and before `app.js`.
- `sw.js`: the file is added to `BUNDLE_PATHS`. `PRECACHE_URLS` lists only
  `public/` files, and this one lives in `lib/`.
- `style.css`: the new buttons are ≥ 44px with 16px text.

## Tests

`test/report-xlsx.test.js` reads every workbook back with exceljs and checks:
- sheet names and order (full, section, list);
- name sanitizing and duplicates;
- RTL, the frozen bold header and its fill, column widths;
- that **every summary, count, list, percentage and cross-table value equals
  the report object**;
- that dates are real dates and an invalid date stays text;
- that phones keep their leading zeros as text, and `+972…` is guarded;
- that percentages carry the `%` format;
- the formula guard (equal to the CSV rule, never a formula);
- that XML-hostile text still opens;
- that an empty period gives headers only, and a bad range doesn't crash;
- a 5,000-stay list;
- CRC-32 and determinism, filenames, and purity;
- page-level behaviour: «ייצוא הכל לאקסל» produces one file whose numbers
  equal the panel reports; section and list file names and sheets; a missing
  module shows an error; the buttons; the wiring.

`test/report-xlsx-browser.test.js` builds the workbook in real Chromium from
the shipped scripts and reads it back.

## Security

- Built in the browser from data the session already holds.
- No new `/api/` route, no Code.gs change, no secrets.
- Formula-guarded text cells; `escapeHtml` on every rendered label.
- `npm audit`: 0 high / 0 critical (1 pre-existing moderate). No new
  dependency.
