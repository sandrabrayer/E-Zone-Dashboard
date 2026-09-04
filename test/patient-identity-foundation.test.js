/* Patient identity foundation (apps-script/Code.gs, public/app.js,
 * scripts/healthcheck.js).
 *
 * Context under test: until this change the Patients sheet had NO id column —
 * row identity was the triple houseId::name::entryDate (patientKey_), the
 * client minted a fresh session id on every load, a rename / entry-date edit
 * landed as a NEW row, identical-key duplicates were indistinguishable, and
 * the ✕ delete removed every row sharing the key.
 *
 * Locked contracts:
 *   - schema: PATIENT_COLUMNS keeps its legacy prefix byte-for-byte and gains
 *     `id` LAST; PATIENT_TOMBSTONE_COLUMNS likewise; the discharged sheet's
 *     positional layout is byte-identical to before (its leading `id` is the
 *     audit row's own key, the Patients id is excluded from the base slice);
 *     a legacy 10-column live sheet gets the header appended non-destructively;
 *   - getData_ backfills blank ids once (unique, 'id-' prefixed, persisted =
 *     returned), under the script lock, and performs ZERO writes afterwards;
 *   - saveAll merge: ID MATCH first (a rename / entry-date edit updates the
 *     row in place, audited), KEY MATCH as fallback (the sheet's id is
 *     immutable — it wins over the payload's), new rows adopt the client's id
 *     or get one minted, ids are UNIQUE across the sheet (house move /
 *     duplicated object → re-minted + audited), a sheet row whose id another
 *     payload row claims is reserved for that id match, preserved rows get
 *     ids minted, and the identical-key dedupe still sees rows that differ
 *     ONLY in id as byte-identical;
 *   - deletePatientRow_: by id → exactly that row (one of several same-key
 *     duplicates), never cross-house; no id / unknown id → the key path;
 *   - no new HTTP action (handle_'s allow-list untouched);
 *   - client: normalizePatient round-trips a persisted id, serializePatients
 *     carries it, deletePatient sends it, dischargeAuditRow mints a FRESH
 *     audit id (never the patient's);
 *   - healthcheck: a blank patient id is a warning (never a critical).
 *
 * vm-sandbox on the REAL shipped Code.gs / app.js, per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

const LEGACY_PATIENT_COLUMNS = [
  'houseId', 'name', 'date', 'pay', 'adv',
  'status', 'fromLead', 'exitDate', 'source', 'notes',
];
const LEGACY_TOMBSTONE_COLUMNS = LEGACY_PATIENT_COLUMNS.concat(['droppedAt', 'reason', 'savedByAction']);
const LEGACY_DISCHARGED_COLUMNS = ['id'].concat(LEGACY_PATIENT_COLUMNS)
  .concat(['dischargedAt', 'disposition', 'discharge_note', 'restored', 'prior_status']);

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
const writeOps = (sh) => sh.ops.filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear');

/* ---------- load apps-script/Code.gs with the GAS globals stubbed ---------- */
const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function loadCode() {
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
    __locks: 0,
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
  sandbox.LockService = {
    getScriptLock: () => ({ tryLock: () => { sandbox.__locks++; return true; }, releaseLock: noop }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS: PATIENT_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    PATIENT_TOMBSTONE_COLUMNS: PATIENT_TOMBSTONE_COLUMNS,
    PATIENTS_TOMBSTONES_SHEET: PATIENTS_TOMBSTONES_SHEET,
    DISCHARGED_PATIENT_COLUMNS: DISCHARGED_PATIENT_COLUMNS,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    ensure: (name, headers) => getOrCreateSheet_(name, headers),
    getData: () => getData_(),
    saveAll: (l, p) => saveAll_(l, p),
    deletePatientRow: (p) => deletePatientRow_(p),
    patientKey: (h, n, d) => patientKey_(h, n, d),
    findKeys: () => findDuplicatePatientKeysNow(),
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
function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function tombstonesOf(code, sandbox) {
  const sh = sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET];
  return sh ? code.readSheet(sh, arr(code.PATIENT_TOMBSTONE_COLUMNS)) : [];
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)).map((r) => Object.assign({}, r, { details: JSON.parse(r.details) })) : [];
}

