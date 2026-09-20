/* Tests for the shared loading-spinner pattern (busyButton) and the two save
 * paths it is applied to in this PR:
 *
 *   - the helper itself, run TWICE — once against the copy that ships in
 *     public/app.js and once against the copy in public/meeting-report.js —
 *     so a regression in either file fails here;
 *   - /meeting-report's «שליחת דיווח» button (public/meeting-report.js): the
 *     real DOM wiring driven through a fake document, including the
 *     double-tap guard and the restore after success / network failure /
 *     validation refusal;
 *   - the dashboard's «שמירה» in the עריכת דיווח מנהל modal (public/app.js),
 *     same three exits plus the ביטול freeze;
 *   - source scans: the helper block and the spinner CSS block are
 *     byte-identical across the two pages, the spinner is rendered BEFORE the
 *     label with logical properties only, prefers-reduced-motion drops the
 *     animation for a static indicator, /meeting-report never pulls the
 *     dashboard bundle, and sw.js carries the bumped cache version.
 *
 * vm-sandbox conventions per the repo (see meeting-report-edit-delete.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const noop = () => {};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* Let queued microtasks drain — busyButton runs `fn` on a microtask, so the
 * request it fires is only observable after a few ticks. */
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* ---------- a fake element good enough for both pages ---------- */
function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function fakeEl(tag) {
  return {
    tagName: tag || 'div',
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    href: '',
    scrollHeight: 40,
    style: {},
    classList: fakeClassList(),
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    fire(ev, arg) { (this._listeners[ev] || []).forEach((f) => f(arg)); },
    _removed: false,
    remove() { this._removed = true; },
    appendChild() {},
    querySelectorAll() { return []; },
  };
}

/* ===================================================================== */
/* 1. The helper, from BOTH shipped copies                                */
/* ===================================================================== */

/* public/meeting-report.js exports the helper directly (its DOM wiring is
 * guarded behind `typeof document`, so a plain require loads only the
 * constants + pure helpers). */
const mrModule = require('../public/meeting-report.js');

