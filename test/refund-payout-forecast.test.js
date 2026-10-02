/* Refund payout forecast — action=refundPayoutForecast + the גבייה payout view.
 * See CHANGELOG-refund-payout-forecast.md.
 *
 * Locked contracts:
 *   - decided: pending saved credits with amount > 0, grouped by the STORED
 *     payoutDate — never recomputed (an old-15th-cutoff date stays as stored);
 *   - awaiting_decision: discharges on/after the records cutoff (2026-07-01)
 *     with NO saved credit for that stay and a server suggestion > 0; the
 *     payoutDate is "if decided today" (cutoff on the 10th);
 *   - missing_payment_data: no saved credit and no recorded payment covering
 *     the exit cycle — carries NO amount, never a 0;
 *   - a discharge the rules refuse (unknown house) is `unresolved`, never 0;
 *   - the three sections are never summed together;
 *   - read-only; gated by PROXY_SECRET (not open), listed as a known action;
 *   - getData keeps its keys;
 *   - the CSV: UTF-8 BOM, Hebrew headers, formula-guarded cells, labelled
 *     sections, a generated-at line;
 *   - the UI escapes everything and shows loading / error states.
 *
 * vm-sandbox on the REAL shipped Code.gs / app.js, per repo convention. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));
const PROXY = 'proxy-secret-for-tests';
const DISCHARGED = 'מטופלים משוחררים';

/* ======================= Code.gs harness ======================= */

function fakeSheet(grid) {
  return {
    grid,
    getName: () => 'sheet',
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {}, hideSheet() {}, isSheetHidden() { return false; },
    appendRow(row) { grid.push(row.slice()); },
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
        clearContent() {},
      };
    },
  };
}

