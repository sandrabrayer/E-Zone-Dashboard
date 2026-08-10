/* Tests for the carry-row override editor (the reachability fix).
 *
 * Live bug: the due list only shows a patient on an exact day-of-month match
 * with the selected billing date, so most unpaid rows render as carry-forward
 * rows in יתרות פתוחות — where the PR-2 editor was gated off by
 * !isCarryForward. The override editor was effectively unreachable.
 *
 *   app.js — carry rows now render the amount (override-aware) with the ✏️/↩
 *            editor when the patient is REALLY matched
 *            (patientKey === payment.patientId); the original due date folds
 *            into the label line; an edit targets the RECORD's own month;
 *            orphaned payments (fallback pseudo-patient) get no editor; and
 *            the displayed carry amount/balance flow through the same
 *            override-aware applyBillingOverride path as everything else.
 *
 * Same vm-sandbox + fake-DOM approach as billing-override-ui.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c), remove: c => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: c => set.has(c),
  };
}
function fakeEl() {
  const el = {
    className: '', _html: '', dataset: {}, textContent: '', value: '', disabled: false,
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    classList: fakeClassList(), children: [],
    appendChild(c) { this.children.push(c); },
    remove() {}, addEventListener() {},
    _sub: {},
    querySelector(sel) { if (!this._sub[sel]) this._sub[sel] = fakeEl(); return this._sub[sel]; },
    querySelectorAll() { return []; },
  };
  return el;
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      buildBillingRow,
      applyBillingOverride,
      setSaveBillingOverride(fn)  { saveBillingOverride = fn; },
      setClearBillingOverride(fn) { clearBillingOverride = fn; },
    };
  `;
  const noop = () => {};
  const doc = {
    addEventListener: noop,
    getElementById: () => fakeEl(),
    createElement: () => fakeEl(),
    querySelectorAll: () => [],
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

const PATIENT = { houseId: 'ramot', name: 'מעיין', date: '2026-01-05', pay: 30000, status: 'active' };
const PID = 'ramot::מעיין::2026-01-05'; // patientKey(PATIENT)

/* An unpaid carry-forward record from June (its own month, not the selected one). */
function juneCarry(over) {
  return Object.assign({
    id: `pay::${PID}::2026-06-05`, patientId: PID, patientName: 'מעיין', houseId: 'ramot',
    dueDate: '2026-06-05', amount: 30000, status: 'unpaid', amountPaid: 0, balance: 30000,
  }, over || {});
}
const JUNE_OVR = { id: `ovr::${PID}::2026-06`, patientId: PID, month: '2026-06', amount: 4200, created: '2026-08-10' };

test('a matched unpaid carry row renders the editor, with the original date folded into the label', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const row = app.buildBillingRow(PATIENT, juneCarry(), '2026-06-05', true);
  assert.ok(row.innerHTML.includes('bill-amount-edit-btn'), 'pencil present on the carry row');
  assert.ok(row.innerHTML.includes('תאריך מקורי ·'), 'original due date kept in the label line');
  assert.ok(row.innerHTML.includes('30,000'), 'amount now shown on the carry row');
  assert.ok(row.className.includes('carry'), 'still styled as a carry row');
});

test('editing a carry row targets the RECORD\'s own month, not the selected billing date', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const calls = [];
  app.setSaveBillingOverride(async (patient, dueDateISO, v) => calls.push([dueDateISO, v]));
  // renderBillingOpenList passes the record's own dueDate as dueDateISO — build
  // the row exactly as it does.
  const row = app.buildBillingRow(PATIENT, juneCarry(), '2026-06-05', true);
  const input = row.querySelector('.bill-amount-input');
  input.value = '7777';
  const saveBtn = row.querySelector('.bill-amount-save');
  return Promise.resolve(saveBtn.onclick({ currentTarget: fakeEl() })).then(() => {
    assert.deepStrictEqual(Array.from(calls[0]), ['2026-06-05', 7777],
      'override write keyed to the June record, so monthKey resolves 2026-06');
  });
});

test('an ORPHANED carry row (patient not really matched) gets no editor', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  // findPatientForPayment's fallback pseudo-patient: name/house from the record
  // but no entry date → patientKey !== payment.patientId.
  const pseudo = { name: 'מעיין', houseId: 'ramot', pay: 30000, date: '', status: '' };
  const row = app.buildBillingRow(pseudo, juneCarry(), '2026-06-05', true);
  assert.ok(!row.innerHTML.includes('bill-amount-edit-btn'), 'no pencil for an orphan');
  assert.ok(!row.innerHTML.includes('bill-amount-clear-btn'), 'no clear for an orphan');
});

test('CONSISTENCY: an overridden carry month flows through applyBillingOverride into the row display', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [JUNE_OVR] });
  // renderBillingOpenList overlays before building the row — replicate that
  // exact path: overlay first, then build.
  const overlaid = app.applyBillingOverride(juneCarry(), [JUNE_OVR]);
  assert.strictEqual(overlaid.amount, 4200, 'overlay replaces the unpaid amount');
  assert.strictEqual(overlaid.balance, 4200, 'overlay recomputes the balance');
  const row = app.buildBillingRow(PATIENT, overlaid, overlaid.dueDate, true);
  const html = row.innerHTML;
  assert.ok(html.includes('4,200'), 'displayed amount AND יתרה show the effective amount');
  assert.ok(!html.includes('30,000'), 'the base amount is nowhere on the row');
  assert.ok(html.includes('מותאם'), 'the מותאם badge shows on the carry row');
  assert.ok(html.includes('bill-amount-clear-btn'), 'clear-to-base offered on the carry row');
});

test('paid carry rows remain non-editable history', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const paid = juneCarry({ status: 'partial', amountPaid: 10000, balance: 20000 });
  const row = app.buildBillingRow(PATIENT, paid, '2026-06-05', true);
  assert.ok(!row.innerHTML.includes('bill-amount-edit-btn'));
});
