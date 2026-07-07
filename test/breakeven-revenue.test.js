/* Tests for actual-revenue break-even logic in public/app.js.
 *
 * public/app.js is a browser global script: it touches `location`/`document`
 * at top level and declares `state` + the calc functions with `const`/function
 * declarations (no module.exports). So we can't `require` it directly.
 *
 * Instead we read the source, append a tiny in-sandbox epilogue that exposes
 * the bits we need (function declarations are reachable in a vm script, but the
 * `const state` is not — the epilogue closes over it lexically), and evaluate
 * it all in a vm context with the browser globals stubbed. No changes to
 * app.js are required for this. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  // Appended to the same script so it shares lexical scope with `state` and the
  // calc functions. Exposes a setter + the functions under test on globalThis.
  const epilogue = `
    globalThis.__test = {
      setPatients(arr) { state.patients = arr; },
      setBreakeven(be) { state.breakeven = be; },
      actualRevenuePerHouse,
      computeHouseMetrics,
      computeNetworkMetrics,
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

// Break-even metrics reason about revenue ex-VAT (pay is stored VAT-inclusive).
// Must match VAT_RATE in public/app.js. actualRevenuePerHouse itself stays
// VAT-inclusive — only computeHouseMetrics / network roll-ups divide.
const VAT_RATE = 1.18;

// Cross-order floating arithmetic (dividing per house, then summing) can differ
// from the implementation's summation by a ULP, so compare with a tolerance.
function approx(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-6, msg || `${actual} ≈ ${expected}`);
}

function patient(houseId, pay, status = 'active') {
  return { houseId, pay, status };
}

test('mixed pay values are summed, not averaged', () => {
  app.setPatients([
    patient('arfoni', 30000),
    patient('arfoni', 40000),
    patient('arfoni', 50000),
  ]);
  // Sum is 120000. An averaging implementation would yield 40000 (the mean)
  // or 40000 * 3 = 120000 only by coincidence — so also assert a non-uniform
  // set below where mean * count != sum is impossible to confuse.
  assert.strictEqual(app.actualRevenuePerHouse('arfoni'), 120000);
});

test('mixed pay where averaging would visibly differ', () => {
  // mean = (10000 + 90000) / 2 = 50000; sum = 100000. Both equal here, so add
  // a third to break it: mean of [10000, 90000, 5000] = 35000, sum = 105000.
  app.setPatients([
    patient('arfoni', 10000),
    patient('arfoni', 90000),
    patient('arfoni', 5000),
  ]);
  const sum = app.actualRevenuePerHouse('arfoni');
  assert.strictEqual(sum, 105000);
  assert.notStrictEqual(sum, 35000); // would be the averaged value
});

test('released patients are excluded from the sum', () => {
  app.setPatients([
    patient('arfoni', 30000, 'active'),
    patient('arfoni', 40000, 'trial'),
    patient('arfoni', 999999, 'released'),
  ]);
  assert.strictEqual(app.actualRevenuePerHouse('arfoni'), 70000);
});

test('active patient with pay 0 counts and contributes 0', () => {
  app.setPatients([
    patient('arfoni', 0, 'active'),
    patient('arfoni', 30000, 'active'),
  ]);
  assert.strictEqual(app.actualRevenuePerHouse('arfoni'), 30000);
});

test('empty house sums to 0', () => {
  app.setPatients([
    patient('ramot', 50000, 'active'),
  ]);
  assert.strictEqual(app.actualRevenuePerHouse('arfoni'), 0);
});

test('no patients at all sums to 0', () => {
  app.setPatients([]);
  assert.strictEqual(app.actualRevenuePerHouse('arfoni'), 0);
});

test('computeHouseMetrics.currentRevenue uses the actual sum', () => {
  app.setBreakeven({
    hqCost: 0,
    houses: { arfoni: { active: true, fixed: 100000, variable: 50000 } },
  });
  app.setPatients([
    patient('arfoni', 30000),
    patient('arfoni', 45000),
    patient('arfoni', 999999, 'released'), // excluded
  ]);
  const m = app.computeHouseMetrics({ id: 'arfoni', name: 'x', capacity: 13 });
  // currentRevenue is the actual sum (30000 + 45000 = 75000) net of VAT.
  assert.strictEqual(m.currentRevenue, 75000 / VAT_RATE);
  assert.strictEqual(m.currentPL, 75000 / VAT_RATE - 150000); // revenue - (fixed+variable)
});

test('computeNetworkMetrics rolls up the actual per-house revenue', () => {
  app.setBreakeven({
    hqCost: 10000,
    houses: {
      arfoni: { active: true, fixed: 100000, variable: 50000 },
      ramot:  { active: true, fixed: 200000, variable: 100000 },
    },
  });
  app.setPatients([
    patient('arfoni', 30000),
    patient('arfoni', 45000),
    patient('ramot', 60000),
    patient('ramot', 20000, 'released'), // excluded
  ]);
  const ms = [
    app.computeHouseMetrics({ id: 'arfoni', name: 'a', capacity: 13 }),
    app.computeHouseMetrics({ id: 'ramot', name: 'r', capacity: 20 }),
  ];
  const net = app.computeNetworkMetrics(ms);
  // arfoni 75000 + ramot 60000 = 135000 gross → ex-VAT via per-house division.
  const expRevenue = 75000 / VAT_RATE + 60000 / VAT_RATE;
  approx(net.totalRevenueCurrent, expRevenue);
  // expenses: 150000 + 300000 + hq 10000 = 460000
  approx(net.networkPL, expRevenue - 460000);
});

test('computeNetworkMetrics.housesPL sums per-house currentPL and excludes hqCost', () => {
  app.setBreakeven({
    hqCost: 10000,
    houses: {
      arfoni: { active: true, fixed: 100000, variable: 50000 },
      ramot:  { active: true, fixed: 200000, variable: 100000 },
    },
  });
  app.setPatients([
    patient('arfoni', 30000),
    patient('arfoni', 45000),
    patient('ramot', 60000),
    patient('ramot', 20000, 'released'), // excluded
  ]);
  const ms = [
    app.computeHouseMetrics({ id: 'arfoni', name: 'a', capacity: 13 }),
    app.computeHouseMetrics({ id: 'ramot', name: 'r', capacity: 20 }),
  ];
  const net = app.computeNetworkMetrics(ms);
  // Ex-VAT: arfoni currentPL = 75000/1.18 - 150000; ramot = 60000/1.18 - 300000.
  const expectedHousesPL = ms.reduce((s, m) => s + m.currentPL, 0);
  approx(expectedHousesPL, 135000 / VAT_RATE - 450000);
  approx(net.housesPL, expectedHousesPL);
  // housesPL must NOT include the 10000 hqCost — networkPL does.
  approx(net.housesPL, net.networkPL + net.hqCost);
  assert.notStrictEqual(net.housesPL, net.networkPL);
});
