/* Refund rule v2 — one rule for every house (Sandra, 07/10/2026).
 * CHANGELOG-refund-rule-v2.md, docs/billing-control-plan.md §8.6.
 *
 *   - stayDay = exit − entry + 1 (entry day = day 1, counted across month
 *     boundaries). stayDay ≥ 14 → no refund for the current cycle
 *     ('stay_day14_zero'); stayDay 1–13 → pro-rata of the current cycle
 *     ('stay_prorata'). (Corrected 07/10/2026: day 14 of the STAY, not of the
 *     billing month.)
 *   - a prepaid cycle that starts after the exit → refunded in full (unchanged);
 *   - payout timing unchanged (decided by the 10th → the 15th, else next 15th);
 *   - selected by the EXIT date: exit on/after REFUND_RULE_V2_FROM = 2026-10-07
 *     → v2; an earlier exit keeps the v1 per-house rule (last 7 days for
 *     asher/ramot, stay day 14 for the others).
 *
 * The rule lives twice — lib/refund-rules.js (window.RefundRules) and
 * apps-script/Code.gs (refundRuleVersion_ / refundCurrentCycleRule_, used by
 * computeRefund_). The parity test runs both over a grid of inputs.
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
      FROM: REFUND_RULE_V2_FROM,
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

/* ======================= guard ======================= */

test('guard: REFUND_RULE_V2_FROM is 2026-10-07 and the cutoff day is 14 — in Code.gs AND lib/refund-rules.js', () => {
  assert.strictEqual(gs.FROM, '2026-10-07');
  assert.strictEqual(lib.REFUND_RULE_V2_FROM, '2026-10-07');
  assert.strictEqual(gs.DAY, 14);
  assert.strictEqual(lib.REFUND_V2_NO_REFUND_FROM_DAY, 14);
  assert.match(GS_SRC, /^const REFUND_RULE_V2_FROM\s+= '2026-10-07';$/m);
  assert.match(LIB_SRC, /^const REFUND_RULE_V2_FROM = '2026-10-07';$/m);
  // v1 constants unchanged (the old code path is kept).
  assert.strictEqual(lib.REFUND_V1_RESIDENTIAL_LAST_DAYS, 7);
  assert.strictEqual(lib.REFUND_V1_DETOX_CUTOFF_DAY, 14);
  assert.match(GS_SRC, /^const CREDIT_RESIDENTIAL_LAST_DAYS\s+= 7;$/m);
  assert.match(GS_SRC, /^const CREDIT_DETOX_TENURE_CUTOFF_DAYS = 14;/m);
});

test('the version is picked by the EXIT date: 06/10 → v1, 07/10 → v2 (both runtimes); a bad date throws', () => {
  for (const [exit, v] of [['2026-10-06', 1], ['2026-10-07', 2], ['2026-10-08', 2], ['2025-12-31', 1], ['2027-01-01', 2]]) {
    assert.strictEqual(gs.version(exit), v, exit);
    assert.strictEqual(lib.refundRuleVersion(exit), v, exit);
  }
  assert.throws(() => gs.version('07/10/2026'), (e) => e.code === 'bad_date');
  assert.throws(() => lib.refundRuleVersion(''), /bad exitDate/);
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
    // Entry 30/09 → stay day 13 = 12/10, day 14 = 13/10 (crosses the September end).
    const e = { houseId, entryDate: '2026-09-30', amountPaid: 30000 };
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-12' }, e)).refund, 17000, houseId + ' day 13: 13/10–29/10');
    assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-13' }, e)).refund, 0, houseId + ' day 14');
  }
  // 31 Jan entry: stay day 13 = 12/02, day 14 = 13/02 (the clamped cycle 31/01–27/02).
  const jan = { houseId: 'asher', entryDate: '2027-01-31', amountPaid: 30000 };
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-12' }, jan)).rule, 'stay_prorata');
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-12' }, jan)).refund, 15000, '15 days not stayed (13/02–27/02)');
  assert.strictEqual(refund(Object.assign({ exitDate: '2027-02-13' }, jan)).rule, 'stay_day14_zero');
});

