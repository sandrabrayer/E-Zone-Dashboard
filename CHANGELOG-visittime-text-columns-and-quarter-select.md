# visitTime: text columns, upsert normalization, one-time repair, quarter-hour select

Follow-up to the earlier visitTime corruption fix, addressing the two remaining
live findings: legacy time cells kept drifting, and the mobile time picker
ignored `step="900"`.

## 1. `apps-script/Code.gs` — text-format the whole visitDate/visitTime columns at sheet-ensure
`getOrCreateSheet_` now, for the **Leads** sheet, forces the **entire**
`visitDate` and `visitTime` columns to the plain-text (`@`) number format
(`forceColumnsText_`, whole column via `getMaxRows()`), **once at ensure time**
rather than per-write. Any write path — present or future (`mergeLeads_`,
`upsertRowById_`, a manual edit) — now lands in a text cell, so Sheets can never
coerce `"08:18"` / `"2026-06-11"` into a Date/time-typed cell (the coercion that
drove the getValues→UTC drift). Idempotent.

## 2. `apps-script/Code.gs` — `upsertRowById_` normalizes + text-formats
`upsertRowById_` (used by restore/move/remove) previously did a bare
`objectToRow_` + `setValues`, re-coercing cells. It now gets the same treatment
`mergeLeads_` has: shared helpers `normalizeLeadRowDates_` (visitDate/entryDate/
created via `asISODate_`, visitTime via `asISOTime_`) and `setLeadDateColsText_`
(force those columns to `@` **before** `setValues`). The insert path writes at the
next row explicitly (not `appendRow`) so the format is applied before the value
lands. Safe on any `columns` list — absent names are skipped.

## 3. `apps-script/Code.gs` — one-time manual repair `repairLeadVisitTimes_`
Runnable **from the Apps Script editor only** — it is **not** wired to any
endpoint (`handle_`/`doGet`/`doPost` never call it). The legacy `visitTime` values
were corrupted beyond recovery by repeated tz round-trips, so it **blanks every
existing `visitTime`** for hand re-entry and **leaves `visitDate` intact**. It
also (re)forces the two columns to text, logs how many rows were blanked, and
returns that count. Idempotent (a second run blanks 0).

## 4. `public/app.js` — quarter-hour `<select>` instead of `<input type="time">`
The mobile native time picker ignores `step`, so `visitTime` is now a `<select>`:
- `QUARTER_HOUR_TIMES` (00:00…23:45) + `visitTimeOptions(value)` — a blank
  placeholder plus every quarter hour. A non-empty, **non-quarter** stored value
  (e.g. a legacy `08:18`) is added as an **extra option, sorted into place**, so
  it still displays and round-trips instead of being silently lost.
- `visitTimeSelectHTML(value)` renders the inline card select, keeping
  `data-field="visitTime"` so it rides the existing single-field save wiring
  unchanged. The edit-modal field switches from `type:'time'` to `type:'select'`
  with `options: visitTimeOptions(...)`.
- `public/style.css`: `.lc-visit-time` matches the date input's box so the row
  stays even.

## Tests — `test/visittime-text-columns-and-quarter-select.test.js`
- The select emits the blank placeholder + exactly the 96 quarter hours for a
  clean value (nothing else), and selects the matching option.
- An off-step value (`08:18`) is added as an extra option, sorted between
  `08:15` and `08:30`, renders selected, and round-trips through the lead card
  and the edit modal.
- `repairLeadVisitTimes_` blanks `visitTime`, leaves `visitDate` untouched, and
  logs/returns the count.
- `upsertRowById_` normalizes date/time cells and text-formats them **before**
  `setValues` (order asserted), and `getOrCreateSheet_` text-formats the whole
  columns.

Two PR-#59 tests that asserted `step="900"` on the old `<input type="time">` were
updated to the new `<select>` contract.

## Deploy note
Parts 1–3 are in `apps-script/Code.gs` (deployed separately). After the Apps
Script redeploy, run `repairLeadVisitTimes_` **once** from the editor to blank the
corrupted times; from then on the text columns keep new writes clean.
