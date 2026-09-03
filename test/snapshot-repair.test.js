/* Snapshot-based auto-repair tiers (apps-script/Code.gs).
 *
 * Context under test: the chunk-split bug (live 2026-07-27 → fixed PR #102)
 * corrupted rows that were WRITTEN CLEAN before it — their clean values
 * survive in a pre-bug spreadsheet copy Sandra creates manually, named with
 * the EZONE-SNAPSHOT prefix. writeRepairPlanNow now auto-fills newValue
 * through tiered proposals: tier 1 snapshot (row-matched, compatibility-
 * guarded, notes included), tier 2 closed value sets (enum), tier 3 name
 * roster + corrupted-twin merge. RepairPlan gained an appended `source`
 * column recording the proposing tier.
 *
 * Locked contracts:
 *   - snapshots are located by name PREFIX and are READ-ONLY — never written;
 *   - Patients rows match by fromLead (else houseId+entryDate+pay); 2+
 *     candidates → ambiguous → NO proposal; Leads family matches by lead id;
 *   - column mapping follows the snapshot's own header row, so a snapshot
 *     with FEWER (pre-append) columns still repairs the columns it has;
 *   - a clean-but-incompatible snapshot value → 'snapshot mismatch — manual'
 *     and the weaker tiers do NOT run for that cell;
 *   - enum/roster propose only on an EXACTLY-ONE wildcard match (U+FFFD runs
 *     = 1+ chars, so length-incompatible candidates never match);
 *   - enum/roster never touch notes/free-text columns;
 *   - twin-merge reconstructs only a full clean string from two same-length
 *     twins corrupted in different positions;
 *   - no snapshot found → tiers 2–3 still run and the log says so clearly;
 *   - RepairPlan's `source` column is APPENDED at the END (append-only) and
 *     applyCorruptedRowRepairsNow's contract is unchanged on the 8-col plan.
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

/* ---------- load apps-script/Code.gs with GAS globals + DriveApp stubbed ---------- */
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
    __props: {},
    __logs: logs,
    __snapshotFiles: [],   // {id, name, updated: ms}
    __snapshotSheets: {},  // id → {sheetName: fakeSheet}
  };
  const fileIter = (files) => {
    let i = 0;
    return {
      hasNext: () => i < files.length,
      next() {
        const f = files[i++];
        return {
          getId: () => f.id,
          getName: () => f.name,
          getLastUpdated: () => new Date(f.updated),
        };
      },
    };
  };
  sandbox.DriveApp = {
    searchFiles: (q) => {
      assert.ok(/title contains/.test(String(q)), 'prefix search query');
      return fileIter(sandbox.__snapshotFiles.filter((f) => f.name.includes('EZONE-SNAPSHOT')));
    },
    getFilesByName: (n) => fileIter(sandbox.__snapshotFiles.filter((f) => f.name === n)),
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: (id) => {
      const sheets = sandbox.__snapshotSheets[id];
      if (!sheets) throw new Error('no such spreadsheet: ' + id);
      return { getSheetByName: (name) => sheets[name] || null };
    },
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
    LEAD_COLUMNS: LEAD_COLUMNS,
    LEADS_SHEET: LEADS_SHEET,
    PAYMENT_COLUMNS: PAYMENT_COLUMNS,
    PAYMENTS_SHEET: PAYMENTS_SHEET,
    REPAIR_PLAN_COLUMNS: REPAIR_PLAN_COLUMNS,
    REPAIR_PLAN_SHEET: REPAIR_PLAN_SHEET,
    SNAPSHOT_NAME_PREFIX: SNAPSHOT_NAME_PREFIX,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    scan: () => scanCorruptedRowsNow(),
    writePlan: () => writeRepairPlanNow(),
    apply: () => applyCorruptedRowRepairsNow(),
    wildcardOk: (corrupted, candidate) => corruptionWildcardRegex_(corrupted).test(candidate),
    twinMerge: (a, b) => corruptionTwinMerge_(a, b),
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
/* Seed one snapshot spreadsheet: sheets = {sheetName: {cols, rows}} where cols
 * may be a TRUNCATED (pre-append) column list — the header row IS those cols. */
let snapSeq = 0;
function seedSnapshot(sandbox, name, updated, sheets) {
  const id = 'snap-' + (++snapSeq);
  sandbox.__snapshotFiles.push({ id, name, updated });
  const built = {};
  Object.keys(sheets).forEach((sheetName) => {
    const { cols, rows } = sheets[sheetName];
    built[sheetName] = fakeSheet(arr(cols), (rows || []).map((f) => rowOf(arr(cols), f)));
  });
  sandbox.__snapshotSheets[id] = built;
  return built;
}
function snapshotWriteOps(sandbox) {
  const out = [];
  Object.keys(sandbox.__snapshotSheets).forEach((id) => {
    Object.keys(sandbox.__snapshotSheets[id]).forEach((nm) => {
      sandbox.__snapshotSheets[id][nm].ops
        .filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear' || o.op === 'fmt')
        .forEach((o) => out.push({ id, nm, o }));
    });
  });
  return out;
}
function cellsBy(res, pred) { return res.cells.filter(pred); }

const CLEAN_NAME = 'הדס חלמיש';
const CORRUPT_NAME = 'הד' + FFFD + FFFD;        // wildcard-compatible with CLEAN_NAME
const CLEAN_NOTE = 'הערה חשובה על המטופל';
const CORRUPT_NOTE = 'הערה ' + FFFD + FFFD + ' על המטופל';

/* ===== the shared wildcard/compatibility rule ===== */

test('wildcard rule: segments in order, each U+FFFD run stands for 1+ chars, anchored', () => {
  const { code } = loadCode();
  assert.strictEqual(code.wildcardOk('יע' + FFFD + 'ב', 'יעקב'), true, 'run = exactly one char');
  assert.strictEqual(code.wildcardOk('יע' + FFFD + 'ב', 'יעב'), false, 'run must consume ≥1 char — length-incompatible');
  assert.strictEqual(code.wildcardOk('הד' + FFFD + FFFD, CLEAN_NAME), true, 'trailing run swallows the rest');
  assert.strictEqual(code.wildcardOk(FFFD + 'רה', 'שרה'), true, 'leading run');
  assert.strictEqual(code.wildcardOk('אב' + FFFD, 'צג'), false, 'surviving prefix must lead the candidate');
  assert.strictEqual(code.wildcardOk('א.ב' + FFFD, 'א.בג'), true, 'regex metachars in surviving text are escaped');
  assert.strictEqual(code.wildcardOk('א.ב' + FFFD, 'אXבג'), false, '"." matches literally, not as a wildcard');
});

/* ===== Tier 1 — snapshot repair ===== */

test('snapshot match by fromLead repairs name AND notes; RepairPlan `source` records the tier; snapshots NEVER written', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-05-01', pay: 9000, status: 'active', fromLead: 'id-1', notes: CORRUPT_NOTE },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-05-01', pay: 9000, status: 'active', fromLead: 'id-1', notes: CLEAN_NOTE },
    ] },
  });

  const n = code.writePlan();
  assert.strictEqual(n, 2, 'name + notes plan rows');
  const planSh = sandbox.__sheets[code.REPAIR_PLAN_SHEET];
  const rows = code.readSheet(planSh, arr(code.REPAIR_PLAN_COLUMNS));
  const byCol = {};
  rows.forEach((r) => { byCol[r.column] = r; });

  assert.strictEqual(byCol.name.newValue, CLEAN_NAME, 'name auto-filled from snapshot');
  assert.strictEqual(byCol.notes.newValue, CLEAN_NOTE, 'notes are a free win in the snapshot tier');
  rows.forEach((r) => {
    assert.strictEqual(String(r.approved), 'FALSE', 'still lands as approved=FALSE');
    assert.match(String(r.source), /^repair from snapshot — EZONE-SNAPSHOT /, 'source column records tier + provenance');
  });
  assert.deepStrictEqual(snapshotWriteOps(sandbox), [], 'snapshot spreadsheets are READ-ONLY');
});

