# Hide released patients from the תפוסה (occupancy) tab

## Problem

Discharged patients (`status === 'released'`) were still appearing in the
תפוסה (occupancy) patient list. They rendered with a "שוחרר · DATE" status
pill but remained in the active list, when they should only appear in the
מטופלים משוחררים (discharged patients) tab.

## Root cause

`renderPatients()` (`public/app.js`) built its `rows` list by filtering on
house and search query only — it never filtered out released patients. The
`isReleased` (`p.status === 'released'`) check inside the function was wired
only to cosmetics (badge class, the `· DATE` pill suffix, and hiding the
"שחרר" button), not to excluding rows from the list.

The data layer was already correct: `dischargePatient` sets
`p.status = 'released'` and persists it via `saveAll`, and `normalizeStatus`
round-trips the value cleanly. Every other consumer
(`renderDashboard`, `renderHouseTabs`, occupancy/billing helpers) already
excluded released patients with `p.status !== 'released'`.

## Fix

Added `.filter(p => p.status !== 'released')` to the `rows` filter chain in
`renderPatients()`, matching the pattern already used in `renderDashboard`
(`state.patients.filter(p => p.status !== 'released')`).

Frontend only — no `Code.gs` / Apps Script change required.
