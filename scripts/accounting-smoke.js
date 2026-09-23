#!/usr/bin/env node
/* Read-only smoke test for the accounting source feed.
 *
 *   node scripts/accounting-smoke.js
 *
 * Runs the REAL shipped apps-script/Code.gs inside a vm sandbox against an
 * in-memory spreadsheet and drives the endpoint exactly as the accounting app
 * will: authenticate, full sync, page, then an incremental sync from the
 * watermark the full sync returned. It prints every request and the response
 * shape so the contract can be eyeballed without a live deployment.
 *
 * It asserts the three properties that matter operationally and exits non-zero
 * if any of them breaks:
 *   1. an unauthenticated call serves nothing;
 *   2. paging visits every row exactly once;
 *   3. a read performs no business write (only the one-time identity mint).
 *
 * To smoke the LIVE deployment instead, see the curl in
 * CHANGELOG-accounting-source-feed.md — it needs the /exec URL and the
 * ACCOUNTING_SECRET Script Property, neither of which lives in this repo.
 */

process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SECRET = 'smoke-secret';

let seq = 0;
function sheet(header, rows) {
  const grid = [header.slice()].concat((rows || []).map((r) => r.slice()));
  const ops = [];
  return {
    grid, ops,
    getLastRow: () => grid.length,
    getLastColumn: () => (grid[0] ? grid[0].length : 0),
    getMaxRows: () => Math.max(grid.length, 1000),
    setFrozenRows() {}, hideSheet() {}, isSheetHidden: () => false,
    appendRow(r) { ops.push({ op: 'append' }); grid.push(r.slice()); },
    deleteRow(r) { ops.push({ op: 'delete' }); grid.splice(r - 1, 1); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() { ops.push({ op: 'fmt', seq: ++seq }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) { ops.push({ op: 'setcell', c }); if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(v) {
          ops.push({ op: 'set' });
          for (let i = 0; i < v.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < v[i].length; j++) grid[r - 1 + i][c - 1 + j] = v[i][j];
          }
        },
        clearContent() { ops.push({ op: 'clear' }); },
      };
    },
  };
}