/* public/app.js is a browser script — load it in the repo's vm sandbox. */
function loadAppHelper() {
  const src = read('public', 'app.js');
  const epilogue = `globalThis.__test = {
    busyButton: busyButton,
    busyButtonActive: busyButtonActive,
    busyLabelFor: busyLabelFor,
    BUSY_LABELS: BUSY_LABELS,
  };`;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    setTimeout: () => 0, clearTimeout: noop,
    document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const COPIES = [
  ['public/app.js', loadAppHelper()],
  ['public/meeting-report.js', mrModule],
];

COPIES.forEach(([where, api]) => {
  test(`[${where}] busyButton freezes the button and swaps the label while the action runs`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    const d = deferred();
    const p = api.busyButton(btn, 'save', () => d.promise);

    // Applied synchronously, at the tap — before `fn` has even been queued.
    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(btn.getAttribute('aria-busy'), 'true');
    assert.strictEqual(btn.classList.contains('is-busy'), true);
    assert.strictEqual(btn.textContent, 'שומר…');
    assert.strictEqual(api.busyButtonActive(btn), true);

    d.resolve('done');
    assert.strictEqual(await p, 'done');
  });

  test(`[${where}] busyButton uses the Hebrew busy word for the kind of work`, () => {
    assert.strictEqual(api.busyLabelFor('save'), 'שומר…');
    assert.strictEqual(api.busyLabelFor('load'), 'טוען…');
    assert.strictEqual(api.busyLabelFor('delete'), 'מוחק…');
    // Unknown / omitted kind falls back to the save wording rather than blanking.
    assert.strictEqual(api.busyLabelFor('nonsense'), 'שומר…');
    assert.strictEqual(api.busyLabelFor(undefined), 'שומר…');
    // Key-by-key: the app.js copy comes out of a vm realm, so its Object
    // prototype is not this realm's and deepStrictEqual would reject it.
    assert.deepStrictEqual(Object.keys(api.BUSY_LABELS).sort(), ['delete', 'load', 'save']);
    assert.strictEqual(api.BUSY_LABELS.save, 'שומר…');
    assert.strictEqual(api.BUSY_LABELS.load, 'טוען…');
    assert.strictEqual(api.BUSY_LABELS['delete'], 'מוחק…');
  });

  test(`[${where}] a second click while busy does nothing — fn never runs twice`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    let runs = 0;
    const d = deferred();
    const first = api.busyButton(btn, 'save', () => { runs++; return d.promise; });
    const second = api.busyButton(btn, 'save', () => { runs++; return d.promise; });
    const third = api.busyButton(btn, 'save', () => { runs++; return d.promise; });

    await tick();
    assert.strictEqual(runs, 1, 'only the first click may reach the worker');
    assert.strictEqual(await second, undefined);
    assert.strictEqual(await third, undefined);

    d.resolve();
    await first;
    assert.strictEqual(runs, 1);
  });

  test(`[${where}] busyButton restores the button after SUCCESS`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    await api.busyButton(btn, 'save', () => Promise.resolve(1));
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.getAttribute('aria-busy'), null);
    assert.strictEqual(btn.classList.contains('is-busy'), false);
    assert.strictEqual(btn.textContent, 'שמירה');
    assert.strictEqual(api.busyButtonActive(btn), false);
  });

  test(`[${where}] busyButton restores the button after a REJECTED promise, and re-throws`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    await assert.rejects(
      api.busyButton(btn, 'save', () => Promise.reject(new Error('network down'))),
      /network down/);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.getAttribute('aria-busy'), null);
    assert.strictEqual(btn.classList.contains('is-busy'), false);
    assert.strictEqual(btn.textContent, 'שמירה');
  });

  test(`[${where}] busyButton restores the button after a THROWN validation error`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    await assert.rejects(
      api.busyButton(btn, 'save', () => { throw new Error('נא לבחור ליד'); }),
      /נא לבחור ליד/);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.classList.contains('is-busy'), false);
    assert.strictEqual(btn.textContent, 'שמירה');

    // ...and after a validation refusal that just returns early (the shape both
    // shipped save paths actually use: show the error, make no request).
    await api.busyButton(btn, 'save', () => undefined);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.getAttribute('aria-busy'), null);
    assert.strictEqual(btn.textContent, 'שמירה');
  });

  test(`[${where}] busyButton is re-usable after every exit`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'שמירה';
    let runs = 0;
    await api.busyButton(btn, 'save', () => { runs++; });
    await assert.rejects(api.busyButton(btn, 'save', () => { runs++; throw new Error('x'); }));
    await api.busyButton(btn, 'save', () => { runs++; });
    assert.strictEqual(runs, 3);
  });

  test(`[${where}] a pre-disabled button is restored to DISABLED, not enabled`, async () => {
    const btn = fakeEl('button');
    btn.textContent = 'אישור';
    btn.disabled = true;
    await api.busyButton(btn, 'delete', () => Promise.resolve());
    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(btn.textContent, 'אישור');
  });

  test(`[${where}] a falsy button is a passthrough — the action still runs`, async () => {
    let ran = false;
    const out = await api.busyButton(null, 'save', () => { ran = true; return 7; });
    assert.strictEqual(ran, true);
    assert.strictEqual(out, 7);
    assert.strictEqual(api.busyButtonActive(null), false);
  });
});

/* ===================================================================== */
/* 2. /meeting-report — the real page wiring                              */
/* ===================================================================== */

const MR_IDS = [
  'mr-form', 'mr-error', 'mr-reporter', 'mr-lead', 'mr-lead-toggle', 'mr-outcomes',
  'mr-companions', 'mr-companion-other-wrap', 'mr-companion-other', 'mr-note',
  'mr-note-count', 'mr-submit', 'mr-again', 'mr-done', 'mr-summary', 'mr-whatsapp',
];

const PICKER_LEAD = { id: 'L1', name: 'דני', house: 'ramot', visitDate: '2026-09-01' };

/* Boot public/meeting-report.js with a fake document so its DOM-wiring IIFE
 * actually runs, then leave the form in a state that passes validation:
 * מדווח/ת picked, ליד L1 selected (it came back from the /leads feed), an
 * outcome chosen through the page's own click handler, and a פירוט typed.
 * Returns the elements plus a swappable fetch responder. */
