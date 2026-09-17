'use strict';

/**
 * Coverage for the permanent monthly occupancy snapshot (apps-script/Code.gs):
 * the `OccupancySnapshots` sheet, snapshotMonth_, runMonthlyOccupancySnapshot,
 * installOccupancySnapshotTrigger, backfillOccupancySnapshotsNow /
 * previewOccupancySnapshotsNow, and the read-only
 * `doGet?action=occupancySnapshots` feed.
 *
 * Same two styles as the rest of this suite (see nightly-integrity.test.js):
 *
 * 1. REAL-CODE extraction — the module's functions are pulled out of Code.gs
 *    by name (balanced braces) and eval'd in one vm sandbox, so the tests run
 *    the ACTUAL deployed logic rather than a drift-prone mirror. The pure
 *    helpers (occupancyPct_, occupancySnapshotRowsFromOverview_,
 *    occupancySnapshotNewRows_, occupancySnapshotMonthRange_, …) touch no GAS
 *    service at all; the sheet layer runs against a fake Sheets grid that
 *    records every write op, so append-only and text-pinning are observable.
 *
 * 2. SOURCE-SCAN guards locking the contract: append-only (no clear/delete
 *    primitive anywhere in the module), LockService around the write, the
 *    shared computation (managersOverview_, never a second occupancy
 *    implementation), no new secret, no financial column, and the doGet
 *    routing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

/* vm objects come from another realm, so their prototypes never match the test
 * realm's — round-trip through JSON before any deep comparison. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* The module's own source slice, for the guard tests. */
const MODULE_START = GS.indexOf('/* ===== Monthly occupancy snapshots');
assert.notEqual(MODULE_START, -1, 'occupancy snapshot module not found in Code.gs');
const MODULE_END = GS.indexOf('/* ===== Coordinators digest', MODULE_START);
assert.notEqual(MODULE_END, -1, 'module end marker not found');
const MODULE_SRC = GS.slice(MODULE_START, MODULE_END);
/* Code only — the doc comments legitimately mention "secret", "financial" and
 * the helpers the module must NOT call, so guards scan the stripped source. */
