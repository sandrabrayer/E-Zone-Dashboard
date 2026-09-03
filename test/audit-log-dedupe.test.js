/* Audit log + promotion dedupe guard (apps-script/Code.gs).
 *
 * The bug class under test — the הדס duplicate: the Patients sheet has no id
 * column (identity is houseId::name::entryDate), and promotion is client-side
 * (promoteEnteredLeads) with guards that only consult the promoting tab's
 * IN-MEMORY state. A lead promoted once, then RENAMED, then promoted again by
 * a tab that never saw the first patient row, appends a second row with the
 * SAME fromLead lead-id and a different name — the name-keyed merge cannot
 * match it.
 *
 * The fix under test (this PR):
 *   A. Server-side promotion dedupe guard in replaceHousePatients_: a payload
 *      row that would be APPENDED and carries a non-empty fromLead is refused
 *      when that fromLead already exists on ANY Patients row (all houses,
 *      released included) or has a NON-restored discharged-audit row
 *      (discharge-loop guard). Skips are echoed in the saveAll response
 *      (promoteSkipped), excluded from `written`, and audit-logged.
 *   B. Hidden append-only AuditLog sheet (timestamp|action|fn|patientId|name|
 *      details — APPEND-ONLY, order guard-tested here) written by logAudit_,
 *      which is FAIL-SOFT: a logging failure never breaks the main operation.
 *   C. findDuplicatePatientIdsNow — read-only manual scanner for existing
 *      duplicates; performs zero writes.
 *
 * vm-sandbox on the REAL shipped Code.gs, per the repo convention
 * (see patients-merge-dont-drop.test.js). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
/* vm-sandbox values carry the sandbox realm's prototypes; JSON-normalize before
 * deepStrictEqual so structure, not realm, is compared. */
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- a minimal fake Sheet (merge-test shape + hide support) ---------- */
let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  let hidden = false;
  return {
    grid, ops,
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
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
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
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {
          ops.push({ op: 'clear', seq: ++opSeq, r, c, nr, nc });
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
  const logs = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: (m) => logs.push(String(m)) },
    __sheets: {},
    __digestSheets: {},
    __props: {},
    __logs: logs,
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
    handle: (params) => handle_(params).json,
    saveAll: (l, p) => saveAll_(l, p),
    logAudit: (a, f, id, n, d) => logAudit_(a, f, id, n, d),
    readSheet: (sh, cols) => readSheet_(sh, cols),
    findDuplicates: () => findDuplicatePatientIdsNow(),
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

/* The הדס seed: the lead was already promoted once as 'הדס'. */
const SEED = [
  { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'active',
    source: 'lead', fromLead: LEAD_ID },
  { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
];

/* ===== AuditLog column contract ===== */

test('AuditLog column order is PINNED — append-only, same rule as LEAD_COLUMNS', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.AUDIT_LOG_COLUMNS),
    ['timestamp', 'action', 'fn', 'patientId', 'name', 'details'],
    'never insert/delete/reorder AuditLog columns — new columns go at the END');
});

/* ===== A. promotion dedupe guard ===== */

test('the הדס duplicate: a re-promotion under a NEW name with an existing fromLead is SKIPPED', () => {
  const { code, sandbox } = withPatients(SEED);
  // A stale tab promotes the (renamed) lead again: same fromLead, new name.
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', pay: 0,
              status: 'trial', source: 'lead', fromLead: LEAD_ID }],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual({ ...res.written }, { ramot: 0 }, 'skipped row excluded from written');
  assert.deepStrictEqual(plain(res.promoteSkipped.ramot),
    [{ fromLead: LEAD_ID, name: 'הדס חלמיש', reason: 'existing_patient_row' }]);

  const after = patientsOf(code, sandbox);
  assert.deepStrictEqual(arr(after).map((p) => p.name).sort(), ['הדס', 'שרה'],
    'no second row for the same lead id — the sheet row stands');

  const audit = auditOf(code, sandbox);
  const skip = audit.find((a) => a.action === 'promote_skipped_duplicate');
  assert.ok(skip, 'the skip is audit-logged');
  assert.strictEqual(skip.patientId, LEAD_ID);
  assert.strictEqual(skip.name, 'הדס חלמיש');
  const details = JSON.parse(skip.details);
  assert.strictEqual(details.reason, 'existing_patient_row');
  assert.strictEqual(details.existingName, 'הדס', 'details name the row that already holds the id');
});

test('guard sees the WHOLE sheet: released rows and rows in OTHER houses both block re-promotion', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'arfoni', name: 'רון', date: '2026-06-10', status: 'released',
      exitDate: '2026-08-01', source: 'lead', fromLead: 'id-lead-ron' },
  ]);
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'רון כהן', date: '2026-09-01', pay: 0,
              status: 'trial', source: 'lead', fromLead: 'id-lead-ron' }],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 0 });
  assert.strictEqual(arr(res.promoteSkipped.ramot).length, 1);
  assert.strictEqual(patientsOf(code, sandbox).length, 1, 'released row in another house still blocks');
});

