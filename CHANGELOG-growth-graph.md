# Growth graph (גרף צמיחה) — network-wide growth over time

Adds a new top-level tab **גרף צמיחה** with two stacked, network-wide (all
houses combined) time-series:

- **Graph 1 — active patient count, WEEKLY (Sunday-start) buckets.** For each
  week, the number of patients active that week (net occupancy curve).
- **Graph 2 — revenue run-rate, MONTHLY buckets.** For each month, the sum of
  monthly `pay` across all patients active that month — reusing the דשבורד
  "הכנסות חודשיות" card's `sum (pay || 0)` over active patients.

Frontend-only. All inputs already arrive via `getData` in `state.patients`
(`date`, `exitDate`, `pay`, `status`, `houseId`). **No `Code.gs` change, no
Apps Script deploy.**

## Locked design decisions

- New tab **גרף צמיחה**, network-wide.
- **Week start: Sunday** (Israeli week).
- Two **separate stacked SVG graphs**, each with its own Y-scale and Hebrew RTL
  label. **Inline hand-rolled SVG** (polyline / circle / text) — no charting
  library, no CDN, consistent with the vanilla-JS no-build frontend.
- **X-axis range:** from the earliest patient entry date to today (weekly for
  Graph 1, monthly for Graph 2).

## Date handling (the timezone rule — MANDATORY)

A patient's `date` is already `isoDate`-normalized to a bare `YYYY-MM-DD`, but
`exitDate` is **raw** from `getData` and may be a **full ISO timestamp**
(e.g. `"2026-06-22T21:00:00.000Z"`). Both are normalized through **`isoDate()`
first** (local-day correct, idempotent on bare dates), and **all** week/month
math runs on the resulting bare `YYYY-MM-DD` via `parseLocalISO` / local `Date`
arithmetic. This avoids the `exitDate` raw-timestamp UTC off-by-one: a `…T21:00Z`
timestamp is the **next** local calendar day in Israel in summer (IDT, UTC+3),
and `…T22:00Z`+ in winter (IST, UTC+2). All comparisons are on bare
`YYYY-MM-DD` strings, which sort lexicographically == chronologically.

## Bucketing rules

- **Graph 1 — weekly active count (Sunday-start).** Week `W` spans `[S, E]` with
  `S` = the Sunday on/before, `E = S + 6` days. A patient is active in `W` iff
  `entry <= E` **AND** (`exit === ''` **OR** `exit >= S`). Inclusive at both
  boundaries: a patient present for any part of the week is counted; a
  still-active patient (`exit === ''`) is counted in every week from entry
  onward. Weeks run from the earliest entry's week through the week containing
  today.
- **Graph 2 — monthly revenue.** Month `M` spans `[F, L]` (first/last calendar
  day). Revenue(`M`) = sum of `(pay || 0)` over patients with `entry <= L`
  **AND** (`exit === ''` **OR** `exit >= F`). Months run from the earliest
  entry's month through the current month.

## Current-month reconciliation note

The monthly graph uses the time-based "active that month" rule for **all**
months, **including the current one**. It therefore counts anyone active for any
part of the month — so **the current-month revenue point may EXCEED the live
דשבורד "הכנסות חודשיות" card** when there were mid-month releases (the card is a
live snapshot of `status !== 'released'`, i.e. only patients still active right
now). This is intentional: it keeps every month bucket consistent with the same
membership rule. In a month with no mid-month releases the two agree exactly.

## Files changed

- `public/index.html` — `גרף צמיחה` tab button + `#screen-growth` section with a
  `#growth-graphs` host.
- `public/app.js`
  - `'growth'` appended to `SCREENS`; `renderGrowthGraph()` added to `renderAll()`.
  - Pure helpers (unit-tested): `growthRecord`, `addDaysISO`, `weekStartSunday`,
    `monthKey` / `firstDayOfMonth` / `lastDayOfMonth` / `nextMonthKey`,
    `earliestEntryISO`, `weeklyActiveCounts`, `monthlyRevenue`.
  - `growthLineChartSVG` (inline SVG builder; every dynamic label is
    `escapeHtml`'d) + `renderGrowthGraph` (two stacked charts).
- `public/style.css` — `.growth-*` styles (RTL container, LTR plotted SVG,
  axis/gridline colors).
- `test/growth-graph.test.js` — vm-sandbox suite (15 tests).
- `CHANGELOG-growth-graph.md` — this file.

## Tests

`npm test` → **81/81 pass** (15 new). Covers: both date formats (bare
`YYYY-MM-DD` and full ISO timestamp) with an explicit no-off-by-one assertion on
`"2026-06-22T21:00:00.000Z"` → local `2026-06-23`; weekly bucketing (still-active
patient counted every week from entry; enter+exit within range counted only in
active weeks with leading/trailing zero weeks; Sunday week-start and Saturday
week-end boundary inclusivity); monthly summation for a known multi-patient
month; monthly first-of-month boundary; a raw-timestamp exit crossing a month
end via the local day; current-month equals the dashboard card sum when there
are no mid-month releases; empty / no-entry-date edge cases; short-month
`lastDayOfMonth`. TZ pinned to `Asia/Jerusalem` (matching the existing
`isodate-timezone.test.js`) so the local-day assertions are deterministic.

## Deploy

Frontend-only — `public/` + a test. Railway redeploys on merge. **No
`apps-script/Code.gs` change → no Apps Script deploy, the dual-deploy IDs do NOT
apply to this PR.**

## Commits

- _(pending)_ feat(growth): network-wide growth graph tab (weekly count + monthly revenue)
