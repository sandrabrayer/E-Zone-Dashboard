/* Snapshot-based auto-repair tiers (apps-script/Code.gs) — follow-up to the
 * PR #105 cleanup utilities.
 *
 * A live scan classified almost every U+FFFD cell 'no source — manual'
 * because in-spreadsheet cross-references are scarce. Rows written BEFORE the
 * chunk-split bug went live (2026-07-27) have clean values in a pre-bug
 * spreadsheet copy Sandra names 'EZONE-SNAPSHOT…'. The plan-writer now runs
 * three auto-proposal tiers, first winner takes the cell:
 *   Tier 1 — snapshot: match the live row into read-only EZONE-SNAPSHOT
 *            spreadsheets (Patients by fromLead, else houseId+entryDate+pay;
 *            Leads family + discharged by id), oldest-modified snapshot
 *            first; the value must pass the wildcard COMPATIBILITY guard
 *            (surviving chars in order, each U+FFFD run = 1+ chars) or the
 *            cell terminates as 'snapshot mismatch — manual'.
 *   Tier 2 — enum: closed-set columns; surviving chars must match exactly
 *            ONE legal value (derived from clean rows live + snapshots).
 *   Tier 3 — roster: name columns; exactly one clean name matches. Bonus:
 *            twin-merge of two same-fromLead rows corrupted in different
 *            positions.
 * RepairPlan gains an appended `source` column recording the winning tier.
 * Snapshots are NEVER written (locked here).
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

/* ---------- load Code.gs with GAS globals + a fake DriveApp ---------- */
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
    __snapshotFiles: [],   // [{name, id, lastUpdated: Date}] — Drive search results
    __snapshotSheets: {},  // id → {sheetName: fakeSheet}
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: (id) => {
      if (sandbox.__snapshotSheets[id]) {
        return { getSheetByName: (name) => sandbox.__snapshotSheets[id][name] || null };
      }
      return {
        getSheetByName: (name) => sandbox.__digestSheets[name] || null,
        insertSheet: (name) => (sandbox.__digestSheets[name] = fakeSheet([], [])),
      };
    },
  };
  sandbox.DriveApp = {
    searchFiles: () => {
      const files = sandbox.__snapshotFiles.slice();
      let i = 0;
      return {
        hasNext: () => i < files.length,
        next: () => {
          const f = files[i++];
          return { getName: () => f.name, getId: () => f.id, getLastUpdated: () => f.lastUpdated };
        },
      };
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
    REPAIR_PLAN_COLUMNS: REPAIR_PLAN_COLUMNS,
    REPAIR_PLAN_SHEET: REPAIR_PLAN_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    scan: () => scanCorruptedRowsNow(),
    writePlan: () => writeRepairPlanNow(),
    matches: (c, s) => corruptionPatternMatches_(c, s),
    merge: (a, b) => mergeCorruptedTwins_(a, b),
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
/* Register one EZONE-SNAPSHOT spreadsheet. `sheets` maps sheet name →
 * {cols (array of live column names, may be a truncated prefix), rows
 * (field objects)}. */
function seedSnapshot(sandbox, name, lastUpdated, sheets) {
  const id = 'snap-' + name;
  sandbox.__snapshotFiles.push({ name, id, lastUpdated });
  const byName = {};
  Object.keys(sheets).forEach((sheetName) => {
    const spec = sheets[sheetName];
    byName[sheetName] = fakeSheet(spec.cols, spec.rows.map((f) => rowOf(spec.cols, f)));
  });
  sandbox.__snapshotSheets[id] = byName;
  return byName;
}
function cellFor(res, value) {
  return res.cells.find((c) => c.value === value);
}

const LEAD_ID = 'id-tzxpotqwmth4fh15';
const CORRUPT_NAME = 'הד' + FFFD + FFFD;          // surviving 'הד' + run
const CLEAN_NAME = 'הדס חלמיש';
const CORRUPT_NOTES = 'הע' + FFFD + 'ות';         // 'הערות' with one run
const CLEAN_NOTES = 'הערות';

/* ===== the wildcard compatibility rule ===== */

test('corruptionPatternMatches_: anchored, in-order, each U+FFFD run = 1+ chars', () => {
  const { code } = loadCode();
  assert.strictEqual(code.matches('הד' + FFFD, 'הדס'), true);
  assert.strictEqual(code.matches('הד' + FFFD, 'הד'), false, 'a run must consume at least one char');
  assert.strictEqual(code.matches(FFFD + 'דס', 'הדס'), true, 'leading run');
  assert.strictEqual(code.matches('ה' + FFFD + FFFD + 'ה', 'הדסה'), true, 'run length ≠ char count (2 marks, 2 chars ok)');
  assert.strictEqual(code.matches('ה' + FFFD + FFFD + 'ה', 'הליה'), true);
  assert.strictEqual(code.matches('הד' + FFFD, 'סהד'), false, 'anchored at the start');
  assert.strictEqual(code.matches('הד' + FFFD, 'אחרת לגמרי'), false);
  assert.strictEqual(code.matches('נקי', 'נקי'), true, 'no corruption → exact equality');
  assert.strictEqual(code.matches('נקי', 'אחר'), false);
  assert.strictEqual(code.matches('הד' + FFFD, 'הד' + FFFD + 'ס'), false, 'a corrupted candidate never matches');
});

/* ===== Tier 1: snapshot ===== */

test('snapshot match by fromLead repairs name AND notes; plan records the tier + snapshot name in `source`', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-06-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID, notes: CORRUPT_NOTES },
  ]);
  const snapSheets = seedSnapshot(sandbox, 'EZONE-SNAPSHOT', new Date('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-06-01', pay: 9000, status: 'active',
        source: 'lead', fromLead: LEAD_ID, notes: CLEAN_NOTES },
    ] },
  });

  const res = code.scan();
  const nameCell = cellFor(res, CORRUPT_NAME);
  const notesCell = cellFor(res, CORRUPT_NOTES);
  assert.deepStrictEqual(
    { p: nameCell.proposal, v: nameCell.newValue, s: nameCell.source },
    { p: 'repair from snapshot', v: CLEAN_NAME, s: 'EZONE-SNAPSHOT' });
  assert.deepStrictEqual(
    { p: notesCell.proposal, v: notesCell.newValue },
    { p: 'repair from snapshot', v: CLEAN_NOTES },
    'long-text columns get the snapshot tier too (free win)');
  assert.deepStrictEqual(plain(res.snapshots), ['EZONE-SNAPSHOT']);

  code.writePlan();
  const planRows = code.readSheet(sandbox.__sheets[code.REPAIR_PLAN_SHEET], arr(code.REPAIR_PLAN_COLUMNS));
  const nameRow = planRows.find((r) => r.oldValue === CORRUPT_NAME);
  assert.deepStrictEqual(
    { newValue: nameRow.newValue, approved: String(nameRow.approved), source: nameRow.source },
    { newValue: CLEAN_NAME, approved: 'FALSE', source: 'repair from snapshot (EZONE-SNAPSHOT)' });

  // Snapshots are READ-ONLY — no write op of any kind ever lands on them.
  const writes = snapSheets[code.PATIENTS_SHEET].ops
    .filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear' || o.op === 'fmt');
  assert.deepStrictEqual(writes, [], 'snapshot never written');
});

