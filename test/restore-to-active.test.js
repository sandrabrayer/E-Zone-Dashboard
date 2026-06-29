/* Tests for the restore-to-active feature in public/app.js.
 *
 * Same vm-sandbox approach as breakeven-revenue.test.js: app.js is a browser
 * global script (no module.exports, touches document/location at top level), so
 * we read the source, append an epilogue that exposes the functions under test
 * (and setters for the module-scoped `state` + reassignable function bindings
 * apiPost/saveAll/renderAll/showError/showToast), and evaluate it in a vm
 * context with the browser globals stubbed. No changes to app.js are required. */

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
      matchActivePatientIndex,
      reconstructActivePatientFromAudit,
      buildRestoredToActivePatients,
      restoreNeedsOutpatientCleanup,
      doRestorePatientToActive,
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

function patient(over) {
  return Object.assign(
    { houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05', pay: 9000, adv: 0,
      status: 'released', fromLead: 'lead-7', exitDate: '2026-06-01',
      source: 'lead', notes: 'הערה' },
    over || {}
  );
}

function audit(over) {
  return Object.assign(
    { id: 'aud-1', houseId: 'ramot', name: 'בעז גילה', date: '2026-01-05',
      pay: 9000, adv: 0, status: 'released', fromLead: 'lead-7', exitDate: '2026-06-01',
      source: 'lead', notes: 'הערה', disposition: 'completed' },
    over || {}
  );
}

/* ===== pure helpers ===== */

test('match-by-houseId+name+date flips the existing row in place (no duplicate)', () => {
  const rows = [patient({ id: 'p-1' }), patient({ houseId: 'arfoni', name: 'אחר', date: '2026-02-02' })];
  const out = app.buildRestoredToActivePatients(rows, audit());
  assert.strictEqual(out.reconstructed, false);
  assert.strictEqual(out.patients.length, rows.length); // no duplicate added
  const flipped = out.patients[0];
  assert.strictEqual(flipped.status, 'active');
  assert.strictEqual(flipped.exitDate, '');
  // original fields preserved
  assert.strictEqual(flipped.pay, 9000);
  assert.strictEqual(flipped.fromLead, 'lead-7');
});

test('post-reload restore (audit id != any patient id) still matches and does NOT duplicate', () => {
  // After a reload, the persisted released row carries a fresh session-local id
  // that differs from the audit row's stored id. Matching by id would miss it
  // and reconstruct -> duplicate. Match by houseId+name+date must flip in place.
  const reloadedRow = patient({ id: 'fresh-session-id-xyz' });
  const out = app.buildRestoredToActivePatients([reloadedRow], audit({ id: 'aud-OLD' }));
  assert.strictEqual(out.reconstructed, false);
  assert.strictEqual(out.patients.length, 1); // no duplicate across the reload
  assert.strictEqual(out.patients[0].status, 'active');
  assert.strictEqual(out.patients[0].exitDate, '');
});

test('reconstruct-only-when-no-match: appends a rebuilt active row when nothing matches', () => {
  const rows = [patient({ houseId: 'arfoni', name: 'מישהו', date: '2026-03-03' })];
  const out = app.buildRestoredToActivePatients(rows, audit());
  assert.strictEqual(out.reconstructed, true);
  assert.strictEqual(out.patients.length, rows.length + 1);
  const rebuilt = out.patients[out.patients.length - 1];
  assert.strictEqual(rebuilt.status, 'active');
  assert.strictEqual(rebuilt.exitDate, '');
  assert.strictEqual(rebuilt.houseId, 'ramot');
  assert.strictEqual(rebuilt.name, 'בעז גילה');
  assert.strictEqual(rebuilt.date, '2026-01-05');
  assert.strictEqual(rebuilt.pay, 9000);
  assert.strictEqual(rebuilt.fromLead, 'lead-7');
  assert.strictEqual(rebuilt.source, 'lead');
  assert.strictEqual(rebuilt.notes, 'הערה');
});

