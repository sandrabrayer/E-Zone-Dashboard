/* Automated revision harvesting (apps-script/Code.gs).
 *
 * Context under test: a single pre-bug snapshot covers only rows created
 * before 2026-07-27, but corruption happened on read→rewrite cycles through
 * 2026-08-31 — each row's last clean value lives in a DIFFERENT revision.
 * harvestRevisionSnapshotsNow lists the container spreadsheet's Drive
 * revisions, selects a spread across the corruption window, exports each as
 * xlsx and rebuilds it as a Google Sheet named EZONE-SNAPSHOT-AUTO-<date>,
 * which the existing corruptionSnapshots_ prefix discovery consumes.
 * deleteAutoSnapshotsNow cleans up. The tier-1 fallback matcher
 * (houseId+entryDate+pay) now disambiguates 2+ candidates by the corrupted
 * NAME's surviving characters.
 *
 * Locked contracts:
 *   - revision selection: baseline (newest pre-2026-07-27) + latest per
 *     ~6-day bucket + newest pre-fix, sparse-tolerant, capped at ~10, one
 *     per calendar day, post-window revisions never selected;
 *   - idempotent: an existing EZONE-SNAPSHOT-AUTO-<date> file is skipped —
 *     re-running only fills gaps, never duplicates;
 *   - per-revision failure isolation: one failed export logs and continues;
 *   - deleteAutoSnapshotsNow trashes ONLY the full AUTO prefix — the manual
 *     EZONE-SNAPSHOT (and any non-AUTO prefixed copy) is NEVER touched;
 *   - corruptionSnapshots_ orders by the date ENCODED in the name when
 *     present (harvested files are all created at harvest time, so
 *     lastUpdated says nothing about content age);
 *   - fallback-key disambiguation: exactly one candidate whose clean name is
 *     wildcard-compatible with the corrupted name → match; 2+ compatible →
 *     still ambiguous, no proposal;
 *   - neither new public function is dispatchable via handle_.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention, with
 * Drive advanced service / UrlFetchApp / ScriptApp stubbed. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));
const FFFD = '�';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------- minimal fake Sheet (as sibling tests) ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() {},
    isSheetHidden() { return true; },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
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

/* ---------- load Code.gs with GAS + Drive/UrlFetch/ScriptApp stubbed ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  let uuid = 0;
  let autoId = 0;
  const logs = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isNaN, encodeURIComponent,
    Logger: { log: (m) => logs.push(String(m)) },
    __sheets: {},          // live spreadsheet sheets by name
    __sheetsById: {},      // snapshot spreadsheets: file id → {sheetName: fakeSheet}
    __driveFiles: [],      // {id, name, updated, trashed} — DriveApp + Drive.Files share it
    __revisions: [],       // raw v3 revision objects served by Drive.Revisions.list
    __failUrls: {},        // url → true ⇒ UrlFetchApp returns HTTP 500
    __fetches: [],         // every UrlFetchApp call, for assertions
    __created: [],         // every Drive.Files.create call, for assertions
    __props: {},
    __logs: logs,
  };
  const liveFiles = () => sandbox.__driveFiles.filter((f) => !f.trashed);
  const fileObj = (f) => ({
    getId: () => f.id,
    getName: () => f.name,
    getLastUpdated: () => new Date(f.updated),
    setTrashed: (v) => { f.trashed = !!v; },
  });
  const fileIter = (files) => {
    let i = 0;
    return { hasNext: () => i < files.length, next: () => fileObj(files[i++]) };
  };
  sandbox.DriveApp = {
    searchFiles: (q) => {
      const m = String(q).match(/"([^"]+)"/);
      const needle = m ? m[1] : '';
      return fileIter(liveFiles().filter((f) => f.name.includes(needle)));
    },
    getFilesByName: (n) => fileIter(liveFiles().filter((f) => f.name === n)),
  };
  sandbox.Drive = {
    Revisions: {
      list: (fileId, args) => ({ revisions: sandbox.__revisions }),
    },
    Files: {
      create: (meta, blob) => {
        const id = 'auto-' + (++autoId);
        sandbox.__created.push({ meta: plain(meta), blob });
        sandbox.__driveFiles.push({ id, name: meta.name, updated: Date.now(), trashed: false });
        return { id };
      },
    },
  };
  sandbox.UrlFetchApp = {
    fetch: (url, opts) => {
      sandbox.__fetches.push({ url: String(url), opts });
      assert.ok(opts && opts.headers && /^Bearer /.test(opts.headers.Authorization),
        'every Drive REST fetch carries the OAuth bearer token');
      if (sandbox.__failUrls[url]) {
        return { getResponseCode: () => 500, getContentText: () => 'boom', getBlob: () => { throw new Error('no blob'); } };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({}),
        getBlob: () => ({ __xlsxFrom: String(url) }),
      };
    },
  };
  sandbox.ScriptApp = { getOAuthToken: () => 'test-token', getProjectTriggers: () => [] };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getId: () => 'live-spreadsheet-id',
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: (id) => {
      const sheets = sandbox.__sheetsById[id];
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
    SNAPSHOT_NAME_PREFIX: SNAPSHOT_NAME_PREFIX,
    AUTO_SNAPSHOT_PREFIX: AUTO_SNAPSHOT_PREFIX,
    XLSX_EXPORT_MIME: XLSX_EXPORT_MIME,
    scan: () => scanCorruptedRowsNow(),
    harvest: () => harvestRevisionSnapshotsNow(),
    deleteAuto: () => deleteAutoSnapshotsNow(),
    select: (revs, opts) => selectHarvestRevisions_(normalizeRevisions_(revs), opts),
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
function rev(id, iso, exportLinks) {
  return { id, modifiedTime: iso, exportLinks: exportLinks === undefined
    ? { [XLSX_MIME]: 'https://export/' + id } : exportLinks };
}
function filesNamed(sandbox, name) {
  return sandbox.__driveFiles.filter((f) => f.name === name && !f.trashed);
}

/* ===== revision selection (pure) ===== */