const MODULE_CODE = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ---- extract a whole `function name(...) {...}` out of Code.gs (balanced) -- */
function gsFunction(name) {
  const sig = 'function ' + name + '(';
  const start = GS.indexOf(sig);
  assert.notEqual(start, -1, name + ' not found in Code.gs');
  const open = GS.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = open; j < GS.length; j++) {
    if (GS[j] === '{') depth++;
    else if (GS[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.notEqual(end, -1, name + ' has unbalanced braces');
  return GS.slice(start, end + 1);
}

/* ---- extract a `const NAME = <literal>;` declaration, single or multi-line -- */
function gsConst(name) {
  const re = new RegExp('(^|\\n)const ' + name + '\\s*=');
  const m = GS.match(re);
  assert.ok(m, name + ' not found in Code.gs');
  const start = GS.indexOf('const ' + name, m.index);
  let depth = 0;
  for (let j = start; j < GS.length; j++) {
    const ch = GS[j];
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    // `const` is lexical and would NOT attach to the vm context object, so the
    // extracted declaration is re-bound with `var` (value and name unchanged).
    else if (ch === ';' && depth === 0) return 'var ' + GS.slice(start + 'const '.length, j + 1);
  }
  assert.fail(name + ' declaration is unterminated');
}

const CONSTS = [
  'OCCUPANCY_SNAPSHOTS_SHEET',
  'OCCUPANCY_SNAPSHOT_COLUMNS',
  'OCCUPANCY_SNAPSHOT_FIRST_MONTH',
  'OCCUPANCY_SNAPSHOT_TRIGGER_HANDLER',
  'OCCUPANCY_SNAPSHOT_HOUSES',
];

const FUNCS = [
  // shared, pre-existing helpers the module reuses (never re-implemented)
  'endOfMonth_', 'daysInMonth_', 'ymOf_', 'offsetMonth_',
  'readSheet_', 'objectToRow_',
  // the module
  'occupancySnapshotValidMonth_', 'occupancySnapshotIsFinishedMonth_',
  'occupancySnapshotRound_', 'occupancyPct_', 'occupancySnapshotKey_',
  'occupancySnapshotMonthText_', 'occupancySnapshotExistingKeys_',
  'occupancySnapshotNewRows_', 'occupancySnapshotRowsFromOverview_',
  'occupancySnapshotSortRows_', 'occupancySnapshotMonthRange_',
  'occupancySnapshotSheet_', 'readOccupancySnapshots_',
  'appendOccupancySnapshotRows_', 'snapshotMonth_',
  'runMonthlyOccupancySnapshot', 'installOccupancySnapshotTrigger',
  'occupancySnapshotBackfill_', 'backfillOccupancySnapshotsNow',
  'previewOccupancySnapshotsNow', 'occupancySnapshots_',
];

/* ---- a minimal Sheets grid that records every write op ---------------------- */
function makeFakeSheet() {
  const sh = {
    grid: [],
    formats: [],
    ops: [],
    _ensure(rows, cols) {
      while (sh.grid.length < rows) { sh.grid.push([]); sh.formats.push([]); }
      for (let i = 0; i < sh.grid.length; i++) {
        while (sh.grid[i].length < cols) { sh.grid[i].push(''); sh.formats[i].push(''); }
      }
    },
    getLastRow() {
      let last = 0;
      for (let i = 0; i < sh.grid.length; i++) {
        if (sh.grid[i].some((v) => v !== '' && v !== null && v !== undefined)) last = i + 1;
      }
      return last;
    },
    getLastColumn() {
      let last = 0;
      for (const row of sh.grid) {
        for (let j = 0; j < row.length; j++) {
          if (row[j] !== '' && row[j] !== null && row[j] !== undefined && j + 1 > last) last = j + 1;
        }
      }
      return last;
    },
    setFrozenRows() { return sh; },
    getRange(row, col, numRows, numCols) {
      const nr = numRows === undefined ? 1 : numRows;
      const nc = numCols === undefined ? 1 : numCols;
      sh._ensure(row + nr - 1, col + nc - 1);
      return {
        setValues(vals) {
          sh.ops.push({ op: 'setValues', row, col, numRows: nr, numCols: nc });
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.grid[row - 1 + i][col - 1 + j] = vals[i][j];
          return this;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const r = [];
            for (let j = 0; j < nc; j++) r.push(sh.grid[row - 1 + i][col - 1 + j]);
            out.push(r);
          }
          return out;
        },
        setNumberFormat(f) {
          sh.ops.push({ op: 'setNumberFormat', row, col, numRows: nr, numCols: nc, format: f });
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.formats[row - 1 + i][col - 1 + j] = f;
          return this;
        },
        clearContent() { sh.ops.push({ op: 'clearContent' }); return this; },
      };
    },
  };
  return sh;
}

/* One overview payload shape, matching managersOverview_'s `houses` array. */
function overviewFor(ym, houses) {
  return { ok: true, month: ym, totals: {}, houses: houses };
}

const DEFAULT_HOUSES = [
  { key: 'raanana', manager: 'שחר',  treatmentDays: 0, avgDaily: 0 },
  { key: 'ramot',   manager: 'אורן', treatmentDays: 0, avgDaily: 0 },
  { key: 'efroni',  manager: 'חנן',  treatmentDays: 0, avgDaily: 0 },
  { key: 'rehab',   manager: 'רנטה', treatmentDays: 0, avgDaily: 0 },
  { key: 'pardes',  manager: 'חן',   treatmentDays: 0, avgDaily: 0 },
];

/* Houses with `perDay` residents every day of the month — the numbers
 * managersOverview_ would produce for a flat month. */
function flatHouses(ym, perDay, daysInMonth) {
  return DEFAULT_HOUSES.map((h) => {
    const n = perDay[h.key];
    if (n === undefined) return null;
    return {
      key: h.key,
      manager: h.manager,
      treatmentDays: n * daysInMonth,
      avgDaily: (n * daysInMonth) / daysInMonth,
    };
  }).filter(Boolean);
}

function load(opts) {
  const options = opts || {};
  const sheet = makeFakeSheet();
  const triggers = (options.triggers || []).slice();
  const created = [];
  const logs = [];

  const sandbox = {
    console,
    __sheet: sheet,
    __triggers: triggers,
    __created: created,
    __logs: logs,
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
    Utilities: {
      formatDate(d, tz, fmt) {
        const y = d.getFullYear();
        const mo = d.getMonth() + 1;
        const da = d.getDate();
        const p = (n) => (n < 10 ? '0' + n : String(n));
        if (fmt === 'yyyy-MM') return y + '-' + p(mo);
        return y + '-' + p(mo) + '-' + p(da);
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() { sheet.ops.push({ op: 'lock' }); return true; },
        releaseLock() { sheet.ops.push({ op: 'unlock' }); },
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => sandbox.__triggers.slice(),
      deleteTrigger(t) {
        const i = sandbox.__triggers.indexOf(t);
        if (i >= 0) sandbox.__triggers.splice(i, 1);
      },
      newTrigger(handler) {
        const spec = { handler, kind: null, monthDay: null, hour: null };
        const builder = {
          timeBased() { spec.kind = 'timeBased'; return builder; },
          onMonthDay(d) { spec.monthDay = d; return builder; },
          atHour(h) { spec.hour = h; return builder; },
          create() {
            created.push(spec);
            const trig = { getHandlerFunction: () => handler, spec };
            sandbox.__triggers.push(trig);
            return trig;
          },
        };
        return builder;
      },
    },
    // The ONLY sheet this module touches.
    getOrCreateSheet_(name, headers) {
      assert.equal(name, 'OccupancySnapshots', 'module must only touch its own sheet');
      if (sheet.getLastRow() === 0) {
        // written straight into the grid so sheet-creation never shows up as a
        // recorded write op (the tests assert on the module's own writes)
        sheet._ensure(1, headers.length);
        for (let j = 0; j < headers.length; j++) sheet.grid[0][j] = headers[j];
      }
      return sheet;
    },
    defaultMonth_: () => options.currentMonth || '2026-09',
    managersOverview_: options.managersOverview || ((ym) => overviewFor(ym, DEFAULT_HOUSES)),
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(CONSTS.map(gsConst).join('\n') + '\n' + FUNCS.map(gsFunction).join('\n'), sandbox);
  return sandbox;
}

/* =========================== column + house contract ======================== */

test('OccupancySnapshots header contract is exactly the agreed append-only list', () => {
  const s = load();
  assert.deepStrictEqual(plain(s.OCCUPANCY_SNAPSHOT_COLUMNS), [
    'month', 'houseId', 'treatmentDays', 'daysInMonth',
    'avgDaily', 'capacity', 'occupancyPct', 'manager', 'capturedAt',
  ]);
  assert.strictEqual(s.OCCUPANCY_SNAPSHOTS_SHEET, 'OccupancySnapshots');
  assert.strictEqual(s.OCCUPANCY_SNAPSHOT_FIRST_MONTH, '2026-05');
});

test('houses and capacities are pinned: raanana 14, ramot 20, arfoni 13, rehab 13, pardes 13', () => {
  const s = load();
  assert.deepStrictEqual(plain(s.OCCUPANCY_SNAPSHOT_HOUSES), [
    { houseId: 'raanana', managerHouse: 'raanana', capacity: 14 },
    { houseId: 'ramot',   managerHouse: 'ramot',   capacity: 20 },
    { houseId: 'arfoni',  managerHouse: 'efroni',  capacity: 13 },
    { houseId: 'rehab',   managerHouse: 'rehab',   capacity: 13 },
    { houseId: 'pardes',  managerHouse: 'pardes',  capacity: 13 },
  ]);
});

test('no financial field can reach the snapshot sheet', () => {
  const s = load();
  const FORBIDDEN = ['amount', 'price', 'debt', 'billing', 'payment', 'paid', 'rate', 'bonus', 'revenue'];
  plain(s.OCCUPANCY_SNAPSHOT_COLUMNS).forEach((c) => {
    FORBIDDEN.forEach((f) => {
      assert.ok(!c.toLowerCase().includes(f), 'financial-looking column in the contract: ' + c);
    });
  });
});

/* =============================== daysInMonth =============================== */

test('daysInMonth_ — 28 / 29 / 30 / 31', () => {
  const s = load();
  assert.strictEqual(s.daysInMonth_('2026-02'), 28, 'February, common year');
  assert.strictEqual(s.daysInMonth_('2024-02'), 29, 'February, leap year');
  assert.strictEqual(s.daysInMonth_('2000-02'), 29, 'February, century leap year');
  assert.strictEqual(s.daysInMonth_('1900-02'), 28, 'February, century non-leap year');
  assert.strictEqual(s.daysInMonth_('2026-04'), 30);
  assert.strictEqual(s.daysInMonth_('2026-09'), 30);
  assert.strictEqual(s.daysInMonth_('2026-01'), 31);
  assert.strictEqual(s.daysInMonth_('2026-12'), 31);
});

/* =============================== occupancyPct ============================== */

test('occupancyPct_ = avgDaily ÷ capacity × 100, rounded to one decimal', () => {
  const s = load();
  assert.strictEqual(s.occupancyPct_(14, 14), 100);
  assert.strictEqual(s.occupancyPct_(7, 14), 50);
  assert.strictEqual(s.occupancyPct_(12.5, 14), 89.3);   // 89.2857…
  assert.strictEqual(s.occupancyPct_(10, 13), 76.9);     // 76.923…
  assert.strictEqual(s.occupancyPct_(1, 8), 12.5);       // exact, no drift
  assert.strictEqual(s.occupancyPct_(17.34, 20), 86.7);
  assert.strictEqual(s.occupancyPct_(0, 13), 0);
  assert.strictEqual(s.occupancyPct_(21, 20), 105, 'over capacity is reported, never clamped');
});

test('occupancyPct_ never returns NaN or Infinity on a missing capacity', () => {
  const s = load();
  [0, -1, null, undefined, '', 'x'].forEach((cap) => {
    const v = s.occupancyPct_(10, cap);
    assert.strictEqual(v, 0, 'capacity ' + String(cap));
  });
});

/* ============================ finished-month rule ========================== */

test('occupancySnapshotIsFinishedMonth_ refuses the running month and the future', () => {
  const s = load();
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('2026-08', '2026-09'), true);
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('2025-12', '2026-01'), true);
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('2026-09', '2026-09'), false, 'running month');
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('2026-10', '2026-09'), false, 'future month');
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('2026-13', '2026-09'), false, 'invalid month');
  assert.strictEqual(s.occupancySnapshotIsFinishedMonth_('', '2026-09'), false);
});

