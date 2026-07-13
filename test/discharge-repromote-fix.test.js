/* Tests for the discharge re-promotion fix in public/app.js.
 *
 * Bug: a discharged patient (e.g. אלה אנגר) reappears as an active/trial
 * patient after reload. dischargePatient marked the patient 'released' but left
 * her SOURCE lead at stage 'entry'/'entered'; on the next loadAll,
 * promoteEnteredLeads — which consulted only state.patients, never
 * state.dischargedPatients — re-created her as a fresh 'trial' patient. So the
 * discharge "didn't stick".
 *
 * Two guards, both exercised here against the REAL shipped code:
 *   Guard 1 (load-side): promoteEnteredLeads skips any entry/entered lead that
 *     matches a NON-RESTORED discharged audit row, by fromLead OR houseId::name.
 *   Guard 2 (discharge-time): dischargePatient retires the resolved source lead
 *     to stage 'admitted', and rolls that back with the patient if a write fails.
 *
 * Same vm-sandbox approach as restore-to-active.test.js: read app.js, append an
 * epilogue exposing the functions under test plus setters for module-scoped
 * `state` and the reassignable function bindings, evaluate in a sandbox with
 * browser globals stubbed. No changes to app.js are required for the tests. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      getState() { return state; },
      setApiPost(fn)   { apiPost   = fn; },
      setSaveAll(fn)   { saveAll   = fn; },
      setRenderAll(fn) { renderAll = fn; },
      setShowError(fn) { showError = fn; },
      setShowToast(fn) { showToast = fn; },
      setShowCloseLeadModal(fn) { showCloseLeadModal = fn; },
      promoteEnteredLeads,
      dischargePatient,
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Promise,
    RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

/* A discharged audit row carries the same fields as a patient (dischargeAuditRow
 * spreads ...patient) plus discharge metadata; the ones that matter for the
 * Guard-1 match are fromLead, houseId, name, and restored. */
function discharged(over) {
  return Object.assign(
    { id: 'aud-1', houseId: 'ramot', name: 'אלה אנגר', date: '2026-01-05',
      pay: 9000, adv: 0, status: 'released', fromLead: 'lead-7',
      exitDate: '2026-06-01', source: 'lead', disposition: 'completed' },
    over || {}
  );
}

function enteredLead(over) {
  return Object.assign(
    { id: 'lead-7', name: 'אלה אנגר', house: 'ramot', stage: 'entry',
      entryDate: '2026-01-05', advance: 0 },
    over || {}
  );
}

/* ===== Guard 1 — promoteEnteredLeads skips discharged leads ===== */

