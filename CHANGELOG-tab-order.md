# Tab order follows the business flow

October 11, 2026. **Railway only** (`public/`). Code.gs not touched. No column,
sheet, Script Property or env var. SW `CACHE_VERSION` v58 → **v59** (live was
v58, no open PR; v17 stays burned).

## Why

The flow is: a lead gets a meeting; only after they decide to enter and pay
does Vered admit them as a patient. The top tabs now read in that order.

## What changed

| | Before (RTL reading order) | After |
| --- | --- | --- |
| 1 | דשבורד | דשבורד |
| 2 | לידים | לידים |
| 3 | מטופלים | **לוח פגישות** |
| 4 | לוח פגישות | **מטופלים** |
| 5… | תפוסה, מטופלים משוחררים, גבייה, בקרת גבייה, הכנסות חודשיות, שיוך תשלומים, נקודת איזון, גרף צמיחה, שימור לידים | unchanged |

- `public/index.html` — the «לוח פגישות» button moved before «מטופלים».
- `public/app.js` — `SCREENS` mirrors the nav (it drives the mobile swipe
  order and deep-link validation), so `meetings` now precedes `patients`.
- Unchanged: every badge (`leads-unadmitted-badge`, `meetings-unseen-badge`,
  `patients-problems-badge`, `bc-badge`), the default tab (דשבורד, the only
  `active` one), the restricted-view / controller-view tab removal, and the
  first-allowed-tab fallback.

## Tests

- New `test/tab-order.test.js` pins the order, the unchanged tail, the
  `SCREENS` mirror, the badges, the default tab and the finance markers.
- `test/meetings-tab-shell.test.js`, `test/restricted-view.test.js`,
  `test/restricted-view-browser.test.js`, `test/patients-tab-ui.test.js`,
  `test/patients-tab-ui-browser.test.js` — expected order updated
  (מטופלים now follows לוח פגישות).
- `test/dashboard-perf-assets.test.js` — pins v59.
- `test/refund-logic-wiring.test.js` — pre-existing clock bug fixed: the credits
  modal's decision date is the real "today", so the expected «ישולם ב־» date is
  now derived from it (the hard-coded 15/10/2026 failed once today passed
  10/10/2026, on the base branch too).
