/* Tests for the BillingOverrides foundation (PR 1 — storage + plumbing, no UI).
 *
 *   Code.gs — BILLING_OVERRIDE_COLUMNS shape (readSheet_ maps cells to keys BY
 *             POSITION, so the order is a contract); getOrCreateSheet_ force-texts
 *             the month + amount columns; upsertBillingOverride_ upserts by
 *             (patientId, month) with REPLACE semantics and text-formats month +
 *             amount BEFORE setValues; deleteBillingOverride_ removes the row.
 *   app.js  — normalizeBillingOverride (defensive pickField pattern), the
 *             deterministic billingOverrideId(), and monthKey() formatting.
 *
 * Both files are non-Node scripts; per the repo's vm-sandbox convention we read
 * the source, stub the globals, and exercise the REAL shipped functions. The
 * fakeSheet mirrors the one in visittime-text-columns-and-quarter-select.test.js. */

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
        clearContent() {
          for (let i = 0; i < nr; i++) {
            for (let j = 0; j < nc; j++) {
              if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = '';
            }
          }
        },
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
  const noop = () => {};
  const registry = {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    Utilities: { formatDate: () => '2026-08-09' },
    LockService: { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) },
    __registry: registry,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => registry[name] || null,
      insertSheet: (name) => (registry[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    BILLING_OVERRIDE_COLUMNS: BILLING_OVERRIDE_COLUMNS,
    BILLING_OVERRIDES_SHEET: BILLING_OVERRIDES_SHEET,
    billingOverrideId_: (p, m) => billingOverrideId_(p, m),
    upsert: (o) => upsertBillingOverride_(o),
    del: (o) => deleteBillingOverride_(o),
    ensure: () => getOrCreateSheet_(BILLING_OVERRIDES_SHEET, BILLING_OVERRIDE_COLUMNS),
    readSheet: (sh, cols) => readSheet_(sh, cols),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, registry, sandbox, fakeSheet };
}