test('v2: an exit in the second cycle or later is past stay day 14 → 0 for that cycle (NOT counted from the cycle start)', () => {
  for (const houseId of HOUSES) {
    // Entry 20/09 → cycle 2 starts 20/10; exit 01/11 is day 13 of that cycle but stay day 43.
    const r = refund({ houseId, entryDate: '2026-09-20', exitDate: '2026-11-01', amountPaid: 30000 });
    assert.strictEqual(r.cycleStart, '2026-10-20', houseId);
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

/* ======================= exit 06/10 vs 07/10 ======================= */

test('exit 06/10 → the old per-house rule; exit 07/10 → the new stay-day rule (balance houses)', () => {
  for (const houseId of ['asher', 'ramot']) {
    // Entry 24/09: cycle 24/09–23/10, last 7 days 17/10–23/10. 06/10 = stay day 13, 07/10 = 14.
    const base = { houseId, entryDate: '2026-09-24', amountPaid: 30000 };
    const oct06 = refund(Object.assign({ exitDate: '2026-10-06' }, base));
    assert.strictEqual(oct06.ruleVersion, 1, houseId);
    assert.strictEqual(oct06.rule, 'residential_prorata', houseId);
    assert.strictEqual(oct06.refund, 17000, houseId);
    assert.strictEqual(oct06.lastDaysFrom, '2026-10-17', houseId + ' v1 keeps its breakdown');
    const oct07 = refund(Object.assign({ exitDate: '2026-10-07' }, base));
    assert.strictEqual(oct07.ruleVersion, 2, houseId);
    assert.strictEqual(oct07.rule, 'stay_day14_zero', houseId + ' v2: stay day 14 → no refund');
    assert.strictEqual(oct07.refund, 0, houseId);
  }
  // ramot, entry 22/09: v1 refunds 06/10 (stay day 15, outside the last 7 days); v2 gives 0 on 07/10.
  const r = { houseId: 'ramot', entryDate: '2026-09-22', amountPaid: 30000 };
  assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-06' }, r)).refund, 15000);
  assert.strictEqual(refund(Object.assign({ exitDate: '2026-10-07' }, r)).refund, 0);
});

test('exit 06/10 → the old per-house rule; exit 07/10 → the new rule (rehab / dual-diagnosis — same stay-day cutoff, new rule name)', () => {
  for (const houseId of ['rehab', 'pardes', 'arfoni', 'sde']) {
    const base = { houseId, entryDate: '2026-09-24', amountPaid: 30000 };
    const oct06 = refund(Object.assign({ exitDate: '2026-10-06' }, base));   // stay day 13
    assert.strictEqual(oct06.ruleVersion, 1, houseId);
    assert.strictEqual(oct06.rule, 'detox_prorata', houseId);
    assert.strictEqual(oct06.refund, 17000, houseId);
    const oct07 = refund(Object.assign({ exitDate: '2026-10-07' }, base));   // stay day 14
    assert.strictEqual(oct07.ruleVersion, 2, houseId);
    assert.strictEqual(oct07.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(oct07.refund, 0, houseId);
  }
});

test('v1 is kept as it was for exits before 07/10 — every house, day 13 / day 14 / last 7 days', () => {
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
    const base = { houseId, entryDate: '2026-09-25', exitDate: '2026-10-20', amountPaid: 30000 };
    const cur = refund(Object.assign({ cycleStart: '2026-09-25' }, base));
    assert.strictEqual(cur.stayDay, 26, houseId);
    assert.strictEqual(cur.rule, 'stay_day14_zero', houseId);
    assert.strictEqual(cur.refund, 0, houseId);
    const next = refund(Object.assign({ cycleStart: '2026-10-25' }, base));
    assert.strictEqual(next.rule, 'prepaid_return', houseId);
    assert.strictEqual(next.refund, 30000, houseId);
    // a short stay (day 13) with the next month prepaid: pro-rata now + the prepaid month in full
    const short = { houseId, entryDate: '2026-10-08', exitDate: '2026-10-20', amountPaid: 30000 };
    assert.strictEqual(refund(Object.assign({ cycleStart: '2026-10-08' }, short)).refund, 18000, houseId);
    assert.strictEqual(refund(Object.assign({ cycleStart: '2026-11-08' }, short)).refund, 30000, houseId);
  }
  const used = refund({ houseId: 'asher', entryDate: '2026-08-01', exitDate: '2026-10-10', cycleStart: '2026-08-01', amountPaid: 30000 });
  assert.strictEqual(used.rule, 'cycle_fully_used');
  assert.strictEqual(used.refund, 0);
});

test('payout timing unchanged under v2: decided on the 10th → the 15th; the 11th → the next 15th', () => {
  const base = { houseId: 'asher', entryDate: '2026-10-01', exitDate: '2026-10-05', amountPaid: 30000 };
  assert.strictEqual(refundWith(gs, Object.assign({}, base, { decidedDate: '2026-11-10' })).payoutDate, '2026-11-15');
  assert.strictEqual(refundWith(gs, Object.assign({}, base, { decidedDate: '2026-11-11' })).payoutDate, '2026-12-15');
});

test('no override parameter under v2 either: exception fields in the input are ignored (Sandra-only, server-side)', () => {
  const r = refund({ houseId: 'ramot', entryDate: '2026-10-01', exitDate: '2026-10-20', amountPaid: 30000,
    refund: 9999, override: true, exceptionApprovedBy: 'sandra', policyResult: 'eligible' });
  assert.strictEqual(r.refund, 0);
});

/* ======================= the live path: suggestions + forecast ======================= */

const KEY = 'ramot::דנה::2026-10-01';
const payRow = (over) => Object.assign({ id: 'pay::' + KEY + '::' + over.dueDate, patientId: KEY, amount: 30000, status: 'paid', amountPaid: 30000, balance: 0 }, over);

test('suggestRefunds (refundSuggestionsFor_) under v2: day 13 → eligible pro-rata line; day 14 → one zero line + the prepaid return', () => {
  const rows = [payRow({ dueDate: '2026-10-01' }), payRow({ dueDate: '2026-11-01' })];
  const d13 = plain(gs.suggest({ houseId: 'ramot', entryDate: '2026-10-01', exitDate: '2026-10-13', patientKey: KEY }, rows, '2026-10-14'));
  const du13 = d13.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(du13.basis.rule, 'stay_prorata');
  assert.strictEqual(du13.basis.eligible, true);
  assert.strictEqual(du13.basis.ruleVersion, 2);
  assert.strictEqual(du13.calculatedAmount, 18000);
  assert.strictEqual(d13.find((s) => s.creditType === 'prepaid_return').calculatedAmount, 30000);

  const d14 = plain(gs.suggest({ houseId: 'ramot', entryDate: '2026-10-01', exitDate: '2026-10-14', patientKey: KEY }, rows, '2026-10-14'));
  const du14 = d14.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(du14.basis.rule, 'stay_day14_zero');
  assert.strictEqual(du14.basis.eligible, false);
  assert.strictEqual(du14.calculatedAmount, 0);
  assert.strictEqual(d14.find((s) => s.creditType === 'prepaid_return').calculatedAmount, 30000);
});

test('refund forecast under v2: a day-13 exit is «ממתין להחלטה»; a day-14 exit is a zero by policy', () => {
  const pays = [payRow({ dueDate: '2026-10-01' })];
  const dis = (exit) => [{ id: 'd1', houseId: 'ramot', name: 'דנה', date: '2026-10-01', exitDate: exit, status: 'released', restored: '' }];
  const f13 = plain(gs.forecast(dis('2026-10-13'), [], pays, '2026-10-14'));
  assert.strictEqual(f13.awaiting_decision.total, 18000);
  assert.strictEqual(f13.awaiting_decision.byPayoutDate[0].rows[0].rule, 'stay_prorata');
  const f14 = plain(gs.forecast(dis('2026-10-14'), [], pays, '2026-10-14'));
  assert.strictEqual(f14.awaiting_decision.count, 0);
  assert.strictEqual(f14.zeroByPolicyCount, 1);
});

/* ======================= parity lib ↔ Code.gs ======================= */

function parityRun(L, G) {
  const diffs = [];
  const entries = ['2026-01-31', '2026-02-28', '2026-08-15', '2026-09-01', '2026-09-20', '2026-09-30', '2026-10-01', '2026-10-07', '2027-01-31'];
  for (const ft of ['residential', 'detox_dual']) {
    for (const entry of entries) {
      const e0 = Date.UTC(Number(entry.slice(0, 4)), Number(entry.slice(5, 7)) - 1, Number(entry.slice(8, 10)));
      for (let off = 0; off < 75; off++) {
        const exit = new Date(e0 + off * 86400000).toISOString().slice(0, 10);
        // The cycle that holds the exit, from computeRefund_ itself.
        const b = G.computeRefund({ houseId: ft === 'residential' ? 'asher' : 'rehab', entryDate: entry, exitDate: exit, amountPaid: 0, decidedDate: '2026-10-07' });
        const x = { facilityType: ft, entryDate: entry, exitDate: exit, cycleStart: b.cycleStart, cycleEnd: b.cycleEnd };
        const a = JSON.stringify(plain(L.currentCycleRule(x)));
        const g = JSON.stringify(plain(G.current(x)));
        if (a !== g) diffs.push(`${ft} ${entry}→${exit}: lib ${a} ≠ gs ${g}`);
        if (L.refundRuleVersion(exit) !== G.version(exit)) diffs.push(`version ${exit}`);
        if (b.rule !== plain(G.current(x)).rule) diffs.push(`computeRefund_ ${ft} ${entry}→${exit}: ${b.rule}`);
      }
    }
  }
  return diffs;
}

test('parity: lib/refund-rules.js and Code.gs give the same rule on a grid of entries × exits (both sides of 07/10), and computeRefund_ uses it', () => {
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

test('labels: the two v2 rules have Hebrew labels on screen and in the .xlsx; the v1 labels stay for older exits', () => {
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
  const v2 = refund({ houseId: 'ramot', entryDate: '2026-10-01', exitDate: '2026-10-14', amountPaid: 30000 });
  const html2 = app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v2));
  assert.match(html2, /יום שהייה ביציאה:<\/span> <span class="credit-bd-v">14</);
  assert.doesNotMatch(html2, /7 הימים האחרונים במחזור:/);
  assert.doesNotMatch(html2, /חודש החיוב ביציאה/);
  assert.match(html2, /יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי/);

  const v1 = refund({ houseId: 'ramot', entryDate: '2026-09-10', exitDate: '2026-10-02', amountPaid: 30000 });
  const html1 = app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v1));
  assert.match(html1, /7 הימים האחרונים במחזור:/);
  assert.doesNotMatch(html1, /יום שהייה ביציאה/, 'v1 residential shows the last-7-days window, not the stay day');
  const v1d = refund({ houseId: 'rehab', entryDate: '2026-09-25', exitDate: '2026-10-06', amountPaid: 30000 });
  assert.match(app.creditBreakdownHtml(Object.assign({ basisVersion: 2 }, v1d)), /יום שהייה ביציאה:/);
});

test('the «זיכויים» modal rule line names the rule that applies — by the exit date — and nothing without the rules file', () => {
  const v2 = app.refundPolicyNote('2026-10-07', 'residential');
  assert.match(v2, /יציאה מ־07\/10\/2026, כל הבתים/);
  assert.match(v2, /יציאה ביום השהייה ה־14 ומעלה \(יום הכניסה = יום 1, נספר גם מעבר לסוף החודש\) — ללא זיכוי על המחזור הנוכחי; יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי/);
  assert.match(v2, /מחזור ששולם מראש ומתחיל אחרי היציאה — החזר מלא/);
  assert.doesNotMatch(v2, /חודש החיוב/);
  assert.strictEqual(app.refundPolicyNote('2026-10-07', 'detox_dual'), v2, 'one rule for every house');
  assert.match(app.refundPolicyNote('2026-10-06', 'residential'), /לפני 07\/10\/2026, בית מאזן\): יציאה ב־7 הימים האחרונים/);
  assert.match(app.refundPolicyNote('2026-10-06', 'detox_dual'), /לפני 07\/10\/2026, גמילה \/ דואלי\): יציאה ביום שהייה 14 ומעלה/);
  assert.strictEqual(app.refundPolicyNote('', 'residential'), '');
  assert.strictEqual(loadApp(false).refundPolicyNote('2026-10-07', 'residential'), '', 'no RefundRules → no line, no throw');
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
    const r = refundWith(g, { houseId: 'asher', entryDate: '2026-09-20', exitDate: '2026-11-01', amountPaid: 30000 });
    return r.refund === 0 && r.rule === 'stay_day14_zero' ? '' : `second cycle ${r.rule} ${r.refund}`;
  },
  oct06vs07: (g) => {
    const b = { houseId: 'asher', entryDate: '2026-09-24', amountPaid: 30000 };
    const a = refundWith(g, Object.assign({ exitDate: '2026-10-06' }, b));
    const c = refundWith(g, Object.assign({ exitDate: '2026-10-07' }, b));
    return a.rule === 'residential_prorata' && a.refund === 17000 && c.rule === 'stay_day14_zero' && c.refund === 0 ? '' : `${a.rule} / ${c.rule}`;
  },
  prepaid: (g) => {
    const r = refundWith(g, { houseId: 'ramot', entryDate: '2026-09-25', exitDate: '2026-10-20', cycleStart: '2026-10-25', amountPaid: 30000 });
    return r.refund === 30000 ? '' : 'prepaid ' + r.refund;
  },
  eligible: (g) => {
    const rows = [payRow({ dueDate: '2026-10-01' })];
    const s = plain(g.suggest({ houseId: 'ramot', entryDate: '2026-10-01', exitDate: '2026-10-13', patientKey: KEY }, rows, '2026-10-14'));
    return s[0].basis.eligible === true ? '' : 'v2 pro-rata not eligible';
  },
  parity: (g) => (parityRun(lib, g).length === 0 ? '' : 'parity broken'),
};

