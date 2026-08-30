/* Merge-don't-drop for the Patients sheet (apps-script/Code.gs) + the client
 * resync half (public/app.js).
 *
 * The bug class under test: the Patients sheet used to be written by saveAll's
 * WHOLE-HOUSE REPLACE — every save rewrote each house from the saving tab's
 * in-memory list, so a stale tab (loaded before an admission) silently DROPPED
 * rows it never knew about. Leads were already safe (mergeLeads_ preserves
 * rows absent from the payload); patients were not.
 *
 * The fix under test (this PR):
 *   A. replaceHousePatients_ MERGES by the identity triple
 *      houseId::name::entryDate (patientKey_): matched → replaced, new →
 *      appended, absent from payload → KEPT; kept keys echoed per house in
 *      the saveAll response's `preserved` map.
 *   B. Every kept-but-omitted row is copied to the append-only
 *      PatientsTombstones audit sheet (own literal header list) BEFORE the
 *      rewrite — fail-soft: an audit failure never blocks the save.
 *   C1. Write-then-trim replaces clear-then-write in replaceHousePatients_,
 *       mergeLeads_ and deleteRowsById_ — a crash mid-rewrite can duplicate
 *       tail rows but can no longer empty a sheet (clearBody_ is gone).
 *   C2. public/app.js: a save response with preserved rows triggers a
 *       guarded reload; the tab also reloads on visibilitychange→visible
 *       (save-in-flight + 60s-floor guards).
 *
 * vm-sandbox on the REAL shipped sources, per the repo convention
 * (see meeting-report-guard-compat.test.js). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

/* ---------- a minimal fake Sheet (guard-compat shape + clear-op logging) ---------- */
let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
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
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},        // primary spreadsheet: name → fakeSheet
    __digestSheets: {},  // digest spreadsheet (openById): name → fakeSheet
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
    PATIENT_TOMBSTONE_COLUMNS: PATIENT_TOMBSTONE_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    PATIENTS_TOMBSTONES_SHEET: PATIENTS_TOMBSTONES_SHEET,
    LEAD_COLUMNS: LEAD_COLUMNS,
    handle: (params) => handle_(params).json,
    saveAll: (l, p) => saveAll_(l, p),
    removeLead: (l) => removeLead_(l),
    patientKey: (h, n, d) => patientKey_(h, n, d),
    readSheet: (sh, cols) => readSheet_(sh, cols),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

function patientRow(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}

/* Fresh sandbox with a Patients sheet holding the given patient field-objects. */
function withPatients(patientFields) {
  const { code, sandbox } = loadCode();
  const cols = arr(code.PATIENT_COLUMNS);
  sandbox.__sheets[code.PATIENTS_SHEET] =
    fakeSheet(cols, (patientFields || []).map((f) => patientRow(cols, f)));
  return { code, sandbox, cols };
}

const SEED = [
  { houseId: 'ramot',  name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
  { houseId: 'ramot',  name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial'  },
  { houseId: 'arfoni', name: 'רון', date: '2026-06-10', pay: 8000, status: 'active' },
];

function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function tombstonesOf(code, sandbox) {
  const sh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  return sh ? code.readSheet(sh, arr(code.PATIENT_TOMBSTONE_COLUMNS)) : [];
}

/* ===== A. merge-don't-drop ===== */

test('a stale save omitting an existing row KEEPS the row and echoes it in preserved', () => {
  const { code, sandbox } = withPatients(SEED);
  // Stale tab loaded before דנה was admitted: its ramot list has only שרה.
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' }],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual({ ...res.written }, { ramot: 1 });
  assert.deepStrictEqual(
    { ramot: arr(res.preserved.ramot) },
    { ramot: ['ramot::דנה::2026-08-15'] }
  );

  const after = patientsOf(code, sandbox);
  const names = arr(after).map((p) => p.houseId + '/' + p.name).sort();
  assert.deepStrictEqual(names, ['arfoni/רון', 'ramot/דנה', 'ramot/שרה'],
    'the omitted row survives the stale save; nothing else changed');
});

test('a matched row is REPLACED in place (status flip persists, no duplicate, no tombstone)', () => {
  const { code, sandbox } = withPatients(SEED);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'released', exitDate: '2026-08-30' },
      { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial' },
    ],
  });
  assert.deepStrictEqual({ ...res.preserved }, {}, 'full payload → nothing preserved');

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 3, 'no duplicate rows');
  const sara = after.find((p) => p.name === 'שרה');
  assert.strictEqual(sara.status, 'released');
  assert.strictEqual(sara.exitDate, '2026-08-30');
  assert.strictEqual(tombstonesOf(code, sandbox).length, 0, 'no tombstones on a clean save');
});