test('snapshotMonth_ REFUSES the running month and writes nothing', () => {
  const s = load({ currentMonth: '2026-09' });
  const res = s.snapshotMonth_('2026-09');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'month_not_finished');
  assert.strictEqual(res.appended, 0);
  assert.deepStrictEqual(s.__sheet.ops.filter((o) => o.op === 'setValues'), [], 'no write at all');
});

test('snapshotMonth_ refuses a future month and a malformed month', () => {
  const s = load({ currentMonth: '2026-09' });
  assert.strictEqual(s.snapshotMonth_('2026-12').error, 'month_not_finished');
  assert.strictEqual(s.snapshotMonth_('2026-1').error, 'bad_month');
  assert.strictEqual(s.snapshotMonth_('nope').error, 'bad_month');
  assert.strictEqual(s.snapshotMonth_('').error, 'bad_month');
  assert.deepStrictEqual(s.__sheet.ops.filter((o) => o.op === 'setValues'), []);
});

/* ======================= projection from managersOverview ================== */

test('rows are projected from the managersOverview_ payload, not recomputed', () => {
  const s = load();
  const ym = '2026-06'; // 30 days
  const overview = overviewFor(ym, [
    { key: 'raanana', manager: 'שחר',  treatmentDays: 375, avgDaily: 12.5 },
    { key: 'ramot',   manager: 'אורן', treatmentDays: 540, avgDaily: 18 },
    { key: 'efroni',  manager: 'חנן',  treatmentDays: 300, avgDaily: 10 },
    { key: 'rehab',   manager: 'רנטה', treatmentDays: 390, avgDaily: 13 },
    { key: 'pardes',  manager: 'חן',   treatmentDays: 240, avgDaily: 8 },
  ]);
  const rows = s.occupancySnapshotRowsFromOverview_(ym, overview, '2026-07-01T00:10:00.000Z');

  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(plain(rows[0]), {
    month: '2026-06',
    houseId: 'raanana',
    treatmentDays: 375,
    daysInMonth: 30,
    avgDaily: 12.5,
    capacity: 14,
    occupancyPct: 89.3,
    manager: 'שחר',
    capturedAt: '2026-07-01T00:10:00.000Z',
  });
  // efroni's overview key becomes the `arfoni` house id on the feed.
  const efroni = rows.find((r) => r.houseId === 'arfoni');
  assert.strictEqual(efroni.capacity, 13);
  assert.strictEqual(efroni.occupancyPct, 76.9);
  assert.strictEqual(efroni.manager, 'חנן');
  // Every row's daysInMonth is the month's real length.
  rows.forEach((r) => assert.strictEqual(r.daysInMonth, 30));
});

