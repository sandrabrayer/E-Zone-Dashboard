/* Corrupted-rows cleanup utilities (apps-script/Code.gs).
 *
 * Context under test: the server.js UTF-8 chunk-split bug (fixed PR #102)
 * wrote U+FFFD replacement characters into Hebrew free text and, because
 * name is part of Patients row identity, also spawned duplicate rows. These
 * utilities scan (read-only), write a human-approval RepairPlan
 * (approved=FALSE), and apply ONLY approved rows — with drift guards,
 * tombstone-first deletes, and audit logging.
 *
 * Locked contracts:
 *   - scanCorruptedRowsNow detects U+FFFD and classifies all four proposal
 *     types (twin / lead / phone match / manual) with ZERO writes;
 *   - the readmission pattern (same fromLead, different entryDate or status)
 *     is NEVER proposed for delete — only the exact-duplicate signature is;
 *   - applyCorruptedRowRepairsNow skips approved=FALSE rows, skips on
 *     cell-value mismatch (row drift), refuses blank newValue;
 *   - deletes re-locate by identity and write the tombstone BEFORE the
 *     Patients mutation (deletePatientRow_ semantics);
 *   - logAudit_ failures never propagate;
 *   - RepairPlan column order is pinned (append-only contract);
 *   - none of the three public functions is dispatchable via handle_.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));
const FFFD = '�';

/* ---------- minimal fake Sheet (op-logging + hide, as sibling tests) ---------- */
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
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
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
    PATIENT_TOMBSTONE_COLUMNS: PATIENT_TOMBSTONE_COLUMNS,
    PATIENTS_TOMBSTONES_SHEET: PATIENTS_TOMBSTONES_SHEET,
    LEAD_COLUMNS: LEAD_COLUMNS,
    LEADS_SHEET: LEADS_SHEET,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    REPAIR_PLAN_COLUMNS: REPAIR_PLAN_COLUMNS,
    REPAIR_PLAN_SHEET: REPAIR_PLAN_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    scan: () => scanCorruptedRowsNow(),
    writePlan: () => writeRepairPlanNow(),
    apply: () => applyCorruptedRowRepairsNow(),
    phoneKey: (raw) => corruptionPhoneKey_(raw),
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
function seedSheet(code, sandbox, sheetName, cols, rows) {
  sandbox.__sheets[sheetName] = fakeSheet(arr(cols), (rows || []).map((f) => rowOf(arr(cols), f)));
  return sandbox.__sheets[sheetName];
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}
function planRow(code, fields) {
  return rowOf(arr(code.REPAIR_PLAN_COLUMNS), fields);
}

const CORRUPT = 'הד' + FFFD + FFFD;      // corrupted name
const CLEAN = 'הדס חלמיש';

/* ===== RepairPlan column contract ===== */

test('RepairPlan column order is PINNED — append-only, same rule as LEAD_COLUMNS', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.REPAIR_PLAN_COLUMNS),
    // 'source' (the proposing repair tier + provenance) was APPENDED at the
    // END with the snapshot-repair tiers — the append-only contract in action.
    ['sheet', 'row', 'column', 'newValue', 'action', 'approved', 'oldValue', 'source'],
    'never insert/delete/reorder RepairPlan columns — new columns go at the END');
});

/* ===== phone normalization (ecosystem rule) ===== */

test('corruptionPhoneKey_: /^0\\d{9}$/ only, 972 prefix folded, Sheets-dropped leading zero healed', () => {
  const { code } = loadCode();
  assert.strictEqual(code.phoneKey('052-555-1234'), '0525551234');
  assert.strictEqual(code.phoneKey('972525551234'), '0525551234');
  assert.strictEqual(code.phoneKey(525551234), '0525551234', '9 digits (Sheets ate the 0) → healed');
  assert.strictEqual(code.phoneKey('12345'), '', 'not a valid IL phone → excluded from matching');
  assert.strictEqual(code.phoneKey(''), '');
  assert.strictEqual(code.phoneKey(null), '');
});

/* ===== A. scanCorruptedRowsNow — classification, read-only ===== */

