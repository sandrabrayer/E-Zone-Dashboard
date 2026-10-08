'use strict';

/* Coordinators roster — Dashboard UI pure helpers (public/app.js), vm-loaded
 * like test/discharge-enhancements.test.js. The real-browser flow is in
 * test/coordinators-roster-browser.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function loadApp() {
  const epilogue = `
    globalThis.__test = { coordinatorDischarges, intakeFormFields, intakeMissingFields, normalizeDischargedPatient };
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
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();
const arr = (x) => JSON.parse(JSON.stringify(x));

const TODAY = '2026-10-04';
const coord = (o) => Object.assign({ dischargeSource: 'ezone-coordinators', restored: '', name: 'x',
  houseId: 'ramot', dischargedAt: '2026-10-01T10:00:00Z' }, o);

test('coordinatorDischarges: only coordinators rows, last 30 days, restored hidden, newest first', () => {
  const rows = arr(app.coordinatorDischarges([
    coord({ id: 'a', exitDate: '2026-10-01' }),
    coord({ id: 'b', exitDate: '2026-10-03' }),
    coord({ id: 'edge', exitDate: '2026-09-04' }),           // exactly 30 days → kept
    coord({ id: 'old', exitDate: '2026-09-03' }),            // 31 days → dropped
    coord({ id: 'restored', exitDate: '2026-10-02', restored: 'TRUE' }),
    coord({ id: 'restoredBool', exitDate: '2026-10-02', restored: true }),
    { id: 'own', exitDate: '2026-10-02', dischargeSource: '' }, // the Dashboard's own discharge
    { id: 'own2', exitDate: '2026-10-02' },
    coord({ id: 'noExit', exitDate: '', dischargedAt: '2026-10-02T09:00:00Z' }), // falls back to dischargedAt
    null,
  ], TODAY));
  assert.deepStrictEqual(rows.map((r) => r.id), ['b', 'noExit', 'a', 'edge']);
});

test('coordinatorDischarges: tolerates a missing list', () => {
  assert.deepStrictEqual(arr(app.coordinatorDischarges(undefined, TODAY)), []);
});

test('intake form: required fields are EXACTLY name, house, admission date; no status field; pay optional', () => {
  const f = arr(app.intakeFormFields(true, 'ramot', TODAY));
  assert.deepStrictEqual(f.filter((x) => x.required).map((x) => x.name), ['name', 'houseId', 'date']);
  assert.ok(!f.some((x) => x.name === 'status'), 'a new inpatient is always active');
  assert.strictEqual(f.find((x) => x.name === 'date').value, TODAY);
  assert.strictEqual(f.find((x) => x.name === 'houseId').value, 'ramot');
  // The legacy direct-add form keeps its status picker and required amount.
  const legacy = arr(app.intakeFormFields(false, 'ramot', TODAY));
  assert.deepStrictEqual(legacy.filter((x) => x.required).map((x) => x.name), ['name', 'houseId', 'date', 'pay']);
  assert.ok(legacy.some((x) => x.name === 'status'));
});

test('intakeMissingFields: names what is missing; intake does not require the amount', () => {
  assert.deepStrictEqual(arr(app.intakeMissingFields({ name: 'א', houseId: 'ramot', date: TODAY, pay: '' }, true)), []);
  assert.deepStrictEqual(arr(app.intakeMissingFields({ name: ' ', houseId: 'nope', date: '04/10/2026' }, true)),
    ['שם מטופל', 'בית', 'תאריך כניסה']);
  assert.deepStrictEqual(arr(app.intakeMissingFields({ name: 'א', houseId: 'ramot', date: TODAY, pay: '' }, false)), ['סכום חודשי']);
});

test('normalizeDischargedPatient carries the coordinators audit columns (a restore must not blank them)', () => {
  const d = app.normalizeDischargedPatient({ id: 'c1', houseId: 'ramot', name: 'א', date: '2026-08-01',
    dischargeSource: 'ezone-coordinators', dischargedBy: 'רכזת', dischargeReason: 'סיים', patientId: 'id-a' });
  assert.deepStrictEqual([d.dischargeSource, d.dischargedBy, d.dischargeReason, d.patientId],
    ['ezone-coordinators', 'רכזת', 'סיים', 'id-a']);
  const own = app.normalizeDischargedPatient({ id: 'd1', houseId: 'ramot', name: 'ב' });
  assert.deepStrictEqual([own.dischargeSource, own.dischargedBy, own.dischargeReason, own.patientId], ['', '', '', '']);
});

test('index.html: the intake button is a top-level dashboard action; the panel sits on the dashboard', () => {
  const dash = HTML_SRC.slice(HTML_SRC.indexOf('id="screen-dashboard"'), HTML_SRC.indexOf('id="screen-leads"'));
  assert.match(dash, /id="intake-patient-btn"[^>]*>🟢 קליטת מטופל חדש</);
  assert.match(dash, /id="coord-discharges"/);
  assert.match(dash, /🚪 שחרורים מהבתים/);
  // The panel holds no money, so it is NOT a data-finance widget.
  assert.doesNotMatch(dash.slice(dash.indexOf('id="coord-discharges"') - 80, dash.indexOf('id="coord-discharges"')), /data-finance/);
  assert.match(APP_SRC, /getElementById\('intake-patient-btn'\)/);
  assert.match(APP_SRC, /openDirectAddPatientModal\(\{ intake: true \}\)/);
});

test('the panel renders with textContent only (values come from another app)', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('function renderCoordinatorDischarges'), APP_SRC.indexOf('function renderDischargedPatients'));
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn.replace("list.innerHTML = '';", ''), /innerHTML/);
});