const DANA = { houseId: 'arfoni', name: 'דנה כהן', date: '2026-01-10', pay: 30000, adv: 0, status: 'active', source: 'direct_admin' };
const SARA = { houseId: 'ramot',  name: 'שרה לוי', date: '2026-02-01', pay: 9000,  adv: 0, status: 'active', source: 'direct_admin' };

/* ===== A. Schema ===== */

test('PATIENT_COLUMNS keeps the legacy prefix byte-for-byte; `id` then the who/when stamps appended LAST', () => {
  const { code } = loadCode();
  const cols = arr(code.PATIENT_COLUMNS);
  assert.deepStrictEqual(cols.slice(0, LEGACY_PATIENT_COLUMNS.length), LEGACY_PATIENT_COLUMNS);
  assert.deepStrictEqual(cols.slice(LEGACY_PATIENT_COLUMNS.length), ['id', 'updatedAt', 'updatedBy']);
  assert.strictEqual(cols.filter((c) => c === 'id').length, 1);
});

test('PATIENT_TOMBSTONE_COLUMNS keeps its legacy layout; `id` + stamps appended LAST (own literal list, not derived)', () => {
  const { code } = loadCode();
  const cols = arr(code.PATIENT_TOMBSTONE_COLUMNS);
  assert.deepStrictEqual(cols.slice(0, LEGACY_TOMBSTONE_COLUMNS.length), LEGACY_TOMBSTONE_COLUMNS);
  assert.deepStrictEqual(cols.slice(LEGACY_TOMBSTONE_COLUMNS.length), ['id', 'updatedAt', 'updatedBy']);
  assert.ok(/const PATIENT_TOMBSTONE_COLUMNS = \[\s*'houseId'/.test(GS_SRC), 'still its own literal list');
});

test('DISCHARGED_PATIENT_COLUMNS keeps the legacy positional layout (Patients id excluded); stamps appended LAST', () => {
  const { code } = loadCode();
  const cols = arr(code.DISCHARGED_PATIENT_COLUMNS);
  assert.deepStrictEqual(cols.slice(0, LEGACY_DISCHARGED_COLUMNS.length), LEGACY_DISCHARGED_COLUMNS,
    'the pre-stamp prefix is byte-identical (now a FROZEN literal, no longer derived)');
  assert.deepStrictEqual(cols.slice(LEGACY_DISCHARGED_COLUMNS.length), ['updatedAt', 'updatedBy']);
  assert.strictEqual(cols.filter((c) => c === 'id').length, 1, 'no duplicate id header');
});

test('a legacy 10-column live Patients sheet gets the id + stamp headers appended non-destructively', () => {
  const { code, sandbox } = loadCode();
  const sh = seedSheet(sandbox, code.PATIENTS_SHEET, LEGACY_PATIENT_COLUMNS, [DANA]);
  code.ensure(code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS));
  assert.deepStrictEqual(sh.grid[0], arr(code.PATIENT_COLUMNS), 'header extended');
  assert.deepStrictEqual(sh.grid[1].slice(0, 10), rowOf(LEGACY_PATIENT_COLUMNS, DANA), 'existing row untouched');
  const sets = sh.ops.filter((o) => o.op === 'set');
  assert.deepStrictEqual(sets.map((o) => [o.r, o.c, o.nr, o.nc]), [[1, 11, 1, 3]],
    'ONLY the three missing header cells were written, in one write');
});

/* ===== B. getData_ backfill ===== */