test('scan classifies all four proposal types and performs ZERO writes', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const LC = arr(code.LEAD_COLUMNS);
  // Patients: (1) corrupted name with a clean same-fromLead twin;
  //           (2) corrupted name whose only clean source is its lead;
  //           (4) corrupted notes with no source anywhere.
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-01', status: 'active', source: 'lead', fromLead: 'id-twin' },
    { houseId: 'ramot', name: CLEAN, date: '2026-08-15', status: 'active', source: 'lead', fromLead: 'id-twin' },
    { houseId: 'ramot', name: 'רו' + FFFD, date: '2026-08-02', status: 'active', source: 'lead', fromLead: 'id-lead-only' },
    { houseId: 'ramot', name: 'שרה', date: '2026-07-01', status: 'active', notes: 'הע' + FFFD + 'רה' },
  ]);
  // Leads: clean name for id-lead-only; (3) a corrupted lead whose phone
  // matches a different clean lead.
  const leadsSh = seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'id-lead-only', name: 'רותם כהן', phone: '0521111111', stage: 'admitted' },
    { id: 'id-corrupt-lead', name: 'ד' + FFFD + 'ה', phone: '052-222-2222', stage: 'new' },
    { id: 'id-phone-source', name: 'דנה לוי', phone: '0522222222', stage: 'new' },
  ]);
  patientsSh.ops.length = 0;
  leadsSh.ops.length = 0;

  const res = code.scan();
  const byValue = {};
  res.cells.forEach((c) => { byValue[c.value] = c; });

  assert.strictEqual(byValue[CORRUPT].proposal, 'repair from twin');
  assert.strictEqual(byValue[CORRUPT].newValue, CLEAN);
  assert.strictEqual(byValue['רו' + FFFD].proposal, 'repair from lead');
  assert.strictEqual(byValue['רו' + FFFD].newValue, 'רותם כהן');
  assert.strictEqual(byValue['ד' + FFFD + 'ה'].proposal, 'repair from phone match');
  assert.strictEqual(byValue['ד' + FFFD + 'ה'].newValue, 'דנה לוי');
  assert.strictEqual(byValue['הע' + FFFD + 'רה'].proposal, 'no source — manual');
  assert.strictEqual(byValue['הע' + FFFD + 'רה'].newValue, '');

  const writes = (sh) => sh.ops.filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear' || o.op === 'fmt');
  assert.deepStrictEqual(writes(patientsSh), [], 'dry run: Patients untouched');
  assert.deepStrictEqual(writes(leadsSh), [], 'dry run: Leads untouched');
  assert.ok(!sandbox.__sheets[code.REPAIR_PLAN_SHEET], 'dry run creates no sheets');
  assert.ok(sandbox.__logs.some((m) => m.includes('NO WRITES')), 'summary logged');
});

test('exact corrupted duplicate (same fromLead+house+entryDate+status, clean twin) → proposed delete; readmission NEVER', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    // exact duplicate pair: one corrupted + one clean, all identity fields equal
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
    { houseId: 'ramot', name: CLEAN, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
    // READMISSION pattern from the live run: released 2026-01-12 + active 2026-08-15
    { houseId: 'ramot', name: 'יע' + FFFD, date: '2026-01-12', status: 'released', exitDate: '2026-03-01', fromLead: 'id-readmit' },
    { houseId: 'ramot', name: 'יעל', date: '2026-08-15', status: 'active', fromLead: 'id-readmit' },
    // both-corrupted exact pair → repair only, never delete
    { houseId: 'arfoni', name: 'ר' + FFFD, date: '2026-08-20', status: 'trial', fromLead: 'id-both' },
    { houseId: 'arfoni', name: FFFD + 'ן', date: '2026-08-20', status: 'trial', fromLead: 'id-both' },
  ]);

  const res = code.scan();
  assert.strictEqual(res.deletes.length, 1, 'exactly ONE delete proposal');
  assert.deepStrictEqual(
    { name: res.deletes[0].name, fromLead: res.deletes[0].fromLead, row: res.deletes[0].row },
    { name: CORRUPT, fromLead: 'id-dup', row: 2 },
    'only the corrupted side of the exact-duplicate pair');

  const keepReasons = plain(res.keepBoth.map((k) => k.fromLead)).sort();
  assert.deepStrictEqual(keepReasons, ['id-both', 'id-readmit'],
    'readmission and both-corrupted pairs are keep-both, never delete');
  const readmit = res.keepBoth.find((k) => k.fromLead === 'id-readmit');
  assert.ok(/readmission/.test(readmit.reason), 'readmission pattern named as the reason');
});