test('avgDaily is stored at 2 decimals and occupancyPct is consistent with it', () => {
  const s = load();
  // 31-day month, 320 patient-days → 10.3225806… → stored 10.32
  const rows = s.occupancySnapshotRowsFromOverview_('2026-07', overviewFor('2026-07', [
    { key: 'rehab', manager: 'רנטה', treatmentDays: 320, avgDaily: 320 / 31 },
  ]), 'now');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].avgDaily, 10.32);
  assert.strictEqual(rows[0].occupancyPct, s.occupancyPct_(rows[0].avgDaily, rows[0].capacity));
  assert.strictEqual(rows[0].occupancyPct, 79.4); // 10.32 / 13 * 100 = 79.384…
});

test('a house missing from the month yields NO ROW', () => {
  const s = load();
  const overview = overviewFor('2026-06', [
    { key: 'raanana', manager: 'שחר', treatmentDays: 300, avgDaily: 10 },
    { key: 'ramot',   manager: 'אורן', treatmentDays: 300, avgDaily: 10 },
    // efroni / rehab / pardes absent entirely
  ]);
  const rows = s.occupancySnapshotRowsFromOverview_('2026-06', overview, 'now');
  assert.deepStrictEqual(plain(rows.map((r) => r.houseId)), ['raanana', 'ramot']);
});

