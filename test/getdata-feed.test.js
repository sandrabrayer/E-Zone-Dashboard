/* Minimal direct test of the getData_ feed — the one core read path every
 * consumer (Dashboard, ezone-managers) depends on, which until now was only
 * exercised indirectly. Locks the RESPONSE SHAPE: the full key set, patients
 * grouped by houseId, and empty-sheet safety. Added alongside the CI workflow
 * so a green check actually vouches for the feed contract.
 *
 * vm-sandbox + fakeSheet registry, same harness as
 * billing-override-foundation.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            for (let j = 0; j < nc; j++) { if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = ''; }
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const registry = {};
  let uuid = 0;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    Utilities: { formatDate: () => '2026-08-10', getUuid: () => 'uuid' + (++uuid) },
    LockService: { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() { return this; } }) },
    __registry: registry,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => registry[name] || null,
      insertSheet: (name) => (registry[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    getData: () => getData_(),
    LEAD_COLUMNS, PATIENT_COLUMNS,
    LEADS_SHEET, PATIENTS_SHEET,
    seed(name, header, rows) { __registry[name] = null; },
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, registry };
}

/* Every key the two consumers (Dashboard app.js loadAll + ezone-managers) rely
 * on. Append-only contract — a key disappearing from getData is a breaking
 * change for a consumer that may deploy on a different schedule. */
const REQUIRED_KEYS = [
  'ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads',
  'dischargedPatients', 'billingOverrides', 'houseManagers', 'managerPhones',
];

test('getData_ on a fresh (empty) spreadsheet returns the full shape with empty collections', () => {
  const { code } = loadCode();
  const out = code.getData();
  assert.strictEqual(out.ok, true);
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in out, `response must carry '${k}'`);
  }
  assert.deepStrictEqual(arr(out.leads), []);
  assert.deepStrictEqual({ ...out.patients }, {});
  assert.deepStrictEqual(arr(out.billingOverrides), []);
  assert.strictEqual(typeof out.houseManagers, 'object');
  assert.strictEqual(typeof out.managerPhones, 'object');
});

test('getData_ groups patient rows by houseId and passes leads through', () => {
  const { code, registry } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const LC = arr(code.LEAD_COLUMNS);
  const patientRow = (m) => PC.map((c) => (m[c] === undefined ? '' : m[c]));
  const leadRow    = (m) => LC.map((c) => (m[c] === undefined ? '' : m[c]));

  registry[code.PATIENTS_SHEET] = fakeSheet(PC, [
    patientRow({ houseId: 'ramot',  name: 'א', date: '2026-01-01', pay: 9000, status: 'active' }),
    patientRow({ houseId: 'ramot',  name: 'ב', date: '2026-02-01', pay: 8000, status: 'trial' }),
    patientRow({ houseId: 'arfoni', name: 'ג', date: '2026-03-01', pay: 7000, status: 'active' }),
  ]);
  registry[code.LEADS_SHEET] = fakeSheet(LC, [
    leadRow({ id: 'L1', name: 'ליד', stage: 'new', visitTime: '09:15' }),
  ]);

  const out = code.getData();
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(arr(out.patients.ramot.map(p => p.name)), ['א', 'ב']);
  assert.deepStrictEqual(arr(out.patients.arfoni.map(p => p.name)), ['ג']);
  assert.strictEqual(out.leads.length, 1);
  assert.strictEqual(String(out.leads[0].id), 'L1');
  assert.strictEqual(out.leads[0].visitTime, '09:15', 'clean HH:MM passes through unchanged');
});

test('getData_ never drops a row for having extra blank columns (positional read tolerance)', () => {
  const { code, registry } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const short = PC.map((c) => (c === 'houseId' ? 'ramot' : c === 'name' ? 'קצר' : ''));
  registry[code.PATIENTS_SHEET] = fakeSheet(PC, [short]);
  const out = code.getData();
  assert.strictEqual(out.patients.ramot.length, 1);
  assert.strictEqual(out.patients.ramot[0].name, 'קצר');
});
