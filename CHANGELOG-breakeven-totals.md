# Break-even tab — totals rows + filled-order arrow flip

Two display-only changes on the נקודת איזון tab (`public/app.js`), no computation logic altered.

## Change 1 — totals rows in השוואת נקודות איזון

Added a `<tfoot>` to the comparison table with two summary rows after the per-house rows:

- **סהכ רווח/הפסד בתים** — the houses-only P-L, i.e. the sum of each active house's
  `currentPL`. Uses the same green/red (`positive`/`negative`) sign coloring as the
  per-house רווח/הפסד cell.
- **עלות מטה** — the network HQ cost (`state.breakeven.hqCost`), shown as the amount.

`computeNetworkMetrics` now exposes `housesPL = totalRevenueCurrent - totalHouseExpenses`.
This **excludes** `hqCost`, unlike the existing `networkPL` which subtracts it. Identity:
`housesPL === networkPL + hqCost`. No existing values were changed.

## Change 2 — arrow flip in תוכנית פעולה למילוי

The מ → ל column previously rendered `from → to` (e.g. `13 → 9`). It now renders
`to ← from` (e.g. `9 ← 13`) — same numbers, target first then a right-to-left arrow,
matching the RTL reading direction. Pure markup; no logic change.

## Tests

Extended `test/breakeven-revenue.test.js` with a case asserting `computeNetworkMetrics.housesPL`
equals the sum of per-house `currentPL` and that it excludes `hqCost`
(`housesPL === networkPL + hqCost`, and `housesPL !== networkPL`). The arrow change is pure
markup and needs no test.

## Scope

- No `Code.gs` / Apps Script change → no deploy required.