function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function loadGs(o) {
  const opts = o || {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, Error, isNaN, isFinite,
    Logger: { log: noop },
    __sheets: {}, __inserted: [], __props: Object.assign({}, opts.props || {}), __cache: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      getSheets: () => Object.values(sandbox.__sheets),
      insertSheet: (n) => { sandbox.__inserted.push(n); return (sandbox.__sheets[n] = fakeSheet([])); },
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null), setProperty() { return this; } }),
  };
  sandbox.CacheService = { getScriptCache: () => ({ get: (k) => sandbox.__cache[k] || null, put: (k, v) => { sandbox.__cache[k] = v; } }) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
  sandbox.ContentService = { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } };
  sandbox.Utilities = {
    getUuid: () => 'uuid',
    formatDate: (d, tz, fmt) => {
      if (opts.today && fmt === 'yyyy-MM-dd' && tz === 'Asia/Jerusalem' && Math.abs(Date.now() - d.getTime()) < 60000) return opts.today;
      if (fmt === 'yyyy-MM-dd') return formatInTz(d, tz || 'Asia/Jerusalem');
      return d.toISOString();
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__t = {
      PAYMENT_COLUMNS, CREDIT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, OPEN_ACTIONS, PROXY_KNOWN_ACTIONS,
      handle: (p) => handle_(p).json,
      post: (body) => doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).json,
    };`, sandbox);
  const t = sandbox.__t;
  const put = (name, cols, rows) => {
    const c = Array.from(cols);
    sandbox.__sheets[name] = fakeSheet([c.slice()].concat(rows.map((r) => c.map((k) => (r[k] === undefined ? '' : r[k])))));
  };
  const g = {
    t, sandbox,
    setPayments: (rows) => put('Payments', t.PAYMENT_COLUMNS, rows),
    setCredits: (rows) => put('Credits', t.CREDIT_COLUMNS, rows),
    setDischarged: (rows) => put(DISCHARGED, t.DISCHARGED_PATIENT_COLUMNS, rows),
    snapshot: () => JSON.stringify(Object.keys(sandbox.__sheets).sort().map((k) => [k, sandbox.__sheets[k].grid])),
    forecast: () => plain(t.handle({ action: 'refundPayoutForecast' })),
  };
  g.setPayments([]); g.setCredits([]); g.setDischarged([]);
  return g;
}

const keyOf = (h, n, e) => `${h}::${n}::${e}`;
function payRow(key, over) {
  return Object.assign({
    id: 'pay::' + key + '::' + over.dueDate, patientId: key, patientName: key.split('::')[1], houseId: key.split('::')[0],
    amount: 30000, status: 'paid', amountPaid: 30000, balance: 0,
  }, over);
}
let auditSeq = 0;
function dis(houseId, name, entry, exit, over) {
  return Object.assign({ id: 'dis-' + (++auditSeq), houseId, name, date: entry, exitDate: exit, status: 'released', restored: '' }, over || {});
}
function credit(over) {
  return Object.assign({
    id: 'credit::pt::2026-09::1', patientId: 'pt', patientKey: 'ramot::דנה::2026-09-10', patientName: 'דנה', houseId: 'ramot',
    facilityType: 'residential', creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 5000, amount: 5000,
    overrideReason: '', reason: '', approvedBy: '', decidedDate: '2026-10-01', payoutDate: '2026-10-15', status: 'pending',
    paidDate: '', method: '', notes: '', basis: '{"basisVersion":2,"rule":"residential_prorata"}',
  }, over);
}

/* ======================= A. decided ======================= */

test('A: decided uses the STORED payoutDate as-is, grouped, with totals per date and per house', () => {
  const g = loadGs({ today: '2026-10-01' });
  g.setCredits([
    // decided on the 14th under the old 15th cutoff: stored 2026-09-15 — the 10th cutoff would say 2026-10-15
    credit({ id: 'c1', patientKey: 'ramot::דנה::2026-08-01', decidedDate: '2026-09-14', payoutDate: '2026-09-15', amount: 4800 }),
    // a stored date nothing would compute today — still reported as stored
    credit({ id: 'c2', patientKey: 'rehab::רון::2026-09-01', patientName: 'רון', houseId: 'rehab', decidedDate: '2026-10-01',
      payoutDate: '2026-12-15', amount: 17000, overrideReason: 'אישור סנדרה', basis: '{"basisVersion":2,"rule":"detox_prorata"}' }),
    credit({ id: 'c3', patientKey: 'ramot::גל::2026-08-05', patientName: 'גל', decidedDate: '2026-09-02', payoutDate: '2026-09-15', amount: 1200 }),
    credit({ id: 'paid', patientKey: 'ramot::א::2026-08-01', status: 'paid', paidDate: '2026-09-15', method: 'העברה', amount: 900 }),
    credit({ id: 'cancelled', patientKey: 'ramot::ב::2026-08-01', status: 'cancelled', amount: 900 }),
    credit({ id: 'zero', patientKey: 'ramot::ג::2026-08-01', amount: 0, calculatedAmount: 0 }),
  ]);
  const res = g.forecast();
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const d = res.decided;
  assert.deepStrictEqual(d.byPayoutDate.map((x) => [x.payoutDate, x.count, x.total]), [['2026-09-15', 2, 6000], ['2026-12-15', 1, 17000]]);
  const c1 = d.byPayoutDate[0].rows.find((r) => r.creditId === 'c1');
  assert.deepStrictEqual([c1.payoutDate, c1.decidedDate, c1.amount, c1.patientName, c1.houseId, c1.rule],
    ['2026-09-15', '2026-09-14', 4800, 'דנה', 'ramot', 'residential_prorata']);
  const c2 = d.byPayoutDate[1].rows[0];
  assert.deepStrictEqual([c2.payoutDate, c2.overrideReason, c2.rule], ['2026-12-15', 'אישור סנדרה', 'detox_prorata']);
  assert.deepStrictEqual(d.byHouse.map((h) => [h.houseId, h.count, h.total]), [['ramot', 2, 6000], ['rehab', 1, 17000]]);
  assert.strictEqual(d.total, 23000);
  assert.strictEqual(d.count, 3, 'paid, cancelled and zero-amount credits are not in decided');
});

/* ======================= B. awaiting_decision ======================= */

test('B: awaiting excludes a discharge with a saved credit (even a zero one) and excludes 0 suggestions', () => {
  const g = loadGs({ today: '2026-10-01' });
  const kA = keyOf('ramot', 'אבי', '2026-09-10');   // exit 28/09 → 11000, no credit → awaiting
  const kB = keyOf('ramot', 'בני', '2026-09-10');   // same figure, but a saved credit → excluded
  const kC = keyOf('ramot', 'כרמל', '2026-09-10');  // a saved ZERO credit → excluded
  const kD = keyOf('ramot', 'דור', '2026-09-10');   // exit in the last 7 days → 0 by policy → excluded
  g.setPayments([
    payRow(kA, { dueDate: '2026-09-10' }), payRow(kB, { dueDate: '2026-09-10' }),
    payRow(kC, { dueDate: '2026-09-10' }), payRow(kD, { dueDate: '2026-09-10' }),
  ]);
  g.setDischarged([
    dis('ramot', 'אבי', '2026-09-10', '2026-09-28'), dis('ramot', 'בני', '2026-09-10', '2026-09-28'),
    dis('ramot', 'כרמל', '2026-09-10', '2026-09-28'), dis('ramot', 'דור', '2026-09-10', '2026-10-05'),
  ]);
  g.setCredits([
    credit({ id: 'cb', patientKey: kB, patientName: 'בני', amount: 11000 }),
    credit({ id: 'cc', patientKey: ' ' + kC.replace('כרמל', 'כרמל '), patientName: 'כרמל', amount: 0, calculatedAmount: 0 }),
  ]);
  const res = g.forecast();
  const a = res.awaiting_decision;
  assert.strictEqual(a.count, 1, JSON.stringify(a));
  const row = a.byPayoutDate[0].rows[0];
  assert.deepStrictEqual([row.patientName, row.houseId, row.exitDate, row.suggestedAmount, row.rule, row.payoutDate],
    ['אבי', 'ramot', '2026-09-28', 11000, 'residential_prorata', '2026-10-15']);
  assert.deepStrictEqual(a.byHouse.map((h) => [h.houseId, h.total]), [['ramot', 11000]]);
  assert.strictEqual(res.zeroByPolicyCount, 1, 'the data-backed 0 is counted, not listed');
  assert.strictEqual(res.missing_payment_data.count, 0, 'a data-backed 0 is not "missing data"');
  assert.strictEqual(res.decided.count, 1, 'only the >0 pending credit is decided');
});

test('B: a prepaid cycle counts — rehab exit on day 20 with the next month paid suggests the prepaid return', () => {
  const g = loadGs({ today: '2026-10-01' });
  const k = keyOf('rehab', 'רון', '2026-08-01');
  g.setPayments([payRow(k, { dueDate: '2026-08-01' }), payRow(k, { dueDate: '2026-09-01' })]);
  g.setDischarged([dis('rehab', 'רון', '2026-08-01', '2026-08-20')]);
  const a = g.forecast().awaiting_decision;
  assert.strictEqual(a.total, 30000);
  assert.strictEqual(a.byPayoutDate[0].rows[0].rule, 'prepaid_return');
});

/* ======================= C. missing_payment_data ======================= */

test('C: a discharge with no recorded payment is missing_payment_data — never reported as 0', () => {
  const g = loadGs({ today: '2026-10-01' });
  const kOld = keyOf('asher', 'עדי', '2026-07-05');
  g.setPayments([
    // only an EARLIER cycle was paid — nothing covers the exit cycle
    payRow(kOld, { dueDate: '2026-07-05' }),
    // a void row is not a payment
    payRow(keyOf('arfoni', 'ערן', '2026-09-09'), { dueDate: '2026-09-09', status: 'void' }),
  ]);
  g.setDischarged([
    dis('rehab', 'נועה', '2026-09-01', '2026-09-05'),        // no payment at all
    dis('asher', 'עדי', '2026-07-05', '2026-08-20'),          // exit cycle 05/08–04/09 unpaid
    dis('arfoni', 'ערן', '2026-09-09', '2026-09-12'),         // only a void row
  ]);
  const res = g.forecast();
  const m = res.missing_payment_data;
  assert.deepStrictEqual(m.rows.map((r) => r.patientName).sort(), ['ערן', 'נועה', 'עדי'].sort());
  for (const r of m.rows) {
    assert.strictEqual(r.note, 'אין תשלום רשום — לבדוק');
    for (const k of Object.keys(r)) assert.notStrictEqual(r[k], 0, `missing row field ${k} must never be 0`);
    assert.ok(!('suggestedAmount' in r) && !('amount' in r), 'a missing row carries no amount');
  }
  assert.strictEqual(res.awaiting_decision.count, 0);
  assert.strictEqual(res.zeroByPolicyCount, 0);
});

test('C: an unknown house is unresolved with its error code — never 0, never awaiting', () => {
  const g = loadGs({ today: '2026-10-01' });
  g.setDischarged([dis('nowhere', 'טל', '2026-09-01', '2026-09-05'), dis('ramot', 'בלי', '', '2026-09-05')]);
  const res = g.forecast();
  assert.deepStrictEqual(res.unresolved.rows.map((r) => [r.patientName, r.error]).sort(), [['בלי', 'bad_date'], ['טל', 'unknown_house']]);
  assert.strictEqual(res.awaiting_decision.count + res.missing_payment_data.count, 0);
});

/* ======================= D. records cutoff, restored, sections ======================= */

test('D: the records cutoff — an exit before 2026-07-01 is excluded, on 2026-07-01 included', () => {
  const g = loadGs({ today: '2026-10-01' });
  g.setDischarged([dis('rehab', 'לפני', '2026-06-01', '2026-06-30'), dis('rehab', 'ביום', '2026-06-25', '2026-07-01')]);
  const res = g.forecast();
  assert.strictEqual(res.recordsCutoff, '2026-07-01');
  const names = res.missing_payment_data.rows.map((r) => r.patientName)
    .concat(res.awaiting_decision.byPayoutDate.flatMap((x) => x.rows.map((r) => r.patientName)));
  assert.deepStrictEqual(names, ['ביום']);
});

test('D: a restored discharge is not a discharge', () => {
  const g = loadGs({ today: '2026-10-01' });
  g.setDischarged([dis('rehab', 'חזר', '2026-09-01', '2026-09-05', { restored: 'TRUE' }), dis('rehab', 'חזר2', '2026-09-01', '2026-09-05', { restored: true })]);
  const res = g.forecast();
  assert.strictEqual(res.missing_payment_data.count + res.awaiting_decision.count + res.unresolved.count, 0);
});

test('D: the three sections are never summed — no grand total across them', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = g.forecast();
  for (const k of ['grandTotal', 'total', 'sum', 'allTotal']) assert.ok(!(k in res), 'no top-level ' + k);
  assert.ok(!('total' in res.missing_payment_data), 'missing data has no money total');
});

/* ======================= E. payout date if decided today ======================= */

test('E: pending payoutDate if decided today — the 10th gives this month\'s 15th, the 11th the next month\'s', () => {
  for (const [today, want] of [['2026-10-10', '2026-10-15'], ['2026-10-11', '2026-11-15'], ['2026-12-11', '2027-01-15']]) {
    const g = loadGs({ today });
    const k = keyOf('ramot', 'אבי', '2026-09-10');
    g.setPayments([payRow(k, { dueDate: '2026-09-10' })]);
    g.setDischarged([dis('ramot', 'אבי', '2026-09-10', '2026-09-28')]);
    const res = g.forecast();
    assert.strictEqual(res.today, today);
    assert.strictEqual(res.payoutDateIfDecidedToday, want, today);
    assert.deepStrictEqual(res.awaiting_decision.byPayoutDate.map((x) => x.payoutDate), [want], today);
  }
});

/* ======================= F. read-only, gate, getData ======================= */

test('F: refundPayoutForecast is read-only — no sheet created, no cell written (with and without the tabs)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const k = keyOf('ramot', 'אבי', '2026-09-10');
  g.setPayments([payRow(k, { dueDate: '2026-09-10' })]);
  g.setDischarged([dis('ramot', 'אבי', '2026-09-10', '2026-09-28')]);
  g.setCredits([credit({})]);
  const before = g.snapshot();
  assert.strictEqual(g.forecast().ok, true);
  assert.strictEqual(g.snapshot(), before);
  assert.deepStrictEqual(g.sandbox.__inserted, []);
  const empty = loadGs({ today: '2026-10-01' });
  empty.sandbox.__sheets = {};
  const res = empty.forecast();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(empty.sandbox.__inserted, [], 'never creates a missing tab');
  assert.deepStrictEqual(Object.keys(empty.sandbox.__sheets), []);
});

test('F: the action is refused without PROXY_SECRET in enforce mode; not open; a known action', () => {
  const en = loadGs({ today: '2026-10-01', props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const body = { action: 'refundPayoutForecast' };
  assert.deepStrictEqual(plain(en.t.post(body)), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(plain(en.t.post(Object.assign({ proxySecret: 'wrong' }, body))), { ok: false, error: 'unauthorized' });
  const ok = plain(en.t.post(Object.assign({ proxySecret: PROXY, proxyUser: 'ורד' }, body)));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.ok(!Array.from(en.t.OPEN_ACTIONS).includes('refundPayoutForecast'));
  assert.ok(Array.from(en.t.PROXY_KNOWN_ACTIONS).includes('refundPayoutForecast'));
});

test('F: getData keeps its keys (the forecast adds nothing to it)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = plain(g.t.handle({ action: 'getData' }));
  assert.deepStrictEqual(Object.keys(res).sort(), [
    'billingOverrides', 'currentManagers', 'currentManagersSource', 'dischargedPatients', 'houseManagers',
    'irrelevantLeads', 'leads', 'managerPhones', 'ok', 'patients', 'removedLeads',
  ]);
});

/* ======================= app.js harness ======================= */

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '', value: '', hidden: false,
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {}, click() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function loadApp(server) {
  const sent = [];
  const els = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      getElementById: (id) => (els[id] = els[id] || fakeEl()),
      createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Intl, Set, Map,
    setTimeout, clearTimeout,
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      sent.push(body);
      let payload;
      try { payload = plain(server(body)); } catch (e) { return Promise.reject(e); }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    showError = (m) => { globalThis.__errors.push(String(m)); };
    globalThis.__errors = [];
    globalThis.__t = { state, payoutForecastHtml, renderPayoutForecast, loadPayoutForecast, saveCredit };`, sandbox);
  return { t: sandbox.__t, sent: () => sent.map(plain), els, errors: () => Array.from(sandbox.__errors) };
}

