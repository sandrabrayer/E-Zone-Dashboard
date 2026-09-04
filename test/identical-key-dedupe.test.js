/* Identical-key patient duplicates (apps-script/Code.gs).
 *
 * Context under test: the Patients sheet has no id column — row identity is
 * patientKey_(houseId, name, entryDate). The corruption-repair pipeline
 * (PRs #105/#107/#108) repaired names cell-by-cell with no key-collision
 * check, so repairing a corrupted twin of an existing clean row minted 2–3
 * rows with the IDENTICAL key (the live אלה פליישר ×3 symptom). Those rows
 * were immortal: replaceHousePatients_ consumes one queued row per payload
 * row and PRESERVES the same-key leftovers on every save, the fromLead-based
 * scanner never sees them (blank/differing fromLead), and deletePatientRow_
 * deletes ALL rows matching the key at once.
 *
 * Locked contracts:
 *   - findDuplicatePatientKeysNow groups by identity key, flags byte-identical
 *     vs differing groups, names the keep row, performs ZERO writes;
 *   - findDuplicatePatientIdsNow's log points at the key scanner;
 *   - collapseDuplicatePatientKeysNow keeps the first fromLead row (else the
 *     first row), tombstones the rest FIRST (fail-hard, reason
 *     'dedupe-identical-key'), audit-logs per group with differing columns,
 *     and is idempotent;
 *   - the repair pipeline refuses a repair whose post-repair key already
 *     exists — plan time (delete proposal only for a same-house+date+status
 *     twin, else manual) AND apply time (skip, never write a duplicate key);
 *   - replaceHousePatients_ drops (tombstones) a byte-identical same-key
 *     leftover of a consumed row and still preserves a differing one;
 *   - neither new public function is dispatchable via handle_ (PR #105
 *     precedent).
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

/* ---------- minimal fake Sheet (op-logging, as sibling tests) ---------- */
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

/* A sheet whose every method throws — the "quota exceeded" stand-in used to
 * prove fail-hard/fail-soft contracts. */
function brokenSheet() {
  const boom = () => { throw new Error('quota'); };
  return {
    getLastRow: boom, getLastColumn: boom, getMaxRows: boom, getRange: boom,
    setFrozenRows: boom, hideSheet: boom, isSheetHidden: boom, appendRow: boom,
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
    saveAll: (l, p) => saveAll_(l, p),
    patientKey: (h, n, d) => patientKey_(h, n, d),
    findIds: () => findDuplicatePatientIdsNow(),
    findKeys: () => findDuplicatePatientKeysNow(),
    collapse: () => collapseDuplicatePatientKeysNow(),
    scan: () => scanCorruptedRowsNow(),
    writePlan: () => writeRepairPlanNow(),
    apply: () => applyCorruptedRowRepairsNow(),
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
function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function tombstonesOf(code, sandbox) {
  const sh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  return sh ? code.readSheet(sh, arr(code.PATIENT_TOMBSTONE_COLUMNS)) : [];
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}

/* The live symptom, verbatim: three rows for the same person, identical
 * name / entryDate / pay / advance, blank fromLead. */
const ELLA = { houseId: 'arfoni', name: 'אלה פליישר', date: '2026-06-29',
               pay: 35000, adv: 0, status: 'active' };
const CORRUPT = 'אל' + FFFD + FFFD;
const CLEAN_ELLA = 'אלה פליישר';

/* ===== A. findDuplicatePatientKeysNow — read-only scanner ===== */

test('scanner groups by identity key, flags byte-identical vs differing, names the keep row — ZERO writes', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    ELLA,                                             // row 2 ─ identical triple
    ELLA,                                             // row 3
    ELLA,                                             // row 4
    { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },          // row 5 — unique
    { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9000, status: 'active' },          // row 6 ─ same key,
    { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'active', fromLead: 'L1' }, // row 7  differing pay/fromLead
  ]);
  patientsSh.ops.length = 0;

  const res = code.findKeys();
  assert.strictEqual(res.length, 2, 'two duplicate groups, the unique row absent');

  const ella = res.find((g) => g.key === code.patientKey('arfoni', CLEAN_ELLA, '2026-06-29'));
  assert.deepStrictEqual(
    plain({ rows: ella.rows.map((r) => r.row), identical: ella.identical, keepRow: ella.keepRow }),
    { rows: [2, 3, 4], identical: true, keepRow: 2 },
    'byte-identical group: keep the FIRST row (no fromLead anywhere)');

  const dana = res.find((g) => g.key === code.patientKey('ramot', 'דנה', '2026-08-15'));
  assert.deepStrictEqual(
    plain({ rows: dana.rows.map((r) => r.row), identical: dana.identical, keepRow: dana.keepRow }),
    { rows: [6, 7], identical: false, keepRow: 7 },
    'differing group flagged NOT byte-identical; the fromLead row wins even later in sheet order');

  const writes = patientsSh.ops.filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear' || o.op === 'fmt');
  assert.deepStrictEqual(writes, [], 'dry run: Patients untouched');
  assert.ok(!sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] && !sandbox.__sheets[code.AUDIT_LOG_SHEET],
    'dry run creates no sheets');
  assert.ok(sandbox.__logs.some((m) => m.includes('No writes performed')), 'summary logged');
  assert.ok(sandbox.__logs.some((m) => m.includes('byte-identical')), 'identical flag logged');
});

