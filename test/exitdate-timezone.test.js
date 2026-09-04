/* Patient exitDate timezone drift (apps-script/Code.gs).
 *
 * Bug: replaceHousePatients_ text-forced the entry `date` column before
 * writing but NOT `exitDate`, so Sheets coerced a discharge entered as
 * 2026-05-07 into a date-typed cell; getValues() returned a Date, it
 * serialized to the client as "2026-05-06T21:00:00.000Z" (Israel is UTC+3),
 * and the day drifted −1. The same pitfall was fixed earlier for `date` and
 * for the leads' visitDate/visitTime.
 *
 * Locked contracts:
 *   - asISODate_: a Date at 21:00Z → the NEXT local day; a tz-marked ISO
 *     timestamp string → the local day (not the sliced UTC one); a Sheets
 *     date serial → its exact day; a bare 'YYYY-MM-DD' passes through; blank
 *     stays blank;
 *   - replaceHousePatients_ writes exitDate as 'YYYY-MM-DD' even when the
 *     payload carries a timestamp or the sheet cell is a Date, text-forces
 *     the exitDate column BEFORE the write (op order + source-scan guard),
 *     and a storage-form-only difference never re-stamps updatedAt;
 *   - getData_ serializes a Date-typed exitDate / date as 'YYYY-MM-DD' for
 *     Patients and DischargedPatients (normalize on read);
 *   - dischargePatient_ (upsertRowById_) normalizes + text-forces date and
 *     exitDate at the target row; tombstones snapshot exitDate normalized;
 *   - sheet-ensure text-forces exitDate on Patients / DischargedPatients /
 *     PatientsTombstones (whole column);
 *   - repairPatientExitDatesNow converts Date, serial and ISO-timestamp
 *     exitDate cells (and entry `date` cells, same pass — the discharged
 *     sheet's date column gains a whole-column text force in this change,
 *     which turns a legacy date-typed cell into a numeric serial until it is
 *     rewritten), leaves clean strings and blanks alone, does not touch
 *     updatedAt/updatedBy, audit-logs the counts, is idempotent (second run
 *     = 0 writes, no audit row); previewPatientExitDatesNow writes nothing;
 *     neither is dispatchable via handle_;
 *   - parseDate_ reads a Sheets date serial as its calendar day.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention. Unlike the
 * sibling suites, Utilities.formatDate is stubbed TIMEZONE-AWARE (Intl in
 * the requested tz) — the whole point here is the local-day conversion. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- timezone-aware Utilities.formatDate stand-in ---------- */
function formatDateStub(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((x) => x.type === t).value;
  if (fmt === 'HH:mm') return get('hour').replace(/^24$/, '00') + ':' + get('minute');
  if (fmt === 'yyyy-MM') return get('year') + '-' + get('month');
  return get('year') + '-' + get('month') + '-' + get('day');
}

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
      const range = {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); return range; },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c, v });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
          return range;
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
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc, vals: vals.map((x) => x.slice()) });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
          return range;
        },
        clearContent() {
          ops.push({ op: 'clear', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
          return range;
        },
      };
      return range;
    },
  };
}

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
    __props: {},
    __logs: logs,
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
  sandbox.Utilities = { getUuid: () => 'uuid-' + (++uuid), formatDate: formatDateStub };
  sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS, PATIENTS_SHEET,
    PATIENT_TOMBSTONE_COLUMNS, PATIENTS_TOMBSTONES_SHEET,
    DISCHARGED_PATIENT_COLUMNS, DISCHARGED_PATIENTS_SHEET,
    AUDIT_LOG_COLUMNS, AUDIT_LOG_SHEET,
    asISODate: (v) => asISODate_(v),
    parseDate: (v) => parseDate_(v),
    readSheet: (sh, cols) => readSheet_(sh, cols),
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    getData: () => getData_(),
    handle: (params) => handle_(params).json,
    saveAll: (l, p, u) => saveAll_(l, p, u),
    discharge: (p, u) => dischargePatient_(p, u),
    del: (p, u) => deletePatientRow_(p, u),
    repair: () => repairPatientExitDatesNow(),
    preview: () => previewPatientExitDatesNow(),
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
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}
const writeOps = (sh) => sh.ops.filter((o) => o.op === 'set' || o.op === 'setcell' || o.op === 'clear');

