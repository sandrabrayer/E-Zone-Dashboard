# Fix visitTime corruption (time drifts on every save→load)

Fixes the data-corruption bug where every lead's `visitTime` shifted by the same
amount between page loads (e.g. all rows −2:21, then +14:36), compounding until
the value was meaningless.

## Root cause (diagnosed previously)

The leads write path stored `visitTime` as a **coerced time cell**, not text:
`mergeLeads_` wrote the sheet with **no `setNumberFormat('@')`**, so Google
Sheets turned the `'HH:MM'` string into a time-typed cell. On read, `getValues()`
returned it as a `Date` anchored on 1899-12-30, `JSON.stringify` serialized that
to a **UTC** ISO string, and the client's `isoTime` extracted the time with
**`getUTCHours`**. Each cycle applied the spreadsheet-timezone offset at the 1899
anchor (Jerusalem's pre-1918 LMT, +02:20:54 → the observed ~−2:21), compounding
and wrapping past midnight (the large positive jumps). The patients date column
was already protected this way (`replaceHousePatients_`); the leads sheet never
was.

## The fix (four parts)

### 1. `apps-script/Code.gs` — force the leads date/time columns to text
`mergeLeads_` now canonicalizes **`visitDate`, `visitTime`, `entryDate`,
`created`** for both kept and new rows and applies `setNumberFormat('@')` to
those columns **before** `setValues`, exactly mirroring `replaceHousePatients_`
(extended from one date column to all four). Sheets can no longer coerce
`'08:18'` into a time serial or `'2026-06-11'` into a date serial — the values
stay stable strings end-to-end.

### 2. `apps-script/Code.gs` — `asISOTime_`, the counterpart to `asISODate_`
New `asISOTime_(v)` returns `'HH:MM'`: a `Date` is formatted with
`Utilities.formatDate` in the **spreadsheet timezone** (never UTC — that mismatch
was the drift); a `'HH:MM'` string passes through; anything unrecognized returns
`''`. `getData_` runs it over every lead's `visitTime` on read, so a **legacy
cell** that was coerced before this fix normalizes correctly on the way out.

### 3. `public/app.js` — `isoTime` uses local getters
The `Date`/timestamp fallbacks now use `getHours()/getMinutes()` instead of
`getUTCHours()/getUTCMinutes()`, consistent with the `isoDate` rule. The `'HH:MM'`
fast path is unchanged. With the server normalizing `visitTime` to `'HH:MM'`,
this fallback is rarely hit; when it is, it reads the local wall clock rather
than shifting by the UTC offset.

### 4. `public/app.js` — autosave per-lead failure guard
`autosaveMeetingWithDefaults` rolled `meetingWith` back to `''` on save failure,
leaving the lead permanently "pending" so a failing backend re-fired `saveAll` on
**every** `renderAll` — an infinite write loop that amplified the corruption. A
new session-scoped `_meetingWithAutosaveFailed` set records any lead whose save
failed and skips it on later renders, capping retries at **one attempt per lead
per session**. Leads that have not failed are unaffected.

## Tests — `test/visittime-corruption-fix.test.js`
- `'HH:MM'` round-trips unchanged through both `asISOTime_` (server) and `isoTime`
  (client).
- A `Date`-valued cell is formatted in the **spreadsheet tz, not UTC** (asserts
  the tz passed to `Utilities.formatDate`).
- A simulated save→read→save cycle is **idempotent** — no drift after three
  iterations.
- Autosave **retries at most once per lead per session** under a failing backend
  (no infinite write loop), and a different, non-failed lead is still attempted.

Two existing assertions that encoded the old UTC extraction were updated to the
new local-getter contract (`test/meetings-polish.test.js`,
`test/meetings-whatsapp.test.js`) — the epoch artifact is now normalized
server-side, so the client is tested against the clean `'HH:MM'` it now receives.

## Not included / deploy note
- **Requires the Apps Script redeploy** to take effect — parts 1 and 2 are in
  `Code.gs`, which is deployed separately. Until then the frontend fix (parts 3–4)
  ships via the normal bundle; `asISOTime_` on read repairs legacy coerced cells
  once the script is live.