test('Leads family: snapshot match by lead id repairs name and free-text note', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'lead-7', name: 'רו' + FFFD + FFFD, phone: '0521111111', stage: 'new', note: 'שי' + FFFD + 'ה' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.LEADS_SHEET]: { cols: LC, rows: [
      { id: 'lead-7', name: 'רותם כהן', phone: '0521111111', stage: 'new', note: 'שיחה' },
    ] },
  });
  const res = code.scan();
  const byCol = {};
  res.cells.forEach((c) => { byCol[c.column] = c; });
  assert.strictEqual(byCol.name.proposal, 'repair from snapshot');
  assert.strictEqual(byCol.name.newValue, 'רותם כהן');
  assert.strictEqual(byCol.note.proposal, 'repair from snapshot');
  assert.strictEqual(byCol.note.newValue, 'שיחה');
});

test('2+ snapshot candidates for the same fromLead → ambiguous: NO proposal, reason logged', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-dup' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      // the readmission pattern: TWO snapshot rows share the fromLead — and
      // both names also wildcard-match the corrupted value, so the roster
      // tier is ambiguous too and cannot mask the snapshot ambiguity here
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-01-01', status: 'released', fromLead: 'id-dup' },
      { houseId: 'ramot', name: 'הדר כהן', date: '2026-05-01', status: 'active', fromLead: 'id-dup' },
    ] },
  });
  const res = code.scan();
  assert.strictEqual(res.cells.length, 1);
  assert.strictEqual(res.cells[0].proposal, 'no source — manual', 'ambiguous → no proposal');
  assert.strictEqual(res.cells[0].newValue, '');
  assert.match(res.cells[0].note, /ambiguous/, 'why is recorded on the finding');
  assert.ok(sandbox.__logs.some((m) => /ambiguous/.test(m)), 'and surfaces in the dry-run log');
});

