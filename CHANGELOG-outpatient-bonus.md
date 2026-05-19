# Changelog — Outpatient-Continuation Bonus (DASHBOARD side, step 3)

Format loosely follows Keep a Changelog. Covers DASHBOARD's additive
pass-through of the OUTPATIENTS 5% figure into the managers feed.

## [Unreleased]

### Changed (money-affecting — preview before deploy)

- **Outpatient-continuation bonus now sourced from the OUTPATIENTS app
  (5% of upfront monthly package), replacing the local flat-rate model.**
  `managersOverview_` and `managersHouse_` now call the new
  `fetchOutpatientContinuity_(ym)` instead of
  `computeContinuityByHouse_(readOutpatients_())`. Policy decision
  (2026-05): our 5% replaces the ₪100/500/1000 flat rate.
- **BEP occupancy gate removed for the outpatient bonus ONLY.** Previously
  `continuityBonus = qualifies ? continuity.total : 0` zeroed the
  outpatient bonus for below-BEP houses. Per policy, the outpatient bonus
  is now paid regardless of occupancy. The stability bonuses
  (base / daily / quarterly) **keep** their `qualifies` gate unchanged —
  only the single continuity line was un-gated.

### Added

- `fetchOutpatientContinuity_(ym)` — pulls the OUTPATIENTS
  `getContinuationBonus` endpoint via `UrlFetchApp`, reading
  `OUTPATIENT_BONUS_URL` / `OUTPATIENT_BONUS_SECRET` from Script
  Properties. Returns the exact shape `calcHouseBonus_` already consumes
  (per-house `{maintenance,day_2x,day_daily,total}`; only `total` carries
  the 5% figure), so the downstream calculator is unchanged.
- Feed health is surfaced as `outpatientFeed` in both managers API
  responses (`_meta`), so a failure is visible, never silent.
- `test/outpatient-bonus-bridge.test.js` (9 tests) + `npm test` script
  (no new dependency; uses Node's built-in runner like the OUTPATIENTS
  repo).

### Safety / fail-safe

- If the feed is not configured, returns non-200, returns `ok:false`,
  returns malformed JSON, or reports a different month than requested,
  `fetchOutpatientContinuity_` returns the ZEROED shape plus an
  `_meta.error`. It never throws (managers dashboard keeps rendering) and
  never silently reuses the old flat-rate numbers (that would be wrong
  money).
- The month-mismatch guard prevents attributing the source's
  current-month figure to a historical/future month view.
- The legacy `computeContinuityByHouse_` and the hand-maintained
  `Outpatients` tab are kept (rollback safety) but are no longer wired
  into any bonus path. Re-wiring both is a double-pay bug — do not.
- `_meta` cannot leak into per-house math: all access is explicit
  `continuityByHouse[key]` for `key ∈ MANAGER_HOUSES`.

### Operator setup (required before this has any effect)

1. OUTPATIENTS Apps Script: set Script Property `BONUS_SECRET`, redeploy
   the Web App (see CHANGELOG-continuation-bonus.md in ezone-outpatient).
2. DASHBOARD Apps Script: set Script Properties `OUTPATIENT_BONUS_URL`
   (the OUTPATIENTS /exec URL) and `OUTPATIENT_BONUS_SECRET` (same value
   as BONUS_SECRET). Redeploy the DASHBOARD Web App.
3. Until both are set, `outpatientFeed._meta.error` will report
   `outpatient_bonus_not_configured` and the outpatient bonus shows ₪0
   (safe: no wrong money, just absent until wired).

### Money impact (representative preview — run live before deploy)

Qualifying houses generally see the outpatient portion DECREASE
(flat-rate was higher than 5% for typical packages); below-BEP houses see
it APPEAR where it was previously gated to zero. Stability bonus
unchanged everywhere. Individual manager payouts move materially in both
directions — sign-off (incl. finance) on a LIVE preview with real data
is required before deploy.

### Not done here (step 4)

- MANAGERS app display: the bonus already arrives via the existing feed
  path; MANAGERS reads DASHBOARD's managers endpoints. Verify the
  "פירוט חישוב הבונוס" line reflects the new figure once the feed is
  configured. Tracked separately.