async function bootMeetingReportPage() {
  const els = {};
  MR_IDS.forEach((id) => { els[id] = fakeEl(id === 'mr-submit' ? 'button' : 'div'); });
  els['mr-submit'].textContent = 'שליחת דיווח';

  const fetchCalls = [];
  const ok = (body) => Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
  let responder = (url) => (String(url).indexOf('/leads') !== -1
    ? ok({ ok: true, leads: [PICKER_LEAD] })
    : ok({ ok: true }));

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    document: { getElementById: (id) => els[id] || null },
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return responder(url, opts); },
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Error,
    isFinite, encodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public', 'meeting-report.js'), sandbox);
  await tick(8); // let the initial loadLeads settle

  els['mr-reporter'].value = 'חנן';
  els['mr-lead'].value = PICKER_LEAD.id;
  els['mr-note'].value = 'הפגישה הייתה טובה';
  els['mr-outcomes'].fire('click', { target: { closest: () => ({ getAttribute: () => 'advancing' }) } });

  return {
    els, fetchCalls,
    setResponder(fn) { responder = fn; },
    submitCalls: () => fetchCalls.filter((c) => String(c.url).indexOf('/submit') !== -1),
    click: () => els['mr-submit'].fire('click'),
    /* showConfirmation is the ONLY thing that fills the summary — a reliable
     * "did the confirmation screen render?" probe on this fake DOM. */
    confirmed: () => els['mr-summary'].innerHTML !== '',
  };
}

test('[meeting-report] clicking שליחת דיווח puts the button in the busy state', async () => {
  const page = await bootMeetingReportPage();
  const d = deferred();
  page.setResponder(() => d.promise);

  page.click();
  const btn = page.els['mr-submit'];
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(btn.classList.contains('is-busy'), true);
  assert.strictEqual(btn.textContent, 'שומר…');

  await tick();
  assert.strictEqual(page.submitCalls().length, 1);

  d.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
  await tick(8);
});

test('[meeting-report] a second click while busy fires NO second request', async () => {
  const page = await bootMeetingReportPage();
  const d = deferred();
  page.setResponder(() => d.promise);

  page.click();
  await tick();
  page.click();
  page.click();
  await tick();

  assert.strictEqual(page.submitCalls().length, 1, 'double tap must not double-submit');

  d.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
  await tick(8);
  assert.strictEqual(page.submitCalls().length, 1);
});

test('[meeting-report] the button is restored after a SUCCESSFUL submit', async () => {
  const page = await bootMeetingReportPage();
  page.click();
  await tick(10);

  const btn = page.els['mr-submit'];
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.getAttribute('aria-busy'), null);
  assert.strictEqual(btn.classList.contains('is-busy'), false);
  assert.strictEqual(btn.textContent, 'שליחת דיווח');
  // ...and the confirmation screen rendered.
  assert.strictEqual(page.confirmed(), true);
  assert.match(page.els['mr-summary'].innerHTML, /דני/);
  assert.strictEqual(page.els['mr-form'].classList.contains('hidden'), true);
});

test('[meeting-report] the button is restored after a REJECTED request, with the error shown', async () => {
  const page = await bootMeetingReportPage();
  page.setResponder(() => Promise.reject(new Error('sheets_unreachable')));

  page.click();
  await tick(10);

  const btn = page.els['mr-submit'];
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.getAttribute('aria-busy'), null);
  assert.strictEqual(btn.classList.contains('is-busy'), false);
  assert.strictEqual(btn.textContent, 'שליחת דיווח');
  assert.match(page.els['mr-error'].textContent, /אין חיבור לגיליון/);
  assert.strictEqual(page.els['mr-error'].classList.contains('hidden'), false);
  // The form is still on screen for a retry — no confirmation screen.
  assert.strictEqual(page.confirmed(), false);
  assert.strictEqual(page.els['mr-form'].classList.contains('hidden'), false);
});

