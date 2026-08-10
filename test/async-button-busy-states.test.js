/* Tests for the async-button busy-state pass (PR-R3).
 *
 *   app.js — withBusyButton (disable + .busy for the duration of an async
 *            action, restore on settle, propagate rejections);
 *            showConfirm busy discipline (stays open + frozen while an async
 *            onConfirm runs; double-click and backdrop-close guarded);
 *            renewPatient returns its settle promise (so the renew button's
 *            busy wrapper can track it);
 *            buildBillingRow freezes the status select + paid input (and dims
 *            the row) while savePayment's round-trip is in flight.
 *
 * Same vm-sandbox approach as restore-choice-modal.test.js. */

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

/* ---------- minimal DOM ---------- */
function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: (c) => set.has(c),
  };
}
function fakeButton() {
  return { disabled: false, textContent: '', onclick: null, classList: fakeClassList() };
}
function fakeControl() {
  return { disabled: false, value: '', onchange: null, classList: fakeClassList() };
}
function fakeContainerEl() {
  const el = {
    className: '', _html: '', dataset: {},
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    classList: fakeClassList(),
    children: [],
    appendChild(c) { this.children.push(c); },
    removed: false,
    remove() { this.removed = true; },
    _listeners: {},
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    _sub: {},
    querySelector(sel) {
      if (!this._sub[sel]) {
        this._sub[sel] = (sel.includes('select') || sel.includes('input') ||
                          sel.includes('.billing-status') || sel.includes('.billing-paid'))
          ? fakeControl() : fakeButton();
      }
      return this._sub[sel];
    },
    querySelectorAll() { return []; },
  };
  return el;
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      withBusyButton,
      showConfirm,
      renewPatient,
      buildBillingRow,
      setSavePayment(fn)     { savePayment = fn; },
      setRenderDashboard(fn) { renderDashboard = fn; },
      setShowError(fn)       { showError = fn; },
      setShowToast(fn)       { showToast = fn; },
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

/* ===== withBusyButton ===== */

test('withBusyButton disables + marks busy during the action, restores after', async () => {
  const btn = fakeButton();
  const d = deferred();
  const run = app.withBusyButton(btn, () => d.promise);
  assert.strictEqual(btn.disabled, true, 'disabled while pending');
  assert.strictEqual(btn.classList.contains('busy'), true, 'busy class while pending');
  d.resolve('done');
  assert.strictEqual(await run, 'done', 'return value passes through');
  assert.strictEqual(btn.disabled, false, 're-enabled after settle');
  assert.strictEqual(btn.classList.contains('busy'), false, 'busy class removed');
});

test('withBusyButton restores the button and propagates a rejection', async () => {
  const btn = fakeButton();
  await assert.rejects(
    () => app.withBusyButton(btn, () => Promise.reject(new Error('boom'))),
    /boom/
  );
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.classList.contains('busy'), false);
});

test('withBusyButton preserves a pre-disabled button and passes through a falsy button', async () => {
  const btn = fakeButton();
  btn.disabled = true;
  await app.withBusyButton(btn, async () => {});
  assert.strictEqual(btn.disabled, true, 'previously-disabled stays disabled');
  assert.strictEqual(await app.withBusyButton(null, async () => 42), 42);
});

/* ===== showConfirm busy discipline ===== */

test('showConfirm stays open + frozen while async onConfirm runs, closes after', async () => {
  const d = deferred();
  let calls = 0;
  holder.created.length = 0;
  app.showConfirm({ text: 'בטוח?', onConfirm: () => { calls++; return d.promise; } });
  const back = holder.created[0];
  const confirmBtn = back.querySelector('[data-action="confirm"]');
  const cancelBtn  = back.querySelector('[data-action="cancel"]');

  const clicked = confirmBtn.onclick();
  assert.strictEqual(confirmBtn.disabled, true, 'confirm frozen while pending');
  assert.strictEqual(cancelBtn.disabled, true, 'cancel frozen while pending');
  assert.strictEqual(confirmBtn.classList.contains('busy'), true);
  assert.strictEqual(back.removed, false, 'dialog still open while pending');

  // double-click during busy is a no-op
  confirmBtn.onclick();
  // backdrop click during busy must not close
  back._listeners['click']({ target: back });
  assert.strictEqual(back.removed, false, 'backdrop close guarded while busy');

  d.resolve();
  await clicked;
  assert.strictEqual(calls, 1, 'onConfirm ran exactly once');
  assert.strictEqual(back.removed, true, 'closed after settle');
});

test('showConfirm surfaces an onConfirm error and still closes', async () => {
  const errors = [];
  app.setShowError(m => errors.push(m));
  holder.created.length = 0;
  app.showConfirm({ text: 'x', onConfirm: async () => { throw new Error('נפל'); } });
  const back = holder.created[0];
  await back.querySelector('[data-action="confirm"]').onclick();
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('נפל'));
  assert.strictEqual(back.removed, true);
});

test('showConfirm cancel + backdrop still close normally when NOT busy', () => {
  holder.created.length = 0;
  app.showConfirm({ text: 'x', onConfirm: async () => {} });
  const back = holder.created[0];
  back.querySelector('[data-action="cancel"]').onclick();
  assert.strictEqual(back.removed, true);
});

/* ===== renewPatient returns its settle promise ===== */

test('renewPatient returns a promise the busy wrapper can await', async () => {
  app.setState({ mode: 'edit', payments: [], patients: [] });
  app.setRenderDashboard(() => {});
  app.setShowToast(() => {});
  let saved = null;
  app.setSavePayment(async (p) => { saved = p; });
  const out = app.renewPatient(
    { houseId: 'ramot', name: 'א', date: '2026-01-05', pay: 7000 },
    '2026-08-05'
  );
  assert.ok(out && typeof out.then === 'function', 'returns a thenable');
  await out;
  assert.ok(saved, 'savePayment was invoked');
  assert.strictEqual(saved.status, 'paid');
});

/* ===== billing row controls freeze during savePayment ===== */

test('billing status change freezes the row controls until savePayment settles', async () => {
  app.setState({ mode: 'edit', payments: [] });
  const d = deferred();
  app.setSavePayment(() => d.promise);

  holder.created.length = 0;
  const row = app.buildBillingRow(
    { houseId: 'ramot', name: 'א', date: '2026-01-05', pay: 7000, status: 'active' },
    { id: 'pay::x::2026-08-05', patientId: 'x', patientName: 'א', houseId: 'ramot',
      dueDate: '2026-08-05', amount: 7000, status: 'unpaid', amountPaid: 0, balance: 7000 },
    '2026-08-05',
    false
  );
  const statusSel = row.querySelector('.billing-status');
  const paidInput = row.querySelector('.billing-paid');

  statusSel.value = 'paid';
  statusSel.onchange();
  assert.strictEqual(statusSel.disabled, true, 'select frozen while save pending');
  assert.strictEqual(paidInput.disabled, true, 'paid input frozen while save pending');
  assert.strictEqual(row.classList.contains('saving'), true, 'row dimmed');

  d.resolve();
  // Cross-realm promise adoption (vm async fn awaiting a host promise) takes a
  // few extra microtask ticks — a short macrotask wait is deterministic.
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(statusSel.disabled, false, 're-enabled after settle');
  assert.strictEqual(paidInput.disabled, false);
  assert.strictEqual(row.classList.contains('saving'), false);
});