test('fallback row match (no fromLead): houseId + entryDate + pay; unique hit repairs, 2+ hits do not', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'שר' + FFFD, date: '2026-04-01', pay: 8000, status: 'active' },
    { houseId: 'asher', name: 'דנ' + FFFD, date: '2026-04-02', pay: 7000, status: 'active' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'שרה לוי', date: '2026-04-01', pay: 8000, status: 'active' },
      // two snapshot rows share asher + 2026-04-02 + 7000 → ambiguous
      { houseId: 'asher', name: 'דנה כהן', date: '2026-04-02', pay: 7000, status: 'active' },
      { houseId: 'asher', name: 'דניאל רם', date: '2026-04-02', pay: 7000, status: 'active' },
    ] },
  });
  const res = code.scan();
  const byVal = {};
  res.cells.forEach((c) => { byVal[c.value] = c; });
  assert.strictEqual(byVal['שר' + FFFD].proposal, 'repair from snapshot');
  assert.strictEqual(byVal['שר' + FFFD].newValue, 'שרה לוי');
  assert.notStrictEqual(byVal['דנ' + FFFD].proposal, 'repair from snapshot', 'ambiguous fallback match proposes nothing');
  assert.strictEqual(byVal['דנ' + FFFD].newValue, '');
});

test('column-position tolerance: a snapshot with FEWER (pre-append) columns still repairs the columns it has', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1', notes: CORRUPT_NOTE },
  ]);
  // snapshot pre-dates the source/notes appends: only the first 8 columns
  const truncated = PC.slice(0, 8);
  assert.ok(!truncated.includes('notes'), 'precondition: truncated schema lacks notes');
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: truncated, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
    ] },
  });
  const res = code.scan();
  const byCol = {};
  res.cells.forEach((c) => { byCol[c.column] = c; });
  assert.strictEqual(byCol.name.proposal, 'repair from snapshot', 'columns the snapshot has still repair');
  assert.strictEqual(byCol.name.newValue, CLEAN_NAME);
  assert.strictEqual(byCol.notes.proposal, 'no source — manual', 'a column the snapshot lacks falls through cleanly');
});

test('compatibility guard: clean-but-incompatible snapshot value → "snapshot mismatch — manual", weaker tiers do NOT run', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'דנ' + FFFD, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
  ]);
  // a clean lead puts 'דנה לוי' in the roster — it WOULD match, but must not get a turn
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'other-lead', name: 'דנה לוי', phone: '0529999999', stage: 'new' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      // matched row, clean value, but the surviving 'דנ' prefix is absent → incompatible
      { houseId: 'ramot', name: 'משה כהן', date: '2026-05-01', status: 'active', fromLead: 'id-1' },
    ] },
  });
  const res = code.scan();
  assert.strictEqual(res.cells.length, 1);
  assert.strictEqual(res.cells[0].proposal, 'snapshot mismatch — manual');
  assert.strictEqual(res.cells[0].newValue, '', 'roster never got a turn');
});

test('snapshot priority: OLDEST-modified first; a corrupted newer snapshot value falls through to the older clean one', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
  ]);
  // seeded newest-first to prove the sort, named per the multi-snapshot pattern
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT-AUG', Date.parse('2026-08-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'הדר ' + FFFD, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
    ] },
  });
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT-JULY', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
    ] },
  });
  const res = code.scan();
  assert.deepStrictEqual(plain(res.snapshots), ['EZONE-SNAPSHOT-JULY', 'EZONE-SNAPSHOT-AUG'],
    'priority order is oldest-modified first (newest last)');
  assert.strictEqual(res.cells[0].proposal, 'repair from snapshot');
  assert.strictEqual(res.cells[0].newValue, CLEAN_NAME, 'clean older snapshot wins; corrupted newer one is skipped');
  assert.match(res.cells[0].source, /EZONE-SNAPSHOT-JULY/);
});