test('getData_ backfills blank patient ids once — unique, id- prefixed, persisted == returned, under the script lock — then ZERO writes', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const sh = seedSheet(sandbox, code.PATIENTS_SHEET, PC, [
    DANA,
    Object.assign({}, DANA, { id: 'id-already' }),   // identical-key duplicate that already has an id
    SARA,
    {},                                              // fully-empty trailing row — must be skipped
  ]);
  sandbox.__locks = 0;
  const res = code.getData();
  assert.strictEqual(res.ok, true);
  const sheetRows = patientsOf(code, sandbox);
  assert.strictEqual(sheetRows.length, 3, 'the empty row is not a patient');
  const ids = sheetRows.map((r) => r.id);
  assert.ok(ids.every((id) => /^id-/.test(id)), 'every row now has an id-… id: ' + ids.join(','));
  assert.strictEqual(new Set(ids).size, 3, 'unique');
  assert.strictEqual(ids[1], 'id-already', 'a present id is never overwritten');
  const returned = [].concat(res.patients.arfoni, res.patients.ramot).map((p) => p.id).sort();
  assert.deepStrictEqual(plain(returned), plain(ids.slice().sort()), 'client receives exactly the persisted ids');
  assert.ok(sandbox.__locks >= 1, 'backfill ran under the script lock');
  assert.strictEqual(sh.grid[4].every((v) => v === '' || v === undefined), true, 'empty row still empty');

  sh.ops.length = 0;
  sandbox.__locks = 0;
  code.getData();
  assert.deepStrictEqual(writeOps(sh), [], 'steady state: no writes');
  assert.strictEqual(sandbox.__locks, 0, 'steady state: no lock taken');
});

/* ===== C. saveAll merge ===== */

test('ID MATCH: a rename lands IN PLACE for a hand-entered patient — one row, same id, audited patient_rekeyed_via_id', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-dana' }), Object.assign({}, SARA, { id: 'id-sara' })]);
  const res = code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-dana', name: 'דנה כהן-לוי', date: '2026-01-12' })] });
  assert.strictEqual(res.ok, true);
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows.length, 2, 'no appended twin');
  const dana = rows.find((r) => r.id === 'id-dana');
  assert.deepStrictEqual(plain({ name: dana.name, date: dana.date, houseId: dana.houseId }), { name: 'דנה כהן-לוי', date: '2026-01-12', houseId: 'arfoni' });
  assert.deepStrictEqual(plain(res.preserved), {}, 'nothing preserved — the old row was consumed by the id match');
  assert.strictEqual(tombstonesOf(code, sandbox).length, 0, 'no tombstone: nothing was omitted or dropped');
  const ev = auditOf(code, sandbox).find((e) => e.action === 'patient_rekeyed_via_id');
  assert.ok(ev, 'rekey audited');
  assert.deepStrictEqual(plain({ id: ev.details.id, oldKey: ev.details.oldKey, newKey: ev.details.newKey }),
    { id: 'id-dana', oldKey: code.patientKey('arfoni', 'דנה כהן', '2026-01-10'), newKey: code.patientKey('arfoni', 'דנה כהן-לוי', '2026-01-12') });
  assert.ok(ev.details.changed.includes('name') && ev.details.changed.includes('date'));
});

test('ID MATCH with an unchanged key is an ordinary edit (patient_edited carries the id); an id-only difference is not an edit', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-dana' })]);
  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-dana', pay: 31000 })] });
  const ev = auditOf(code, sandbox).filter((e) => e.action === 'patient_edited');
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(plain({ id: ev[0].details.id, changed: ev[0].details.changed }), { id: 'id-dana', changed: ['pay'] });
  assert.strictEqual(patientsOf(code, sandbox)[0].pay, 31000);
});

test('KEY MATCH keeps the SHEET id (immutable) over a stale tab\'s session id — and logs no edit for the id alone', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-sheet' })]);
  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-stale-session' })] });
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'id-sheet');
  assert.deepStrictEqual(plain(auditOf(code, sandbox).filter((e) => e.action === 'patient_edited')), [], 'id-only difference is not content');
});

test('KEY MATCH on a row without an id adopts the payload id when unused, else mints one', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [DANA, Object.assign({}, SARA, { id: 'id-sara' })]);
  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-from-client' })] });
  assert.strictEqual(patientsOf(code, sandbox).find((r) => r.name === DANA.name).id, 'id-from-client', 'adopted');

  const t2 = loadCode();
  seedSheet(t2.sandbox, t2.code.PATIENTS_SHEET, PC, [DANA]);
  t2.code.saveAll([], { arfoni: [Object.assign({}, DANA)] });          // no id at all (legacy writer)
  assert.match(patientsOf(t2.code, t2.sandbox)[0].id, /^id-uuid-/, 'minted');
});