test('mutation check: the real Code.gs passes every core check', () => {
  for (const [name, fn] of Object.entries(GS_CHECKS)) assert.strictEqual(fn(gs), '', name);
});

const GS_MUTANTS = [
  ['cutoff day 14 → 15', 'day13vs14', "rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'", "rule = stayDay > REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'"],
  ['effective date moved to 08/10', 'oct06vs07', "const REFUND_RULE_V2_FROM             = '2026-10-07';", "const REFUND_RULE_V2_FROM             = '2026-10-08';"],
  ['version compared with > (07/10 stays v1)', 'oct06vs07', 'return s >= REFUND_RULE_V2_FROM ? 2 : 1;', 'return s > REFUND_RULE_V2_FROM ? 2 : 1;'],
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

test('mutation check (lib): a lib whose cutoff drifts from Code.gs FAILS the parity check', () => {
  const from = "rule = stayDay >= REFUND_V2_NO_REFUND_FROM_DAY ? 'stay_day14_zero'";
  assert.strictEqual(LIB_SRC.split(from).length, 2);
  const mutant = loadLibBrowser(LIB_SRC.replace(from, from.replace('>=', '>')));
  assert.ok(parityRun(mutant, gs).length > 0, 'the mutant survived');
  const fromDate = "const REFUND_RULE_V2_FROM = '2026-10-07';";
  assert.strictEqual(LIB_SRC.split(fromDate).length, 2);
  assert.ok(parityRun(loadLibBrowser(LIB_SRC.replace(fromDate, "const REFUND_RULE_V2_FROM = '2026-10-06';")), gs).length > 0, 'date mutant survived');
});
