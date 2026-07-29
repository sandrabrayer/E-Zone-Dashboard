/* Tests for the visitTime text-columns + quarter-hour select PR.
 *
 *   Code.gs  — repairLeadVisitTimes blanks visitTime, leaves visitDate; and
 *              upsertRowById_ normalizes date/time cells and writes them into
 *              text-formatted cells (setNumberFormat('@') BEFORE setValues).
 *   app.js   — visitTimeOptions / visitTimeSelectHTML emit every quarter hour for
 *              a clean value and add an off-step value as an extra option.
 *
 * Both files are non-Node scripts; per the repo's vm-sandbox convention we read
 * the source, stub the globals, and exercise the REAL shipped functions. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x); // copy a sandbox-realm array into this realm

/* ---------- a minimal fake Sheet that records ops in order ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  const sheet = {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', r, c, nr, nc, fmt }); },
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
          ops.push({ op: 'set', r, c, nr, nc, vals: vals.map((x) => x.slice()) });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
  return sheet;
}

/* ---------- load apps-script/Code.gs ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const logLines = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: (m) => logLines.push(String(m)) },
    Utilities: { formatDate: (d, tz, fmt) => (fmt === 'HH:mm' ? '00:00' : '1899-12-30') },
    __leadsSheet: null,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: () => sandbox.__leadsSheet,
      insertSheet: () => sandbox.__leadsSheet,
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS, LEADS_SHEET: LEADS_SHEET,
    repair: () => repairLeadVisitTimes(),
    upsert: (sh, cols, obj) => upsertRowById_(sh, cols, obj),
    ensure: () => getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox, logLines };
}

/* ---------- load public/app.js (with a DOM stub) ---------- */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild() {}, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const holder = { lastCreated: null };
  const doc = {
    getElementById: () => fakeEl(),
    createElement: () => { const el = fakeEl(); holder.lastCreated = el; return el; },
    querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
  };
  const epilogue = `globalThis.__test = {
    visitTimeOptions: (v) => visitTimeOptions(v),
    visitTimeSelectHTML: (v) => visitTimeSelectHTML(v),
    buildLeadCard: (l) => buildLeadCard(l),
    openEditLeadModal: (l) => openEditLeadModal(l),
  };`;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, created: () => holder.lastCreated };
}

// The 96 canonical quarter hours 00:00..23:45.
const QUARTERS = [];
for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45]) {
  QUARTERS.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
}

/* ===== Part 4a — clean value: every quarter hour, no others ===== */
test('visitTimeOptions emits blank + every quarter hour and nothing else for a clean value', () => {
  const { app } = loadApp();
  const values = arr(app.visitTimeOptions('09:30')).map((o) => o.value);
  assert.strictEqual(values[0], '', 'first option is the blank placeholder');
  assert.deepStrictEqual(values.slice(1), QUARTERS, 'exactly the 96 quarter hours');
  assert.strictEqual(values.length, 97);
  assert.ok(values.includes('09:30'));
});

test('visitTimeSelectHTML selects the matching quarter option', () => {
  const { app } = loadApp();
  const html = app.visitTimeSelectHTML('09:30');
  assert.ok(/data-field="visitTime"/.test(html), 'keeps data-field="visitTime"');
  assert.ok(/<option value="09:30" selected>09:30<\/option>/.test(html));
  assert.strictEqual((html.match(/<option/g) || []).length, 97);
});

/* ===== Part 4b — off-step value: extra option, round-trips ===== */
test('an off-step stored value is added as an extra option, sorted into place', () => {
  const { app } = loadApp();
  const values = arr(app.visitTimeOptions('08:18')).map((o) => o.value);
  assert.strictEqual(values.length, 98, 'blank + 96 quarters + the off-step value');
  assert.ok(values.includes('08:18'));
  // Sorted chronologically: 08:15 < 08:18 < 08:30.
  assert.ok(values.indexOf('08:15') < values.indexOf('08:18'));
  assert.ok(values.indexOf('08:18') < values.indexOf('08:30'));
});

test('an off-step value renders selected and round-trips through the lead card', () => {
  const { app } = loadApp();
  const html = app.visitTimeSelectHTML('08:18');
  assert.ok(/<option value="08:18" selected>08:18<\/option>/.test(html));
  // End-to-end: a visit-stage lead card renders the select with the off-step value.
  const card = app.buildLeadCard({ id: 'L', name: 'x', stage: 'visit', house: '',
    visitDate: '2026-07-27', visitTime: '08:18', meetingWith: '' });
  assert.ok(/class="lc-visit-time" data-field="visitTime"/.test(card.innerHTML));
  assert.ok(/<option value="08:18" selected>/.test(card.innerHTML));
});

