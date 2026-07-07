/* Tests for the ex-VAT break-even logic in public/app.js.
 *
 * public/app.js is a browser global script (touches location/document at top
 * level, declares `state` + calc functions with const/function, no exports),
 * so we evaluate it in a vm sandbox with browser globals stubbed and an
 * appended epilogue that exposes the functions under test. Same approach as
 * breakeven-revenue.test.js — no changes to app.js are required. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VAT_RATE = 1.18; // must match the constant in public/app.js

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__test = {
      setPatients(arr) { state.patients = arr; },
      setBreakeven(be) { state.breakeven = be; },
      actualRevenuePerHouse,
      computeHouseMetrics,
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

function patient(houseId, pay, status = 'active') {
  return { houseId, pay, status };
}

const HOUSE = { id: 'arfoni', name: 'קיסריה עפרוני', capacity: 13 };

test('price and currentRevenue are divided by VAT_RATE before derived math', () => {
  app.setBreakeven({
    hqCost: 0,
    houses: { arfoni: { active: true, fixed: 100000, variable: 50000 } },
  });
  // 35400 / 1.18 = 30000 exactly — clean assertions.
  app.setPatients([patient('arfoni', 35400)]);

  const m = app.computeHouseMetrics(HOUSE);
  assert.strictEqual(m.price, 30000);
  assert.strictEqual(m.currentRevenue, 30000);
  // Guard: the VAT-inclusive figure would have been 35400.
  assert.notStrictEqual(m.currentRevenue, 35400);
  // currentPL follows from the ex-VAT revenue.
  assert.strictEqual(m.currentPL, 30000 - 150000);
});

test('marginPct = (currentPL / currentRevenue) * 100 on the ex-VAT basis', () => {
  app.setBreakeven({
    hqCost: 0,
    houses: { arfoni: { active: true, fixed: 10000, variable: 0 } },
  });
  // Two patients at 59000 (VAT-incl) → sum 118000 → ex-VAT 100000.
  app.setPatients([patient('arfoni', 59000), patient('arfoni', 59000)]);

  const m = app.computeHouseMetrics(HOUSE);
  assert.strictEqual(m.currentRevenue, 100000);
  assert.strictEqual(m.currentPL, 90000); // 100000 - 10000
  assert.strictEqual(m.marginPct, 90);    // 90000 / 100000 * 100
});

test('zero revenue yields a null margin (no divide-by-zero)', () => {
  app.setBreakeven({
    hqCost: 0,
    houses: { arfoni: { active: true, fixed: 100000, variable: 50000 } },
  });
  // No active patients: released ones are excluded, so revenue is 0.
  app.setPatients([patient('arfoni', 999999, 'released')]);

  const m = app.computeHouseMetrics(HOUSE);
  assert.strictEqual(m.currentRevenue, 0);
  assert.strictEqual(m.marginPct, null);
  // Price still falls back to the VAT-inclusive PRICE_FALLBACKS / VAT_RATE.
  assert.ok(Math.abs(m.price - 30000 / VAT_RATE) < 1e-9);
});

test('expenses above revenue give a negative margin', () => {
  app.setBreakeven({
    hqCost: 0,
    houses: { arfoni: { active: true, fixed: 100000, variable: 50000 } },
  });
  // 35400 ex-VAT = 30000 revenue vs 150000 expenses → PL -120000.
  app.setPatients([patient('arfoni', 35400)]);

  const m = app.computeHouseMetrics(HOUSE);
  assert.strictEqual(m.currentPL, -120000);
  assert.ok(m.marginPct < 0);
  assert.strictEqual(m.marginPct, -400); // -120000 / 30000 * 100
});