/* ===== Tier 2 — closed-set (enum) repair ===== */

test('enum: corrupted house matches exactly ONE legal house name (from the in-code closed set) → repair from enum', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'lead-1', name: 'שם נקי', phone: '0521111111', stage: 'new', house: 'רמות ' + FFFD + 'שבים' },
  ]);
  const res = code.scan();
  const houseCell = res.cells.find((c) => c.column === 'house');
  assert.strictEqual(houseCell.proposal, 'repair from enum');
  assert.strictEqual(houseCell.newValue, 'רמות השבים');
});

test('enum: 2+ legal values match → manual (never guess); legal sets also derive from clean rows (source column)', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    // clean rows define the legal source values
    { id: 'l-1', name: 'א נקי', stage: 'new', source: 'אינסטגרם' },
    { id: 'l-2', name: 'ב נקי', stage: 'new', source: 'אינטרנט' },
    { id: 'l-3', name: 'ג נקי', stage: 'new', source: 'פייסבוק' },
    // corrupted: matches BOTH אינסטגרם and אינטרנט → manual
    { id: 'l-4', name: 'ד נקי', stage: 'new', source: 'אינ' + FFFD },
    // corrupted: matches ONLY פייסבוק → repaired from the derived set
    { id: 'l-5', name: 'ה נקי', stage: 'new', source: 'פיי' + FFFD + 'בוק' },
  ]);
  const res = code.scan();
  const byVal = {};
  cellsBy(res, (c) => c.column === 'source').forEach((c) => { byVal[c.value] = c; });
  assert.strictEqual(byVal['אינ' + FFFD].proposal, 'no source — manual', '2+ matches → manual');
  assert.match(byVal['אינ' + FFFD].note, /2 legal source values match/);
  assert.strictEqual(byVal['פיי' + FFFD + 'בוק'].proposal, 'repair from enum');
  assert.strictEqual(byVal['פיי' + FFFD + 'בוק'].newValue, 'פייסבוק');
});

test('enum: corrupted meetingWith repairs to the single matching manager name; notes never go through enum', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'lead-1', name: 'שם נקי', stage: 'visit', meetingWith: 'ח' + FFFD + 'ן',
      meetingNote: 'ח' + FFFD + 'ן' },  // same corrupted text in a FREE-TEXT column
  ]);
  const res = code.scan();
  const byCol = {};
  res.cells.forEach((c) => { byCol[c.column] = c; });
  assert.strictEqual(byCol.meetingWith.proposal, 'repair from enum');
  assert.strictEqual(byCol.meetingWith.newValue, 'חנן', 'manager closed set (in-code constants)');
  assert.strictEqual(byCol.meetingNote.proposal, 'no source — manual',
    'free-text columns NEVER repair from enum/roster — snapshot or manual only');
});

/* ===== Tier 3 — roster matching + twin-merge ===== */

test('roster: exactly-one clean name (pooled across sheets + snapshots) repairs; length-incompatible names never match', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const PAYC = arr(code.PAYMENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'יע' + FFFD + 'ב', date: '2026-08-01', status: 'active' },
    { houseId: 'asher', name: 'יעב', date: '2026-08-02', status: 'active' },        // length-incompatible candidate
  ]);
  // the ONLY length-compatible candidate lives in a SNAPSHOT (live copies are corrupted)
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PAYMENTS_SHEET]: { cols: PAYC, rows: [
      { id: 'p1', patientName: 'יעקב', houseId: 'ramot', dueDate: '2026-06-01', amount: 100 },
    ] },
  });
  const res = code.scan();
  const cell = res.cells.find((c) => c.value === 'יע' + FFFD + 'ב');
  assert.strictEqual(cell.proposal, 'repair from roster');
  assert.strictEqual(cell.newValue, 'יעקב', '"יעב" is length-incompatible (the run must consume ≥1 char) — exactly one match remains');
});

test('roster: Payments.patientName repairs on an unambiguous name match; 2+ roster matches stay manual', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const PAYC = arr(code.PAYMENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'רותם כהן', date: '2026-05-01', status: 'active' },
    { houseId: 'asher', name: 'רות לוי', date: '2026-05-02', status: 'active' },
  ]);
  seedSheet(code, sandbox, code.PAYMENTS_SHEET, PAYC, [
    { id: 'p1', patientId: 's-1', patientName: 'רותם ' + FFFD + 'הן', houseId: 'ramot', dueDate: '2026-06-01', amount: 100 },
    { id: 'p2', patientId: 's-2', patientName: 'רות' + FFFD, houseId: 'asher', dueDate: '2026-06-01', amount: 100 },
  ]);
  const res = code.scan();
  const byVal = {};
  res.cells.forEach((c) => { byVal[c.value] = c; });
  assert.strictEqual(byVal['רותם ' + FFFD + 'הן'].proposal, 'repair from roster');
  assert.strictEqual(byVal['רותם ' + FFFD + 'הן'].newValue, 'רותם כהן');
  assert.strictEqual(byVal['רות' + FFFD].proposal, 'no source — manual', 'matches both רותם כהן and רות לוי → manual');
  assert.match(byVal['רות' + FFFD].note, /2 roster names match/);
});

