# Dashboard: occupancy for open houses only, % per house, no committees card (2026-10-25)

## What changed (public/ only — no Code.gs change, no Apps Script deploy)
- `HOUSES` gets a `closed` flag; **שדה אליעזר** is `closed: true`. The dashboard (`renderDashboard`) counts
  capacity, occupied beds and the occupancy % over OPEN houses only, and shows no card for a closed house.
  Other screens (occupancy tab, break-even, etc.) are unchanged.
- Each house card now shows its own occupancy %: `N / capacity מאוכלסים · P% תפוסה`.
- «ועדות קרובות» card removed from «דשבורד» (markup, painter/loader, controller-view move).
  `lib/committee-alerts.js`, its route and the backend `upcomingCommittees` action stay (unused, inert).
- SW cache v87 → v88 (monotonic from the live v87).

## Tests
`test/dashboard-open-houses-occupancy.test.js` (new); `test/dashboard-committees.test.js` and
`test/ortal-billing-ui.test.js` updated for the removed card.

## Security
No new routes, inputs or secrets; house names are static constants.