test('[meeting-report] the button is restored after a VALIDATION error, and nothing is sent', async () => {
  const page = await bootMeetingReportPage();
  page.els['mr-reporter'].value = '';   // מדווח/ת missing

  page.click();
  await tick(10);

  assert.strictEqual(page.submitCalls().length, 0, 'validation must refuse before any request');
  const btn = page.els['mr-submit'];
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.getAttribute('aria-busy'), null);
  assert.strictEqual(btn.classList.contains('is-busy'), false);
  assert.strictEqual(btn.textContent, 'שליחת דיווח');
  assert.strictEqual(page.els['mr-error'].textContent, 'נא לבחור מדווח/ת');

  // The button still works afterwards.
  page.els['mr-reporter'].value = 'חנן';
  page.click();
  await tick(10);
  assert.strictEqual(page.submitCalls().length, 1);
});

/* ===================================================================== */
/* 3. Dashboard — עריכת דיווח מנהל save                                    */
/* ===================================================================== */

function loadDashboardEditModal() {
  const src = read('public', 'app.js');
  const epilogue = `globalThis.__test = {
    showMeetingReportEditModal: (l, cb) => showMeetingReportEditModal(l, cb),
    setSaveMeetingReportEdit(fn) { saveMeetingReportEdit = fn; },
  };`;

  const root = fakeEl('div');
  const created = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      addEventListener: noop,
      querySelectorAll: () => [],
      getElementById: (id) => (id === 'modal-root' ? root : null),
      createElement: () => {
        const back = fakeEl('div');
        const sub = {};
        back.querySelector = (sel) => {
          if (!sub[sel]) {
            const e = fakeEl(sel === 'form' ? 'form' : 'button');
            if (sel === 'form') e._values = {};
            if (sel === 'button[type="submit"]') e.textContent = 'שמירה';
            if (sel === '[data-action="cancel"]') e.textContent = 'ביטול';
            sub[sel] = e;
          }
          return sub[sel];
        };
        back.querySelectorAll = () => [];
        created.push(back);
        return back;
      },
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    // FormData(form) reads the values the test seeded on the fake form.
    FormData: function (form) { this._v = (form && form._values) || {}; },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.FormData.prototype.get = function (k) {
    return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : '';
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, created };
}

const REPORTED_LEAD = {
  id: 'L1', name: 'דני', house: 'ramot',
  meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
  meetingNote: 'שיחה טובה', meetingReporter: 'חנן',
  meetingReportedAt: '2026-08-29T10:15:00.000Z', meetingSeen: '1',
};

/* Open the modal with saveMeetingReportEdit stubbed; returns the pieces the
 * assertions need. */
function openEditModal(saveImpl) {
  const { app, created } = loadDashboardEditModal();
  const calls = [];
  app.setSaveMeetingReportEdit((id, v) => { calls.push({ id, v }); return saveImpl(); });
  let savedCb = 0;
  app.showMeetingReportEditModal(REPORTED_LEAD, () => { savedCb++; });
  const back = created[created.length - 1];
  const form = back.querySelector('form');
  form._values = { mrvOutcome: 'undecided', mrvNote: 'תיקון', mrvCompanionOther: '' };
  return {
    back, form, calls,
    submitBtn: back.querySelector('button[type="submit"]'),
    cancelBtn: back.querySelector('[data-action="cancel"]'),
    savedCb: () => savedCb,
    submit: () => form.onsubmit({ preventDefault: noop }),
  };
}

test('[dashboard edit-report] submitting puts שמירה in the busy state and freezes ביטול', async () => {
  const d = deferred();
  const m = openEditModal(() => d.promise);

  const p = m.submit();
  assert.strictEqual(m.submitBtn.disabled, true);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), 'true');
  assert.strictEqual(m.submitBtn.classList.contains('is-busy'), true);
  assert.strictEqual(m.submitBtn.textContent, 'שומר…');

  await tick();
  assert.strictEqual(m.cancelBtn.disabled, true, 'ביטול must not dismiss an in-flight save');
  assert.strictEqual(m.calls.length, 1);

  d.resolve(true);
  await p;
});