test('guard skips a fromLead with a NON-restored discharged-audit row (discharge-loop guard)', () => {
  const { code, sandbox } = withPatients([]);
  const DC = arr(code.DISCHARGED_PATIENT_COLUMNS);
  sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET] = fakeSheet(DC, [
    rowOf(DC, { id: 'p1', houseId: 'ramot', name: 'דנה', date: '2026-05-01',
                fromLead: 'id-lead-dana', dischargedAt: '2026-08-01T00:00:00Z', restored: '' }),
  ]);
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'דנה', date: '2026-05-01', pay: 0,
              status: 'trial', source: 'lead', fromLead: 'id-lead-dana' }],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 0 });
  assert.deepStrictEqual(plain(res.promoteSkipped.ramot),
    [{ fromLead: 'id-lead-dana', name: 'דנה', reason: 'discharged_not_restored' }]);
  assert.strictEqual(patientsOf(code, sandbox).length, 0, 'discharged lead not re-promoted');
  const skip = auditOf(code, sandbox).find((a) => a.action === 'promote_skipped_duplicate');
  assert.strictEqual(JSON.parse(skip.details).reason, 'discharged_not_restored');
});

test('a restored=TRUE discharged row does NOT block — both restore paths keep re-promoting', () => {
  const { code, sandbox } = withPatients([]);
  const DC = arr(code.DISCHARGED_PATIENT_COLUMNS);
  sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET] = fakeSheet(DC, [
    rowOf(DC, { id: 'p1', houseId: 'ramot', name: 'דנה', date: '2026-05-01',
                fromLead: 'id-lead-dana', restored: 'TRUE' }),
  ]);
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'דנה', date: '2026-09-01', pay: 0,
              status: 'trial', source: 'lead', fromLead: 'id-lead-dana' }],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 1 });
  assert.deepStrictEqual({ ...res.promoteSkipped }, {});
  assert.strictEqual(patientsOf(code, sandbox).length, 1, 're-promotion after restore lands');
});

test('the same fromLead twice WITHIN one payload: first lands, second skipped', () => {
  const { code, sandbox } = withPatients([]);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'הדס', date: '2026-09-01', status: 'trial', source: 'lead', fromLead: LEAD_ID },
      { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', status: 'trial', source: 'lead', fromLead: LEAD_ID },
    ],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 1 });
  assert.deepStrictEqual(arr(patientsOf(code, sandbox)).map((p) => p.name), ['הדס']);
});

test('normal flows unaffected: key-matched replace, fromLead-less append, NEW-lead promotion all land', () => {
  const { code, sandbox } = withPatients(SEED);
  const res = code.saveAll(null, {
    ramot: [
      // exact key match → replace (status flip) — guard never fires on matches
      { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'wait',
        source: 'lead', fromLead: LEAD_ID },
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
      // hand-entered append (no fromLead) → old behavior untouched
      { houseId: 'ramot', name: 'נועה', date: '2026-08-29', pay: 9800, status: 'active', source: 'direct_admin' },
      // fresh promotion of a lead never seen before → lands
      { houseId: 'ramot', name: 'יעל', date: '2026-09-02', pay: 0, status: 'trial', source: 'lead', fromLead: 'id-lead-new' },
    ],
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 4 });
  assert.deepStrictEqual({ ...res.promoteSkipped }, {});
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 4);
  assert.strictEqual(after.find((p) => p.name === 'הדס').status, 'wait', 'replace landed');

  const actions = plain(auditOf(code, sandbox).map((a) => a.action).sort());
  assert.deepStrictEqual(actions, ['patient_added', 'patient_edited', 'promote_created'],
    'edit diff + both append kinds logged; untouched rows log nothing');
});

/* ===== B. logAudit_ fail-soft + hidden sheet ===== */

test('a broken AuditLog sheet NEVER breaks the main operation (fail-soft contract)', () => {
  const { code, sandbox } = withPatients(SEED);
  sandbox.__sheets[code.AUDIT_LOG_SHEET] = {
    getLastRow() { throw new Error('quota'); },
    getLastColumn() { throw new Error('quota'); },
    getMaxRows() { throw new Error('quota'); },
    getRange() { throw new Error('quota'); },
    setFrozenRows() { throw new Error('quota'); },
    hideSheet() { throw new Error('quota'); },
    isSheetHidden() { throw new Error('quota'); },
  };
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'הדס', date: '2026-09-01', pay: 9000, status: 'wait', source: 'lead', fromLead: LEAD_ID },
      { houseId: 'ramot', name: 'נועה', date: '2026-08-29', pay: 9800, status: 'trial', source: 'lead', fromLead: 'id-lead-new' },
    ],
  });
  assert.strictEqual(res.ok, true, 'save succeeded despite the audit failure');
  assert.ok(arr(patientsOf(code, sandbox)).some((p) => p.name === 'נועה'), 'append landed');
  assert.strictEqual(patientsOf(code, sandbox).find((p) => p.name === 'הדס').status, 'wait', 'edit landed');
  // Direct call too — the helper itself must swallow.
  assert.doesNotThrow(() => code.logAudit('x', 'y_', 'id', 'name', { a: 1 }));
});

