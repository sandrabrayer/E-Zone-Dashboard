# «ייצוא להנהלת חשבונות» — a formatted .xlsx instead of the CSV

**What:** the «ייצוא להנהלת חשבונות» button on the גבייה tab (added in PR #159,
`CHANGELOG-refund-payout-forecast.md`) now downloads a formatted Excel file
built on the server. The browser-built CSV and all its code are gone.

The workbook comes from a new **shared** helper, `lib/xlsx-report.js`, so any
future report can be exported the same way by passing it a plain spec.

Base: `claude/build-ezone-dashboard-QOg5s`. Branch: `feat/xlsx-export`.
`apps-script/Code.gs` is **unchanged**: the existing read-only
`action=refundPayoutForecast` already returns everything the file needs.

## Dependency

- `exceljs` **4.4.0**, pinned exactly (`"exceljs": "4.4.0"`).
- exceljs 4.4.0 depends on `uuid@^8`, which `npm audit` flags (GHSA-w5hq-g745-h8pq,
  moderate: a missing bounds check in uuid v3/v5/v6 **when a `buf` is passed**).
  exceljs only calls `uuid.v4()` with no buffer, so the path is unreachable,
  but `package.json` now pins `"overrides": { "uuid": "11.1.1" }` (the fixed
  release, still CommonJS-compatible) so the audit is clean for this change.
- `npm audit` after this change: **2 findings, both pre-existing and both in
  express's own tree** (`body-parser` low, `qs` moderate). They were already
  reported on the base branch before exceljs was added and are not touched
  here. Before the override, exceljs had added 2 more (`uuid`, and `exceljs`
  itself as its dependent); with the override it adds none.

## Shared helper — `lib/xlsx-report.js`

`buildXlsxReport(spec) → Promise<Buffer>`. Spec:

```js
{
  generatedAt: Date,
  sheets: [{
    name, title, note?,                        // tab name, row-1 title, optional note row
    columns: [{ header, key, type: 'text'|'money'|'date'|'int', width }],
    rows: [{ …by key }],
    totals: [{ label, values: { key: number } }],
    emptyText?,                                // written when there are no rows
    // or, for several tables on one sheet:
    sections: [{ heading, columns, rows, totals, emptyText }],
  }],
}
```

**Formatting, every sheet:**
- right-to-left view;
- row 1: the title (bold, 14pt); row 2: «הופק ב־DD/MM/YYYY HH:MM» in Israel
  time; then the optional note;
- the header is bold on a fill colour (`#D9E2F3`). The sheet's first header is
  frozen and carries the autoFilter (Excel allows one autoFilter per sheet);
- `money` → a number shown as `"₪"#,##0`; `int` → `0`;
- `date` → a real Excel date (from `YYYY-MM-DD` or a `Date`) shown
  `dd/mm/yyyy`. An impossible date (e.g. `2026-02-30`) stays as text, never a
  wrong date;
- an empty money/date/int value stays an **empty cell, never 0**;
- each table's totals rows are bold, on a grey fill with a top border. The
  helper writes only the totals it is given — it never adds one table to
  another;
- column widths from the spec, minimum 10 (exceljs silently drops a width of
  exactly 9 as "default").

**Security:**
- every text cell is formula-guarded: a value starting with `=` `+` `-` `@`, a
  tab or a CR gets a leading `'`;
- values are always written as plain values — the helper never writes a formula;
- the helper logs nothing.

## The export — `lib/refund-forecast-xlsx.js`

`buildRefundForecastSpec(data, now)` turns the `refundPayoutForecast` response
into five sheets:

| Sheet | Content | Total |
|---|---|---|
| «סיכום» | Note «הסעיפים אינם מסתכמים יחד». Four tables: הוחלט by payout date, הוחלט by house, ממתין להחלטה by payout-date-if-decided-today, ממתין להחלטה by house. A fifth table of **counts only**: חסרים נתוני תשלום, לא ניתן לחשב, אפס לפי מדיניות. | Each of the four tables has its own section total. The counts table has **no** total. |
| «הוחלט» | Payout date (the stored one), patient, house, amount, decided date, rule, override reason | «סה"כ הוחלט» |
| «ממתין להחלטה» | Note: a suggestion only, not decided, not for payment. Patient, house, entry, exit, suggested amount, rule, payout date if decided today | «סה"כ ממתין להחלטה (הצעה בלבד)» |
| «חסרים נתוני תשלום» | Patient, house, entry, exit, «אין תשלום רשום — לבדוק». **No amount column.** | count |
| «לא ניתן לחשב» | Patient, house, entry, exit, Hebrew reason | count |

- Every total comes from the server's own `total` / `count` fields; nothing is
  re-added across sections.
- An empty section says so in words (e.g. «אין שחרורים הממתינים להחלטה»).
- House names, rule labels, section labels and error labels are copies of the
  constants in `public/app.js`. A test fails if the copies drift.

