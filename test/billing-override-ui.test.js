/* Tests for the billing per-month amount override UI (billing PR 2).
 *
 *   app.js — billingOverrideFor / applyBillingOverride (the overlay rule:
 *            unpaid amounts follow the month's override, paid/partial history
 *            never rewritten); paymentForPatientOnDate override-aware with
 *            month isolation; KPI aggregation (monthly summary) uses effective
 *            amounts; saveBillingOverride / clearBillingOverride optimistic +
 *            rollback; buildBillingRow renders the מותאם badge + edit controls
 *            only where they belong.
 *
 * Same vm-sandbox + fake-DOM approach as the other UI test files. */

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
      getState() { return state; },
      billingOverrideFor,
      applyBillingOverride,
      paymentForPatientOnDate,
      saveBillingOverride,
      clearBillingOverride,
      buildBillingRow,
      renderBillingMonthlySummary,
      setApiPost(fn)       { apiPost = fn; },
      setRenderBilling(fn) { renderBilling = fn; },
      setShowToast(fn)     { showToast = fn; },
      setShowError(fn)     { showError = fn; },
    };
  `;
  const noop = () => {};
  const byId = {};
  const doc = {
    addEventListener: noop,
    getElementById: (id) => { if (!byId[id]) byId[id] = fakeEl(); return byId[id]; },
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
  return { app: sandbox.__test, byId };
}

const { app, byId } = loadApp();

const PATIENT = { houseId: 'ramot', name: 'בעז', date: '2026-01-05', pay: 9000, status: 'active' };
const PID = 'ramot::בעז::2026-01-05'; // patientKey(patient)
const OVR_AUG = { id: `ovr::${PID}::2026-08`, patientId: PID, month: '2026-08', amount: 4200, created: '2026-08-10' };

function unpaidPayment(over) {
  return Object.assign({
    id: `pay::${PID}::2026-08-05`, patientId: PID, patientName: 'בעז', houseId: 'ramot',
    dueDate: '2026-08-05', amount: 9000, status: 'unpaid', amountPaid: 0, balance: 9000,
  }, over || {});
}

/* ===== the overlay rule ===== */

test('applyBillingOverride replaces an UNPAID amount and recomputes the balance', () => {
  const out = app.applyBillingOverride(unpaidPayment(), [OVR_AUG]);
  assert.strictEqual(out.amount, 4200);
  assert.strictEqual(out.balance, 4200);
  assert.strictEqual(out.status, 'unpaid');
});

test('applyBillingOverride NEVER rewrites paid/partial history', () => {
  const paid = unpaidPayment({ status: 'paid', amountPaid: 9000, balance: 0 });
  const partial = unpaidPayment({ status: 'partial', amountPaid: 3000, balance: 6000 });
  assert.strictEqual(app.applyBillingOverride(paid, [OVR_AUG]), paid, 'paid returned untouched');
  assert.strictEqual(app.applyBillingOverride(partial, [OVR_AUG]), partial, 'partial returned untouched');
});

test('applyBillingOverride is a no-op without a matching override', () => {
  const p = unpaidPayment();
  assert.strictEqual(app.applyBillingOverride(p, []), p);
  assert.strictEqual(app.applyBillingOverride(p, [{ ...OVR_AUG, month: '2026-09' }]), p);
});

/* ===== paymentForPatientOnDate: effective amount + month isolation ===== */

test('placeholder for the overridden month carries the override amount', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [OVR_AUG] });
  const aug = app.paymentForPatientOnDate(PATIENT, '2026-08-05');
  assert.strictEqual(aug.amount, 4200);
  assert.strictEqual(aug.balance, 4200);
});

test('month isolation: the override does NOT leak into another month', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [OVR_AUG] });
  const sep = app.paymentForPatientOnDate(PATIENT, '2026-09-05');
  assert.strictEqual(sep.amount, 9000, 'September stays at base pay');
  const jul = app.paymentForPatientOnDate(PATIENT, '2026-07-05');
  assert.strictEqual(jul.amount, 9000, 'July stays at base pay');
});

test('a persisted UNPAID record is overlaid too; clearing the override restores its stored amount', () => {
  app.setState({ mode: 'edit', payments: [unpaidPayment()], billingOverrides: [OVR_AUG] });
  assert.strictEqual(app.paymentForPatientOnDate(PATIENT, '2026-08-05').amount, 4200);
  app.setState({ billingOverrides: [] });
  assert.strictEqual(app.paymentForPatientOnDate(PATIENT, '2026-08-05').amount, 9000, 'base restored');
});

/* ===== KPI aggregation (monthly summary) ===== */

test('monthly summary outstanding uses the effective amount; collected untouched', () => {
  app.setState({
    mode: 'edit',
    billingOverrides: [OVR_AUG],
    payments: [
      unpaidPayment(), // 9000 base → 4200 effective
      unpaidPayment({ id: `pay::other::2026-08-10`, patientId: 'other', patientName: 'אחר',
                      dueDate: '2026-08-10', status: 'paid', amount: 5000, amountPaid: 5000, balance: 0 }),
    ],
  });
  app.renderBillingMonthlySummary('2026-08-15');
  assert.ok(byId['bill-month-outstanding'].textContent.includes('4,200'),
    `outstanding shows the override amount (got: ${byId['bill-month-outstanding'].textContent})`);
  assert.ok(byId['bill-month-collected'].textContent.includes('5,000'),
    'collected sums amountPaid, unaffected by the override');
});

/* ===== save / clear workers: optimistic + rollback ===== */

test('saveBillingOverride writes the upsert action and applies optimistically', async () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const posts = [];
  app.setApiPost(async (b) => { posts.push(b); });
  app.setRenderBilling(() => {});
  app.setShowToast(() => {});
  await app.saveBillingOverride({ patientId: PID, dueDate: '2026-08-05' }, 4200);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].action, 'upsertBillingOverride');
  assert.strictEqual(posts[0].override.patientId, PID);
  assert.strictEqual(posts[0].override.month, '2026-08');
  assert.strictEqual(posts[0].override.amount, 4200);
  assert.strictEqual(app.getState().billingOverrides.length, 1);
  // Re-saving the same month replaces, never duplicates.
  await app.saveBillingOverride({ patientId: PID, dueDate: '2026-08-20' }, 3900);
  assert.strictEqual(app.getState().billingOverrides.length, 1);
  assert.strictEqual(app.getState().billingOverrides[0].amount, 3900);
});

test('saveBillingOverride rolls back on failure', async () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const errors = [];
  app.setApiPost(async () => { throw new Error('נכשל'); });
  app.setRenderBilling(() => {});
  app.setShowError(m => errors.push(m));
  await app.saveBillingOverride({ patientId: PID, dueDate: '2026-08-05' }, 4200);
  assert.strictEqual(app.getState().billingOverrides.length, 0, 'optimistic write rolled back');
  assert.strictEqual(errors.length, 1);
});

test('clearBillingOverride deletes and restores base; rolls back on failure', async () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [{ ...OVR_AUG }] });
  const posts = [];
  app.setApiPost(async (b) => { posts.push(b); });
  app.setRenderBilling(() => {});
  app.setShowToast(() => {});
  await app.clearBillingOverride({ patientId: PID, dueDate: '2026-08-05' });
  assert.strictEqual(posts[0].action, 'deleteBillingOverride');
  assert.strictEqual(app.getState().billingOverrides.length, 0);
  assert.strictEqual(app.paymentForPatientOnDate(PATIENT, '2026-08-05').amount, 9000, 'base restored');

  // failure path
  app.setState({ billingOverrides: [{ ...OVR_AUG }] });
  app.setApiPost(async () => { throw new Error('x'); });
  app.setShowError(() => {});
  await app.clearBillingOverride({ patientId: PID, dueDate: '2026-08-05' });
  assert.strictEqual(app.getState().billingOverrides.length, 1, 'delete rolled back');
});

/* ===== row rendering ===== */

test('row shows the מותאם badge + clear control only when an override is active', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [OVR_AUG] });
  const withOvr = app.buildBillingRow(PATIENT, app.paymentForPatientOnDate(PATIENT, '2026-08-05'), '2026-08-05', false);
  assert.ok(withOvr.innerHTML.includes('מותאם'), 'badge shown');
  assert.ok(withOvr.innerHTML.includes('bill-amount-clear-btn'), 'clear control shown');
  assert.ok(withOvr.innerHTML.includes('4,200'), 'effective amount rendered');

  app.setState({ billingOverrides: [] });
  const without = app.buildBillingRow(PATIENT, app.paymentForPatientOnDate(PATIENT, '2026-08-05'), '2026-08-05', false);
  assert.ok(!without.innerHTML.includes('מותאם'), 'no badge without an override');
  assert.ok(without.innerHTML.includes('bill-amount-edit-btn'), 'edit pencil still offered');
});

test('paid rows offer no amount editing; carry rows with a matched patient DO (carry-edit fix)', () => {
  app.setState({ mode: 'edit', payments: [], billingOverrides: [] });
  const paidRow = app.buildBillingRow(
    PATIENT, unpaidPayment({ status: 'paid', amountPaid: 9000, balance: 0 }), '2026-08-05', false);
  assert.ok(!paidRow.innerHTML.includes('bill-amount-edit-btn'), 'paid history not editable');
  /* Changed by the carry-edit fix: an unpaid carry-forward row whose patient is
   * really matched now offers the editor (the original reachability gap made
   * the override editor unreachable for most unpaid rows). Deep coverage lives
   * in billing-override-carry-edit.test.js. */
  const carryRow = app.buildBillingRow(PATIENT, unpaidPayment(), '2026-08-05', true);
  assert.ok(carryRow.innerHTML.includes('bill-amount-edit-btn'), 'matched unpaid carry rows are editable now');
});