test('new rows append; other houses and houses absent from the payload stay untouched', () => {
  const { code, sandbox } = withPatients(SEED);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
      { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial' },
      { houseId: 'ramot', name: 'נועה', date: '2026-08-29', pay: 9800, status: 'trial' },
    ],
    // arfoni deliberately absent from the payload entirely.
  });
  assert.deepStrictEqual({ ...res.written }, { ramot: 3 });

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 4);
  assert.ok(after.some((p) => p.name === 'נועה'), 'admission appended');
  const ron = after.find((p) => p.name === 'רון');
  assert.deepStrictEqual({ houseId: ron.houseId, pay: ron.pay, status: ron.status },
    { houseId: 'arfoni', pay: 8000, status: 'active' });
});

test('accepted trade-off: a rename changes the identity key → old row kept + edit appended', () => {
  const { code, sandbox } = withPatients(SEED);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'שרה כהן', date: '2026-07-01', pay: 9000, status: 'active' }, // renamed
      { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial' },
    ],
  });
  assert.deepStrictEqual(arr(res.preserved.ramot), ['ramot::שרה::2026-07-01']);
  const after = patientsOf(code, sandbox);
  const ramotNames = arr(after).filter((p) => p.houseId === 'ramot').map((p) => p.name).sort();
  assert.deepStrictEqual(ramotNames, ['דנה', 'שרה', 'שרה כהן'],
    'visible duplicate instead of silent loss — locked as the accepted trade-off');
});

/* ===== B. tombstone audit ===== */

test('every omitted-but-kept row lands on PatientsTombstones with full snapshot + metadata', () => {
  const { code, sandbox } = withPatients(SEED);
  code.saveAll(null, { ramot: [] }); // empty stale save: both ramot rows omitted
  const stones = tombstonesOf(code, sandbox);
  assert.strictEqual(stones.length, 2);
  const dana = stones.find((t) => t.name === 'דנה');
  assert.deepStrictEqual(
    { houseId: dana.houseId, date: dana.date, pay: dana.pay, status: dana.status,
      reason: dana.reason, savedByAction: dana.savedByAction },
    { houseId: 'ramot', date: '2026-08-15', pay: 9500, status: 'trial',
      reason: 'saveAll-omitted-preserved', savedByAction: 'saveAll' }
  );
  assert.ok(String(dana.droppedAt).length > 0, 'droppedAt stamped');
  // ...and the rows are STILL on the Patients sheet — the tombstone is an
  // audit trace, not the recovery copy.
  assert.strictEqual(patientsOf(code, sandbox).length, 3);
});

test('a tombstone write failure never blocks the save (fail-soft contract)', () => {
  const { code, sandbox } = withPatients(SEED);
  // Pre-register a broken tombstone sheet: every access throws.
  sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] = {
    getLastRow() { throw new Error('quota'); },
    getLastColumn() { throw new Error('quota'); },
    getMaxRows() { throw new Error('quota'); },
    getRange() { throw new Error('quota'); },
    setFrozenRows() { throw new Error('quota'); },
  };
  const res = code.saveAll(null, {
    ramot: [{ houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' }],
  });
  assert.strictEqual(res.ok, true, 'save succeeded despite the audit failure');
  assert.deepStrictEqual(arr(res.preserved.ramot), ['ramot::דנה::2026-08-15']);
  assert.strictEqual(patientsOf(code, sandbox).length, 3, 'omitted row still kept');
});

/* ===== C1. write-then-trim ===== */

test('deleteRowsById_ (via removeLead_) writes kept rows BEFORE clearing the tail', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  const leadRow = (fields) => {
    const row = LC.map(() => '');
    Object.keys(fields).forEach((k) => { row[LC.indexOf(k)] = fields[k]; });
    return row;
  };
  const leadsSh = sandbox.__sheets['Leads'] =
    fakeSheet(LC, [leadRow({ id: 'L1', name: 'a' }), leadRow({ id: 'L2', name: 'b' })]);
  sandbox.__sheets['לידים שהוסרו'] = fakeSheet(arr(code.LEAD_COLUMNS).concat(['removedAt', 'originSheet']), []);
  leadsSh.ops.length = 0;

  const res = code.removeLead({ id: 'L1', name: 'a' });
  assert.strictEqual(res.ok, true);

  const set = leadsSh.ops.find((o) => o.op === 'set');
  const clear = leadsSh.ops.find((o) => o.op === 'clear');
  assert.ok(set, 'kept rows rewritten');
  assert.ok(clear, 'surplus tail trimmed');
  assert.ok(set.seq < clear.seq, `write (seq ${set.seq}) must precede trim (seq ${clear.seq})`);
  assert.strictEqual(clear.r, 3, 'trim starts below the kept rows, never the whole body');
  // Data outcome unchanged: L1 gone, L2 intact.
  assert.deepStrictEqual(arr(code.readSheet(leadsSh, LC)).map((l) => l.id), ['L2']);
});