## Route — `GET /api/export/refund-forecast.xlsx` (`server.js`)

- Middleware: `requireSession` → `requireProxySecret` → handler. No session →
  **401**; no `PROXY_SECRET` → 503 (fail-closed).
- Calls `refundPayoutForecast` through the existing `sheetsPost`, which attaches
  `PROXY_SECRET`; the `user` is the session user from the signed cookie.
- Success headers:
  - `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `Content-Disposition: attachment; filename="refund-forecast-YYYY-MM-DD.xlsx"; filename*=UTF-8''<זיכויים-לתשלום-YYYY-MM-DD.xlsx, RFC 5987-encoded>`
    — the date is the Israel day; the ASCII `filename=` is the fallback for
    old clients;
  - `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Length`.
- Failures answer JSON `{ok:false, error}` with `no-store`: `lock_busy` → 503;
  an `{ok:false}` or malformed backend response → 502 (`bad_response` or the
  backend's code); network failure → 502 `sheets_unreachable`; a build error →
  500 `xlsx_build_failed`.
- **Logs:** only an error code, or `ok, bytes=N`. Never a patient name, an
  amount or a response body.
- The handler factory `refundForecastXlsxHandler({ fetchForecast, now })` is
  exported so the tests can run it without Apps Script.

## UI (`public/app.js`)

- The button calls `exportPayoutForecastXlsx()` inside `busyButton(…, 'load', …)`,
  so it shows the shared spinner + «טוען…» while busy and can't double-fire.
- It `GET`s the route with `cache: 'no-store'` and downloads the blob as
  `זיכויים-לתשלום-YYYY-MM-DD.xlsx`.
- On failure it shows «הייצוא נכשל — <reason>» in the error banner, with a
  Hebrew reason: «המערכת עסוקה, נסו שוב», «אין חיבור לגיליון הנתונים», «אין
  חיבור לשרת», «נדרשת התחברות מחדש» (a 401 also shows the PIN screen), …
- Removed: `csvCell`, `csvLine`, `buildPayoutForecastCsv`, `payoutForecastStamp`,
  `exportPayoutForecastCsv`.
- `index.html` and `style.css` are unchanged: the button keeps its id and label.

## Service worker

`CACHE_VERSION` **v22 → v23** (`app.js` changed). The export route is under
`/api/`, which `cacheStrategy()` already classes `network-only`: the SW does not
intercept it and never writes it to the cache. A test pins that.

## Tests

**New: `test/xlsx-export.test.js`, 21 tests.**
- **Helper** (re-opening the buffer with exceljs): RTL; title and «הופק ב־» rows
  in Israel time; bold filled header; frozen at the header row; autoFilter
  range; `"₪"#,##0`, `0` and `dd/mm/yyyy` formats; real `Date` cells; empty
  values stay empty; an impossible date stays text; the formula guard on `=`
  `+` `-` `@` and tab; no formula cells; bold total row; column widths; a bad
  spec throws.
- **Workbook:** the five sheet names; every sheet RTL, frozen and filtered;
  row content and rule labels; missing rows have no amount column and no 0;
  the summary per date / per house / counts.
- **Never summed:** no cell equals decided + awaiting; no "grand total" label;
  each summary table carries only its own section total; the counts are never
  added up; changing one section never moves another's total.
- **Label drift:** the server copies equal the `app.js` constants.
- **Route:** the real app gives 401 without (or with a bad) session and 503
  without `PROXY_SECRET`; with a stub backend: content type, the exact
  RFC 5987 `Content-Disposition`, `no-store`, `nosniff`, `Content-Length`, a
  loadable workbook, the session user forwarded, and no patient data in the
  logs; failure cases answer JSON with `no-store`; the header can't be injected.
- **SW:** `/api/export/*` is `network-only`, not intercepted, nothing cached;
  `CACHE_VERSION` is v23.
- **UI:** the CSV code is gone; the click is wrapped in `busyButton`; a
  successful export GETs the route with `no-store` and downloads the `.xlsx`
  name; every failure throws a Hebrew message.

**Updated:** `test/refund-payout-forecast.test.js` — test G (the CSV) now runs
the real `Code.gs` forecast through the `.xlsx` builder and checks the five
sheets, the formula guard and that a missing row never shows 0.

**Full suite:** `npm test` → **1734 / 1734** (base was 1713).

## Deploy

- Railway installs the new dependency from `package-lock.json` (`npm ci`) and
  serves the new `server.js`, `lib/` and `app.js`; SW v23 evicts v22.
- No Apps Script deploy is needed: `Code.gs` and `appsscript.json` are unchanged.
- **Not verified live:** the live site is unreachable from this environment's
  network policy, and the file was not opened in Excel or LibreOffice — only
  re-read with exceljs. Open one export in Excel after deploy to confirm the
  look.