test('[dashboard edit-report] a second submit while busy triggers no second save', async () => {
  const d = deferred();
  const m = openEditModal(() => d.promise);

  const p = m.submit();
  await tick();
  m.submit();
  m.submit();
  await tick();

  assert.strictEqual(m.calls.length, 1, 'double-click must not write twice');

  d.resolve(true);
  await p;
  assert.strictEqual(m.calls.length, 1);
});

test('[dashboard edit-report] SUCCESS restores the button and closes the modal', async () => {
  const m = openEditModal(() => Promise.resolve(true));
  await m.submit();
  await tick();

  assert.strictEqual(m.back._removed, true, 'a saved edit closes the modal');
  assert.strictEqual(m.savedCb(), 1);
  assert.strictEqual(m.submitBtn.disabled, false);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), null);
  assert.strictEqual(m.submitBtn.classList.contains('is-busy'), false);
  assert.strictEqual(m.submitBtn.textContent, 'שמירה');
  assert.strictEqual(m.cancelBtn.disabled, false);
});

test('[dashboard edit-report] a REJECTED save restores the button and keeps the modal open', async () => {
  const m = openEditModal(() => Promise.reject(new Error('save failed')));
  await assert.rejects(m.submit(), /save failed/);

  assert.strictEqual(m.back._removed, false, 'a failed save must not close the modal');
  assert.strictEqual(m.submitBtn.disabled, false);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), null);
  assert.strictEqual(m.submitBtn.classList.contains('is-busy'), false);
  assert.strictEqual(m.submitBtn.textContent, 'שמירה');
  assert.strictEqual(m.cancelBtn.disabled, false, 'ביטול is usable again');
});

test('[dashboard edit-report] a VALIDATION refusal restores the button for a retry', async () => {
  // saveMeetingReportEdit answers false on a refused/failed edit (it has already
  // surfaced the Hebrew error itself).
  const m = openEditModal(() => Promise.resolve(false));
  await m.submit();
  await tick();

  assert.strictEqual(m.back._removed, false, 'a refused edit stays open');
  assert.strictEqual(m.savedCb(), 0);
  assert.strictEqual(m.submitBtn.disabled, false);
  assert.strictEqual(m.submitBtn.getAttribute('aria-busy'), null);
  assert.strictEqual(m.submitBtn.textContent, 'שמירה');
  assert.strictEqual(m.cancelBtn.disabled, false);

  // ...and a retry actually goes through.
  await m.submit();
  await tick();
  assert.strictEqual(m.calls.length, 2);
});

test('[dashboard edit-report] a CONFLICT closes the modal without the onSaved callback', async () => {
  const m = openEditModal(() => Promise.resolve('conflict'));
  await m.submit();
  await tick();

  assert.strictEqual(m.back._removed, true);
  assert.strictEqual(m.savedCb(), 0, 'nothing was saved — no in-place refresh');
});

/* ===================================================================== */
/* 4. Source scans — the duplication is real, and it stays in sync        */
/* ===================================================================== */

function extract(text, startMark, endMark) {
  const i = text.indexOf(startMark);
  const j = text.indexOf(endMark);
  assert.ok(i !== -1, 'start marker missing: ' + startMark);
  assert.ok(j !== -1, 'end marker missing: ' + endMark);
  assert.ok(j > i, 'markers out of order');
  return text.slice(i, j + endMark.length);
}

const JS_START = '/* ===== BUSY-BUTTON PATTERN — START';
const JS_END = '/* ===== BUSY-BUTTON PATTERN — END ===== */';
const CSS_START = '/* ===== BUSY-BUTTON SPINNER — START';
const CSS_END = '/* ===== BUSY-BUTTON SPINNER — END ===== */';

