/* Patient funder (גורם מממן) — foundation (PR 1 of 2). See
 * CHANGELOG-patient-funder-foundation.md.
 *
 * Locked here:
 *   - public/funder.js: the fixed key list (no "other"), Hebrew labels, the
 *     strict key allowlist (unknown keys, Hebrew labels and case variants are
 *     refused), normalizeFunderEntry, funderAt (no history → unset; a future
 *     effectiveFrom is ignored; a mid-month switch; a same-day correction —
 *     the later recordedAt wins; a Sheets Date-object effectiveFrom),
 *     currentFunder, debtByFunder (the five funders sum to the EXISTING
 *     debtAging_ totals, per figure and per house; attribution by cycle start)
 *   - Code.gs: FunderHistory header order; setPatientFunder validation, the
 *     PROXY_SECRET gate, the finance capability, lock_busy, unknown patient,
 *     append-only (a correction is a new row), recordedBy from the session,
 *     no log line carries patient data; getData.funderHistory (Date cells
 *     coerced, a missing tab reads [] and is not created, dropped for a
 *     restricted actor)
 *   - nothing in the browser loads funder.js yet (no index.html / sw.js /
 *     app.js / server.js reference)
 *
 * vm sandbox on the real Code.gs. TZ pinned to Israel. Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const Funder = require('../public/funder.js');
const scope = require('../lib/finance-scope.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const PROXY = 'proxy-secret-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
const NOW = '2026-09-30T09:00:00.000Z';   // 12:00 in Israel → today 2026-09-30

/* ============================ Code.gs harness ============================ */

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}
function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}

/* A writable fake sheet that records every mutating call in `log`. */
function fakeSheet(name, grid, log) {
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxRows: () => 1000,
    getMaxColumns: () => Math.max(26, width()),
    setFrozenRows() {},
    appendRow(r) { log.push(name + '.appendRow'); grid.push(r.slice()); },
    deleteRow() { log.push(name + '.deleteRow'); throw new Error('no delete'); },
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(f) { log.push(name + '.setNumberFormat@' + r + ':' + f); return this; },
        setValue(v) { log.push(name + '.setValue@' + r); (grid[r - 1] = grid[r - 1] || [])[c - 1] = v; },
        setValues(v) {
          log.push(name + '.setValues@' + r);
          v.forEach((row, i) => { grid[r - 1 + i] = grid[r - 1 + i] || []; row.forEach((x, j) => { grid[r - 1 + i][c - 1 + j] = x; }); });
        },
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const g = grid[r - 1 + i];
          return g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '';
        })),
        getValue: () => ((grid[r - 1] || [])[c - 1] ?? ''),
      };
    },
  };
}