/* Local midnight 2026-05-07 in Israel (IDT, UTC+3) as the Date getValues()
 * hands back for a date-typed cell — it serializes as 2026-05-06T21:00Z. */
const SUMMER_DATE = new Date('2026-05-06T21:00:00.000Z');
const SUMMER_TS   = '2026-05-06T21:00:00.000Z';
/* Sheets date serial for 2026-05-07 (days since 1899-12-30). */
const SUMMER_SERIAL = Date.UTC(2026, 4, 7) / 86400000 + 25569;

/* ===== A. asISODate_ ===== */

test('asISODate_: a Date at 21:00Z is the NEXT local day (summer and winter)', () => {
  const { code } = loadCode();
  assert.strictEqual(code.asISODate(SUMMER_DATE), '2026-05-07', 'IDT: 21:00Z → local 2026-05-07');
  assert.strictEqual(code.asISODate(new Date('2026-01-14T22:00:00.000Z')), '2026-01-15', 'IST: 22:00Z → local 2026-01-15');
  // Sanity: the UTC slice this replaces would have been the previous day.
  assert.strictEqual(SUMMER_DATE.toISOString().slice(0, 10), '2026-05-06');
});

test('asISODate_: a tz-marked ISO timestamp STRING is re-localized, not sliced', () => {
  const { code } = loadCode();
  assert.strictEqual(code.asISODate(SUMMER_TS), '2026-05-07');
  assert.strictEqual(code.asISODate('2026-01-14T22:00:00Z'), '2026-01-15');
  assert.strictEqual(code.asISODate('2026-05-07T00:00:00+03:00'), '2026-05-07', 'offset form');
  // A tz-LESS 'T' string is wall-clock: its leading date is the intended day.
  assert.strictEqual(code.asISODate('2026-05-07T00:00:00'), '2026-05-07');
});

test('asISODate_: bare YYYY-MM-DD unchanged; blank stays blank; serial → its day', () => {
  const { code } = loadCode();
  assert.strictEqual(code.asISODate('2026-05-07'), '2026-05-07');
  assert.strictEqual(code.asISODate(''), '');
  assert.strictEqual(code.asISODate(null), '');
  assert.strictEqual(code.asISODate(undefined), '');
  assert.strictEqual(code.asISODate(SUMMER_SERIAL), '2026-05-07', 'Sheets date serial');
  assert.strictEqual(code.asISODate(SUMMER_SERIAL + 0.5), '2026-05-07', 'serial with a time fraction');
  assert.strictEqual(code.asISODate('free text'), 'free text', 'unrecognized text passes through');
});

test('parseDate_: a Sheets date serial is its calendar day, not epoch milliseconds', () => {
  const { code } = loadCode();
  const d = code.parseDate(SUMMER_SERIAL);
  assert.deepStrictEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 5, 7]);
});

/* ===== B. replaceHousePatients_ (via saveAll_) ===== */

function seedPatients(code, sandbox, rows) {
  return seedSheet(sandbox, code.PATIENTS_SHEET, code.PATIENT_COLUMNS, rows);
}