test('source-scan: clear-then-write is gone — no clearBody_ anywhere in Code.gs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.ok(!/clearBody_/.test(src),
    'clearBody_ (whole-body clear before rewrite) must not come back; use write-then-trim');
});

/* ===== digest propagation under the merge ===== */

test('refreshDigestBestEffort_ rebuilds from the MERGED sheet — preserved active rows stay in the digest', () => {
  const { code, sandbox } = withPatients(SEED);
  sandbox.__props.DIGEST_SPREADSHEET_ID = 'digest-ss';
  // Stale saveAll through the real dispatcher so the digest refresh fires.
  const out = code.handle({
    action: 'saveAll',
    patients: { ramot: [{ houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' }] },
  });
  assert.strictEqual(out.ok, true);

  const digest = sandbox.__digestSheets['ActivePatients'];
  assert.ok(digest, 'digest tab written');
  const names = digest.grid.slice(1).map((r) => r[1]).filter(Boolean).sort();
  // דנה is 'trial' (not exported by design); שרה + רון are active — both
  // present, proving the digest reads the post-merge sheet, not the payload.
  assert.deepStrictEqual(names, ['רון', 'שרה']);
});

/* ===== dedicated permanent delete (deletePatientRow) ===== */

test('deletePatientRow: tombstones (user-delete) BEFORE deleting; row gone, others intact', () => {
  const { code, sandbox } = withPatients(SEED);
  const patientsSh = sandbox.__sheets[code.PATIENTS_SHEET];
  patientsSh.ops.length = 0;

  const out = code.handle({
    action: 'deletePatientRow',
    patient: { houseId: 'ramot', name: 'דנה', date: '2026-08-15' },
  });
  assert.deepStrictEqual({ ok: out.ok, deleted: out.deleted, key: out.key },
    { ok: true, deleted: 1, key: 'ramot::דנה::2026-08-15' });

  assert.deepStrictEqual(arr(patientsOf(code, sandbox)).map((p) => p.name).sort(),
    ['רון', 'שרה']);

  const stones = tombstonesOf(code, sandbox);
  assert.strictEqual(stones.length, 1);
  assert.deepStrictEqual(
    { name: stones[0].name, pay: stones[0].pay, reason: stones[0].reason, savedByAction: stones[0].savedByAction },
    { name: 'דנה', pay: 9500, reason: 'user-delete', savedByAction: 'deletePatientRow' });
  assert.ok(String(stones[0].droppedAt).length > 0, 'droppedAt stamped');

  // Ordering (fail-hard contract): the tombstone DATA write must precede any
  // Patients-sheet mutation. The shared opSeq counter orders ops across sheets.
  const tombSh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  const tombDataSet = tombSh.ops.find((o) => o.op === 'set' && o.r > 1);
  const patientsMut = patientsSh.ops.find((o) => (o.op === 'set' || o.op === 'clear'));
  assert.ok(tombDataSet, 'tombstone data written');
  assert.ok(patientsMut, 'Patients sheet rewritten');
  assert.ok(tombDataSet.seq < patientsMut.seq,
    `tombstone (seq ${tombDataSet.seq}) must precede the delete (seq ${patientsMut.seq})`);
});

test('deletePatientRow: unknown identity key → patient_not_found, nothing touched', () => {
  const { code, sandbox } = withPatients(SEED);
  const out = code.handle({
    action: 'deletePatientRow',
    patient: { houseId: 'ramot', name: 'לא קיימת', date: '2026-01-01' },
  });
  assert.deepStrictEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'patient_not_found' });
  assert.strictEqual(patientsOf(code, sandbox).length, 3);
  assert.strictEqual(tombstonesOf(code, sandbox).length, 0);
});

test('deletePatientRow: a tombstone failure ABORTS the delete — the row survives (fail-hard)', () => {
  const { code, sandbox } = withPatients(SEED);
  sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] = {
    getLastRow() { throw new Error('quota'); },
    getLastColumn() { throw new Error('quota'); },
    getMaxRows() { throw new Error('quota'); },
    getRange() { throw new Error('quota'); },
    setFrozenRows() { throw new Error('quota'); },
  };
  const out = code.handle({
    action: 'deletePatientRow',
    patient: { houseId: 'ramot', name: 'דנה', date: '2026-08-15' },
  });
  assert.strictEqual(out.ok, false, 'delete refused without its recovery copy');
  assert.ok(arr(patientsOf(code, sandbox)).some((p) => p.name === 'דנה'), 'row survives');
});

