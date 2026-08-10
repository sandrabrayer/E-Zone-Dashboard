/* Tests for the restore-choice modal (PR-R1).
 *
 *   app.js  — priorStatusFromAudit (pre-discharge status, fallback active);
 *             buildRestoredToActivePatients / reconstructActivePatientFromAudit
 *             restore the PRIOR status, not hard-coded active;
 *             dischargeAuditRow captures prior_status BEFORE the released flip;
 *             normalizeDischargedPatient round-trips prior_status (blank on
 *             legacy rows); showRestorePatientChoiceModal renders both options
 *             with prior-status pre-selected and routes each choice to the
 *             right worker.
 *   Code.gs — DISCHARGED_PATIENT_COLUMNS appends prior_status LAST (readSheet_
 *             maps by position; append-only contract).
 *
 * Same vm-sandbox approach as restore-to-active.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ---------- minimal DOM for the modal ---------- */
function fakeButton() {
  return { disabled: false, textContent: '', onclick: null };
}
function fakeModalEl() {
  const el = {
    className: '', _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    children: [],
    appendChild(c) { this.children.push(c); },
    removed: false,
    remove() { this.removed = true; },
    addEventListener() {},
    _cancel: fakeButton(),
    _submit: fakeButton(),
    _form: { onsubmit: null },
    querySelector(sel) {
      if (sel === '[data-action="cancel"]') return this._cancel;
      if (sel === 'button[type="submit"]') return this._submit;
      if (sel === 'form') return this._form;
      return fakeButton();
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
      priorStatusFromAudit,
      buildRestoredToActivePatients,
      reconstructActivePatientFromAudit,
      dischargeAuditRow,
      normalizeDischargedPatient,
      showRestorePatientChoiceModal,
      setDoActive(fn)  { doRestorePatientToActive = fn; },
      setDoNewLead(fn) { doRestorePatientAsNewLead = fn; },
    };
  `;
  const noop = () => {};
  const holder = { root: fakeModalEl(), created: [] };
  const doc = {
    addEventListener: noop,
    getElementById: (id) => (id === 'modal-root' ? holder.root : null),
    createElement: () => { const el = fakeModalEl(); holder.created.push(el); return el; },
    querySelectorAll: () => [],
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    // FormData stub: the modal reads get('restoreChoice'); tests set __fdChoice.
    FormData: class { get() { return sandbox.__fdChoice; } },
    __fdChoice: 'prev_status',
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, sandbox, holder };
}

function loadCodeColumns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + 'globalThis.__cols = DISCHARGED_PATIENT_COLUMNS;', sandbox);
  return Array.from(sandbox.__cols);
}

const { app, sandbox, holder } = loadApp();

function audit(over) {
  return Object.assign(
    { id: 'aud-1', houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05',
      pay: 9000, adv: 0, status: 'released', fromLead: 'lead-7',
      exitDate: '2026-06-01', disposition: 'completed', prior_status: '' },
    over || {}
  );
}

/* ===== priorStatusFromAudit ===== */

test('priorStatusFromAudit honors the three live statuses', () => {
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: 'trial' })), 'trial');
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: 'wait' })), 'wait');
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: 'active' })), 'active');
});

test('priorStatusFromAudit falls back to active for legacy/blank/junk/released', () => {
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: '' })), 'active');
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: 'released' })), 'active');
  assert.strictEqual(app.priorStatusFromAudit(audit({ prior_status: 'nonsense' })), 'active');
  assert.strictEqual(app.priorStatusFromAudit(null), 'active');
});

/* ===== restore builders use the prior status ===== */

test('matched row flips to the PRIOR status in place (trial), exitDate cleared', () => {
  const rows = [{ houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05',
                  status: 'released', exitDate: '2026-06-01', pay: 9000 }];
  const out = app.buildRestoredToActivePatients(rows, audit({ prior_status: 'trial' }));
  assert.strictEqual(out.reconstructed, false);
  assert.strictEqual(out.patients[0].status, 'trial');
  assert.strictEqual(out.patients[0].exitDate, '');
});

test('reconstructed row carries the PRIOR status (wait)', () => {
  const out = app.reconstructActivePatientFromAudit(audit({ prior_status: 'wait' }));
  assert.strictEqual(out.status, 'wait');
  assert.strictEqual(out.exitDate, '');
});

test('legacy audit row (no prior_status) restores to active — existing behavior preserved', () => {
  const rows = [{ houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05', status: 'released', exitDate: 'x' }];
  const out = app.buildRestoredToActivePatients(rows, audit());
  assert.strictEqual(out.patients[0].status, 'active');
});

/* ===== capture at discharge time ===== */

test('dischargeAuditRow captures prior_status from the pre-flip patient status', () => {
  const patient = { houseId: 'ramot', name: 'א', date: '2026-01-05', status: 'trial' };
  const row = app.dischargeAuditRow(patient, { disposition: 'completed', note: '' }, '2026-08-09');
  assert.strictEqual(row.prior_status, 'trial');
  assert.strictEqual(row.status, 'released'); // audit row itself still reads released
});

test('normalizeDischargedPatient round-trips prior_status and leaves legacy rows blank', () => {
  const withField = app.normalizeDischargedPatient({ id: 'd1', houseId: 'ramot', name: 'א', prior_status: 'wait' });
  assert.strictEqual(withField.prior_status, 'wait');
  const legacy = app.normalizeDischargedPatient({ id: 'd2', houseId: 'ramot', name: 'ב' });
  assert.strictEqual(legacy.prior_status, '');
});

/* ===== Code.gs column contract ===== */

test('DISCHARGED_PATIENT_COLUMNS appends prior_status LAST, after restored', () => {
  const cols = loadCodeColumns();
  assert.strictEqual(cols[cols.length - 1], 'prior_status');
  assert.strictEqual(cols[cols.length - 2], 'restored');
  assert.strictEqual(cols.filter(c => c === 'prior_status').length, 1);
});

/* ===== the modal ===== */

test('modal renders both choices with prior-status pre-selected and the prior label', () => {
  app.setState({ mode: 'edit' });
  holder.created.length = 0;
  app.showRestorePatientChoiceModal(audit({ prior_status: 'trial', name: 'בעז גילה' }));
  assert.strictEqual(holder.created.length, 1);
  const html = holder.created[0].innerHTML;
  assert.ok(html.includes('value="prev_status" checked'), 'prior-status radio pre-selected');
  assert.ok(html.includes('value="new_lead"'), 'new-lead radio present');
  assert.ok(!html.includes('value="new_lead" checked'), 'new-lead not pre-selected');
  assert.ok(html.includes('החזרה לסטטוס הקודם'), 'prior-status label');
  assert.ok(html.includes('תקופת ניסיון'), 'shows the ACTUAL prior status label (trial)');
  assert.ok(html.includes('פתיחת ליד חדש'), 'new-lead label');
  assert.ok(html.includes('בעז גילה'), 'patient name in heading');
});

test('submit with the default choice routes to doRestorePatientToActive and closes', async () => {
  app.setState({ mode: 'edit' });
  const calls = [];
  app.setDoActive(async (p) => calls.push(['active', p.id]));
  app.setDoNewLead(async (p) => calls.push(['newlead', p.id]));
  holder.created.length = 0;
  app.showRestorePatientChoiceModal(audit({ id: 'aud-9' }));
  const back = holder.created[0];
  sandbox.__fdChoice = 'prev_status';
  await back._form.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(calls, [['active', 'aud-9']]);
  assert.strictEqual(back.removed, true, 'modal closed after the worker settled');
});

test('submit with new_lead routes to doRestorePatientAsNewLead', async () => {
  app.setState({ mode: 'edit' });
  const calls = [];
  app.setDoActive(async (p) => calls.push(['active', p.id]));
  app.setDoNewLead(async (p) => calls.push(['newlead', p.id]));
  holder.created.length = 0;
  app.showRestorePatientChoiceModal(audit({ id: 'aud-10' }));
  const back = holder.created[0];
  sandbox.__fdChoice = 'new_lead';
  await back._form.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(calls, [['newlead', 'aud-10']]);
  assert.strictEqual(back.removed, true);
});

test('modal does not open outside edit mode', () => {
  app.setState({ mode: 'viewer' });
  holder.created.length = 0;
  app.showRestorePatientChoiceModal(audit());
  assert.strictEqual(holder.created.length, 0);
  app.setState({ mode: 'edit' }); // restore for any later tests
});