test('fromLead-less Patients row falls back to houseId + entryDate + pay matching', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-06-01', pay: 9000, status: 'active', source: 'direct_admin' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', new Date('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: CLEAN_NAME, date: '2026-06-01', pay: 9000, status: 'active', source: 'direct_admin' },
      { houseId: 'ramot', name: 'אחרת', date: '2026-05-05', pay: 7000, status: 'active' },
    ] },
  });
  const res = code.scan();
  const cell = cellFor(res, CORRUPT_NAME);
  assert.deepStrictEqual({ p: cell.proposal, v: cell.newValue },
    { p: 'repair from snapshot', v: CLEAN_NAME });
});

test('ambiguous snapshot match (2+ candidate rows) → NO snapshot proposal, reason logged', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-06-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', new Date('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'הדס כהן', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
      { houseId: 'ramot', name: 'הדס לוי', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
    ] },
  });
  const res = code.scan();
  const cell = cellFor(res, CORRUPT_NAME);
  assert.notStrictEqual(cell.proposal, 'repair from snapshot', 'ambiguity is never guessed');
  assert.strictEqual(cell.proposal, 'no source — manual',
    'roster is ambiguous too (both snapshot names match) → manual');
  assert.ok(sandbox.__logs.some((m) => /ambiguous/.test(m)), 'ambiguity logged with why');
});

