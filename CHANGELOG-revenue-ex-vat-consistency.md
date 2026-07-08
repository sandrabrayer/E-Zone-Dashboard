# Revenue ex-VAT, consistent across the dashboard and נקודת איזון tab

Make monthly revenue read **ex-VAT** on both screens so they reconcile. Since
PR #32 the break-even tab already reasons ex-VAT per house
(`computeHouseMetrics.currentRevenue = actualRevenuePerHouse / VAT_RATE`), but
the main dashboard "הכנסות חודשיות" KPI still summed raw `pay` (VAT-inclusive),
so the two screens disagreed. This aligns them.

The growth graph is intentionally **left VAT-inclusive** (by decision) and is
untouched.

## Changes

### Break-even tab — per-house current revenue (`public/app.js`)

`renderBreakevenHousesGrid`: new metric row **"הכנסה נוכחית (ללא מע"מ)"**
directly above **"רווח/הפסד נוכחי"**, showing
`₪ Math.round(m.currentRevenue).toLocaleString('he-IL')` inside a `num-ltr`
span (the ex-VAT figure already computed in `computeHouseMetrics`). Houses with
no revenue render `₪ 0`.

### Dashboard KPI — ex-VAT total (`public/app.js`, `public/index.html`)

- New pure helper `dashboardMonthlyRevenueExVat(patients)`: sum of active
  patients' `pay` (VAT-inclusive) divided by the existing global `VAT_RATE`
  (1.18) constant — **referenced, not redeclared** — then rounded.
- `renderDashboard` now sets the "הכנסות חודשיות" KPI from that helper.
- Sublabel changed from **"סך תשלום חודשי כולל מע"מ"** to
  **"סך תשלום חודשי ללא מע"מ"**.

### Reconciliation

The KPI equals the ex-VAT sum of every house's raw revenue
(`Σ actualRevenuePerHouse(h) / VAT_RATE`), so the dashboard total and the
per-house revenue rows on the break-even tab agree — **rounding aside** (the KPI
rounds the grand total once; each per-house row rounds independently, so the sum
of the displayed rows can differ from the KPI by a few shekels).

## Tests

`test/dashboard-revenue-exvat.test.js` (vm-sandbox, `node:test`) covers the pure
math: VAT division + rounding, released excluded, missing/zero/non-numeric pay,
non-integer rounding, empty input, and a **reconciliation** assertion that the
dashboard KPI equals `round(Σ per-house ex-VAT revenue)`.

Render-only parts are **not** unit-tested (no number-formatting logic in them):
the new per-house row markup, the sublabel text, and the `renderDashboard`
wiring are DOM/string output exercised only in the browser.

Full suite: `npm test` → **139 passing**.
