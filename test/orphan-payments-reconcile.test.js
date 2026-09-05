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
 *   - follow-up buckets (CHANGELOG-orphan-payments-duplicates.md):
 *     `duplicates` — a corrupted row whose canonical id already exists is a
 *     stray twin: byte-equivalent on every non-identity / non-stamp field →
 *     deleted bottom-up, values audited; any difference → skipped
 *     'duplicate row differs'. `rekeys` — a name matched only at another
 *     entry date on a LIVE Patients row → the three key cells follow the
 *     patient's current date; discharged / tombstone-only matches stay
 *     skipped; a colliding rekey target falls under the duplicate rules;
 *   - guards: neither entry point is dispatchable via handle_; the
 *     reconciler deletes ONLY planned stray twins (deleteRow, last,
 *     bottom-up — never clearContent / a whole-row rewrite);
 *     PATIENT/PAYMENT/TOMBSTONE column contracts are unchanged.
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
    deleteRow(r) { ops.push({ op: 'deleteRow', seq: ++opSeq, r }); grid.splice(r - 1, 1); },
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
    ORPHAN_PAYMENT_DUP_IGNORE,
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

test('plan: name matched only at a DIFFERENT entry date on a LIVE patient → REKEY of the three key cells; dueDate untouched', () => {
  const { code } = loadCode();
  const rows = planRows([pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01')]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.tombstones.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.rekeys.length, 1);
  const r = plan.rekeys[0];
  assert.equal(r.key, 'ramot::' + TALIA_BAD + '::2025-12-01');
  assert.equal(r.newKey, 'ramot::' + TALIA + '::2026-03-01');
  assert.equal(r.oldDate, '2025-12-01');
  assert.equal(r.newDate, '2026-03-01');
  assert.deepEqual(plain(r.cells.map((c) => c.column).sort()), ['id', 'patientId', 'patientName']);
  assert.equal(r.cells.find((c) => c.column === 'patientId').to, 'ramot::' + TALIA + '::2026-03-01');
  assert.equal(r.cells.find((c) => c.column === 'id').to, 'pay::ramot::' + TALIA + '::2026-03-01::2026-01-01', 'dueDate segment kept');
});

test('plan: rekey blocked when the only match is a DISCHARGED row or a TOMBSTONE — skipped, no write', () => {
  const { code } = loadCode();
  for (const source of [code.DISCHARGED_PATIENTS_SHEET, code.PATIENTS_TOMBSTONES_SHEET]) {
    const cands = [{ houseId: 'ramot', name: TALIA, date: '2026-03-01', source }];
    const rows = planRows([pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01')]);
    const plan = code.plan(rows, cands, knownOf(code, cands));
    assert.equal(plan.rekeys.length, 0, source);
    assert.equal(plan.renames.length, 0, source);
    assert.equal(plan.tombstones.length, 0, source);
    assert.equal(plan.skipped.length, 1, source);
    assert.match(plan.skipped[0].reason, /different entry date/);
    assert.match(plan.skipped[0].reason, /discharged \/ tombstone/);
    assert.equal(plan.skipped[0].detail, TALIA);
  }
  // a discharged row at the SAME date still renames (sameDate wins), as before
  const cands2 = [{ houseId: 'ramot', name: TALIA, date: '2025-12-01', source: code.DISCHARGED_PATIENTS_SHEET }];
  const plan2 = code.plan(planRows([pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01')]), cands2, knownOf(code, cands2));
  assert.equal(plan2.renames.length, 1);
});

test('plan: live rows that DISAGREE on the entry date (readmission) → skipped, never guessed', () => {
  const { code } = loadCode();
  const cands = [
    { houseId: 'ramot', name: TALIA, date: '2026-03-01' },
    { houseId: 'ramot', name: TALIA, date: '2026-07-01' },
  ];
  const plan = code.plan(planRows([pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01')]), cands, knownOf(code, cands));
  assert.equal(plan.rekeys.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /disagree on the date/);
});

test('plan: rewritten id collides with a byte-equivalent twin → DELETE planned (values kept for the audit); twin untouched', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01', { status: 'שולם', amountPaid: 5000, balance: 0, timestamp: '2026-02-02T00:00:00.000Z' }), // stray twin of row 3
    pay('ramot', TALIA, '2026-03-01', '2026-04-01', { status: 'paid', amountPaid: '5000', balance: '0' }),  // canonical (not an orphan)
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01'),   // no collision → renamed
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-05-01'),   // corrupted TWIN of row 4 → same new id → duplicate of the renamed sibling
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.renames.length, 1);
  assert.equal(plan.renames[0].rowNumber, 4);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.tombstones.length, 0);
  assert.equal(plan.duplicates.length, 2);
  const d = plan.duplicates[0];
  assert.equal(d.rowNumber, 2);
  assert.equal(d.twinRowNumber, 3);
  assert.equal(d.twinId, 'pay::ramot::' + TALIA + '::2026-03-01::2026-04-01');
  assert.equal(d.values.length, arr(code.PAYMENT_COLUMNS).length, 'the whole row rides along in PAYMENT_COLUMNS order');
  assert.equal(d.values[arr(code.PAYMENT_COLUMNS).indexOf('id')], 'pay::ramot::' + TALIA_BAD + '::2026-03-01::2026-04-01');
  assert.equal(plan.duplicates[1].rowNumber, 5);
  assert.equal(plan.duplicates[1].twinRowNumber, 4, 'compared against the sibling renamed in this run');
  // the twin (row 3) is never in any write bucket
  assert.ok(!plan.renames.concat(plan.rekeys, plan.duplicates).some((x) => x.rowNumber === 3));
});

test('plan: duplicate differing in amount → skipped "duplicate row differs", detail names the field and both values', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01', { amount: 4500 }),
    pay('ramot', TALIA, '2026-03-01', '2026-04-01', { amount: 5000 }),
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.duplicates.length, 0);
  assert.equal(plan.renames.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].rowNumber, 2);
  assert.equal(plan.skipped[0].reason, 'duplicate row differs');
  assert.match(plan.skipped[0].detail, /twin row 3/);
  assert.match(plan.skipped[0].detail, /amount 4500 vs 5000/);
  assert.ok(!/status|dueDate|balance/.test(plan.skipped[0].detail), 'only the differing field is named');
});

test('plan: duplicate check ignores identity + stamp columns, coerces amounts, aliases status, normalizes strings', () => {
  const { code } = loadCode();
  const twin = pay('ramot', TALIA, '2026-03-01', '2026-04-01', { amount: 5000, status: 'paid', amountPaid: 5000, balance: 0, timestamp: 'A' });
  const same = pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01', { amount: '5000', status: ' שולם ', amountPaid: '5000.0', balance: '', timestamp: 'B', houseId: ' ramot ' });
  const plan = code.plan(planRows([same, twin]), CANDS, knownOf(code, CANDS));
  assert.equal(plan.duplicates.length, 1, 'timestamp / whitespace / numeric form / status alias differences are not differences');
  const differs = pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01', { amount: 5000, status: 'unpaid', amountPaid: 5000, balance: 0 });
  const plan2 = code.plan(planRows([differs, twin]), CANDS, knownOf(code, CANDS));
  assert.equal(plan2.duplicates.length, 0);
  assert.match(plan2.skipped[0].detail, /status/);
});

test('plan: a rekey whose target id already exists falls under the duplicate rules', () => {
  const { code } = loadCode();
  const rows = planRows([
    pay('ramot', TALIA_BAD, '2025-12-01', '2026-01-01'),                 // old key → rekey target collides with row 3
    pay('ramot', TALIA, '2026-03-01', '2026-01-01'),                     // canonical row the client already minted
    pay('ramot', TALIA_BAD, '2025-12-01', '2026-02-01', { amount: 1 }),  // rekey target collides with row 5, but differs
    pay('ramot', TALIA, '2026-03-01', '2026-02-01'),
  ]);
  const plan = code.plan(rows, CANDS, knownOf(code, CANDS));
  assert.equal(plan.rekeys.length, 0);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].rowNumber, 2);
  assert.equal(plan.duplicates[0].twinRowNumber, 3);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].rowNumber, 4);
  assert.equal(plan.skipped[0].reason, 'duplicate row differs');
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
  seedSheet(sandbox, code.DISCHARGED_PATIENTS_SHEET, code.DISCHARGED_PATIENT_COLUMNS, [
    { id: 'd-1', houseId: 'ramot', name: 'רון לוי', date: '2026-02-01', status: 'released' },
  ]);
  const payments = seedSheet(sandbox, code.PAYMENTS_SHEET, code.PAYMENT_COLUMNS, [
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'),     // ambiguous → tombstone
    pay('pardes', 'דנה כהן', '2026-06-01', '2026-07-01'),     // wrong house → tombstone
    pay('ramot', 'רון לוי', '2025-06-01', '2025-07-01'),      // different date, discharged only → skipped
  ]);
  const s = code.reconcile();
  assert.equal(s.renamed, 0);
  assert.equal(s.rekeyed, 0);
  assert.equal(s.deleted, 0);
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
  assert.equal(s2.skipped, 1, 'the discharged-only different-date row stays a logged skip');
  assert.equal(allWriteOps(sandbox), opsBefore);
});

