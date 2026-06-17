/* Tests for the patient-entryDate / lead-retirement fix in public/app.js.
 *
 * Bug: promoteEnteredLeads() re-stamps a patient's `date` from lead.entryDate on
 * every load, because the originating lead stayed at stage 'entry' forever and
 * the patient<->lead dedup could miss — clobbering any edit the user made to the
 * patient's entry date. Fix: retire the lead to a terminal 'admitted' stage on
 * promotion, plus an idempotent self-heal (retireAdmittedLeads) for leads that
 * are already parked at 'entry' with a matching patient.
 *
 * public/app.js is a browser global script (no module.exports, touches
 * document/location at top level), so — exactly like breakeven-revenue.test.js —
 * we read the source, append an epilogue that closes over `state` + the
 * functions under test, and evaluate it in a vm sandbox with browser globals
 * stubbed. This exercises the REAL shipped functions, not a reimplementation. */

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
      setLeads(a) { state.leads = a; },
      setPatients(a) { state.patients = a; },
      getLeads() { return state.leads; },
      getPatients() { return state.patients; },
      promote() { return promoteEnteredLeads(); },
      retire() { return retireAdmittedLeads(); },
      normalizeStage(v) { return normalizeStage(v); },
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

test('promoteEnteredLeads does not re-stamp an edited patient date on a 2nd run', () => {
  // A patient promoted earlier from lead L1, whose entry date the user later
  // EDITED from the lead's 2026-01-01 to the real move-in date 2026-03-15.
  app.setPatients([
    { id: 'P1', houseId: 'arfoni', name: 'פרק מוסקוביץ', date: '2026-03-15',
      pay: 30000, adv: 0, status: 'trial', fromLead: 'L1' },
  ]);
  // The originating lead is still sitting at stage 'entry' with the OLD date.
  app.setLeads([
    { id: 'L1', name: 'פרק מוסקוביץ', house: 'arfoni', stage: 'entry',
      entryDate: '2026-01-01' },
  ]);

  // First load: dedup by fromLead must skip — no new patient, date untouched.
  const created1 = app.promote();
  assert.strictEqual(created1.length, 0, 'must not create a duplicate patient');
  let patients = app.getPatients();
  assert.strictEqual(patients.length, 1);
  assert.strictEqual(patients[0].date, '2026-03-15', 'edited date must survive promote');

  // Self-heal retires the still-'entry' lead to the terminal 'admitted' stage.
  const retired = app.retire();
  assert.strictEqual(retired.length, 1, 'the matching entry lead must be retired');
  assert.strictEqual(app.getLeads()[0].stage, 'admitted');

  // Second load: the lead is no longer an 'entry' candidate; running promote
  // again is a no-op and the edited date is STILL intact (regression guard).
  const created2 = app.promote();
  assert.strictEqual(created2.length, 0, 'retired lead is no longer a candidate');
  patients = app.getPatients();
  assert.strictEqual(patients.length, 1);
  assert.strictEqual(patients[0].date, '2026-03-15', 'edited date must not revert to lead date');

  // retireAdmittedLeads is idempotent — re-running flips nothing further.
  const retiredAgain = app.retire();
  assert.strictEqual(retiredAgain.length, 0, 'self-heal is idempotent once admitted');
});

test('self-heal matches by houseId::name when the fromLead link is broken', () => {
  // Patient with NO fromLead (e.g. lead id was never persisted, so the link is
  // gone). The houseId::name fallback must still retire the lead.
  app.setPatients([
    { id: 'P2', houseId: 'ramot', name: 'מאיה', date: '2026-04-10',
      pay: 28000, adv: 0, status: 'active', fromLead: '' },
  ]);
  app.setLeads([
    { id: 'L9', name: 'מאיה', house: 'ramot', stage: 'entry', entryDate: '2026-02-02' },
  ]);

  const retired = app.retire();
  assert.strictEqual(retired.length, 1);
  assert.strictEqual(app.getLeads()[0].stage, 'admitted');
  // Patient date untouched by the self-heal.
  assert.strictEqual(app.getPatients()[0].date, '2026-04-10');
});

test("self-heal leaves an 'entry' lead with NO matching patient alone", () => {
  // No patient exists yet for this lead — it's a genuine pending admission that
  // promoteEnteredLeads should still pick up, so retire must not touch it.
  app.setPatients([]);
  app.setLeads([
    { id: 'L5', name: 'דנה', house: 'asher', stage: 'entry', entryDate: '2026-05-01' },
  ]);

  const retired = app.retire();
  assert.strictEqual(retired.length, 0, 'no matching patient → not retired');
  assert.strictEqual(app.getLeads()[0].stage, 'entry');
});

test("normalizeStage round-trips 'admitted' instead of resetting to 'new'", () => {
  assert.strictEqual(app.normalizeStage('admitted'), 'admitted');
  assert.strictEqual(app.normalizeStage('נקלט'), 'admitted');
  // Sanity: a genuinely unknown stage still defaults to 'new'.
  assert.strictEqual(app.normalizeStage('whatever'), 'new');
});