test('findDuplicatePatientIdsNow now points at the key scanner (the two scanners are discoverable together)', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [ELLA]);
  code.findIds();
  assert.ok(sandbox.__logs.some((m) => m.includes('findDuplicatePatientKeysNow')),
    'the fromLead scanner log names findDuplicatePatientKeysNow');
});

/* ===== B. collapseDuplicatePatientKeysNow ===== */

test('collapse keeps the fromLead row (else the earliest), tombstones the rest FIRST, audit-logs per group, idempotent', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    ELLA,                                                                                        // row 2 — kept (earliest)
    ELLA,                                                                                        // row 3 — removed
    ELLA,                                                                                        // row 4 — removed
    { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9000, status: 'active' },          // row 5 — removed (no fromLead)
    { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'active', fromLead: 'L1' }, // row 6 — kept (fromLead)
    { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },          // row 7 — untouched
  ]);
  patientsSh.ops.length = 0;

  const res = code.collapse();
  assert.deepStrictEqual(plain(res), { groups: 2, removed: 3 });

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 3, 'one survivor per key plus the unique row');
  assert.strictEqual(after.filter((p) => p.name === CLEAN_ELLA).length, 1, 'אלה פליישר collapsed to ONE row');
  const dana = after.find((p) => p.name === 'דנה');
  assert.deepStrictEqual({ pay: dana.pay, fromLead: dana.fromLead }, { pay: 9500, fromLead: 'L1' },
    'the fromLead row survived the differing group');

  const tombs = tombstonesOf(code, sandbox);
  assert.strictEqual(tombs.length, 3, 'every removed row tombstoned');
  tombs.forEach((t) => assert.deepStrictEqual(
    { reason: t.reason, savedByAction: t.savedByAction },
    { reason: 'dedupe-identical-key', savedByAction: 'collapseDuplicatePatientKeysNow' }));
  assert.strictEqual(tombs.filter((t) => t.name === 'דנה' && t.pay === 9000).length, 1,
    'the removed differing row is fully recoverable from its tombstone');

  // Tombstone BEFORE the Patients rewrite — deletePatientRow_'s fail-hard
  // ordering, proven via the shared opSeq counter.
  const tombSh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  const tombWrite = tombSh.ops.find((o) => o.op === 'set' && o.r > 1);
  const patientsMut = patientsSh.ops.find((o) => o.op === 'set' || o.op === 'clear');
  assert.ok(tombWrite && patientsMut && tombWrite.seq < patientsMut.seq,
    `tombstone (seq ${tombWrite && tombWrite.seq}) must precede the rewrite (seq ${patientsMut && patientsMut.seq})`);

  const audits = auditOf(code, sandbox).filter((a) => a.action === 'patient_dedupe_collapsed');
  assert.strictEqual(audits.length, 2, 'one audit event per group');
  const ellaAudit = JSON.parse(audits.find((a) => a.name === CLEAN_ELLA).details);
  assert.deepStrictEqual(
    { keptRow: ellaAudit.keptRow, removed: ellaAudit.removed, byteIdentical: ellaAudit.byteIdentical, differingColumns: ellaAudit.differingColumns },
    { keptRow: 2, removed: 2, byteIdentical: true, differingColumns: [] });
  const danaAudit = JSON.parse(audits.find((a) => a.name === 'דנה').details);
  assert.strictEqual(danaAudit.byteIdentical, false);
  assert.ok(danaAudit.differingColumns.includes('pay') && danaAudit.differingColumns.includes('fromLead'),
    'differing columns named in the audit details so the tombstone can be consulted');

  // Idempotent: a second run finds nothing.
  assert.deepStrictEqual(plain(code.collapse()), { groups: 0, removed: 0 });
  assert.strictEqual(patientsOf(code, sandbox).length, 3, 'second run removes nothing');
});