test('column-position tolerance: a snapshot with FEWER columns than the live schema still repairs', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    { id: 'id-old-lead', name: 'רו' + FFFD + 'ם', phone: '0521111111', stage: 'admitted' },
  ]);
  // Pre-appended-columns era snapshot: only the first 6 lead columns exist.
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', new Date('2026-07-20'), {
    [code.LEADS_SHEET]: { cols: LC.slice(0, 6), rows: [
      { id: 'id-old-lead', name: 'רותם', phone: '0521111111', house: 'רעננה' },
    ] },
  });
  const res = code.scan();
  const cell = cellFor(res, 'רו' + FFFD + 'ם');
  assert.deepStrictEqual({ p: cell.proposal, v: cell.newValue },
    { p: 'repair from snapshot', v: 'רותם' });
});

test('compatibility guard: an incompatible snapshot value TERMINATES as snapshot mismatch — manual (no tier shopping)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-06-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
    // A clean roster name compatible with the corrupted value — must NOT be
    // used once the snapshot has flagged an identity mismatch.
    { houseId: 'ramot', name: 'הדסה', date: '2026-05-01', pay: 8000, status: 'active' },
  ]);
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT', new Date('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'אחרת לגמרי', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
    ] },
  });
  const res = code.scan();
  const cell = cellFor(res, CORRUPT_NAME);
  assert.deepStrictEqual({ p: cell.proposal, v: cell.newValue, s: cell.source },
    { p: 'snapshot mismatch — manual', v: '', s: 'EZONE-SNAPSHOT' });
  assert.ok(sandbox.__logs.some((m) => /INCOMPATIBLE/.test(m)), 'mismatch logged');
});

test('snapshot priority: oldest-modified first; non-prefix names are not snapshots', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: CORRUPT_NAME, date: '2026-06-01', pay: 9000, status: 'active',
      source: 'lead', fromLead: LEAD_ID },
  ]);
  // Registered newest-first to prove sorting, plus a non-prefix decoy that
  // must be ignored despite Drive's contains-match returning it.
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT-NEW', new Date('2026-08-30'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'הדס חדשה', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
    ] },
  });
  seedSnapshot(sandbox, 'BACKUP-EZONE-SNAPSHOT', new Date('2026-01-01'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'הדס דקוי', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
    ] },
  });
  seedSnapshot(sandbox, 'EZONE-SNAPSHOT-JULY', new Date('2026-07-20'), {
    [code.PATIENTS_SHEET]: { cols: PC, rows: [
      { houseId: 'ramot', name: 'הדס ותיקה', date: '2026-06-01', pay: 9000, fromLead: LEAD_ID },
    ] },
  });
  const res = code.scan();
  assert.deepStrictEqual(plain(res.snapshots), ['EZONE-SNAPSHOT-JULY', 'EZONE-SNAPSHOT-NEW'],
    'prefix-filtered, sorted oldest-modified first (newest last in priority)');
  const cell = cellFor(res, CORRUPT_NAME);
  assert.deepStrictEqual({ v: cell.newValue, s: cell.source },
    { v: 'הדס ותיקה', s: 'EZONE-SNAPSHOT-JULY' }, 'oldest snapshot wins');
});

/* ===== Tier 2: closed-set (enum) ===== */

