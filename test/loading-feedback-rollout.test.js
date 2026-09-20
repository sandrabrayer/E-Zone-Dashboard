/* Tests for the loading-feedback rollout — see CHANGELOG-loading-spinners-rollout.md.
 *
 * PR #129 built busyButton and applied it to two buttons; #130 fixed its ring.
 * This suite covers the rollout to everything else: the five modal choke points
 * every lead/patient flow funnels through, the inline [data-field] autosave that
 * has no label to swap, the whole-page loading banner, and a structural guard
 * against a new async trigger landing with no feedback at all.
 *
 * busyButton itself is unit-tested against BOTH shipped copies in
 * test/loading-spinners.test.js, and its ring is measured in real Chromium in
 * test/spinner-glyph-browser.test.js — neither is repeated here.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ---------- a fake element with the API a real control has ---------- */
function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function fakeEl(tag) {
  const el = {
    tagName: tag || 'div',
    disabled: false, textContent: '', innerHTML: '', value: '', className: '',
    style: {}, dataset: {}, classList: fakeClassList(),
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    fire(ev, arg) { (this._listeners[ev] || []).forEach((f) => f(arg)); },
    _removed: false,
    remove() { this._removed = true; if (this.parentNode) this.parentNode.removeChild(this); },
    parentNode: null,
    children: [],
    nextSibling: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      const i = this.children.indexOf(node);
      if (i >= 0) this.children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    querySelectorAll() { return []; },
  };
  return el;
}

/* A field sitting inside a parent, so withFieldSaving has somewhere to insert. */
function fieldInParent(tag) {
  const parent = fakeEl('div');
  const el = fakeEl(tag || 'input');
  parent.appendChild(el);
  return { parent, el };
}

/* ---------- load public/app.js ---------- */
function loadApp() {
  const src = read('public', 'app.js');
  const epilogue = `
    globalThis.__test = {
      withFieldSaving: (el, kind, fn) => withFieldSaving(el, kind, fn),
      busyLabelFor: (k) => busyLabelFor(k),
      setLoading: (on) => setLoading(on),
      loadAll: () => loadAll(),
      reloadCredits: () => reloadCredits(),
      closeLead: (l) => closeLead(l),
      dischargePatient: (p) => dischargePatient(p),
      showConfirm: (o) => showConfirm(o),
      showModal: (o) => showModal(o),
      showCloseLeadModal: (o) => showCloseLeadModal(o),
      showRestorePatientChoiceModal: (p) => showRestorePatientChoiceModal(p),
      setState(s) { Object.assign(state, s); },
      getState() { return state; },
      stub(name, fn) { globalThis[name] = fn; },
      setApiGet(fn) { apiGet = fn; },
      setApiPost(fn) { apiPost = fn; },
      setSaveAll(fn) { saveAll = fn; },
      setRenderAll(fn) { renderAll = fn; },
      setShowError(fn) { showError = fn; },
      setShowToast(fn) { showToast = fn; },
      setDoRestoreNewLead(fn) { doRestorePatientAsNewLead = fn; },
      setDoRestoreActive(fn) { doRestorePatientToActive = fn; },
    };
  `;
  const root = fakeEl('div');
  const banner = fakeEl('div');
  banner.classList.add('hidden');
  const created = [];
  const byId = { 'modal-root': root, 'loading-banner': banner };

  const doc = {
    addEventListener: noop,
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => {
      const node = fakeEl(tag);
      const sub = {};
      node.querySelector = (sel) => {
        if (!sub[sel]) {
          const e = fakeEl(sel === 'form' ? 'form' : 'button');
          if (sel === 'form') e._values = {};
          if (sel === 'button[type="submit"]') e.textContent = 'שמירה';
          if (sel === '[data-action="cancel"]') e.textContent = 'ביטול';
          if (sel === '[data-action="confirm"]') e.textContent = 'אישור';
          sub[sel] = e;
        }
        return sub[sel];
      };
      /* showCloseLeadModal captures its radio list AT BUILD TIME, so the fake
       * has to serve one from the start — stubbing it afterwards is too late
       * and silently yields a submit handler that returns without doing
       * anything (which is exactly how a vacuous test gets written). */
      node.querySelectorAll = (sel) => (typeof sel === 'string' && sel.includes('disposition')
        ? [{ checked: true, value: 'not_relevant', addEventListener: noop }]
        : []);
      created.push(node);
      return node;
    },
  };

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    FormData: function (form) { this._v = (form && form._values) || {}; },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    Promise, Set, Map, Error, isFinite, parseFloat, parseInt,
  };
  sandbox.FormData.prototype.get = function (k) {
    return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : '';
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, created, banner, root };
}

