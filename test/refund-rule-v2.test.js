/* Refund rule v2 — one rule for every house (Sandra, 07/10/2026).
 * CHANGELOG-refund-rule-v2.md, CHANGELOG-refunds-auto-policy.md,
 * docs/billing-control-plan.md §8.6.
 *
 *   - stayDay = exit − entry + 1 (entry day = day 1, counted across month
 *     boundaries). stayDay ≥ 14 → no refund for the current cycle
 *     ('stay_day14_zero'); stayDay 1–13 → pro-rata of the current cycle
 *     ('stay_prorata'). (Corrected 07/10/2026: day 14 of the STAY, not of the
 *     billing month.)
 *   - a prepaid cycle that starts after the exit → refunded in full (unchanged);
 *   - payout timing unchanged (decided by the 10th → the 15th, else next 15th);
 *   - selected by the patient's ENTRY date: entry on/after
 *     REFUND_POLICY_CUTOVER (Code.gs, 2026-10-07) → v2; an earlier entry keeps
 *     the v1 per-house rule (last 7 days for asher/ramot, stay day 14 for the
 *     others) WHATEVER the exit date.
 *
 * The rule lives twice — lib/refund-rules.js (window.RefundRules, given the
 * ruleVersion as an input) and apps-script/Code.gs (refundRuleVersion_ /
 * refundCurrentCycleRule_, used by computeRefund_). The cutover date lives only
 * in Code.gs. The parity test runs both over a grid of inputs, the version
 * taken from Code.gs refundRuleVersion_(entry).
 *
 * vm-sandbox on the REAL shipped Code.gs and app.js, per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'refund-rules.js'), 'utf8');
const XLSX_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'refund-forecast-xlsx.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const lib = require('../lib/refund-rules.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* The real (or a mutated) Code.gs, pure refund functions only. */
function loadGs(src) {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, Error, isFinite, isNaN,
    Logger: { log: noop },
    Utilities: { formatDate: (d, tz) => formatInTz(d, tz), getUuid: () => 'uuid' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'UTC' }) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext((typeof src === 'string' ? src : GS_SRC) + `
    globalThis.__t = {
      computeRefund: (x) => computeRefund_(x),
      version: (e) => refundRuleVersion_(e),
      current: (x) => refundCurrentCycleRule_(x),
      suggest: (input, rows, today) => refundSuggestionsFor_(input, rows, today),
      forecast: (d, c, p, t) => refundPayoutForecastFor_(d, c, p, t),
      CUTOVER: REFUND_POLICY_CUTOVER,
      DAY: REFUND_V2_NO_REFUND_FROM_DAY,
    };`, sandbox);
  return sandbox.__t;
}
const gs = loadGs();
const refundWith = (g, x) => plain(g.computeRefund(Object.assign({ decidedDate: '2026-10-07' }, x)));
const refund = (x) => refundWith(gs, x);

/* lib/refund-rules.js in a browser-like sandbox (window.RefundRules). */
function loadLibBrowser(src) {
  const sandbox = { Math, Date, Number, String, Object, Array, RegExp, JSON, Error };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src || LIB_SRC, sandbox);
  return sandbox.RefundRules;
}

const HOUSES = ['asher', 'ramot', 'rehab', 'pardes', 'arfoni', 'sde'];
const FACILITY = { asher: 'residential', ramot: 'residential', rehab: 'detox_dual', pardes: 'detox_dual', arfoni: 'detox_dual', sde: 'detox_dual' };

/* ======================= constants / version ======================= */

test('constants: the stay-day cutoff is 14 in Code.gs AND lib; lib carries no cutover date and no version picker', () => {
  // The fixtures below assume the Code.gs cutover (the literal itself is guarded elsewhere).
  assert.strictEqual(gs.CUTOVER, '2026-10-07');
  assert.strictEqual(gs.DAY, 14);
  assert.strictEqual(lib.REFUND_V2_NO_REFUND_FROM_DAY, 14);
  assert.ok(!('REFUND_RULE_V2_FROM' in lib) && !('refundRuleVersion' in lib), 'the version comes from the server');
  assert.doesNotMatch(GS_SRC, /REFUND_RULE_V2_FROM/);
  assert.doesNotMatch(LIB_SRC, /REFUND_RULE_V2_FROM/);
  // v1 constants unchanged (the old code path is kept).
  assert.strictEqual(lib.REFUND_V1_RESIDENTIAL_LAST_DAYS, 7);
  assert.strictEqual(lib.REFUND_V1_DETOX_CUTOFF_DAY, 14);
  assert.match(GS_SRC, /^const CREDIT_RESIDENTIAL_LAST_DAYS\s+= 7;$/m);
  assert.match(GS_SRC, /^const CREDIT_DETOX_TENURE_CUTOFF_DAYS = 14;/m);
});