test('reconcile: two stray twins in one run are deleted BOTTOM-UP, both gone, every other row intact; values audited; idempotent', () => {
  const { code, sandbox } = loadCode();
  const YC = arr(code.PAYMENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, code.PATIENT_COLUMNS, [
    { houseId: 'ramot', name: TALIA, date: '2026-03-01', status: 'active' },
    { houseId: 'ramot', name: ORNA, date: '2026-05-01', status: 'active' },
  ]);
  const payments = seedSheet(sandbox, code.PAYMENTS_SHEET, YC, [
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-04-01'),                     // row 2: stray twin of row 3 → delete
    pay('ramot', TALIA, '2026-03-01', '2026-04-01'),                         // row 3: canonical
    pay('ramot', ORNA, '2026-05-01', '2026-06-01', { status: 'paid', amountPaid: 5000, balance: 0 }), // row 4: canonical
    pay('ramot', TALIA_BAD, '2026-03-01', '2026-07-01'),                     // row 5: corrupted, no twin → rename
    pay('ramot', ORNA_BAD, '2026-05-01', '2026-06-01', { status: 'שולם', amountPaid: '5000', balance: '0' }), // row 6: stray twin of row 4 → delete
    pay('ramot', ORNA, '2026-05-01', '2026-07-01'),                          // row 7: canonical
  ]);
  const s = code.reconcile();
  assert.equal(s.deleted, 2);
  assert.equal(s.renamed, 1);
  assert.equal(s.skipped, 0);
  // order: the rename's single-cell writes first, then deletes, highest row first
  const ops = writeOps(payments);
  const dels = ops.filter((o) => o.op === 'deleteRow');
  assert.deepEqual(plain(dels.map((o) => o.r)), [6, 2], 'bottom-up');
  assert.ok(ops.every((o) => o.op === 'setcell' || o.op === 'deleteRow'), 'only single-cell writes and row deletes');
  assert.ok(ops.findIndex((o) => o.op === 'deleteRow') > ops.filter((o) => o.op === 'setcell').length - 1, 'deletes run last');
  const after = code.readSheet(payments, YC);
  assert.equal(after.length, 4);
  assert.deepEqual(plain(after.map((r) => r.id)), [
    'pay::ramot::' + TALIA + '::2026-03-01::2026-04-01',
    'pay::ramot::' + ORNA + '::2026-05-01::2026-06-01',
    'pay::ramot::' + TALIA + '::2026-03-01::2026-07-01', // renamed row 5, still in place
    'pay::ramot::' + ORNA + '::2026-05-01::2026-07-01',
  ]);
  assert.equal(after[1].status, 'paid', 'the surviving twin keeps its own values');
  assert.equal(String(after[1].amountPaid), '5000');
  // audit carries the recoverable copies
  const audit = code.readSheet(sandbox.__sheets[code.AUDIT_LOG_SHEET], arr(code.AUDIT_LOG_COLUMNS));
  assert.equal(audit.length, 1);
  const details = JSON.parse(audit[0].details);
  assert.equal(details.deleted, 2);
  assert.equal(details.renamed, 1);
  assert.equal(details.rekeyed, 0);
  assert.deepEqual(details.deletedRows.map((d) => d.rowNumber), [2, 6]);
  assert.equal(details.deletedRows[0].values[YC.indexOf('id')], 'pay::ramot::' + TALIA_BAD + '::2026-03-01::2026-04-01');
  assert.equal(details.deletedRows[1].values[YC.indexOf('status')], 'שולם');
  assert.ok(Array.isArray(details.examples.duplicates) && details.examples.duplicates.length === 2);
  // idempotent
  const opsBefore = allWriteOps(sandbox);
  const s2 = code.reconcile();
  assert.equal(s2.orphanKeys, 0);
  assert.equal(s2.deleted, 0);
  assert.equal(allWriteOps(sandbox), opsBefore, 'second run performs zero writes');
  assert.equal(sandbox.__sheets[code.AUDIT_LOG_SHEET].grid.length, 2, 'no second audit row');
});