function sampleForecast(g) {
  const k = keyOf('ramot', '=HYPERLINK("http://x")', '2026-09-10');
  g.setPayments([payRow(k, { dueDate: '2026-09-10' })]);
  g.setDischarged([
    dis('ramot', '=HYPERLINK("http://x")', '2026-09-10', '2026-09-28'),
    dis('rehab', '<img src=x onerror=alert(1)>', '2026-09-01', '2026-09-05'),
    dis('rehab', '+972-50', '2026-09-02', '2026-09-06'),
  ]);
  g.setCredits([credit({ patientName: '@SUM(A1)', overrideReason: '-2+3', payoutDate: '2026-09-15', decidedDate: '2026-09-14' })]);
  return g.forecast();
}

/* ======================= G. .xlsx export ======================= */
/* The CSV is gone (CHANGELOG-xlsx-export.md). The real Code.gs forecast goes
 * through the server-side .xlsx builder; the full format checks live in
 * test/xlsx-export.test.js. */

test('G: xlsx — the real forecast becomes four guarded sheets; no-payment discharges are a count only', async () => {
  const ExcelJS = require('exceljs');
  const { buildXlsxReport } = require('../lib/xlsx-report');
  const { buildRefundForecastSpec, isForecastResponse } = require('../lib/refund-forecast-xlsx');
  const g = loadGs({ today: '2026-10-01' });
  const data = plain(sampleForecast(g));
  assert.ok(isForecastResponse(data), 'the Code.gs response passes the server shape check');
  const buf = await buildXlsxReport(buildRefundForecastSpec(data, new Date('2026-10-01T06:30:00Z')));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  // A discharge with no recorded payment is DEBT (CHANGELOG-billing-tab-section-colors.md):
  // no sheet for it — only a count line in «סיכום».
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['סיכום', 'הוחלט', 'ממתין להחלטה', 'לא ניתן לחשב']);
  const texts = [];
  wb.worksheets.forEach((ws) => ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') texts.push(c.value); })));
  for (const t of texts) assert.ok(!/^[=+\-@\t\r]/.test(t), 'unguarded cell: ' + t);
  assert.ok(texts.includes(`'=HYPERLINK("http://x")`) && texts.includes(`'@SUM(A1)`) && texts.includes(`'-2+3`));
  assert.ok(texts.includes('הופק ב־01/10/2026 09:30'));
  assert.strictEqual(data.missing_payment_data.count, 2);
  let line = null;
  wb.getWorksheet('סיכום').eachRow((row) => { if (row.getCell(1).value === 'משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״') line = row; });
  assert.ok(line, 'the count line is in «סיכום»');
  assert.strictEqual(line.getCell(2).value, 2, 'its count');
  assert.ok(line.getCell(3).value === null || line.getCell(3).value === undefined, 'no amount next to it');
  for (const name of ['<img src=x onerror=alert(1)>', "'+972-50", '+972-50']) assert.ok(!texts.includes(name), 'not listed: ' + name);
});

