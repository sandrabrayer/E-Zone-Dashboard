# Meetings board fixes — RTL week arrows + scheduled visits in their week

October 9, 2026. Two bugs in the «לוח פגישות» tab. **Railway + Code.gs**
(clasp CI deploys on merge). No column, sheet, Script Property, env var or
trigger. SW `CACHE_VERSION` v53 → **v54** (live was v53; no open PR held a
version; v17 stays burned).

## Bug 1 — week arrows reversed for RTL

**Root cause:** `public/app.js:3870` / `:3872` (before this change) labelled
the buttons «← שבוע קודם» / «שבוע הבא →» — the LTR convention. The rest of the
app (lead card, `public/app.js:4931` «שלב קודם →» and `:4866` «← שלב הבא»)
uses the RTL one: back points RIGHT, forward points LEFT.

**Fix:** the labels are now «שבוע קודם →» / «← שבוע הבא», same text-then-arrow
/ arrow-then-text shape and the same source order (back first) as the
lead-card buttons, so bidi renders them identically. Text only — `data-mtg`
attributes and the ±7-day handlers are unchanged.

## Bug 2 — visits scheduled on leads missing from the board

### Investigation (read-only, top to bottom)

- **Data source:** the board has ONE source — `state.leads[].visitDate` /
  `visitTime` / `meetingWith` (`meetingsForWeek`, `public/app.js`). There is no
  separate meetings sheet. The lead card's inline date / time / «נפגש עם»
  fields write those same three fields (`updateLead` → `saveAll` →
  `mergeLeads_`, which stores them as text via `asISODate_` / `asISOTime_`).
- **Filters:** none by stage, house, status or manager. Every lead in
  `state.leads` with a visitDate inside the Sunday–Saturday week is listed.
  The active-managers logic (PR #154) filters only the conversion strip above
  the board, never the rows. There is no Clients-sheet merge in this app —
  `state.leads` is exactly getData's `leads` (the Leads tab); `Clients` belongs
  to ezone-outpatient.
- **Week math:** `weekStartSunday` / `addDaysISO` are local bare-date math;
  the range check is inclusive on both ends (`v < start || v > end`). Correct.
- **Dates — the defect:** the board trusts how the browser reads whatever
  getData sends as `visitDate`, and getData sends it raw.

### Root cause

1. `apps-script/Code.gs:2573` (`getData_`, before this change) normalized
   `visitTime` on the way out (`asISOTime_`) but **not `visitDate`** — unlike
   `meetingReportLeads_` (`Code.gs:7051`), which does. A Leads cell that is not
   clean `'YYYY-MM-DD'` text reaches the client as-is: a date-typed legacy cell
   → a `Date`, serialized as a UTC timestamp (`2026-10-10T21:00:00.000Z` for
   Sunday 11/10 in Israel); a date cell later re-formatted as text → a serial
   (`46306`); a value typed into the sheet by hand → `'11/10/2026'`.
2. `public/app.js:3161` (`meetingsForWeek`) and `public/app.js:2884`
   (`normalizeLead`) read it through `isoDate` (`public/app.js:9924`), which
   takes the **device's** calendar day of a timestamp, `new Date(46306)` →
   1970-01-01, and parses `'11/10/2026'` month-first → 2026-11-10. The range
   check then drops the lead from its week.

The concrete case lands exactly on the boundary: **11/10/2026 is a Sunday**
(week start). Reproduced with the pre-fix code on a device whose timezone is
not Israel time: the date-typed cell read as Saturday 10/10, so «תומר» showed
in 04/10–10/10 and was missing from 11/10–17/10; as a serial or `11/10/2026`
it was in neither. With clean `'2026-10-11'` text the old code was already
correct (verified) — the fix covers every other shape a Sheets cell can take.
This session had no access to the production sheet, so which of these shapes
the live row holds was not inspected; all of them now land on 11/10.

### Fix

- **`public/app.js`** — new pure `leadVisitDateISO(v)` (+ `visitDayInJerusalem`):
  bare `YYYY-MM-DD` unchanged; a `Date` or a timezone-marked timestamp → its
  calendar day in **Asia/Jerusalem** (Intl), whatever the device zone; a Sheets
  serial → that day; `DD/MM/YYYY` / `DD.MM.YYYY` → day-first; a tz-less
  `YYYY-MM-DDT…` → its leading date; impossible dates / blanks → `''`;
  anything else → `isoDate` as before. Used by `normalizeLead` (so the lead
  card's date input shows the same day, and the next save rewrites it as clean
  text) and by `meetingsForWeek`.
- **`apps-script/Code.gs`** — `getData_` now also runs `visitDate` through
  `asISODate_` (sheet timezone) on the way out, like `visitTime`. Read path
  only: nothing is written to the sheet. Clean text cells pass through
  unchanged.

## Tests

`test/meetings-board-fixes.test.js` (9 tests, TZ pinned to **UTC** — the
device-outside-Israel case):
- arrow labels («שבוע קודם →» / «← שבוע הבא»), same shape and source order as
  the lead-card buttons, old labels gone; ±7-day behavior unchanged;
- `leadVisitDateISO` for every Sheets shape of Sunday 11/10, and blanks /
  non-dates;
- «תומר» (רעננה הפרדס, 14:00, חן) in week 11/10–17/10 for each shape (Date
  object, UTC timestamp, serial, DD/MM/YYYY) and NOT in 04/10–10/10;
- week 04/10–10/10: Sunday and Saturday (Date objects) and mid-week visits in,
  03/10 and 11/10 out;
- `renderMeetings` end to end: the row is rendered in its week only;
- `getData_`: serial / Date `visitDate` sent as `YYYY-MM-DD`, clean text
  unchanged, sheet not written.

`test/dashboard-perf-assets.test.js`: SW version pin v53 → v54.

`test/write-path-hardening-money.test.js` (CI flake that blocked this PR):
«a credit edit retried with the pre-save stamp…» failed ~1 run in 8 because
the create and the edit landed in the same millisecond, so both carried the
same `updatedAt` stamp (`upsertCredit_`, `new Date().toISOString()`) and the
retry was not stale — it saved again instead of replaying. The test now lets
the clock pass the create stamp before the edit. Test-only; 30/30 runs green.

Full suite: 2621 / 2621. `npm audit`: 0 high / critical (1 moderate,
pre-existing).

## Deploy

Merge → Railway deploys `public/app.js` + `public/sw.js`; clasp CI deploys
`Code.gs`. Either order is safe: the new client reads both the old raw and the
new normalized `visitDate`.