test('Guard 1: does NOT promote an entry lead matched to a discharged row by fromLead', () => {
  app.setRenderAll(() => {});
  app.setState({
    patients: [],
    leads: [enteredLead()],
    dischargedPatients: [discharged()],
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 0);
  assert.strictEqual(app.getState().patients.length, 0);
});

test('Guard 1: does NOT promote an entry lead matched by houseId::name (no fromLead link)', () => {
  app.setRenderAll(() => {});
  // The discharged row has NO fromLead, and the lead's id differs from any audit
  // id — only the houseId::name key can match. Mirrors a hand-entered patient
  // that was later discharged, whose lead re-surfaced with a fresh id.
  app.setState({
    patients: [],
    leads: [enteredLead({ id: 'other-lead-id' })],
    dischargedPatients: [discharged({ fromLead: '' })],
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 0);
  assert.strictEqual(app.getState().patients.length, 0);
});

test('Guard 1: DOES promote when the discharged row is restored===TRUE (restore-to-lead still works)', () => {
  app.setRenderAll(() => {});
  app.setState({
    patients: [],
    leads: [enteredLead()],
    dischargedPatients: [discharged({ restored: 'TRUE' })],
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(app.getState().patients.length, 1);
  assert.strictEqual(created[0].name, 'אלה אנגר');
  assert.strictEqual(created[0].status, 'trial');
  assert.strictEqual(created[0].fromLead, 'lead-7');
});

test('Guard 1: restored===true (boolean) is also treated as restored and re-promotes', () => {
  app.setRenderAll(() => {});
  app.setState({
    patients: [],
    leads: [enteredLead()],
    dischargedPatients: [discharged({ restored: true })],
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 1);
});

test('Guard 1: an unrelated entry lead still promotes even when other discharged rows exist', () => {
  app.setRenderAll(() => {});
  app.setState({
    patients: [],
    leads: [enteredLead({ id: 'lead-99', name: 'מטופל אחר', house: 'arfoni' })],
    dischargedPatients: [discharged()], // different lead / name+house
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].name, 'מטופל אחר');
  assert.strictEqual(created[0].houseId, 'arfoni');
});

/* ===== Guard 2 — dischargePatient retires the source lead ===== */

/* Drives the real dischargePatient by capturing the onConfirm the modal would
 * have been handed, then invoking it directly with a chosen disposition. */
function dischargeHarness({ patient, leads, saveAll, apiPost }) {
  let captured = null;
  const errors = [];
  app.setRenderAll(() => {});
  app.setShowError(m => errors.push(m));
  app.setShowToast(() => {});
  app.setShowCloseLeadModal(({ onConfirm }) => { captured = onConfirm; });
  app.setSaveAll(saveAll || (() => Promise.resolve()));
  app.setApiPost(apiPost || (() => Promise.resolve({ ok: true })));
  app.setState({
    mode: 'edit',
    patients: [patient],
    leads: leads || [],
    dischargedPatients: [],
  });
  app.dischargePatient(patient);
  assert.ok(captured, 'dischargePatient should have opened the closure modal');
  return { confirm: captured, errors };
}

test('Guard 2: sets the source lead stage to admitted when fromLead resolves', async () => {
  const patient = { id: 'P1', houseId: 'ramot', name: 'אלה אנגר', date: '2026-01-05',
    pay: 9000, adv: 0, status: 'active', fromLead: 'lead-7', source: 'lead' };
  const lead = enteredLead(); // id 'lead-7', stage 'entry'
  const h = dischargeHarness({ patient, leads: [lead] });

  await h.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-07-01' });

  assert.strictEqual(patient.status, 'released');
  assert.strictEqual(lead.stage, 'admitted');           // retired
  assert.strictEqual(app.getState().dischargedPatients.length, 1);
  assert.deepStrictEqual(h.errors, []);
});

test('Guard 2: rollback restores the lead prior stage if saveAll rejects', async () => {
  const patient = { id: 'P1', houseId: 'ramot', name: 'אלה אנגר', date: '2026-01-05',
    pay: 9000, adv: 0, status: 'active', fromLead: 'lead-7', source: 'lead' };
  const lead = enteredLead({ stage: 'entry' });
  const h = dischargeHarness({
    patient,
    leads: [lead],
    saveAll: () => Promise.reject(new Error('save failed')),
  });

  await assert.rejects(
    h.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-07-01' }),
    /save failed/
  );

  // Patient AND lead rolled back to their pre-discharge state.
  assert.strictEqual(patient.status, 'active');
  assert.strictEqual(patient.exitDate, undefined);
  assert.strictEqual(lead.stage, 'entry');              // restored, not left at 'admitted'
  assert.strictEqual(app.getState().dischargedPatients.length, 0); // optimistic row dropped
  assert.strictEqual(h.errors.length, 1);
});

test('Guard 2: rollback restores the lead prior stage if the dischargePatient POST rejects', async () => {
  const patient = { id: 'P1', houseId: 'ramot', name: 'אלה אנגר', date: '2026-01-05',
    pay: 9000, adv: 0, status: 'active', fromLead: 'lead-7', source: 'lead' };
  const lead = enteredLead({ stage: 'entered' });
  const h = dischargeHarness({
    patient,
    leads: [lead],
    apiPost: () => Promise.reject(new Error('post failed')),
  });

  await assert.rejects(
    h.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-07-01' }),
    /post failed/
  );

  assert.strictEqual(patient.status, 'active');
  assert.strictEqual(lead.stage, 'entered');            // exact prior stage restored
  assert.strictEqual(app.getState().dischargedPatients.length, 0);
});

test('Guard 2: a hand-entered patient (no fromLead) discharges without throwing; no lead touched', async () => {
  const patient = { id: 'P2', houseId: 'ramot', name: 'ידני', date: '2026-01-05',
    pay: 9000, adv: 0, status: 'active', fromLead: '', source: 'direct_admin' };
  // A lead that merely shares nothing with the patient — must be left alone.
  const bystander = enteredLead({ id: 'lead-x', name: 'מישהו', stage: 'entry' });
  const h = dischargeHarness({ patient, leads: [bystander] });

  await h.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-07-01' });

  assert.strictEqual(patient.status, 'released');
  assert.strictEqual(bystander.stage, 'entry');         // untouched
  assert.deepStrictEqual(h.errors, []);
});

/* ===== integration: the two guards together ===== */

test('integration: a hand-entered patient discharged, then reloaded, is NOT re-promoted (Guard 1 covers no-fromLead)', async () => {
  // Guard 2 can't retire a lead for a hand-entered patient (no fromLead). Guard 1
  // is what blocks re-promotion: after discharge writes an audit row, a matching
  // entry lead (same houseId::name) must not be promoted on the next loadAll.
  const patient = { id: 'P2', houseId: 'ramot', name: 'ידני', date: '2026-01-05',
    pay: 9000, adv: 0, status: 'active', fromLead: '', source: 'direct_admin' };
  const h = dischargeHarness({ patient, leads: [] });
  await h.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-07-01' });

  const auditRows = app.getState().dischargedPatients;
  assert.strictEqual(auditRows.length, 1);

  // Simulate the next loadAll: the source lead re-surfaces at 'entry' (same
  // name+house, no fromLead), the released patient row was dropped, and we
  // re-run promoteEnteredLeads against the discharged audit rows.
  app.setState({
    patients: [],
    leads: [enteredLead({ id: 'resurfaced', name: 'ידני', house: 'ramot', stage: 'entry' })],
    dischargedPatients: auditRows,
  });
  const created = app.promoteEnteredLeads();
  assert.strictEqual(created.length, 0);                // Guard 1 blocks it
  assert.strictEqual(app.getState().patients.length, 0);
});