test('buildRestoredToActivePatients never mutates the input array (enables rollback)', () => {
  const original = patient({ id: 'p-1' });
  const rows = [original];
  const out = app.buildRestoredToActivePatients(rows, audit());
  assert.notStrictEqual(out.patients, rows); // new array
  assert.strictEqual(rows[0].status, 'released'); // input untouched
  assert.strictEqual(rows[0].exitDate, '2026-06-01');
});

test('restoreNeedsOutpatientCleanup is true only for released_outpatient', () => {
  assert.strictEqual(app.restoreNeedsOutpatientCleanup(audit({ disposition: 'released_outpatient' })), true);
  assert.strictEqual(app.restoreNeedsOutpatientCleanup(audit({ disposition: 'completed' })), false);
  assert.strictEqual(app.restoreNeedsOutpatientCleanup(audit({ disposition: 'stopped_early' })), false);
  assert.strictEqual(app.restoreNeedsOutpatientCleanup(null), false);
});

/* ===== optimistic handler ===== */

function harness(over) {
  const toasts = [];
  const errors = [];
  app.setRenderAll(() => {});
  app.setShowToast(m => toasts.push(m));
  app.setShowError(m => errors.push(m));
  app.setSaveAll(() => Promise.resolve());
  app.setApiPost(() => Promise.resolve({ ok: true }));
  app.setState({
    mode: 'edit',
    patients: [patient({ id: 'p-1' })],
    dischargedPatients: [audit()],
    leads: [],
  });
  if (over) over({ toasts, errors });
  return { toasts, errors };
}

test('successful restore: row flipped to active in place, audit row flagged restored=TRUE', async () => {
  const h = harness();
  await app.doRestorePatientToActive(audit());
  const st = app.getState();
  assert.strictEqual(st.patients.length, 1);            // no duplicate
  assert.strictEqual(st.patients[0].status, 'active');
  assert.strictEqual(st.patients[0].exitDate, '');
  assert.strictEqual(st.dischargedPatients[0].restored, 'TRUE'); // audit row hidden, kept
  assert.deepStrictEqual(h.toasts, ['המטופל הוחזר לסטטוס פעיל']);
  assert.deepStrictEqual(h.errors, []);
});

test('released_outpatient restore surfaces the manual Outpatient-cleanup note', async () => {
  const h = harness();
  await app.doRestorePatientToActive(audit({ disposition: 'released_outpatient' }));
  assert.strictEqual(h.toasts.length, 2);
  assert.match(h.toasts[1], /אאוטפיישנט/);
});

test('non-released_outpatient restore does NOT surface the cleanup note', async () => {
  const h = harness();
  await app.doRestorePatientToActive(audit({ disposition: 'completed' }));
  assert.strictEqual(h.toasts.length, 1);
});

test('rollback on a failed persist: state restored to previous refs, error shown', async () => {
  const h = harness(() => {
    app.setApiPost(() => Promise.reject(new Error('boom')));
  });
  const st = app.getState();
  const prevPatients = st.patients;
  const prevDischarged = st.dischargedPatients.slice();
  await app.doRestorePatientToActive(audit());
  const after = app.getState();
  assert.strictEqual(after.patients, prevPatients);          // exact previous ref
  // dischargedPatients is rolled back to a slice (matching restorePatient's
  // pattern) — content-equal, restored flag never applied.
  assert.deepStrictEqual(after.dischargedPatients, prevDischarged);
  assert.strictEqual(after.patients[0].status, 'released');  // not flipped
  assert.strictEqual(after.dischargedPatients[0].restored, undefined); // not flagged
  assert.deepStrictEqual(h.toasts, []);
  assert.strictEqual(h.errors.length, 1);
  assert.match(h.errors[0], /נכשלה/);
});

test('rollback also fires when saveAll fails (before the audit flag write)', async () => {
  const h = harness(() => {
    app.setSaveAll(() => Promise.reject(new Error('save failed')));
  });
  await app.doRestorePatientToActive(audit());
  const after = app.getState();
  assert.strictEqual(after.patients[0].status, 'released');
  assert.strictEqual(after.dischargedPatients[0].restored, undefined);
  assert.strictEqual(h.errors.length, 1);
});
