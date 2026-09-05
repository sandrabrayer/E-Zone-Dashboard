'use strict';

/**
 * Coverage for the orphan-payments reconciler + the hardened integrity
 * checker (apps-script/Code.gs, CHANGELOG-orphan-payments-reconcile.md):
 *   - normalizeNameKey_ (shared normalizer): whitespace collapse, trim, NFC;
 *   - orphanPaymentNameRegex_: a run of N U+FFFD stands for 1..N chars,
 *     everything else literal (escaped), anchored;
 *   - orphanPaymentsPlan_ (pure): corrupted → exactly-one candidate renames;
 *     whitespace drift renames; two candidates → tombstone; wrong house →
 *     tombstone; corrupted with no candidate → tombstone; name at a
 *     different entry date → skipped; id collision → skipped;
 *   - previewOrphanPaymentsNow: ZERO writes; reconcileOrphanPaymentsNow:
 *     single-cell writes only, tombstone rows with the legacy reason, one
 *     AuditLog row, IDEMPOTENT (second run = 0 writes, no audit row);
 *   - nightlyIntegrityJob: compares integrityKey_ (normalized names) on both
 *     sides, accepts DischargedPatients rows as known, and a
 *     'legacy_orphan_payment' tombstone silences the payment;
 *   - guards: neither entry point is dispatchable via handle_; the
 *     reconciler never deletes; PATIENT/PAYMENT/TOMBSTONE column contracts
 *     are unchanged.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention (no Jest).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x)); // cross-realm values → plain objects for deepEqual
const FFFD = '�';
const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

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
    appendRow(row) { ops.push({ op: 'append', seq: ++opSeq }); grid.push(row.slice()); },
    deleteRow() { ops.push({ op: 'deleteRow', seq: ++opSeq }); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c, v });
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
  const noop = () => {};
  const logs = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: (m) => logs.push(String(m)) },
    __sheets: {},
    __props: {},
    __logs: logs,
    __lockCalls: 0,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
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
    getUuid: () => 'uuid',
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.LockService = {
    getScriptLock: () => ({ tryLock: () => { sandbox.__lockCalls++; return true; }, releaseLock: noop }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS, PATIENTS_SHEET,
    DISCHARGED_PATIENT_COLUMNS, DISCHARGED_PATIENTS_SHEET,
    PATIENT_TOMBSTONE_COLUMNS, PATIENTS_TOMBSTONES_SHEET,
    PAYMENT_COLUMNS, PAYMENTS_SHEET,
    AUDIT_LOG_COLUMNS, AUDIT_LOG_SHEET,
    LEAD_COLUMNS,
    ORPHAN_PAYMENT_TOMBSTONE_REASON,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    normalizeNameKey: (s) => normalizeNameKey_(s),
    nameRegex: (s) => orphanPaymentNameRegex_(s),
    plan: (rows, cands, known) => orphanPaymentsPlan_(rows, cands, known),
    preview: () => previewOrphanPaymentsNow(),
    reconcile: () => reconcileOrphanPaymentsNow(),
    integrityKey: (h, n, d) => integrityKey_(h, n, d),
    integrityNormalizeKey: (k) => integrityNormalizeKey_(k),
    orphanKeys: (rows, fn, live, tomb) => integrityOrphanKeys_(rows, fn, live, tomb),
    parsePaymentPatientId: (id) => integrityParsePaymentPatientId_(id),
    patientKey: (h, n, d) => patientKey_(h, n, d),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

function rowOf(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}
function seedSheet(sandbox, sheetName, cols, rows) {
  sandbox.__sheets[sheetName] = fakeSheet(arr(cols), (rows || []).map((f) => rowOf(arr(cols), f)));
  return sandbox.__sheets[sheetName];
}
function writeOps(sh) {
  return sh ? sh.ops.filter((o) => o.op !== 'fmt') : [];
}
function allWriteOps(sandbox) {
  return Object.keys(sandbox.__sheets).reduce((n, k) => n + sandbox.__sheets[k].ops.length, 0);
}
function gsFunction(name) {
  const sig = 'function ' + name + '(';
  const start = GS_SRC.indexOf(sig);
  assert.notEqual(start, -1, name + ' not found in Code.gs');
  const open = GS_SRC.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = open; j < GS_SRC.length; j++) {
    if (GS_SRC[j] === '{') depth++;
    else if (GS_SRC[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.notEqual(end, -1, name + ' has unbalanced braces');
  return GS_SRC.slice(start, end + 1);
}

/* Payment row helper: deterministic id + triple, as app.js paymentId() builds. */
function pay(houseId, name, date, due, extra) {
  return Object.assign({
    id: 'pay::' + houseId + '::' + name + '::' + date + '::' + due,
    patientId: houseId + '::' + name + '::' + date,
    patientName: name, houseId, dueDate: due,
    amount: 5000, status: 'unpaid', amountPaid: 0, balance: 5000, timestamp: '2026-01-01T00:00:00.000Z',
  }, extra || {});
}
function planRows(list) {
  return list.map((obj, i) => ({ rowNumber: i + 2, obj }));
}