test('enum tier: surviving chars matching exactly ONE legal value repairs; 2+ matches → manual', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  seedSheet(code, sandbox, code.LEADS_SHEET, LC, [
    // clean rows define the closed set for `house`
    { id: 'l1', name: 'אחת', house: 'רעננה', stage: 'new' },
    { id: 'l2', name: 'שתיים', house: 'רמות', stage: 'new' },
    // exactly one legal value matches רע…ה
    { id: 'l3', name: 'שלוש', house: 'רע' + FFFD + 'נה', stage: 'new' },
    // ר… matches BOTH רעננה and רמות → ambiguous → manual
    { id: 'l4', name: 'ארבע', house: 'ר' + FFFD, stage: 'new' },
  ]);
  const res = code.scan();
  const one = cellFor(res, 'רע' + FFFD + 'נה');
  assert.deepStrictEqual({ p: one.proposal, v: one.newValue, s: one.source },
    { p: 'repair from enum', v: 'רעננה', s: 'enum:house' });
  const two = cellFor(res, 'ר' + FFFD);
  assert.strictEqual(two.proposal, 'no source — manual', '2+ enum matches are never guessed');
  assert.ok(sandbox.__logs.some((m) => /NO SNAPSHOT FOUND/.test(m)),
    'missing snapshot is stated clearly; tiers 2–3 ran anyway');
});

/* ===== Tier 3: roster + twin-merge ===== */

test('roster tier: exactly one clean name matches (U+FFFD run = 1+ chars, so a shorter name cannot match)', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'ד' + FFFD + 'ה', date: '2026-06-01', pay: 9000, status: 'active' },
    { houseId: 'ramot', name: 'דה', date: '2026-05-01', pay: 8000, status: 'active' },  // too short — run needs ≥1 char
    { houseId: 'ramot', name: 'דנה', date: '2026-04-01', pay: 8000, status: 'active' }, // the single legal completion
  ]);
  const res = code.scan();
  const cell = cellFor(res, 'ד' + FFFD + 'ה');
  assert.deepStrictEqual({ p: cell.proposal, v: cell.newValue, s: cell.source },
    { p: 'repair from roster', v: 'דנה', s: 'roster' });
});

test('roster tier: two length-compatible roster names → manual, never guessed', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'ד' + FFFD + 'ה', date: '2026-06-01', pay: 9000, status: 'active' },
    { houseId: 'ramot', name: 'דנה', date: '2026-05-01', pay: 8000, status: 'active' },
    { houseId: 'ramot', name: 'דינה', date: '2026-04-01', pay: 8000, status: 'active' },
  ]);
  const res = code.scan();
  assert.strictEqual(cellFor(res, 'ד' + FFFD + 'ה').proposal, 'no source — manual');
});

test('twin-merge: two same-fromLead rows corrupted in DIFFERENT positions reconstruct the clean name', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const A = 'ה' + FFFD + 'סה';  // ה?סה
  const B = 'הד' + FFFD + 'ה';  // הד?ה
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: A, date: '2026-06-01', pay: 9000, status: 'active', fromLead: LEAD_ID },
    { houseId: 'ramot', name: B, date: '2026-06-01', pay: 9000, status: 'active', fromLead: LEAD_ID },
  ]);
  const res = code.scan();
  assert.deepStrictEqual(
    { a: cellFor(res, A).proposal, av: cellFor(res, A).newValue,
      b: cellFor(res, B).proposal, bv: cellFor(res, B).newValue },
    { a: 'repair from twin-merge', av: 'הדסה', b: 'repair from twin-merge', bv: 'הדסה' });

  // The primitive itself: conflicts / overlapping corruption / length
  // mismatch all refuse; complementary corruption merges positionally.
  assert.strictEqual(code.merge('ה' + FFFD, FFFD + 'ה'), 'הה', 'complementary positions merge deterministically');
  assert.strictEqual(code.merge('א' + FFFD, 'ב' + FFFD), '', 'clean positions conflict');
  assert.strictEqual(code.merge('א' + FFFD, 'א' + FFFD), '', 'overlapping corruption never merges');
  assert.strictEqual(code.merge('אב', 'אבג'), '', 'length mismatch never merges');
  assert.strictEqual(code.merge('א' + FFFD + 'ג', 'אב' + FFFD), 'אבג');
});
