# תפוסה tabs: occupancy % per house, closed house hidden (2026-10-25)

Follow-up to CHANGELOG-dashboard-open-houses-occupancy.md (which changed only the dashboard cards).
- House tabs on «תפוסה» now read `name (N/capacity · P%)`.
- שדה אליעזר (`closed`) has no tab while it holds no patients (a closed house WITH patients stays reachable).
- public/ only — no Code.gs / Apps Script deploy. SW v88 → v89.
- Tests: test/occupancy-tabs-open-houses.test.js (new); SW-version tests bumped.
- Security: static labels only, no new input or routes.