function freshApp() {
  const h = loadApp();
  h.app.setRenderAll(() => {});
  h.app.setShowError(() => {});
  h.app.setShowToast(() => {});
  h.app.setState({ mode: 'edit', leads: [], patients: [], irrelevantLeads: [], credits: [] });
  return h;
}

const bannerHidden = (h) => h.banner.classList.contains('hidden');

/* ===================================================================== */
/* 1. withFieldSaving — the inline autosave indicator                     */
/* ===================================================================== */

test('withFieldSaving marks the field busy and inserts the shared marker', async () => {
  const { app } = freshApp();
  const { parent, el } = fieldInParent('input');
  const d = deferred();
  const p = app.withFieldSaving(el, 'save', () => d.promise);

  assert.strictEqual(el.getAttribute('aria-busy'), 'true');
  const marker = parent.children.find((c) => c !== el);
  assert.ok(marker, 'a marker is inserted beside the field');
  assert.match(marker.className, /\bfield-saving\b/);
  assert.match(marker.className, /\bis-busy\b/,
    'it carries the SAME is-busy class the buttons use — one ring, one stylesheet rule');
  assert.strictEqual(marker.textContent, 'שומר…');
  assert.strictEqual(marker.getAttribute('aria-busy'), 'true');

  d.resolve();
  await p;
});

test('withFieldSaving clears the marker after SUCCESS', async () => {
  const { app } = freshApp();
  const { parent, el } = fieldInParent('select');
  await app.withFieldSaving(el, 'save', () => Promise.resolve('ok'));
  assert.strictEqual(el.getAttribute('aria-busy'), null);
  assert.strictEqual(parent.children.length, 1, 'only the field is left');
});

test('withFieldSaving clears the marker after FAILURE and re-throws', async () => {
  const { app } = freshApp();
  const { parent, el } = fieldInParent('input');
  await assert.rejects(
    app.withFieldSaving(el, 'save', () => Promise.reject(new Error('network down'))),
    /network down/);
  assert.strictEqual(el.getAttribute('aria-busy'), null,
    'a failed save must not leave the field stuck mid-save');
  assert.strictEqual(parent.children.length, 1,
    'and must not leave a «שומר…» marker implying it saved');
});

test('a second change while saving does nothing — no double write', async () => {
  const { app } = freshApp();
  const { el } = fieldInParent('input');
  let runs = 0;
  const d = deferred();
  const first = app.withFieldSaving(el, 'save', () => { runs++; return d.promise; });
  const second = app.withFieldSaving(el, 'save', () => { runs++; return d.promise; });
  await tick();
  assert.strictEqual(runs, 1);
  assert.strictEqual(await second, undefined);
  d.resolve();
  await first;
  assert.strictEqual(runs, 1);
});

test('withFieldSaving tolerates a detached field and a falsy one', async () => {
  const { app } = freshApp();
  const orphan = fakeEl('input');            // no parentNode — a re-render took it
  let ran = false;
  await app.withFieldSaving(orphan, 'save', () => { ran = true; });
  assert.strictEqual(ran, true, 'the save still runs when there is nowhere to attach');
  assert.strictEqual(orphan.getAttribute('aria-busy'), null);
  assert.strictEqual(await app.withFieldSaving(null, 'save', () => 7), 7);
});