test('the version is picked by the ENTRY date: entry 06/10 → v1, 07/10 → v2; a bad date throws; lib needs the version', () => {
  for (const [entry, v] of [['2026-10-06', 1], ['2026-10-07', 2], ['2026-10-08', 2], ['2025-12-31', 1], ['2027-01-01', 2]]) {
    assert.strictEqual(gs.version(entry), v, entry);
  }
  assert.throws(() => gs.version('07/10/2026'), (e) => e.code === 'bad_date');
  // computeRefund_ reports the entry-date version, whatever the exit.
  assert.strictEqual(refund({ houseId: 'asher', entryDate: '2026-09-24', exitDate: '2026-12-01', amountPaid: 30000 }).ruleVersion, 1);
  assert.strictEqual(refund({ houseId: 'asher', entryDate: '2026-10-07', exitDate: '2026-10-07', amountPaid: 30000 }).ruleVersion, 2);
  // lib/refund-rules.js decides nothing by date: no ruleVersion → throws.
  const x = { facilityType: 'residential', entryDate: '2026-10-08', exitDate: '2026-10-20', cycleStart: '2026-10-08', cycleEnd: '2026-11-07' };
  assert.throws(() => lib.currentCycleRule(x), /bad ruleVersion/);
  assert.throws(() => lib.currentCycleRule(Object.assign({ ruleVersion: 3 }, x)), /bad ruleVersion/);
  assert.strictEqual(lib.currentCycleRule(Object.assign({ ruleVersion: 2 }, x)).rule, 'stay_prorata');
  assert.strictEqual(lib.currentCycleRule(Object.assign({ ruleVersion: 1 }, x)).rule, 'residential_prorata');
});

/* ======================= v2: stay day 13 vs 14, every house ======================= */

