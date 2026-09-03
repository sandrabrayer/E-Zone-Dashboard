/* Rename handling for lead-linked patients — follow-up to the promotion
 * dedupe guard (PR #103).
 *
 * The regression class under test: Patients identity is name-keyed
 * (houseId::name::entryDate), so Vered's legitimate rename / entry-date edit
 * of a lead-linked patient arrives at replaceHousePatients_ as append-of-new-
 * key (carrying an EXISTING fromLead) + omission-of-old-key. PR #103's guard
 * refused that append, so the edit was dropped: the modal reported success,
 * the old row came back via `preserved`, and the name snapped back on the
 * resync reload — a silent loss, worse than the duplicate it prevented.
 *
 * The fix under test:
 *   1. SAME-house fromLead match → UPDATE the existing row in place (all
 *      fields from the incoming row), audit 'patient_renamed_via_fromLead'
 *      with old→new name. Two pre-existing rows with the same fromLead (the
 *      הדס state) → deterministic FIRST match only, ambiguity audited.
 *   2. Refusal (promote_skipped_duplicate) still fires for the true
 *      duplicate signatures: cross-house match and discharged-non-restored.
 *   3. Client: a non-empty promoteSkipped in the saveAll response surfaces
 *      an error banner (promoteSkippedMessage → showError) — no refusal is
 *      ever silent.
 *
 * vm-sandbox on the REAL shipped sources, per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- minimal fake Sheet (same shape as audit-log-dedupe.test.js) ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  let hidden = false;
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
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
        clearContent() {
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
        },
      };
    },
  };
}

/* ---------- load apps-script/Code.gs with the GAS globals stubbed ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  let uuid = 0;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},
    __digestSheets: {},
    __props: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: () => ({
      getSheetByName: (name) => sandbox.__digestSheets[name] || null,
      insertSheet: (name) => (sandbox.__digestSheets[name] = fakeSheet([], [])),
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty(k, v) { sandbox.__props[k] = v; return this; },
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS: PATIENT_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    DISCHARGED_PATIENT_COLUMNS: DISCHARGED_PATIENT_COLUMNS,
    DISCHARGED_PATIENTS_SHEET: DISCHARGED_PATIENTS_SHEET,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    saveAll: (l, p) => saveAll_(l, p),
    readSheet: (sh, cols) => readSheet_(sh, cols),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

function rowOf(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}
function withPatients(patientFields) {
  const { code, sandbox } = loadCode();
  const cols = arr(code.PATIENT_COLUMNS);
  sandbox.__sheets[code.PATIENTS_SHEET] =
    fakeSheet(cols, (patientFields || []).map((f) => rowOf(cols, f)));
  return { code, sandbox, cols };
}
function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}

const LEAD_ID = 'id-tzxpotqwmth4fh15';

/* ===== 1. rename / entry-date edit land in place (same house) ===== */

test('edit-modal rename of a lead-linked patient lands: old row consumed, new name in place, nothing preserved', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, adv: 500,
      status: 'active', source: 'lead', fromLead: LEAD_ID, notes: 'הערה' },
    { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
  ]);
  // Exactly what saveAll serializes after openEditPatientModal: the FULL house
  // list with the renamed row — the old name is nowhere in the payload.
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', pay: 9500, adv: 500,
        status: 'active', source: 'lead', fromLead: LEAD_ID, notes: 'הערה' },
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual({ ...res.written }, { ramot: 2 });
  assert.deepStrictEqual({ ...res.promoteSkipped }, {}, 'a rename is not a refusal');
  assert.deepStrictEqual({ ...res.preserved }, {},
    'old row consumed by the update — no preserved echo, no resync loop, no tombstone');

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 2, 'row count unchanged — update, not append');
  const hadas = after.find((p) => p.fromLead === LEAD_ID);
  assert.deepStrictEqual(
    { name: hadas.name, pay: hadas.pay, status: hadas.status, notes: hadas.notes },
    { name: 'הדס חלמיש', pay: 9500, status: 'active', notes: 'הערה' },
    'all fields overwritten from the incoming row');

  const renamed = auditOf(code, sandbox).find((a) => a.action === 'patient_renamed_via_fromLead');
  assert.ok(renamed, 'audit-logged as a rename');
  const d = JSON.parse(renamed.details);
  assert.deepStrictEqual(
    { oldName: d.oldName, newName: d.newName, matches: d.matches, ambiguous: d.ambiguous },
    { oldName: 'הדס', newName: 'הדס חלמיש', matches: 1, ambiguous: false });
});

test('entry-date edit of a lead-linked patient lands in place (date is part of the identity key)', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'הדס', date: '2026-08-25', pay: 9000, status: 'active',
              source: 'lead', fromLead: LEAD_ID }],
  });
  assert.deepStrictEqual({ ...res.promoteSkipped }, {});
  assert.deepStrictEqual({ ...res.preserved }, {});
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].date, '2026-08-25', 'entry date updated in place');
  assert.ok(auditOf(code, sandbox).some((a) => a.action === 'patient_renamed_via_fromLead'));
});

/* ===== 2. the true duplicate signatures still refuse ===== */

test('cross-house fromLead match still refuses (promote_skipped_duplicate)', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'arfoni', name: 'הדס', date: '2026-09-01', status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', status: 'trial',
              source: 'lead', fromLead: LEAD_ID }],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 0 });
  assert.deepStrictEqual(plain(res.promoteSkipped.ramot),
    [{ fromLead: LEAD_ID, name: 'הדס חלמיש', reason: 'existing_patient_row' }]);
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1, 'no second row');
  assert.strictEqual(after[0].houseId, 'arfoni', 'the arfoni row untouched');
  assert.ok(auditOf(code, sandbox).some((a) => a.action === 'promote_skipped_duplicate'));
});

