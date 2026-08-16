/* Regression tests for the discharge-persistence fix.
 *
 * The bug (two proven mechanisms, one root weakness):
 *   The Patients sheet is written by saveAll's WHOLE-HOUSE REPLACE
 *   (replaceHousePatients_ in Code.gs) — last writer wins — while the
 *   discharge is a dual-write (status flip via saveAll + audit row via the
 *   dischargePatient action).
 *   M1 — the audit write failing AFTER saveAll persisted 'released' triggered
 *        a full local rollback; the session's next saveAll then re-sent the
 *        rolled-back 'active' status and silently erased the discharge.
 *   M2 — a stale session (second tab / PWA resumed from background) that
 *        saved ANYTHING resurrected the patient as active; the audit row
 *        survived (keyed upsert, own sheet) but nothing reconciled on load.
 *
 * The fix under test:
 *   1. Write ORDER reversed: the audit row (durable, clobber-proof) goes
 *      first; saveAll second. The full auditRow is sent (carries
 *      prior_status/exitDate/dischargedAt — the old {...p} payload dropped
 *      prior_status, breaking restore-to-previous-status).
 *   2. healClobberedDischarges() on every load: an ACTIVE patient matching a
 *      NON-restored audit row by the established identity key
 *      (houseId+name+date, same as matchActivePatientIndex) is flipped back
 *      to released, exitDate restored from the audit row; persisted via
 *      loadAll's existing post-promote saveAll.
 *
 * vm-sandbox on the REAL shipped functions, per the repo convention.
 * showCloseLeadModal / renderAll / showError / showToast are top-level script
 * declarations (writable globals in the sandbox realm) and are stubbed so
 * dischargePatient's onConfirm can run without a DOM. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

/* Load app.js with fetch stubbed. `routes` maps an action name to a handler
 * returning the parsed JSON body of the response; unlisted actions succeed
 * with {ok:true}. Every request body is recorded in `calls` in order. */