test('a house with no data (zero treatment days) yields NO ROW', () => {
  const s = load();
  const overview = overviewFor('2026-06', [
    { key: 'raanana', manager: 'שחר',  treatmentDays: 300, avgDaily: 10 },
    { key: 'pardes',  manager: 'חן',   treatmentDays: 0,   avgDaily: 0 },
    { key: 'rehab',   manager: 'רנטה', treatmentDays: null, avgDaily: null },
  ]);
  const rows = s.occupancySnapshotRowsFromOverview_('2026-06', overview, 'now');
  assert.deepStrictEqual(plain(rows.map((r) => r.houseId)), ['raanana']);
});

test('a failed / malformed overview yields no rows rather than junk rows', () => {
  const s = load();
  assert.deepStrictEqual(plain(s.occupancySnapshotRowsFromOverview_('2026-06', null, 'n')), []);
  assert.deepStrictEqual(plain(s.occupancySnapshotRowsFromOverview_('2026-06', { ok: false }, 'n')), []);
  assert.deepStrictEqual(plain(s.occupancySnapshotRowsFromOverview_('2026-06', { ok: true }, 'n')), []);
});

/* ============================== writes + idempotency ======================= */

test('snapshotMonth_ appends one row per house, and the month is stored as TEXT', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));
  const res = s.snapshotMonth_('2026-06');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.appended, 5);
  assert.strictEqual(res.skipped, 0);

  const monthCol = s.OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('month');
  const capturedCol = s.OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('capturedAt');
  const sheet = s.__sheet;

  // rows 2..6 hold the data; row 1 is the frozen header
  assert.strictEqual(sheet.getLastRow(), 6);
  for (let r = 1; r < 6; r++) {
    assert.strictEqual(typeof sheet.grid[r][monthCol], 'string', 'month cell must be a string');
    assert.strictEqual(sheet.grid[r][monthCol], '2026-06');
    assert.strictEqual(sheet.formats[r][monthCol], '@', 'month column pinned to plain text');
    assert.strictEqual(sheet.formats[r][capturedCol], '@', 'capturedAt column pinned to plain text');
  }

  // the text format is applied BEFORE the values land
  const order = sheet.ops.filter((o) => o.op === 'setNumberFormat' || o.op === 'setValues').map((o) => o.op);
  assert.strictEqual(order[order.length - 1], 'setValues', 'values written last');
  assert.ok(order.indexOf('setNumberFormat') < order.indexOf('setValues'));
});

/* flatHouses needs the month length; keep it local and pure. */
function s0DaysInMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

test('a second run of the same month adds ZERO rows and rewrites nothing', () => {
  const s = load({ currentMonth: '2026-09' });
  const overview = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));
  s.managersOverview_ = overview;

  const first = s.snapshotMonth_('2026-06');
  assert.strictEqual(first.appended, 5);

  const before = JSON.stringify(s.__sheet.grid);
  s.__sheet.ops.length = 0;

  const second = s.snapshotMonth_('2026-06');
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.appended, 0, 'idempotent: second run appends nothing');
  assert.strictEqual(second.skipped, 5);
  assert.deepStrictEqual(plain(second.rows), []);

  assert.strictEqual(JSON.stringify(s.__sheet.grid), before, 'sheet contents are untouched');
  assert.deepStrictEqual(
    s.__sheet.ops.filter((o) => o.op === 'setValues' || o.op === 'clearContent'), [],
    'no write and no clear on the second run');
});