test('the busyButton helper is byte-identical in app.js and meeting-report.js', () => {
  const a = extract(read('public', 'app.js'), JS_START, JS_END);
  const b = extract(read('public', 'meeting-report.js'), JS_START, JS_END);
  assert.strictEqual(a, b, 'the two copies of the busy-button helper have drifted');
  assert.match(a, /function busyButton\(btn, kind, fn\)/);
  assert.match(a, /aria-busy/);
  assert.match(a, /\.finally\(/, 'the restore must live in a finally');
});

test('the spinner CSS is byte-identical in style.css and meeting-report.css', () => {
  const a = extract(read('public', 'style.css'), CSS_START, CSS_END);
  const b = extract(read('public', 'meeting-report.css'), CSS_START, CSS_END);
  assert.strictEqual(a, b, 'the two copies of the spinner CSS have drifted');
});

test('the spinner renders BEFORE the label and is RTL-safe (logical properties only)', () => {
  ['style.css', 'meeting-report.css'].forEach((f) => {
    const block = extract(read('public', f), CSS_START, CSS_END);
    assert.match(block, /\.is-busy::before\s*\{/, `${f}: the spinner must be ::before the label`);
    assert.ok(!/\.is-busy::after/.test(block), `${f}: ::after would put the spinner after the label`);
    assert.match(block, /margin-inline-end/, `${f}: the gap must use a logical margin`);
    assert.match(block, /border-inline-start-color/, `${f}: the gap in the ring must be logical`);
    // No physical directions anywhere in the block — those break under RTL.
    assert.ok(!/(margin|padding|border)-(left|right)\b/.test(block),
      `${f}: physical left/right properties are not RTL-safe`);
  });
});

test('prefers-reduced-motion drops the animation for a static indicator', () => {
  ['style.css', 'meeting-report.css'].forEach((f) => {
    const block = extract(read('public', f), CSS_START, CSS_END);
    const i = block.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(i !== -1, `${f}: no prefers-reduced-motion block`);
    const reduced = block.slice(i);
    assert.match(reduced, /animation:\s*none/, `${f}: reduced motion must stop the spin`);
    // The ring closes into a full static circle so the control still reads busy.
    assert.match(reduced, /border-inline-start-color:\s*currentColor/,
      `${f}: reduced motion still needs a visible static indicator`);
    // The animated rule is only outside the reduced-motion block.
    assert.match(block.slice(0, i), /animation:\s*ezone-busy-spin/);
  });
});

test('the spinner is pure CSS — no new dependency, no image, no external URL', () => {
  ['style.css', 'meeting-report.css'].forEach((f) => {
    const block = extract(read('public', f), CSS_START, CSS_END);
    assert.ok(!/url\(/.test(block), `${f}: the spinner must not load anything`);
    assert.match(block, /@keyframes ezone-busy-spin/);
  });
});

test('/meeting-report never loads the dashboard bundle', () => {
  const html = read('public', 'meeting-report.html');
  assert.ok(!/app\.js/.test(html), 'meeting-report.html must not load app.js');
  assert.ok(!/["\/]style\.css/.test(html), 'meeting-report.html must not load style.css');
  assert.match(html, /meeting-report\.js/);
  assert.match(html, /meeting-report\.css/);

  // The script itself pulls nothing from the dashboard either.
  const js = read('public', 'meeting-report.js');
  assert.ok(!/require\(\s*['"].*app(\.js)?['"]\s*\)/.test(js), 'meeting-report.js must not require app.js');
  assert.ok(!/\bimport\b[^\n]*app\.js/.test(js), 'meeting-report.js must not import app.js');
  assert.ok(!/importScripts/.test(js));
});

test('both save paths actually go through busyButton', () => {
  const mrJs = read('public', 'meeting-report.js');
  assert.match(mrJs, /busyButton\(el\('mr-submit'\), 'save'/,
    'the meeting-report submit must run through busyButton');
  assert.ok(!/function withBusy\(/.test(mrJs), 'the page-local withBusy helper is replaced');

  const appJs = read('public', 'app.js');
  assert.match(appJs, /busyButton\(submitBtn, 'save'/,
    'the dashboard edit-report save must run through busyButton');
});

test('sw.js CACHE_VERSION is bumped to v9 for the new assets', () => {
  const sw = read('public', 'sw.js');
  assert.match(sw, /var CACHE_VERSION = 'v9';/);
  assert.match(sw, /v8 → v9:/, 'the bump needs its comment line in the existing style');
});
