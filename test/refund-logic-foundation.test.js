/* Refund logic foundation — Phase 1 of docs/billing-control-plan.md (§8).
 *
 * computeRefund_ and refundPayoutDate_ in apps-script/Code.gs: PURE
 * functions, not wired to any endpoint, sheet write or getData. The live
 * credits path (suggestCredits in app.js, payoutDateFor_ / upsertCredit_ in
 * Code.gs) is untouched by this change.
 *
 * The three tests marked [plan 8.x] are the "three failing tests" the plan
 * requires first (§8.1, §8.2, §8.4, §14 Phase 1). They were committed alone,
 * before the implementation, so the history shows them red.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention. The sandbox's
 * spreadsheet timezone is UTC on purpose: every Date cell must be read in
 * Asia/Jerusalem, never in the sheet's zone (the managerDateIso_ trap). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

/* Utilities.formatDate's real contract: the date as seen in `tz`. */
function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* Every SpreadsheetApp access is counted: the functions are pure, so a run
 * must leave the counter at 0. */
let ssCalls = 0;
function loadGs() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, Error, isFinite, isNaN,
    Logger: { log: noop },
    Utilities: { formatDate: (d, tz) => formatInTz(d, tz), getUuid: () => 'uuid' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => { ssCalls++; return { getSpreadsheetTimeZone: () => 'UTC' }; } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__t = {
      computeRefund: (x) => computeRefund_(x),
      payoutDate: (d) => refundPayoutDate_(d),
      cutoffDays: () => CREDIT_DETOX_TENURE_CUTOFF_DAYS,
      asISODate: (v) => asISODate_(v),
    };`, sandbox);
  return sandbox.__t;
}
const gs = loadGs();
const refund = (x) => JSON.parse(JSON.stringify(gs.computeRefund(Object.assign({ decidedDate: '2026-10-01' }, x))));

/* ------------------------------------------------------------------------ */
/* The three tests the plan requires first                                  */
/* ------------------------------------------------------------------------ */

test('[plan 8.1] balance houses: "last 7 days" are counted on the patient\'s own cycle, not the calendar month', () => {
  for (const houseId of ['ramot', 'asher']) {
    const base = { houseId, entryDate: '2026-09-10', amountPaid: 30000 };
    // Cycle 10/09–09/10; last 7 days 03/10–09/10.
    const sep28 = refund(Object.assign({ exitDate: '2026-09-28' }, base));
    assert.strictEqual(sep28.refund, 11000, houseId + ' exit 28/09: 11 days not stayed (29/09–09/10)');
    assert.strictEqual(sep28.rule, 'residential_prorata');
    assert.strictEqual(sep28.cycleStart, '2026-09-10');
    assert.strictEqual(sep28.cycleEnd, '2026-10-09');

    const oct03 = refund(Object.assign({ exitDate: '2026-10-03' }, base));
    assert.strictEqual(oct03.refund, 0, houseId + ' exit 03/10 is cycle end − 6');
    assert.strictEqual(oct03.rule, 'residential_last_days_zero');

    const oct02 = refund(Object.assign({ exitDate: '2026-10-02' }, base));
    assert.strictEqual(oct02.refund, 7000, houseId + ' exit 02/10 is cycle end − 7: pro-rata on 03/10–09/10');
    assert.strictEqual(oct02.rule, 'residential_prorata');
  }
});

test('[plan 8.2] rehab / dual-diagnosis: entry day is day 1; exit on day 14 or later → no refund', () => {
  assert.strictEqual(gs.cutoffDays(), 14);
  for (const houseId of ['rehab', 'pardes']) {
    const base = { houseId, entryDate: '2026-09-01', amountPaid: 30000 };
    const day13 = refund(Object.assign({ exitDate: '2026-09-13' }, base));
    assert.strictEqual(day13.stayDay, 13);
    assert.strictEqual(day13.rule, 'detox_prorata');
    assert.strictEqual(day13.refund, 17000, houseId + ' day 13: 17 days not stayed (14/09–30/09)');

    const day14 = refund(Object.assign({ exitDate: '2026-09-14' }, base));
    assert.strictEqual(day14.stayDay, 14);
    assert.strictEqual(day14.rule, 'detox_tenure_cutoff_zero');
    assert.strictEqual(day14.refund, 0, houseId + ' day 14 → 0');

    const day15 = refund(Object.assign({ exitDate: '2026-09-15' }, base));
    assert.strictEqual(day15.rule, 'detox_tenure_cutoff_zero');
    assert.strictEqual(day15.refund, 0);
  }
});

test('[plan 8.4] payout date: decided on or before the 10th → the 15th of that month; after → the 15th of the next', () => {
  assert.strictEqual(gs.payoutDate('2026-10-10'), '2026-10-15');
  assert.strictEqual(gs.payoutDate('2026-10-11'), '2026-11-15');
  assert.strictEqual(gs.payoutDate('2026-10-15'), '2026-11-15');
  assert.strictEqual(gs.payoutDate('2026-12-20'), '2027-01-15');
});

/* ------------------------------------------------------------------------ */
/* Boundaries per house type                                                */
/* ------------------------------------------------------------------------ */

test('balance houses: exit on cycle end and end−6 → 0; end−7 → pro-rata, with the full breakdown', () => {
  // v1 rule (exits before REFUND_RULE_V2_FROM 2026-10-07 — CHANGELOG-refund-rule-v2.md).
  const base = { houseId: 'ramot', entryDate: '2026-08-10', amountPaid: 30000 };
  const onEnd = refund(Object.assign({ exitDate: '2026-09-09' }, base));
  assert.strictEqual(onEnd.rule, 'residential_last_days_zero');
  assert.strictEqual(onEnd.refund, 0);
  assert.strictEqual(onEnd.daysNotStayed, 0);

  const endMinus6 = refund(Object.assign({ exitDate: '2026-09-03' }, base));
  assert.strictEqual(endMinus6.rule, 'residential_last_days_zero');
  assert.strictEqual(endMinus6.refund, 0);
  assert.strictEqual(endMinus6.daysNotStayed, 6, 'the raw days are still recorded');
  assert.strictEqual(endMinus6.uncappedRefund, 6000, 'the raw figure is still recorded');

  const endMinus7 = refund(Object.assign({ exitDate: '2026-09-02' }, base));
  assert.deepStrictEqual(endMinus7, {
    houseId: 'ramot', facilityType: 'residential',
    entryDate: '2026-08-10', exitDate: '2026-09-02', stayDay: 24,
    cycleStart: '2026-08-10', cycleEnd: '2026-09-09', cycleSource: 'entry_anchored', cycleDays: 31,
    daysStayed: 24, daysNotStayed: 7,
    divisor: 30, amountPaid: 30000, dailyRate: 1000,
    uncappedRefund: 7000, capped: false,
    lastDaysFrom: '2026-09-03', lastDaysTo: '2026-09-09',
    rule: 'residential_prorata', creditType: 'days_unused', refund: 7000,
    ruleVersion: 1, billingMonthDay: 24,
    decidedDate: '2026-10-01', payoutDate: '2026-10-15',
  });
});

test('balance houses: the calendar month is irrelevant (exit late in a calendar month, early in the cycle)', () => {
  // Calendar rule would zero 28/09 (last 7 days of September); the cycle rule does not.
  const r = refund({ houseId: 'asher', entryDate: '2026-09-10', exitDate: '2026-09-28', amountPaid: 30000 });
  assert.strictEqual(r.rule, 'residential_prorata');
  assert.strictEqual(r.refund, 11000);
});

test('rehab / dual-diagnosis: day 13 → pro-rata, day 14 → 0, in every detox_dual house', () => {
  for (const houseId of ['rehab', 'pardes', 'arfoni']) {
    const base = { houseId, entryDate: '2026-09-01', amountPaid: 30000 };
    const d13 = refund(Object.assign({ exitDate: '2026-09-13' }, base));
    assert.strictEqual(d13.facilityType, 'detox_dual');
    assert.strictEqual(d13.rule, 'detox_prorata', houseId);
    assert.strictEqual(d13.daysStayed, 13);
    assert.strictEqual(d13.daysNotStayed, 17);
    assert.strictEqual(d13.refund, 17000);
    assert.strictEqual(d13.lastDaysFrom, '', 'no last-days window outside balance houses');

    const d14 = refund(Object.assign({ exitDate: '2026-09-14' }, base));
    assert.strictEqual(d14.rule, 'detox_tenure_cutoff_zero', houseId);
    assert.strictEqual(d14.refund, 0);
  }
});

test('rehab / dual-diagnosis: the stay day counts from ENTRY, not from the cycle start (second cycle → 0)', () => {
  const r = refund({ houseId: 'rehab', entryDate: '2026-08-01', exitDate: '2026-09-05', amountPaid: 30000 });
  assert.strictEqual(r.cycleStart, '2026-09-01');
  assert.strictEqual(r.daysStayed, 5);
  assert.strictEqual(r.stayDay, 36);
  assert.strictEqual(r.rule, 'detox_tenure_cutoff_zero');
  assert.strictEqual(r.refund, 0);
});

/* ------------------------------------------------------------------------ */
/* Prepaid future cycle, fully used cycle (plan 8.3)                         */
/* ------------------------------------------------------------------------ */

test('[plan 8.3] a prepaid cycle not started at the exit is refunded in full, in every house', () => {
  // rehab: exit day 20 → current cycle 0, next cycle full.
  const cur = refund({ houseId: 'rehab', entryDate: '2026-08-01', exitDate: '2026-08-20', amountPaid: 30000, cycleStart: '2026-08-01' });
  assert.strictEqual(cur.rule, 'detox_tenure_cutoff_zero');
  assert.strictEqual(cur.refund, 0);
  const next = refund({ houseId: 'rehab', entryDate: '2026-08-01', exitDate: '2026-08-20', amountPaid: 30000, cycleStart: '2026-09-01' });
  assert.strictEqual(next.rule, 'prepaid_return');
  assert.strictEqual(next.creditType, 'prepaid_return');
  assert.strictEqual(next.cycleEnd, '2026-09-30');
  assert.strictEqual(next.daysStayed, 0);
  assert.strictEqual(next.daysNotStayed, 30);
  assert.strictEqual(next.refund, 30000);

  // ramot: exit 05/09 is inside the last 7 days of 10/08–09/09 → 0; 10/09 cycle → full.
  const rCur = refund({ houseId: 'ramot', entryDate: '2026-08-10', exitDate: '2026-09-05', amountPaid: 30000, cycleStart: '2026-08-10' });
  assert.strictEqual(rCur.rule, 'residential_last_days_zero');
  assert.strictEqual(rCur.refund, 0);
  const rNext = refund({ houseId: 'ramot', entryDate: '2026-08-10', exitDate: '2026-09-05', amountPaid: 30000, cycleStart: '2026-09-10' });
  assert.strictEqual(rNext.rule, 'prepaid_return');
  assert.strictEqual(rNext.refund, 30000);

  // A partly paid future cycle returns what was received, no more.
  const part = refund({ houseId: 'asher', entryDate: '2026-08-10', exitDate: '2026-08-12', amountPaid: 12500.5, cycleStart: '2026-09-10' });
  assert.strictEqual(part.refund, 12500.5);
});

test('a cycle that ended before the exit is fully used → 0 (cycle_fully_used)', () => {
  const r = refund({ houseId: 'asher', entryDate: '2026-08-10', exitDate: '2026-09-20', amountPaid: 30000, cycleStart: '2026-08-10' });
  assert.strictEqual(r.rule, 'cycle_fully_used');
  assert.strictEqual(r.daysStayed, 31);
  assert.strictEqual(r.daysNotStayed, 0);
  assert.strictEqual(r.refund, 0);
});

/* ------------------------------------------------------------------------ */
/* Month clamp, cycle length, rounding, recorded coverage                    */
/* ------------------------------------------------------------------------ */

test('month clamp: entry 31 Jan → cycle 31/01–27/02; last 7 days 21/02–27/02 (plan 8.1)', () => {
  const base = { houseId: 'asher', entryDate: '2026-01-31', amountPaid: 30000 };
  const feb21 = refund(Object.assign({ exitDate: '2026-02-21' }, base));
  assert.strictEqual(feb21.cycleStart, '2026-01-31');
  assert.strictEqual(feb21.cycleEnd, '2026-02-27');
  assert.strictEqual(feb21.cycleDays, 28);
  assert.strictEqual(feb21.lastDaysFrom, '2026-02-21');
  assert.strictEqual(feb21.rule, 'residential_last_days_zero');
  assert.strictEqual(feb21.refund, 0);

  const feb20 = refund(Object.assign({ exitDate: '2026-02-20' }, base));
  assert.strictEqual(feb20.rule, 'residential_prorata');
  assert.strictEqual(feb20.daysNotStayed, 7);
  assert.strictEqual(feb20.refund, 7000);
});

test('month clamp: cycles are stepped from the ENTRY (31 Jan → 28 Feb → 31 Mar), never chained; leap year → 29 Feb', () => {
  const second = refund({ houseId: 'rehab', entryDate: '2026-01-31', exitDate: '2026-03-10', amountPaid: 30000 });
  assert.strictEqual(second.cycleStart, '2026-02-28');
  assert.strictEqual(second.cycleEnd, '2026-03-30');
  const third = refund({ houseId: 'rehab', entryDate: '2026-01-31', exitDate: '2026-03-31', amountPaid: 30000 });
  assert.strictEqual(third.cycleStart, '2026-03-31');
  assert.throws(() => gs.computeRefund({ houseId: 'rehab', entryDate: '2026-01-31', exitDate: '2026-02-05', amountPaid: 1, decidedDate: '2026-10-01', cycleStart: '2026-03-28' }),
    (e) => e.code === 'cycle_not_aligned', 'a chained date is not a cycle start');

  const leap = refund({ houseId: 'asher', entryDate: '2028-01-31', exitDate: '2028-02-10', amountPaid: 30000 });
  assert.strictEqual(leap.cycleEnd, '2028-02-28');
  // December → January across the year.
  const dec = refund({ houseId: 'asher', entryDate: '2026-12-31', exitDate: '2027-01-05', amountPaid: 30000 });
  assert.strictEqual(dec.cycleEnd, '2027-01-30');
});

test('rate is paid / 30 whatever the cycle length; a 31-day cycle never refunds more than was paid', () => {
  const r = refund({ houseId: 'rehab', entryDate: '2026-10-01', exitDate: '2026-10-01', amountPaid: 30000 });
  assert.strictEqual(r.cycleDays, 31);
  assert.strictEqual(r.daysNotStayed, 30);
  assert.strictEqual(r.refund, 30000);
  // Rounding: from the UNROUNDED rate (1000 / 30 × 7 = 233.33), dailyRate for display.
  const odd = refund({ houseId: 'ramot', entryDate: '2026-09-10', exitDate: '2026-10-02', amountPaid: 1000 });
  assert.strictEqual(odd.dailyRate, 33.33);
  assert.strictEqual(odd.refund, 233.33);
});

test('recorded coverage wins over the derived cycle (plan 8.1); half a coverage pair is an error', () => {
  // v1 rule (exit before 2026-10-07); v2 with recorded coverage: test/refund-rule-v2.test.js.
  const base = { houseId: 'ramot', entryDate: '2026-08-10', exitDate: '2026-09-07', amountPaid: 30000 };
  assert.strictEqual(refund(base).rule, 'residential_last_days_zero', 'derived 10/08–09/09: 07/09 is in the last 7 days');
  const rec = refund(Object.assign({ coverageStart: '2026-08-15', coverageEnd: '2026-09-14' }, base));
  assert.strictEqual(rec.cycleSource, 'recorded_coverage');
  assert.strictEqual(rec.lastDaysFrom, '2026-09-08');
  assert.strictEqual(rec.rule, 'residential_prorata');
  assert.strictEqual(rec.refund, 7000);
  assert.throws(() => gs.computeRefund(Object.assign({ decidedDate: '2026-10-01', coverageStart: '2026-09-15' }, base)),
    (e) => e.code === 'coverage_incomplete');
});

/* ------------------------------------------------------------------------ */
/* Payout date                                                               */
/* ------------------------------------------------------------------------ */

test('payout date: the 10th vs the 11th, and December → January', () => {
  assert.strictEqual(gs.payoutDate('2026-11-10'), '2026-11-15');
  assert.strictEqual(gs.payoutDate('2026-11-11'), '2026-12-15');
  assert.strictEqual(gs.payoutDate('2026-12-01'), '2026-12-15');
  assert.strictEqual(gs.payoutDate('2026-12-10'), '2026-12-15');
  assert.strictEqual(gs.payoutDate('2026-12-11'), '2027-01-15');
  assert.strictEqual(gs.payoutDate('2026-12-31'), '2027-01-15');
  const r = refund({ houseId: 'ramot', entryDate: '2026-09-10', exitDate: '2026-09-28', amountPaid: 30000, decidedDate: '2026-12-11' });
  assert.strictEqual(r.payoutDate, '2027-01-15');
  assert.throws(() => gs.payoutDate(''), (e) => e.code === 'bad_date');
});

/* ------------------------------------------------------------------------ */
/* Dates: Jerusalem-midnight Date cells under a UTC sheet                     */
/* ------------------------------------------------------------------------ */

test('a Jerusalem-midnight Date cell under a UTC sheet stays on its own day', () => {
  const entryCell = new Date('2026-09-09T21:00:00Z');  // 10/09 00:00 Jerusalem (summer, UTC+3)
  const exitCell = new Date('2026-10-02T21:00:00Z');   // 03/10 00:00 Jerusalem
  // The trap: the sheet-zone reader (asISODate_) reads these as the day before.
  assert.strictEqual(gs.asISODate(entryCell), '2026-09-09');
  const before = ssCalls;
  const r = refund({ houseId: 'ramot', entryDate: entryCell, exitDate: exitCell, amountPaid: 30000, decidedDate: new Date('2026-10-10T21:00:00Z') });
  assert.strictEqual(ssCalls, before, 'pure: the spreadsheet (and its zone) is never consulted');
  assert.strictEqual(r.entryDate, '2026-09-10');
  assert.strictEqual(r.exitDate, '2026-10-03');
  assert.strictEqual(r.rule, 'residential_last_days_zero', 'read as 02/10 it would wrongly refund 7 days');
  assert.strictEqual(r.decidedDate, '2026-10-11');
  assert.strictEqual(r.payoutDate, '2026-11-15', 'decided 11/10 Jerusalem, not 10/10 UTC');
  // Winter (UTC+2) and a Sheets serial, and a tz-marked timestamp string.
  assert.strictEqual(gs.payoutDate(new Date('2026-12-10T22:00:00Z')), '2027-01-15');
  assert.strictEqual(refund({ houseId: 'asher', entryDate: 46275, exitDate: '2026-09-12T21:30:00.000Z', amountPaid: 0 }).entryDate, '2026-09-10');
  assert.strictEqual(refund({ houseId: 'asher', entryDate: 46275, exitDate: '2026-09-12T21:30:00.000Z', amountPaid: 0 }).exitDate, '2026-09-13');
});

/* ------------------------------------------------------------------------ */
/* Errors: explicit, never a silent 0                                        */
/* ------------------------------------------------------------------------ */

test('unknown house → explicit unknown_house error, never a silent 0', () => {
  const base = { entryDate: '2026-09-01', exitDate: '2026-09-05', amountPaid: 30000, decidedDate: '2026-10-01' };
  for (const houseId of ['', null, undefined, 'raanana', 'efroni', 'Ramot', 'unknown']) {
    assert.throws(() => gs.computeRefund(Object.assign({ houseId }, base)),
      (e) => e.code === 'unknown_house' && e.field === 'houseId', String(houseId));
  }
  assert.throws(() => gs.computeRefund(undefined), (e) => e.code === 'unknown_house');
});

test('bad input → explicit errors (dates, order, amount)', () => {
  const ok = { houseId: 'asher', entryDate: '2026-09-01', exitDate: '2026-09-05', amountPaid: 30000, decidedDate: '2026-10-01' };
  const bad = (patch, code, field) => assert.throws(() => gs.computeRefund(Object.assign({}, ok, patch)),
    (e) => e.code === code && (!field || e.field === field), JSON.stringify(patch));
  bad({ exitDate: '2026-08-31' }, 'exit_before_entry', 'exitDate');
  bad({ entryDate: '2026-02-30' }, 'bad_date', 'entryDate');
  bad({ exitDate: '05/09/2026' }, 'bad_date', 'exitDate');
  bad({ exitDate: '' }, 'bad_date', 'exitDate');
  bad({ decidedDate: undefined }, 'bad_date', 'decidedDate');
  bad({ entryDate: new Date('x') }, 'bad_date', 'entryDate');
  bad({ amountPaid: '' }, 'bad_amount');
  bad({ amountPaid: -1 }, 'bad_amount');
  bad({ amountPaid: 'abc' }, 'bad_amount');
  bad({ amountPaid: true }, 'bad_amount');
  bad({ cycleStart: '2026-08-01' }, 'cycle_not_aligned', 'cycleStart');
  bad({ coverageStart: '2026-09-30', coverageEnd: '2026-09-01' }, 'bad_coverage');
});

/* ------------------------------------------------------------------------ */
/* Scope: no override, nothing wired, live path unchanged                     */
/* ------------------------------------------------------------------------ */

test('no override parameter: exception fields in the input are ignored (Phase 0b-3)', () => {
  const r = refund({ houseId: 'rehab', entryDate: '2026-09-01', exitDate: '2026-09-20', amountPaid: 30000,
    refund: 9999, amount: 9999, override: true, exceptionApprovedBy: 'סנדרה', policyResult: 'eligible' });
  assert.strictEqual(r.rule, 'detox_tenure_cutoff_zero');
  assert.strictEqual(r.refund, 0);
  assert.ok(!('exceptionApprovedBy' in r));
  assert.match(GS_SRC, /TODO\(Phase 0b-3, personal PINs\)/);
});

/* Superseded by the wiring PR (CHANGELOG-refund-logic-wiring.md): the
 * functions are now the live path. This test used to pin "not wired"; it now
 * pins where they are wired, and that the old 15th cutoff is gone. The full
 * wiring contract is in test/refund-logic-wiring.test.js. */
test('wired: computeRefund_ feeds refundSuggestionsFor_, refundPayoutDate_ feeds upsertCredit_; payoutDateFor_ is retired', () => {
  const body = (name) => {
    const at = GS_SRC.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' exists');
    return GS_SRC.slice(at, GS_SRC.indexOf('\n}\n', at));
  };
  assert.match(body('refundSuggestionsFor_'), /computeRefund_\(/);
  assert.match(body('creditPayoutDate_'), /refundPayoutDate_\(/);
  assert.match(body('upsertCredit_'), /creditPayoutDate_\(/);
  assert.ok(!/function payoutDateFor_\(|payoutDateFor_\(/.test(GS_SRC), 'the 15th-cutoff payoutDateFor_ is gone');
  const appCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/computeRefund_|refundPayoutDate_/.test(appCode), 'app.js calls no server function (comments aside)');
});