const TALIA_BAD = 'ט' + FFFD + FFFD + 'יה שוחט';
const TALIA = 'טליה שוחט';
const ORNA_BAD = 'אורנה  אשכנזי';
const ORNA = 'אורנה אשכנזי';

/* ===== A. normalizeNameKey_ ===== */

test('normalizeNameKey_: double space → single, trailing/leading space trimmed, NFC, blanks', () => {
  const { code } = loadCode();
  assert.equal(code.normalizeNameKey(ORNA_BAD), ORNA);
  assert.equal(code.normalizeNameKey('  ' + TALIA + ' '), TALIA);
  assert.equal(code.normalizeNameKey('טליה\t  שוחט'), TALIA, 'tabs / NBSP collapse too');
  assert.equal(code.normalizeNameKey('Å'), 'Å', 'decomposed → precomposed (NFC)');
  assert.equal(code.normalizeNameKey(null), '');
  assert.equal(code.normalizeNameKey(undefined), '');
  assert.equal(code.normalizeNameKey(''), '');
});

/* ===== B. wildcard regex ===== */

test('orphanPaymentNameRegex_: a run of N U+FFFD stands for 1..N chars; clean text literal; anchored', () => {
  const { code } = loadCode();
  const re = code.nameRegex(TALIA_BAD);
  assert.ok(re.test(TALIA), 'two U+FFFD may stand for ONE lost Hebrew char');
  assert.ok(re.test('טוביה שוחט'), 'or for two');
  assert.ok(!re.test('טרובביה שוחט'), 'never for more than the run length');
  assert.ok(!re.test('טיה שוחט'), 'never for zero');
  assert.ok(!re.test('טליה כהן'));
  assert.ok(!re.test('ד"ר טליה שוחט'), 'anchored at the start');
  assert.ok(!re.test(TALIA + ' ב'), 'anchored at the end');
  assert.ok(code.nameRegex('דן (ד.ר) כהן').test('דן (ד.ר) כהן'), 'regex metacharacters are escaped');
  assert.ok(!code.nameRegex('דן (ד.ר) כהן').test('דן (דXר) כהן'));
  assert.ok(code.nameRegex(ORNA_BAD).test(ORNA), 'the regex is built from the NORMALIZED name');
});

/* ===== C. the pure plan ===== */

const CANDS = [
  { houseId: 'ramot',  name: TALIA,        date: '2026-03-01' },
  { houseId: 'ramot',  name: ORNA,         date: '2026-05-01' },
  { houseId: 'ramot',  name: 'אביב שבתאי', date: '2026-04-01' },
  { houseId: 'pardes', name: 'דנה כהן',    date: '2026-01-01' },
  { houseId: 'ramot',  name: 'שרה ' + FFFD + 'וי', date: '2026-02-02' }, // corrupted candidate: never canonical
];
function knownOf(code, cands) {
  const known = {};
  cands.forEach((c) => { known[code.patientKey(c.houseId, c.name, c.date)] = true; });
  return known;
}

