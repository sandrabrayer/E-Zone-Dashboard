# «חובות פתוחים» — the debt-aging screen and its .xlsx export

Plan: `docs/billing-control-plan.md` §14.1. Branch `feat/debt-aging-ui` →
base `claude/build-ezone-dashboard-QOg5s`. Builds on
`CHANGELOG-debt-aging-foundation.md` (PR #161, the `debtAging` action) and
`CHANGELOG-xlsx-export.md` (PR #160, `lib/xlsx-report.js`).

**`apps-script/Code.gs` and `appsscript.json` are unchanged.** The screen and
the export use only the existing read-only `debtAging` action. There is no new
server math: the server's cycles are **filtered** (house, patient status) and
**grouped** into tables, nothing else. With no filter, every table cell equals
the server's own `totals` / `byHouse` (a test runs the real `Code.gs` and
checks it).

## Where it is

On the **גבייה** tab, a collapsible section **«חובות פתוחים»**, directly under
the payout section («זיכויים ממתינים לתשלום» and its refund forecast /
«ייצוא להנהלת חשבונות» buttons), and above «סיכום חודשי». It is collapsed by
default.

## What it shows

**Controls**
- «נכון לתאריך»: a date picker, default today in Asia/Jerusalem (whatever the
  device's clock zone), and a «סוף חודש קודם» button (the last day of the
  previous month).
- «בית»: כל הבתים + each house, Hebrew names.
- «סטטוס»: כל המטופלים / פעילים / משוחררים. `released` = משוחרר; `active`,
  `trial` and `wait` = פעיל. This is the patient's **stored** status.
- «רענון» and «ייצוא לאקסל».

**Two blocks, never added together**
- **«חוב רשום»** — a Payments row exists and is unpaid or partial at the date.
- **«מחזורים ללא רישום»** — no Payments row at all («לא שולם או שולם ולא
  נרשם»).
- Each block is a table: houses × aging buckets (0–7, 8–30, 31–60, 61+ days)
  with a total column and a total row, in ₪ (VAT-inclusive, as stored).
- No combined figure exists anywhere: not in the view object, the DOM, or the
  workbook.

**Beside the blocks:** «זיכויים ממתינים — לא מקוזזים מהחוב», the credits
pending at that date per house (amount and count). Never subtracted.

**Drill-down:** house → patients (name, status, recorded balance, unrecorded
total, oldest bucket) → expand a patient → cycles (start, end, expected,
received, balance, bucket, kind). Native `<details>`, no extra state.

**Separate collapsible lists, each with its own count (and total when the
report carries an amount), never in the debt figures:**
| List | Count | Total |
|---|---|---|
| תשלומים לא משויכים (`detachedPayments`) | ✅ | the rows' `amount` |
| תשלומים אחרי יציאה (`outsideStay`) | ✅ | — the server returns no amount for these rows |
| משוחררים ללא תאריך יציאה (`releasedWithoutExit`) | ✅ | — no cycles are made for them |
| מטופלים בסכום אפס | ✅ | ₪0 by definition |
| ללא תאריך כניסה (`noEntryDate`) | ✅, shown only when not empty | — |

A "zero-amount patient" is a patient the server returned whose every cycle has
a balance of 0 (monthly amount 0, or overridden to 0). Zero-balance cycles are
never shown in the drill-down.

**Caveats, only when relevant**
- `receivedDateUnknown.count > 0` → «X תשלומים ללא תאריך קבלה — הוערכו לפי
  תחילת המחזור».
- as-of date before today (Israel) → «בתאריך עבר, תשלום שהושלם מאוחר יותר
  עלול להופיע כחוב».

**States:** «טוען חובות פתוחים…» while loading; an explicit error in the box
and the banner («טעינת החובות הפתוחים נכשלה — … אין להסיק שאין חוב») on
failure; «אין חוב פתוח בסינון זה» when the filter has nothing; «פתחו את הסעיף
כדי לטעון» before the first open. Never a silent empty view.

**When it fetches:** only when the section is opened, when the as-of date
changes while it is open (including «סוף חודש קודם»), and on «רענון». The
house and status filters re-render from the loaded data with no fetch. A
response for an older date that arrives late is dropped. An invalid date is
never sent.

## Export — `GET /api/export/debt-aging.xlsx`

`?asOf=YYYY-MM-DD&house=<all|id>&status=<all|active|discharged>`

- Middleware: `requireSession` → `validateDebtAgingExportQuery` →
  `requireProxySecret` → handler.
  - No session → **401**.
  - `asOf` missing, not `YYYY-MM-DD`, not a real day (`2026-02-30`), or
    repeated → **400 `bad_asOf`**. Unknown or repeated `house` → **400
    `bad_house`**. Unknown `status` → **400 `bad_status`**. Own-property checks
    only, so `__proto__` / `constructor` are refused.
  - No `PROXY_SECRET` → 503 (fail-closed).
- Reads `debtAging` through `sheetsPost` (the secret is attached there; the
  `user` is the session user). The answer must be a debtAging response **for
  the requested date**, else 502 `bad_response`.
- Built by `lib/xlsx-report.js` from `lib/debt-aging-xlsx.js` — the same
  formatting standard as the refund export: RTL, title + «הופק ב־» row, bold
  filled header, frozen and filtered, `"₪"#,##0`, real dates as `dd/mm/yyyy`,
  bold total rows, formula-guarded text, no formulas.
- Headers: `Content-Type` xlsx, `Content-Disposition: attachment;
  filename="debt-aging-YYYY-MM-DD.xlsx"; filename*=UTF-8''<חובות-YYYY-MM-DD.xlsx>`
  (the **as-of** date; the day is re-validated so nothing from the request
  reaches the header), `Cache-Control: no-store`, `X-Content-Type-Options:
  nosniff`, `Content-Length`.
- Failures: JSON `{ok:false, error}` with `no-store`. `lock_busy` → 503;
  backend `{ok:false}` / malformed → 502; network → 502
  `sheets_unreachable`; build error → 500 `xlsx_build_failed`.
- Logs: an error code, or `ok, bytes=N`. Never a name, amount or body.

**Sheets**
| Sheet | Content | Total |
|---|---|---|
| «סיכום» | Note «שני הגושים אינם מסתכמים יחד · זיכויים ממתינים אינם מקוזזים מהחוב · הסכומים כוללים מע"מ». «חוב רשום» houses × buckets; «מחזורים ללא רישום» houses × buckets; «זיכויים ממתינים — לא מקוזזים מהחוב» per house; «לבדיקה — לא נכלל בחוב» (count / amount per list, no total row); «פרטי הדוח» (date, house, status, caveats) | each block its own total row; credits their own |
| «חוב רשום» | patient, house, status, cycle start, end, expected, received by the date, balance, days, bucket | «סה"כ חוב רשום» |
| «מחזורים ללא רישום» | patient, house, status, start, end, expected, days, bucket, «לא שולם או שולם ולא נרשם» | «סה"כ מחזורים ללא רישום» |
| «תשלומים לא משויכים» | name on the row, house, due date, amount, received by the date, reason | amount + received |
| «תשלומים אחרי יציאה» | patient, house, status, cycle start, entry, exit | count |
| «חסרי תאריך יציאה» | patient, house, entry | count |

The house and status filters apply to every sheet, so the file matches the
screen.

## Files

- `lib/debt-aging-xlsx.js` (new): `debtAgingView`, `debtAgingCaveats`,
  `buildDebtAgingSpec`, `validateDebtAgingQuery`, `isDebtAgingResponse`,
  `debtAgingContentDisposition`, the labels. House names come from
  `lib/refund-forecast-xlsx.js` (no new copy).
- `server.js`: the route, `validateDebtAgingExportQuery`,
  `debtAgingXlsxHandler({ fetchAging, now })` (injectable for tests).
- `public/app.js`: the browser copy of `debtAgingView` / `debtAgingCaveats`
  and the labels (`DEBT_AGING_*`), `debtAgingHtml` (every value through
  `escapeHtml`; bucket ranges in `dir="ltr"` so «8–30» never flips),
  `loadDebtAging`, `renderDebtAging`, `exportDebtAgingXlsx`,
  `initDebtAgingControls`. A test fails if the two copies drift.
- `public/index.html`: the section. `public/style.css`: `.debt-*` rules; the
  tables scroll inside their box at phone width (390 px: no page scroll).
- `public/sw.js`: `CACHE_VERSION` **v23 → v24**. `/api/export/*` is already
  `network-only` (never intercepted, never cached).

## Tests

**New: `test/debt-aging-ui.test.js`, 25 tests** (vm sandbox on the real
`Code.gs` and `app.js`, TZ Asia/Jerusalem, synthetic names):
- no new math: the tables equal the server's `totals` / `byHouse` per bucket;
- bucket tables: row totals, column totals, exact fixture figures;
- never summed: the view walked key by key, the DOM, every xlsx cell;
- filters: house, status (trial counts as active; the two status halves
  partition each block), lists and credits follow the filter;
- the drill-down render (house → patient → cycle rows, kind labels, the exit
  cycle clipped to the exit day, the empty-filter message);
- the separate lists: counts, totals, a ₪999,999 detached row moves no debt
  figure;
- caveats: shown only when relevant;
- escaping (`<img onerror>` names, hostile house ids);
- the state machine: no fetch on init, a filter or a closed-section date
  change; fetch on open and on «סוף חודש קודם»; loading / error / wrong-date /
  invalid-date / late-response states;
- dates: Israel today across midnight, previous month end (incl. leap years);
- the export button: URL, `no-store`, `חובות-<asOf>.xlsx`, Hebrew errors, a
  401 shows the PIN screen;
- `index.html` placement;
- drift: labels and the view, app.js ↔ lib, on several filters and dates;
- xlsx: six sheet names, RTL / frozen / autoFilter on each, formats, totals,
  the summary blocks, the house filter;
- route: 401, twelve 400 cases, 503 fail-closed; success headers and the
  as-of filename; asOf and the session user forwarded; no patient data in
  logs; failure codes;
- SW: v24, the export never intercepted or cached.

**New: `test/debt-aging-ui-browser.test.js`, 1 test** (real Chromium; skipped
when Playwright or Chromium is missing, like the other `*-browser` tests): no
fetch before opening; two blocks with their own totals and no sum; drill-down
expands to the exact cycle cells; a hostile name renders as text and never
runs; filters re-render with no fetch; «סוף חודש קודם» refetches and shows
the past-date caveat. It ran and passed in this session.

**Updated:**
- `test/lock-busy-frontend.test.js`: `debtAging` added as a busy-lock path
  (its guard requires every `apiPost` action to have one).
- `test/debt-aging-foundation.test.js`: the "nothing user-facing yet" pin now
  asserts the UI reads the action through `apiPost`.
- `test/xlsx-export.test.js`: the SW pin is now "v23 or later".

- `test/payment-coverage-period.test.js`, `test/detached-payments.test.js`,
  `test/duplicate-payment-void.test.js`: their "no new endpoint" guard read
  `handle_` through a fixed 6,000-character window. PR #162 (personal PINs,
  merged into the base while this branch was open) made `handle_` longer, so
  the window stopped before `accountingPayments` and the three tests were
  **red on the base itself** (318d3ff). The guard now reads the whole
  `handle_` function and still asserts the exact same set of payment actions.

**Full suite: `npm test` → 1850 / 1850** after the rebase onto 318d3ff
(base: 1822 tests, 3 of them failing as above; this PR adds 28: 25 here, 1
browser, 2 lock-busy). One run showed a single intermittent failure in the
existing Chromium test `test/detached-payments-browser.test.js` under the
parallel load; it passed alone 3/3 and on the full rerun. Browser tests are
skipped in CI.

## Deploy

- **Railway** serves the new `server.js`, `lib/` and `public/`. SW v24 evicts
  v23. No new dependency, no env var.
- **Apps Script:** nothing to deploy.
- **Not verified live:** the live site is not reachable from this
  environment. Open one export in Excel after deploy to confirm the look.