test('reconcile: rekey on the real sheets rewrites exactly the three key cells, leaves dueDate/amount/status alone; preview writes nothing; idempotent', () => {
  const { code, sandbox } = loadCode();
  const YC = arr(code.PAYMENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, code.PATIENT_COLUMNS, [
    { houseId: 'rehab', name: 'אביעד חביבאן', date: '2026-08-20', status: 'active' }, // entry date was edited
  ]);
  const payments = seedSheet(sandbox, code.PAYMENTS_SHEET, YC, [
    pay('rehab', 'אביעד חביבאן', '2026-08-16', '2026-09-16', { status: 'paid', amountPaid: 5000, balance: 0 }), // keyed on the OLD date
    pay('rehab', 'אביעד חביבאן', '2026-08-20', '2026-10-20'),                                                  // already on the new key
  ]);
  const before = payments.grid.map((r) => r.slice());
  const p = code.preview();
  assert.equal(p.rekeyed, 1);
  assert.equal(allWriteOps(sandbox), 0, 'preview writes nothing');
  assert.ok(sandbox.__logs.some((l) => /rekeys: row 2: rehab::אביעד חביבאן::2026-08-16 → rehab::אביעד חביבאן::2026-08-20/.test(l)), 'old → new key logged');

  const s = code.reconcile();
  assert.equal(s.rekeyed, 1);
  assert.equal(s.renamed, 0);
  assert.equal(s.deleted, 0);
  assert.equal(s.skipped, 0);
  const ops = writeOps(payments);
  assert.equal(ops.length, 2, 'patientId + id (patientName already canonical)');
  assert.ok(ops.every((o) => o.op === 'setcell' && o.r === 2));
  assert.deepEqual(plain(ops.map((o) => YC[o.c - 1]).sort()), ['id', 'patientId']);
  const after = code.readSheet(payments, YC);
  assert.equal(after[0].patientId, 'rehab::אביעד חביבאן::2026-08-20');
  assert.equal(after[0].id, 'pay::rehab::אביעד חביבאן::2026-08-20::2026-09-16');
  assert.equal(after[0].dueDate, '2026-09-16', 'dueDate untouched');
  assert.equal(after[0].status, 'paid');
  assert.equal(String(after[0].amount), String(before[1][YC.indexOf('amount')]));
  assert.deepEqual(plain(payments.grid[2]), plain(before[2]), 'the other row is byte-identical');
  const details = JSON.parse(code.readSheet(sandbox.__sheets[code.AUDIT_LOG_SHEET], arr(code.AUDIT_LOG_COLUMNS))[0].details);
  assert.equal(details.rekeyed, 1);
  assert.deepEqual(details.rekeys, [{ rowNumber: 2, from: 'rehab::אביעד חביבאן::2026-08-16', to: 'rehab::אביעד חביבאן::2026-08-20' }]);
  // idempotent
  const opsBefore = allWriteOps(sandbox);
  const s2 = code.reconcile();
  assert.equal(s2.orphanKeys, 0);
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

test('reconciler deletes ONLY planned stray twins (deleteRow, last, bottom-up); never clears, never rewrites a whole payment row', () => {
  for (const name of ['runOrphanPaymentsReconcile_', 'appendOrphanPaymentTombstones_', 'orphanPaymentCandidates_']) {
    const src = gsFunction(name);
    for (const forbidden of ['deleteRows(', 'clearContent', 'clear(', 'deleteRowsById_', 'deletePatientRow_', 'replaceHousePatients_', 'upsertPayment_']) {
      assert.ok(!src.includes(forbidden), name + ' must not contain ' + forbidden);
    }
  }
  for (const name of ['appendOrphanPaymentTombstones_', 'orphanPaymentCandidates_', 'orphanPaymentsPlan_']) {
    assert.ok(!gsFunction(name).includes('deleteRow'), name + ' must not delete');
  }
  const run = gsFunction('runOrphanPaymentsReconcile_');
  assert.ok(run.includes('.setValue(c.to)'), 'payment cells are written one at a time');
  assert.ok(!run.includes('setValues('), 'no multi-cell payment write');
  assert.equal((run.match(/deleteRow\(/g) || []).length, 1, 'exactly one delete call site');
  assert.match(run, /plan\.duplicates[\s\S]*sort\(function \(x, y\) \{ return y - x; \}\)[\s\S]*deleteRow\(rowNumber\)/, 'deletes come from the duplicates bucket, sorted bottom-up');
  assert.ok(run.indexOf('.setValue(c.to)') < run.indexOf('deleteRow('), 'identity rewrites before deletes');
  assert.ok(run.indexOf('appendOrphanPaymentTombstones_(') < run.indexOf('deleteRow('), 'tombstones before deletes');
  assert.ok(run.includes('LockService.getScriptLock()'));
  assert.ok(run.includes("logAudit_('orphan_payments_reconciled'"));
  assert.ok(run.includes('deletedRows:'), 'deleted values are audited');
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
  assert.deepEqual(arr(code.ORPHAN_PAYMENT_DUP_IGNORE), ['id', 'patientId', 'patientName', 'timestamp', 'updatedAt', 'updatedBy']);
});