test('collapse is fail-HARD on the tombstone write: a broken tombstone sheet aborts with the Patients sheet untouched', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [ELLA, ELLA]);
  sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] = brokenSheet();
  patientsSh.ops.length = 0;

  assert.throws(() => code.collapse(), /quota/, 'the tombstone failure propagates (same contract as deletePatientRow_)');
  assert.strictEqual(patientsOf(code, sandbox).length, 2, 'nothing removed without its recovery copy');
  assert.deepStrictEqual(patientsSh.ops.filter((o) => o.op === 'set' || o.op === 'clear'), [],
    'Patients sheet never mutated');
});

/* ===== C. key-collision guard — plan time ===== */

test('plan time: a repair whose post-repair key exists on a same-house+date+status row becomes a DELETE of the corrupted twin', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const LC = arr(code.LEAD_COLUMNS);
  // The corrupted row's name repairs from its lead to CLEAN_ELLA — but a row
  // with that exact key (same house, same entryDate) and the same status
  // already exists. Blank fromLead on the clean row keeps the old
  // fromLead-pair analysis blind to this group: only the key guard sees it.
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'arfoni', name: CORRUPT, date: '2026-06-29', pay: 35000, status: 'active', fromLead: 'id-ella' },
    { houseId: 'arfoni', name: CLEAN_ELLA, date: '2026-06-29', pay: 35000, status: 'active' },
  ]);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'id-ella', name: CLEAN_ELLA, phone: '0521111111', stage: 'admitted' },
  ]);

  const res = code.scan();
  const finding = res.cells.find((c) => c.value === CORRUPT);
  assert.strictEqual(finding.proposal, 'key collision — delete corrupted twin');
  assert.strictEqual(finding.newValue, '', 'no repair value proposed');
  assert.ok(/key/.test(finding.note), 'the collision is explained in the note');
  assert.deepStrictEqual(plain(res.deletes.map((d) => ({ row: d.row, source: d.source }))),
    [{ row: 2, source: 'key collision — delete corrupted twin' }],
    'exactly one delete proposal, sourced to the key collision');

  const n = code.writePlan();
  assert.strictEqual(n, 1, 'delete row only — no repair row to hand-fill');
  const rows = code.readSheet(sandbox.__sheets[code.REPAIR_PLAN_SHEET], arr(code.REPAIR_PLAN_COLUMNS));
  assert.deepStrictEqual(
    { action: rows[0].action, oldValue: rows[0].oldValue, source: rows[0].source, approved: String(rows[0].approved) },
    { action: 'delete', oldValue: CORRUPT, source: 'key collision — delete corrupted twin', approved: 'FALSE' });
});