/* ======================= H. UI ======================= */

test('H: the forecast HTML — the awaiting label, everything escaped; no-payment discharges are one count line', () => {
  const g = loadGs({ today: '2026-10-01' });
  const data = sampleForecast(g);
  const app = loadApp(() => ({}));
  const html = app.t.payoutForecastHtml(data);
  assert.ok(html.includes('ממתין להחלטה — לא לתשלום'));
  // No section for them any more — one muted line that opens «חובות פתוחים».
  assert.ok(!html.includes('חסרים נתוני תשלום'));
  assert.ok(html.includes('<p class="forecast-missing-line"><a href="#debt-aging-view" data-open-debt-aging>2 משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״</a></p>'));
  assert.ok(!html.includes('<img'), 'patient text is escaped');
  assert.ok(!html.includes('onerror'), 'the no-payment patients are not listed here');
  assert.ok(html.includes('=HYPERLINK(&quot;http://x&quot;)'));
  const line = html.slice(html.indexOf('forecast-missing-line'), html.indexOf('</p>', html.indexOf('forecast-missing-line')));
  assert.ok(!/₪/.test(line), 'the line carries no amount');
  // count 0 → no line at all
  const none = app.t.payoutForecastHtml(Object.assign({}, data, { missing_payment_data: { count: 0, rows: [] } }));
  assert.ok(!none.includes('forecast-missing-line'));
});