test('plan: corrupted name with exactly one same-house candidate → rename patientId + patientName + id', () => {
  const { code } = loadCode();
  const rows = planRows([pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'), pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.scanned, 2);
  assert.equal(plan.orphanKeys, 1);
  assert.equal(plan.tombstones.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.renames.length, 2, 'every payment row of the key is renamed');
  const r = plan.renames[0];
  assert.equal(r.oldName, TALIA_BAD);
  assert.equal(r.newName, TALIA);
  assert.equal(r.newKey, 'ramot::' + TALIA + '::2026-03-01');
  assert.deepEqual(plain(r.cells.map((c) => c.column).sort()), ['id', 'patientId', 'patientName']);
  assert.equal(r.cells.find((c) => c.column === 'patientId').to, 'ramot::' + TALIA + '::2026-03-01');
  assert.equal(r.cells.find((c) => c.column === 'patientName').to, TALIA);
  assert.equal(r.cells.find((c) => c.column === 'id').to, 'pay::ramot::' + TALIA + '::2026-03-01::2026-04-01');
  assert.equal(plan.renames[1].cells.find((c) => c.column === 'id').to, 'pay::ramot::' + TALIA + '::2026-03-01::2026-05-01');
});

test('plan: whitespace-only drift → exact normalized match → rename to the sheet spelling', () => {
  const { code } = loadCode();
  const rows = planRows([pay('ramot', ORNA_BAD, '2026-05-01', '2026-06-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 1);
  assert.equal(plan.renames[0].newName, ORNA);
  assert.equal(plan.tombstones.length, 0);
});

test('plan: two matching candidates → NO rename, tombstone with the ambiguous names', () => {
  const { code } = loadCode();
  const cands = CANDS.concat([{ houseId: 'ramot', name: 'טוביה שוחט', date: '2026-03-01' }]);
  const rows = planRows([pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01')]);
  const plan = code.plan(rows, cands, knownOf(code, cands));
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.tombstones.length, 1);
  const t = plan.tombstones[0];
  assert.equal(t.houseId, 'ramot');
  assert.equal(t.name, TALIA_BAD, 'the payment name AS-IS');
  assert.equal(t.date, '2026-03-01');
  assert.match(t.why, /ambiguous/);
  assert.ok(t.why.includes(TALIA) && t.why.includes('טוביה שוחט'));
  assert.deepEqual(plain(t.paymentIds), ['pay::ramot::' + TALIA_BAD + '::2026-03-01::2026-04-01']);
});

test('plan: wrong house → no match → tombstone (candidates are same-house only)', () => {
  const { code } = loadCode();
  const rows = planRows([pay('pardes', TALIA_BAD, '2026-03-01', '2026-04-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.tombstones.length, 1);
  assert.equal(plan.tombstones[0].houseId, 'pardes');
  assert.equal(plan.tombstones[0].why, 'no candidate');
});

test('plan: corrupted name with no candidate → tombstone; a corrupted CANDIDATE is never canonical', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', 'ש' + FFFD + FFFD + 'ה לוי', '2026-02-02', '2026-03-02'),
    pay('ramot', 'ש' + FFFD + FFFD + 'ה לוי', '2026-02-02', '2026-04-02'),
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.tombstones.length, 1, 'ONE tombstone per orphan key, not per payment row');
  assert.equal(plan.tombstones[0].why, 'no candidate');
  assert.equal(plan.tombstones[0].paymentIds.length, 2);
});

test('plan: a clean name that matches nothing → tombstone (true legacy orphan)', () => {
  const { code } = loadCode();
  const rows = planRows([pay('ramot', 'יוסי לוי', '2025-01-01', '2025-02-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.tombstones.length, 1);
  assert.equal(plan.tombstones[0].name, 'יוסי לוי');
});

test('plan: name matched only at a DIFFERENT entry date → skipped, no write, no tombstone', () => {
  const { code } = loadCode();
  const rows = planRows([pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.tombstones.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /different entry date/);
  assert.equal(plan.skipped[0].detail, TALIA);
});

test('plan: rewritten id would collide with an existing row → that row is skipped untouched', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'),   // collides with the canonical row below
    pay('ramot', TALIA, '2026-03-01', '2026-04-01'),       // already canonical (not an orphan)
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01'),   // no collision → renamed
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01'),   // corrupted TWIN of row 4 → would get the same new id → skipped
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 1);
  assert.equal(plan.renames[0].rowNumber, 4);
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(plain(plan.skipped.map((s) => s.rowNumber)), [2, 5]);
  assert.ok(plan.skipped.every((s) => /duplicate/.test(s.reason)));
  assert.equal(plan.tombstones.length, 0);
});

test('plan: known payments are untouched; blank patientId is healed from the id; unattributable rows skipped silently', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', TALIA, '2026-03-01', '2026-04-01'),
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-06-01', { patientId: '' }),
    { id: 'not-a-payment', patientId: '', patientName: 'x', houseId: 'ramot' },
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.orphanKeys, 1);
  assert.equal(plan.renames.length, 1);
  assert.equal(plan.renames[0].rowNumber, 3);
  assert.equal(plan.skipped.length, 0);
});

/* ===== D. preview / reconcile on fake sheets — writes + idempotency ===== */

function seedScenario(code, sandbox) {
  const PC = code.PATIENT_COLUMNS, DC = code.DISCHARGED_PATIENT_COLUMNS, TC = code.PATIENT_TOMBSTONE_COLUMNS, YC = code.PAYMENT_COLUMNS;
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: TALIA, date: '2026-03-01', pay: 5000, status: 'active', id: 'id-1' },
    { houseId: 'ramot', name: ORNA, date: '2026-05-01', pay: 5000, status: 'active', id: 'id-2' },
  ]);
  seedSheet(sandbox, code.DISCHARGED_PATIENTS_SHEET, DC, [
    { id: 'd-1', houseId: 'ramot', name: 'אביב שבתאי', date: '2026-04-01', status: 'released', dischargedAt: '2026-08-01T00:00:00.000Z' },
  ]);
  seedSheet(sandbox, code.PATIENTS_TOMBSTONES_SHEET, TC, [
    { houseId: 'pardes', name: 'רון לוי', date: '2026-01-10', droppedAt: '2026-06-01T00:00:00.000Z', reason: 'user-delete', savedByAction: 'deletePatientRow' },
  ]);
  const payments = seedSheet(sandbox, code.PAYMENTS_SHEET, YC, [
    pay('ramot', TALIA, '2026-03-01', '2026-04-01'),                      // row 2: fine
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01'),                  // row 3: corrupted → rename
    pay('ramot', ORNA_BAD, '2026-05-01', '2026-06-01'),                   // row 4: whitespace → rename
    pay('ramot', 'אביב שבתא' + FFFD + FFFD, '2026-04-01', '2026-05-01'), // row 5: discharged candidate → rename
    pay('pardes', 'רון לוי', '2026-01-10', '2026-02-10'),                  // row 6: tombstoned already → known
    pay('ramot', 'יוסי לוי', '2025-01-01', '2025-02-01'),                  // row 7: legacy orphan → tombstone
    pay('ramot', 'יוסי לוי', '2025-01-01', '2025-03-01'),                  // row 8: same key → same tombstone
  ]);
  return { payments, tombstones: sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] };
}

test('previewOrphanPaymentsNow: plans everything, performs ZERO writes, no AuditLog sheet', () => {
  const { code, sandbox } = loadCode();
  seedScenario(code, sandbox);
  const summary = code.preview();
  assert.equal(summary.dryRun, true);
  assert.equal(summary.scanned, 7);
  assert.equal(summary.orphanKeys, 4);
  assert.equal(summary.renamed, 3);
  assert.equal(summary.tombstoned, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(allWriteOps(sandbox), 0, 'preview must not touch any sheet');
  assert.equal(sandbox.__sheets[code.AUDIT_LOG_SHEET], undefined, 'preview writes no audit row');
  assert.ok(sandbox.__logs.some((l) => /No writes performed/.test(l)));
});

test('reconcileOrphanPaymentsNow: single-cell renames, tombstone with the legacy reason, audit row, IDEMPOTENT', () => {
  const { code, sandbox } = loadCode();
  const { payments, tombstones } = seedScenario(code, sandbox);
  const YC = arr(code.PAYMENT_COLUMNS), TC = arr(code.PATIENT_TOMBSTONE_COLUMNS);
  const before = payments.grid.map((r) => r.slice());

  const summary = code.reconcile();
  assert.equal(summary.dryRun, false);
  assert.equal(summary.renamed, 3);
  assert.equal(summary.tombstoned, 1);
  assert.equal(sandbox.__lockCalls, 1, 'runs under the script lock');

  // Payments: ONLY setcell ops (never a whole-row / whole-sheet rewrite, never a clear/delete)
  const pOps = writeOps(payments);
  assert.ok(pOps.length > 0);
  assert.ok(pOps.every((o) => o.op === 'setcell'), 'single-cell writes only: ' + JSON.stringify(pOps.map((o) => o.op)));
  const touchedCols = new Set(pOps.map((o) => YC[o.c - 1]));
  assert.deepEqual(arr(touchedCols).sort(), ['id', 'patientId', 'patientName']);

  const after = code.readSheet(payments, YC);
  // row 3: corrupted → canonical, all three identity cells
  assert.equal(after[1].patientName, TALIA);
  assert.equal(after[1].patientId, 'ramot::' + TALIA + '::2026-03-01');
  assert.equal(after[1].id, 'pay::ramot::' + TALIA + '::2026-03-01::2026-05-01');
  // row 4: whitespace drift
  assert.equal(after[2].patientName, ORNA);
  assert.equal(after[2].patientId, 'ramot::' + ORNA + '::2026-05-01');
  // row 5: discharged candidate counts
  assert.equal(after[3].patientName, 'אביב שבתאי');
  assert.equal(after[3].id, 'pay::ramot::אביב שבתאי::2026-04-01::2026-05-01');
  // amounts / dates / status / timestamp untouched everywhere; untouched rows byte-identical
  after.forEach((row, i) => {
    ['dueDate', 'amount', 'status', 'amountPaid', 'balance', 'houseId', 'timestamp'].forEach((col) => {
      assert.equal(String(row[col]), String(before[i + 1][YC.indexOf(col)]), 'row ' + (i + 2) + ' ' + col + ' must be untouched');
    });
  });
  [0, 4, 5, 6].forEach((i) => assert.deepEqual(plain(payments.grid[i + 1]), plain(before[i + 1]), 'row ' + (i + 2) + ' untouched'));

  // Tombstone: ONE row for the legacy key, existing columns, reason + savedByAction + as-is name
  const tombs = code.readSheet(tombstones, TC);
  assert.equal(tombs.length, 2);
  const t = tombs[1];
  assert.equal(t.houseId, 'ramot');
  assert.equal(t.name, 'יוסי לוי');
  assert.equal(t.date, '2025-01-01');
  assert.equal(t.reason, code.ORPHAN_PAYMENT_TOMBSTONE_REASON);
  assert.equal(t.reason, 'legacy_orphan_payment');
  assert.equal(t.savedByAction, 'reconcileOrphanPaymentsNow');
  assert.match(String(t.droppedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(t.notes), /no candidate/);
  assert.ok(String(t.notes).includes('pay::ramot::יוסי לוי::2025-01-01::2025-02-01'));
  assert.equal(t.updatedAt, '', 'not a user edit — no who/when stamp');
  assert.equal(tombstones.grid[0].length, TC.length, 'no new tombstone column');

  // Audit: exactly one event with the counts
  const auditSh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  const audit = code.readSheet(auditSh, arr(code.AUDIT_LOG_COLUMNS));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'orphan_payments_reconciled');
  const details = JSON.parse(audit[0].details);
  assert.equal(details.renamed, 3);
  assert.equal(details.tombstoned, 1);
  assert.equal(details.tombstoneReason, 'legacy_orphan_payment');
  assert.equal(details.stampsRestamped, false);
  assert.ok(Array.isArray(details.examples.renames) && details.examples.renames.length === 3);

  // ---- second run: ZERO writes anywhere, no new audit row ----
  const opsBefore = allWriteOps(sandbox);
  const auditRowsBefore = auditSh.grid.length;
  const second = code.reconcile();
  assert.equal(second.orphanKeys, 0);
  assert.equal(second.renamed, 0);
  assert.equal(second.tombstoned, 0);
  assert.equal(allWriteOps(sandbox), opsBefore, 'second run must perform zero writes');
  assert.equal(auditSh.grid.length, auditRowsBefore, 'second run logs no audit row');
});

test('reconcile: nothing to do → no writes, no tombstone sheet ensure, no audit row', () => {
  const { code, sandbox } = loadCode();
  seedSheet(sandbox, code.PATIENTS_SHEET, code.PATIENT_COLUMNS, [
    { houseId: 'ramot', name: TALIA, date: '2026-03-01', status: 'active' },
  ]);
  seedSheet(sandbox, code.PAYMENTS_SHEET, code.PAYMENT_COLUMNS, [pay('ramot', TALIA, '2026-03-01', '2026-04-01')]);
  const s = code.reconcile();
  assert.equal(s.orphanKeys, 0);
  assert.equal(allWriteOps(sandbox), 0);
  assert.equal(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], undefined);
  assert.equal(sandbox.__sheets[code.AUDIT_LOG_SHEET], undefined);
});

test('reconcile: ambiguous / wrong-house / different-date cases through the real sheets', () => {
  const { code, sandbox } = loadCode();
  seedSheet(sandbox, code.PATIENTS_SHEET, code.PATIENT_COLUMNS, [
    { houseId: 'ramot', name: TALIA, date: '2026-03-01', status: 'active' },
    { houseId: 'ramot', name: 'טוביה שוחט', date: '2026-03-01', status: 'active' },
    { houseId: 'ramot', name: 'דנה כהן', date: '2026-06-01', status: 'active' },
  ]);
  const payments = seedSheet(sandbox, code.PAYMENTS_SHEET, code.PAYMENT_COLUMNS, [
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'),     // ambiguous → tombstone
    pay('pardes', 'דנה כהן', '2026-06-01', '2026-07-01'),     // wrong house → tombstone
    pay('ramot', 'דנה כהן', '2025-06-01', '2025-07-01'),      // different date → skipped
  ]);
  const s = code.reconcile();
  assert.equal(s.renamed, 0);
  assert.equal(s.tombstoned, 2);
  assert.equal(s.skipped, 1);
  assert.equal(writeOps(payments).length, 0, 'no payment cell is written');
  const tombs = code.readSheet(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.deepEqual(plain(tombs.map((t) => t.houseId + '::' + t.name + '::' + t.date).sort()), [
    'pardes::דנה כהן::2026-06-01',
    'ramot::' + TALIA_BAD + '::2026-03-01',
  ].sort());
  assert.ok(tombs.every((t) => t.reason === 'legacy_orphan_payment'));
  // idempotent
  const opsBefore = allWriteOps(sandbox);
  const s2 = code.reconcile();
  assert.equal(s2.tombstoned, 0);
  assert.equal(s2.skipped, 1, 'the different-date row stays a logged skip');
  assert.equal(allWriteOps(sandbox), opsBefore);
});

/* ===== E. the hardened checker ===== */

test('checker: integrityKey_ / integrityNormalizeKey_ normalize the NAME segment (whitespace, NFC)', () => {
  const { code } = loadCode();
  assert.equal(code.integrityKey('ramot', ORNA_BAD, '2026-05-01'), 'ramot::' + ORNA + '::2026-05-01');
  assert.equal(code.integrityNormalizeKey('ramot::' + ORNA_BAD + '::2026-05-01'), 'ramot::' + ORNA + '::2026-05-01');
  assert.equal(code.integrityNormalizeKey(' ramot :: ' + TALIA + ' ::2026-07-01T00:00:00'), 'ramot::' + TALIA + '::2026-07-01');
  assert.equal(code.integrityNormalizeKey('ramot::a::b::2026-07-01'), 'ramot::a::b::2026-07-01', 'a name containing :: keeps the date last');
  assert.equal(code.integrityNormalizeKey('garbage'), 'garbage');
});

test('checker: whitespace drift is NOT an orphan; a legacy_orphan_payment tombstone silences; corruption still alerts', () => {
  const { code } = loadCode();
  const live = {}; live[code.integrityKey('ramot', ORNA, '2026-05-01')] = true;
  const tomb = {}; tomb[code.integrityKey('ramot', 'יוסי לוי', '2025-01-01')] = true; // the reconciler's tombstone
  const rows = [
    pay('ramot', ORNA_BAD, '2026-05-01', '2026-06-01'),
    pay('ramot', 'יוסי לוי', '2025-01-01', '2025-02-01'),
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'),
  ];
  assert.deepEqual(plain(code.orphanKeys(rows, code.parsePaymentPatientId, live, tomb)), ['ramot::' + TALIA_BAD + '::2026-03-01']);
});

test('checker source: builds every key set through integrityKey_, reads DischargedPatients as KNOWN for the orphan sweep only', () => {
  const job = gsFunction('nightlyIntegrityJob');
  assert.ok(!job.includes('patientKey_('), 'the job must not build a raw (un-normalized) key anywhere');
  assert.ok(job.includes('integrityKey_(tombs[t].houseId'));
  assert.ok(job.includes('integrityKey_(patientRows[c].houseId'));
  assert.ok(job.includes('getSheetByName(DISCHARGED_PATIENTS_SHEET)'));
  assert.ok(job.includes('integrityKey_(discharged[d].houseId'));
  // orphan sweep consults live ∪ discharged; the sentinel keeps liveKeySet/tombstones only
  assert.match(job, /integrityOrphanKeys_\(paymentRows,\s*integrityParsePaymentPatientId_,\s*knownKeySet,\s*tombstoneKeySet\)/);
  assert.match(job, /integrityOrphanKeys_\(overrideRows,\s*integrityParseOverridePatientId_,\s*knownKeySet,\s*tombstoneKeySet\)/);
  const sentinel = job.slice(job.indexOf('CHECK 1'), job.indexOf('CHECK 2'));
  assert.ok(!sentinel.includes('knownKeySet'), 'a discharge audit row must not excuse a vanished live row');
  // still read-only (the sibling suite locks the full list; the new read must not regress it)
  for (const forbidden of ['getOrCreateSheet_(', 'setValues(', 'appendRow(', 'setValue(', 'appendPatientTombstones_(']) {
    assert.ok(!job.includes(forbidden), 'job body must not contain ' + forbidden);
  }
});

/* ===== F. contracts + non-exposure guards ===== */

test('both entry points are public (Run dropdown) and NEVER dispatchable via handle_', () => {
  for (const fn of ['previewOrphanPaymentsNow', 'reconcileOrphanPaymentsNow']) {
    assert.ok(new RegExp('function ' + fn + '\\(\\)').test(GS_SRC), fn + ' is public');
  }
  const handleBody = gsFunction('handle_');
  for (const fn of ['previewOrphanPaymentsNow', 'reconcileOrphanPaymentsNow', 'runOrphanPaymentsReconcile_', 'orphanPaymentsPlan_']) {
    assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
  }
});

test('reconciler never deletes or clears anything, never rewrites a whole payment row', () => {
  for (const name of ['runOrphanPaymentsReconcile_', 'appendOrphanPaymentTombstones_', 'orphanPaymentCandidates_']) {
    const src = gsFunction(name);
    for (const forbidden of ['deleteRow', 'deleteRows', 'clearContent', 'clear(', 'deleteRowsById_', 'deletePatientRow_', 'replaceHousePatients_', 'upsertPayment_']) {
      assert.ok(!src.includes(forbidden), name + ' must not contain ' + forbidden);
    }
  }
  const run = gsFunction('runOrphanPaymentsReconcile_');
  assert.ok(run.includes('.setValue(c.to)'), 'payment cells are written one at a time');
  assert.ok(!run.includes('setValues('), 'no multi-cell payment write');
  assert.ok(run.includes('LockService.getScriptLock()'));
  assert.ok(run.includes("logAudit_('orphan_payments_reconciled'"));
});

test('column contracts unchanged: PATIENT_COLUMNS, PAYMENT_COLUMNS, PATIENT_TOMBSTONE_COLUMNS pinned; LEAD_COLUMNS not shrunk', () => {
  const { code } = loadCode();
  assert.deepEqual(arr(code.PATIENT_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv', 'status', 'fromLead', 'exitDate', 'source', 'notes', 'id', 'updatedAt', 'updatedBy',
  ]);
  assert.deepEqual(arr(code.PAYMENT_COLUMNS), [
    'id', 'patientId', 'patientName', 'houseId', 'dueDate', 'amount', 'status', 'amountPaid', 'balance', 'timestamp',
  ]);
  assert.deepEqual(arr(code.PATIENT_TOMBSTONE_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv', 'status', 'fromLead', 'exitDate', 'source', 'notes',
    'droppedAt', 'reason', 'savedByAction', 'id', 'updatedAt', 'updatedBy',
  ], 'the tombstone reason rides in the EXISTING reason column — no new column');
  const leadCols = arr(code.LEAD_COLUMNS);
  assert.ok(leadCols.length >= 26 && leadCols[0] === 'id' && leadCols.includes('name'), 'LEAD_COLUMNS untouched (' + leadCols.length + ' cols)');
  assert.equal(code.ORPHAN_PAYMENT_TOMBSTONE_REASON, 'legacy_orphan_payment');
});