test('replaceHousePatients_ writes exitDate as YYYY-MM-DD from a timestamp payload AND a Date-typed sheet cell', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const exitIdx = PC.indexOf('exitDate');
  const sh = seedPatients(code, sandbox, [
    { houseId: 'ramot',  name: 'דנה', date: '2026-01-05', pay: 9000, status: 'released', exitDate: SUMMER_DATE, id: 'id-1', updatedAt: '2026-05-07T08:00:00.000Z', updatedBy: 'ורד' },
    { houseId: 'arfoni', name: 'שרה', date: '2026-02-01', pay: 9000, status: 'released', exitDate: SUMMER_DATE, id: 'id-2' },
    { houseId: 'ramot',  name: 'יעל', date: '2026-03-01', pay: 9000, status: 'active',   exitDate: '',          id: 'id-3' },
  ]);
  sh.ops.length = 0;

  // The client echoes the legacy read back as a UTC timestamp string.
  const res = code.saveAll([], { ramot: [
    { id: 'id-1', name: 'דנה', date: '2026-01-05', pay: 9000, status: 'released', exitDate: SUMMER_TS, updatedAt: '2026-05-07T08:00:00.000Z', updatedBy: 'ורד' },
    { id: 'id-3', name: 'יעל', date: '2026-03-01', pay: 9000, status: 'active',   exitDate: '' },
  ] }, 'ורד');
  assert.strictEqual(res.ok, true);

  const rows = code.readSheet(sh, PC);
  const byId = {}; rows.forEach((r) => { byId[r.id] = r; });
  assert.strictEqual(byId['id-1'].exitDate, '2026-05-07', 'payload timestamp → local bare date');
  assert.strictEqual(byId['id-2'].exitDate, '2026-05-07', 'kept other-house Date cell → local bare date');
  assert.strictEqual(byId['id-3'].exitDate, '', 'blank stays blank');
  assert.strictEqual(typeof byId['id-2'].exitDate, 'string');

  // Text-force of the exitDate column precedes the bulk write.
  const setOp = sh.ops.find((o) => o.op === 'set');
  const exitFmt = sh.ops.find((o) => o.op === 'fmt' && o.fmt === '@' && o.c === exitIdx + 1 && o.r === 2);
  assert.ok(exitFmt, 'exitDate column text-forced at rows 2..N');
  assert.strictEqual(exitFmt.nr, rows.length, 'covers every written row');
  assert.ok(exitFmt.seq < setOp.seq, 'format precedes setValues');

  // A storage-form-only difference (Date cell vs its timestamp echo) is NOT
  // an edit: updatedAt is carried, never re-stamped.
  assert.strictEqual(byId['id-1'].updatedAt, '2026-05-07T08:00:00.000Z', 'updatedAt untouched');
  assert.strictEqual(byId['id-1'].updatedBy, 'ורד');
});

test('source-scan: replaceHousePatients_ text-forces the exitDate column index, like date', () => {
  const start = GS_SRC.indexOf('function replaceHousePatients_');
  const end = GS_SRC.indexOf('\nfunction ', start + 1);
  const body = GS_SRC.slice(start, end);
  assert.match(body, /sh\.getRange\(2, dateColIdx \+ 1, finalRows\.length, 1\)\.setNumberFormat\('@'\)/, 'date guard still present');
  assert.match(body, /sh\.getRange\(2, exitDateColIdx \+ 1, finalRows\.length, 1\)\.setNumberFormat\('@'\)/, 'exitDate guard present');
  assert.match(body, /row\[exitDateColIdx\] = asISODate_\(row\[exitDateColIdx\]\)/, 'exitDate normalized on write');
});

/* ===== C. getData_ normalizes on read ===== */

test('getData_ serializes a Date-typed exitDate (and date) as YYYY-MM-DD for Patients and DischargedPatients', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [
    { houseId: 'ramot', name: 'דנה', date: SUMMER_DATE, pay: 9000, status: 'released', exitDate: SUMMER_DATE, id: 'id-1' },
    { houseId: 'ramot', name: 'יעל', date: '2026-03-01', pay: 9000, status: 'active', exitDate: '', id: 'id-3' },
  ]);
  seedSheet(sandbox, code.DISCHARGED_PATIENTS_SHEET, code.DISCHARGED_PATIENT_COLUMNS, [
    { id: 'aud-1', houseId: 'ramot', name: 'דנה', date: '2026-01-05', status: 'released', exitDate: SUMMER_TS, dischargedAt: '2026-05-07T08:00:00.000Z' },
  ]);
  const out = JSON.parse(JSON.stringify(code.getData()));
  const dana = out.patients.ramot.find((p) => p.id === 'id-1');
  assert.strictEqual(dana.exitDate, '2026-05-07');
  assert.strictEqual(dana.date, '2026-05-07');
  assert.strictEqual(out.patients.ramot.find((p) => p.id === 'id-3').exitDate, '');
  assert.strictEqual(out.dischargedPatients[0].exitDate, '2026-05-07', 'discharged: timestamp text → local day');
  assert.strictEqual(out.dischargedPatients[0].dischargedAt, '2026-05-07T08:00:00.000Z', 'dischargedAt is a true timestamp, untouched');
});

