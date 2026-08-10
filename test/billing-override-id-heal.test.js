/* Tests for the payment patientId heal + single-identity-source workers.
 *
 * Live bug: a due-list unpaid row showed no ✏️ because the persisted record's
 * patientId CELL was blank while its id was well-formed — the #81 guard's
 * strict `patientKey(patient) === payment.patientId` failed on live data that
 * tests always populated.
 *
 *   app.js — normalizePayment derives a blank patientId from the deterministic
 *            id (pay::<houseId>::<name>::<entryDate>::<dueDate>); due-list rows
 *            are matched by construction (!isCarryForward shortcut);
 *            saveBillingOverride / clearBillingOverride now read BOTH key parts
 *            (patientId + dueDate month) from the normalized payment record —
 *            the exact keys applyBillingOverride looks up with — so the
 *            save-key and the overlay lookup-key cannot diverge.
 *
 * Same vm-sandbox approach as billing-override-ui.test.js. */

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
      normalizePayment,
      paymentForPatientOnDate,
      applyBillingOverride,
      buildBillingRow,
      saveBillingOverride,
      clearBillingOverride,
      setApiPost(fn)       { apiPost = fn; },
      setRenderBilling(fn) { renderBilling = fn; },
      setShowToast(fn)     { showToast = fn; },
      setShowError(fn)     { showError = fn; },
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

const PATIENT = { houseId: 'rehab', name: 'מעיין אברהמי', date: '2026-02-10', pay: 30000, status: 'active' };
const PID = 'rehab::מעיין אברהמי::2026-02-10'; // patientKey(PATIENT)
const DUE = '2026-08-10';

/* A live-style persisted record: well-formed id, BLANK patientId cell. */
function blankIdRecord(over) {
  return Object.assign({
    id: `pay::${PID}::${DUE}`, patientId: '', patientName: 'מעיין אברהמי', houseId: 'rehab',
    dueDate: DUE, amount: 30000, status: 'לא שולם', amountPaid: 0, balance: 30000,
  }, over || {});
}

/* ===== the heal ===== */

test('normalizePayment derives a blank patientId from a well-formed id', () => {
  const out = app.normalizePayment(blankIdRecord());
  assert.strictEqual(out.patientId, PID, 'patientId healed from the id');
  assert.strictEqual(out.status, 'unpaid', 'Hebrew status still normalizes');
});

test('normalizePayment preserves a non-blank patientId and leaves malformed ids blank', () => {
  const kept = app.normalizePayment(blankIdRecord({ patientId: 'explicit::key::x' }));
  assert.strictEqual(kept.patientId, 'explicit::key::x', 'non-blank cell preserved as-is');
  const orphan = app.normalizePayment({ id: 'hand-written-row-7', patientId: '', dueDate: DUE, amount: 1, status: 'unpaid' });
  assert.strictEqual(orphan.patientId, '', 'unparseable id stays a true orphan');
});

/* ===== the live bug: due-list row with a blank-patientId record ===== */

test('due-list unpaid row backed by a blank-patientId record renders the ✏️ again', () => {
  app.setState({ mode: 'edit', billingOverrides: [],
                 payments: [app.normalizePayment(blankIdRecord())] });
  const payment = app.paymentForPatientOnDate(PATIENT, DUE);
  assert.strictEqual(payment.patientId, PID, 'the found record carries the healed id');
  const row = app.buildBillingRow(PATIENT, payment, DUE, false);
  assert.ok(row.innerHTML.includes('bill-amount-edit-btn'), 'pencil renders on the due row');
});

/* ===== THE REQUIRED ROUND-TRIP: save → overlay on a HEALED record ===== */

test('save→overlay round-trip: an override written for a healed record overlays that record', async () => {
  app.setState({ mode: 'edit', billingOverrides: [],
                 payments: [app.normalizePayment(blankIdRecord())] });
  const posts = [];
  app.setApiPost(async b => posts.push(b));
  app.setRenderBilling(() => {});
  app.setShowToast(() => {});

  const payment = app.paymentForPatientOnDate(PATIENT, DUE); // healed identity
  await app.saveBillingOverride(payment, 4200);

  // The write used the record's OWN healed keys…
  assert.strictEqual(posts[0].action, 'upsertBillingOverride');
  assert.strictEqual(posts[0].override.patientId, PID, 'save-key = healed payment.patientId');
  assert.strictEqual(posts[0].override.month, '2026-08', 'month from payment.dueDate');
  // …and the overlay lookup finds it on the very same record.
  const after = app.paymentForPatientOnDate(PATIENT, DUE);
  assert.strictEqual(after.amount, 4200, 'overlay matches the healed record — no key divergence');
  assert.strictEqual(after.balance, 4200);

  // clear uses the same single source and restores base.
  await app.clearBillingOverride(after);
  assert.strictEqual(posts[1].action, 'deleteBillingOverride');
  assert.strictEqual(posts[1].override.patientId, PID);
  assert.strictEqual(app.paymentForPatientOnDate(PATIENT, DUE).amount, 30000, 'base restored');
});

/* ===== single source even when the stored patientId is STALE (non-blank) ===== */

test('workers key off payment.patientId verbatim — save-key equals lookup-key even for a stale id', async () => {
  const stale = app.normalizePayment(blankIdRecord({ patientId: 'old-house::מעיין::2025-01-01' }));
  app.setState({ mode: 'edit', billingOverrides: [], payments: [stale] });
  const posts = [];
  app.setApiPost(async b => posts.push(b));
  app.setRenderBilling(() => {});
  app.setShowToast(() => {});

  await app.saveBillingOverride(stale, 5000);
  assert.strictEqual(posts[0].override.patientId, 'old-house::מעיין::2025-01-01',
    'the worker NEVER recomputes patientKey — it writes the record\'s own id');
  const overlaid = app.applyBillingOverride(stale, app.getState().billingOverrides);
  assert.strictEqual(overlaid.amount, 5000, 'overlay finds it under the same key — consistent by construction');
});

/* ===== worker guard ===== */

test('saveBillingOverride refuses a record with no resolvable identity', async () => {
  app.setState({ mode: 'edit', billingOverrides: [], payments: [] });
  const posts = [];
  app.setApiPost(async b => posts.push(b));
  app.setRenderBilling(() => {});
  await app.saveBillingOverride({ patientId: '', dueDate: DUE }, 999);
  assert.strictEqual(posts.length, 0, 'no write without an identity');
  assert.strictEqual(app.getState().billingOverrides.length, 0);
});

/* ===== carry orphans still locked out ===== */

test('a carry row with a malformed id AND blank patientId still gets no editor', () => {
  app.setState({ mode: 'edit', billingOverrides: [], payments: [] });
  const orphan = app.normalizePayment({ id: 'hand-row-3', patientId: '', patientName: 'מעיין אברהמי',
                                        houseId: 'rehab', dueDate: '2026-06-10', amount: 30000, status: 'unpaid' });
  const pseudo = { name: 'מעיין אברהמי', houseId: 'rehab', pay: 30000, date: '', status: '' };
  const row = app.buildBillingRow(pseudo, orphan, '2026-06-10', true);
  assert.ok(!row.innerHTML.includes('bill-amount-edit-btn'), 'true orphans remain non-editable');
});
