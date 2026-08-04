# Meeting Outcome — UI

Builds on the foundation PR (#64), which added `meetingOutcome` to `LEAD_COLUMNS`,
`normalizeLead`, and `MEETING_OUTCOME_LABELS`. This PR wires that schema field
into the meetings board: an outcome selector on past rows, an auto-set on
admission, and a per-manager conversion summary.

**Frontend-only.** `Code.gs` already carries the `meetingOutcome` column — no
Apps Script changes, no deployment steps beyond Railway's auto-deploy on merge.

## What changed — `public/app.js`

### A. Outcome selector on board rows
- Meeting rows whose date is **today or earlier** render an outcome `<select>`
  (`meetingOutcomeSelectHTML`): an empty `— תוצאה —` option, then two optgroups —
  **התקיימה** (`not_relevant` / `thinking` / `entered`) and **לא התקיימה**
  (`postponed` / `cancelled`). Option values are the stable keys; labels come
  from `MEETING_OUTCOME_LABELS`.
- **Future-dated meetings get no selector.** Eligibility is a pure predicate,
  `meetingOutcomeEligible(dateISO, todayISO)`, comparing bare `YYYY-MM-DD`
  strings — **local date parts, never UTC** (mirrors `meetingsForWeek`'s own
  bucket-range check and `todayISO()`'s local construction).
- The selector renders in **edit mode only** (viewers never write).
- On change it persists through the **same** per-row path the lead-card inline
  fields use — `updateLead → saveAll`, optimistic with rollback. On success the
  board re-renders via `renderMeetings()` only (updates the summary + row state);
  it deliberately does **not** call `renderAll()`, so the `meetingWith` autosave
  busy-flag guard (`_autosaveMeetingWithBusy`, fired only from `renderAll`) is
  never perturbed.

### B. Auto-set on כניסה לבית (admission)
- New pure helper `admissionMeetingOutcome(lead)`: returns `'entered'` when the
  lead had a meeting (`visitDate` set), else `null`.
- Wired into both admission paths:
  - `openEntryModal` (the manual "כניסה לבית" action) — sets `meetingOutcome =
    'entered'` as part of the same save, overwriting any prior value (incl.
    `'thinking'`), with matching rollback on save failure.
  - `promoteEnteredLeads` (auto-promotion on load) — stamps the same outcome on
    promoted leads, persisted by the existing post-promote `saveAll`.
- A lead with **no** `visitDate` gets **no** outcome — a lead without a meeting
  must never pollute a manager's conversion stats.

### C. Per-manager conversion summary
- New pure function `computeManagerConversion(leads)` over **all** leads
  (all-time — the real conversion metric, not just the displayed week). Per
  manager:
  - `total` = leads with any valid `meetingOutcome`
  - `held` = outcomes in `{not_relevant, thinking, entered}` (**התקיימו**)
  - `converted` = `entered` (**נכנסו**)
  - `rate` = `round(converted / held * 100)`, **0 when `held` is 0** (no
    division by zero)
- Only managers with at least one outcome appear; rows sort by `held` desc then
  name. Leads that have an outcome but a blank `meetingWith` are grouped under a
  stable placeholder (`ללא מנהל`, `MANAGER_CONVERSION_UNASSIGNED`) so they are
  counted and shown, never silently dropped.
- Rendered as a compact strip above the board (`meetingsSummaryHTML`), one row
  per manager: `[manager] · פגישות: [total] · התקיימו: [held] · נכנסו: [converted]
  · [rate]%`. Styling reuses the board's surface/border tokens; RTL-safe.
- The function is pure and directly testable — the Managers app will consume the
  same data later.

## Styling — `public/style.css`
Added `.mtg-outcome` (compact neutral select in the actions cell) and the
`.mtg-summary` / `.mtg-sum-*` strip (surface card, tabular numerals, a
`--primary` rate pill). Consistent with the existing meetings-board look.

## Tests — `test/meeting-outcome-ui.test.js`
Existing `node:test` + vm-sandbox pattern (not Jest), no changes to `app.js`
needed for testability:
- `computeManagerConversion` — held/converted/total math, zero-held guard
  (0%, finite), multiple managers with sort order, leads without outcomes
  ignored (blank / missing / invalid key), only-managers-with-outcomes,
  no-`meetingWith` grouping under the placeholder, empty/nullish input.
- `meetingOutcomeEligible` — today-or-earlier eligible, future not, local
  bare-date comparison, blank/invalid not eligible.
- `admissionMeetingOutcome` — `'entered'` when `visitDate` present (overwriting
  a prior outcome), `null` when absent.

**Handling of leads without `meetingWith`:** grouped under a single stable
placeholder key (`ללא מנהל`) rather than dropped — they still count toward the
all-time metric, and a later cleanup that assigns a manager simply moves them.

Full suite: `npm test` — **292 passed, 0 failed** (280 prior + 12 new), zero
regressions.

## Deploy
- Frontend-only; `Code.gs` already has the `meetingOutcome` column. Railway
  auto-deploys on merge — no Apps Script steps.
- **Post-merge verification:** the board shows outcome selects on past/today
  rows; picking a value persists after a reload; the summary strip shows
  per-manager numbers; admitting a lead that has a set meeting flips its outcome
  to **נכנסים לטיפול** (`entered`).