/* ===== D. discharge writer + tombstones + sheet-ensure ===== */

test('dischargePatient_ normalizes date/exitDate and text-forces them at the target row before the write', () => {
  const { code, sandbox } = loadCode();
  const DC = arr(code.DISCHARGED_PATIENT_COLUMNS);
  const sh = seedSheet(sandbox, code.DISCHARGED_PATIENTS_SHEET, code.DISCHARGED_PATIENT_COLUMNS, []);
  sh.ops.length = 0;
  const res = code.discharge({ id: 'aud-1', houseId: 'ramot', name: 'דנה', date: SUMMER_TS, status: 'released', exitDate: SUMMER_TS, disposition: 'completed' }, 'ורד');
  assert.strictEqual(res.ok, true);
  const row = code.readSheet(sh, DC)[0];
  assert.strictEqual(row.exitDate, '2026-05-07');
  assert.strictEqual(row.date, '2026-05-07');
  const setOp = sh.ops.find((o) => o.op === 'set');
  ['date', 'exitDate'].forEach((n) => {
    const f = sh.ops.find((o) => o.op === 'fmt' && o.fmt === '@' && o.c === DC.indexOf(n) + 1 && o.r === setOp.r);
    assert.ok(f && f.seq < setOp.seq, n + ' text-forced at the target row before setValues');
  });
});

test('a tombstone snapshots exitDate as YYYY-MM-DD (user delete of a row holding a Date cell)', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [
    { houseId: 'ramot', name: 'דנה', date: '2026-01-05', pay: 9000, status: 'released', exitDate: SUMMER_DATE, id: 'id-1' },
  ]);
  const res = code.del({ id: 'id-1', houseId: 'ramot', name: 'דנה', date: '2026-01-05' }, 'ורד');
  assert.strictEqual(res.ok, true);
  const tomb = code.readSheet(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.strictEqual(tomb.length, 1);
  assert.strictEqual(tomb[0].exitDate, '2026-05-07');
  assert.strictEqual(tomb[0].reason, 'user-delete');
});

test('sheet-ensure text-forces the whole exitDate column on Patients, DischargedPatients and PatientsTombstones', () => {
  const { code, sandbox } = loadCode();
  [
    [code.PATIENTS_SHEET, code.PATIENT_COLUMNS],
    [code.DISCHARGED_PATIENTS_SHEET, code.DISCHARGED_PATIENT_COLUMNS],
    [code.PATIENTS_TOMBSTONES_SHEET, code.PATIENT_TOMBSTONE_COLUMNS],
  ].forEach(([name, cols]) => {
    const sh = seedSheet(sandbox, name, cols, []);
    code.ensure(name, cols);
    ['date', 'exitDate'].forEach((n) => {
      const f = sh.ops.find((o) => o.op === 'fmt' && o.fmt === '@' && o.c === arr(cols).indexOf(n) + 1);
      assert.ok(f && f.r === 1 && f.nr >= 1000, name + ': whole ' + n + ' column text-forced at ensure time');
    });
  });
});

/* ===== E. one-time repair + preview ===== */

