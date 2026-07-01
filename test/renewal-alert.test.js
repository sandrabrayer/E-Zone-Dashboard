/* Tests for the dashboard renewal alert in public/app.js.
 *
 * Renewal date = the patient's NEXT entry-day-of-month billing occurrence —
 * the SAME schedule the גבייה tab (patientsDueOn / dayOfMonth) uses, NOT a
 * last-payment+1-month derivation. These tests pin: the renewal-date
 * computation, the 7-day window boundary, the zero-payment-history entry-date
 * fallback, and the paid/partial-vs-unpaid cycle-coverage suppression.
 *
 * public/app.js is a browser global script (no module.exports, touches
 * document/location at top level), so — exactly like the other suites — we read
 * the source, append an epilogue that closes over `state` + the functions under
 * test, and evaluate it in a vm sandbox with browser globals stubbed. This
 * exercises the REAL shipped functions, not a reimplementation. */

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

  const epilogue = `
    globalThis.__test = {
      setPatients(a) { state.patients = a; },
      setPayments(a) { state.payments = a; },
      renewalDateISO,
      daysBetween,
      patientsNeedingRenewal,
      paymentId,
      patientKey,
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

function patient(houseId, name, date, opts = {}) {
  return { houseId, name, date, pay: opts.pay ?? 30000, adv: opts.adv ?? 0,
           status: opts.status ?? 'active' };
}

/* ===== renewal-date computation ===== */

test('renewal date is this month when the billing day is still ahead', () => {
  assert.strictEqual(app.renewalDateISO('2026-01-20', '2026-06-05'), '2026-06-20');
});

test('renewal date rolls to next month when the billing day already passed', () => {
  assert.strictEqual(app.renewalDateISO('2026-01-03', '2026-06-05'), '2026-07-03');
});

test('renewal date is today when today IS the billing day', () => {
  assert.strictEqual(app.renewalDateISO('2026-01-10', '2026-06-10'), '2026-06-10');
});

test('entry day 31 clamps to the last day of a short month', () => {
  assert.strictEqual(app.renewalDateISO('2026-01-31', '2026-02-01'), '2026-02-28');
});

test('renewal date rolls across a year boundary', () => {
  assert.strictEqual(app.renewalDateISO('2025-01-15', '2026-12-20'), '2027-01-15');
});

test('unusable entry date yields empty string', () => {
  assert.strictEqual(app.renewalDateISO('', '2026-06-01'), '');
});

/* ===== 7-day window boundary ===== */

test('daysBetween counts whole calendar days', () => {
  assert.strictEqual(app.daysBetween('2026-06-01', '2026-06-08'), 7);  // exactly 7
  assert.strictEqual(app.daysBetween('2026-06-01', '2026-06-09'), 8);  // 8 — out
  assert.strictEqual(app.daysBetween('2026-06-01', '2026-06-01'), 0);  // today
  assert.strictEqual(app.daysBetween('2026-06-08', '2026-06-01'), -7); // past — negative
});

test('window includes exactly-7-days and today, excludes 8-days-out', () => {
  app.setPayments([]);
  app.setPatients([
    patient('arfoni', 'שבעה',  '2026-01-08'), // → 2026-06-08, 7 days  → IN
    patient('rehab',  'שמונה', '2026-03-09'), // → 2026-06-09, 8 days  → OUT
    patient('asher',  'היום',  '2026-02-01'), // → 2026-06-01, 0 days  → IN
  ]);
  const list = app.patientsNeedingRenewal('2026-06-01', 7);
  // Copy into a test-realm array — list comes from the vm sandbox, so its
  // Array prototype differs and deepStrictEqual would reject it cross-realm.
  const names = Array.from(list.map(r => r.patient.name));
  assert.deepStrictEqual(names, ['היום', 'שבעה']); // sorted by renewal date
  assert.strictEqual(list.find(r => r.patient.name === 'שבעה').days, 7);
  assert.strictEqual(list.find(r => r.patient.name === 'היום').days, 0);
  assert.ok(!names.includes('שמונה'));
});

test('a billing day already passed this month is not in the upcoming window', () => {
  app.setPayments([]);
  // Entry day 1, today June 5 → next occurrence is July 1 (26 days out).
  app.setPatients([patient('arfoni', 'עבר', '2026-02-01')]);
  const list = app.patientsNeedingRenewal('2026-06-05', 7);
  assert.strictEqual(list.length, 0);
});

test('released patients are excluded even when due in the window', () => {
  app.setPayments([]);
  app.setPatients([
    patient('arfoni', 'משוחרר', '2026-01-04', { status: 'released' }), // 2026-06-04
  ]);
  const list = app.patientsNeedingRenewal('2026-06-01', 7);
  assert.strictEqual(list.length, 0);
});

/* ===== zero payment-history entry-date fallback ===== */

test('a patient with no payment history still appears (anchored on entry date)', () => {
  app.setPayments([]); // no payments at all
  app.setPatients([patient('ramot', 'חדש', '2026-05-10')]); // → 2026-06-10
  const list = app.patientsNeedingRenewal('2026-06-05', 7);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].renewalISO, '2026-06-10');
  assert.strictEqual(list[0].days, 5);
});

/* ===== paid / partial vs unpaid cycle coverage ===== */

function withCoverage(status) {
  const p = patient('arfoni', 'דנה', '2026-01-10'); // → 2026-06-10
  const due = '2026-06-10';
  const payments = status
    ? [{ id: app.paymentId(p, due), patientId: app.patientKey(p), dueDate: due, status }]
    : [];
  app.setPatients([p]);
  app.setPayments(payments);
  return app.patientsNeedingRenewal('2026-06-05', 7);
}

test('no payment for the cycle → patient is alerted', () => {
  assert.strictEqual(withCoverage(null).length, 1);
});

test('paid payment for the cycle suppresses the alert', () => {
  assert.strictEqual(withCoverage('paid').length, 0);
});

test('partial payment for the cycle suppresses the alert', () => {
  assert.strictEqual(withCoverage('partial').length, 0);
});

test('unpaid placeholder does NOT suppress the alert', () => {
  assert.strictEqual(withCoverage('unpaid').length, 1);
});

test('a paid payment for a DIFFERENT cycle does not suppress the upcoming one', () => {
  const p = patient('arfoni', 'דנה', '2026-01-10'); // upcoming → 2026-06-10
  app.setPatients([p]);
  // Last month's cycle (2026-05-10) is paid; the upcoming 2026-06-10 is not.
  app.setPayments([
    { id: app.paymentId(p, '2026-05-10'), patientId: app.patientKey(p),
      dueDate: '2026-05-10', status: 'paid' },
  ]);
  const list = app.patientsNeedingRenewal('2026-06-05', 7);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].renewalISO, '2026-06-10');
});

/* ===== renew-button success confirmation (showToast) =====
 *
 * renewPatient touches the DOM (renderDashboard) and the network (apiPost via
 * savePayment), so unlike the pure-function suite above we load a SECOND
 * sandbox whose epilogue overrides those side-effecting globals: renders become
 * no-ops, apiPost is a controllable resolve/reject, and showToast is a spy that
 * records its message. This exercises the REAL renewPatient + savePayment path,
 * including savePayment's own rollback-on-failure, and pins that the success
 * toast fires only when the paid record survives the round-trip. */
function loadRenew() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__toasts = [];
    globalThis.__apiShouldFail = false;
    state.mode = 'edit';
    // Silence side effects so we isolate the toast decision. savePayment calls
    // renderBillingMonthlySummary (and, on rollback, renderBilling + showError);
    // renewPatient calls renderDashboard. apiPost is the persistence round-trip.
    showToast = (m) => { globalThis.__toasts.push(m); };
    showError = () => {};
    renderDashboard = () => {};
    renderBilling = () => {};
    renderBillingMonthlySummary = () => {};
    apiPost = async () => {
      if (globalThis.__apiShouldFail) throw new Error('save failed');
      return {};
    };
    globalThis.__renew = {
      setPatients(a) { state.patients = a; },
      setPayments(a) { state.payments = a; },
      getPayments() { return state.payments; },
      setApiFail(v) { globalThis.__apiShouldFail = v; },
      resetToasts() { globalThis.__toasts = []; },
      getToasts() { return globalThis.__toasts; },
      renewPatient,
      renewalDateISO,
      paymentId,
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Promise, setTimeout,
    Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__renew;
}

const renew = loadRenew();
// Let the sandbox's microtask chain settle: renewPatient schedules a
// Promise.resolve(savePayment()).then(...), and savePayment awaits apiPost.
const flush = () => new Promise(r => setTimeout(r, 0));

test('renew fires a success toast when the paid payment survives the save', async () => {
  renew.setApiFail(false);
  renew.resetToasts();
  const p = patient('arfoni', 'דנה', '2026-01-10'); // → 2026-06-10
  renew.setPatients([p]);
  renew.setPayments([]);
  const due = renew.renewalDateISO(p.date, '2026-06-05');

  renew.renewPatient(p, due);
  await flush();
  await flush();

  const toasts = renew.getToasts();
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0], `חידוש נרשם — ${p.name}`);
  // The paid record persisted.
  const pays = renew.getPayments();
  assert.strictEqual(pays.length, 1);
  assert.strictEqual(pays[0].status, 'paid');
});

test('renew does NOT toast when the save fails and the payment is rolled back', async () => {
  renew.setApiFail(true);
  renew.resetToasts();
  const p = patient('arfoni', 'דנה', '2026-01-10'); // → 2026-06-10
  renew.setPatients([p]);
  renew.setPayments([]);
  const due = renew.renewalDateISO(p.date, '2026-06-05');

  renew.renewPatient(p, due);
  await flush();
  await flush();

  // No confirmation, and savePayment rolled the optimistic insert back out.
  assert.strictEqual(renew.getToasts().length, 0);
  assert.strictEqual(renew.getPayments().length, 0);

  renew.setApiFail(false); // restore for any later cases
});