test('a new admission adopts the client id; a blank one is minted — and every written row has an id', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, []);
  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-client-new' }), Object.assign({}, SARA, { houseId: 'arfoni' })] });
  const rows = patientsOf(code, sandbox);
  assert.deepStrictEqual(plain(rows.map((r) => r.name)), [DANA.name, SARA.name]);
  assert.strictEqual(rows[0].id, 'id-client-new');
  assert.match(rows[1].id, /^id-uuid-/);
  const added = auditOf(code, sandbox).filter((e) => e.action === 'patient_added');
  assert.deepStrictEqual(plain(added.map((e) => e.details.id)), ['id-client-new', rows[1].id], 'patient_added carries the id');
});

test('UNIQUENESS: a house move arrives with an id held by the old house\'s row → the incoming row is re-minted and audited; the old row keeps its id', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-dana' })]);
  code.saveAll([], { ramot: [Object.assign({}, DANA, { houseId: 'ramot', id: 'id-dana' })] });
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows.length, 2, 'old house row untouched (merge-don\'t-drop), new house row appended');
  const old = rows.find((r) => r.houseId === 'arfoni');
  const moved = rows.find((r) => r.houseId === 'ramot');
  assert.strictEqual(old.id, 'id-dana');
  assert.match(moved.id, /^id-uuid-/);
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, 2, 'no duplicate id on the sheet');
  const ev = auditOf(code, sandbox).find((e) => e.action === 'patient_id_reminted');
  assert.deepStrictEqual(plain({ incomingId: ev.details.incomingId, newId: ev.details.newId, houseId: ev.details.houseId }), { incomingId: 'id-dana', newId: moved.id, houseId: 'ramot' });
});

test('UNIQUENESS: two payload objects with the same id and different keys → first adopts, second re-minted', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, []);
  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-dup' }), Object.assign({}, SARA, { houseId: 'arfoni', id: 'id-dup' })] });
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows[0].id, 'id-dup');
  assert.match(rows[1].id, /^id-uuid-/);
  assert.strictEqual(auditOf(code, sandbox).filter((e) => e.action === 'patient_id_reminted').length, 1);
});

test('RESERVATION: a sheet row whose id another payload row claims is never key-consumed — both payload rows land, no data loss', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-X' })]);
  // P1: the OLD key with a different id (stale copy); P2: id-X renamed. P1 is processed first.
  code.saveAll([], { arfoni: [
    Object.assign({}, DANA, { id: 'id-Y' }),
    Object.assign({}, DANA, { id: 'id-X', name: 'דנה כהן-לוי' }),
  ] });
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows.length, 2);
  const x = rows.find((r) => r.id === 'id-X');
  const y = rows.find((r) => r.id === 'id-Y');
  assert.strictEqual(x.name, 'דנה כהן-לוי', 'the persisted row followed its id (rename in place)');
  assert.strictEqual(y.name, DANA.name, 'the stale copy was appended under the old key, not silently dropped');
  assert.strictEqual(tombstonesOf(code, sandbox).length, 0);
});

test('preserved (omitted) rows without an id get one minted; the tombstone carries it', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [DANA, Object.assign({}, SARA, { houseId: 'arfoni' })]);
  const res = code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-dana' })] });
  const rows = patientsOf(code, sandbox);
  const sara = rows.find((r) => r.name === SARA.name);
  assert.match(sara.id, /^id-uuid-/, 'preserved row minted');
  assert.deepStrictEqual(plain(res.preserved), { arfoni: [code.patientKey('arfoni', SARA.name, SARA.date)] });
  const tomb = tombstonesOf(code, sandbox);
  assert.strictEqual(tomb.length, 1);
  assert.deepStrictEqual(plain({ reason: tomb[0].reason, id: tomb[0].id }), { reason: 'saveAll-omitted-preserved', id: sara.id });
});

test('identical-key dedupe still sees rows that differ ONLY in id as byte-identical (scanner + save-time drop)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-a' }), Object.assign({}, DANA, { id: 'id-b' })]);
  const groups = code.findKeys();
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].identical, true, 'differing ids do not make the twins "differ"');

  code.saveAll([], { arfoni: [Object.assign({}, DANA, { id: 'id-a' })] });
  const rows = patientsOf(code, sandbox);
  assert.deepStrictEqual(plain(rows.map((r) => r.id)), ['id-a'], 'the immortal twin was dropped');
  const tomb = tombstonesOf(code, sandbox);
  assert.deepStrictEqual(plain(tomb.map((t) => [t.reason, t.id])), [['dedupe-identical-key', 'id-b']]);
});

