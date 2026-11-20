# CRM — «בית לא מזוהה» fixed inside the CRM

Sandra, 20/11/2026: patients whose house does not resolve («בית לא מזוהה») were fixed
only in the classic page. The fix now lives in the CRM occupancy tab. Migrating every
classic-only operation so `/?view=classic` can be dropped.

## What is new

- `occupancy()` now carries the unknown-house patients (`unknownStays`), not just a count.
- The occupancy «בית לא מזוהה» card no longer links to the classic page. It opens a
  native, collapsible list of those patients; each is a button that opens the patient
  card. The list's open state survives the re-render while fixing them.
- The fix itself is the **existing** native «העברה לבית אחר» move form on the patient
  card — it already offers every open house to an unknown-house patient, and the move
  intent (`movedFrom`) names the unknown origin so the backend accepts the move.

## Not changed

The move form, its confirm, and the backend `saveAll` move path are untouched — this
only routes the unknown-house patients to it natively instead of to the classic page.

## Security

No new write path, no new action, no new endpoint; a read-only model field plus a UI
list. `npm audit`: 0 high / critical.

## Tests

- `test/crm-shell-ui.test.js`: `occupancy().unknownStays`; the occupancy render opens a
  native list, no `view=classic`.
- `test/crm-shell-browser.test.js`: one scenario — the occupancy card opens the
  unknown-house patient, the move form assigns a house, the saveAll carries the move
  intent, no classic link.

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v150 → v151),
`test/crm-shell-ui.test.js`, `test/crm-shell-browser.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