test('plan time: a colliding repair whose twin has a DIFFERENT status is classified manual with no newValue — never delete', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'arfoni', name: CORRUPT, date: '2026-06-29', pay: 35000, status: 'active', fromLead: 'id-ella' },
    { houseId: 'arfoni', name: CLEAN_ELLA, date: '2026-06-29', pay: 35000, status: 'released', exitDate: '2026-08-01' },
  ]);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'id-ella', name: CLEAN_ELLA, phone: '0521111111', stage: 'admitted' },
  ]);

  const res = code.scan();
  const finding = res.cells.find((c) => c.value === CORRUPT);
  assert.strictEqual(finding.proposal, 'key collision — manual');
  assert.strictEqual(finding.newValue, '', 'a machine must not pick sides');
  assert.deepStrictEqual(plain(res.deletes), [], 'no delete proposed for a status-differing twin');

  code.writePlan();
  const rows = code.readSheet(sandbox.__sheets[code.REPAIR_PLAN_SHEET], arr(code.REPAIR_PLAN_COLUMNS));
  const manual = rows.find((r) => r.oldValue === CORRUPT);
  assert.deepStrictEqual({ action: manual.action, newValue: manual.newValue },
    { action: 'repair', newValue: '' }, 'manual plan row awaits a hand-filled value');
  assert.ok(String(manual.source).indexOf('key collision — manual') === 0, 'sourced to the collision');
});

/* ===== C. key-collision guard — apply time ===== */

test('apply time: an approved repair whose resulting key already exists is SKIPPED — a duplicate key is never written', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const RC = arr(code.REPAIR_PLAN_COLUMNS);
  // The sheet changed since the plan was written: a clean row with the
  // post-repair key appeared. Row 4's repair is fine and must still apply.
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'arfoni', name: CORRUPT, date: '2026-06-29', pay: 35000, status: 'active' },
    { houseId: 'arfoni', name: CLEAN_ELLA, date: '2026-06-29', pay: 35000, status: 'active' },
    { houseId: 'ramot', name: 'רו' + FFFD, date: '2026-08-01', pay: 9000, status: 'active' },
  ]);
  seedSheet(code, sandbox, code.REPAIR_PLAN_SHEET, RC, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: CLEAN_ELLA, action: 'repair', approved: 'TRUE', oldValue: CORRUPT },
    { sheet: code.PATIENTS_SHEET, row: 4, column: 'name', newValue: 'רותם', action: 'repair', approved: 'TRUE', oldValue: 'רו' + FFFD },
  ]);

  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 1, deleted: 0, skipped: 1 });
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after[0].name, CORRUPT, 'colliding repair NOT applied — cell untouched');
  assert.strictEqual(after[2].name, 'רותם', 'non-colliding repair applied normally');
  assert.strictEqual(after.filter((p) => code.patientKey(p.houseId, p.name, p.date) === code.patientKey('arfoni', CLEAN_ELLA, '2026-06-29')).length,
    1, 'the identical key exists exactly once');
  assert.ok(sandbox.__logs.some((m) => /SKIP repair .*key collision/.test(m)), 'skip reason names the key collision');
});

test('apply time: two twin-merge repairs converging on the same clean name — the first applies, the second is refused', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const RC = arr(code.REPAIR_PLAN_COLUMNS);
  // The exact mechanism that minted the live אלה פליישר triple: same-key-
  // after-repair rows corrupted in different positions, both approved.
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'arfoni', name: 'א' + FFFD + 'ה', date: '2026-06-29', pay: 35000, status: 'active' },
    { houseId: 'arfoni', name: FFFD + 'לה', date: '2026-06-29', pay: 35000, status: 'active' },
  ]);
  seedSheet(code, sandbox, code.REPAIR_PLAN_SHEET, RC, [
    { sheet: code.PATIENTS_SHEET, row: 2, column: 'name', newValue: 'אלה', action: 'repair', approved: 'TRUE', oldValue: 'א' + FFFD + 'ה' },
    { sheet: code.PATIENTS_SHEET, row: 3, column: 'name', newValue: 'אלה', action: 'repair', approved: 'TRUE', oldValue: FFFD + 'לה' },
  ]);

  const res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 1, deleted: 0, skipped: 1 });
  const after = patientsOf(code, sandbox);
  assert.deepStrictEqual(plain(after.map((p) => p.name)), ['אלה', FFFD + 'לה'],
    'second repair refused — identical-key duplicates can no longer be minted');
});