test('a stale saveAll cannot resurrect a deleted patient (deletedSuppressed)', () => {
  const { code, sandbox } = withPatients(SEED);
  code.handle({
    action: 'deletePatientRow',
    patient: { houseId: 'ramot', name: 'דנה', date: '2026-08-15' },
  });
  // A stale tab still carries דנה in memory and saves.
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
      { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial' },
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual({ ...res.written }, { ramot: 1 }, 'suppressed row excluded from written');
  assert.deepStrictEqual(arr(res.deletedSuppressed.ramot), ['ramot::דנה::2026-08-15']);
  assert.deepStrictEqual({ ...res.preserved }, {}, 'normal preserved behavior unaffected');
  assert.deepStrictEqual(arr(patientsOf(code, sandbox)).map((p) => p.name).sort(),
    ['רון', 'שרה'], 'deleted patient stays deleted');
  assert.strictEqual(tombstonesOf(code, sandbox).length, 1, 'suppression adds no audit rows');
});

test('an EXPIRED user-delete tombstone no longer suppresses — deliberate re-add works', () => {
  const { code, sandbox } = withPatients(SEED);
  const TC = arr(code.PATIENT_TOMBSTONE_COLUMNS);
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET] = fakeSheet(TC, [
    patientRow(TC, { houseId: 'ramot', name: 'יעל', date: '2026-05-01',
                     reason: 'user-delete', droppedAt: old, savedByAction: 'deletePatientRow' }),
  ]);
  const res = code.saveAll(null, {
    ramot: [
      { houseId: 'ramot', name: 'שרה', date: '2026-07-01', pay: 9000, status: 'active' },
      { houseId: 'ramot', name: 'דנה', date: '2026-08-15', pay: 9500, status: 'trial' },
      { houseId: 'ramot', name: 'יעל', date: '2026-05-01', pay: 7000, status: 'active' },
    ],
  });
  assert.deepStrictEqual({ ...res.deletedSuppressed }, {});
  assert.ok(arr(patientsOf(code, sandbox)).some((p) => p.name === 'יעל'), 're-add landed');
});

/* ===== C2. client half (public/app.js) ===== */

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
    needsResync: (res) => saveAllResponseNeedsResync(res),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

test('saveAllResponseNeedsResync: true only for a non-empty preserved map', () => {
  const app = loadAppPure();
  assert.strictEqual(app.needsResync(null), false);
  assert.strictEqual(app.needsResync({ ok: true }), false, 'pre-deploy backend: no preserved field');
  assert.strictEqual(app.needsResync({ ok: true, preserved: {} }), false);
  assert.strictEqual(app.needsResync({ ok: true, preserved: { ramot: [] } }), false);
  assert.strictEqual(app.needsResync({ ok: true, preserved: [] }), false, 'wrong shape tolerated');
  assert.strictEqual(app.needsResync({ ok: true, preserved: { ramot: ['ramot::x::'] } }), true);
  assert.strictEqual(app.needsResync({ ok: true, deletedSuppressed: { ramot: ['ramot::x::'] } }), true,
    'a suppressed resurrection attempt also means this tab is stale');
});

test('source-scan: deletePatient uses the dedicated action, never saveAll omission', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('async function deletePatient');
  assert.ok(start >= 0, 'deletePatient exists');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/action: 'deletePatientRow'/.test(body), 'posts the dedicated backend action');
  assert.ok(!/saveAll\(\)/.test(body), 'must not delete by saveAll omission');
});

test('source-scan: saveAll routes its response through the preserved-rows resync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(/maybeResyncPreservedPatients\(res\)/.test(src),
    'saveAll must hand the backend response to maybeResyncPreservedPatients');
  assert.ok(/_preservedResyncBusy/.test(src) && /_preservedResyncLastAt/.test(src),
    'resync must keep its re-entry + rate-limit guards');
});

test('source-scan: visibilitychange resync exists with its two guards', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const idx = src.indexOf("addEventListener('visibilitychange'");
  assert.ok(idx >= 0, 'visibilitychange listener registered');
  const body = src.slice(idx, idx + 600);
  assert.ok(/visibilityState !== 'visible'/.test(body), 'acts only on becoming visible');
  assert.ok(/_savesInFlight > 0/.test(body), 'skips while a save is in flight');
  assert.ok(/60000/.test(body), 'floors reloads at 60s');
  assert.ok(/loadAll\(\)/.test(body), 'reloads from the sheet');
});