test('twin-merge: two same-fromLead rows corrupted in DIFFERENT positions reconstruct the full clean string', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    // union of 'ר�ן' and '�ון' reconstructs 'רון'
    { houseId: 'ramot', name: 'ר' + FFFD + 'ן', date: '2026-08-20', status: 'trial', fromLead: 'id-both' },
    { houseId: 'ramot', name: FFFD + 'ון', date: '2026-08-20', status: 'trial', fromLead: 'id-both' },
  ]);
  const res = code.scan();
  assert.strictEqual(res.cells.length, 2);
  res.cells.forEach((c) => {
    assert.strictEqual(c.proposal, 'repair from twin-merge');
    assert.strictEqual(c.newValue, 'רון');
  });
  assert.strictEqual(res.deletes.length, 0, 'both-corrupted pairs are never delete candidates');
});

test('twin-merge refuses overlapping corruption, clean-char conflicts, and differing lengths', () => {
  const { code } = loadCode();
  assert.strictEqual(code.twinMerge('ר' + FFFD + 'ן', FFFD + 'ון'), 'רון');
  assert.strictEqual(code.twinMerge('ר' + FFFD, FFFD + FFFD), '', 'overlapping U+FFFD → cannot fully reconstruct');
  assert.strictEqual(code.twinMerge('רן' + FFFD, 'רב' + FFFD), '', 'conflicting clean chars → refuse');
  assert.strictEqual(code.twinMerge('ר' + FFFD + 'ן', 'ר' + FFFD), '', 'differing lengths are not mergeable');
  assert.strictEqual(code.twinMerge('', ''), '', 'empty strings merge to nothing');
});

/* ===== pipeline behavior ===== */

test('tier priority: snapshot beats enum for the same cell', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'lead-1', name: 'שם נקי', stage: 'new', house: 'רמות ' + FFFD + 'שבים' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.LEADS_SHEET]: { cols: LC, rows: [
      { id: 'lead-1', name: 'שם נקי', stage: 'new', house: 'רמות השבים' },
    ] },
  });
  const res = code.scan();
  const houseCell = res.cells.find((c) => c.column === 'house');
  assert.strictEqual(houseCell.proposal, 'repair from snapshot', 'first tier with a proposal wins');
  assert.strictEqual(houseCell.newValue, 'רמות השבים');
});

test('no snapshot found: the log says so clearly and tiers 2–3 still run', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'lead-1', name: 'שם נקי', stage: 'new', house: 'רמות ' + FFFD + 'שבים' },
  ]);
  const res = code.scan();
  assert.deepStrictEqual(plain(res.snapshots), []);
  assert.ok(sandbox.__logs.some((m) => /NO SNAPSHOT FOUND/.test(m)), 'log states no snapshot was found');
  const houseCell = res.cells.find((c) => c.column === 'house');
  assert.strictEqual(houseCell.proposal, 'repair from enum', 'enum tier still ran');
});

test('end-to-end: 8-column plan with snapshot proposals applies under the UNCHANGED apply contract', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', Date.parse('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
    ] },
  });
  assert.strictEqual(code.writePlan(), 1);
  const planSh = sandbox.__sheets[code.REPAIR_PLAN_SHEET];

  // approved=FALSE → apply touches nothing
  let res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 0, deleted: 0, skipped: 0 });
  assert.strictEqual(code.readSheet(patientsSh, PC)[0].name, CORRUPT_NAME);

  // Sandra flips approved → the snapshot-proposed value is applied
  const approvedIdx = arr(code.REPAIR_PLAN_COLUMNS).indexOf('approved');
  planSh.grid[1][approvedIdx] = 'TRUE';
  res = code.apply();
  assert.deepStrictEqual(plain(res), { applied: 1, deleted: 0, skipped: 0 });
  assert.strictEqual(code.readSheet(patientsSh, PC)[0].name, CLEAN_NAME);
  assert.deepStrictEqual(snapshotWriteOps(sandbox), [], 'snapshots stayed untouched through the whole pipeline');
});
