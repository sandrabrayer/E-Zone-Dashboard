/* Tests for the dashboard "הכנסות חודשיות" ex-VAT total in public/app.js.
 *
 * Same vm-sandbox approach as breakeven-revenue.test.js: app.js is a browser
 * global script (no module.exports, touches document/location at top level), so
 * we read the source, append an epilogue exposing the pure functions under
 * test, and evaluate it in a vm context with browser globals stubbed. No changes
 * to app.js are required.
 *
 * Focus: dashboardMonthlyRevenueExVat() must divide the VAT-inclusive `pay` sum
 * by VAT_RATE and round, and it must reconcile with the per-house ex-VAT
 * revenue (actualRevenuePerHouse / VAT_RATE) used by the נקודת איזון tab. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VAT_RATE = 1.18; // must match the constant in public/app.js

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setPatients(arr) { state.patients = arr; },
      dashboardMonthlyRevenueExVat,
      actualRevenuePerHouse,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object,
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

test('sums active pay and divides by VAT_RATE, rounded', () => {
  // 35400/1.18 = 30000, 23600/1.18 = 20000 -> total 50000 exactly.
  const total = app.dashboardMonthlyRevenueExVat([
    patient('arfoni', 35400),
    patient('ramot', 23600),
  ]);
  assert.strictEqual(total, 50000);
  // Guard: the VAT-inclusive sum would have been 59000.
  assert.notStrictEqual(total, 59000);
});

test('released patients are excluded', () => {
  const total = app.dashboardMonthlyRevenueExVat([
    patient('arfoni', 35400, 'active'),
    patient('ramot', 23600, 'trial'),      // non-released counts
    patient('asher', 999999, 'released'),  // excluded
  ]);
  assert.strictEqual(total, 50000);
});

test('missing / zero / non-numeric pay contributes 0', () => {
  const total = app.dashboardMonthlyRevenueExVat([
    patient('arfoni', 35400),
    patient('ramot', 0),
    patient('asher', undefined),
    patient('rehab', 'not-a-number'),
  ]);
  assert.strictEqual(total, 30000); // only the 35400 -> 30000
});

test('rounds a non-integer division', () => {
  // 10000/1.18 = 8474.57... -> rounds to 8475.
  assert.strictEqual(app.dashboardMonthlyRevenueExVat([patient('arfoni', 10000)]), 8475);
});

test('empty / missing input -> 0', () => {
  assert.strictEqual(app.dashboardMonthlyRevenueExVat([]), 0);
  assert.strictEqual(app.dashboardMonthlyRevenueExVat(undefined), 0);
});

test('reconciles with the per-house ex-VAT revenue (dashboard == sum of houses, pre-round)', () => {
  // The KPI must equal the ex-VAT sum of each house's raw revenue, so the main
  // dashboard and the נקודת איזון per-house rows reconcile.
  const patients = [
    patient('arfoni', 35400),
    patient('arfoni', 11800),
    patient('ramot', 23600),
    patient('asher', 17700),
    patient('rehab', 5900, 'released'), // excluded on both sides
  ];
  app.setPatients(patients);

  const dash = app.dashboardMonthlyRevenueExVat(patients);
  const houseIds = ['arfoni', 'rehab', 'asher', 'pardes', 'ramot', 'sde'];
  const perHouseExVatSum = houseIds
    .reduce((s, h) => s + app.actualRevenuePerHouse(h) / VAT_RATE, 0);

  // dashboard = round(totalPay/VAT); perHouseExVatSum = totalPay/VAT (unrounded).
  assert.strictEqual(dash, Math.round(perHouseExVatSum));
});