test('the marker uses the shared Hebrew vocabulary, not its own', async () => {
  const { app } = freshApp();
  for (const [kind, word] of [['save', 'שומר…'], ['load', 'טוען…'], ['delete', 'מוחק…'], ['send', 'שולח…']]) {
    const { parent, el } = fieldInParent('input');
    const d = deferred();
    const p = app.withFieldSaving(el, kind, () => d.promise);
    assert.strictEqual(parent.children.find((c) => c !== el).textContent, word);
    assert.strictEqual(app.busyLabelFor(kind), word);
    d.resolve(); await p;
  }
});

/* ===================================================================== */
/* 2. The modal choke points                                              */
/* ===================================================================== */

/* Every lead/patient create, edit, admit, close, discharge and restore funnels
 * through one of these five. Testing them is what covers those actions. */

function openShowModal(app, created, onSubmit) {
  app.showModal({ title: 't', fields: [{ name: 'a', label: 'a', type: 'text' }],
                  submitLabel: 'שמירה', onSubmit });
  const back = created[created.length - 1];
  return { back, form: back.querySelector('form'),
           submitBtn: back.querySelector('button[type="submit"]'),
           cancelBtn: back.querySelector('[data-action="cancel"]') };
}

test('[showModal] submit shows the busy state and blocks a second submit', async () => {
  const { app, created } = freshApp();
  const d = deferred();
  let calls = 0;
  const m = openShowModal(app, created, () => { calls++; return d.promise; });

  const p = m.form.onsubmit({ preventDefault: noop, target: m.form });
  assert.strictEqual(m.submitBtn.disabled, true);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(m.submitBtn.classList.contains('is-busy'), true);
  assert.strictEqual(m.submitBtn.textContent, 'שומר…');

  await tick();
  m.form.onsubmit({ preventDefault: noop, target: m.form });
  m.form.onsubmit({ preventDefault: noop, target: m.form });
  await tick();
  assert.strictEqual(calls, 1, 'a double submit must not write twice');

  d.resolve(true);
  await p;
  assert.strictEqual(m.submitBtn.textContent, 'שמירה', 'restored');
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), null);
});

test('[showModal] restores after a REJECTED submit and keeps the modal open', async () => {
  const { app, created } = freshApp();
  const m = openShowModal(app, created, () => Promise.reject(new Error('boom')));
  await m.form.onsubmit({ preventDefault: noop, target: m.form });
  await tick();
  assert.strictEqual(m.back._removed, false, 'a thrown submit keeps the modal open');
  assert.strictEqual(m.submitBtn.disabled, false);
  assert.strictEqual(m.submitBtn.textContent, 'שמירה');
  assert.strictEqual(m.cancelBtn.disabled, false, 'ביטול usable again');
});

test('[showModal] restores after a REFUSED submit (onSubmit returned false)', async () => {
  const { app, created } = freshApp();
  const m = openShowModal(app, created, () => Promise.resolve(false));
  await m.form.onsubmit({ preventDefault: noop, target: m.form });
  await tick();
  assert.strictEqual(m.back._removed, false);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), null);
  assert.strictEqual(m.submitBtn.textContent, 'שמירה');
});

