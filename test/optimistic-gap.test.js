/* The optimistic-trigger gap — the fast guard that always runs in CI.
 *
 * #132 wired every async action through busyButton, including four writes that
 * re-render BEFORE they await: moveLead (both stage buttons), deletePatient,
 * saveBillingOverride and clearBillingOverride. busyButton sets its class
 * synchronously but runs `fn` on a microtask, so class-set → worker entered →
 * trigger detached all land in ONE task with no paint between them: on those
 * four the busy state never reaches a frame. test/optimistic-gap-browser.test.js
 * measures that in Chromium (0 of ~90 frames before this change, ~88 of 90
 * after, against a modal-button control at 43/43). This file is the structural
 * half — it runs everywhere, with no browser.
 *
 * What it pins:
 *   - the page-level banner (reference counting, the floor at zero, read
 *     outranking write);
 *   - for each of the four workers: the banner is up while the write is in
 *     flight and down afterwards, on success AND on failure;
 *   - the property that actually matters — the indicator lives OUTSIDE the
 *     re-rendered region, so it survives the synchronous re-render that
 *     detaches the trigger;
 *   - the rollbacks, which this change must not have disturbed.
 *
 * vm-sandbox conventions per the repo (see test/loading-feedback-rollout.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const noop = () => {};
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function fakeEl() {
  return {
    textContent: '', value: '', disabled: false, className: '', dataset: {},
    style: {}, children: [], classList: fakeClassList(),
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    addEventListener: noop,
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  };
}

/* Boot public/app.js with a #loading-banner the assertions can read. */
function loadApp() {
  const banner = fakeEl();
  banner.classList.add('hidden');

  const epilogue = `globalThis.__test = {
    state,
    setState(s) { Object.assign(state, s); },
    setLoading, setSaving,
    BANNER_LOADING, BANNER_SAVING,
    moveLead, deletePatient, saveBillingOverride, clearBillingOverride, loadAll,
    setApiGet(fn)        { apiGet = fn; },
    setApiPost(fn)       { apiPost = fn; },
    setSaveAll(fn)       { saveAll = fn; },
    setRenderAll(fn)     { renderAll = fn; },
    setRenderBilling(fn) { renderBilling = fn; },
    setShowError(fn)     { showError = fn; },
    setShowToast(fn)     { showToast = fn; },
  };`;

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      addEventListener: noop,
      querySelectorAll: () => [],
      getElementById: (id) => (id === 'loading-banner' ? banner : null),
      createElement: () => fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    confirm: () => true,                  // the native dialog #132 kept
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    Promise, Set, Map, Error, isFinite, parseInt, parseFloat,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public', 'app.js') + epilogue, sandbox);

  const app = sandbox.__test;
  app.setShowError(noop);
  app.setShowToast(noop);
  app.setRenderAll(noop);
  app.setRenderBilling(noop);
  const up = () => !banner.classList.contains('hidden');
  return { app, banner, up };
}

/* ===================================================================== */
/* 1. The banner itself                                                   */
/* ===================================================================== */

test('[banner] setSaving shows «שומר נתונים…» and hides it again', () => {
  const { app, banner, up } = loadApp();
  assert.strictEqual(up(), false);
  app.setSaving(true);
  assert.strictEqual(up(), true);
  assert.strictEqual(banner.textContent, 'שומר נתונים…');
  app.setSaving(false);
  assert.strictEqual(up(), false);
});

test('[banner] setLoading still shows «טוען נתונים…» — reads are unchanged', () => {
  const { app, banner, up } = loadApp();
  app.setLoading(true);
  assert.strictEqual(up(), true);
  assert.strictEqual(banner.textContent, 'טוען נתונים…');
  app.setLoading(false);
  assert.strictEqual(up(), false);
});

test('[banner] it is REFERENCE-COUNTED — an inner operation cannot hide the outer one', () => {
  const { app, up } = loadApp();
  app.setLoading(true);
  app.setLoading(true);              // e.g. reloadCredits during another read
  app.setLoading(false);
  assert.strictEqual(up(), true, 'the inner read finishing must not lower the outer banner');
  app.setLoading(false);
  assert.strictEqual(up(), false);

  app.setSaving(true);
  app.setSaving(true);               // two overlapping optimistic writes
  app.setSaving(false);
  assert.strictEqual(up(), true);
  app.setSaving(false);
  assert.strictEqual(up(), false);
});

test('[banner] an extra false never drives a counter negative', () => {
  const { app, up } = loadApp();
  app.setSaving(false);
  app.setSaving(false);
  app.setSaving(true);
  assert.strictEqual(up(), true, 'a stray unwind must not leave the banner stuck off');
  app.setSaving(false);
  assert.strictEqual(up(), false);
});