test('a legacy payload (no ids at all) behaves exactly as before: key match replaces, unknown key appends', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-dana' })]);
  const res = code.saveAll([], { arfoni: [Object.assign({}, DANA, { pay: 32000 }), Object.assign({}, SARA, { houseId: 'arfoni' })] });
  const rows = patientsOf(code, sandbox);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(plain({ id: rows[0].id, pay: rows[0].pay }), { id: 'id-dana', pay: 32000 });
  assert.deepStrictEqual(plain(res.preserved), {});
});

/* ===== D. deletePatientRow_ ===== */

test('delete BY ID removes exactly that one of two same-key duplicates; the tombstone carries the id', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-a' }), Object.assign({}, DANA, { id: 'id-b' }), Object.assign({}, SARA, { id: 'id-s' })]);
  const res = code.deletePatientRow({ id: 'id-b', houseId: DANA.houseId, name: DANA.name, date: DANA.date });
  assert.deepStrictEqual(plain(res), { ok: true, deleted: 1, key: code.patientKey(DANA.houseId, DANA.name, DANA.date), id: 'id-b', matchedBy: 'id' });
  assert.deepStrictEqual(plain(patientsOf(code, sandbox).map((r) => r.id)), ['id-a', 'id-s']);
  const tomb = tombstonesOf(code, sandbox);
  assert.deepStrictEqual(plain(tomb.map((t) => [t.reason, t.id])), [['user-delete', 'id-b']]);
  const ev = auditOf(code, sandbox).find((e) => e.action === 'patient_deleted');
  assert.deepStrictEqual(plain({ id: ev.details.id, matchedBy: ev.details.matchedBy, deleted: ev.details.deleted }), { id: 'id-b', matchedBy: 'id', deleted: 1 });
});

test('delete WITHOUT an id is the legacy key path (all same-key rows); an unknown id falls back to the key path', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-a' }), Object.assign({}, DANA, { id: 'id-b' }), Object.assign({}, SARA, { id: 'id-s' })]);
  const res = code.deletePatientRow({ houseId: DANA.houseId, name: DANA.name, date: DANA.date });
  assert.deepStrictEqual(plain({ deleted: res.deleted, matchedBy: res.matchedBy, id: res.id }), { deleted: 2, matchedBy: 'key', id: '' });
  assert.deepStrictEqual(plain(patientsOf(code, sandbox).map((r) => r.id)), ['id-s']);

  const t2 = loadCode();
  seedSheet(t2.sandbox, t2.code.PATIENTS_SHEET, PC, [Object.assign({}, DANA, { id: 'id-a' })]);
  const r2 = t2.code.deletePatientRow({ id: 'id-not-on-sheet', houseId: DANA.houseId, name: DANA.name, date: DANA.date });
  assert.deepStrictEqual(plain({ deleted: r2.deleted, matchedBy: r2.matchedBy }), { deleted: 1, matchedBy: 'key' });
});

test('delete by an id that lives in ANOTHER house never crosses houses: key fallback, and with no key match nothing is touched', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const sh = seedSheet(sandbox, code.PATIENTS_SHEET, PC, [Object.assign({}, SARA, { id: 'id-s' })]);
  sh.ops.length = 0;
  const res = code.deletePatientRow({ id: 'id-s', houseId: 'arfoni', name: SARA.name, date: SARA.date });
  assert.deepStrictEqual(plain(res), { ok: false, error: 'patient_not_found' });
  assert.deepStrictEqual(writeOps(sh), [], 'refused: nothing written');
  assert.strictEqual(patientsOf(code, sandbox).length, 1);
});

/* ===== E. Surface ===== */

test('no new HTTP action: handle_\'s allow-list gains nothing (backfill is internal to getData)', () => {
  const actions = (GS_SRC.match(/action === '([A-Za-z]+)'/g) || []).map((s) => s.match(/'([A-Za-z]+)'/)[1]);
  assert.ok(!actions.some((a) => /backfill|identity|patientId/i.test(a)), 'no identity/backfill action: ' + actions.join(','));
  assert.ok(!/function backfillPatientIdsLocked\b[^_]/.test(GS_SRC), 'helper stays private (underscore-suffixed)');
});

