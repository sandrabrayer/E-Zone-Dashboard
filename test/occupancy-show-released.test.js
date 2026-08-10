/* Tests for the תפוסה "הצג משוחררים" toggle (PR-R2).
 *
 *   app.js — visibleOccupancyRows (released hidden unless the session-only
 *            toggle is on; search + house isolation apply either way);
 *            houseOccupancyCount (released NEVER counted, toggle-independent);
 *            auditRowForReleasedPatient (bridges a released house-view row to
 *            its discharged-audit record for the restore-choice modal);
 *            state.showReleasedPatients defaults to false and is session-only
 *            (no localStorage read/write for it).
 *
 * Same vm-sandbox approach as restore-choice-modal.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      getState() { return state; },
      visibleOccupancyRows,
      houseOccupancyCount,
      auditRowForReleasedPatient,
    };
  `;
  const noop = () => {};
  const lsLog = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: {
      getItem: (k) => { lsLog.push(['get', k]); return null; },
      setItem: (k) => { lsLog.push(['set', k]); },
      removeItem: noop,
    },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, lsLog };
}

const { app, lsLog } = loadApp();

const PATIENTS = [
  { houseId: 'ramot', name: 'פעיל א', date: '2026-01-01', status: 'active' },
  { houseId: 'ramot', name: 'ניסיון ב', date: '2026-02-01', status: 'trial' },
  { houseId: 'ramot', name: 'משוחרר ג', date: '2026-03-01', status: 'released', exitDate: '2026-07-01' },
  { houseId: 'arfoni', name: 'פעיל ד', date: '2026-04-01', status: 'active' },
  { houseId: 'arfoni', name: 'משוחרר ה', date: '2026-05-01', status: 'released' },
];

/* ===== visibleOccupancyRows ===== */

test('toggle OFF: released rows are hidden from the list', () => {
  const rows = app.visibleOccupancyRows(PATIENTS, 'ramot', '', false);
  assert.deepStrictEqual(Array.from(rows.map(r => r.name)), ['פעיל א', 'ניסיון ב']);
});

test('toggle ON: released rows appear in the list (their house only)', () => {
  const rows = app.visibleOccupancyRows(PATIENTS, 'ramot', '', true);
  assert.deepStrictEqual(Array.from(rows.map(r => r.name)), ['פעיל א', 'ניסיון ב', 'משוחרר ג']);
});

test('search query applies with the toggle on', () => {
  const rows = app.visibleOccupancyRows(PATIENTS, 'ramot', 'משוחרר', true);
  assert.deepStrictEqual(Array.from(rows.map(r => r.name)), ['משוחרר ג']);
  // and with the toggle off the same query finds nothing (released hidden)
  assert.strictEqual(app.visibleOccupancyRows(PATIENTS, 'ramot', 'משוחרר', false).length, 0);
});

test('house isolation: the toggle never leaks another house\'s released rows', () => {
  const rows = app.visibleOccupancyRows(PATIENTS, 'arfoni', '', true);
  assert.deepStrictEqual(Array.from(rows.map(r => r.name)), ['פעיל ד', 'משוחרר ה']);
});

/* ===== houseOccupancyCount — counts NEVER include released ===== */

test('houseOccupancyCount excludes released regardless of any display state', () => {
  assert.strictEqual(app.houseOccupancyCount(PATIENTS, 'ramot'), 2);   // active + trial
  assert.strictEqual(app.houseOccupancyCount(PATIENTS, 'arfoni'), 1);  // active only
  assert.strictEqual(app.houseOccupancyCount([], 'ramot'), 0);
  assert.strictEqual(app.houseOccupancyCount(null, 'ramot'), 0);
});

/* ===== auditRowForReleasedPatient ===== */

test('prefers the matching NON-RESTORED audit row (prior_status flows to the modal)', () => {
  const released = PATIENTS[2]; // משוחרר ג
  const discharged = [
    { id: 'aud-old', houseId: 'ramot', name: 'משוחרר ג', date: '2026-03-01',
      prior_status: 'trial', restored: 'TRUE' },                       // restored — skipped
    { id: 'aud-live', houseId: 'ramot', name: 'משוחרר ג', date: '2026-03-01',
      prior_status: 'wait', restored: '' },                            // the live audit row
  ];
  const audit = app.auditRowForReleasedPatient(released, discharged);
  assert.strictEqual(audit.id, 'aud-live');
  assert.strictEqual(audit.prior_status, 'wait');
});

test('synthesizes a fallback audit object when no audit row matches (legacy release)', () => {
  const released = { id: 'p-9', houseId: 'ramot', name: 'ותיק', date: '2025-01-01',
                     pay: 8000, adv: 500, fromLead: 'L1', exitDate: '2025-06-01',
                     source: 'lead', notes: 'הערה', status: 'released' };
  const audit = app.auditRowForReleasedPatient(released, []);
  assert.strictEqual(audit.id, 'p-9');
  assert.strictEqual(audit.houseId, 'ramot');
  assert.strictEqual(audit.name, 'ותיק');
  assert.strictEqual(audit.date, '2025-01-01');
  assert.strictEqual(audit.pay, 8000);
  assert.strictEqual(audit.prior_status, '', 'legacy release → blank → restores to active');
  assert.strictEqual(audit.restored, '');
});

test('audit match uses the houseId+name+date key (a different date does not match)', () => {
  const released = PATIENTS[2];
  const discharged = [
    { id: 'aud-x', houseId: 'ramot', name: 'משוחרר ג', date: '2020-01-01', prior_status: 'trial', restored: '' },
  ];
  const audit = app.auditRowForReleasedPatient(released, discharged);
  assert.notStrictEqual(audit.id, 'aud-x', 'date mismatch → synthesized, not the wrong audit row');
});

/* ===== session-only ===== */

test('showReleasedPatients defaults to false and never touches localStorage', () => {
  assert.strictEqual(app.getState().showReleasedPatients, false);
  const touched = lsLog.filter(([, k]) => String(k).toLowerCase().includes('release'));
  assert.deepStrictEqual(Array.from(touched), [], 'no localStorage key involves the toggle');
});
