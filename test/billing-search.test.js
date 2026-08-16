/* Tests for the גבייה (billing) tab search:
 *   - billingRowMatchesQuery — the pure per-row matcher. Delegates to the
 *     shared core dischargedPatientMatchesQuery (name + house label by
 *     lowercased substring, phone raw OR normalized digits via normalizePhone),
 *     consulting BOTH the patient object (may be findPatientForPayment's
 *     fallback pseudo-patient) and the payment record for name/house, with
 *     house-label resolution mirroring buildBillingRow.
 *
 * Same vm-sandbox approach as discharged-search.test.js: app.js is a
 * browser-global script, so we read the source, append an epilogue exposing
 * the pure functions, and evaluate it in a vm context with browser globals
 * stubbed. No changes to app.js are needed for testability. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      billingRowMatchesQuery,
      dischargedPatientMatchesQuery,
      normalizePhone,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

// A billing row as renderBilling builds it: a patient object + a payment
// record. The input handler lowercases+trims the query, so tests pass queries
// the same way the live call site does.
function patient(over) {
  return Object.assign({ name: '', phone: '', houseId: '' }, over || {});
}
function payment(over) {
  return Object.assign({ patientName: '', houseId: '', status: 'unpaid' }, over || {});
}

/* ===== empty query ===== */

test('empty query matches everything', () => {
  assert.strictEqual(app.billingRowMatchesQuery(patient(), payment(), ''), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ name: 'דוד' }), payment(), null), true);
  assert.strictEqual(app.billingRowMatchesQuery(null, null, ''), true);
});

/* ===== name match ===== */

test('name matches from the patient object, case-insensitive substring', () => {
  assert.strictEqual(app.billingRowMatchesQuery(patient({ name: 'דניאל כהן' }), payment(), 'דני'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ name: 'David Levi' }), payment(), 'david'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ name: 'דניאל' }), payment(), 'משהו'), false);
});

test('name falls back to payment.patientName (orphaned carry-forward row)', () => {
  // findPatientForPayment miss → pseudo-patient may carry the name; but even a
  // null patient must match on the payment record's own name.
  assert.strictEqual(app.billingRowMatchesQuery(null, payment({ patientName: 'רות אלמוג' }), 'רות'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ name: '' }), payment({ patientName: 'רות אלמוג' }), 'אלמוג'), true);
});

/* ===== phone match (via normalizePhone) ===== */

test('phone matches across formatting via normalizePhone when present', () => {
  assert.strictEqual(app.billingRowMatchesQuery(patient({ phone: '050-111-2222' }), payment(), '0501112222'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ phone: '0501112222' }), payment(), '+972-50-111-2222'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ phone: '050-111-2222' }), payment(), '050-111'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ phone: '050-111-2222' }), payment(), '0539999999'), false);
});

/* ===== house match ===== */

test('house matches by the displayed house name, resolved from payment.houseId first', () => {
  // buildBillingRow resolves payment.houseId before patient.houseId — mirror it.
  assert.strictEqual(app.billingRowMatchesQuery(patient(), payment({ houseId: 'arfoni' }), 'עפרוני'), true);
  assert.strictEqual(app.billingRowMatchesQuery(patient({ houseId: 'rehab' }), payment(), 'ריהאב'), true);
});

test('unresolved house falls back to the raw patient.houseId text', () => {
  assert.strictEqual(app.billingRowMatchesQuery(patient({ houseId: 'old-house-7' }), payment(), 'old-house'), true);
});

/* ===== no match / null safety ===== */

test('no field matches → false', () => {
  const row = [patient({ name: 'דוד', phone: '050-111-2222', houseId: 'arfoni' }), payment({ houseId: 'arfoni' })];
  assert.strictEqual(app.billingRowMatchesQuery(row[0], row[1], 'זזזזז'), false);
  assert.strictEqual(app.billingRowMatchesQuery(row[0], row[1], '0399999'), false);
});

test('nullish patient and payment never throw', () => {
  assert.strictEqual(app.billingRowMatchesQuery(null, null, 'x'), false);
  assert.strictEqual(app.billingRowMatchesQuery(undefined, payment(), 'x'), false);
});
