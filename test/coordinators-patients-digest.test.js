/* Tests for the coordinators ActivePatients digest in apps-script/Code.gs.
 *
 * Code.gs is Google Apps Script — no module.exports, and its helpers call
 * SpreadsheetApp / PropertiesService / DriveApp / ScriptApp. Like
 * admitted-roster.test.js, we read the source and evaluate it in a vm sandbox,
 * then reach the REAL shipped functions:
 *   - buildActivePatientsRows_ : the pure patients → digest-rows projection
 *     (house mapping, active-status filter, no-financial-leak contract)
 *   - rebuildActivePatientsDigest_ : the end-to-end rebuild against an in-memory
 *     digest sheet, proving the whole-tab replace + frozen column contract.
 * This locks the contract against the actual code, not a reimplementation.
 *
 * The digest exports the active-treatment RESIDENT population (Patients sheet,
 * status active / פעיל), which is the population shown per house on the
 * dashboard's occupancy board — not the pre-admission `paid` kanban leads it
 * used to read. See DIGEST-CONTRACT.md. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDigest() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    'utf8'
  );

  // Shares lexical scope with the top-level consts (DIGEST_COLUMNS,
  // PATIENT_COLUMNS, …). We stub the sheet layer so rebuildActivePatientsDigest_
  // runs against an in-memory Patients fixture and an in-memory digest tab we
  // can inspect.
  const epilogue = `
    let __patients = [];
    let __digestTab = null;   // { header:[], body:[[...]] }
    getOrCreateSheet_ = function () { return {}; };
    readSheet_ = function (sh, columns) {
      if (columns === PATIENT_COLUMNS) return __patients;
      return [];
    };
    // Fake the digest spreadsheet + tab so writeDigestRows_ has something real
    // to clear/write, and we can read back exactly what was persisted.
    function __makeTab() {
      return {
        _header: [],
        _body: [],
        getRange: function (row, col, numRows, numCols) {
          const self = this;
          return {
            setValues: function (vals) {
              if (row === 1) { self._header = vals[0].slice(); }
              else {
                for (let i = 0; i < vals.length; i++) self._body[row - 2 + i] = vals[i].slice();
              }
              return this;
            },
            clearContent: function () { self._body = []; return this; },
          };
        },
        setFrozenRows: function () { return this; },
        getLastRow: function () { return this._body.length + 1; },
      };
    }
    globalThis.__test = {
      setPatients(p) { __patients = p || []; },
      setDigestConfigured(v) { globalThis.__digestId = v ? 'SS_ID' : ''; },
      resetTab() { __digestTab = __makeTab(); },
      tab() { return __digestTab; },
      buildRows(patients, nowIso) { return buildActivePatientsRows_(patients, nowIso); },
      rebuild() { return rebuildActivePatientsDigest_(); },
      canonicalHouse(v) { return canonicalDigestHouse_(v); },
      statusActive(v) { return digestStatusIsActive_(v); },
      columns() { return DIGEST_COLUMNS.slice(); },
      tabName() { return DIGEST_TAB; },
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return key === 'DIGEST_SPREADSHEET_ID'
              ? (sandbox.__digestId || null)
              : null;
          },
          setProperty() { return this; },
        };
      },
    },
    // openById hands back the fake tab through ensureDigestTab_.
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName() { return sandbox.__test.tab(); },
          insertSheet() { return sandbox.__test.tab(); },
        };
      },
      getActiveSpreadsheet() {
        return { getSpreadsheetTimeZone() { return 'Asia/Jerusalem'; } };
      },
    },
    LockService: {
      getScriptLock() {
        return { tryLock() { return true; }, releaseLock() {} };
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.__digestId = '';
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const api = loadDigest();

// Values built inside the vm carry the vm's intrinsic Array/Object prototypes,
// which are not reference-equal to the host's — deepStrictEqual checks that.
// Round-trip through JSON to compare structure in the host realm.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('status filter recognizes active (בטיפול פעיל / פעיל), excludes the rest', () => {
  assert.strictEqual(api.statusActive('active'), true);
  assert.strictEqual(api.statusActive('פעיל'), true);
  assert.strictEqual(api.statusActive('ACTIVE'), true);
  // Non-active residence states and the released state are NOT exported.
  assert.strictEqual(api.statusActive('released'), false);
  assert.strictEqual(api.statusActive('שוחרר'), false);
  assert.strictEqual(api.statusActive('trial'), false);
  assert.strictEqual(api.statusActive('wait'), false);
  assert.strictEqual(api.statusActive(''), false);
  assert.strictEqual(api.statusActive(null), false);
});

test('house encoding maps internal ids + Hebrew names to canonical, excludes the rest', () => {
  // Internal ids (the form the Patients sheet stores in houseId).
  assert.strictEqual(api.canonicalHouse('asher'), 'raanana');
  assert.strictEqual(api.canonicalHouse('ramot'), 'ramot');
  assert.strictEqual(api.canonicalHouse('arfoni'), 'efroni');
  assert.strictEqual(api.canonicalHouse('rehab'), 'rehab');
  // Hebrew display names (accepted for mixed/legacy rows).
  assert.strictEqual(api.canonicalHouse('רעננה אשר'), 'raanana');
  assert.strictEqual(api.canonicalHouse('רמות השבים'), 'ramot');
  assert.strictEqual(api.canonicalHouse('קיסריה עפרוני'), 'efroni');
  assert.strictEqual(api.canonicalHouse('קיסריה ריהאב'), 'rehab');
  // Already-canonical passes through.
  assert.strictEqual(api.canonicalHouse('efroni'), 'efroni');
  // Houses outside the four are excluded, never renamed.
  assert.strictEqual(api.canonicalHouse('pardes'), '');
  assert.strictEqual(api.canonicalHouse('sde'), '');
  assert.strictEqual(api.canonicalHouse('רעננה הפרדס'), '');
  assert.strictEqual(api.canonicalHouse('שדה אליעזר'), '');
  assert.strictEqual(api.canonicalHouse('whatever'), '');
  assert.strictEqual(api.canonicalHouse(''), '');
  assert.strictEqual(api.canonicalHouse(null), '');
});

test('projection: only active, in-scope, named patients become rows with the 4-col contract', () => {
  const now = '2026-07-27T09:00:00.000Z';
  const rows = api.buildRows(
    [
      // Active + canonical house + name → included. Financial fields present to
      // prove they never leak into the digest.
      { houseId: 'asher', name: 'דנה', status: 'active', date: '2026-06-01', pay: 41300, adv: 5000 },
      // Active + Hebrew-named house → mapped.
      { houseId: 'רמות השבים', name: 'מאיה', status: 'פעיל', date: '2026-06-10' },
      // Active but excluded house (pardes) → dropped.
      { houseId: 'pardes', name: 'יוסי', status: 'active' },
      // Released (left active treatment) → dropped.
      { houseId: 'ramot', name: 'נועה', status: 'released' },
      // Active + in-scope but no name → dropped (a row must name a patient).
      { houseId: 'rehab', name: '   ', status: 'active' },
      // Trial (not yet active treatment) → dropped.
      { houseId: 'arfoni', name: 'רון', status: 'trial' },
    ],
    now
  );

  assert.strictEqual(rows.length, 2);
  const dana = rows.find((r) => r.patientName === 'דנה');
  const maya = rows.find((r) => r.patientName === 'מאיה');
  // patientId is a deterministic derived key (Patients sheet has no id column).
  assert.deepStrictEqual(plain(dana), {
    house: 'raanana', patientName: 'דנה', patientId: 'ap:raanana:דנה:2026-06-01', updatedAt: now,
  });
  assert.deepStrictEqual(plain(maya), {
    house: 'ramot', patientName: 'מאיה', patientId: 'ap:ramot:מאיה:2026-06-10', updatedAt: now,
  });

  // No-leak contract: every row exposes EXACTLY the four contract keys.
  for (const row of rows) {
    assert.deepStrictEqual(Object.keys(plain(row)).sort(), ['house', 'patientId', 'patientName', 'updatedAt']);
  }
  // Defense in depth: no financial or other Patients field appears under any name.
  const forbidden = ['pay', 'adv', 'advance', 'price', 'pricing', 'debt', 'balance',
    'amount', 'amountPaid', 'note', 'notes', 'status', 'phone', 'source', 'fromLead', 'date'];
  for (const row of rows) {
    for (const f of forbidden) assert.ok(!(f in row), 'leaked field: ' + f);
  }
});

test('patientId is stable across rebuilds for the same patient', () => {
  const a = api.buildRows([{ houseId: 'arfoni', name: 'קטי', status: 'active', date: '2026-07-19' }], 'T1');
  const b = api.buildRows([{ houseId: 'arfoni', name: 'קטי', status: 'active', date: '2026-07-19' }], 'T2');
  assert.strictEqual(a[0].patientId, b[0].patientId);
  assert.strictEqual(a[0].patientId, 'ap:efroni:קטי:2026-07-19');
});

test('rebuild writes the frozen header + body to the ActivePatients tab', () => {
  api.setDigestConfigured(true);
  api.resetTab();
  api.setPatients([
    { houseId: 'asher', name: 'דנה', status: 'active', date: '2026-06-01', pay: 41300 },
    { houseId: 'רמות השבים', name: 'מאיה', status: 'פעיל', date: '2026-06-10' },
    { houseId: 'pardes', name: 'יוסי', status: 'active' },
    { houseId: 'ramot', name: 'נועה', status: 'released' },
  ]);

  const res = api.rebuild();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);
  assert.match(res.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO 8601 UTC

  const tab = api.tab();
  // Header is exactly the frozen column contract, in order.
  assert.deepStrictEqual(plain(tab._header), plain(api.columns()));
  assert.deepStrictEqual(plain(tab._header), ['house', 'patientName', 'patientId', 'updatedAt']);
  // Body: one row per included patient, columns positional, no financial data.
  assert.strictEqual(tab._body.length, 2);
  assert.deepStrictEqual(plain(tab._body[0]), ['raanana', 'דנה', 'ap:raanana:דנה:2026-06-01', res.updatedAt]);
  assert.deepStrictEqual(plain(tab._body[1]), ['ramot', 'מאיה', 'ap:ramot:מאיה:2026-06-10', res.updatedAt]);
});

test('rebuild replaces the body (stale rows disappear on the next rebuild)', () => {
  api.setDigestConfigured(true);
  api.resetTab();

  api.setPatients([{ houseId: 'asher', name: 'דנה', status: 'active', date: '2026-06-01' }]);
  api.rebuild();
  assert.strictEqual(api.tab()._body.length, 1);

  // דנה is discharged; nobody is active now.
  api.setPatients([{ houseId: 'asher', name: 'דנה', status: 'released', date: '2026-06-01' }]);
  const res = api.rebuild();
  assert.strictEqual(res.count, 0);
  assert.strictEqual(api.tab()._body.length, 0); // stale row cleared
});

test('rebuild no-ops when the digest spreadsheet is not configured', () => {
  api.setDigestConfigured(false);
  const res = api.rebuild();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'digest_not_configured');
});

test('column contract is frozen: exact order and tab name', () => {
  assert.deepStrictEqual(plain(api.columns()), ['house', 'patientName', 'patientId', 'updatedAt']);
  assert.strictEqual(api.tabName(), 'ActivePatients');
});
