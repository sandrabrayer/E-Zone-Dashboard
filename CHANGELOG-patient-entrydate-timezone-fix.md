# Patient entry date no longer drifts −1 day per save/reload (timezone fix)

Two-part fix. **Part B changes `apps-script/Code.gs` → dual Apps Script redeploy
required after merge** (both deployments, pencil-edit discipline). Part A
(`public/app.js`) ships with the normal static deploy.

## Symptom

After editing a patient's תאריך כניסה and saving, the date persisted but shifted
one day **earlier** on the next reload (e.g. 11.6 → 10.6), and walked further
back on each subsequent reload.

## Root cause

The patient `date` round-tripped through a **Sheets date-typed cell**:

1. **Write side (enabler).** `replaceHousePatients_` wrote the bare `YYYY-MM-DD`
   string with no text-format guard, so Sheets coerced it into a date-typed cell
   valued at **local midnight** in the script timezone (Asia/Jerusalem).
2. **Read side (boundary crossed).** `readSheet_` (`Code.gs:263`) returns that
   cell as a JS `Date`; `jsonOut_` (`Code.gs:230`) serializes it with
   `JSON.stringify` → `Date.toISOString()` → **UTC**. Local midnight
   `2026-06-11 IDT (UTC+3)` becomes `"2026-06-10T21:00:00.000Z"` — the previous
   calendar day.
3. **Client (failed to correct).** `isoDate` matched the leading `YYYY-MM-DD` of
   that UTC timestamp and returned it verbatim (`"2026-06-10"`), propagating the
   −1 shift. Each save→read cycle re-coerced the now-earlier string and lost
   another day.

## Part A — `public/app.js`: timezone-safe `isoDate`

- The bare-date short-circuit regex is **anchored** (`/^\d{4}-\d{2}-\d{2}$/`).
  Previously it was unanchored, so it also matched the *start* of a full
  timestamp and sliced the UTC day — that was the propagation bug. Now only a
  pure `YYYY-MM-DD` returns as-is; anything else falls through.
- Full timestamps / `Date` objects now derive the day from **local parts**
  (`getFullYear()`, `getMonth()+1`, `getDate()`, zero-padded) instead of
  `toISOString().slice(0, 10)`. Both UTC fallbacks are removed. Invalid input
  preserves prior behavior (`''` / original string / `String(v)`).
- Effect: already-drifted date-typed cells render back on their correct local
  day, so existing affected rows (e.g. פרק מוסקוביץ, שחר תמיר) **self-correct on
  display** without manual sheet edits.

## Part B — `apps-script/Code.gs`: store the date column as text

In `replaceHousePatients_`:

- Every row's `date` cell (both kept rows whose cell may already be a coerced
  `Date`, and new rows from the client) is canonicalized to a clean
  `YYYY-MM-DD` string via `asISODate_` — the same helper leads' `created` column
  uses in `mergeLeads_`.
- The **date column only** (`PATIENT_COLUMNS.indexOf('date') + 1`, single column)
  is set to plain-text format with `setNumberFormat('@')` **before** `setValues`,
  so Sheets never re-coerces the string into a date-typed cell. The value stays a
  stable string end-to-end — no `getValues` → `Date` → UTC trip, no drift,
  regardless of timezone or DST.
- `PATIENT_COLUMNS` order and every other column's behavior are unchanged; the
  text format is scoped to the date column, never the whole sheet.

## Not changed

- The frontend write/read field plumbing (`serializePatients`,
  `normalizePatient`, the edit modal) — `date` was always carried as a string
  there; the drift lived in the Sheets coercion + UTC serialization + UTC slice.

## Tests

`test/isodate-timezone.test.js` (node:test + vm sandbox, TZ pinned to
Asia/Jerusalem for deterministic local-part assertions):

- Bare `YYYY-MM-DD` strings pass through unchanged.
- A UTC timestamp (summer IDT and winter IST cases) localizes to the correct day
  instead of slicing the UTC day.
- A `Date` object renders from local parts.
- Empty / invalid inputs preserve prior behavior.

`npm test` → all green.

## Post-merge deployment + verification

1. Redeploy **both** Apps Script deployments (pencil-edit → new version) so
   Part B is live.
2. Confirm `getData` returns plain `YYYY-MM-DD` strings for patient `date`.
3. On פרק מוסקוביץ: edit the entry date → save → hard-reload twice; the date
   must hold steady (no −1 walk).