test('selection windowing, sparse revisions: baseline + what exists in the window; post-window never selected', () => {
  const { code } = loadCode();
  const revs = [
    rev('r1', '2026-07-01T10:00:00Z'),
    rev('r2', '2026-07-20T10:00:00Z'),   // baseline: newest pre-2026-07-27
    rev('r3', '2026-08-10T10:00:00Z'),   // the only in-window revision (sparse)
    rev('r4', '2026-09-05T10:00:00Z'),   // post-window: never selected
  ];
  const sel = code.select(revs);
  assert.deepStrictEqual(plain(sel.map((r) => r.dateLabel)), ['2026-07-20', '2026-08-10'],
    'baseline + the one sparse in-window revision (also the newest pre-fix), ascending; r4 excluded');
  assert.deepStrictEqual(plain(sel.map((r) => r.id)), ['r2', 'r3']);
});

test('selection windowing, dense revisions: capped at ~10, baseline first, newest pre-fix last, one per bucket', () => {
  const { code } = loadCode();
  const revs = [];
  for (let d = new Date('2026-07-01T20:00:00Z'); d < new Date('2026-09-01T00:00:00Z'); d = new Date(d.getTime() + 86400000)) {
    revs.push(rev('r-' + d.toISOString().slice(0, 10), d.toISOString()));
  }
  const sel = code.select(revs);
  assert.ok(sel.length <= 10, 'cap holds under daily revisions (got ' + sel.length + ')');
  assert.ok(sel.length >= 6, 'a real spread is still selected (got ' + sel.length + ')');
  assert.strictEqual(sel[0].dateLabel, '2026-07-26', 'baseline: newest revision BEFORE the bug went live');
  assert.strictEqual(sel[sel.length - 1].dateLabel, '2026-08-31', 'newest pre-fix revision always kept');
  const labels = sel.map((r) => r.dateLabel);
  assert.deepStrictEqual(labels.slice().sort(), labels, 'ascending');
  assert.strictEqual(new Set(labels).size, labels.length, 'one per calendar day');
});

test('selection: no pre-bug revision at all → no baseline, window picks still work', () => {
  const { code } = loadCode();
  const sel = code.select([rev('r1', '2026-08-15T10:00:00Z')]);
  assert.deepStrictEqual(plain(sel.map((r) => r.dateLabel)), ['2026-08-15']);
});

/* ===== harvest: end-to-end, idempotency, failure isolation ===== */