/* ===== B. writeRepairPlanNow ===== */

test('writeRepairPlanNow fills the hidden RepairPlan with approved=FALSE rows (repairs + deletes)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
    { houseId: 'ramot', name: CLEAN, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
  ]);
  const n = code.writePlan();
  assert.strictEqual(n, 2, 'one repair row + one delete row');

  const planSh = sandbox.__sheets[code.REPAIR_PLAN_SHEET];
  assert.ok(planSh, 'RepairPlan created');
  assert.strictEqual(planSh.isSheetHidden(), true, 'hidden');
  const rows = code.readSheet(planSh, arr(code.REPAIR_PLAN_COLUMNS));
  assert.strictEqual(rows.length, 2);
  rows.forEach((r) => assert.strictEqual(String(r.approved), 'FALSE', 'nothing pre-approved'));
  const repair = rows.find((r) => r.action === 'repair');
  const del = rows.find((r) => r.action === 'delete');
  assert.deepStrictEqual(
    { sheet: repair.sheet, column: repair.column, newValue: repair.newValue, oldValue: repair.oldValue },
    { sheet: code.PATIENTS_SHEET, column: 'name', newValue: CLEAN, oldValue: CORRUPT });
  assert.deepStrictEqual(
    { sheet: del.sheet, column: del.column, oldValue: del.oldValue },
    { sheet: code.PATIENTS_SHEET, column: 'name', oldValue: CORRUPT });
});

/* ===== C. applyCorruptedRowRepairsNow ===== */

function withPlan(code, sandbox, planFields) {
  const RC = arr(code.REPAIR_PLAN_COLUMNS);
  seedSheet(code, sandbox, code.REPAIR_PLAN_SHEET, RC, planFields);
}

test('apply executes ONLY approved=TRUE rows; approved=FALSE rows touch nothing', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-01', status: 'active', fromLead: 'id-a' },
    { houseId: 'ramot', name: 'ש' + FFFD + 'ה', date: '2026-07-01', status: 'active', fromLead: 'id-b' },
  ]);
  withPlan(code, sandbox, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: CLEAN, action: 'repair', approved: 'TRUE', oldValue: CORRUPT },
    { sheet: code.PATIENTS_SHEET, row: 3, column: 'name', newValue: 'שרה', action: 'repair', approved: 'FALSE', oldValue: 'ש' + FFFD + 'ה' },
  ]);

  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 1, deleted: 0, skipped: 0 });
  const after = code.readSheet(patientsSh, PC);
  assert.strictEqual(after[0].name, CLEAN, 'approved repair applied');
  assert.strictEqual(after[1].name, 'ש' + FFFD + 'ה', 'unapproved row untouched');

  const audit = auditOf(code, sandbox).filter((a) => a.action === 'corruption_repair');
  assert.strictEqual(audit.length, 1, 'exactly the applied repair audit-logged');
  const d = JSON.parse(audit[0].details);
  assert.deepStrictEqual({ oldValue: d.oldValue, newValue: d.newValue, row: d.row }, { oldValue: CORRUPT, newValue: CLEAN, row: 2 });
});

test('apply skips on cell-value mismatch (row drift) and on blank/corrupted newValue — cell untouched', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'כבר תוקן', date: '2026-08-01', status: 'active' },   // drifted: no longer corrupted
    { houseId: 'ramot', name: 'ד' + FFFD, date: '2026-08-02', status: 'active' },   // plan has no newValue
  ]);
  withPlan(code, sandbox, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: CLEAN, action: 'repair', approved: 'TRUE', oldValue: CORRUPT },
    { sheet: code.PATIENTS_SHEET, row: 3, column: 'name', newValue: '', action: 'repair', approved: 'TRUE', oldValue: 'ד' + FFFD },
    { sheet: 'NoSuchSheet', row: 2, column: 'name', newValue: 'x', action: 'repair', approved: 'TRUE', oldValue: CORRUPT },
  ]);

  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 0, deleted: 0, skipped: 3 });
  const after = code.readSheet(patientsSh, PC);
  assert.strictEqual(after[0].name, 'כבר תוקן', 'drifted cell untouched');
  assert.strictEqual(after[1].name, 'ד' + FFFD, 'blank-newValue row untouched');
  assert.strictEqual(auditOf(code, sandbox).filter((a) => a.action === 'corruption_repair').length, 0);
  assert.ok(sandbox.__logs.some((m) => /SKIP repair/.test(m)), 'skips are logged');
});

