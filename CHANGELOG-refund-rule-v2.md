# Refund rule v2 — one rule for every house (Sandra, 07/10/2026)

**What changed:** the refund rule for the cycle that holds the exit is now the
same in every house, and it is decided by the **stay day**:

- `stayDay = exit − entry + 1`. The entry day is day 1, and the count runs
  across month and cycle boundaries.
- **`stayDay ≥ 14`** → **no refund** for the current cycle
  (`stay_day14_zero`).
- **`stayDay` 1–13** → a pro-rata refund of the current cycle, as computed
  before (`stay_prorata`): paid ÷ 30 × the days not stayed, capped at the
  amount paid.

> **Correction (Sandra, 07/10/2026):** the first version of this PR counted
> day 14 of the **billing month** (from the start of the current cycle). The
> rule is day 14 of the **stay**. The billing-month field
> (`billingMonthDay`) and the `billing_month_*` rule names are gone. They
> never shipped.

- **Unchanged:** a fully prepaid cycle that starts after the exit is refunded
  in full (`prepaid_return`). A cycle that ended before the exit refunds 0.
  Payout timing stays the same: a decision on the 1st–10th is paid on the 15th
  of that month, otherwise on the 15th of the next month. Exceptions and
  write-offs remain Sandra-only. There is still no override parameter.

## Effective date: by the EXIT date

`REFUND_RULE_V2_FROM = '2026-10-07'` is compared with the **exit** date,
inclusive:

| Exit | Rule |
|---|---|
| before 07/10/2026 | **v1**, the old per-house rule, kept as it was: the cycle's last 7 days for אשר / רמות, stay day 14 counted from the entry for the others. |
| on 07/10/2026 or later | **v2**, the unified stay-day rule. |

The old code path stays in place, and the rule is selected by the exit date.
Saved credits are never recomputed: their stored `basis`, amount and payout
date stay as decided.

### What the change means in practice

- **Balance houses (אשר, רמות).** Before, the cutoff was the last 7 days of
  the cycle (about day 24 of each cycle). Now it is stay day 14, so any exit
  from day 14 of the stay onward gives 0 for the current cycle, including
  every exit in the second cycle or later. Example: entry 24/09. An exit on
  06/10 (stay day 13, v1) gets 17 days back. An exit on 07/10 (stay day 14,
  v2) gets 0.
- **Rehab / dual diagnosis (ריהאב, פרדס, עפרוני, שדה אליעזר).** The cutoff
  is the same as v1 (stay day 14, entry day = day 1). Only the rule name
  changes, to `stay_*`.
- **Every house:** a prepaid cycle that starts after the exit is still
  returned in full. Example: entry 08/10, exit 20/10 (stay day 13), with the
  next month prepaid. The current cycle refunds 18 days, and the prepaid
  month comes back in full.

## The shared rule: `lib/refund-rules.js` ⇄ `Code.gs`

- **`lib/refund-rules.js`** (new, a UMD module like
  `lib/billing-control-rules.js`): `REFUND_RULE_V2_FROM`,
  `REFUND_V2_NO_REFUND_FROM_DAY = 14`, `refundRuleVersion(exitIso)` and
  `currentCycleRule({ facilityType, entryDate, exitDate, cycleStart, cycleEnd })`.
  It returns `{ ruleVersion, rule, stayDay, lastDaysFrom, lastDaysTo,
  refundDue }`. The page loads it at `/refund-rules.js`
  (`window.RefundRules`). The v1 constants are exported under display names
  (`REFUND_V1_*`) so that `app.js` keeps no copy of the calculation constants.
- **`apps-script/Code.gs`**: the same rule as `refundRuleVersion_` and
  `refundCurrentCycleRule_`. `computeRefund_` calls them for the current
  cycle. The two new constants are `REFUND_RULE_V2_FROM` and
  `REFUND_V2_NO_REFUND_FROM_DAY`.
- **Parity test:** both runtimes run over 2 facility types × 9 entry dates ×
  75 exit offsets (on both sides of 07/10, including the 31 Jan clamp). Any
  difference fails the test. It also checks that `computeRefund_`'s rule
  equals the shared helper's.

