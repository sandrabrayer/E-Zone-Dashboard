'use strict';

/* public/revenue-engine.js — the «הכנסות חודשיות» engine, GENERATED verbatim from
 * public/app.js so the CRM page computes the classic tab's figures
 * (CHANGELOG-revenue-engine-shared.md). Guards:
 *   1. the checked-in file is exactly what scripts/build-revenue-engine.js
 *      produces from today's app.js (an app.js rule change without a re-run fails);
 *   2. PARITY: on the same raw getData / getPayments / getCredits answers the
 *      engine's month equals app.js's own normalise + buildMonthlyRevenue;
 *   3. it is self-contained (a bare browser-like context, no DOM, no `state`).
 * Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const gen = require('../scripts/build-revenue-engine.js');
const APP = fs.readFileSync(gen.APP_PATH, 'utf8');
const ENGINE_SRC = fs.readFileSync(gen.OUT_PATH, 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'billing-control-rules.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/* The engine as a BROWSER script: a bare context — no document, no window, no state. */
function loadEngine() {
  const sb = { console: { log() {}, warn() {}, error() {} } };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(RULES_SRC.replace(/module\.exports\s*=/, 'globalThis.__rules ='), sb);
  if (sb.__rules) sb.BillingControlRules = sb.__rules;
  vm.runInContext(ENGINE_SRC, sb);
  return sb;
}
/* app.js itself (the classic page's script) with its own normalisers + engine. */
function loadApp() {
  const noop = () => {};
  const sb = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(RULES_SRC.replace(/module\.exports\s*=/, 'globalThis.__rules ='), sb);
  if (sb.__rules) sb.BillingControlRules = sb.__rules;
  vm.runInContext(APP + `
    globalThis.__classicMonth = function (o) {
      const ps = paymentsStateFrom(o.payments);
      state.patients = parsePatients(o.data.patients);
      const overrides = (o.data.billingOverrides || []).map(normalizeBillingOverride).filter(x => x.patientId && x.month);
      const credits = (o.credits.credits || []).map(normalizeCredit).filter(c => c.id);
      return buildMonthlyRevenue({ month: o.month, patients: state.patients, payments: ps.payments, credits: credits,
        overrides: overrides, receipts: ps.receipts, today: o.today });
    };`, sb);
  return sb;
}