test('[banner] a read outranks a write while both are up', () => {
  const { app, banner, up } = loadApp();
  app.setSaving(true);
  assert.strictEqual(banner.textContent, 'שומר נתונים…');
  app.setLoading(true);
  assert.strictEqual(banner.textContent, 'טוען נתונים…', 'a reload replaces everything — bigger news');
  app.setLoading(false);
  assert.strictEqual(banner.textContent, 'שומר נתונים…', 'and the write is still announced');
  app.setSaving(false);
  assert.strictEqual(up(), false);
});

/* ===================================================================== */
/* 2. The four workers — feedback survives the synchronous re-render      */
/* ===================================================================== */

/* Each case re-renders BEFORE it awaits. `renderAll`/`renderBilling` is the
 * moment the trigger is detached, so these assert the banner is up AFTER that
 * has already happened and while the request is still pending — which is
 * precisely "the indicator survives the re-render". */
const CASES = [
  {
    name: '«← שלב הבא» / «שלב קודם →» → moveLead',
    render: 'setRenderAll',
    run(app, settle) {
      const lead = { id: 'L1', stage: 'new', waitlistedAt: '' };
      app.setState({ mode: 'edit', leads: [lead] });
      app.setSaveAll(() => settle());
      return { promise: app.moveLead(lead, 'visit'), subject: lead };
    },
    assertRolledBack(t) { assert.strictEqual(t.subject.stage, 'new', 'the stage rolled back'); },
    assertCommitted(t) { assert.strictEqual(t.subject.stage, 'visit'); },
  },
  {
    name: 'מחק לצמיתות ✕ → deletePatient',
    render: 'setRenderAll',
    run(app, settle) {
      const p = { id: 'P1', name: 'בעז', houseId: 'ramot', date: '2026-01-05' };
      app.setState({ mode: 'edit', patients: [p] });
      app.setApiPost(() => settle().then(() => ({ ok: true })));
      return { promise: app.deletePatient(p), subject: p };
    },
    assertRolledBack(t, app) { assert.strictEqual(app.state.patients.length, 1, 'the patient is back'); },
    assertCommitted(t, app) { assert.strictEqual(app.state.patients.length, 0); },
  },
  {
    name: 'billing שמור → saveBillingOverride',
    render: 'setRenderBilling',
    run(app, settle) {
      const prev = [];
      app.setState({ mode: 'edit', billingOverrides: prev, billingDate: '2026-09-05' });
      app.setApiPost(() => settle().then(() => ({ ok: true })));
      return { promise: app.saveBillingOverride({ patientId: 'P1', dueDate: '2026-09-05' }, 8000) };
    },
    assertRolledBack(t, app) { assert.strictEqual(app.state.billingOverrides.length, 0, 'the override rolled back'); },
    assertCommitted(t, app) { assert.strictEqual(app.state.billingOverrides.length, 1); },
  },
  {
    name: 'billing ↩ → clearBillingOverride',
    render: 'setRenderBilling',
    run(app, settle) {
      const existing = { id: 'ov1', patientId: 'P1', month: '2026-09', amount: 1 };
      app.setState({ mode: 'edit', billingOverrides: [existing], billingDate: '2026-09-05' });
      app.setApiPost(() => settle().then(() => ({ ok: true })));
      return { promise: app.clearBillingOverride({ patientId: 'P1', dueDate: '2026-09-05' }) };
    },
    assertRolledBack(t, app) { assert.strictEqual(app.state.billingOverrides.length, 1, 'the override is back'); },
    assertCommitted(t, app) { assert.strictEqual(app.state.billingOverrides.length, 0); },
  },
];

CASES.forEach((c) => {
  test(`[${c.name}] the banner is up while the write is in flight, AFTER the re-render`, async () => {
    const { app, banner, up } = loadApp();
    const d = deferred();
    let renderedBeforeAwait = 0;
    app[c.render](() => { renderedBeforeAwait++; });

    const t = c.run(app, () => d.promise);
    await tick();

    assert.ok(renderedBeforeAwait >= 1,
      'this worker is supposed to re-render before it awaits — if it stopped doing so ' +
      'the premise of this whole test file changed');
    assert.strictEqual(up(), true,
      'the trigger is detached by now, so the banner is the only surviving indicator');
    assert.strictEqual(banner.textContent, 'שומר נתונים…');

    d.resolve({ ok: true });
    await t.promise;
    await tick();
    assert.strictEqual(up(), false, 'and it comes down when the write settles');
  });

  test(`[${c.name}] a FAILED write lowers the banner and leaves the rollback intact`, async () => {
    const { app, up } = loadApp();
    app[c.render](noop);
    const t = c.run(app, () => Promise.reject(new Error('נפל')));
    await t.promise.catch(noop);
    await tick();

    assert.strictEqual(up(), false, 'a failure must not leave the app looking permanently busy');
    c.assertRolledBack(t, app);
  });

  test(`[${c.name}] a SUCCESSFUL write keeps its effect`, async () => {
    const { app, up } = loadApp();
    app[c.render](noop);
    const t = c.run(app, () => Promise.resolve({ ok: true }));
    await t.promise;
    await tick();
    assert.strictEqual(up(), false);
    c.assertCommitted(t, app);
  });
});

