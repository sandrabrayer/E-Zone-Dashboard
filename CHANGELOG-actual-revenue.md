# Actual revenue for break-even (per house + network rollup)

## What changed

Break-even **revenue** now uses the real summed `pay` (תשלום חודשי) of each
active patient instead of an estimate of `patient count × averaged price`.

### `public/app.js`

- **New helper `actualRevenuePerHouse(houseId)`** — sums `pay` across the
  house's active patients. Mirrors `activeCountPerHouse`'s filter exactly:
  released patients are excluded; active patients with `pay === 0` still count
  and contribute `0` to the sum.

  ```js
  function actualRevenuePerHouse(houseId) {
    return state.patients
      .filter(p => p.houseId === houseId && p.status !== 'released')
      .reduce((s, p) => s + (Number(p.pay) || 0), 0);
  }
  ```

- **`computeHouseMetrics`** — `currentRevenue` now comes from
  `actualRevenuePerHouse(house.id)` instead of `currentPatients * price`.
  `currentPL` therefore reflects real revenue minus expenses.

## What did NOT change

- **`computeNetworkMetrics` is untouched.** Its `totalRevenueCurrent` already
  reduces over each house's `currentRevenue`, so the actual-revenue fix
  propagates to the network total and `networkPL` automatically.
- **`breakevenPoint` (per house) and `networkBreakeven` are unchanged.**
  "Patients needed to break even" legitimately needs a representative price, so
  they still divide expenses by the averaged price (`avgPricePerHouse` /
  weighted `avgPrice`). `avgPricePerHouse` is unchanged.
- **`maxRevenue` (potential at full capacity) is unchanged** — it is a
  capacity projection, not actual revenue.
- No `apps-script/Code.gs` change → no Apps Script redeploy needed.

## Tests

`test/breakeven-revenue.test.js` (Node built-in runner, `npm test` →
`node --test`, no new dependencies). Loads `public/app.js` in a `vm` sandbox
with browser globals stubbed (the file is a browser global script with no
exports). Covers:

- mixed pay values are **summed, not averaged**;
- **released patients excluded** from the sum;
- active patient with `pay 0` counts and contributes 0;
- **empty house = 0** (and no patients at all = 0);
- `computeHouseMetrics.currentRevenue` / `currentPL` use the actual sum;
- `computeNetworkMetrics` rolls up the actual per-house revenue.