test('v2: exit on stay day 13 → pro-rata of the current cycle; stay day 14 → 0 — in every house', () => {
  for (const houseId of HOUSES) {
    // Entry 2026-10-08: cycle 08/10–07/11 (31 days). Stay day 13 = 20/10, day 14 = 21/10.
    const base = { houseId, entryDate: '2026-10-08', amountPaid: 30000 };
    const d13 = refund(Object.assign({ exitDate: '2026-10-20' }, base));
    assert.strictEqual(d13.ruleVersion, 2, houseId);
    assert.strictEqual(d13.stayDay, 13, houseId);
    assert.strictEqual(d13.rule, 'stay_prorata', houseId);
    assert.strictEqual(d13.daysNotStayed, 18, houseId);
    assert.strictEqual(d13.refund, 18000, houseId + ' day 13: 30000 / 30 × 18 days not stayed');
    assert.strictEqual(d13.lastDaysFrom, '', houseId + ' no «last 7 days» window under v2');
    assert.ok(!('billingMonthDay' in d13), houseId + ' no billing-month day in the breakdown');

    const d14 = refund(Object.assign({ exitDate: '2026-10-21' }, base));
    assert.strictEqual(d14.stayDay, 14, houseId);
    assert.strictEqual(d14.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(d14.refund, 0, houseId + ' day 14 → 0');
    assert.strictEqual(d14.uncappedRefund, 17000, houseId + ' the raw figure is still recorded');

    const d1 = refund(Object.assign({ exitDate: '2026-10-08' }, base));
    assert.strictEqual(d1.stayDay, 1, houseId);
    assert.strictEqual(d1.rule, 'stay_prorata', houseId);
    assert.strictEqual(d1.refund, 30000, houseId + ' day 1 of a 31-day cycle: 30 days not stayed');
  }
});

test('v2: the stay day counts across month boundaries (calendar month and cycle boundaries are irrelevant)', () => {
  for (const houseId of HOUSES) {
    // Entry 25/10: stay day 13 = 06/11, day 14 = 07/11 — across the calendar month end.
    const b = { houseId, entryDate: '2026-10-25', amountPaid: 30000 };
    const d13 = refund(Object.assign({ exitDate: '2026-11-06' }, b));
    assert.strictEqual(d13.stayDay, 13, houseId);
    assert.strictEqual(d13.rule, 'stay_prorata', houseId);
    assert.strictEqual(d13.cycleEnd, '2026-11-24');
    assert.strictEqual(d13.refund, 18000, houseId + ' 18 days not stayed (07/11–24/11)');
    const d14 = refund(Object.assign({ exitDate: '2026-11-07' }, b));
    assert.strictEqual(d14.stayDay, 14, houseId);
    assert.strictEqual(d14.refund, 0, houseId);
    // Entry 30/11 → stay day 13 = 12/12, day 14 = 13/12 (crosses the November end).
    const e = { houseId, entryDate: '2026-11-30', amountPaid: 30000 };
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-12-12' }, e)).refund, 17000, houseId + ' day 13: 13/12–29/12');
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-12-13' }, e)).refund, 0, houseId + ' day 14');
  }
  // 31 Jan entry: stay day 13 = 12/02, day 14 = 13/02 (the clamped cycle 31/01–27/02).
  const jan = { houseId: 'asher', entryDate: '2027-01-31', amountPaid: 30000 };
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-12' }, jan)).rule, 'stay_prorata');
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-12' }, jan)).refund, 15000, '15 days not stayed (13/02–27/02)');
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-13' }, jan)).rule, 'stay_day14_zero');
});

test('v2: an exit in the second cycle or later is past stay day 14 → 0 for that cycle (NOT counted from the cycle start)', () => {
  for (const houseId of HOUSES) {
    // Entry 20/10 → cycle 2 starts 20/11; exit 01/12 is day 12 of that cycle but stay day 43.
    const r = refund({ houseId, entryDate: '2026-10-20', exitDate: '2026-12-01', amountPaid: 30000 });
    assert.strictEqual(r.cycleStart, '2026-11-20', houseId);
    assert.strictEqual(r.stayDay, 43, houseId);
    assert.strictEqual(r.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(r.refund, 0, houseId);
  }
});

test('v2: a RECORDED coverage period sets the cycle (days not stayed); the rule is still the stay day', () => {
  const base = { houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-20', amountPaid: 30000 };
  const rec = refund(Object.assign({ coverageStart: '2026-10-10', coverageEnd: '2026-11-09' }, base));
  assert.strictEqual(rec.cycleSource, 'recorded_coverage');
  assert.strictEqual(rec.stayDay, 13);
  assert.strictEqual(rec.rule, 'stay_prorata');
  assert.strictEqual(rec.refund, 20000, '20 days not stayed (21/10–09/11)');
  const rec14 = refund(Object.assign({}, base, { exitDate: '2026-10-21', coverageStart: '2026-10-15', coverageEnd: '2026-11-14' }));
  assert.strictEqual(rec14.stayDay, 14);
  assert.strictEqual(rec14.refund, 0, 'a later coverage start does not reset the stay day');
});

/* ======================= entry 06/10 vs 07/10 ======================= */

test('entry 06/10 → the old per-house rule; entry 07/10 → the new stay-day rule (balance houses)', () => {
  for (const houseId of ['asher', 'ramot']) {
    // Entry 06/10: cycle 06/10–05/11, last 7 days 30/10–05/11. Stay day 14 = 19/10.
    const old = { houseId, entryDate: '2026-10-06', amountPaid: 30000 };
    const o14 = refund(Object.assign({ exitDate: '2026-10-19' }, old));
    assert.strictEqual(o14.ruleVersion, 1, houseId);
    assert.strictEqual(o14.rule, 'residential_prorata', houseId + ' v1 residential refunds on stay day 14');
    assert.strictEqual(o14.refund, 17000, houseId + ' 17 days not stayed (20/10–05/11)');
    assert.strictEqual(o14.lastDaysFrom, '2026-10-30', houseId + ' v1 keeps its breakdown');
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-30' }, old)).rule, 'residential_last_days_zero', houseId);
    // Entry 07/10: cycle 07/10–06/11. Stay day 13 = 19/10, day 14 = 20/10.
    const neu = { houseId, entryDate: '2026-10-07', amountPaid: 30000 };
    const n13 = refund(Object.assign({ exitDate: '2026-10-19' }, neu));
    assert.strictEqual(n13.ruleVersion, 2, houseId);
    assert.strictEqual(n13.rule, 'stay_prorata', houseId);
    assert.strictEqual(n13.refund, 18000, houseId);
    const n14 = refund(Object.assign({ exitDate: '2026-10-20' }, neu));
    assert.strictEqual(n14.rule, 'stay_day14_zero', houseId + ' v2: stay day 14 → no refund');
    assert.strictEqual(n14.refund, 0, houseId);
    assert.strictEqual(n14.lastDaysFrom, '', houseId);
  }
});

test('entry 06/10 → the old per-house rule; entry 07/10 → the new rule (rehab / dual-diagnosis — same stay-day cutoff, new rule name)', () => {
  for (const houseId of ['rehab', 'pardes', 'arfoni', 'sde']) {
    const old = { houseId, entryDate: '2026-10-06', amountPaid: 30000 };
    const o13 = refund(Object.assign({ exitDate: '2026-10-18' }, old));   // stay day 13
    assert.strictEqual(o13.ruleVersion, 1, houseId);
    assert.strictEqual(o13.rule, 'detox_prorata', houseId);
    assert.strictEqual(o13.refund, 18000, houseId);
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-19' }, old)).rule, 'detox_tenure_cutoff_zero', houseId);
    const neu = { houseId, entryDate: '2026-10-07', amountPaid: 30000 };
    const n13 = refund(Object.assign({ exitDate: '2026-10-19' }, neu));   // stay day 13
    assert.strictEqual(n13.ruleVersion, 2, houseId);
    assert.strictEqual(n13.rule, 'stay_prorata', houseId);
    assert.strictEqual(n13.refund, 18000, houseId);
    const n14 = refund(Object.assign({ exitDate: '2026-10-20' }, neu));   // stay day 14
    assert.strictEqual(n14.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(n14.refund, 0, houseId);
  }
});

test('an entry before 07/10 keeps the old rule even when the EXIT is on/after 07/10', () => {
  // asher, entry 24/09: cycle 24/09–23/10, last 7 days 17/10–23/10. Exit 07/10 = stay day 14.
  const res = refund({ houseId: 'asher', entryDate: '2026-09-24', exitDate: '2026-10-07', amountPaid: 30000 });
  assert.strictEqual(res.ruleVersion, 1);
  assert.strictEqual(res.rule, 'residential_prorata', 'not stay_day14_zero — the exit date does not pick the rule');
  assert.strictEqual(res.refund, 16000, '16 days not stayed (08/10–23/10)');
  assert.strictEqual(res.lastDaysFrom, '2026-10-17');
  assert.strictEqual(refund({ houseId: 'asher', entryDate: '2026-09-24', exitDate: '2026-10-17', amountPaid: 30000 }).rule, 'residential_last_days_zero');
  // ramot, entry 22/09, exit 08/10 (stay day 17): still pro-rata under v1.
  assert.strictEqual(refund({ houseId: 'ramot', entryDate: '2026-09-22', exitDate: '2026-10-08', amountPaid: 30000 }).refund, 13000);
  // detox, entry 24/09: exit 06/10 (day 13) → pro-rata; 07/10 (day 14) → the v1 detox cutoff.
  const d13 = refund({ houseId: 'rehab', entryDate: '2026-09-24', exitDate: '2026-10-06', amountPaid: 30000 });
  assert.strictEqual(d13.rule, 'detox_prorata');
  assert.strictEqual(d13.refund, 17000);
  const d14 = refund({ houseId: 'rehab', entryDate: '2026-09-24', exitDate: '2026-10-07', amountPaid: 30000 });
  assert.strictEqual(d14.ruleVersion, 1);
  assert.strictEqual(d14.rule, 'detox_tenure_cutoff_zero');
});

test('v1 is kept as it was for entries before 07/10 — every house, day 13 / day 14 / last 7 days', () => {
  for (const houseId of HOUSES) {
    const base = { houseId, entryDate: '2026-09-01', amountPaid: 30000 };   // cycle 01/09–30/09
    const d13 = refund(Object.assign({ exitDate: '2026-09-13' }, base));
    const d14 = refund(Object.assign({ exitDate: '2026-09-14' }, base));
    const d24 = refund(Object.assign({ exitDate: '2026-09-24' }, base));    // last 7 days start
    assert.strictEqual(d13.ruleVersion, 1);
    if (FACILITY[houseId] === 'residential') {
      assert.strictEqual(d13.rule, 'residential_prorata', houseId);
      assert.strictEqual(d14.rule, 'residential_prorata', houseId + ' v1 residential refunds on day 14');
      assert.strictEqual(d14.refund, 16000, houseId);
      assert.strictEqual(d24.rule, 'residential_last_days_zero', houseId);
    } else {
      assert.strictEqual(d13.rule, 'detox_prorata', houseId);
      assert.strictEqual(d14.rule, 'detox_tenure_cutoff_zero', houseId);
      assert.strictEqual(d14.refund, 0, houseId);
    }
  }
});

/* ======================= unchanged: prepaid, fully used, payout ======================= */

test('v2: a fully prepaid cycle after the exit is refunded in full, beside a day-14+ zero', () => {
  for (const houseId of HOUSES) {
    const base = { houseId, entryDate: '2026-10-25', exitDate: '2026-11-19', amountPaid: 30000 };
    const cur = refund(Object.assign({ cycleStart: '2026-10-25' }, base));
    assert.strictEqual(cur.stayDay, 26, houseId);
    assert.strictEqual(cur.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(cur.refund, 0, houseId);
    const next = refund(Object.assign({ cycleStart: '2026-11-25' }, base));
    assert.strictEqual(next.rule, 'prepaid_return', houseId);
    assert.strictEqual(next.refund, 30000, houseId);
    // a short stay (day 13) with the next month prepaid: pro-rata now + the prepaid month in full
    const short = { houseId, entryDate: '2026-10-08', exitDate: '2026-10-20', amountPaid: 30000 };
    assert.strictEqual(refund(Object.assign({ cycleStart: '2026-10-08' }, short)).refund, 18000, houseId);
    assert.strictEqual(refund(Object.assign({ cycleStart: '2026-11-08' }, short)).refund, 30000, houseId);
  }
  const used = refund({ houseId: 'asher', entryDate: '2026-10-08', exitDate: '2026-12-10', cycleStart: '2026-10-08', amountPaid: 30000 });
  assert.strictEqual(used.rule, 'cycle_fully_used');
  assert.strictEqual(used.refund, 0);
});

test('payout timing unchanged under v2: decided on the 10th → the 15th; the 11th → the next 15th', () => {
  const base = { houseId: 'asher', entryDate: '2026-10-08', exitDate: '2026-10-12', amountPaid: 30000 };
  assert.strictEqual(refundWith(gs, Object.assign({}, base, { decidedDate: '2026-11-10' })).payoutDate, '2026-11-15');
  assert.strictEqual(refundWith(gs, Object.assign({}, base, { decidedDate: '2026-11-11' })).payoutDate, '2026-12-15');
});

test('no override parameter under v2 either: exception fields in the input are ignored (Sandra-only, server-side)', () => {
  const r = refund({ houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-21', amountPaid: 30000,
    refund: 9999, override: true, exceptionApprovedBy: 'sandra', policyResult: 'eligible' });
  assert.strictEqual(r.rule, 'stay_day14_zero');
  assert.strictEqual(r.refund, 0);
});

/* ======================= the live path: suggestions + forecast ======================= */

const KEY = 'ramot::דנה::2026-10-08';
const payRow = (over) => Object.assign({ id: 'pay::' + KEY + '::' + over.dueDate, patientId: KEY, amount: 30000, status: 'paid', amountPaid: 30000, balance: 0 }, over);

test('suggestRefunds (refundSuggestionsFor_) under v2: day 13 → eligible pro-rata line; day 14 → one zero line + the prepaid return', () => {
  const rows = [payRow({ dueDate: '2026-10-08' }), payRow({ dueDate: '2026-11-08' })];
  const d13 = plain(gs.suggest({ houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-20', patientKey: KEY }, rows, '2026-10-22'));
  const du13 = d13.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(du13.basis.rule, 'stay_prorata');
  assert.strictEqual(du13.basis.eligible, true);
  assert.strictEqual(du13.basis.ruleVersion, 2);
  assert.strictEqual(du13.calculatedAmount, 18000);
  assert.strictEqual(d13.find((s) => s.creditType === 'prepaid_return').calculatedAmount, 30000);

  const d14 = plain(gs.suggest({ houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-21', patientKey: KEY }, rows, '2026-10-22'));
  const du14 = d14.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(du14.basis.rule, 'stay_day14_zero');
  assert.strictEqual(du14.basis.eligible, false);
  assert.strictEqual(du14.calculatedAmount, 0);
  assert.strictEqual(d14.find((s) => s.creditType === 'prepaid_return').calculatedAmount, 30000);
});

test('refund list under v2: a day-13 exit is a «לתשלום» row (by policy, v2); a day-14 exit is a zero by policy', () => {
  const pays = [payRow({ dueDate: '2026-10-08' })];
  const dis = (exit) => [{ id: 'd1', houseId: 'ramot', name: 'דנה', date: '2026-10-08', exitDate: exit, status: 'released', restored: '' }];
  const f13 = plain(gs.forecast(dis('2026-10-20'), [], pays, '2026-10-22'));
  assert.strictEqual(f13.toPay.total, 18000);
  assert.strictEqual(f13.toPay.rows[0].rule, 'stay_prorata');
  assert.strictEqual(f13.toPay.rows[0].ruleVersion, 2);
  assert.strictEqual(f13.toPay.rows[0].payoutDate, '2026-11-15', 'exit after the 10th → the next 15th');
  const f14 = plain(gs.forecast(dis('2026-10-21'), [], pays, '2026-10-22'));
  assert.strictEqual(f14.toPay.count, 0);
  assert.strictEqual(f14.zeroByPolicyCount, 1);
});

/* ======================= parity lib ↔ Code.gs ======================= */

/* The version comes from Code.gs refundRuleVersion_(entry) — the server's
 * answer — and is handed to the lib, as the page does with basis.ruleVersion. */
function parityRun(L, G) {
  const diffs = [];
  const entries = ['2026-01-31', '2026-02-28', '2026-08-15', '2026-09-01', '2026-09-20', '2026-09-30', '2026-10-01',
    '2026-10-06', '2026-10-07', '2026-10-08', '2026-11-30', '2027-01-31'];
  for (const ft of ['residential', 'detox_dual']) {
    for (const entry of entries) {
      const e0 = Date.UTC(Number(entry.slice(0, 4)), Number(entry.slice(5, 7)) - 1, Number(entry.slice(8, 10)));
      const ruleVersion = G.version(entry);
      for (let off = 0; off < 75; off++) {
        const exit = new Date(e0 + off * 86400000).toISOString().slice(0, 10);
        // The cycle that holds the exit, from computeRefund_ itself.
        const b = G.computeRefund({ houseId: ft === 'residential' ? 'asher' : 'rehab', entryDate: entry, exitDate: exit, amountPaid: 0, decidedDate: '2026-10-07' });
        const x = { facilityType: ft, entryDate: entry, exitDate: exit, cycleStart: b.cycleStart, cycleEnd: b.cycleEnd };
        const a = JSON.stringify(plain(L.currentCycleRule(Object.assign({ ruleVersion }, x))));
        const g = JSON.stringify(plain(G.current(x)));
        if (a !== g) diffs.push(`${ft} ${entry}→${exit}: lib ${a} ≠ gs ${g}`);
        if (b.ruleVersion !== ruleVersion) diffs.push(`computeRefund_ version ${entry}`);
        if (b.rule !== plain(G.current(x)).rule) diffs.push(`computeRefund_ ${ft} ${entry}→${exit}: ${b.rule}`);
      }
    }
  }
  return diffs;
}

test('parity: lib/refund-rules.js and Code.gs give the same rule on a grid of entries × exits (entries both sides of 07/10), and computeRefund_ uses it', () => {
  const diffs = parityRun(lib, gs);
  assert.deepStrictEqual(diffs.slice(0, 5), []);
  // The browser build (window.RefundRules) is the same file.
  assert.deepStrictEqual(parityRun(loadLibBrowser(), gs).slice(0, 5), []);
});

/* ======================= UI: labels, breakdown, the modal's rule line ======================= */

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '', value: '', hidden: false,
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}
function loadApp(withRules) {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Intl, Set, Map,
    setTimeout, clearTimeout, fetch: () => new Promise(() => {}),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (withRules !== false) vm.runInContext(typeof withRules === 'string' ? withRules : LIB_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__t = { CREDIT_RULE_LABELS, creditRuleLabel, creditBreakdownHtml, refundPolicyNote, creditBasisText };`, sandbox);
  return sandbox.__t;
}
const app = loadApp();

test('labels: the two v2 rules have Hebrew labels on screen and in the .xlsx; the v1 labels stay for older entries', () => {
  assert.strictEqual(app.CREDIT_RULE_LABELS.stay_prorata, 'יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי');
  assert.strictEqual(app.CREDIT_RULE_LABELS.stay_day14_zero, 'יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי');
  assert.ok(!('billing_month_prorata' in app.CREDIT_RULE_LABELS) && !('billing_month_day14_zero' in app.CREDIT_RULE_LABELS));
  assert.strictEqual(app.CREDIT_RULE_LABELS.residential_last_days_zero, '7 הימים האחרונים במחזור — ללא זיכוי');
  assert.strictEqual(app.CREDIT_RULE_LABELS.detox_tenure_cutoff_zero, 'יום 14 ומעלה — ללא זיכוי');
  const xlsx = require('../lib/refund-forecast-xlsx.js');
  assert.deepStrictEqual(plain(xlsx.RULE_LABELS), plain(app.CREDIT_RULE_LABELS));
  assert.match(XLSX_SRC, /stay_day14_zero/);
});

test('breakdown: a v2 basis shows the stay day in every house and no «7 הימים האחרונים»; a v1 basis is unchanged', () => {
  const v2 = refund({ houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-21', amountPaid: 30000 });
  assert.strictEqual(v2.ruleVersion, 2);
  const html2 = app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v2));
  assert.match(html2, /יום שהייה ביציאה:<\/span> <span class="credit-bd-v">14</);
  assert.doesNotMatch(html2, /7 הימים האחרונים במחזור:/);
  assert.doesNotMatch(html2, /חודש החיוב ביציאה/);
  assert.match(html2, /יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי/);

  const v1 = refund({ houseId: 'ramot', entryDate: '2026-09-10', exitDate: '2026-10-02', amountPaid: 30000 });
  const html1 = app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v1));
  assert.match(html1, /7 הימים האחרונים במחזור:/);
  assert.doesNotMatch(html1, /יום שהייה ביציאה/, 'v1 residential shows the last-7-days window, not the stay day');
  // An entry before the cutover with an exit after it is still a v1 breakdown.
  const v1late = refund({ houseId: 'asher', entryDate: '2026-09-24', exitDate: '2026-10-08', amountPaid: 30000 });
  assert.strictEqual(v1late.ruleVersion, 1);
  const htmlLate = app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v1late));
  assert.match(htmlLate, /7 הימים האחרונים במחזור:<\/span> <span class="credit-bd-v">17\/10\/2026 – 23\/10\/2026</);
  assert.doesNotMatch(htmlLate, /יום שהייה ביציאה/);
  const v1d = refund({ houseId: 'rehab', entryDate: '2026-09-25', exitDate: '2026-10-06', amountPaid: 30000 });
  assert.match(app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v1d)), /יום שהייה ביציאה:/);
});

test('the «זיכויים» modal rule line names the rule of the server basis\'s ruleVersion — no date on the client, nothing without the rules file', () => {
  const v2 = app.refundPolicyNote(2, 'residential');
  assert.match(v2, /כלל ההחזר החדש \(כניסה מתאריך המעבר ואילך, כל הבתים\)/);
  assert.match(v2, /יציאה ביום השהייה ה־14 ומעלה \(יום הכניסה = יום 1\) — ללא זיכוי על המחזור הנוכחי; יציאה ביום שהייה 1–13 — זיכוי יחסי/);
  assert.match(v2, /מחזור ששולם מראש ומתחיל אחרי היציאה — החזר מלא/);
  assert.doesNotMatch(v2, /חודש החיוב/);
  assert.doesNotMatch(v2, /\d{2}\/\d{2}\/\d{4}/, 'the cutover date lives on the server only');
  assert.strictEqual(app.refundPolicyNote(2, 'detox_dual'), v2, 'one rule for every house');
  assert.strictEqual(app.refundPolicyNote('2', 'residential'), v2, 'a version read back from a stored basis');
  assert.match(app.refundPolicyNote(1, 'residential'), /כניסה לפני תאריך המעבר, בית מאזן\): יציאה ב־7 הימים האחרונים/);
  assert.match(app.refundPolicyNote(1, 'detox_dual'), /כניסה לפני תאריך המעבר, גמילה \/ דואלי\): יציאה ביום שהייה 14 ומעלה/);
  assert.strictEqual(app.refundPolicyNote(1, ''), '', 'v1 needs the house type');
  assert.strictEqual(app.refundPolicyNote('', 'residential'), '', 'no version → no line');
  assert.strictEqual(app.refundPolicyNote('2026-10-07', 'residential'), '', 'a date is not a version');
  assert.strictEqual(loadApp(false).refundPolicyNote(2, 'residential'), '', 'no RefundRules → no line, no throw');
  // The modal takes the version from a saved credit's server basis, and escapes the line.
  assert.match(APP_SRC, /refundPolicyNote\(versioned \? versioned\.basis\.ruleVersion : '', facility\)/);
  assert.match(APP_SRC, /\$\{policyNote \? `<p class="credit-policy">\$\{escapeHtml\(policyNote\)\}<\/p>` : ''\}/);
});

test('wiring: /refund-rules.js is served like the other lib rules, loaded before app.js, hashed by the SW', () => {
  assert.match(SERVER_SRC, /'\/refund-rules\.js': \{ file: path\.join\(__dirname, 'lib', 'refund-rules\.js'\)/);
  assert.match(SERVER_SRC, /app\.get\('\/refund-rules\.js', sendLibAsset\('\/refund-rules\.js'\)\);/);
  assert.ok(INDEX_SRC.indexOf('refund-rules.js?v=__BUILD__') > 0);
  assert.ok(INDEX_SRC.indexOf('refund-rules.js?v=__BUILD__') < INDEX_SRC.indexOf('app.js?v=__BUILD__'));
  assert.match(SW_SRC, /var BUNDLE_PATHS = \[[^\]]*'\/refund-rules\.js'[^\]]*\]/);
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 46);
  assert.doesNotMatch(LIB_SRC, /fetch\(|require\(|Date\.now|new Date\(\)/, 'pure: no I/O, no clock');
});

/* ======================= mutation checks ======================= */

/* Core assertions as functions returning '' (pass) or a failure string, so a
 * mutated Code.gs / lib can be shown to FAIL them. */
const GS_CHECKS = {
  day13vs14: (g) => {
    const b = { houseId: 'asher', entryDate: '2026-10-08', amountPaid: 30000 };
    const d13 = refundWith(g, Object.assign({ exitDate: '2026-10-20' }, b));
    const d14 = refundWith(g, Object.assign({ exitDate: '2026-10-21' }, b));
    return d13.refund === 18000 && d14.refund === 0 ? '' : `d13 ${d13.refund} d14 ${d14.refund}`;
  },
  secondCycle: (g) => {
    const r = refundWith(g, { houseId: 'asher', entryDate: '2026-10-20', exitDate: '2026-12-01', amountPaid: 30000 });
    return r.refund === 0 && r.rule === 'stay_day14_zero' ? '' : `second cycle ${r.rule} ${r.refund}`;
  },
  entry06vs07: (g) => {
    // Stay day 14 for both: entry 06/10 → v1 residential pro-rata; entry 07/10 → v2 zero.
    const a = refundWith(g, { houseId: 'asher', entryDate: '2026-10-06', exitDate: '2026-10-19', amountPaid: 30000 });
    const c = refundWith(g, { houseId: 'asher', entryDate: '2026-10-07', exitDate: '2026-10-20', amountPaid: 30000 });
    return a.rule === 'residential_prorata' && a.refund === 17000 && a.ruleVersion === 1
      && c.rule === 'stay_day14_zero' && c.refund === 0 && c.ruleVersion === 2 ? '' : `${a.rule} / ${c.rule}`;
  },
  entryNotExit: (g) => {
    // Entry before the cutover, exit after it (stay day 14) → still v1.
    const r = refundWith(g, { houseId: 'asher', entryDate: '2026-09-24', exitDate: '2026-10-07', amountPaid: 30000 });
    return r.ruleVersion === 1 && r.rule === 'residential_prorata' && r.refund === 16000 && r.lastDaysFrom === '2026-10-17'
      ? '' : `${r.ruleVersion} ${r.rule} ${r.refund} ${r.lastDaysFrom}`;
  },
  prepaid: (g) => {
    const r = refundWith(g, { houseId: 'ramot', entryDate: '2026-10-25', exitDate: '2026-11-19', cycleStart: '2026-11-25', amountPaid: 30000 });
    return r.refund === 30000 ? '' : 'prepaid ' + r.refund;
  },
  eligible: (g) => {
    const rows = [payRow({ dueDate: '2026-10-08' })];
    const s = plain(g.suggest({ houseId: 'ramot', entryDate: '2026-10-08', exitDate: '2026-10-20', patientKey: KEY }, rows, '2026-10-22'));
    return s[0].basis.eligible === true ? '' : 'v2 pro-rata not eligible';
  },
  parity: (g) => (parityRun(lib, g).length === 0 ? '' : 'parity broken'),
};

test('mutation check: the real Code.gs passes every core check', () => {
  for (const [name, fn] of Object.entries(GS_CHECKS)) assert.strictEqual(fn(gs), '', name);
});

const GS_MUTANTS = [
  ['cutoff day 14 → 15', 'day13vs14', "rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'", "rule = stayDay > REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'"],
  ['cutover moved to 08/10', 'entry06vs07', "const REFUND_POLICY_CUTOVER           = '2026-10-07';", "const REFUND_POLICY_CUTOVER           = '2026-10-08';"],
  ['cutover moved back to 24/09', 'entryNotExit', "const REFUND_POLICY_CUTOVER           = '2026-10-07';", "const REFUND_POLICY_CUTOVER           = '2026-09-24';"],
  ['version compared with > (entry 07/10 stays v1)', 'entry06vs07', 'return s >= REFUND_POLICY_CUTOVER ? 2 : 1;', 'return s > REFUND_POLICY_CUTOVER ? 2 : 1;'],
  ['rule picked by the EXIT date', 'entryNotExit', 'const version = refundRuleVersion_(o.entryDate);', 'const version = refundRuleVersion_(o.exitDate);'],
  ['reported version (and v1 breakdown) by the EXIT date', 'entryNotExit', 'const ruleVersion = refundRuleVersion_(entryDate);', 'const ruleVersion = refundRuleVersion_(exitDate);'],
  ['stay day counted from the cycle start (the billing-month reading)', 'secondCycle', 'const endN = refundDayNum_(o.cycleEnd);\n  const stayDay = exitN - entryN + 1;', 'const endN = refundDayNum_(o.cycleEnd);\n  const stayDay = exitN - refundDayNum_(o.cycleStart) + 1;'],
  ['v2 pro-rata pays nothing', 'day13vs14', "refundDue: rule === 'stay_prorata' || rule === 'residential_prorata'", "refundDue: rule === 'residential_prorata'"],
  ['prepaid cycle no longer returned in full', 'prepaid', 'uncapped = amountPaid; refund = amountPaid;', 'uncapped = amountPaid; refund = 0;'],
  ['v2 pro-rata not eligible in the suggestion', 'eligible', "b.rule === 'stay_prorata' || b.rule === 'prepaid_return'", "b.rule === 'prepaid_return'"],
];

for (const [name, check, from, to] of GS_MUTANTS) {
  test(`mutation check (Code.gs): «${name}» FAILS its check`, () => {
    assert.strictEqual(GS_SRC.split(from).length, 2, 'the mutation site exists exactly once: ' + from);
    let failure;
    try { failure = GS_CHECKS[check](loadGs(GS_SRC.replace(from, to))); } catch (e) { failure = 'threw: ' + e.message; }
    assert.notStrictEqual(failure, '', 'the mutant survived');
  });
}

test('mutation check (lib): a lib whose cutoff drifts from Code.gs, or that ignores ruleVersion, FAILS the parity check', () => {
  const from = "rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'";
  assert.strictEqual(LIB_SRC.split(from).length, 2);
  const mutant = loadLibBrowser(LIB_SRC.replace(from, from.replace('>=', '>')));
  assert.ok(parityRun(mutant, gs).length > 0, 'the mutant survived');
  // A lib that ignores the server's ruleVersion (always the new rule) FAILS too.
  const fromVer = 'if (version === 2) {';
  assert.strictEqual(LIB_SRC.split(fromVer).length, 2);
  assert.ok(parityRun(loadLibBrowser(LIB_SRC.replace(fromVer, 'if (true) {')), gs).length > 0, 'version-blind mutant survived');
});