test('harvest exports each selected revision and rebuilds it as EZONE-SNAPSHOT-AUTO-<date>; scan then consumes it', () => {
  const { code, sandbox } = loadCode();
  sandbox.__revisions = [
    rev('r1', '2026-07-20T10:00:00Z'),
    rev('r2', '2026-08-10T10:00:00Z'),
  ];
  const res = code.harvest();
  assert.deepStrictEqual(plain(res), { found: 2, selected: 2, harvested: 2, skipped: 0, failed: 0 });
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-07-20').length, 1);
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-08-10').length, 1);
  sandbox.__created.forEach((c) => {
    assert.strictEqual(c.meta.mimeType, 'application/vnd.google-apps.spreadsheet', 'xlsx CONVERTED to a real Sheet');
    assert.ok(c.blob && c.blob.__xlsxFrom, 'created from the exported xlsx blob');
  });
  // the harvested names are exactly what tier-1 discovery consumes
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'הד' + FFFD, date: '2026-05-01', status: 'active', fromLead: 'id-1' },
  ]);
  sandbox.__driveFiles.forEach((f) => {
    sandbox.__sheetsById[f.id] = {
      [code.PATIENTS_SHEET]: fakeSheet(PC, [rowOf(PC,
        { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-05-01', status: 'active', fromLead: 'id-1' })]),
    };
  });
  const scan = code.scan();
  assert.deepStrictEqual(plain(scan.snapshots),
    ['EZONE-SNAPSHOT-AUTO-2026-07-20', 'EZONE-SNAPSHOT-AUTO-2026-08-10'],
    'prefix discovery picks the harvested files up, oldest encoded date first');
  assert.strictEqual(scan.cells[0].proposal, 'repair from snapshot');
});

test('idempotent: a date already harvested is SKIPPED — re-running fills gaps, never duplicates', () => {
  const { code, sandbox } = loadCode();
  sandbox.__revisions = [
    rev('r1', '2026-07-20T10:00:00Z'),
    rev('r2', '2026-08-10T10:00:00Z'),
  ];
  sandbox.__driveFiles.push({ id: 'pre', name: 'EZONE-SNAPSHOT-AUTO-2026-07-20', updated: Date.now(), trashed: false });
  const res = code.harvest();
  assert.deepStrictEqual(plain(res), { found: 2, selected: 2, harvested: 1, skipped: 1, failed: 0 });
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-07-20').length, 1, 'no duplicate created');
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-08-10').length, 1, 'the gap was filled');
  // and a full re-run is a complete no-op
  const res2 = code.harvest();
  assert.deepStrictEqual(plain(res2), { found: 2, selected: 2, harvested: 0, skipped: 2, failed: 0 });
});

test('per-revision failure isolation: one failed export logs and continues; the rest still harvest', () => {
  const { code, sandbox } = loadCode();
  sandbox.__revisions = [
    rev('r1', '2026-07-20T10:00:00Z'),
    rev('r2', '2026-08-10T10:00:00Z'),
  ];
  sandbox.__failUrls['https://export/r1'] = true;
  const res = code.harvest();
  assert.deepStrictEqual(plain(res), { found: 2, selected: 2, harvested: 1, skipped: 0, failed: 1 });
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-07-20').length, 0, 'failed revision produced no file');
  assert.strictEqual(filesNamed(sandbox, 'EZONE-SNAPSHOT-AUTO-2026-08-10').length, 1, 'later revision unaffected');
  assert.ok(sandbox.__logs.some((m) => /FAILED EZONE-SNAPSHOT-AUTO-2026-07-20/.test(m)), 'failure is logged');
  assert.ok(sandbox.__logs.some((m) => /1 failed/.test(m)), 'summary counts the failure');
});

/* ===== cleanup ===== */

test('deleteAutoSnapshotsNow trashes ONLY -AUTO- files; the manual EZONE-SNAPSHOT is NEVER touched', () => {
  const { code, sandbox } = loadCode();
  sandbox.__driveFiles.push(
    { id: 'm1', name: 'EZONE-SNAPSHOT', updated: Date.now(), trashed: false },
    { id: 'm2', name: 'EZONE-SNAPSHOT-JULY', updated: Date.now(), trashed: false },
    { id: 'a1', name: 'EZONE-SNAPSHOT-AUTO-2026-07-20', updated: Date.now(), trashed: false },
    { id: 'a2', name: 'EZONE-SNAPSHOT-AUTO-2026-08-10', updated: Date.now(), trashed: false },
  );
  const res = code.deleteAuto();
  assert.deepStrictEqual(plain(res), { trashed: 2 });
  const byId = {};
  sandbox.__driveFiles.forEach((f) => { byId[f.id] = f; });
  assert.strictEqual(byId.m1.trashed, false, 'manual EZONE-SNAPSHOT untouched');
  assert.strictEqual(byId.m2.trashed, false, 'manual non-AUTO copy untouched');
  assert.strictEqual(byId.a1.trashed, true);
  assert.strictEqual(byId.a2.trashed, true);
});

/* ===== discovery ordering with encoded dates ===== */

test('corruptionSnapshots_ orders by the date ENCODED in the name, not lastUpdated; undated manual keeps lastUpdated', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    { houseId: 'ramot', name: 'x' + FFFD, date: '2026-05-01', status: 'active' },
  ]);
  // lastUpdated deliberately INVERTED vs content age: harvested files are all
  // created at harvest time, so only the encoded date is meaningful.
  sandbox.__driveFiles.push(
    { id: 's-new', name: 'EZONE-SNAPSHOT-AUTO-2026-08-10', updated: Date.parse('2026-09-02T10:00:00Z'), trashed: false },
    { id: 's-old', name: 'EZONE-SNAPSHOT-AUTO-2026-07-20', updated: Date.parse('2026-09-02T11:00:00Z'), trashed: false },
    { id: 's-manual', name: 'EZONE-SNAPSHOT', updated: Date.parse('2026-07-01T10:00:00Z'), trashed: false },
  );
  const empty = { [code.PATIENTS_SHEET]: fakeSheet(PC, []) };
  sandbox.__sheetsById['s-new'] = empty;
  sandbox.__sheetsById['s-old'] = empty;
  sandbox.__sheetsById['s-manual'] = empty;
  const res = code.scan();
  assert.deepStrictEqual(plain(res.snapshots),
    ['EZONE-SNAPSHOT', 'EZONE-SNAPSHOT-AUTO-2026-07-20', 'EZONE-SNAPSHOT-AUTO-2026-08-10'],
    'manual by lastUpdated (2026-07-01) first, then AUTO files by encoded date — creation order irrelevant');
});