/* ---------- load public/app.js (with a DOM stub) ---------- */
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const noop = () => {};
  const fakeEl = () => ({
    className: '', dataset: {}, style: {}, _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild() {}, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const doc = {
    getElementById: () => fakeEl(),
    createElement: () => fakeEl(),
    querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
  };
  const epilogue = `globalThis.__test = {
    normalizeBillingOverride: (r) => normalizeBillingOverride(r),
    billingOverrideId: (p, m) => billingOverrideId(p, m),
    monthKey: (iso) => monthKey(iso),
  };`;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const { code, registry, fakeSheet: mkSheet } = loadCode();
const app = loadApp();

/* Seed a fresh BillingOverrides sheet in the registry and return it. */
function seedOverrides(rows) {
  const sh = mkSheet(arr(code.BILLING_OVERRIDE_COLUMNS), rows || []);
  registry[code.BILLING_OVERRIDES_SHEET] = sh;
  return sh;
}

/* ===== Code.gs — column contract ===== */

test('BILLING_OVERRIDE_COLUMNS is exactly [id, patientId, month, amount, created]', () => {
  assert.deepStrictEqual(
    arr(code.BILLING_OVERRIDE_COLUMNS),
    ['id', 'patientId', 'month', 'amount', 'created']
  );
});

test('BILLING_OVERRIDES_SHEET is the internal sheet name', () => {
  assert.strictEqual(code.BILLING_OVERRIDES_SHEET, 'BillingOverrides');
});

/* ===== id parity between Code.gs and app.js ===== */

test('billingOverrideId matches between server and client', () => {
  const p = 'arfoni::דנה::2026-01-15', m = '2026-08';
  assert.strictEqual(code.billingOverrideId_(p, m), `ovr::${p}::${m}`);
  assert.strictEqual(app.billingOverrideId(p, m), code.billingOverrideId_(p, m));
});

/* ===== upsert-replaces semantics ===== */

test('upsertBillingOverride_ appends a new row for a new (patientId, month)', () => {
  const sh = seedOverrides([]);
  const res = code.upsert({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created, true);
  // header + 1 data row
  assert.strictEqual(sh.getLastRow(), 2);
  const stored = code.readSheet(sh, code.BILLING_OVERRIDE_COLUMNS);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(String(stored[0].id), 'ovr::p1::2026-08');
  assert.strictEqual(Number(stored[0].amount), 4200);
});

test('upsertBillingOverride_ REPLACES the amount for the same (patientId, month) — no duplicate row', () => {
  const sh = seedOverrides([]);
  code.upsert({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  const res = code.upsert({ patientId: 'p1', month: '2026-08', amount: 3900, created: '2026-08-09' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.updated, true);
  // still exactly one data row
  assert.strictEqual(sh.getLastRow(), 2);
  const stored = code.readSheet(sh, code.BILLING_OVERRIDE_COLUMNS);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(Number(stored[0].amount), 3900);
});

test('upsertBillingOverride_ keeps months isolated — different months are different rows', () => {
  const sh = seedOverrides([]);
  code.upsert({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  code.upsert({ patientId: 'p1', month: '2026-09', amount: 5000, created: '2026-08-09' });
  const stored = code.readSheet(sh, code.BILLING_OVERRIDE_COLUMNS);
  assert.strictEqual(stored.length, 2);
  const aug = stored.find(o => o.month === '2026-08');
  const sep = stored.find(o => o.month === '2026-09');
  assert.strictEqual(Number(aug.amount), 4200);
  assert.strictEqual(Number(sep.amount), 5000);
});

test('upsertBillingOverride_ text-formats month + amount BEFORE setValues', () => {
  const sh = seedOverrides([]);
  sh.ops.length = 0;
  code.upsert({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  const setIdx = sh.ops.findIndex(o => o.op === 'set');
  const fmtOps = sh.ops.filter((o, i) => o.op === 'fmt' && i < setIdx);
  // month is column 3, amount column 4 (1-indexed) — both forced to text before
  // the row is written. getOrCreateSheet_ also whole-column-formats them, so the
  // exact op count is not asserted; what matters is that cols 3 and 4 are both
  // set to plain text ('@') and that this happens BEFORE the setValues.
  const fmtCols = new Set(fmtOps.map(o => o.c));
  assert.ok(fmtCols.has(3), 'month column formatted before write');
  assert.ok(fmtCols.has(4), 'amount column formatted before write');
  assert.ok(fmtOps.every(o => o.fmt === '@'), 'month + amount forced to plain text');
});

/* ===== validation (fail-closed on bad input) ===== */

test('upsertBillingOverride_ rejects a missing patientId', () => {
  seedOverrides([]);
  assert.strictEqual(code.upsert({ month: '2026-08', amount: 100 }).error, 'missing_patientId');
});

test('upsertBillingOverride_ rejects a non YYYY-MM month', () => {
  seedOverrides([]);
  assert.strictEqual(code.upsert({ patientId: 'p1', month: '2026-08-01', amount: 100 }).error, 'bad_month');
  assert.strictEqual(code.upsert({ patientId: 'p1', month: 'nope', amount: 100 }).error, 'bad_month');
});

test('upsertBillingOverride_ rejects a negative or non-numeric amount', () => {
  seedOverrides([]);
  assert.strictEqual(code.upsert({ patientId: 'p1', month: '2026-08', amount: -5 }).error, 'bad_amount');
  assert.strictEqual(code.upsert({ patientId: 'p1', month: '2026-08', amount: 'x' }).error, 'bad_amount');
});

/* ===== delete restores base (removes the row) ===== */

test('deleteBillingOverride_ removes the matching row (by id)', () => {
  const sh = seedOverrides([]);
  code.upsert({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  code.upsert({ patientId: 'p2', month: '2026-08', amount: 3000, created: '2026-08-09' });
  const res = code.del({ patientId: 'p1', month: '2026-08' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.deleted, true);
  const stored = code.readSheet(sh, code.BILLING_OVERRIDE_COLUMNS);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].patientId, 'p2');
});

test('deleteBillingOverride_ needs an id or (patientId + month)', () => {
  seedOverrides([]);
  assert.strictEqual(code.del({ patientId: 'p1' }).error, 'missing_id');
});

/* ===== app.js — normalizeBillingOverride ===== */

test('normalizeBillingOverride preserves present values', () => {
  const out = app.normalizeBillingOverride({
    id: 'ovr::p1::2026-08', patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09',
  });
  // Copy into the test realm so deepStrictEqual compares contents, not the
  // cross-realm object prototype (same reason the array tests use arr()).
  assert.deepStrictEqual({ ...out }, {
    id: 'ovr::p1::2026-08', patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09',
  });
});

test('normalizeBillingOverride coerces amount to a number and defaults to 0', () => {
  assert.strictEqual(app.normalizeBillingOverride({ patientId: 'p1', month: '2026-08', amount: '3900' }).amount, 3900);
  assert.strictEqual(app.normalizeBillingOverride({ patientId: 'p1', month: '2026-08' }).amount, 0);
});

test('normalizeBillingOverride clamps month to YYYY-MM (no day precision leaks into the key)', () => {
  const out = app.normalizeBillingOverride({ patientId: 'p1', month: '2026-08-31', amount: 100 });
  assert.strictEqual(out.month, '2026-08');
});

test('normalizeBillingOverride derives a deterministic id when absent', () => {
  const out = app.normalizeBillingOverride({ patientId: 'p1', month: '2026-08', amount: 100 });
  assert.strictEqual(out.id, 'ovr::p1::2026-08');
});

test('normalizeBillingOverride survives a round-trip without dropping fields', () => {
  const first = app.normalizeBillingOverride({ patientId: 'p1', month: '2026-08', amount: 4200, created: '2026-08-09' });
  const second = app.normalizeBillingOverride(first);
  assert.deepStrictEqual(second, first);
});

test('normalizeBillingOverride tolerates junk input (empty patientId/month → blank id)', () => {
  const out = app.normalizeBillingOverride(null);
  assert.strictEqual(out.patientId, '');
  assert.strictEqual(out.month, '');
  assert.strictEqual(out.id, '');
});

/* ===== app.js — monthKey formatting ===== */

test('monthKey extracts YYYY-MM from an ISO date', () => {
  assert.strictEqual(app.monthKey('2026-08-09'), '2026-08');
  assert.strictEqual(app.monthKey('2026-08'), '2026-08');
  assert.strictEqual(app.monthKey(''), '');
});
