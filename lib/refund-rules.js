/* The refund rule for the CURRENT cycle (the one that holds the exit) — which
 * rule applies, picked by the EXIT date. CHANGELOG-refund-rule-v2.md,
 * docs/billing-control-plan.md §8.6, decided by Sandra on 2026-10-07.
 *
 * ONE definition, two runtimes, like lib/billing-control-rules.js: the page
 * loads it at /refund-rules.js (window.RefundRules) for the credits modal's
 * labels, and apps-script/Code.gs holds the same rule as refundRuleVersion_ /
 * refundCurrentCycleRule_ (Apps Script cannot require a file). The parity test
 * test/refund-rule-v2.test.js runs both over a grid of inputs and fails on any
 * difference. Code.gs computeRefund_ is still THE calculation; this file only
 * names the rule. No data, no I/O, no clock.
 *
 * Rule v2 (every house, exit on or after REFUND_RULE_V2_FROM):
 *   the patient's own billing month is anchored on the entry date (the cycle
 *   start is day 1). An exit on day 14 or later of that month → no refund for
 *   it; an exit on day 1–13 → pro-rata on the days not stayed.
 * Rule v1 (exit before REFUND_RULE_V2_FROM, kept as it was):
 *   residential (asher, ramot) — exit inside the cycle's last 7 days → 0;
 *   detox_dual (rehab, pardes, arfoni, sde) — exit on stay day 14 or later,
 *   counted from the ENTRY (entry day = day 1) → 0.
 * Unchanged in both: a prepaid cycle that starts after the exit is refunded in
 * full, and a cycle that ended before the exit refunds nothing — those are
 * decided by computeRefund_ before this rule is asked. */
(function (root) {
'use strict';

/* Compared against the EXIT date (inclusive): exit on 2026-10-07 → v2. */
const REFUND_RULE_V2_FROM = '2026-10-07';
/* v2: billing-month day from which no refund is due (cycle start = day 1). */
const REFUND_V2_NO_REFUND_FROM_DAY = 14;
/* v1 constants — the same names and values as Code.gs. */
const CREDIT_RESIDENTIAL_LAST_DAYS = 7;
const CREDIT_DETOX_TENURE_CUTOFF_DAYS = 14;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* 'YYYY-MM-DD' → whole days since 1970-01-01 (UTC epoch days). */
function dayNum(iso) {
  const p = String(iso).split('-');
  return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}
function isoFromDayNum(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/* 2 when the exit is on/after REFUND_RULE_V2_FROM, else 1. A bare ISO day
 * compares as a string. Throws on anything else — never a silent rule. */
function refundRuleVersion(exitIso) {
  const s = String(exitIso == null ? '' : exitIso);
  if (!ISO_RE.test(s)) throw new Error('refund-rules: bad exitDate');
  return s >= REFUND_RULE_V2_FROM ? 2 : 1;
}

/* The rule for the cycle that holds the exit (cycleStart ≤ exit ≤ cycleEnd).
 * x: { facilityType: 'residential' | 'detox_dual', entryDate, exitDate,
 *      cycleStart, cycleEnd } — bare ISO days.
 * → { ruleVersion, rule, billingMonthDay, stayDay, lastDaysFrom, lastDaysTo, refundDue }
 *   rule ∈ billing_month_prorata | billing_month_day14_zero        (v2)
 *        | residential_prorata | residential_last_days_zero
 *        | detox_prorata | detox_tenure_cutoff_zero                 (v1) */
function currentCycleRule(x) {
  const o = x || {};
  const version = refundRuleVersion(o.exitDate);
  const entryN = dayNum(o.entryDate), exitN = dayNum(o.exitDate);
  const startN = dayNum(o.cycleStart), endN = dayNum(o.cycleEnd);
  const billingMonthDay = exitN - startN + 1;
  const stayDay = exitN - entryN + 1;
  let rule, lastDaysFrom = '', lastDaysTo = '';
  if (version === 2) {
    rule = billingMonthDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'billing_month_day14_zero' : 'billing_month_prorata';
  } else if (o.facilityType === 'residential') {
    const fromN = endN - (CREDIT_RESIDENTIAL_LAST_DAYS - 1);
    lastDaysFrom = isoFromDayNum(fromN);
    lastDaysTo = isoFromDayNum(endN);
    rule = exitN >= fromN ? 'residential_last_days_zero' : 'residential_prorata';
  } else if (o.facilityType === 'detox_dual') {
    rule = stayDay >= CREDIT_DETOX_TENURE_CUTOFF_DAYS ? 'detox_tenure_cutoff_zero' : 'detox_prorata';
  } else {
    throw new Error('refund-rules: unknown facilityType');
  }
  return {
    ruleVersion: version, rule: rule, billingMonthDay: billingMonthDay, stayDay: stayDay,
    lastDaysFrom: lastDaysFrom, lastDaysTo: lastDaysTo,
    refundDue: rule === 'billing_month_prorata' || rule === 'residential_prorata' || rule === 'detox_prorata',
  };
}

const API = {
  REFUND_RULE_V2_FROM,
  REFUND_V2_NO_REFUND_FROM_DAY,
  /* The v1 constants under display names (app.js keeps no copy of the
   * calculation constants — test/credits-ledger.test.js guards that). */
  REFUND_V1_RESIDENTIAL_LAST_DAYS: CREDIT_RESIDENTIAL_LAST_DAYS,
  REFUND_V1_DETOX_CUTOFF_DAY: CREDIT_DETOX_TENURE_CUTOFF_DAYS,
  refundRuleVersion,
  currentCycleRule,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.RefundRules = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