/* ===== tier-1 fallback matcher disambiguation ===== */

function seedFallbackScenario(code, sandbox, snapshotNames) {
  const PC = arr(code.PATIENT_COLUMNS);
  seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    // no fromLead → fallback key houseId+entryDate+pay
    { houseId: 'ramot', name: 'שר' + FFFD, date: '2026-04-01', pay: 8000, status: 'active' },
  ]);
  sandbox.__driveFiles.push({ id: 'snap', name: 'EZONE-SNAPSHOT', updated: Date.parse('2026-07-01T00:00:00Z'), trashed: false });
  sandbox.__sheetsById.snap = {
    [code.PATIENTS_SHEET]: fakeSheet(PC, snapshotNames.map((nm) => rowOf(PC,
      { houseId: 'ramot', name: nm, date: '2026-04-01', pay: 8000, status: 'active' }))),
  };
}

test('fallback-key collision, exactly ONE name-compatible candidate → disambiguated, repaired from snapshot', () => {
  const { code, sandbox } = loadCode();
  seedFallbackScenario(code, sandbox, ['שרה לוי', 'משה כהן']); // both share the fallback key; one compatible with שר�
  const res = code.scan();
  assert.strictEqual(res.cells.length, 1);
  assert.strictEqual(res.cells[0].proposal, 'repair from snapshot');
  assert.strictEqual(res.cells[0].newValue, 'שרה לוי', 'the corrupted name\'s surviving chars broke the tie');
});

test('fallback-key collision, TWO name-compatible candidates → still ambiguous, no proposal', () => {
  const { code, sandbox } = loadCode();
  seedFallbackScenario(code, sandbox, ['שרה לוי', 'שרון כץ']); // both compatible with שר�
  const res = code.scan();
  assert.strictEqual(res.cells.length, 1);
  assert.notStrictEqual(res.cells[0].proposal, 'repair from snapshot');
  assert.strictEqual(res.cells[0].newValue, '', 'a machine must not guess between two compatible names');
  assert.match(res.cells[0].note, /ambiguous/);
});

/* ===== dispatch guard ===== */

test('source-scan: harvest + cleanup are public but never dispatchable via handle_', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  for (const fn of ['harvestRevisionSnapshotsNow', 'deleteAutoSnapshotsNow']) {
    assert.ok(new RegExp('function ' + fn + '\\(\\)').test(src), fn + ' is public (Run dropdown)');
  }
  const handleStart = src.indexOf('function handle_');
  const handleEnd = src.indexOf('\nfunction ', handleStart + 1);
  const handleBody = src.slice(handleStart, handleEnd);
  for (const fn of ['harvestRevisionSnapshotsNow', 'deleteAutoSnapshotsNow']) {
    assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
  }
});