function fmt(d, _tz, pattern) {
  const p = (n) => String(n).padStart(2, '0');
  if (pattern === 'yyyy-MM-dd') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (pattern === 'yyyy-MM') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  if (pattern === 'HH:mm') return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const off = -d.getTimezoneOffset();
  // SimpleDateFormat's 'Z' token: RFC-822, no colon. Code.gs inserts it.
  const s = (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}`;
}

const noop = () => {};
let uuid = 0;
const props = { ACCOUNTING_SECRET: SECRET };
const box = {
  console: { log: noop, warn: noop, error: noop, info: noop },
  JSON, Math, Date, Number, String, Array, Object, RegExp, Set,
  isNaN, isFinite, parseInt, parseFloat,
  Logger: { log: noop },
  __sheets: {},
};
box.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => box.__sheets[n] || null,
    insertSheet: (n) => (box.__sheets[n] = sheet([], [])),
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }),
};
box.PropertiesService = {
  getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty(k, v) { props[k] = v; return this; } }),
};
box.ContentService = {
  createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
  MimeType: { JSON: 'json' },
};
box.Utilities = { getUuid: () => 'smoke-' + (++uuid), formatDate: fmt };
box.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
box.globalThis = box;
vm.createContext(box);
vm.runInContext(GS + `globalThis.__api = {
  PAYMENT_COLUMNS, PATIENT_COLUMNS, CREDIT_COLUMNS, PAYMENTS_SHEET, PATIENTS_SHEET, CREDITS_SHEET,
  handle: (p) => handle_(p).json, objectToRow: (o, c) => objectToRow_(o, c),
};`, box);
const api = box.__api;

/* ---- seed a small, realistic spreadsheet -------------------------------- */
const DANA = 'דנה כהן';
const KEY = 'arfoni::' + DANA + '::2025-06-20';
function seed(name, cols, rows) {
  box.__sheets[name] = sheet(Array.from(cols), rows.map((r) => api.objectToRow(r, Array.from(cols))));
}
seed(api.PATIENTS_SHEET, api.PATIENT_COLUMNS, [
  { houseId: 'arfoni', name: DANA, date: '2025-06-20', pay: 3000, status: 'active',
    notes: 'אבחנה קלינית שלא אמורה לדלוף', id: 'id-dana' },
]);
const payments = [];
for (let i = 1; i <= 7; i++) {
  const due = '2026-0' + i + '-20';
  payments.push({
    id: 'pay::' + KEY + '::' + due, patientId: KEY, patientName: DANA, houseId: 'arfoni',
    dueDate: due, amount: 3000, status: i <= 5 ? 'paid' : 'unpaid',
    amountPaid: i <= 5 ? 3000 : 0, balance: i <= 5 ? 0 : 3000,
    timestamp: '2026-0' + i + '-20T08:00:00.000Z',
    coverageStart: '', coverageEnd: '',
    // rows 1–3 are HISTORICAL (never written since the contract shipped)
    sourceUpdatedAt: i <= 3 ? '' : '2026-09-0' + i + 'T10:00:00+03:00',
    sourceVersion: i <= 3 ? '' : 1,
    chargedAt: i <= 3 ? '' : '2026-09-0' + i + 'T10:00:00+03:00',
    chargedBy: i <= 3 ? '' : 'ורד',
  });
}
seed(api.PAYMENTS_SHEET, api.PAYMENT_COLUMNS, payments);
seed(api.CREDITS_SHEET, api.CREDIT_COLUMNS, []);

/* ---- drive it ----------------------------------------------------------- */
const line = (s) => process.stdout.write(s + '\n');
let failures = 0;
function check(label, fn) {
  try { fn(); line('  ✓ ' + label); }
  catch (e) { failures++; line('  ✗ ' + label + '\n    ' + e.message); }
}

line('\n== 1. unauthenticated ==');
line('  GET ?action=accountingPayments            (no secret)');
const anon = api.handle({ action: 'accountingPayments' });
line('  → ' + JSON.stringify(anon));
check('serves nothing without the secret', () => {
  assert.equal(anon.ok, false);
  assert.equal(anon.error, 'unauthorized');
  assert.ok(!JSON.stringify(anon).includes(DANA));
});
const wrong = api.handle({ action: 'accountingPayments', secret: 'nope' });
check('serves nothing with a wrong secret', () => assert.equal(wrong.error, 'unauthorized'));

line('\n== 2. full sync, paged ==');
const seen = [];
let cursor = null, page = 0;
do {
  line('  GET ?action=accountingPayments&secret=***&limit=3' + (cursor ? '&cursor=' + cursor : ''));
  const res = api.handle({ action: 'accountingPayments', secret: SECRET, limit: 3, cursor });
  assert.equal(res.ok, true);
  page++;
  res.payments.forEach((p) => seen.push(p.paymentUid));
  line(`  → page ${page}: ${res.page.count} row(s), hasMore=${res.page.hasMore}` +
       `, tombstones=${res.tombstones.length}` +
       `, historical=${res.payments.filter((p) => p.historical).length}`);
  cursor = res.page.nextCursor;
} while (cursor && page < 20);
check('every row seen exactly once', () => {
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
});

line('\n== 3. one record, in full ==');
const one = api.handle({ action: 'accountingPayments', secret: SECRET, limit: 1,
  updatedSince: '2026-09-01T00:00:00+03:00' });
line(JSON.stringify(one.payments[0], null, 2).split('\n').map((l) => '  ' + l).join('\n'));
check('no clinical data anywhere in the response', () => {
  const body = JSON.stringify(one);
  assert.ok(!body.includes('אבחנה'));
  ['"notes"', '"reason"', '"basis"', '"adv"', '"source"'].forEach((k) => assert.ok(!body.includes(k), k));
});
check('amounts are VAT-inclusive and marked as such', () => {
  assert.equal(one.payments[0].vatInclusive, true);
  assert.equal(one.payments[0].amount, 3000);
});

line('\n== 4. incremental sync from a watermark ==');
line('  GET ?action=accountingPayments&secret=***&updatedSince=2026-09-01T00:00:00%2B03:00');
const inc = api.handle({ action: 'accountingPayments', secret: SECRET,
  updatedSince: '2026-09-01T00:00:00+03:00' });
line(`  → ${inc.payments.length} row(s); historical rows excluded: ` +
     `${inc.payments.filter((p) => p.historical).length === 0}`);
check('historical rows never enter an incremental read', () => {
  assert.equal(inc.payments.length, 4);
  assert.ok(inc.payments.every((p) => !p.historical));
});
check('a mistyped watermark is refused, not treated as a full sync', () => {
  assert.equal(api.handle({ action: 'accountingPayments', secret: SECRET, updatedSince: 'last tuesday' }).error,
    'bad_updatedSince');
});

line('\n== 5. reads perform no business write ==');
const sh = box.__sheets[api.PAYMENTS_SHEET];
api.handle({ action: 'accountingPayments', secret: SECRET });   // settle the identity mint
const before = JSON.stringify(sh.grid);
sh.ops.length = 0;
api.handle({ action: 'accountingPayments', secret: SECRET });
api.handle({ action: 'accountingCredits', secret: SECRET });
check('second read writes nothing at all', () => {
  assert.equal(sh.ops.filter((o) => o.op !== 'fmt').length, 0);
  assert.equal(JSON.stringify(sh.grid), before);
});

line(failures ? `\nFAILED — ${failures} check(s)\n` : '\nAll smoke checks passed.\n');
process.exit(failures ? 1 : 0);