test('a later month appends BELOW the existing rows — never over them', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));

  s.snapshotMonth_('2026-06');
  const juneRows = s.__sheet.grid.slice(1, 6).map((r) => r.slice());
  s.snapshotMonth_('2026-07');

  assert.strictEqual(s.__sheet.getLastRow(), 11, '5 June + 5 July rows below the header');
  assert.deepStrictEqual(s.__sheet.grid.slice(1, 6).map((r) => r.slice()), juneRows,
    'the June block is byte-identical after the July write');
  const monthCol = s.OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('month');
  assert.deepStrictEqual(plain(s.__sheet.grid.slice(6, 11).map((r) => r[monthCol])),
    ['2026-07', '2026-07', '2026-07', '2026-07', '2026-07']);
});

test('the write is wrapped in LockService and re-checks the sheet inside the lock', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, { raanana: 12 }, s0DaysInMonth(ym)));
  s.snapshotMonth_('2026-06');
  const ops = s.__sheet.ops.map((o) => o.op);
  assert.ok(ops.indexOf('lock') >= 0, 'lock acquired');
  assert.ok(ops.indexOf('lock') < ops.indexOf('setValues'), 'lock precedes the write');
  assert.ok(ops.lastIndexOf('unlock') > ops.indexOf('setValues'), 'lock released after the write');
});

/* ============================== monthly trigger ============================ */

test('runMonthlyOccupancySnapshot snapshots the PREVIOUS month', () => {
  const seen = [];
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => { seen.push(ym); return overviewFor(ym, flatHouses(ym, { raanana: 12 }, s0DaysInMonth(ym))); };
  const res = s.runMonthlyOccupancySnapshot();
  assert.deepStrictEqual(seen, ['2026-08']);
  assert.strictEqual(res.month, '2026-08');
  assert.strictEqual(res.appended, 1);
});

test('runMonthlyOccupancySnapshot rolls the year at January', () => {
  const seen = [];
  const s = load({ currentMonth: '2027-01' });
  s.managersOverview_ = (ym) => { seen.push(ym); return overviewFor(ym, []); };
  s.runMonthlyOccupancySnapshot();
  assert.deepStrictEqual(seen, ['2026-12']);
});

test('installOccupancySnapshotTrigger leaves EXACTLY one trigger, on day 1 at 03:00', () => {
  const s = load({ triggers: [] });
  const res = s.installOccupancySnapshotTrigger();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removed, 0);
  assert.strictEqual(res.installed, 1);
  assert.strictEqual(res.monthDay, 1);
  assert.strictEqual(res.hour, 3);
  assert.strictEqual(s.__triggers.length, 1);
  assert.deepStrictEqual(plain(s.__created), [{
    handler: 'runMonthlyOccupancySnapshot', kind: 'timeBased', monthDay: 1, hour: 3,
  }]);
});

test('installOccupancySnapshotTrigger is idempotent: duplicates are removed, foreign triggers kept', () => {
  const dupe = () => ({ getHandlerFunction: () => 'runMonthlyOccupancySnapshot' });
  const foreign = { getHandlerFunction: () => 'nightlyIntegrityJob' };
  const s = load({ triggers: [dupe(), foreign, dupe(), dupe()] });

  const res = s.installOccupancySnapshotTrigger();
  assert.strictEqual(res.removed, 3);
  const handlers = s.__triggers.map((t) => t.getHandlerFunction());
  assert.deepStrictEqual(handlers.filter((h) => h === 'runMonthlyOccupancySnapshot').length, 1,
    'exactly one snapshot trigger remains');
  assert.ok(handlers.includes('nightlyIntegrityJob'), 'another job\'s trigger is never touched');
});

/* ============================ backfill + preview =========================== */

test('occupancySnapshotMonthRange_ walks 2026-05 → the last finished month', () => {
  const s = load();
  assert.deepStrictEqual(plain(s.occupancySnapshotMonthRange_('2026-05', '2026-08')),
    ['2026-05', '2026-06', '2026-07', '2026-08']);
  assert.deepStrictEqual(plain(s.occupancySnapshotMonthRange_('2026-11', '2027-02')),
    ['2026-11', '2026-12', '2027-01', '2027-02'], 'rolls the year');
  assert.deepStrictEqual(plain(s.occupancySnapshotMonthRange_('2026-05', '2026-05')), ['2026-05']);
  assert.deepStrictEqual(plain(s.occupancySnapshotMonthRange_('2026-05', '2026-04')), [],
    'nothing to do before the anchor month');
  assert.deepStrictEqual(plain(s.occupancySnapshotMonthRange_('2026-05', 'bad')), []);
});