test('the edit modal renders the visitTime select with the off-step value preserved', () => {
  const { app, created } = loadApp();
  app.openEditLeadModal({ id: 'L', name: 'x', stage: 'visit', house: '',
    created: '2026-07-01', visitDate: '2026-07-27', visitTime: '08:18', meetingWith: '' });
  const html = created().innerHTML;
  assert.ok(/<select name="visitTime">/.test(html));
  assert.ok(/<option value="08:18" selected>08:18<\/option>/.test(html));
});

/* ===== Part 3 — repair blanks visitTime, leaves visitDate ===== */
test('repairLeadVisitTimes blanks visitTime, leaves visitDate, logs the count', () => {
  const { code, sandbox, logLines } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  const vDate = LC.indexOf('visitDate');
  const vTime = LC.indexOf('visitTime');
  const rowA = LC.map(() => ''); rowA[vDate] = '2026-07-27'; rowA[vTime] = '08:18';
  const rowB = LC.map(() => ''); rowB[vDate] = '2026-07-28'; rowB[vTime] = '';       // already blank
  sandbox.__leadsSheet = fakeSheet(LC, [rowA, rowB]);

  const blanked = code.repair();

  assert.strictEqual(blanked, 1, 'only the one non-empty visitTime counts');
  assert.strictEqual(sandbox.__leadsSheet.grid[1][vTime], '', 'row A visitTime blanked');
  assert.strictEqual(sandbox.__leadsSheet.grid[2][vTime], '', 'row B visitTime stays blank');
  assert.strictEqual(sandbox.__leadsSheet.grid[1][vDate], '2026-07-27', 'row A visitDate intact');
  assert.strictEqual(sandbox.__leadsSheet.grid[2][vDate], '2026-07-28', 'row B visitDate intact');
  assert.ok(logLines.some((l) => /blanked 1 visitTime/.test(l)), 'logs the count');
});

/* ===== Part 2 — upsertRowById_ normalizes + text-formats ===== */
test('upsertRowById_ normalizes date/time cells and text-formats them before setValues', () => {
  const { code } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  const idIdx = LC.indexOf('id');
  const vDate = LC.indexOf('visitDate');
  const vTime = LC.indexOf('visitTime');
  const existing = LC.map(() => ''); existing[idIdx] = 'L1';
  const sh = fakeSheet(LC, [existing]);

  // visitDate as a full ISO string proves asISODate_ ran (it slices to the date);
  // visitTime '08:18' passes through asISOTime_ unchanged.
  code.upsert(sh, code.LEAD_COLUMNS, { id: 'L1', visitDate: '2026-07-27T21:00:00.000Z', visitTime: '08:18' });

  const setOp = sh.ops.find((o) => o.op === 'set');
  const fmtOps = sh.ops.filter((o) => o.op === 'fmt' && o.fmt === '@');
  // Text format applied to visitDate + visitTime columns...
  assert.ok(fmtOps.some((o) => o.c === vDate + 1), 'visitDate column text-formatted');
  assert.ok(fmtOps.some((o) => o.c === vTime + 1), 'visitTime column text-formatted');
  // ...and BEFORE the setValues (order in the ops log).
  assert.ok(sh.ops.indexOf(fmtOps[0]) < sh.ops.indexOf(setOp), 'format precedes write');
  // Written values are normalized.
  assert.strictEqual(setOp.vals[0][vDate], '2026-07-27', 'visitDate normalized to a bare date');
  assert.strictEqual(setOp.vals[0][vTime], '08:18', 'visitTime passthrough');
});

/* ===== Part 1 — getOrCreateSheet_ text-formats the whole vDate/vTime columns ===== */
test('getOrCreateSheet_ forces the whole visitDate/visitTime columns to text for the Leads sheet', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  const vDate = LC.indexOf('visitDate');
  const vTime = LC.indexOf('visitTime');
  sandbox.__leadsSheet = fakeSheet(LC, []);
  code.ensure();
  const fmt = sandbox.__leadsSheet.ops.filter((o) => o.op === 'fmt' && o.fmt === '@');
  // Whole column: starts at row 1 and spans getMaxRows() (>= 1000).
  const vDateFmt = fmt.find((o) => o.c === vDate + 1);
  const vTimeFmt = fmt.find((o) => o.c === vTime + 1);
  assert.ok(vDateFmt && vDateFmt.r === 1 && vDateFmt.nr >= 1000, 'visitDate whole column text');
  assert.ok(vTimeFmt && vTimeFmt.r === 1 && vTimeFmt.nr >= 1000, 'visitTime whole column text');
});
