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
 * Same vm-sandbox + fake-DOM approach as async-button-busy-states.test.js.
 *
 * Phase 3 PR 2 (CHANGELOG-payment-report-form.md): the confirm-then-mark-paid
 * step is replaced by the strict «דווח תשלום» form; the tests below pin that. */

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
  /* Attribute API included: busyButton reads/writes aria-busy on the button. */
  return {
    disabled: false, textContent: '', onclick: null, classList: fakeClassList(),
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    // The report form (Phase 3 PR 2) looks its fields up by name.
    querySelector() { return fakeButton(); },
    querySelectorAll() { return []; },
  };
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

/* ===== Phase 3 PR 2: חידוש תשלום opens the strict «דווח תשלום» form =====
 * A renewal is money received like any other, so the button no longer marks
 * the cycle paid behind a confirm dialog: it opens the report form for the
 * renewal cycle, and nothing is written until a COMPLETE report is sent
 * (test/payment-report-form.test.js covers the form itself). */

test('clicking חידוש תשלום opens the «דווח תשלום» form for the renewal cycle and writes no payment', () => {
  app.setState({ mode: 'edit', payments: [], finance: true });
  let writes = 0;
  app.setSavePayment(async () => { writes++; });
  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  assert.strictEqual(writes, 0, 'no payment written on the initial click');
  assert.strictEqual(holder.created.length, 1, 'the form dialog is created');
  const html = holder.created[0].innerHTML;
  assert.ok(html.includes('דווח תשלום'), 'the report form, not the old confirm');
  assert.ok(!html.includes('לחדש תשלום עבור'), 'the old mark-paid confirm is gone');
  assert.ok(html.includes('בעז גילה'), 'patient name in the form');
  assert.ok(html.includes('9,000') || html.includes('9000'), 'expected amount in the form');
});

test('submitting the form without the required fields writes nothing (strict)', () => {
  app.setState({ mode: 'edit', payments: [], finance: true });
  let writes = 0;
  app.setSavePayment(async () => { writes++; });
  holder.created.length = 0;
  app.confirmRenewPatient(PATIENT, DUE);
  const back = holder.created[0];
  const form = back.querySelector('form');
  let prevented = false;
  form.onsubmit({ preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(writes, 0, 'nothing written');
  assert.strictEqual(back.removed, false, 'the form stays open');
});

test('ביטול closes the form and writes nothing', () => {
  app.setState({ mode: 'edit', payments: [], finance: true });
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