test('approved delete: relocated by identity, tombstone written BEFORE the Patients mutation, clean twin survives', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
    { houseId: 'ramot', name: CLEAN, date: '2026-08-15', status: 'active', fromLead: 'id-dup' },
  ]);
  withPlan(code, sandbox, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: '', action: 'delete', approved: 'TRUE', oldValue: CORRUPT },
  ]);
  patientsSh.ops.length = 0;

  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 0, deleted: 1, skipped: 0 });

  const after = code.readSheet(patientsSh, PC);
  assert.deepStrictEqual(plain(after.map((p) => p.name)), [CLEAN], 'corrupted twin gone, clean twin survives');

  // Tombstone (recovery copy) BEFORE any Patients mutation — deletePatientRow_'s
  // fail-hard contract, ordered via the shared opSeq counter.
  const tombSh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  assert.ok(tombSh, 'tombstone sheet written');
  const tombs = code.readSheet(tombSh, arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.deepStrictEqual({ name: tombs[0].name, reason: tombs[0].reason }, { name: CORRUPT, reason: 'user-delete' });
  const tombWrite = tombSh.ops.find((o) => o.op === 'set' && o.r > 1);
  const patientsMut = patientsSh.ops.find((o) => o.op === 'set' || o.op === 'clear');
  assert.ok(tombWrite && patientsMut && tombWrite.seq < patientsMut.seq,
    `tombstone (seq ${tombWrite && tombWrite.seq}) must precede the delete (seq ${patientsMut && patientsMut.seq})`);

  const audit = auditOf(code, sandbox).map((a) => a.action);
  assert.ok(audit.includes('corruption_delete'), 'corruption_delete audit-logged');
});

test('delete skips when the row no longer holds the expected corrupted name (drift) — nothing deleted', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CLEAN, date: '2026-08-15', status: 'active', fromLead: 'id-dup' }, // rows shifted since the plan
  ]);
  withPlan(code, sandbox, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: '', action: 'delete', approved: 'TRUE', oldValue: CORRUPT },
  ]);
  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 0, deleted: 0, skipped: 1 });
  assert.strictEqual(code.readSheet(patientsSh, PC).length, 1, 'nothing deleted on drift');
  assert.ok(!sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], 'no tombstone written either');
});

test('a broken AuditLog sheet never breaks the apply run (logAudit_ fail-soft)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT, date: '2026-08-01', status: 'active' },
  ]);
  sandbox.__sheets[code.AUDIT_LOG_SHEET] = {
    getLastRow() { throw new Error('quota'); },
    getLastColumn() { throw new Error('quota'); },
    getMaxRows() { throw new Error('quota'); },
    getRange() { throw new Error('quota'); },
    setFrozenRows() { throw new Error('quota'); },
    hideSheet() { throw new Error('quota'); },
    isSheetHidden() { throw new Error('quota'); },
  };
  withPlan(code, sandbox, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: CLEAN, action: 'repair', approved: 'TRUE', oldValue: CORRUPT },
  ]);
  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 1, deleted: 0, skipped: 0 }, 'repair applied despite audit failure');
  assert.strictEqual(code.readSheet(patientsSh, PC)[0].name, CLEAN);
});

/* ===== dispatch guard ===== */

test('source-scan: the three cleanup functions are public but never dispatchable via handle_', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  for (const fn of ['scanCorruptedRowsNow', 'writeRepairPlanNow', 'applyCorruptedRowRepairsNow']) {
    assert.ok(new RegExp('function ' + fn + '\\(\\)').test(src), fn + ' is public (Run dropdown)');
  }
  const handleStart = src.indexOf('function handle_');
  const handleEnd = src.indexOf('\nfunction ', handleStart + 1);
  const handleBody = src.slice(handleStart, handleEnd);
  for (const fn of ['scanCorruptedRowsNow', 'writeRepairPlanNow', 'applyCorruptedRowRepairsNow']) {
    assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
  }
});
