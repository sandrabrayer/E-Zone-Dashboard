/* Tests for the discharge → Outpatient cross-app lead write in public/app.js
 * (PR 3).
 *
 * Covers:
 *   - the trigger fires ONLY for disposition === 'released_outpatient';
 *   - the { name, phone, house, note } field mapping (phone joined from the
 *     originating lead; house resolved to its Hebrew name; empty-phone fallback);
 *   - the non-fatal contract: a failed Outpatient write neither throws out of
 *     createOutpatientLead nor mutates any discharge state, so it can never roll
 *     back the (already-persisted) local discharge.
 *
 * Same vm-sandbox approach as the sibling suites: read app.js, append an
 * epilogue exposing the functions under test, evaluate in a sandbox with browser
 * globals stubbed. For the non-fatal test we stub `fetch` (to reject) and give
 * document.getElementById a minimal fake element so showError/showToast — which
 * the real catch path calls — don't throw on a null node. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp({ fetchImpl } = {}) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__test = {
      setLeads(a) { state.leads = a; },
      setPatients(a) { state.patients = a; },
      setDischarged(a) { state.dischargedPatients = a; },
      getPatients() { return state.patients; },
      getDischarged() { return state.dischargedPatients; },
      shouldCreateOutpatientLead,
      outpatientLeadPayload,
      createOutpatientLead,
    };
  `;

  const noop = () => {};
  // Minimal fake element so showError (el.textContent / el.classList) and
  // showToast don't throw when the catch path runs in the non-fatal test.
  const fakeEl = { textContent: '', classList: { add: noop, remove: noop, toggle: noop } };

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => fakeEl },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

const PATIENT = {
  id: 'P1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-01-10',
  status: 'released', exitDate: '2026-06-28', fromLead: 'L1',
  source: 'ליד', notes: 'הערה כללית',
};

/* ===== trigger fires only for released_outpatient ===== */

test('trigger is true only for released_outpatient', () => {
  assert.strictEqual(app.shouldCreateOutpatientLead('released_outpatient'), true);
});

test('trigger is false for the other dispositions and empties', () => {
  ['completed', 'stopped_early', 'not_relevant', '', undefined, null].forEach(d => {
    assert.strictEqual(app.shouldCreateOutpatientLead(d), false, `should be false for ${d}`);
  });
});

/* ===== field mapping ===== */

test('payload maps name/phone/house/note with phone joined from the lead', () => {
  const lead = { id: 'L1', phone: '052-765-4321', name: 'דנה כהן' };
  const payload = app.outpatientLeadPayload(PATIENT, lead);
  assert.strictEqual(payload.name, 'דנה כהן');
  assert.strictEqual(payload.phone, '052-765-4321');
  assert.strictEqual(payload.house, 'arfoni');          // stable houseId KEY, not Hebrew name
  assert.strictEqual(payload.note, 'ליד — הערה כללית');  // source + notes
});

test('phone is empty when the patient has no originating lead', () => {
  const payload = app.outpatientLeadPayload(PATIENT, null);
  assert.strictEqual(payload.phone, '');
  assert.strictEqual(payload.name, 'דנה כהן');
  assert.strictEqual(payload.house, 'arfoni');
});

test('house is always the raw houseId key (Outpatient maps it), never a Hebrew name', () => {
  assert.strictEqual(app.outpatientLeadPayload(PATIENT, null).house, 'arfoni');
  const odd = { ...PATIENT, houseId: 'mystery' };
  assert.strictEqual(app.outpatientLeadPayload(odd, null).house, 'mystery');
});

test('note is source + notes combined, and never leaks the exit date', () => {
  assert.strictEqual(app.outpatientLeadPayload(PATIENT, null).note, 'ליד — הערה כללית');
  // source only
  assert.strictEqual(app.outpatientLeadPayload({ ...PATIENT, notes: '' }, null).note, 'ליד');
  // notes only
  assert.strictEqual(app.outpatientLeadPayload({ ...PATIENT, source: '' }, null).note, 'הערה כללית');
  // neither → empty string
  assert.strictEqual(app.outpatientLeadPayload({ ...PATIENT, source: '', notes: '' }, null).note, '');
  // the exit date must NOT appear in the note
  assert.ok(!app.outpatientLeadPayload(PATIENT, null).note.includes('2026-06-28'));
});

/* ===== non-fatal: a failed Outpatient write must not throw or roll back ===== */

test('a failed Outpatient write does not throw and does not mutate discharge state', async () => {
  const failing = async () => { throw new Error('network down'); };
  const a = loadApp({ fetchImpl: failing });

  const patient = { ...PATIENT, status: 'released', exitDate: '2026-06-28' };
  a.setLeads([{ id: 'L1', phone: '0500000000' }]);
  a.setPatients([patient]);
  a.setDischarged([{ id: 'P1' }]);

  // Must resolve (not reject) even though the underlying fetch throws.
  await a.createOutpatientLead(patient);

  // Discharge state is untouched — the function never rolls anything back.
  assert.strictEqual(patient.status, 'released');
  assert.strictEqual(patient.exitDate, '2026-06-28');
  assert.strictEqual(a.getPatients().length, 1);
  assert.strictEqual(a.getDischarged().length, 1);
});

test('an ok:false response is also handled non-fatally', async () => {
  const okFalse = async () => ({
    ok: true,                                  // HTTP ok...
    json: async () => ({ ok: false, error: 'unauthorized' }), // ...app-level failure
  });
  const a = loadApp({ fetchImpl: okFalse });
  const patient = { ...PATIENT };
  a.setLeads([]);
  a.setPatients([patient]);
  // Resolves without throwing despite the app-level { ok:false }.
  await a.createOutpatientLead(patient);
  assert.strictEqual(patient.status, 'released');
});
