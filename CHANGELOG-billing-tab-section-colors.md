# גבייה — a colour per group, refunds without the "missing payment" section, coloured and auto-sized exports

Branch `ui/billing-tab-section-colors` → base `claude/build-ezone-dashboard-QOg5s`.
**`apps-script/Code.gs` is unchanged.** The server's `refundPayoutForecast` still
returns `missing_payment_data`; only the screen and the two `.xlsx` builders
changed.

Sandra: "the headings aren't prominent enough; each group needs its own clear
colour with a bold heading".

## 1. A colour per group (screen)

The colours are defined once:
- `lib/report-colors.js` (`GROUP_COLORS`) for the workbooks;
- the same hex values as CSS tokens on `:root` (`--grp-*`) in `public/style.css`.

A test keeps the two equal.

| Group | Token | Hex |
|---|---|---|
| «לגבייה בתאריך הנבחר» | `--grp-due` (blue) | `#7aa2ff` |
| «יתרות פתוחות מתאריכים קודמים» | `--grp-open` (amber) | `#f5b041` |
| «זיכויים ממתינים לתשלום» / הוחלט | `--grp-credits` (green) | `#3ddc84` |
| «ממתין להחלטה — לא לתשלום» | `--grp-awaiting` (purple) | `#b892ff` |
| «לא ניתן לחשב» and the separate lists | `--grp-unresolved` (grey) | `#a3acc2` |
| «חובות פתוחים» / «חוב רשום» | `--grp-debt` (red) | `#ff7a7a` |
| «מחזורים ללא רישום» (xlsx; the screen's block border) | `--grp-unrecorded` (orange) | `#ff9f43` |

- **Markup:** each group gets a wrapper, `<div class="bill-group bill-group--<key>">`.
  - The lists, ids and cards inside are unchanged.
  - The refund forecast renders its own purple and grey wrappers.
  - «חובות פתוחים» is the existing `<details>`, with the classes added.
- **The look:**
  - the heading is bold 700, 1.15rem, in the group colour, with a 4px bar on its start side (right in RTL);
  - the panel is a 9% tint of the colour over `--surface` (with a fallback where `color-mix()` is unsupported);
  - the chip uses the same colour.
- **Why the headings looked weak:** `.screen h3` (specificity 0,1,1) made every heading 14px, muted, uppercase and weight 600. The new rule is `.bill-group .bill-group-title` (0,2,0), which outranks it and undoes the uppercase and the letter-spacing.
- **Contrast:** every heading passes WCAG AA over its tinted panel. The lowest is 5.4:1 (blue).
- **Phone (360px):** headings wrap (`overflow-wrap: anywhere`) and the page does not scroll sideways. Both are checked in Chromium.

## 2. Discharges with no recorded payment are debt, not refunds (Sandra's decision)

- **The «חסרים נתוני תשלום» section is gone** from the refund view, and the sheet is gone from the refund `.xlsx`. They get no colour.
- **In the refund view, one muted line takes its place,** only when the count is > 0: «N משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״». It is a link: it opens «חובות פתוחים» (whose toggle loads it) and scrolls to it.
- **The refund `.xlsx` «סיכום» sheet** keeps the same line in its count-only table, with **no amount**.
- **The server check is looser:** `isForecastResponse` now needs only `missing_payment_data.count`, so a server that trims the rows keeps working.
- **Renamed:** «ייצוא להנהלת חשבונות» → **«ייצוא זיכויים לאקסל»**.
- **Cross-check (tested against the real `Code.gs`):** every `missing_payment_data` discharge is in `debtAging_`'s «מחזורים ללא רישום» as of the same day. This covers:
  - no payment at all;
  - only an earlier cycle paid;
  - only a void row;
  - two unrecorded cycles.

  **Two exceptions, reported and not fixed** (a fix needs server math, which this change does not make):
  1. **An unpaid row exists for the exit cycle** (`amountPaid: 0`). The forecast counts the patient as missing payment data. `debtAging_` lists them under **«חוב רשום»**, not «מחזורים ללא רישום», so they are still in «חובות פתוחים».
  2. **The exit cycle started before 01/07/2026** (for example, entry 20/06, exit 05/07). The forecast counts the patient, because the exit is on or after the cutoff. `debtAging_` starts at the cutoff, so **the patient is not in «חובות פתוחים» at all**, although the line says they are.

  Both cases are pinned in `test/billing-tab-section-colors.test.js`.

## 3. The workbooks (`lib/xlsx-report.js`, both exports)

- **Per-section `color`** in the spec, taking a `GROUP_COLORS` key. A one-table sheet takes `sheet.color`.
  - The section heading row is bold white on a dark shade of the colour, merged across all the section's columns. White passes AA on every shade (≥ 6.2:1).
  - The column-header row is a light tint (18%).
  - Total rows are bold on a medium tint (40%).
  - A one-table sheet shows its title row in the heading style.
  - Without `color`, the old neutral look stays.
- **Colours per export:**
  - refund: הוחלט green, ממתין להחלטה purple, לא ניתן לחשב and the count table grey;
  - debt: חוב רשום red, מחזורים ללא רישום orange, the credits line green, the separate lists grey.
- **Merges:** the title, the «הופק ב־» line, the notes, section headings and empty-table text all merge across the table width.
- **Widths are computed** from the longest displayed value in each column (headers, cells, totals; ₪ and dates as shown), plus padding, between 12 and 60.
  - Hebrew counts ×1.2 and bold ×1.1.
  - If a merged line is still wider than its columns, its columns are widened.
  - The spec's `width` fields are now ignored.
- **Rows:**
  - nothing wraps;
  - row heights are fixed: title 24, headings 22, rows 18;
  - blank separator rows are 6, so there are no oversized empty rows.
- **Notes:** `sheet.note` may be an array of lines.
  - The debt «סיכום» now carries the house/status filter line and the caveats as merged note lines, instead of the «פרטי הדוח» table.
  - With the table, a ~50-character caveat in column B widened the «0–7» column.
- **Printing:** each sheet prints one page wide (landscape when a table has more than 4 columns).
- **No product name anywhere:** «E-ZONE» is removed from both titles, and every workbook property (creator, lastModifiedBy, company, manager, title, subject, keywords, category, description) is blank. The download names are unchanged («זיכויים-לתשלום-…», «חובות-…»). A test scans every cell, sheet name, header/footer, property, raw XML part and filename for «איזון» and «E-ZONE».

**Visual check:**
- Both workbooks were converted with LibreOffice Calc 24.2 (headless) to PDF, then to PNG.
- The «סיכום» pages are in `docs/screenshots/billing-tab-section-colors/`: `xlsx-refund-summary.png` and `xlsx-debt-summary.png`.
- This was not checked in Excel itself.

## Service worker

`CACHE_VERSION` **v24 → v25**, because `app.js`, `index.html` and `style.css` changed.

## Tests

- **New: `test/billing-tab-section-colors.test.js`, 17 tests.** They cover:
  - the tokens equal `GROUP_COLORS`, and no group rule hard-codes a colour;
  - each modifier sets `--grp`, and the heading rule is bold 1.15rem with a 4px bar;
  - AA contrast;
  - the wrappers, labels and order in `index.html`;
  - the forecast's purple and grey groups and the muted line (only when the count is > 0, never listing the patients);
  - the link opens and scrolls;
  - the cross-check and its two pinned exceptions;
  - xlsx: heading, header and total fills per section in both exports, merges, widths ≥ the longest value, compact rows, no wrap, merged lines that fit, neutral sections unchanged, an unknown colour refused;
  - the «איזון» / «E-ZONE» scan;
  - SW v25.
- **New: `test/billing-tab-section-colors-browser.test.js`, 1 test.** It runs in real Chromium at 360px and 1280px and reads computed styles:
  - weight 700, larger than the row text, the group colour, a 4px right bar with no left bar, a tinted panel, the chip colour;
  - the labels;
  - the link opens and loads «חובות פתוחים»;
  - no sideways scroll.

  It is skipped in CI, like the other browser tests. `SHOT_DIR=… node --test …` writes the screenshots.
- **Updated (label, sheet-count and layout pins only):**
  - `test/refund-payout-forecast.test.js` (four sheets; the count line instead of a missing sheet or section; the button label);
  - `test/xlsx-export.test.js` (four sheets; the count line; widths computed instead of taken from the spec; the label-parity pin uses `MISSING_LINE`; the button label);
  - `test/debt-aging-ui.test.js` (the SW pin is "v24 or later"; one comment).
- **Full suite: `npm test` → 1868 / 1868** (base 1850).
