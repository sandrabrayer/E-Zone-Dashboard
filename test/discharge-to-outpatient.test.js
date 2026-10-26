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
      createOutpatientLead,
      sentIds() { return state.outpatientSentLeadIds; },
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

/* ===== field mapping =====
 * The { name, phone, house, note } mapping moved server-side
 * (CHANGELOG-discharge-outpatient-handoff.md): Code.gs dischargeOutpatientFields_
 * — tested in test/discharge-outpatient-handoff.test.js. The browser sends the
 * discharge row id only. */

test('the browser sends the discharge row id only — never name, phone or house', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, sent: true }) }; };
  const a = loadApp({ fetchImpl });
  assert.strictEqual(await a.createOutpatientLead(PATIENT, 'aud-1'), 'sent');
  assert.deepStrictEqual(calls, [{ url: '/api/outpatient-lead', body: { dischargeId: 'aud-1', manual: false } }]);
  assert.ok(a.sentIds().has('discharge:aud-1'));
});

test('without a discharge row id nothing is sent', async () => {
  let n = 0;
  const a = loadApp({ fetchImpl: async () => { n++; return { ok: true, json: async () => ({}) }; } });
  assert.strictEqual(await a.createOutpatientLead(PATIENT, ''), 'skipped');
  assert.strictEqual(n, 0);
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
  assert.strictEqual(await a.createOutpatientLead(patient, 'P1'), 'failed');

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
  assert.strictEqual(await a.createOutpatientLead(patient, 'P1'), 'failed');
  assert.strictEqual(patient.status, 'released');
});