function seedForRepair(code, sandbox) {
  const stamps = { updatedAt: '2026-05-07T08:00:00.000Z', updatedBy: 'ורד' };
  const patients = seedPatients(code, sandbox, [
    Object.assign({ houseId: 'ramot', name: 'א', date: '2026-01-05', status: 'released', exitDate: SUMMER_DATE,   id: 'id-1' }, stamps),
    Object.assign({ houseId: 'ramot', name: 'ב', date: '2026-01-05', status: 'released', exitDate: SUMMER_TS,     id: 'id-2' }, stamps),
    Object.assign({ houseId: 'ramot', name: 'ג', date: '2026-01-05', status: 'released', exitDate: SUMMER_SERIAL, id: 'id-3' }, stamps),
    Object.assign({ houseId: 'ramot', name: 'ד', date: '2026-01-05', status: 'released', exitDate: '2026-05-07',  id: 'id-4' }, stamps),
    Object.assign({ houseId: 'ramot', name: 'ה', date: '2026-01-05', status: 'active',   exitDate: '',            id: 'id-5' }, stamps),
  ]);
  const discharged = seedSheet(sandbox, code.DISCHARGED_PATIENTS_SHEET, code.DISCHARGED_PATIENT_COLUMNS, [
    Object.assign({ id: 'aud-1', houseId: 'ramot', name: 'א', date: '2026-01-05', exitDate: SUMMER_TS,   dischargedAt: '2026-05-07T08:00:00.000Z' }, stamps),
    // A legacy discharged row whose entry `date` was coerced too (the audit
    // writer never text-forced it) — the repair covers `date` in the same pass.
    Object.assign({ id: 'aud-2', houseId: 'ramot', name: 'ד', date: SUMMER_DATE, exitDate: '2026-05-07', dischargedAt: '2026-05-07T08:00:00.000Z' }, stamps),
  ]);
  const tomb = seedSheet(sandbox, code.PATIENTS_TOMBSTONES_SHEET, code.PATIENT_TOMBSTONE_COLUMNS, [
    Object.assign({ houseId: 'ramot', name: 'ו', date: '2026-01-05', exitDate: SUMMER_DATE, droppedAt: '2026-05-07T08:00:00.000Z', reason: 'user-delete', id: 'id-9' }, stamps),
  ]);
  [patients, discharged, tomb].forEach((sh) => { sh.ops.length = 0; });
  return { patients, discharged, tomb };
}

test('previewPatientExitDatesNow: reports what would change, performs ZERO writes', () => {
  const { code, sandbox } = loadCode();
  const sheets = seedForRepair(code, sandbox);
  const res = code.preview();
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.sheets[code.PATIENTS_SHEET].rewritten, 3, 'Date + timestamp + serial');
  assert.strictEqual(res.sheets[code.PATIENTS_SHEET].columns.exitDate.scanned, 4, 'non-blank exitDate cells scanned');
  assert.strictEqual(res.sheets[code.PATIENTS_SHEET].columns.date.rewritten, 0, 'clean entry dates untouched');
  assert.strictEqual(res.sheets[code.DISCHARGED_PATIENTS_SHEET].rewritten, 2, 'one exitDate + one Date-typed date');
  assert.strictEqual(res.sheets[code.DISCHARGED_PATIENTS_SHEET].columns.date.rewritten, 1);
  assert.strictEqual(res.sheets[code.PATIENTS_TOMBSTONES_SHEET].rewritten, 1);
  assert.strictEqual(res.rewritten, 6);
  Object.values(sheets).forEach((sh) => {
    assert.deepStrictEqual(sh.ops.filter((o) => o.op !== 'get'), [], 'no format/value ops on ' + sh.grid[0].join(','));
  });
  assert.strictEqual(sandbox.__sheets[code.AUDIT_LOG_SHEET], undefined, 'no audit row on preview');
  // Cells untouched.
  assert.strictEqual(sheets.patients.grid[1][arr(code.PATIENT_COLUMNS).indexOf('exitDate')], SUMMER_DATE);
  const ex = res.sheets[code.PATIENTS_SHEET].examples;
  assert.deepStrictEqual(plain(ex[0]), { column: 'exitDate', row: 2, before: SUMMER_TS, after: '2026-05-07' });
  assert.ok(sandbox.__logs.some((l) => /previewPatientExitDatesNow: Patients/.test(l)), 'per-sheet Logger summary');
});