function loadApp(routes) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push(body);
      const handler = body && routes && routes[body.action];
      const payload = handler ? handler(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const epilogue = `
    showCloseLeadModal = (opts) => { globalThis.__confirm = opts.onConfirm; };
    renderAll = () => {};
    showError = (m) => { globalThis.__errors.push(m); };
    showToast = () => {};
    globalThis.__errors = [];
    globalThis.__test = {
      state,
      normalizePatient: (p) => normalizePatient(p),
      normalizeDischargedPatient: (d) => normalizeDischargedPatient(d),
      dischargePatient: (p) => dischargePatient(p),
      healClobberedDischarges: () => healClobberedDischarges(),
      visibleOccupancyRows: (p, h, q, s) => visibleOccupancyRows(p, h, q, s),
      saveAll: () => saveAll(),
      confirm: (payload) => globalThis.__confirm(payload),
      errors: () => globalThis.__errors,
    };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, calls };
}

const PATIENT = {
  houseId: 'ramot', name: 'דנה', date: '2026-07-01', pay: 9000, adv: 1000,
  status: 'active', fromLead: 'L1', exitDate: '', source: 'lead', notes: '',
};
const AUDIT_BASE = {
  id: 'aud-1', houseId: 'ramot', name: 'דנה', date: '2026-07-01',
  status: 'released', fromLead: 'L1', exitDate: '2026-08-10',
  dischargedAt: '2026-08-10T09:00:00.000Z', disposition: 'completed',
  discharge_note: '', restored: '', prior_status: 'active',
};

/* ===== Write order + payload ===== */

test('discharge writes the audit row FIRST, then saveAll', async () => {
  const { app, calls } = loadApp({});
  app.state.mode = 'edit';
  const p = app.normalizePatient(PATIENT);
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = [];

  app.dischargePatient(p);
  await app.confirm({ disposition: 'completed', note: '', dischargeDate: '' });

  const actions = calls.map(c => c && c.action);
  const auditIdx = actions.indexOf('dischargePatient');
  const saveIdx  = actions.indexOf('saveAll');
  assert.ok(auditIdx !== -1 && saveIdx !== -1, 'both writes must fire');
  assert.ok(auditIdx < saveIdx,
    'the clobber-proof audit write must land before the whole-house-replace saveAll');
  assert.strictEqual(p.status, 'released');
  assert.strictEqual(app.errors().length, 0, 'no error surfaced on the happy path');
});

test('the persisted audit payload carries prior_status, exitDate and dischargedAt', async () => {
  const { app, calls } = loadApp({});
  app.state.mode = 'edit';
  const p = app.normalizePatient({ ...PATIENT, status: 'trial' });
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = [];

  app.dischargePatient(p);
  await app.confirm({ disposition: 'stopped_early', note: 'הערה', dischargeDate: '2026-08-12' });

  const sent = calls.find(c => c && c.action === 'dischargePatient').patient;
  assert.strictEqual(sent.prior_status, 'trial',
    'prior_status must persist (the old {...p} payload dropped it, breaking restore-to-previous-status)');
  assert.strictEqual(sent.status, 'released');
  assert.strictEqual(sent.exitDate, '2026-08-12');
  assert.match(sent.dischargedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(sent.disposition, 'stopped_early');
  assert.strictEqual(sent.discharge_note, 'הערה');
});

/* ===== M1 regression: audit-write failure no longer poisons the sheet ===== */

test('audit-write failure rolls back BEFORE anything persisted — a later saveAll cannot erase a discharge', async () => {
  const { app, calls } = loadApp({
    dischargePatient: () => ({ ok: false, error: 'exception', message: 'flaky' }),
  });
  app.state.mode = 'edit';
  const p = app.normalizePatient(PATIENT);
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = [];

  app.dischargePatient(p);
  await assert.rejects(() => app.confirm({ disposition: 'completed', note: '', dischargeDate: '' }));

  // The failed write was the FIRST one: no saveAll ever carried 'released',
  // so the local rollback matches the sheet exactly — no divergence to erase.
  assert.strictEqual(p.status, 'active', 'local rollback (nothing persisted)');
  const savedStatuses = calls.filter(c => c && c.action === 'saveAll')
    .map(c => c.patients.ramot[0] && c.patients.ramot[0].status);
  assert.deepStrictEqual(savedStatuses, [], 'no saveAll may fire when the audit write fails');
  assert.ok(app.errors().length > 0, 'the failure is loud');

  // She keeps working: the next saveAll re-sends active — which IS the sheet
  // state. Consistent, nothing silently lost.
  await app.saveAll();
  const last = calls[calls.length - 1];
  assert.strictEqual(last.action, 'saveAll');
  assert.strictEqual(last.patients.ramot[0].status, 'active');
});

test('saveAll failure after the audit persisted rolls back the UI and reports partial save', async () => {
  let failSave = true;
  const { app, calls } = loadApp({
    saveAll: () => failSave ? { ok: false, error: 'exception', message: 'quota' } : { ok: true },
  });
  app.state.mode = 'edit';
  const p = app.normalizePatient(PATIENT);
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = [];

  app.dischargePatient(p);
  await assert.rejects(() => app.confirm({ disposition: 'completed', note: '', dischargeDate: '' }));

  // Audit row persisted; patient row didn't. UI rolls back to match the
  // Patients sheet; the heal below finishes the release on the next load.
  const actions = calls.map(c => c && c.action);
  assert.ok(actions.indexOf('dischargePatient') < actions.indexOf('saveAll'));
  assert.strictEqual(p.status, 'active', 'UI mirrors the (unchanged) Patients sheet');
  assert.ok(app.errors().some(m => /חלקית/.test(m)), 'the partial save is reported');
});

/* ===== M2 regression: the load-time heal ===== */

test('heal flips an active patient with a non-restored audit row back to released (clobbered discharge)', () => {
  const { app } = loadApp({});
  app.state.patients = [app.normalizePatient(PATIENT)]; // clobbered back to active
  app.state.dischargedPatients = [app.normalizeDischargedPatient(AUDIT_BASE)];

  const healed = app.healClobberedDischarges();

  assert.strictEqual(healed.length, 1);
  assert.strictEqual(app.state.patients[0].status, 'released');
  assert.strictEqual(app.state.patients[0].exitDate, '2026-08-10',
    'exitDate is restored from the audit row (the clobber wiped it)');
  const active = app.visibleOccupancyRows(app.state.patients, 'ramot', '', false);
  assert.deepStrictEqual(active, [], 'the healed patient leaves the active list');
});

test('heal is idempotent and skips already-released patients', () => {
  const { app } = loadApp({});
  app.state.patients = [app.normalizePatient({ ...PATIENT, status: 'released', exitDate: '2026-08-10' })];
  app.state.dischargedPatients = [app.normalizeDischargedPatient(AUDIT_BASE)];
  assert.strictEqual(app.healClobberedDischarges().length, 0);
});

test('heal skips restored audit rows — a restored patient stays active', () => {
  const { app } = loadApp({});
  app.state.patients = [app.normalizePatient(PATIENT)];
  app.state.dischargedPatients = [app.normalizeDischargedPatient({ ...AUDIT_BASE, restored: 'TRUE' })];
  assert.strictEqual(app.healClobberedDischarges().length, 0);
  assert.strictEqual(app.state.patients[0].status, 'active');
  // Sheets may coerce 'TRUE' to a boolean — same skip.
  app.state.dischargedPatients = [app.normalizeDischargedPatient({ ...AUDIT_BASE, restored: true })];
  assert.strictEqual(app.healClobberedDischarges().length, 0);
});

test('heal never touches a genuine re-admission (new entry date breaks the identity key)', () => {
  const { app } = loadApp({});
  // Same person re-admitted to the same house after the discharge: NEW date.
  app.state.patients = [app.normalizePatient({ ...PATIENT, date: '2026-08-14', fromLead: 'L9' })];
  app.state.dischargedPatients = [app.normalizeDischargedPatient(AUDIT_BASE)];
  assert.strictEqual(app.healClobberedDischarges().length, 0);
  assert.strictEqual(app.state.patients[0].status, 'active',
    'the new stay must never be released by the old audit row');
});

test('END-TO-END: a stale-session clobber is healed on the next load and persisted', async () => {
  // Sheet state after the clobber: patient active again, audit row intact.
  const getDataPayload = {
    ok: true,
    leads: [],
    patients: { ramot: [{ ...PATIENT }] },
    irrelevantLeads: [], removedLeads: [],
    dischargedPatients: [{ ...AUDIT_BASE }],
    billingOverrides: [], houseManagers: {}, managerPhones: {},
  };
  const { app, calls } = loadApp({});
  app.state.mode = 'edit';
  // Simulate loadAll's ingest → promote/retire → heal → conditional persist,
  // using the same primitives loadAll calls (loadAll itself needs live fetch
  // plumbing; the wiring below mirrors its exact order).
  app.state.leads = [];
  app.state.patients = [app.normalizePatient(getDataPayload.patients.ramot[0])];
  app.state.dischargedPatients = getDataPayload.dischargedPatients.map(app.normalizeDischargedPatient);

  const healed = app.healClobberedDischarges();
  assert.strictEqual(healed.length, 1);
  if (healed.length > 0) await app.saveAll(); // loadAll persists when healed>0

  const save = calls.find(c => c && c.action === 'saveAll');
  assert.ok(save, 'the heal is persisted back to the sheet');
  assert.strictEqual(save.patients.ramot[0].status, 'released',
    'the persisted payload re-releases the clobbered patient');
});

/* ===== loadAll wiring guard (source-level) ===== */

test('loadAll runs the heal and persists when healed > 0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const loadAllBody = src.slice(src.indexOf('async function loadAll()'), src.indexOf('function admissionMeetingOutcome'));
  assert.ok(/const healed\s*=\s*healClobberedDischarges\(\)/.test(loadAllBody),
    'loadAll must invoke healClobberedDischarges');
  assert.ok(/promoted\.length > 0 \|\| retired\.length > 0 \|\| healed\.length > 0/.test(loadAllBody),
    'the post-load persist condition must include healed discharges');
});
