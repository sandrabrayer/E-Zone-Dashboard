/* The refund rule for the CURRENT cycle (the one that holds the exit) — which
 * rule applies, GIVEN the rule version. CHANGELOG-refunds-auto-policy.md,
 * CHANGELOG-refund-rule-v2.md, docs/billing-control-plan.md §8.6.
 *
 * The version is decided by the patient's ENTRY date against
 * REFUND_POLICY_CUTOVER, which lives ONLY in apps-script/Code.gs (the server
 * computes every refund and sends `ruleVersion` with it). This file holds no
 * copy of that date — test/refunds-auto-policy.test.js fails on any other
 * literal. The page loads it at /refund-rules.js (window.RefundRules) for the
 * credits modal's labels; test/refund-rule-v2.test.js runs it against Code.gs
 * refundCurrentCycleRule_ over a grid of inputs. No data, no I/O, no clock.
 *
 * Rule v2 / NEW (entry on/after the cutover, every house): stayDay = exit −
 *   entry + 1 (entry day = day 1). stayDay ≥ 14 → no refund for the current
 *   cycle; stayDay 1–13 → pro-rata of the current cycle (the days not stayed).
 * Rule v1 / OLD (entry before the cutover, kept as it was):
 *   residential (asher, ramot) — exit inside the cycle's last 7 days → 0;
 *   detox_dual (rehab, pardes, arfoni, sde) — exit on stay day 14 or later,
 *   counted from the ENTRY (entry day = day 1) → 0.
 * Unchanged in both: a prepaid cycle that starts after the exit is refunded in
 * full, and a cycle that ended before the exit refunds nothing — those are
 * decided by computeRefund_ before this rule is asked. */
(function (root) {
'use strict';

/* v2: stay day from which no refund is due (entry day = day 1). */
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

/* The rule for the cycle that holds the exit (cycleStart ≤ exit ≤ cycleEnd).
 * x: { ruleVersion: 1 | 2 (from the server), facilityType: 'residential' |
 *      'detox_dual', entryDate, exitDate, cycleStart, cycleEnd } — bare ISO days.
 * → { ruleVersion, rule, stayDay, lastDaysFrom, lastDaysTo, refundDue }
 *   rule ∈ stay_prorata | stay_day14_zero                          (v2)
 *        | residential_prorata | residential_last_days_zero
 *        | detox_prorata | detox_tenure_cutoff_zero                 (v1) */
function currentCycleRule(x) {
  const o = x || {};
  const version = Number(o.ruleVersion);
  if (version !== 1 && version !== 2) throw new Error('refund-rules: bad ruleVersion');
  if (!ISO_RE.test(String(o.exitDate)) || !ISO_RE.test(String(o.entryDate))) throw new Error('refund-rules: bad date');
  const entryN = dayNum(o.entryDate), exitN = dayNum(o.exitDate);
  const endN = dayNum(o.cycleEnd);
  const stayDay = exitN - entryN + 1;
  let rule, lastDaysFrom = '', lastDaysTo = '';
  if (version === 2) {
    rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero' : 'stay_prorata';
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
    ruleVersion: version, rule: rule, stayDay: stayDay,
    lastDaysFrom: lastDaysFrom, lastDaysTo: lastDaysTo,
    refundDue: rule === 'stay_prorata' || rule === 'residential_prorata' || rule === 'detox_prorata',
  };
}

const API = {
  REFUND_V2_NO_REFUND_FROM_DAY,
  /* The v1 constants under display names (app.js keeps no copy of the
   * calculation constants — test/credits-ledger.test.js guards that). */
  REFUND_V1_RESIDENTIAL_LAST_DAYS: CREDIT_RESIDENTIAL_LAST_DAYS,
  REFUND_V1_DETOX_CUTOFF_DAY: CREDIT_DETOX_TENURE_CUTOFF_DAYS,
  currentCycleRule,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.RefundRules = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