/* ===== D. replaceHousePatients_ stops immortalizing exact duplicates ===== */

test('saveAll: byte-identical same-key leftovers of a consumed row are tombstoned and DROPPED, not preserved', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [ELLA, ELLA, ELLA]);

  // Vered's tab (rightly) carries the person ONCE and edits the pay — the
  // consumed row's ORIGINAL content still matches the two leftovers.
  const res = code.saveAll(null, {
    arfoni: [Object.assign({}, ELLA, { pay: 36000 })],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(plain(res.preserved || {}), {}, 'nothing echoed as preserved — no resync loop');

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1, 'the duplicates are gone for good');
  assert.deepStrictEqual({ name: after[0].name, pay: after[0].pay }, { name: CLEAN_ELLA, pay: 36000 },
    'the payload edit landed on the single surviving row');

  const dedupeTombs = tombstonesOf(code, sandbox).filter((t) => t.reason === 'dedupe-identical-key');
  assert.strictEqual(dedupeTombs.length, 2, 'both dropped leftovers tombstoned');
  dedupeTombs.forEach((t) => assert.strictEqual(t.savedByAction, 'replaceHousePatients_'));
  assert.strictEqual(auditOf(code, sandbox).filter((a) => a.action === 'patient_dedupe_collapsed').length, 2,
    'each drop audit-logged');

  // And the fix is permanent: the next identical save has nothing to drop.
  const res2 = code.saveAll(null, { arfoni: [Object.assign({}, ELLA, { pay: 36000 })] });
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(patientsOf(code, sandbox).length, 1, 'still one row — no duplicate resurrection');
});

test('saveAll: a same-key leftover that DIFFERS from the consumed row keeps today\'s preserve behavior', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    ELLA,
    Object.assign({}, ELLA, { notes: 'הערה חשובה' }), // same key, different notes
  ]);

  const res = code.saveAll(null, { arfoni: [Object.assign({}, ELLA)] });
  assert.strictEqual(res.ok, true);
  const key = code.patientKey('arfoni', CLEAN_ELLA, '2026-06-29');
  assert.deepStrictEqual(plain(res.preserved), { arfoni: [key] },
    'the differing leftover is preserved and echoed for resync, exactly as before');

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 2, 'differing same-key rows are NOT collapsed by saveAll');
  assert.ok(after.some((p) => p.notes === 'הערה חשובה'), 'the differing row survives intact');
  assert.strictEqual(tombstonesOf(code, sandbox).filter((t) => t.reason === 'dedupe-identical-key').length, 0,
    'no dedupe tombstone for a differing row');
});

test('saveAll: when the dedupe tombstone write fails, the leftover is PRESERVED and the save still succeeds (fail-soft)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [ELLA, ELLA]);
  sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] = brokenSheet();

  const res = code.saveAll(null, { arfoni: [Object.assign({}, ELLA)] });
  assert.strictEqual(res.ok, true, 'an audit failure never fails the save');
  assert.strictEqual(patientsOf(code, sandbox).length, 2,
    'nothing destroyed without its recovery copy — the duplicate waits for a later collapse');
});

/* ===== dispatch guard (PR #105 precedent) ===== */

test('source-scan: the two dedupe functions are public but never dispatchable via handle_', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  for (const fn of ['findDuplicatePatientKeysNow', 'collapseDuplicatePatientKeysNow']) {
    assert.ok(new RegExp('function ' + fn + '\\(\\)').test(src), fn + ' is public (Run dropdown)');
  }
  const handleStart = src.indexOf('function handle_');
  const handleEnd = src.indexOf('\nfunction ', handleStart + 1);
  const handleBody = src.slice(handleStart, handleEnd);
  for (const fn of ['findDuplicatePatientKeysNow', 'collapseDuplicatePatientKeysNow']) {
    assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
  }
});