test('discharged-non-restored fromLead still refuses; restored=TRUE still re-promotes', () => {
  const { code, sandbox } = withPatients([]);
  const DC = arr(code.DISCHARGED_PATIENT_COLUMNS);
  sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET] = fakeSheet(DC, [
    rowOf(DC, { id: 'p1', houseId: 'ramot', name: 'דנה', date: '2026-05-01',
                fromLead: 'id-lead-dana', restored: '' }),
    rowOf(DC, { id: 'p2', houseId: 'ramot', name: 'רות', date: '2026-04-01',
                fromLead: 'id-lead-rut', restored: 'TRUE' }),
  ]);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'דנה', date: '2026-05-01', status: 'trial', source: 'lead', fromLead: 'id-lead-dana' },
      { houseId: 'ramot', name: 'רות', date: '2026-09-02', status: 'trial', source: 'lead', fromLead: 'id-lead-rut' },
    ],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 1 });
  assert.deepStrictEqual(plain(res.promoteSkipped.ramot),
    [{ fromLead: 'id-lead-dana', name: 'דנה', reason: 'discharged_not_restored' }]);
  assert.deepStrictEqual(arr(patientsOf(code, sandbox)).map((p) => p.name), ['רות']);
});

/* ===== 3. ambiguity: two pre-existing rows with the same fromLead ===== */

test('pre-existing duplicate (the הדס state): the update targets the FIRST match only, ambiguity audited', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
    { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', pay: 0, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  // A payload appends yet another name for the same lead; neither existing
  // row's key is claimed by the payload.
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'הדס כהן', date: '2026-09-01', pay: 9500,
              status: 'active', source: 'lead', fromLead: LEAD_ID }],
  });
  assert.strictEqual(res.ok, true);

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 2, 'row count unchanged — never writes to both, never appends a third');
  assert.deepStrictEqual(arr(after).map((p) => p.name).sort(), ['הדס חלמיש', 'הדס כהן'],
    'FIRST sheet row (הדס) updated; the second duplicate untouched');
  const second = after.find((p) => p.name === 'הדס חלמיש');
  assert.strictEqual(second.pay, 0, 'second duplicate not overwritten');

  const renamed = auditOf(code, sandbox).find((a) => a.action === 'patient_renamed_via_fromLead');
  const d = JSON.parse(renamed.details);
  assert.deepStrictEqual({ matches: d.matches, ambiguous: d.ambiguous, oldName: d.oldName },
    { matches: 2, ambiguous: true, oldName: 'הדס' });
});

test('a sheet row key-matched by another payload row is never consumed by the rename branch', () => {
  // The pre-existing הדס state where the client carries BOTH rows and renames
  // only one of them: the key-matched row must go to its own payload row, and
  // the rename must target the other.
  const { code, sandbox } = withPatients([
    { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
    { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', pay: 8000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  const res = code.saveAll(null, {
    ramot: [
      // renamed copy of the FIRST row (append path, fromLead match)
      { houseId: 'ramot', name: 'הדס לוי', date: '2026-09-01', pay: 9000, status: 'active',
        source: 'lead', fromLead: LEAD_ID },
      // untouched copy of the SECOND row (exact key match)
      { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', pay: 8000, status: 'active',
        source: 'lead', fromLead: LEAD_ID },
    ],
  });
  assert.strictEqual(res.ok, true);
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 2, 'still two rows — no double-consume, no extra append');
  assert.deepStrictEqual(arr(after).map((p) => p.name).sort(), ['הדס חלמיש', 'הדס לוי']);
});

/* ===== 4. client half: promoteSkipped is never silent ===== */

function loadAppPure() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    skippedMsg: (res) => promoteSkippedMessage(res),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

test('promoteSkippedMessage: null unless promoteSkipped is non-empty; message names the refused rows', () => {
  const app = loadAppPure();
  assert.strictEqual(app.skippedMsg(null), null);
  assert.strictEqual(app.skippedMsg({ ok: true }), null, 'old backend without the field');
  assert.strictEqual(app.skippedMsg({ ok: true, promoteSkipped: {} }), null);
  assert.strictEqual(app.skippedMsg({ ok: true, promoteSkipped: { ramot: [] } }), null);
  assert.strictEqual(app.skippedMsg({ ok: true, promoteSkipped: [] }), null, 'wrong shape tolerated');
  const msg = app.skippedMsg({ ok: true, promoteSkipped: {
    ramot: [{ fromLead: 'x', name: 'הדס חלמיש', reason: 'existing_patient_row' }],
  } });
  assert.ok(msg && msg.includes('שורה לא נשמרה — כפילות זוהתה'), 'Hebrew refusal message');
  assert.ok(msg.includes('הדס חלמיש'), 'names the refused row');
});

test('source-scan: saveAll surfaces promoteSkipped through showError — refusals are never silent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function saveAll()');
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf('\n}', start + 1) + 2);
  assert.ok(/promoteSkippedMessage\(res\)/.test(body), 'saveAll routes the response through promoteSkippedMessage');
  assert.ok(/showError\(skippedMsg\)/.test(body), 'a non-empty refusal shows the error banner');
});
