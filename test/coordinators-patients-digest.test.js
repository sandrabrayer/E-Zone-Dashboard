/* Tests for the coordinators ActivePatients digest in apps-script/Code.gs.
 *
 * Code.gs is Google Apps Script — no module.exports, and its helpers call
 * SpreadsheetApp / PropertiesService / DriveApp / ScriptApp. Like
 * admitted-roster.test.js, we read the source and evaluate it in a vm sandbox,
 * then reach the REAL shipped functions:
 *   - buildActivePatientsRows_ : the pure leads → digest-rows projection
 *     (house mapping, stage filter, no-financial-leak contract)
 *   - rebuildActivePatientsDigest_ : the end-to-end rebuild against an in-memory
 *     digest sheet, proving the whole-tab replace + frozen column contract.
 * This locks the contract against the actual code, not a reimplementation. */

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

  // Shares lexical scope with the top-level consts (DIGEST_COLUMNS, LEAD_COLUMNS,
  // …). We stub the sheet layer so rebuildActivePatientsDigest_ runs against an
  // in-memory Leads fixture and an in-memory digest tab we can inspect.
  const epilogue = `
    let __leads = [];
    let __digestTab = null;   // { header:[], body:[[...]] }
    getOrCreateSheet_ = function () { return {}; };
    readSheet_ = function (sh, columns) {
      if (columns === LEAD_COLUMNS) return __leads;
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
      setLeads(l) { __leads = l || []; },
      setDigestConfigured(v) { globalThis.__digestId = v ? 'SS_ID' : ''; },
      resetTab() { __digestTab = __makeTab(); },
      tab() { return __digestTab; },
      buildRows(leads, nowIso) { return buildActivePatientsRows_(leads, nowIso); },
      rebuild() { return rebuildActivePatientsDigest_(); },
      canonicalHouse(v) { return canonicalDigestHouse_(v); },
      stageActive(v) { return digestStageIsActive_(v); },
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

test('stage filter recognizes בטיפול פעיל (paid) under id and Hebrew labels', () => {
  assert.strictEqual(api.stageActive('paid'), true);
  assert.strictEqual(api.stageActive('בטיפול פעיל'), true);
  assert.strictEqual(api.stageActive('מקדמה שולמה'), true);
  assert.strictEqual(api.stageActive('new'), false);
  assert.strictEqual(api.stageActive('ליד חדש'), false);
  assert.strictEqual(api.stageActive('visit'), false);
  assert.strictEqual(api.stageActive('admitted'), false);
  assert.strictEqual(api.stageActive(''), false);
  assert.strictEqual(api.stageActive(null), false);
});

test('house encoding maps internal ids + Hebrew names to canonical, excludes the rest', () => {
  // Internal ids.
  assert.strictEqual(api.canonicalHouse('asher'), 'raanana');
  assert.strictEqual(api.canonicalHouse('ramot'), 'ramot');
  assert.strictEqual(api.canonicalHouse('arfoni'), 'efroni');
  assert.strictEqual(api.canonicalHouse('rehab'), 'rehab');
  // Hebrew display names.
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

test('projection: only active-stage, in-scope, named leads become rows with the 4-col contract', () => {
  const now = '2026-07-27T09:00:00.000Z';
  const rows = api.buildRows(
    [
      // Active + canonical house + name → included. Financial fields present to
      // prove they never leak into the digest.
      { id: 'L1', name: 'דנה', house: 'asher', stage: 'paid', advance: 5000, note: 'x' },
      // Active but Hebrew-named house → mapped.
      { id: 'L2', name: 'מאיה', house: 'רמות השבים', stage: 'בטיפול פעיל' },
      // Active but excluded house (pardes) → dropped.
      { id: 'L3', name: 'יוסי', house: 'pardes', stage: 'paid' },
      // Not active (still a new lead) → dropped.
      { id: 'L4', name: 'נועה', house: 'ramot', stage: 'new' },
      // Active + in-scope but no name → dropped (a row must name a patient).
      { id: 'L5', name: '   ', house: 'rehab', stage: 'paid' },
      // Admitted (left active treatment) → dropped.
      { id: 'L6', name: 'רון', house: 'arfoni', stage: 'admitted' },
    ],
    now
  );

  assert.strictEqual(rows.length, 2);
  const l1 = rows.find((r) => r.patientId === 'L1');
  const l2 = rows.find((r) => r.patientId === 'L2');
  assert.deepStrictEqual(plain(l1), { house: 'raanana', patientName: 'דנה', patientId: 'L1', updatedAt: now });
  assert.deepStrictEqual(plain(l2), { house: 'ramot', patientName: 'מאיה', patientId: 'L2', updatedAt: now });

  // No-leak contract: every row exposes EXACTLY the four contract keys.
  for (const row of rows) {
    assert.deepStrictEqual(Object.keys(plain(row)).sort(), ['house', 'patientId', 'patientName', 'updatedAt']);
  }
  // Defense in depth: no financial or other Leads field appears under any name.
  const forbidden = ['advance', 'adv', 'pay', 'price', 'pricing', 'debt', 'balance',
    'amount', 'amountPaid', 'note', 'notes', 'stage', 'phone', 'source', 'created'];
  for (const row of rows) {
    for (const f of forbidden) assert.ok(!(f in row), 'leaked field: ' + f);
  }
});

test('rebuild writes the frozen header + body to the ActivePatients tab', () => {
  api.setDigestConfigured(true);
  api.resetTab();
  api.setLeads([
    { id: 'L1', name: 'דנה', house: 'asher', stage: 'paid', advance: 5000 },
    { id: 'L2', name: 'מאיה', house: 'רמות השבים', stage: 'בטיפול פעיל' },
    { id: 'L3', name: 'יוסי', house: 'pardes', stage: 'paid' },
  ]);

  const res = api.rebuild();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);
  assert.match(res.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO 8601 UTC

  const tab = api.tab();
  // Header is exactly the frozen column contract, in order.
  assert.deepStrictEqual(plain(tab._header), plain(api.columns()));
  assert.deepStrictEqual(plain(tab._header), ['house', 'patientName', 'patientId', 'updatedAt']);
  // Body: one row per included lead, columns positional, no financial data.
  assert.strictEqual(tab._body.length, 2);
  assert.deepStrictEqual(plain(tab._body[0]), ['raanana', 'דנה', 'L1', res.updatedAt]);
  assert.deepStrictEqual(plain(tab._body[1]), ['ramot', 'מאיה', 'L2', res.updatedAt]);
});

test('rebuild replaces the body (stale rows disappear on the next rebuild)', () => {
  api.setDigestConfigured(true);
  api.resetTab();

  api.setLeads([{ id: 'L1', name: 'דנה', house: 'asher', stage: 'paid' }]);
  api.rebuild();
  assert.strictEqual(api.tab()._body.length, 1);

  // L1 advances out of active treatment; nobody is active now.
  api.setLeads([{ id: 'L1', name: 'דנה', house: 'asher', stage: 'admitted' }]);
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