test('H: loading then rendered; an error is shown explicitly, never a silent empty list', async () => {
  const g = loadGs({ today: '2026-10-01' });
  sampleForecast(g);
  const app = loadApp((body) => g.t.handle(body));
  app.t.state.currentScreen = 'billing';
  app.t.renderPayoutForecast();
  assert.ok(app.els['credits-forecast'].innerHTML.includes('טוען תחזית החזרים'), 'loading state');
  await app.t.state.payoutForecast.promise;
  assert.strictEqual(app.t.state.payoutForecast.status, 'ok');
  assert.ok(app.els['credits-forecast'].innerHTML.includes('ממתין להחלטה — לא לתשלום'));
  assert.deepStrictEqual(app.sent().map((b) => b.action), ['refundPayoutForecast']);

  const bad = loadApp(() => ({ ok: false, error: 'unauthorized' }));
  bad.t.state.currentScreen = 'billing';
  await bad.t.loadPayoutForecast();
  const box = bad.els['credits-forecast'].innerHTML;
  assert.ok(box.includes('טעינת תחזית ההחזרים נכשלה') && box.includes('אין להסיק שהן ריקות'), box);
  assert.ok(bad.errors().some((e) => e.includes('טעינת תחזית ההחזרים נכשלה')));
});

test('H: not fetched off the גבייה screen; a credit save marks it stale', async () => {
  const g = loadGs({ today: '2026-10-01' });
  const app = loadApp((body) => g.t.handle(body));
  app.t.renderPayoutForecast();
  assert.deepStrictEqual(app.sent(), [], 'no request while another screen is shown');
  app.t.state.currentScreen = 'billing';
  await app.t.loadPayoutForecast();
  assert.strictEqual(app.t.state.payoutForecast.status, 'ok');
  app.t.state.mode = 'edit';
  await app.t.saveCredit({ patientId: 'pt', patientKey: 'ramot::דנה::2026-09-10', patientName: 'דנה', houseId: 'ramot',
    creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 100, amount: 100, decidedDate: '2026-10-01', basis: {} });
  assert.strictEqual(app.t.state.payoutForecast.status, 'idle', 'stale after a saved credit');
});

test('H: index.html extends the existing payout section — no second view', () => {
  const at = (s) => HTML_SRC.indexOf(s);
  assert.strictEqual(HTML_SRC.split('id="credits-payout-list"').length, 2, 'one payout list');
  assert.ok(at('id="credits-payout-list"') < at('id="credits-forecast"'), 'the forecast sits under the existing list');
  assert.ok(at('id="credits-forecast"') < at('<h3>סיכום חודשי</h3>'), 'inside the same block');
  assert.ok(HTML_SRC.includes('id="credits-forecast-export"') && HTML_SRC.includes('ייצוא זיכויים לאקסל'));
});