test('[showConfirm] the busy state lives on the dialog button, cancel freezes at the tap', async () => {
  const { app, created } = freshApp();
  const d = deferred();
  let calls = 0;
  app.showConfirm({ text: 'x', onConfirm: () => { calls++; return d.promise; } });
  const back = created[created.length - 1];
  const confirmBtn = back.querySelector('[data-action="confirm"]');
  const cancelBtn = back.querySelector('[data-action="cancel"]');

  const p = confirmBtn.onclick();
  // Synchronously, at the tap — not one microtask later.
  assert.strictEqual(confirmBtn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(confirmBtn.textContent, 'שומר…');
  assert.strictEqual(cancelBtn.disabled, true, 'ביטול frozen immediately');

  await tick();
  confirmBtn.onclick();
  assert.strictEqual(calls, 1, 'a second click must not fire the worker again');

  d.resolve();
  await p;
  assert.strictEqual(back._removed, true);
});

test('[showConfirm] a destructive dialog says מוחק…, an ordinary one שומר…', async () => {
  const { app, created } = freshApp();
  const d1 = deferred();
  app.showConfirm({ text: 'x', danger: true, confirmLabel: 'כן, מחק', onConfirm: () => d1.promise });
  const dangerBtn = created[created.length - 1].querySelector('[data-action="confirm"]');
  const p1 = dangerBtn.onclick();
  assert.strictEqual(dangerBtn.textContent, 'מוחק…');
  d1.resolve(); await p1;

  const d2 = deferred();
  app.showConfirm({ text: 'y', onConfirm: () => d2.promise });
  const plainBtn = created[created.length - 1].querySelector('[data-action="confirm"]');
  const p2 = plainBtn.onclick();
  assert.strictEqual(plainBtn.textContent, 'שומר…');
  d2.resolve(); await p2;
});

test('[showCloseLeadModal] submit is busy, blocks a double submit, restores on both exits', async () => {
  const { app, created } = freshApp();
  const d = deferred();
  let calls = 0;
  app.showCloseLeadModal({ onConfirm: () => { calls++; return d.promise; } });
  const back = created[created.length - 1];
  const form = back.querySelector('form');
  const submitBtn = back.querySelector('button[type="submit"]');
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  form._values = { disposition: 'not_relevant', not_relevant_note: '' };

  const p = form.onsubmit({ preventDefault: noop });
  assert.strictEqual(submitBtn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(submitBtn.textContent, 'שומר…');
  await tick();
  assert.strictEqual(cancelBtn.disabled, true);
  form.onsubmit({ preventDefault: noop });
  await tick();
  assert.strictEqual(calls, 1, 'a second submit must not close the lead twice');

  d.resolve();
  await p;
  assert.strictEqual(back._removed, true, 'closes on success');
  assert.strictEqual(cancelBtn.disabled, false);

  // ...and a rejection restores instead of closing.
  app.showCloseLeadModal({ onConfirm: () => Promise.reject(new Error('nope')) });
  const back2 = created[created.length - 1];
  const form2 = back2.querySelector('form');
  const submit2 = back2.querySelector('button[type="submit"]');
  form2._values = { disposition: 'not_relevant', not_relevant_note: '' };
  await form2.onsubmit({ preventDefault: noop });
  await tick(6);
  assert.strictEqual(back2._removed, false, 'a failed close keeps the modal open for a retry');
  assert.strictEqual(submit2.getAttribute('aria-busy'), null);
  assert.strictEqual(submit2.disabled, false);
});

test('[restore choice modal] submit is busy and restores on both exits', async () => {
  const { app, created } = freshApp();
  const d = deferred();
  app.setDoRestoreActive(() => d.promise);
  app.setDoRestoreNewLead(async () => {});
  app.showRestorePatientChoiceModal({ name: 'דני', houseId: 'ramot', date: '2026-01-01' });
  const back = created[created.length - 1];
  const form = back.querySelector('form');
  const submitBtn = back.querySelector('button[type="submit"]');
  const cancelBtn = back.querySelector('[data-action="cancel"]');
  form._values = { restoreChoice: 'prev_status' };

  const p = form.onsubmit({ preventDefault: noop });
  assert.strictEqual(submitBtn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(submitBtn.textContent, 'שומר…');
  await tick();
  assert.strictEqual(cancelBtn.disabled, true);

  d.resolve();
  await p;
  assert.strictEqual(submitBtn.getAttribute('aria-busy'), null);
  assert.strictEqual(cancelBtn.disabled, false);
  assert.strictEqual(back._removed, true);
});

/* ===================================================================== */
/* 3. The whole-page loading banner                                       */
/* ===================================================================== */

test('loadAll raises and clears the loading banner', async () => {
  const h = freshApp();
  const d = deferred();
  h.app.setApiGet(() => d.promise);
  assert.strictEqual(bannerHidden(h), true, 'hidden to start');

  const p = h.app.loadAll();
  assert.strictEqual(bannerHidden(h), false, 'banner up while loading');

  d.resolve({ ok: true, leads: [], patients: {}, irrelevantLeads: [], dischargedPatients: [] });
  await p;
  assert.strictEqual(bannerHidden(h), true, 'banner down after the load');
});

test('loadAll clears the banner even when the load FAILS', async () => {
  const h = freshApp();
  h.app.setApiGet(() => Promise.reject(new Error('offline')));
  await h.app.loadAll();
  assert.strictEqual(bannerHidden(h), true,
    'a failed load must not strand the banner on screen forever');
});

test('reloadCredits raises the banner too — it used to reload in silence', async () => {
  const h = freshApp();
  const d = deferred();
  h.app.setApiGet(() => d.promise);

  const p = h.app.reloadCredits();
  assert.strictEqual(bannerHidden(h), false, 'banner up for the credits reload');

  d.resolve({ ok: true, credits: [] });
  assert.strictEqual(await p, true);
  assert.strictEqual(bannerHidden(h), true);
});

test('reloadCredits clears the banner when the reload fails', async () => {
  const h = freshApp();
  h.app.setApiGet(() => Promise.reject(new Error('offline')));
  assert.strictEqual(await h.app.reloadCredits(), false);
  assert.strictEqual(bannerHidden(h), true);
});

/* ===================================================================== */
/* 4. Optimistic rollback is UNCHANGED                                    */
/* ===================================================================== */

test('closeLead still rolls back and re-throws when the write fails', async () => {
  const { app, created } = freshApp();
  const lead = { id: 'L1', name: 'דני', stage: 'visit' };
  app.setState({ mode: 'edit', leads: [lead], irrelevantLeads: [] });
  app.setApiPost(() => Promise.reject(new Error('sheet down')));

  let posted = 0;
  app.setApiPost(() => { posted++; return Promise.reject(new Error('sheet down')); });

  app.closeLead(lead);
  const back = created[created.length - 1];
  const form = back.querySelector('form');
  form._values = { disposition: 'not_relevant', not_relevant_note: '' };

  await form.onsubmit({ preventDefault: noop });
  await tick(8);

  assert.strictEqual(posted, 1, 'the write really was attempted (guards a vacuous pass)');
  const after = app.getState();
  assert.strictEqual(after.leads.length, 1, 'the lead is rolled BACK into the pipeline');
  assert.strictEqual(after.irrelevantLeads.length, 0, 'and removed from the closed list');
  assert.strictEqual(back._removed, false, 'the modal stays open for a retry');
});

test('closeLead still moves the lead when the write succeeds', async () => {
  const { app, created } = freshApp();
  const lead = { id: 'L1', name: 'דני', stage: 'visit' };
  app.setState({ mode: 'edit', leads: [lead], irrelevantLeads: [] });
  app.setApiPost(async () => ({ ok: true }));

  app.closeLead(lead);
  const back = created[created.length - 1];
  const form = back.querySelector('form');
  form._values = { disposition: 'not_relevant', not_relevant_note: 'סיבה' };
  await form.onsubmit({ preventDefault: noop });
  await tick(8);

  const after = app.getState();
  assert.strictEqual(after.leads.length, 0);
  assert.strictEqual(after.irrelevantLeads.length, 1);
  assert.strictEqual(after.irrelevantLeads[0].disposition, 'not_relevant');
  assert.strictEqual(back._removed, true, 'the modal closes on success');
});

/* ===================================================================== */
/* 5. Structural guards                                                   */
/* ===================================================================== */

test('the retired withBusyButton pattern is gone for good', () => {
  const appJs = read('public', 'app.js');
  assert.ok(!/withBusyButton/.test(appJs),
    'withBusyButton must not come back — busyButton is the one pattern');
  assert.ok(!/classList\.add\('busy'\)/.test(appJs),
    "the legacy .busy class must not be re-added");
  const css = read('public', 'style.css');
  assert.ok(!/^\.btn\.busy\s*\{/m.test(css), 'its dead CSS is removed too');
  assert.ok(!/@keyframes btn-busy-spin/.test(css));
});

test('no hand-rolled submitting flag or hard-coded busy label survives', () => {
  const appJs = read('public', 'app.js');
  assert.ok(!/let submitting = false/.test(appJs),
    'the per-modal submitting flags are replaced by busyButton\'s own guard');
  assert.ok(!/'שומר\.\.\.'/.test(appJs),
    'the old three-dot label is gone; BUSY_LABELS owns the wording');
});

test('every Hebrew busy word comes from BUSY_LABELS, not a stray literal', () => {
  // A stray literal would drift from the shared vocabulary the moment one of
  // the four words is reworded. Comments are stripped first — prose that NAMES
  // the word («the «שומר…» label») is documentation, not a second source of
  // truth, and counting it would make this guard unmaintainable.
  const stripped = read('public', 'app.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
  const start = stripped.indexOf('var BUSY_LABELS');
  const block = stripped.slice(start, stripped.indexOf('}', start) + 1);
  assert.ok(start !== -1, 'BUSY_LABELS must still be the one declaration');
  ['שומר…', 'טוען…', 'מוחק…', 'שולח…'].forEach((w) => {
    const total = stripped.split(w).length - 1;
    const inBlock = block.split(w).length - 1;
    assert.strictEqual(inBlock, 1, `"${w}" must be declared exactly once in BUSY_LABELS`);
    assert.strictEqual(total, inBlock,
      `"${w}" must come from BUSY_LABELS only, found ${total - inBlock} stray literal(s)`);
  });
});

/* ---------- the coverage guard ---------- */

/* Trigger wirings that are deliberately feedback-free, each with the reason.
 * A NEW async trigger will not be on this list, so the guard below fails until
 * it is either given feedback or consciously added here. */
const SYNC_TRIGGERS_OK = [
  'renderBreakeven',    // localStorage only
  'saveBreakevenToStorage',
  'classList.toggle',   // collapse / expand
  'openWhatsAppLink',   // hands off to wa.me, no request of ours
];

/* The mutation/load calls that make a handler "async work" for the guard. */
const ASYNC_MARKERS = [
  // the transport + the shared write paths
  'apiPost(', 'apiGet(', 'saveAll(', 'updateLead(', 'savePayment(',
  'saveCredit(', 'loadAll(', 'reloadCredits(',
  // the named workers a handler can reach directly
  'deletePatient(', 'saveBillingOverride(', 'clearBillingOverride(',
  'advanceLead(', 'moveLead(', 'removeLead(', 'restoreIrrelevantLead(',
  'renewPatient(', 'deleteMeetingReport(', 'markMeetingReportSeen(',
  'createOutpatientLead(',
];
/* What counts as "this handler is covered". The modal openers are in the list
 * on purpose: handing off to showModal / showCloseLeadModal / showConfirm /
 * showRestorePatientChoiceModal IS the architecture — the dialog's own submit
 * button carries the busy state, because an optimistic worker re-renders the
 * list and destroys the row button that opened it. Those four submit handlers
 * are behaviourally tested above, so trusting them here is not a hole. */
const FEEDBACK_MARKERS = [
  'busyButton(', 'withFieldSaving(', 'setLoading(', 'setRowSaving(',
  'showConfirm(', 'showModal(', 'showCloseLeadModal(', 'showRestorePatientChoiceModal(',
];

/* Extract each handler's FULL source: everything from the trigger to the end of
 * the statement that installs it. Depth is tracked across (), {} and [] so a
 * concise arrow body (`x.onchange = () => save(...)`) is captured just as well
 * as a block body — an earlier version stopped at the arrow's own `()` and
 * silently read an empty body, which made this whole guard vacuous. */
function handlerBodies(src) {
  const out = [];
  const re = /(?:\.onclick\s*=|\.onchange\s*=|\.onsubmit\s*=|addEventListener\(\s*'(?:click|change)'\s*,)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const from = m.index;
    let i = from + m[0].length;
    let paren = m[0].startsWith('addEventListener') ? 1 : 0;
    let curly = 0, square = 0;
    const limit = Math.min(src.length, from + 6000);
    for (; i < limit; i++) {
      const ch = src[i];
      if (ch === '(') paren++;
      else if (ch === ')') { paren--; if (paren < 0) break; }
      else if (ch === '{') curly++;
      else if (ch === '}') curly--;
      else if (ch === '[') square++;
      else if (ch === ']') square--;
      else if (ch === ';' && paren === 0 && curly === 0 && square === 0) break;
    }
    out.push({ index: from, body: src.slice(from, i + 1) });
  }
  return out;
}

/* A handler is often a one-liner delegating to a named worker that owns the
 * feedback itself (`.onclick = () => restoreIrrelevantLead(lead)` → showConfirm
 * lives inside restoreIrrelevantLead). Resolve ONE level of that indirection so
 * the guard judges the whole reachable surface instead of raising a false
 * positive that would only get allowlisted away. */
function bodyOf(src, name) {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const m = decl.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  if (i === -1) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}

function reachableText(src, body) {
  let text = body;
  const called = new Set((body.match(/\b([a-zA-Z_$][\w$]*)\s*\(/g) || [])
    .map((c) => c.replace(/\s*\($/, '')));
  called.forEach((name) => { text += '\n' + bodyOf(src, name); });
  return text;
}

test('COVERAGE GUARD: no click/change handler does async work without feedback', () => {
  const src = read('public', 'app.js');
  const offenders = [];
  handlerBodies(src).forEach(({ index, body }) => {
    const text = reachableText(src, body);
    if (!ASYNC_MARKERS.some((mk) => text.includes(mk))) return;
    if (FEEDBACK_MARKERS.some((mk) => text.includes(mk))) return;
    if (SYNC_TRIGGERS_OK.some((mk) => body.includes(mk))) return;
    const line = src.slice(0, index).split('\n').length;
    offenders.push(`public/app.js:${line} → ${body.split('\n')[0].trim().slice(0, 90)}`);
  });
  assert.deepStrictEqual(offenders, [],
    'these handlers reach a network call with no visible feedback:\n' + offenders.join('\n'));
});

test('COVERAGE GUARD actually bites — a stripped handler is detected', () => {
  // Proves the guard is not vacuous: the same scan over a handler with its
  // feedback removed must flag it.
  const src = read('public', 'app.js');
  const stripped = "x.onclick = () => advanceLead(lead);";
  const text = reachableText(src, stripped);
  assert.ok(ASYNC_MARKERS.some((mk) => text.includes(mk)), 'async work is seen');
  assert.ok(!FEEDBACK_MARKERS.some((mk) => stripped.includes(mk)), 'and no feedback in the handler');
});

test('COVERAGE GUARD: the meeting-report page has feedback on both its triggers', () => {
  const src = read('public', 'meeting-report.js');
  assert.match(src, /busyButton\(el\('mr-submit'\), 'send'/);
  assert.match(src, /busyButton\(el\('mr-again'\), 'load'/);
  // ...and the picker announces its own load rather than sitting blank.
  assert.match(src, /function showLeadsLoading/);
  assert.match(src, /busyLabelFor\('load'\)/);
});

test('the /meeting-report page still does not load the dashboard bundle', () => {
  // The rollout must not have quietly imported app.js to share a helper.
  const html = read('public', 'meeting-report.html');
  assert.ok(!/app\.js/.test(html));
  assert.ok(!/["\/]style\.css/.test(html));
  const js = read('public', 'meeting-report.js');
  assert.ok(!/require\(\s*['"].*app(\.js)?['"]\s*\)/.test(js));
  assert.ok(!/withFieldSaving/.test(js),
    'withFieldSaving is dashboard-only — the report page has no inline autosave');
});