test('backfillOccupancySnapshotsNow writes 2026-05 → last finished month, then is a no-op', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));

  const first = s.backfillOccupancySnapshotsNow();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.dryRun, false);
  assert.strictEqual(first.firstMonth, '2026-05');
  assert.strictEqual(first.lastMonth, '2026-08', 'the running month is never backfilled');
  assert.strictEqual(first.months, 4);
  assert.strictEqual(first.appended, 20, '4 months × 5 houses');
  assert.deepStrictEqual(plain(first.summary.map((r) => r.month)), ['2026-05', '2026-06', '2026-07', '2026-08']);
  first.summary.forEach((r) => { assert.strictEqual(r.appended, 5); assert.strictEqual(r.error, null); });

  // a per-month summary line is logged
  ['2026-05', '2026-06', '2026-07', '2026-08'].forEach((m) => {
    assert.ok(s.__logs.some((l) => l.includes(m) && l.includes('appended')), 'no log line for ' + m);
  });
  assert.ok(s.__logs.some((l) => l.includes('TOTAL')), 'a total line is logged');

  const before = JSON.stringify(s.__sheet.grid);
  const second = s.backfillOccupancySnapshotsNow();
  assert.strictEqual(second.appended, 0, 'idempotent');
  assert.strictEqual(second.skipped, 20);
  assert.strictEqual(JSON.stringify(s.__sheet.grid), before);
});

test('previewOccupancySnapshotsNow is a DRY RUN — it writes nothing', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));

  const res = s.previewOccupancySnapshotsNow();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.appended, 20, 'reports what it WOULD write');
  assert.strictEqual(res.months, 4);
  assert.deepStrictEqual(
    s.__sheet.ops.filter((o) => o.op === 'setValues' || o.op === 'clearContent'), [],
    'preview must not write');
  assert.strictEqual(s.__sheet.getLastRow(), 1, 'header only');
  assert.ok(s.__logs.some((l) => l.includes('dry run')), 'dry-run runs are labelled in the log');
});

test('backfill before the anchor month does nothing at all', () => {
  const s = load({ currentMonth: '2026-05' });
  const res = s.backfillOccupancySnapshotsNow();
  assert.strictEqual(res.months, 0);
  assert.strictEqual(res.appended, 0);
  assert.deepStrictEqual(s.__sheet.ops.filter((o) => o.op === 'setValues'), [], 'nothing written');
  assert.ok(s.__sheet.getLastRow() <= 1, 'header at most — no data rows');
});

/* ================================ read feed =============================== */

test('occupancySnapshots_ returns { ok:true, rows } sorted by month then houseId', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, {
    raanana: 12, ramot: 18, efroni: 10, rehab: 11, pardes: 9,
  }, s0DaysInMonth(ym)));

  // written out of order on purpose
  s.snapshotMonth_('2026-07');
  s.snapshotMonth_('2026-05');
  s.snapshotMonth_('2026-06');

  const res = s.occupancySnapshots_();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rows.length, 15);

  const order = plain(res.rows.map((r) => r.month + '/' + r.houseId));
  const expected = ['2026-05', '2026-06', '2026-07'].flatMap((m) =>
    ['arfoni', 'pardes', 'raanana', 'ramot', 'rehab'].map((h) => m + '/' + h));
  assert.deepStrictEqual(order, expected);

  const row = res.rows[0];
  assert.deepStrictEqual(Object.keys(row).sort(), plain(s.OCCUPANCY_SNAPSHOT_COLUMNS).sort());
  assert.strictEqual(typeof row.month, 'string');
  assert.strictEqual(typeof row.occupancyPct, 'number');
});

test('a month cell that a human reformatted into a Date still reads back as YYYY-MM', () => {
  const s = load();
  assert.strictEqual(s.occupancySnapshotMonthText_(new Date(2026, 5, 1)), '2026-06');
  assert.strictEqual(s.occupancySnapshotMonthText_('2026-06'), '2026-06');
  assert.strictEqual(s.occupancySnapshotMonthText_('2026-06-01'), '2026-06');
  assert.strictEqual(s.occupancySnapshotMonthText_(''), '');
  assert.strictEqual(s.occupancySnapshotMonthText_(null), '');
});

test('idempotency survives a month cell that came back as a Date', () => {
  const s = load({ currentMonth: '2026-09' });
  s.managersOverview_ = (ym) => overviewFor(ym, flatHouses(ym, { raanana: 12 }, s0DaysInMonth(ym)));
  s.snapshotMonth_('2026-06');

  // simulate Sheets handing the cell back as a typed Date
  const monthCol = s.OCCUPANCY_SNAPSHOT_COLUMNS.indexOf('month');
  s.__sheet.grid[1][monthCol] = new Date(2026, 5, 1);

  const again = s.snapshotMonth_('2026-06');
  assert.strictEqual(again.appended, 0, 'still recognised as already captured');
});