test('repairPatientExitDatesNow: rewrites drifted cells as the local day, leaves clean cells + stamps alone, audits, idempotent', () => {
  const { code, sandbox } = loadCode();
  const sheets = seedForRepair(code, sandbox);
  const PC = arr(code.PATIENT_COLUMNS);
  const exitIdx = PC.indexOf('exitDate');

  const res = code.repair();
  assert.strictEqual(res.dryRun, false);
  assert.strictEqual(res.rewritten, 6);

  const rows = code.readSheet(sheets.patients, PC);
  assert.deepStrictEqual(plain(rows.map((r) => r.exitDate)), ['2026-05-07', '2026-05-07', '2026-05-07', '2026-05-07', '']);
  rows.forEach((r) => {
    assert.strictEqual(r.updatedAt, '2026-05-07T08:00:00.000Z', 'updatedAt NOT re-stamped (' + r.name + ')');
    assert.strictEqual(r.updatedBy, 'ורד', 'updatedBy NOT re-stamped');
  });
  // Only the drifted cells were written (per-cell), each with a text format first.
  const cellWrites = sheets.patients.ops.filter((o) => o.op === 'setcell');
  assert.deepStrictEqual(plain(cellWrites.map((o) => o.r)), [2, 3, 4], 'rows 2-4 rewritten; clean row 5 and blank row 6 untouched');
  cellWrites.forEach((w) => {
    assert.strictEqual(w.c, exitIdx + 1);
    const fmt = sheets.patients.ops.find((o) => o.op === 'fmt' && o.fmt === '@' && o.r === w.r && o.c === w.c);
    assert.ok(fmt && fmt.seq < w.seq, 'cell format set to @ before the value');
  });
  assert.ok(!sheets.patients.ops.some((o) => o.op === 'set' || o.op === 'clear'), 'no bulk rewrite, no clears');
  // Whole-column text force preceded the writes.
  const colFmt = sheets.patients.ops.find((o) => o.op === 'fmt' && o.c === exitIdx + 1 && o.r === 1);
  assert.ok(colFmt && colFmt.seq < cellWrites[0].seq);

  const disc = code.readSheet(sheets.discharged, arr(code.DISCHARGED_PATIENT_COLUMNS));
  assert.deepStrictEqual(plain(disc.map((r) => r.exitDate)), ['2026-05-07', '2026-05-07']);
  assert.deepStrictEqual(plain(disc.map((r) => r.date)), ['2026-01-05', '2026-05-07'], 'legacy Date-typed entry date rewritten as its local day');
  assert.strictEqual(disc[0].dischargedAt, '2026-05-07T08:00:00.000Z', 'other columns untouched');
  const tomb = code.readSheet(sheets.tomb, arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.strictEqual(tomb[0].exitDate, '2026-05-07');
  assert.strictEqual(tomb[0].droppedAt, '2026-05-07T08:00:00.000Z');

  const audit = auditOf(code, sandbox).filter((a) => a.action === 'exit_date_repaired');
  assert.strictEqual(audit.length, 1, 'one audit event');
  const details = JSON.parse(audit[0].details);
  assert.strictEqual(details.rewritten, 6);
  assert.strictEqual(details.perSheet[code.PATIENTS_SHEET].rewritten, 3);
  assert.strictEqual(details.perSheet[code.DISCHARGED_PATIENTS_SHEET].columns.date.rewritten, 1);
  assert.strictEqual(details.stampsRestamped, false);

  // Idempotent: second run = 0 writes, no new audit row; preview confirms 0.
  Object.values(sheets).forEach((sh) => { sh.ops.length = 0; });
  const again = code.repair();
  assert.strictEqual(again.rewritten, 0);
  Object.values(sheets).forEach((sh) => assert.deepStrictEqual(writeOps(sh), [], 'second run writes nothing'));
  assert.strictEqual(auditOf(code, sandbox).filter((a) => a.action === 'exit_date_repaired').length, 1, 'no second audit row');
  assert.strictEqual(code.preview().rewritten, 0);
});

test('repair on absent sheets is a no-op (fresh spreadsheet)', () => {
  const { code, sandbox } = loadCode();
  const res = code.repair();
  assert.strictEqual(res.rewritten, 0);
  assert.deepStrictEqual(Object.keys(sandbox.__sheets), [], 'creates nothing');
});

test('neither repair function is dispatchable via handle_ (Run dropdown only)', () => {
  const { code } = loadCode();
  const handleStart = GS_SRC.indexOf('function handle_');
  const handleEnd = GS_SRC.indexOf('\nfunction ', handleStart + 1);
  const handleBody = GS_SRC.slice(handleStart, handleEnd);
  ['repairPatientExitDatesNow', 'previewPatientExitDatesNow', 'runPatientExitDateRepair_'].forEach((fn) => {
    assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
    assert.deepStrictEqual(plain(code.handle({ action: fn })), { ok: false, error: 'unknown_action', action: fn });
  });
});