/* ===================================================================== */
/* 3. Structure — the indicator cannot be inside a re-rendered region     */
/* ===================================================================== */

const APP = read('public', 'app.js');

test('#loading-banner sits outside every re-rendered container', () => {
  /* The fix only works because this element is not inside anything renderAll /
   * renderBilling rebuilds. It lives in the banner block at the top of
   * index.html, before #app — a sibling of the whole application shell. */
  const html = read('public', 'index.html');
  const banner = html.indexOf('id="loading-banner"');
  const app = html.indexOf('id="app"');
  assert.ok(banner !== -1 && app !== -1, 'both elements must exist');
  assert.ok(banner < app,
    '#loading-banner must precede (and sit outside) #app, or a re-render could detach it too');

  /* And nothing may rebuild it: every render* function empties its own
   * container by innerHTML, so the banner must never be inside one. */
  assert.ok(!/getElementById\('loading-banner'\)[^\n]*innerHTML/.test(APP),
    'the banner must not be rebuilt by any renderer');
});

test('each of the four workers raises the banner AFTER its optimistic re-render', () => {
  /* Ordering is load-bearing: setSaving must come after the re-render call, or
   * it would be reporting a window that has not started yet. Structural — it
   * proves the call sites exist and are ordered, while the browser test proves
   * the result actually paints. */
  const WORKERS = [
    ['async function moveLead', 'renderAll()'],
    ['async function deletePatient', 'renderAll()'],
    ['async function saveBillingOverride', 'renderBilling()'],
    ['async function clearBillingOverride', 'renderBilling()'],
  ];
  WORKERS.forEach(([sig, renderCall]) => {
    const i = APP.indexOf(sig);
    assert.ok(i !== -1, `${sig} not found — did it get renamed?`);
    const body = APP.slice(i, APP.indexOf('\n}\n', i));
    const render = body.indexOf(renderCall);
    const raise = body.indexOf('setSaving(true)');
    assert.ok(render !== -1, `${sig}: expected an optimistic ${renderCall}`);
    assert.ok(raise !== -1, `${sig}: must raise the saving banner`);
    assert.ok(raise > render,
      `${sig}: setSaving(true) must come AFTER ${renderCall} — the window it reports ` +
      'is the one that starts once the trigger is already detached');
    assert.ok(body.includes('setSaving(false)'), `${sig}: and lower it in a finally`);
    assert.ok(/}\s*finally\s*{[^}]*setSaving\(false\)/.test(body),
      `${sig}: the lower must be in a finally, or a failure leaves the banner stuck on`);
  });
});

test('the banner counters are reference-counted, not booleans', () => {
  assert.match(APP, /_loadingCount\s*=\s*on\s*\?\s*_loadingCount \+ 1\s*:\s*Math\.max\(0, _loadingCount - 1\)/);
  assert.match(APP, /_savingCount\s*=\s*on\s*\?\s*_savingCount \+ 1\s*:\s*Math\.max\(0, _savingCount - 1\)/);
});

test('this change adds no second indicator — no new helper, no new CSS class', () => {
  /* The whole point is that #loading-banner and .loading-banner already exist.
   * A new spinner here would be the second pattern #129/#130/#132 spent three
   * PRs removing. */
  assert.ok(!/function\s+withBusyButton\s*\(/.test(APP), 'the retired helper stays retired');
  const css = read('public', 'style.css');
  assert.ok(!/@keyframes\s+(?!ezone-busy-spin|btn-busy-spin)[\w-]*spin/.test(css),
    'no third spin keyframe');
  assert.strictEqual((css.match(/\.loading-banner\s*\{/g) || []).length, 1,
    'the banner keeps exactly one style rule');
});

test('sw.js CACHE_VERSION carries a version and its bump comment', () => {
  const sw = read('public', 'sw.js');
  const m = sw.match(/var CACHE_VERSION = 'v(\d+)';/);
  assert.ok(m, 'CACHE_VERSION must be a vN string');
  const n = Number(m[1]);
  assert.ok(n >= 13, `the optimistic-gap fix bumped past #132's v12; found v${n}`);
  assert.ok(sw.includes(`v${n - 1} → v${n}:`),
    `the bump to v${n} needs its comment line in the existing style`);
});