/* ========================= source-scan contract guards ==================== */

test('the module is APPEND-ONLY: no clear, delete or overwrite primitive anywhere in it', () => {
  [
    'clearContent', 'clear(', 'deleteRow', 'deleteRows', 'deleteSheet',
    'removeSheet', 'deleteRowsById_', 'clearBody_', 'setValue(',
  ].forEach((needle) => {
    assert.ok(!MODULE_CODE.includes(needle),
      'append-only violated: the occupancy snapshot module must not use ' + needle);
  });
  // exactly one write call in the whole module
  const writes = MODULE_CODE.match(/\.setValues\(/g) || [];
  assert.strictEqual(writes.length, 1, 'the module must have exactly one setValues call');
});

test('the write targets getLastRow() + 1 — the append position, never an existing row', () => {
  assert.ok(/const target = sh\.getLastRow\(\) \+ 1;/.test(MODULE_CODE));
  assert.ok(/sh\.getRange\(target, 1, values\.length, OCCUPANCY_SNAPSHOT_COLUMNS\.length\)\.setValues\(values\)/
    .test(MODULE_CODE));
});

test('the write is inside LockService', () => {
  assert.ok(MODULE_CODE.includes('LockService.getScriptLock()'));
  assert.ok(MODULE_CODE.includes('lock.releaseLock()'));
  const lockAt = MODULE_CODE.indexOf('LockService.getScriptLock()');
  const writeAt = MODULE_CODE.indexOf('.setValues(values)');
  assert.ok(lockAt !== -1 && writeAt !== -1 && lockAt < writeAt);
});

test('occupancy math is NOT duplicated: snapshotMonth_ calls managersOverview_', () => {
  const src = gsFunction('snapshotMonth_');
  assert.ok(src.includes('managersOverview_(ym)'),
    'snapshotMonth_ must reuse the managersOverview_ computation');
  // the module must not reimplement the per-day walk
  ['computeMonthStats_', 'dailyCounts', 'readPatientsForBonus_', 'parseDate_'].forEach((needle) => {
    assert.ok(!MODULE_CODE.includes(needle),
      'the module must not re-derive occupancy itself (' + needle + ')');
  });
});

test('the module introduces NO new secret and reads no Script Property', () => {
  ['PropertiesService', 'getProperty', 'setProperty', 'SECRET'].forEach((needle) => {
    assert.ok(!MODULE_CODE.includes(needle), 'no new secret may be introduced: ' + needle);
  });
});

test('doGet routes action=occupancySnapshots, on the managersOverview access model', () => {
  const handleStart = GS.indexOf('function handle_');
  const handleEnd = GS.indexOf('\nfunction ', handleStart + 1);
  const handleBody = GS.slice(handleStart, handleEnd);
  assert.ok(handleBody.includes("if (action === 'occupancySnapshots')"));
  assert.ok(handleBody.includes('jsonOut_(occupancySnapshots_())'));

  // No auth gate — exactly like managersOverview / managersHouse.
  const at = handleBody.indexOf("action === 'occupancySnapshots'");
  const snippet = handleBody.slice(at, at + 200);
  assert.ok(!/AuthOk_|unauthorized/.test(snippet),
    'the snapshots feed must sit on the same access model as managersOverview');
});

test('the editor-run entry points are NOT reachable over HTTP', () => {
  const handleStart = GS.indexOf('function handle_');
  const handleEnd = GS.indexOf('\nfunction ', handleStart + 1);
  const handleBody = GS.slice(handleStart, handleEnd);
  ['installOccupancySnapshotTrigger', 'backfillOccupancySnapshotsNow',
   'previewOccupancySnapshotsNow', 'runMonthlyOccupancySnapshot', 'snapshotMonth_']
    .forEach((fn) => {
      assert.ok(!handleBody.includes(fn), 'handle_ must never route to ' + fn);
    });
});

test('no existing action response shape is touched by this change', () => {
  // managersOverview_ / managersHouse_ / getData_ return statements are the
  // contract three apps share; the module must not appear inside any of them.
  ['managersOverview_', 'managersHouse_'].forEach((fn) => {
    const src = gsFunction(fn);
    assert.ok(!src.includes('occupancy'), fn + ' must be untouched by the snapshot work');
    assert.ok(!src.includes('Snapshot'), fn + ' must be untouched by the snapshot work');
  });
});