/* ===== F. Client (public/app.js) ===== */

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function loadApp() {
  const noop = () => {};
  const doc = {
    addEventListener: noop,
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] }),
    querySelectorAll: () => [],
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      normalizePatient, serializePatients, dischargeAuditRow, parsePatients,
    };`, sandbox);
  return sandbox.__test;
}

test('client: normalizePatient round-trips a persisted id verbatim (and still mints one only when absent)', () => {
  const app = loadApp();
  const p = app.normalizePatient({ id: 'id-persisted', houseId: 'arfoni', name: 'דנה', date: '2026-01-10', pay: 1 });
  assert.strictEqual(p.id, 'id-persisted');
  assert.match(app.normalizePatient({ houseId: 'arfoni', name: 'x' }).id, /^id-/);
  const fromServer = app.parsePatients({ arfoni: [{ id: 'id-sheet', houseId: 'arfoni', name: 'דנה', date: '2026-01-10' }] });
  assert.strictEqual(fromServer[0].id, 'id-sheet', 'getData payload id survives parsePatients');
});

test('client: serializePatients carries the id to saveAll', () => {
  const app = loadApp();
  app.setState({ patients: [{ id: 'id-sheet', houseId: 'arfoni', name: 'דנה', date: '2026-01-10', pay: 1, adv: 0, status: 'active' }] });
  const out = app.serializePatients();
  assert.strictEqual(out.arfoni[0].id, 'id-sheet');
});

test('client: dischargeAuditRow mints a FRESH audit id — never the patient\'s persisted id — and keeps every other field', () => {
  const app = loadApp();
  const patient = { id: 'id-patient', houseId: 'arfoni', name: 'דנה', date: '2026-01-10', pay: 30000, adv: 0, status: 'active' };
  const a = app.dischargeAuditRow(patient, { disposition: 'completed', note: 'n', dischargeDate: '2026-07-15' }, '2026-06-28');
  const b = app.dischargeAuditRow(patient, { disposition: 'completed', note: 'n', dischargeDate: '2026-07-15' }, '2026-06-28');
  assert.notStrictEqual(a.id, 'id-patient');
  assert.notStrictEqual(a.id, b.id, 'every discharge gets its own audit row');
  assert.deepStrictEqual(plain({ name: a.name, houseId: a.houseId, pay: a.pay, prior_status: a.prior_status, exitDate: a.exitDate, status: a.status }),
    { name: 'דנה', houseId: 'arfoni', pay: 30000, prior_status: 'active', exitDate: '2026-07-15', status: 'released' });
});

test('client: deletePatient sends the persisted id alongside the identity key (source contract)', () => {
  const m = APP_SRC.match(/action: 'deletePatientRow',\s*patient: \{([^}]*)\}/);
  assert.ok(m, 'deletePatientRow call found');
  assert.match(m[1], /\bid:/);
  assert.match(m[1], /houseId: p\.houseId, name: p\.name, date: p\.date/);
});

/* ===== G. Healthcheck ===== */

test('healthcheck: a blank patient id is a warning by house + position (never a critical); present ids are quiet', () => {
  const hc = require('../scripts/healthcheck');
  assert.deepStrictEqual(hc.PATIENT_COLUMNS, LEGACY_PATIENT_COLUMNS.concat(['id', 'updatedAt', 'updatedBy']));
  const patient = {};
  for (const c of hc.PATIENT_COLUMNS) patient[c] = '';
  patient.houseId = 'ramot'; patient.date = '2026-08-02';
  const data = { leads: [], patients: { ramot: [patient, Object.assign({}, patient, { id: 'id-ok' })] }, dischargedPatients: [] };
  const warnings = hc.warnBlankIds(data);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Blank patient id: 1 patient row\(s\).*house ramot position 0/);
  assert.ok(!/ramot position 1/.test(warnings[0]));
  patient.id = 'id-also-ok';
  assert.deepStrictEqual(hc.warnBlankIds(data), []);
});
