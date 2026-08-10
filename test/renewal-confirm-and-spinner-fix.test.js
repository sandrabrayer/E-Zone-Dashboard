/* Tests for the renewal confirm-step + spinner fix.
 *
 * ROOT CAUSE PINNED HERE: renewPatient's optimistic update re-renders the
 * renewals list synchronously (savePayment upserts state, renderDashboard()
 * rebuilds the list, the now-covered row is dropped), destroying the clicked
 * row button in the same tick — so R3's busy state on the ROW button never
 * survived to a paint. The fix moves both the confirmation AND the busy state
 * to showConfirm's dialog in #modal-root, which no list re-render touches.
 *
 *   app.js — confirmRenewPatient: the renew button now opens a confirm dialog
 *            (no write on the initial click); אישור fires renewPatient with the
 *            dialog frozen+spinning until the round-trip settles; ביטול writes
 *            nothing. renewalAmount keeps the dialog text and the write in
 *            agreement.
 *
 * Same vm-sandbox + fake-DOM approach as async-button-busy-states.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c), remove: c => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: c => set.has(c),
  };
}
function fakeButton() {
  return { disabled: false, textContent: '', onclick: null, classList: fakeClassList() };
}
function fakeContainerEl() {
  return {
    className: '', _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    classList: fakeClassList(), children: [],
    appendChild(c) { this.children.push(c); },
    removed: false, remove() { this.removed = true; },
    _listeners: {}, addEventListener(ev, fn) { this._listeners[ev] = fn; },
    _sub: {},
    querySelector(sel) {
      if (!this._sub[sel]) this._sub[sel] = fakeButton();
      return this._sub[sel];
    },
    querySelectorAll() { return []; },
  };
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      confirmRenewPatient,
      renewalAmount,
      renewPatient,
      setSavePayment(fn)     { savePayment = fn; },
      setRenderDashboard(fn) { renderDashboard = fn; },
      setShowToast(fn)       { showToast = fn; },
      setShowError(fn)       { showError = fn; },
    };
  `;
  const noop = () => {};
  const holder = { root: fakeContainerEl(), created: [] };
  const doc = {
    addEventListener: noop,
    getElementById: (id) => (id === 'modal-root' ? holder.root : null),
    createElement: () => { const el = fakeContainerEl(); holder.created.push(el); return el; },
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
  return { app: sandbox.__test, holder };
}

const { app, holder } = loadApp();

const PATIENT = { houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05', pay: 9000, adv: 0, status: 'active' };
const DUE = '2026-08-15';

function settle(ms) { return new Promise(r => setTimeout(r, ms || 20)); }

/* ===== renewalAmount ===== */

test('renewalAmount uses an existing payment record amount, else the base pay', () => {
  app.setState({ mode: 'edit', payments: [] });
  assert.strictEqual(app.renewalAmount(PATIENT, DUE), 9000, 'no record → base pay');
  // Seed a persisted record for the same (patient, dueDate) with an overridden amount.
  app.setState({
    payments: [{ id: `pay::ramot::בעז גילה::2026-01-05::${DUE}`, patientId: `ramot::בעז גילה::2026-01-05`,
                 patientName: 'בעז גילה', houseId: 'ramot', dueDate: DUE,
                 amount: 7500, status: 'unpaid', amountPaid: 0, balance: 7500 }],
  });
  assert.strictEqual(app.renewalAmount(PATIENT, DUE), 7500, 'existing record amount wins');
  app.setState({ payments: [] });
});

/* ===== the initial click writes NOTHING ===== */

test('clicking חידוש תשלום opens the confirm dialog and writes no payment', () => {
  app.setState({ mode: 'edit', payments: [] });
  let writes = 0;
  app.setSavePayment(async () => { writes++; });
  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  assert.strictEqual(writes, 0, 'no payment written on the initial click');
  assert.strictEqual(holder.created.length, 1, 'confirm dialog created');
  const html = holder.created[0].innerHTML;
  assert.ok(html.includes('לחדש תשלום עבור'), 'Hebrew confirm phrasing');
  assert.ok(html.includes('בעז גילה'), 'patient name in the prompt');
  assert.ok(html.includes('9,000') || html.includes('9000'), 'amount in the prompt');
});

/* ===== אישור → write, with the busy state surviving the re-render ===== */

test('אישור fires the write; the dialog stays open + frozen for the round-trip (spinner survives)', async () => {
  app.setState({ mode: 'edit', payments: [] });
  const d = deferred();
  let saved = null;
  app.setSavePayment((p) => { saved = p; return d.promise; });
  // Simulate the destructive optimistic re-render renderDashboard performs:
  // it rebuilds the renewals LIST — it cannot touch #modal-root. The dialog
  // node below living in modal-root is exactly what makes the spinner survive.
  let dashboardRenders = 0;
  app.setRenderDashboard(() => { dashboardRenders++; });
  app.setShowToast(() => {});

  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  const back = holder.created[0];
  const confirmBtn = back.querySelector('[data-action="confirm"]');
  const cancelBtn  = back.querySelector('[data-action="cancel"]');

  const clicked = confirmBtn.onclick();
  assert.ok(saved, 'savePayment fired on אישור');
  assert.strictEqual(saved.status, 'paid');
  assert.ok(dashboardRenders >= 1, 'optimistic re-render ran while the request is pending');
  // The heart of the fix: while the network write is still pending, the busy
  // state is alive on the modal button — NOT on a destroyed row button.
  assert.strictEqual(back.removed, false, 'dialog still open while pending');
  assert.strictEqual(confirmBtn.disabled, true, 'confirm frozen');
  assert.strictEqual(cancelBtn.disabled, true, 'cancel frozen');
  assert.strictEqual(confirmBtn.classList.contains('busy'), true, 'spinner class present');

  d.resolve();
  await clicked;
  await settle();
  assert.strictEqual(back.removed, true, 'dialog closes after the round-trip settles');
});

/* ===== ביטול → no write ===== */

test('ביטול closes the dialog and writes nothing', () => {
  app.setState({ mode: 'edit', payments: [] });
  let writes = 0;
  app.setSavePayment(async () => { writes++; });
  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  const back = holder.created[0];
  back.querySelector('[data-action="cancel"]').onclick();
  assert.strictEqual(back.removed, true, 'dialog closed');
  assert.strictEqual(writes, 0, 'no payment written');
});

/* ===== edit-mode gate ===== */

test('confirmRenewPatient no-ops outside edit mode', () => {
  app.setState({ mode: 'viewer' });
  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  assert.strictEqual(holder.created.length, 0);
  app.setState({ mode: 'edit' });
});