function loadGs(opts) {
  const o = opts || {};
  const log = [];
  const consoleLines = [];
  const grids = {};
  const sheets = {};
  const add = (name, grid) => { grids[name] = grid; sheets[name] = fakeSheet(name, grid, log); };
  Object.keys(o.grids || {}).forEach((n) => add(n, o.grids[n].map((r) => r.slice())));
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => Object.values(sheets),
    insertSheet: (n) => { log.push('insertSheet:' + n); add(n, []); return sheets[n]; },
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  };
  const props = Object.assign({}, o.props || {});
  let uuid = 0;
  const say = (...a) => consoleLines.push(a.map(String).join(' '));
  const sandbox = {
    console: { log: say, warn: say, error: say, info: say },
    JSON, Math, Date: frozenDate(o.now || NOW), Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log: say },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
    Utilities: { formatDate, getUuid: () => 'u' + (++uuid) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { log.push('tryLock'); return o.lockBusy ? false : true; },
      waitLock() {}, releaseLock() { log.push('releaseLock'); },
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__c = { FUNDER_HISTORY_SHEET, FUNDER_HISTORY_COLUMNS, FUNDER_KEYS, PATIENTS_SHEET, PATIENT_COLUMNS,
      OPEN_ACTIONS, PROXY_KNOWN_ACTIONS, FINANCE_ACTIONS, GETDATA_FINANCE_KEYS, DELETE_ACTIONS, APPROVER_ACTIONS };`, sandbox);
  const post = (body) => plain(sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).json);
  return { sandbox, C: plain(sandbox.__c), log, consoleLines, grids, post };
}

const PATIENT_HEADER = ['houseId', 'name', 'date', 'pay', 'adv', 'status', 'fromLead', 'exitDate', 'source', 'notes', 'id', 'updatedAt', 'updatedBy'];
const patientRow = (id, house, name) => [house, name, '2026-07-01', 30000, '', 'active', '', '', '', '', id, '', ''];
const FUNDER_HEADER = ['id', 'patientId', 'funder', 'effectiveFrom', 'recordedAt', 'recordedBy'];
const PATIENTS_GRID = [PATIENT_HEADER, patientRow('id-aaa', 'ramot', 'בדיקה אחת'), patientRow('id-bbb', 'rehab', 'בדיקה שתיים')];

/* A verified full-view (finance) proxy call as Sandra / Vered's server sends it. */
const asVered = (extra) => Object.assign({
  proxySecret: PROXY, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered',
  proxyRoles: ['staff', 'deleter'], proxyCaps: ['finance'],
}, extra);
const asShiran = (extra) => Object.assign({
  proxySecret: PROXY, proxyUser: 'שירן', user: 'שירן', proxyAuth: 'personal', proxyUserId: 'shiran',
  proxyRoles: ['staff'], proxyCaps: [],
}, extra);
const setFunder = (g, funder, who) => g.post((who || asVered)({ action: 'setPatientFunder', funder }));
const writes = (g) => g.log.filter((l) => /FunderHistory\.(setValues|appendRow|setValue|deleteRow)|insertSheet:FunderHistory/.test(l));

/* ============================ funder.js: keys ============================ */

test('funder.js: the fixed key list, stable keys, Hebrew labels, unset = «לא הוגדר»; Code.gs FUNDER_KEYS equal', () => {
  assert.deepStrictEqual([...Funder.FUNDER_KEYS], ['private', 'btl', 'mod', 'maccabi']);
  assert.equal(Funder.FUNDER_UNSET, 'unset');
  assert.deepStrictEqual(plain(Funder.FUNDER_LABELS), {
    private: 'פרטי', btl: 'ביטוח לאומי', mod: 'משרד הביטחון', maccabi: 'מכבי', unset: 'לא הוגדר',
  });
  assert.ok(!Funder.FUNDER_KEYS.includes('other'), 'no "other"');
  assert.deepStrictEqual(loadGs().C.FUNDER_KEYS, [...Funder.FUNDER_KEYS]);
  assert.equal(Funder.funderLabel('btl'), 'ביטוח לאומי');
  assert.equal(Funder.funderLabel('nope'), 'לא הוגדר');
  assert.ok(Object.isFrozen(Funder.FUNDER_KEYS) && Object.isFrozen(Funder.FUNDER_LABELS));
});

const BAD_KEYS = ['', 'other', 'unset', 'BTL', 'Btl', 'PRIVATE', 'Maccabi', ' btl', 'btl ', 'פרטי', 'ביטוח לאומי',
  'משרד הביטחון', 'מכבי', 'לא הוגדר', 'toString', '__proto__', 'constructor', null, undefined, 0, 1, true, {}, ['btl']];

test('funder.js: the key allowlist refuses unknown keys, Hebrew labels, case variants, padding and non-strings', () => {
  for (const k of Funder.FUNDER_KEYS) assert.equal(Funder.isFunderKey(k), true, k);
  for (const k of BAD_KEYS) assert.equal(Funder.isFunderKey(k), false, JSON.stringify(k));
  // and a row carrying one never counts
  for (const k of BAD_KEYS) {
    assert.equal(Funder.normalizeFunderEntry({ patientId: 'id-aaa', funder: k, effectiveFrom: '2026-08-01' }), null, JSON.stringify(k));
  }
});

test('funder.js: normalizeFunderEntry is pickField-defensive and refuses unusable rows', () => {
  assert.deepStrictEqual(Funder.normalizeFunderEntry({
    id: 'fh-1', patientId: ' id-aaa ', funder: 'mod', effectiveFrom: '2026-08-01', recordedAt: '2026-08-01T08:00:00.000Z', recordedBy: 'ורד',
  }), { id: 'fh-1', patientId: 'id-aaa', funder: 'mod', effectiveFrom: '2026-08-01', recordedAt: '2026-08-01T08:00:00.000Z', recordedBy: 'ורד' });
  // alternative column names
  const alt = Funder.normalizeFunderEntry({ patient_id: 'id-x', 'גורם מממן': 'btl', effective_from: '2026-07-15' });
  assert.deepStrictEqual([alt.patientId, alt.funder, alt.effectiveFrom, alt.id, alt.recordedAt], ['id-x', 'btl', '2026-07-15', '', '']);
  for (const bad of [null, undefined, 'x', 42, [], {},
    { funder: 'btl', effectiveFrom: '2026-08-01' },                       // no patient
    { patientId: 'id-a', funder: 'btl' },                                  // no date
    { patientId: 'id-a', funder: 'btl', effectiveFrom: '2026-02-30' },     // not a real day
    { patientId: 'id-a', funder: 'btl', effectiveFrom: '01/08/2026' },
    { patientId: 'id-a', funder: 'btl', effectiveFrom: 20260801 },
  ]) assert.equal(Funder.normalizeFunderEntry(bad), null, JSON.stringify(bad));
});

/* ============================ funder.js: funderAt ============================ */

const row = (patientId, funder, effectiveFrom, recordedAt) => ({ patientId, funder, effectiveFrom, recordedAt: recordedAt || '2026-08-01T08:00:00.000Z' });

test('funderAt: no history → unset; another patient\'s rows never leak; a bad date → unset', () => {
  assert.equal(Funder.funderAt([], 'id-aaa', '2026-09-01'), 'unset');
  assert.equal(Funder.funderAt(undefined, 'id-aaa', '2026-09-01'), 'unset');
  const h = [row('id-bbb', 'btl', '2026-01-01')];
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-09-01'), 'unset');
  assert.equal(Funder.funderAt(h, '', '2026-09-01'), 'unset');
  assert.equal(Funder.funderAt(h, 'id-bbb', 'not-a-date'), 'unset');
  assert.equal(Funder.funderAt(h, 'id-bbb', '2026-09-01'), 'btl');
});

test('funderAt: a future effectiveFrom is ignored until its day; before the first row → unset', () => {
  const h = [row('id-aaa', 'private', '2026-07-01'), row('id-aaa', 'mod', '2026-10-01')];
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-06-30'), 'unset');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-09-30'), 'private');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-10-01'), 'mod');
  assert.equal(Funder.currentFunder(h, 'id-aaa', '2026-09-30'), 'private');
  assert.equal(Funder.currentFunder(h, 'id-aaa', '2026-10-02'), 'mod');
});

test('funderAt: a switch mid-month applies from its day, whatever the row order', () => {
  const h = [row('id-aaa', 'maccabi', '2026-08-15'), row('id-aaa', 'private', '2026-07-01')];
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-01'), 'private');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-14'), 'private');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-15'), 'maccabi');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-31'), 'maccabi');
});

test('funderAt: a same-day correction — the later recordedAt wins (even if it is an earlier row); a tie → the later row', () => {
  const h = [
    row('id-aaa', 'mod', '2026-08-01', '2026-08-03T10:00:00.000Z'),      // the correction, listed first
    row('id-aaa', 'btl', '2026-08-01', '2026-08-02T10:00:00.000Z'),      // the original mistake
  ];
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-01'), 'mod');
  assert.equal(Funder.funderAt(h.slice().reverse(), 'id-aaa', '2026-08-01'), 'mod');
  const tie = [row('id-aaa', 'btl', '2026-08-01', 'x'), row('id-aaa', 'mod', '2026-08-01', 'x')];
  assert.equal(Funder.funderAt(tie, 'id-aaa', '2026-08-20'), 'mod');
  // a correction never rewrites the earlier period
  const h2 = [row('id-aaa', 'private', '2026-07-01'), ...h];
  assert.equal(Funder.funderAt(h2, 'id-aaa', '2026-07-31'), 'private');
});

test('funderAt: a Sheets Date-object effectiveFrom is read by its Israel day (no −1 drift)', () => {
  // A date-typed cell for 15/08/2026 is local midnight = 2026-08-14T21:00Z.
  const cell = new Date(2026, 7, 15);
  assert.equal(cell.toISOString(), '2026-08-14T21:00:00.000Z');
  const h = [row('id-aaa', 'private', '2026-07-01'), { patientId: 'id-aaa', funder: 'btl', effectiveFrom: cell, recordedAt: new Date('2026-08-15T06:00:00Z') }];
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-14'), 'private');
  assert.equal(Funder.funderAt(h, 'id-aaa', '2026-08-15'), 'btl');
  // the same cell after JSON transport (a full UTC timestamp string)
  const h2 = [row('id-aaa', 'private', '2026-07-01'), row('id-aaa', 'btl', JSON.parse(JSON.stringify(cell)))];
  assert.equal(Funder.funderAt(h2, 'id-aaa', '2026-08-14'), 'private');
  assert.equal(Funder.funderAt(h2, 'id-aaa', '2026-08-15'), 'btl');
  assert.equal(Funder.funderAt(h, 'id-aaa', new Date(2026, 7, 15)), 'btl', 'a Date query day too');
});

/* ============================ funder.js: debtByFunder ============================ */

const AVI = 'ramot::אבי בדיקה::2026-07-10';
const GAL = 'rehab::גל בדיקה::2026-08-05';
const HADAS = 'ramot::הדס בדיקה::2026-07-01';
const PATIENTS = [
  { id: 'pt-1', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, status: 'active' },
  { id: 'pt-2', houseId: 'rehab', name: 'גל בדיקה', date: '2026-08-05', pay: 20000, status: 'active' },
  { id: 'pt-3', houseId: 'arfoni', name: 'בת בדיקה', date: '2026-06-20', pay: 35000, status: 'active' },
  { id: 'pt-4', houseId: 'pardes', name: 'נועה בדיקה', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'pt-5', houseId: 'ramot', name: 'הדס בדיקה', date: '2026-07-01', pay: 30000, status: 'active' },
  { id: 'pt-6', houseId: 'asher', name: 'רון בדיקה', date: '2026-07-31', pay: 15000, status: 'active' },
  { id: '', houseId: 'asher', name: 'בלי מזהה', date: '2026-08-10', pay: 12000, status: 'active' },
];
const pay = (pid, due, f) => Object.assign({
  id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due,
}, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  pay(AVI, '2026-08-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-02T10:00:00+03:00' }),
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-08-05', { amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-08-05T09:00:00+03:00' }),
  pay(GAL, '2026-09-05', { amount: 20000, status: 'partial', amountPaid: 12000, chargedAt: '2026-09-06T09:00:00+03:00' }),
  pay(HADAS, '2026-08-01', { amount: 30000, status: 'unpaid', amountPaid: 0, coverageStart: '2026-08-05', coverageEnd: '2026-09-04' }),
];
const OVERRIDES = [{ id: 'ovr::' + AVI + '::2026-09', patientId: AVI, month: '2026-09', amount: 25000 }];
function tabsOf() {
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  return { patients: rows(PATIENTS), payments: rows(PAYMENTS), credits: rows([]), overrides: rows(OVERRIDES) };
}
let GS;
const aging = (asOf) => plain((GS || (GS = loadGs())).sandbox.debtAging_(asOf, tabsOf()));

/* History: pt-1 switches mid-stay; pt-3 has a same-day correction and a future
 * row; pt-4 starts mid-stay (its earlier cycles stay unset); pt-2, pt-6 and
 * the id-less patient have none. */
const HISTORY = [
  row('pt-1', 'private', '2026-07-01'),
  row('pt-1', 'btl', '2026-09-01'),
  row('pt-3', 'mod', '2026-06-01', '2026-06-01T08:00:00.000Z'),
  row('pt-3', 'maccabi', '2026-06-01', '2026-06-02T08:00:00.000Z'),
  row('pt-3', 'private', '2026-12-01'),
  row('pt-4', 'btl', '2026-08-01'),
  row('pt-5', 'מכבי', '2026-07-01'),            // a Hebrew label: never counts → unset
  { patientId: 'pt-6', funder: 'mod', effectiveFrom: new Date(2026, 7, 31) },   // Date cell, 31/08
];

const FUNDERS = ['private', 'btl', 'mod', 'maccabi', 'unset'];
const r2 = (n) => Math.round(n * 100) / 100;

function assertInvariant(report, split) {
  assert.deepStrictEqual(Object.keys(split).sort(), [...FUNDERS].sort());
  for (const kind of ['recorded_debt', 'unrecorded_cycles']) {
    assert.equal(r2(FUNDERS.reduce((s, f) => s + split[f][kind].total, 0)), report.totals[kind].total, kind + ' total');
    assert.equal(FUNDERS.reduce((s, f) => s + split[f][kind].count, 0), report.totals[kind].count, kind + ' count');
    for (const h of report.byHouse) {
      const sum = r2(FUNDERS.reduce((s, f) => s + ((split[f].byHouse[h.houseId] || {})[kind] || { total: 0 }).total, 0));
      assert.equal(sum, h[kind].total, kind + ' ' + h.houseId);
    }
    // no house appears that the report does not have
    for (const f of FUNDERS) for (const hid of Object.keys(split[f].byHouse)) {
      assert.ok(report.byHouse.some((h) => h.houseId === hid), hid);
    }
  }
}

test('debtByFunder: the funders + unset sum EXACTLY to the existing debt (per figure, per house) — several as-of dates', () => {
  for (const asOf of ['2026-08-31', '2026-09-15', '2026-09-30']) {
    const report = aging(asOf);
    assert.equal(report.ok, true);
    assert.ok(report.totals.recorded_debt.total > 0 && report.totals.unrecorded_cycles.total > 0, 'a non-trivial fixture');
    assertInvariant(report, Funder.debtByFunder(report, HISTORY, asOf));
    assertInvariant(report, Funder.debtByFunder(report, HISTORY));            // asOf from the report
    // no history at all → everything is unset, equal to the totals
    const none = Funder.debtByFunder(report, [], asOf);
    assertInvariant(report, none);
    for (const kind of ['recorded_debt', 'unrecorded_cycles']) {
      assert.equal(none.unset[kind].total, report.totals[kind].total);
      for (const f of ['private', 'btl', 'mod', 'maccabi']) assert.deepStrictEqual(none[f][kind], { count: 0, total: 0 });
    }
  }
});

test('debtByFunder: each cycle goes to the funder active on ITS start day', () => {
  const report = aging('2026-09-30');
  const split = Funder.debtByFunder(report, HISTORY, '2026-09-30');
  const expect = { private: { recorded_debt: 0, unrecorded_cycles: 0 }, btl: { recorded_debt: 0, unrecorded_cycles: 0 },
    mod: { recorded_debt: 0, unrecorded_cycles: 0 }, maccabi: { recorded_debt: 0, unrecorded_cycles: 0 }, unset: { recorded_debt: 0, unrecorded_cycles: 0 } };
  const kindOf = (c) => (c.kind === 'recorded' ? 'recorded_debt' : 'unrecorded_cycles');
  for (const p of report.byPatient) for (const c of p.cycles) {
    let f = 'unset';
    if (p.patientId === 'pt-1') f = c.start >= '2026-09-01' ? 'btl' : 'private';
    if (p.patientId === 'pt-3') f = 'maccabi';                               // the correction; the Dec row is future
    if (p.patientId === 'pt-4') f = c.start >= '2026-08-01' ? 'btl' : 'unset';
    if (p.patientId === 'pt-6') f = c.start >= '2026-08-31' ? 'mod' : 'unset';
    expect[f][kindOf(c)] = r2(expect[f][kindOf(c)] + c.balance);
  }
  for (const f of FUNDERS) for (const k of ['recorded_debt', 'unrecorded_cycles']) assert.equal(split[f][k].total, expect[f][k], f + ' ' + k);
  // spot checks against named cycles
  const avi = report.byPatient.find((p) => p.patientId === 'pt-1');
  const sep = avi.cycles.find((c) => c.start === '2026-09-10');
  assert.equal(sep.kind, 'recorded');
  assert.equal(split.btl.byHouse.ramot.recorded_debt.total >= sep.balance, true);
  assert.ok(split.maccabi.unrecorded_cycles.total > 0, 'pt-3 (arfoni) owes cycles under maccabi');
  assert.equal(split.maccabi.byHouse.arfoni.unrecorded_cycles.total, split.maccabi.unrecorded_cycles.total);
  assert.ok(split.unset.unrecorded_cycles.total > 0, 'pt-5 (Hebrew label), pt-2 and the id-less patient are unset');
});

test('debtByFunder: the two debt figures are never summed into one field; inputs are not mutated', () => {
  const report = aging('2026-09-30');
  const before = JSON.stringify([report, HISTORY.map((h) => Object.assign({}, h, { effectiveFrom: String(h.effectiveFrom) }))]);
  const split = Funder.debtByFunder(report, HISTORY, '2026-09-30');
  assert.equal(JSON.stringify([report, HISTORY.map((h) => Object.assign({}, h, { effectiveFrom: String(h.effectiveFrom) }))]), before);
  for (const f of FUNDERS) {
    assert.deepStrictEqual(Object.keys(split[f]).sort(), ['byHouse', 'recorded_debt', 'unrecorded_cycles']);
    for (const h of Object.values(split[f].byHouse)) assert.deepStrictEqual(Object.keys(h).sort(), ['recorded_debt', 'unrecorded_cycles']);
  }
  assert.ok(!/"total_debt"|"sum"|"combined"/.test(JSON.stringify(split)));
});

test('debtByFunder: refuses a non-report and an asOfDate that differs from the report', () => {
  const report = aging('2026-09-30');
  assert.throws(() => Funder.debtByFunder(null, []), TypeError);
  assert.throws(() => Funder.debtByFunder({ ok: false, error: 'bad_asOf' }, []), TypeError);
  assert.throws(() => Funder.debtByFunder(report, [], '2026-09-29'), RangeError);
  assert.throws(() => Funder.debtByFunder(report, [], 'garbage'), RangeError);
});

/* ============================ Code.gs: schema + lists ============================ */

test('Code.gs: FunderHistory header order is pinned (append-only); text-forced date columns', () => {
  const { C } = loadGs();
  assert.equal(C.FUNDER_HISTORY_SHEET, 'FunderHistory');
  assert.deepStrictEqual(C.FUNDER_HISTORY_COLUMNS, FUNDER_HEADER);
  assert.match(GS_SRC, /if \(name === FUNDER_HISTORY_SHEET\) \{\s*forceColumnsText_\(sh, FUNDER_HISTORY_COLUMNS, FUNDER_HISTORY_TEXT_COLUMNS\);/);
  assert.match(GS_SRC, /const FUNDER_HISTORY_TEXT_COLUMNS = \[[^\]]*'effectiveFrom'[^\]]*'recordedAt'/);
});

test('Code.gs: setPatientFunder is known, PROXY_SECRET-gated (not open), a finance action on both sides, not a delete', () => {
  const { C } = loadGs();
  assert.ok(C.PROXY_KNOWN_ACTIONS.includes('setPatientFunder'));
  assert.ok(!C.OPEN_ACTIONS.includes('setPatientFunder'));
  assert.ok(C.FINANCE_ACTIONS.includes('setPatientFunder'));
  assert.ok(scope.FINANCE_ACTIONS.includes('setPatientFunder'), 'lib/finance-scope.js (server.js 403)');
  assert.ok(scope.isFinanceAction('setPatientFunder'));
  assert.deepStrictEqual(C.GETDATA_FINANCE_KEYS, [...scope.GETDATA_FINANCE_KEYS]);
  assert.ok(scope.GETDATA_FINANCE_KEYS.includes('funderHistory'));
  assert.ok(!C.DELETE_ACTIONS.includes('setPatientFunder') && !C.APPROVER_ACTIONS.includes('setPatientFunder'));
});

/* ============================ Code.gs: validation ============================ */

test('Code.gs funderPayloadCheck_: strict funder key, strict real yyyy-MM-dd, at most 1 day ahead, a patient id', () => {
  const { sandbox } = loadGs();
  const chk = (p) => plain(sandbox.funderPayloadCheck_(p, '2026-09-30'));
  const ok = { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' };
  assert.deepStrictEqual(chk(ok), { ok: true, patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' });
  assert.equal(chk(Object.assign({}, ok, { effectiveFrom: '2026-10-01' })).ok, true, 'tomorrow is allowed');
  assert.equal(chk(Object.assign({}, ok, { effectiveFrom: '2020-01-01' })).ok, true, 'any past day');
  assert.equal(chk(Object.assign({}, ok, { effectiveFrom: '2026-10-02' })).error, 'future_effectiveFrom');
  for (const k of BAD_KEYS) assert.equal(chk(Object.assign({}, ok, { funder: k })).error, 'bad_funder', JSON.stringify(k));
  for (const d of ['2026-02-30', '2026-13-01', '30/09/2026', '2026-9-1', '2026-09-01T00:00:00Z', ' 2026-09-01', '', null, 20260901, {}]) {
    assert.equal(chk(Object.assign({}, ok, { effectiveFrom: d })).error, 'bad_effectiveFrom', JSON.stringify(d));
  }
  for (const id of ['', '   ', null, 7, 'x'.repeat(201)]) assert.equal(chk(Object.assign({}, ok, { patientId: id })).error, 'missing_patientId', JSON.stringify(id));
  for (const p of [null, undefined, 'btl', [], 3]) assert.equal(chk(p).error, 'missing_funder');
});

/* ============================ Code.gs: the write ============================ */

test('setPatientFunder: appends one row (text format first), recordedBy from the session, never the body', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  const res = setFunder(g, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-15', recordedBy: 'זייף', id: 'evil', recordedAt: '1999' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepStrictEqual(res.entry, {
    id: 'fh-u1', patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-15', recordedAt: NOW, recordedBy: 'ורד',
  });
  assert.deepStrictEqual(g.grids.FunderHistory, [FUNDER_HEADER, ['fh-u1', 'id-aaa', 'btl', '2026-09-15', NOW, 'ורד']]);
  const iFmt = g.log.indexOf('FunderHistory.setNumberFormat@2:@');
  const iVal = g.log.indexOf('FunderHistory.setValues@2');
  assert.ok(iFmt >= 0 && iVal > iFmt, 'the row is text-formatted before the value lands');
  assert.ok(g.log.includes('tryLock') && g.log.includes('releaseLock'));
  // a body `user` cannot impersonate
  const g2 = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  assert.equal(setFunder(g2, { patientId: 'id-aaa', funder: 'mod', effectiveFrom: '2026-09-15' }, (x) => asVered(Object.assign({}, x, { user: 'סנדרה' }))).entry.recordedBy, 'ורד');
});

test('setPatientFunder: a correction is a NEW row — the earlier row is never edited or deleted', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  assert.equal(setFunder(g, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' }).ok, true);
  const first = g.grids.FunderHistory[1].slice();
  assert.equal(setFunder(g, { patientId: 'id-aaa', funder: 'mod', effectiveFrom: '2026-09-01' }).ok, true);
  assert.equal(g.grids.FunderHistory.length, 3);
  assert.deepStrictEqual(g.grids.FunderHistory[1], first, 'row 2 untouched');
  assert.equal(g.grids.FunderHistory[2][2], 'mod');
  assert.ok(!g.log.some((l) => /FunderHistory\.(setValues|setValue)@2$/.test(l) && g.log.indexOf(l) > g.log.lastIndexOf('FunderHistory.setValues@2')));
  assert.equal(g.log.filter((l) => l === 'FunderHistory.setValues@2').length, 1);
  assert.ok(!g.log.some((l) => /deleteRow/.test(l)));
  // read back through getData + funder.js: the correction is ordered by sheet
  // position on an identical recordedAt (frozen clock) → mod
  const data = g.post(asVered({ action: 'getData' }));
  assert.equal(Funder.funderAt(data.funderHistory, 'id-aaa', '2026-09-01'), 'mod');
});

test('setPatientFunder: refused cases write NOTHING (bad payload, unknown patient, lock busy, restricted actor, enforce without secret)', () => {
  const cases = [
    [{}, { patientId: 'id-aaa', funder: 'Btl', effectiveFrom: '2026-09-01' }, 'bad_funder'],
    [{}, { patientId: 'id-aaa', funder: 'ביטוח לאומי', effectiveFrom: '2026-09-01' }, 'bad_funder'],
    [{}, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-10-05' }, 'future_effectiveFrom'],
    [{}, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-02-30' }, 'bad_effectiveFrom'],
    [{}, { patientId: 'id-zzz', funder: 'btl', effectiveFrom: '2026-09-01' }, 'unknown_patient'],
    [{}, { patientId: '=HYPERLINK("x")', funder: 'btl', effectiveFrom: '2026-09-01' }, 'unknown_patient'],
    [{ lockBusy: true }, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' }, 'lock_busy'],
  ];
  for (const [opts, payload, error] of cases) {
    const g = loadGs(Object.assign({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } }, opts));
    const res = setFunder(g, payload);
    assert.deepStrictEqual([res.ok, res.error], [false, error], JSON.stringify(payload));
    assert.deepStrictEqual(writes(g), [], error);
  }
  // no Patients tab at all → unknown_patient
  const empty = loadGs({ props: { PROXY_SECRET: PROXY } });
  assert.equal(setFunder(empty, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' }).error, 'unknown_patient');
  assert.deepStrictEqual(writes(empty), []);
  // the restricted view (Shiran / Yael): refused before any read or write
  const r = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  assert.equal(setFunder(r, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' }, asShiran).error, 'forbidden');
  assert.deepStrictEqual(writes(r), []);
  assert.ok(!r.log.includes('tryLock'));
  // enforce mode without a valid secret → unauthorized; a wrong secret too
  for (const secret of [undefined, 'wrong']) {
    const e = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' }, grids: { Patients: PATIENTS_GRID } });
    const body = { action: 'setPatientFunder', user: 'ורד', funder: { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' } };
    if (secret) body.proxySecret = secret;
    assert.deepStrictEqual(e.post(body), { ok: false, error: 'unauthorized' });
    assert.deepStrictEqual(writes(e), []);
  }
});

test('setPatientFunder: no console / Logger line carries patient data', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  setFunder(g, { patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-09-01' });
  setFunder(g, { patientId: 'id-zzz', funder: 'btl', effectiveFrom: '2026-09-01' });
  setFunder(g, { patientId: 'id-aaa', funder: 'nope', effectiveFrom: '2026-09-01' });
  const all = g.consoleLines.join('\n');
  for (const s of ['id-aaa', 'id-zzz', 'בדיקה', 'ורד', '2026-09-01']) assert.ok(!all.includes(s), s);
  // and the function body has no logging call at all
  const body = GS_SRC.slice(GS_SRC.indexOf('function setPatientFunder_('), GS_SRC.indexOf('function normalizeFunderHistoryRow_('));
  assert.ok(!/console\.|Logger\.|logAudit_/.test(body));
});

test('Code.gs: FunderHistory has exactly one writer, and it only appends', () => {
  const writers = GS_SRC.match(/getOrCreateSheet_\(FUNDER_HISTORY_SHEET/g) || [];
  assert.equal(writers.length, 1);
  const body = GS_SRC.slice(GS_SRC.indexOf('function setPatientFunder_('), GS_SRC.indexOf('function normalizeFunderHistoryRow_('));
  assert.match(body, /const target = sh\.getLastRow\(\) \+ 1;/);
  assert.ok(!/deleteRow|deleteRows|clear\(|insertRow/.test(body));
});

/* ============================ Code.gs: getData ============================ */

test('getData.funderHistory: rows normalized (a Date-typed effectiveFrom → its Israel day); a missing tab → [] and is NOT created', () => {
  const grid = [FUNDER_HEADER,
    ['fh-1', 'id-aaa', 'private', '2026-07-01', '2026-07-01T08:00:00.000Z', 'ורד'],
    ['fh-2', 'id-aaa', 'btl', new Date(2026, 7, 15), new Date('2026-08-15T06:00:00Z'), 'סנדרה'],   // Sheets coerced both
  ];
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID, FunderHistory: grid } });
  const data = g.post(asVered({ action: 'getData' }));
  assert.equal(data.ok, true);
  assert.deepStrictEqual(data.funderHistory, [
    { id: 'fh-1', patientId: 'id-aaa', funder: 'private', effectiveFrom: '2026-07-01', recordedAt: '2026-07-01T08:00:00.000Z', recordedBy: 'ורד' },
    { id: 'fh-2', patientId: 'id-aaa', funder: 'btl', effectiveFrom: '2026-08-15', recordedAt: '2026-08-15T06:00:00.000Z', recordedBy: 'סנדרה' },
  ]);
  assert.equal(Funder.funderAt(data.funderHistory, 'id-aaa', '2026-08-14'), 'private');
  assert.equal(Funder.funderAt(data.funderHistory, 'id-aaa', '2026-08-15'), 'btl');

  const fresh = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID } });
  assert.deepStrictEqual(fresh.post(asVered({ action: 'getData' })).funderHistory, []);
  assert.ok(!fresh.log.includes('insertSheet:FunderHistory'), 'a read never creates the tab');
});

test('getData: funderHistory is dropped for a restricted actor (finance key), kept for full view', () => {
  const grid = [FUNDER_HEADER, ['fh-1', 'id-aaa', 'private', '2026-07-01', '2026-07-01T08:00:00.000Z', 'ורד']];
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, grids: { Patients: PATIENTS_GRID, FunderHistory: grid } });
  assert.ok('funderHistory' in g.post(asVered({ action: 'getData' })));
  const restricted = g.post(asShiran({ action: 'getData' }));
  assert.equal(restricted.ok, true);
  assert.ok(!('funderHistory' in restricted) && !('billingOverrides' in restricted));
  assert.deepStrictEqual(scope.stripFinanceKeys({ ok: true, funderHistory: [], billingOverrides: [], leads: [] }), { ok: true, leads: [] });
});

/* ============================ zero browser-visible change ============================ */

/* PR 1 shipped funder.js unloaded; PR 2 (patient-funder-ui) wires it in. The
 * wiring itself is tested in test/patient-funder-ui.test.js. */
test('funder.js is served (server.js route) and loaded before app.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const f = html.indexOf('<script src="funder.js?v=__BUILD__"></script>');
  assert.ok(f > 0 && f < html.indexOf('<script src="app.js?v=__BUILD__"></script>'));
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /app\.get\('\/funder\.js', sendStatic\('funder\.js', 'application\/javascript'\)\)/);
});