const K = (house, name, date) => house + '::' + name + '::' + date;
const RAW = {
  today: '2026-11-11',
  data: {
    patients: {
      ramot: [
        { id: 'u-1', name: 'דנה כהן', date: '2026-08-20', pay: 30000, status: 'active' },
        { id: 'u-2', name: 'גל רון', date: '2026-07-05', pay: 41300, status: 'released', exitDate: '2026-10-12T21:00:00.000Z' },
        { id: 'u-3', name: 'נוי שי', date: '2026-10-28', pay: 35000, status: 'trial' }],
      asher: [{ id: 'u-4', name: 'אבי רז', date: '2026-09-01', pay: 20000, status: 'active' }],
      raanana: [{ id: 'u-5', name: 'טל לב', date: '2026-10-15', pay: 28000, status: 'active' }],   // legacy house id
    },
    billingOverrides: [{ id: 'o-1', patientId: K('asher', 'אבי רז', '2026-09-01'), month: '2026-10', amount: 15000, reason: 'הנחה' }, { patientId: '', month: '2026-10', amount: 1 }],
  },
  payments: {
    payments: [
      { id: 'pay-1', patientId: K('ramot', 'דנה כהן', '2026-08-20'), patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-09-20', amount: 30000, amountPaid: 30000, status: 'paid' },
      { id: 'pay-2', patientId: K('ramot', 'דנה כהן', '2026-08-20'), patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-10-20', amount: 30000, amountPaid: 12000, status: 'partial' },
      { id: 'pay-3', patientId: K('ramot', 'גל רון', '2026-07-05'), patientName: 'גל רון', houseId: 'ramot', dueDate: '2026-10-05', amount: 41300, amountPaid: 41300, status: 'paid', coverageStart: '2026-10-05', coverageEnd: '2026-10-12' },
      { id: 'pay-4', patientId: K('ramot', 'גל רון', '2026-07-05'), patientName: 'גל רון', houseId: 'ramot', dueDate: '2026-10-05', amount: 41300, amountPaid: 41300, status: 'void' },
      { id: 'pay-5', patientId: K('asher', 'אבי רז', '2026-09-01'), patientName: 'אבי רז', houseId: 'asher', dueDate: '2026-10-01T21:00:00.000Z', amount: 20000, amountPaid: 0, status: 'unpaid' },
      { id: '', patientId: 'x', dueDate: '2026-10-01', amount: 5 }],
    receipts: [
      { id: 'rc-1', cycleId: 'pay-1', patientId: K('ramot', 'דנה כהן', '2026-08-20'), patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-09-20', amount: 30000, status: 'paid', receivedDate: '2026-09-21', confirmStatus: 'confirmed' },
      { id: 'rc-2', cycleId: 'pay-2', patientId: K('ramot', 'דנה כהן', '2026-08-20'), patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-10-20', amount: 12000, status: 'partial', receivedDate: '2026-10-22', confirmStatus: 'partial', confirmedAmount: 9000 }],
    funders: [{ patientId: 'u-1', funder: 'פרטי', effectiveFrom: '2026-08-20' }],
  },
  credits: { credits: [
    { id: 'cr-1', patientId: K('ramot', 'גל רון', '2026-07-05'), patientName: 'גל רון', houseId: 'ramot', creditType: 'days_unused', allocationMonth: '2026-10', amount: 6000, status: 'pending',
      basis: JSON.stringify({ creditedFrom: '2026-10-13', coverageEnd: '2026-11-04' }) },
    { id: 'cr-2', patientName: 'בוטל', houseId: 'asher', creditType: 'other', allocationMonth: '2026-10', amount: 999, status: 'cancelled' }] },
};

test('the checked-in public/revenue-engine.js is exactly what the script generates from app.js', () => {
  assert.equal(ENGINE_SRC, gen.generate(APP), 'stale — run: node scripts/build-revenue-engine.js');
  assert.match(ENGINE_SRC, /^\/\* GENERATED by scripts\/build-revenue-engine\.js from public\/app\.js — DO NOT EDIT\./);
});

test('every listed declaration is copied verbatim, once; a missing or duplicated one is an error, never a guess', () => {
  const lines = APP.split('\n');
  assert.equal(new Set(gen.NAMES).size, gen.NAMES.length);
  for (const n of gen.NAMES) {
    const text = gen.slice(lines, n)[1];
    assert.ok(APP.includes(text) && ENGINE_SRC.includes(text), n);
  }
  assert.throws(() => gen.slice(lines, 'noSuchDeclaration__'), /declared 0 times/);
  assert.throws(() => gen.slice(['function a() {', '}', 'function a() {', '}'], 'a'), /declared 2 times/);
  assert.throws(() => gen.slice(['function a() {', '  x();', 'const b = 1;'], 'a'), /cannot find the end/);
});

test('PARITY: the engine answers exactly what app.js answers, month after month, on the same raw answers', () => {
  const eng = loadEngine().RevenueEngine;
  const app = loadApp();
  let moved = 0;
  for (const month of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) {
    const o = Object.assign({ month }, RAW);
    const a = plain(app.__classicMonth(o)), e = plain(eng.monthModel(o));
    assert.deepEqual(e, a, month);
    moved += a.received.inclVat + a.expected.inclVat + a.credits.inclVat;
  }
  const oct = plain(eng.monthModel(Object.assign({ month: '2026-10' }, RAW)));
  assert.ok(oct.received.exVat > 0 && oct.expected.exVat > 0 && oct.credits.exVat > 0 && oct.verified && oct.verified.exVat > 0, 'the fixture exercises received / expected / credits / verified');
  assert.ok(oct.byHouse.length >= 2);
  assert.ok(moved > 0);
});

test('a bad month → null; empty / missing answers → a zero month, never a throw', () => {
  const eng = loadEngine().RevenueEngine;
  for (const m of ['', '2026-13', '11/2026', null, undefined]) assert.equal(eng.monthModel(Object.assign({}, RAW, { month: m })), null);
  const z = plain(eng.monthModel({ month: '2026-10', today: '2026-11-11' }));
  assert.deepEqual([z.received.inclVat, z.expected.inclVat, z.credits.inclVat, z.net.inclVat], [0, 0, 0, 0]);
  assert.equal(eng.isMonthKey('2026-10'), true);
  assert.equal(eng.revenueShiftMonth('2026-01', -1), '2025-12');
  assert.match(eng.revenueMonthLabel('2026-10'), /2026/);
});

test('self-contained: a browser script that defines only RevenueEngine; a Node module too; no DOM, no network, no storage', () => {
  const sb = loadEngine();
  assert.deepEqual(Object.keys(sb.RevenueEngine).sort(), ['VAT_RATE', 'buildMonthlyRevenue', 'inputsFrom', 'isMonthKey', 'monthModel', 'revenueMonthLabel', 'revenueShiftMonth']);
  assert.equal(typeof sb.buildMonthlyRevenue, 'undefined', 'nothing else leaks to the page');
  assert.equal(typeof require('../public/revenue-engine.js').monthModel, 'function');
  for (const bad of [/\bdocument\./, /localStorage/, /\bfetch\(/, /XMLHttpRequest/, /\bwindow\.[A-Za-z_$]/]) assert.ok(!bad.test(ENGINE_SRC), String(bad));
});

test('PR scope: the classic page and app.js are untouched by this file (no page loads it yet)', () => {
  assert.ok(!fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').includes('revenue-engine.js'));
});