## New rule names

| rule | label (screen and .xlsx) |
|---|---|
| `stay_prorata` | יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי |
| `stay_day14_zero` | יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי |

The v1 labels stay, for exits before 07/10. `computeRefund_`'s breakdown gains
`ruleVersion` (1 / 2). Under v2 the deciding figure is the existing
`stayDay`, and `lastDaysFrom` / `lastDaysTo` are blank.

## Call sites changed

- `Code.gs` `computeRefund_`: the current-cycle rule comes from
  `refundCurrentCycleRule_`; the breakdown gains `ruleVersion`.
- `Code.gs` `refundSuggestion_`: `eligible` includes `stay_prorata`.
  This flows to **suggestRefunds** (`refundSuggestionsFor_`) and to the
  **refund forecast** (`refundPayoutForecastFor_`, «ממתין להחלטה»), which are
  both built on `computeRefund_`. The same is true of
  `billingControlRefundExceptions_` (built on the forecast).
- `public/app.js`:
  - `CREDIT_RULE_LABELS` gains the two v2 labels.
  - `creditBreakdownHtml` shows «יום שהייה ביציאה» for every house under v2.
    For v1 it is unchanged: the stay day for detox, the last 7 days for
    residential.
  - New `refundPolicyNote(exit, facility)`, the rule line at the top of the
    «זיכויים» modal. It is picked by the exit date.
- `lib/refund-forecast-xlsx.js` `RULE_LABELS`: the two v2 labels (the drift
  test against `app.js` is kept).
- `server.js`: serves `/refund-rules.js` (ASSETS, hashed).
- `public/index.html`: loads the script before `app.js`.
- `public/style.css`: `.credit-policy`.
- `public/sw.js`: `BUNDLE_PATHS` + `/refund-rules.js`; `CACHE_VERSION` v45 →
  **v46**. v45 was the highest on every remote branch, and v17 stays burned.
- Docs: `docs/billing-control-plan.md` §0, §8 (new §8.6) and §15;
  `EZONE-ECOSYSTEM-STATUS.md`.

## Tests

`test/refund-rule-v2.test.js`, 28 tests:

- the guard on the constant;
- the version picked by exit date;
- stay day 13 vs 14 in all six houses;
- stay day 13 / 14 across month boundaries (entry 25/10 → 06/11 / 07/11;
  entry 30/09 → 12/10 / 13/10; the 31 Jan clamp);
- a second-cycle exit (stay day 43) → 0, never counted from the cycle start;
- recorded coverage (it sets the days not stayed, never the stay day);
- exit 06/10 vs 07/10 for both balance houses and all four rehab houses;
- v1 kept for every house;
- the prepaid full refund (also beside a day-13 pro-rata) and the fully used
  cycle;
- unchanged payout timing;
- no override parameter;
- `refundSuggestionsFor_` and the forecast under v2;
- lib ⇄ Code.gs parity (Node and browser builds);
- labels on screen and in the .xlsx, the breakdown, the modal's rule line;
- the asset wiring;
- **8 mutation checks**:
  - six against Code.gs: cutoff 14→15, the date moved to 08/10, `>=`→`>`,
    the stay day counted from the cycle start (the billing-month reading),
    v2 pro-rata pays 0, the prepaid return dropped;
  - one against `eligible`;
  - one against the lib (cutoff drift and date drift both break parity).

Existing tests:

- `refund-logic-foundation.test.js`: two v1 fixtures whose exits fell on or
  after 07/10 moved one month earlier, so they still test v1 as written. The
  full breakdown fixture gains `ruleVersion`.
- `dashboard-perf-assets.test.js`: the SW pin is now v46, and
  `/refund-rules.js` is added to the hashed files.
- `patients-tab-ui.test.js`: the SW pin becomes "v45 or later".

Full suite: `npm test`, 2465 / 2465 pass (browser tests included).

## Deploy

Code.gs changes, so clasp CI deploys on merge. Railway deploys `public/`,
`lib/` and `server.js`. No new action, Script Property, env var, column or
trigger. No data change.