test('logAudit_ ensures the sheet, hides it, and appends the row with a JSON details string', () => {
  const { code, sandbox } = loadCode();
  code.logAudit('promote_skipped_duplicate', 'replaceHousePatients_', LEAD_ID, 'הדס חלמיש',
    { houseId: 'ramot', reason: 'existing_patient_row' });
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  assert.ok(sh, 'sheet created on first use');
  assert.strictEqual(sh.isSheetHidden(), true, 'hidden — Vered sees nothing new');
  const rows = auditOf(code, sandbox);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(
    { action: rows[0].action, fn: rows[0].fn, patientId: rows[0].patientId, name: rows[0].name },
    { action: 'promote_skipped_duplicate', fn: 'replaceHousePatients_', patientId: LEAD_ID, name: 'הדס חלמיש' });
  assert.deepStrictEqual(JSON.parse(rows[0].details), { houseId: 'ramot', reason: 'existing_patient_row' });
  assert.ok(!isNaN(Date.parse(rows[0].timestamp)), 'ISO timestamp stamped');
});

test('discharge / delete / restore write paths each log one audit row', () => {
  const { code, sandbox } = withPatients(SEED);
  code.handle({ action: 'dischargePatient',
    patient: { id: 'p1', houseId: 'ramot', name: 'הדס', date: '2026-09-01', fromLead: LEAD_ID } });
  code.handle({ action: 'restorePatientToActive', patient: { id: 'p1', name: 'הדס', fromLead: LEAD_ID } });
  code.handle({ action: 'deletePatientRow',
    patient: { houseId: 'ramot', name: 'שרה', date: '2026-07-01' } });
  const actions = plain(auditOf(code, sandbox).map((a) => a.action).sort());
  assert.deepStrictEqual(actions,
    ['patient_deleted', 'patient_discharged', 'patient_restored_active']);
});

/* ===== C. findDuplicatePatientIdsNow (read-only scanner) ===== */

test('findDuplicatePatientIdsNow reports duplicate fromLead ids with row numbers and names — zero writes', () => {
  const { code, sandbox } = withPatients([
    { houseId: 'ramot', name: 'הדס',       date: '2026-09-01', status: 'active', source: 'lead', fromLead: LEAD_ID },
    { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', status: 'active', source: 'lead', fromLead: LEAD_ID },
    { houseId: 'ramot', name: 'שרה', date: '2026-07-01', status: 'active' }, // no fromLead — ignored
    { houseId: 'arfoni', name: 'רון', date: '2026-06-10', status: 'active', source: 'lead', fromLead: 'id-lead-ron' },
  ]);
  const sh = sandbox.__sheets[code.PATIENTS_SHEET];
  sh.ops.length = 0;

  const dupes = code.findDuplicates();
  assert.strictEqual(dupes.length, 1, 'only the doubled id reported');
  assert.strictEqual(dupes[0].fromLead, LEAD_ID);
  assert.deepStrictEqual(plain(arr(dupes[0].rows).map((r) => ({ row: r.row, name: r.name }))),
    [{ row: 2, name: 'הדס' }, { row: 3, name: 'הדס חלמיש' }], '1-based sheet row numbers');

  assert.ok(!sh.ops.some((o) => o.op === 'set' || o.op === 'clear' || o.op === 'fmt'),
    'scanner is READ-ONLY — no writes, no formats');
  assert.ok(sandbox.__logs.some((m) => m.includes(LEAD_ID)), 'duplicate Logger.logged for manual cleanup');
  assert.ok(!sandbox.__sheets[code.AUDIT_LOG_SHEET], 'scanner does not even create sheets');
});

test('source-scan: findDuplicatePatientIdsNow is public (Run dropdown) but never dispatched by handle_', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.ok(/function findDuplicatePatientIdsNow\(\)/.test(src), 'public name, no trailing underscore');
  const handleStart = src.indexOf('function handle_');
  const handleEnd = src.indexOf('\nfunction ', handleStart + 1);
  assert.ok(!src.slice(handleStart, handleEnd).includes('findDuplicatePatientIdsNow'),
    'handle_ must never route to the manual scanner');
});
