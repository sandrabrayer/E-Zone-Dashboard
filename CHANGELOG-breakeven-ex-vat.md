# Break-even tab: ex-VAT revenue + gross-margin row

The נקודת איזון (break-even) tab now reasons about revenue **net of VAT** and
shows a gross-margin percentage per house.

## Why

Patient payments (`pay`, תשלום חודשי) and the hard-coded `PRICE_FALLBACKS` are
stored **VAT-inclusive** — the gross amount billed. Expenses in the tab are
net figures, so comparing gross revenue against net expenses overstated
profitability. The break-even analysis should be on a like-for-like ex-VAT
basis.

## What changed (`public/app.js`)

- Added `const VAT_RATE = 1.18;` next to `BREAKEVEN_DEFAULTS`, with a comment
  noting that `pay` and `PRICE_FALLBACKS` are VAT-inclusive.
- In `computeHouseMetrics`, `price` and `currentRevenue` are divided by
  `VAT_RATE` **before** any derived math. Everything downstream —
  `currentPL`, `maxRevenue`, `maxPL`, `breakevenPoint`, `marginalProfit` —
  follows automatically from the ex-VAT basis. `PRICE_FALLBACKS` are divided at
  point of use (via `avgPricePerHouse`), not by editing the constants.
- Added `marginPct = currentRevenue > 0 ? (currentPL / currentRevenue) * 100 : null`
  to the returned metrics (null when there is no revenue to divide by).
- House card render (`renderBreakevenHousesGrid`): new **רווח גולמי** row —
  one decimal, red (`negative`) style when negative, `—` when `marginPct` is
  null. The "מחיר ממוצע למטופל" figure is labelled **(ללא מע"מ)** so the
  changed basis is explicit.
- The comparison table's average-price cell is now `Math.round`-ed (price is
  fractional after the VAT division); all P&L / revenue cells were already
  rounded at display.

`actualRevenuePerHouse` is unchanged — it still returns the raw VAT-inclusive
sum; only `computeHouseMetrics` and the network roll-ups divide.

## Tests

- New `test/breakeven-ex-vat.test.js` (vm-sandbox, `node:test`): VAT division of
  price/revenue, `marginPct` math, zero-revenue → null margin, negative margin.
- Updated `test/breakeven-revenue.test.js`: the three assertions that hard-coded
  VAT-inclusive `currentRevenue`/`currentPL`/`housesPL` now expect the ex-VAT
  values (with a small tolerance helper for cross-order float arithmetic).

Full suite: `npm test` → 105 passing.
