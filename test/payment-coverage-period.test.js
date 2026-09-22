/* תקופת כיסוי — the recorded coverage period on a payment row.
 *
 * THE PROBLEM THIS CLOSES. A payment's coverage period used to be INFERRED:
 * the patient's entry day-of-month, plus an assumption of one month paid in
 * advance. Nothing recorded what the money actually bought, so when the
 * assumption was wrong the revenue landed in the wrong month and no screen
 * could say so. coverageStart / coverageEnd make the period an explicit fact
 * on the row.
 *
 * Locked contracts:
 *   - PAYMENT_COLUMNS gains coverageStart + coverageEnd AT THE END; the
 *     original ten keep their positions (readSheet_ maps by position);
 *   - paymentCoverage() is still the ONE window function, now answering from
 *     the recorded period when the row has one and the inferred cycle when it
 *     does not — so the credits ledger, the monthly revenue screen and the
 *     גבייה row editor cannot disagree;
 *   - NOTHING IS BACKFILLED: a row with blank coverage cells reads exactly as
 *     it did before this change, derived on read, never rewritten;
 *   - savePayment() stamps the inferred cycle as the DEFAULT on every write,
 *     so accepting it costs zero clicks and changes zero figures;
 *   - validation is shared client-side and enforced SERVER-side in
 *     upsertPayment_(): a half-filled pair, a malformed or impossible date, a
 *     backwards period and a span over 366 days are all refused with the
 *     reason surfaced; overlaps and gaps between rows are NOT refused;
 *   - no new endpoint, server.js untouched, everything interpolated escaped.
 *
 * TZ pinned to Asia/Jerusalem so the local-part assertions mean what they say.
 * vm-sandbox on the REAL shipped app.js / Code.gs, per repo convention.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

const arr = (x) => Array.from(x);

/* ================= app.js harness ================= */

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      paymentCoverage, recordedCoverage, inferredCoverage, coveragePeriodError,
      coverageDateISO,
      coverageDiffersFromDefault, withDefaultCoverage, COVERAGE_MAX_DAYS,
      normalizePayment, suggestCredits, buildMonthlyRevenue,
      patientKey, isoFromLocalDate, isoDate, roundMoney,
      // The display layer + the month split (this PR).
      coveragePeriodText, formatDate, splitByMonth, paymentMonthSplit,
      coverageSplitHtml, revenueAllocate, revenueMonthBounds, localDateFromISO,
      creditBasisText, escapeHtml,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();
const iso = (d) => app.isoFromLocalDate(d);

/** Extract one `function NAME(...) { ... }` body out of a source string. */
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* ================= Code.gs harness ================= */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() {},
    isSheetHidden() { return false; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
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
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc });
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

function loadCode() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty() { return this; } }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = { getUuid: () => 'uuid', formatDate: (d) => d.toISOString().slice(0, 10) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PAYMENT_COLUMNS, PAYMENTS_SHEET, PAYMENT_TEXT_COLUMNS, COVERAGE_MAX_DAYS,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    upsert: (p) => upsertPayment_(p),
    coveragePeriodError: (a, b) => coveragePeriodError_(a, b),
    coverageDateISO: (v) => coverageDateISO_(v),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

/* ================= fixtures ================= */

const PAT = {
  id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2025-06-20',
  pay: 3000, status: 'active', exitDate: '',
};
const KEY = app.patientKey(PAT);
function pay(over) {
  const dueDate = (over && over.dueDate) || '2026-01-20';
  return Object.assign({
    id: 'pay::' + KEY + '::' + dueDate,
    patientId: KEY, patientName: 'דנה כהן', houseId: 'arfoni',
    dueDate, amount: 3000, amountPaid: 3000, status: 'paid', balance: 0,
  }, over || {});
}
function build(over) {
  return app.buildMonthlyRevenue(Object.assign({
    month: '2026-01', patients: [PAT], payments: [], credits: [], overrides: [],
    today: '2026-01-15',
  }, over || {}));
}

/* ================= A. the schema is APPEND-ONLY ================= */

test('A: PAYMENT_COLUMNS appends the two coverage columns and moves nothing', () => {
  const { code } = loadCode();
  const cols = arr(code.PAYMENT_COLUMNS);
  assert.deepEqual(cols.slice(0, 10), [
    'id', 'patientId', 'patientName', 'houseId', 'dueDate',
    'amount', 'status', 'amountPaid', 'balance', 'timestamp',
  ], 'position IS the data contract — the original ten are untouched');
  assert.deepEqual(cols.slice(10), ['coverageStart', 'coverageEnd']);
  assert.equal(cols.length, 12);
});

test('A: the two new columns are text-forced at sheet-ensure, the old ones are left alone', () => {
  const { code, sandbox } = loadCode();
  const sh = code.ensure(code.PAYMENTS_SHEET, arr(code.PAYMENT_COLUMNS));
  assert.equal(sandbox.__sheets.Payments, sh);
  assert.deepEqual(sh.grid[0], arr(code.PAYMENT_COLUMNS));
  const cols = arr(code.PAYMENT_COLUMNS);
  const forced = sh.ops
    .filter((o) => o.op === 'fmt' && o.fmt === '@' && o.r === 1 && o.nr >= 1000)
    .map((o) => cols[o.c - 1]);
  /* Only the appended pair. A 'YYYY-MM-DD' in a date-TYPED cell reads back as
   * a Date, serializes as a UTC timestamp and drifts −1 day for Israel — here
   * that would move revenue between months. Re-formatting a LIVE column would
   * be a migration, so dueDate/timestamp keep whatever they have. */
  assert.deepEqual(forced.sort(), ['coverageEnd', 'coverageStart']);
  assert.deepEqual(arr(code.PAYMENT_TEXT_COLUMNS).slice().sort(), forced.sort());
});

/* ================= B. one primitive, two answers ================= */

test('B: with no recorded period the window is INFERRED, exactly as before', () => {
  const c = app.paymentCoverage({ dueDate: '2026-01-20' });
  assert.equal(iso(c.start), '2026-01-20');
  assert.equal(iso(c.end), '2026-02-19');
  assert.equal(c.source, 'inferred');
  // The month-length clamp the credits ledger has always relied on.
  assert.equal(iso(app.paymentCoverage({ dueDate: '2026-01-31' }).end), '2026-02-27');
  assert.equal(iso(app.paymentCoverage({ dueDate: '2024-01-31' }).end), '2024-02-28', 'leap year');
});

test('B: a recorded period WINS over the inference', () => {
  const c = app.paymentCoverage({
    dueDate: '2026-01-20', coverageStart: '2026-02-01', coverageEnd: '2026-02-28',
  });
  assert.equal(iso(c.start), '2026-02-01');
  assert.equal(iso(c.end), '2026-02-28');
  assert.equal(c.source, 'recorded');
});

test('B: a recorded period NEEDS NO due date — and no due date with no period is null', () => {
  const c = app.paymentCoverage({ dueDate: '', coverageStart: '2026-05-01', coverageEnd: '2026-05-31' });
  assert.equal(iso(c.start), '2026-05-01');
  assert.equal(app.paymentCoverage({ dueDate: '' }), null);
  assert.equal(app.paymentCoverage(null), null);
  assert.equal(app.paymentCoverage({}), null);
});

test('B: a HALF-filled or unusable stored pair falls back to the inference, never throws', () => {
  /* A cell mangled by a manual sheet edit must still produce a window — a
   * screen that renders nothing is worse than one that falls back and says
   * "inferred". */
  for (const bad of [
    { coverageStart: '2026-02-01', coverageEnd: '' },
    { coverageStart: '', coverageEnd: '2026-02-28' },
    { coverageStart: 'nonsense', coverageEnd: 'also nonsense' },
    { coverageStart: '2026-03-01', coverageEnd: '2026-02-01' },   // backwards
    { coverageStart: '2026-02-30', coverageEnd: '2026-03-05' },   // no such day
    { coverageStart: '2026-01-01', coverageEnd: '2027-06-01' },   // absurdly long
  ]) {
    const c = app.paymentCoverage(Object.assign({ dueDate: '2026-01-20' }, bad));
    assert.equal(c.source, 'inferred', JSON.stringify(bad) + ' must not be honoured');
    assert.equal(iso(c.start), '2026-01-20');
    assert.equal(app.recordedCoverage(Object.assign({ dueDate: '2026-01-20' }, bad)), null);
  }
});

test('B: a single-day period is legal; a zero-length one cannot be expressed', () => {
  // start === end is ONE day, not zero — the shortest honest period.
  const c = app.paymentCoverage({ dueDate: '2026-01-20', coverageStart: '2026-01-20', coverageEnd: '2026-01-20' });
  assert.equal(c.source, 'recorded');
  assert.equal(iso(c.start), iso(c.end));
  assert.equal(app.coveragePeriodError('2026-01-20', '2026-01-20'), '');
  // end before start is the only "zero or less", and it is refused.
  assert.match(app.coveragePeriodError('2026-01-21', '2026-01-20'), /מוקדם/);
});

test('B: the DST switches do not cost or gain a day', () => {
  // Israel springs forward in late March and falls back in late October;
  // diffWholeDays rounds the ±1h away, so the span count stays exact.
  assert.equal(app.coveragePeriodError('2026-03-01', '2026-04-30'), '');
  assert.equal(app.coveragePeriodError('2026-10-01', '2026-11-30'), '');
  const c = app.paymentCoverage({ coverageStart: '2026-03-20', coverageEnd: '2026-04-19' });
  assert.equal(iso(c.start), '2026-03-20');
  assert.equal(iso(c.end), '2026-04-19');
});

/* ================= C. the default, and the badge ================= */

test('C: withDefaultCoverage stamps the INFERRED cycle, so the default costs nothing', () => {
  const stamped = app.withDefaultCoverage(pay({ coverageStart: '', coverageEnd: '' }));
  assert.equal(stamped.coverageStart, '2026-01-20');
  assert.equal(stamped.coverageEnd, '2026-02-19');
  // And the stamped row produces the SAME window it would have inferred.
  const before = app.paymentCoverage(pay());
  const after = app.paymentCoverage(stamped);
  assert.equal(iso(before.start), iso(after.start));
  assert.equal(iso(before.end), iso(after.end));
});

test('C: withDefaultCoverage never overwrites a period somebody recorded', () => {
  const rec = pay({ coverageStart: '2026-03-01', coverageEnd: '2026-03-31' });
  assert.equal(app.withDefaultCoverage(rec).coverageStart, '2026-03-01');
  // Nothing to infer and nothing recorded → left exactly as it came.
  const orphan = { id: 'x', dueDate: '' };
  assert.deepEqual(app.withDefaultCoverage(orphan), orphan);
});

test('C: the "מותאמת" badge marks only a period that DIFFERS from the default', () => {
  assert.equal(app.coverageDiffersFromDefault(pay()), false, 'no recorded period → not adjusted');
  assert.equal(app.coverageDiffersFromDefault(
    pay({ coverageStart: '2026-01-20', coverageEnd: '2026-02-19' })), false,
    'recording exactly the default is not an adjustment — a badge on every row would mean nothing');
  assert.equal(app.coverageDiffersFromDefault(
    pay({ coverageStart: '2026-01-20', coverageEnd: '2026-02-20' })), true, 'one day out is out');
  assert.equal(app.coverageDiffersFromDefault(
    pay({ coverageStart: '2026-03-01', coverageEnd: '2026-03-31' })), true);
});

test('C: normalizePayment carries the pair through, and normalizes a timestamp to its LOCAL day', () => {
  const n = app.normalizePayment({
    id: 'x', dueDate: '2026-01-20', coverageStart: '2026-02-01', coverageEnd: '2026-02-28',
  });
  assert.equal(n.coverageStart, '2026-02-01');
  assert.equal(n.coverageEnd, '2026-02-28');
  // Blank stays blank — that is what "infer" looks like on the wire.
  const blank = app.normalizePayment({ id: 'x', dueDate: '2026-01-20' });
  assert.equal(blank.coverageStart, '');
  assert.equal(blank.coverageEnd, '');
  /* A Sheets date cell arrives as a UTC timestamp. isoDate() reads its LOCAL
   * parts: a naive .slice(0,10) would land on the 31st and move a month of
   * revenue. */
  const drifted = app.normalizePayment({
    id: 'x', dueDate: '2026-01-20',
    coverageStart: '2026-01-31T22:00:00.000Z', coverageEnd: '2026-02-28T22:00:00.000Z',
  });
  assert.equal(drifted.coverageStart, '2026-02-01');
  assert.equal(drifted.coverageEnd, '2026-03-01');
});

/* ================= D. NOTHING IS BACKFILLED ================= */

test('D: a historical row with blank coverage reads exactly as it did before', () => {
  /* The December + January worked example from the monthly-revenue suite,
   * with no coverage cells at all: ₪3,000 in January, from 19 December days
   * and 12 January ones. If the fallback had changed, this number moves. */
  const dec = pay({ dueDate: '2025-12-20', id: 'a' });
  const jan = pay({ dueDate: '2026-01-20', id: 'b' });
  const r = build({ payments: [dec, jan] });
  assert.equal(r.received.inclVat, 3000);
  const rows = r.received.rows.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  assert.equal(rows[0].daysInMonth, 19);
  assert.equal(rows[1].daysInMonth, 12);
  assert.equal(rows[0].coverageWindowSource, 'inferred');
  assert.equal(rows[0].coverageAdjusted, false);
});

test('D: reading a blank row WRITES nothing back to it — the input object is untouched', () => {
  const row = pay();
  const snapshot = JSON.stringify(row);
  app.paymentCoverage(row);
  app.recordedCoverage(row);
  app.coverageDiffersFromDefault(row);
  build({ payments: [row] });
  app.suggestCredits(PAT, '2026-02-01', [row]);
  assert.equal(JSON.stringify(row), snapshot,
    'derive on read — a historical row is never rewritten');
  // withDefaultCoverage is the one stamper, and it too returns a COPY.
  const stamped = app.withDefaultCoverage(row);
  assert.equal(JSON.stringify(row), snapshot, 'the stamper copies rather than mutating');
  assert.notEqual(stamped, row);
});

/* ================= E. all three consumers, one window ================= */

test('E: an edited period moves the REVENUE allocation and nothing else', () => {
  const base = pay();                                    // Jan 20 → Feb 19
  const moved = pay({ coverageStart: '2026-03-05', coverageEnd: '2026-04-04' });

  // Before: 20–31 January is 12 of the cycle's 31 days.
  assert.equal(build({ month: '2026-01', payments: [base] }).received.inclVat,
    app.roundMoney(3000 * 12 / 31));
  assert.equal(build({ month: '2026-01', payments: [moved] }).received.inclVat, 0,
    'the money no longer belongs to January');
  const mar = build({ month: '2026-03', payments: [moved] });
  assert.equal(mar.received.rows.length, 1);
  assert.equal(mar.received.rows[0].daysInMonth, 27, '5–31 March');
  assert.equal(mar.received.rows[0].windowDays, 31);
  assert.equal(mar.received.rows[0].coverageWindowSource, 'recorded');
  assert.equal(mar.received.rows[0].coverageAdjusted, true);
  const apr = build({ month: '2026-04', payments: [moved] });
  assert.equal(apr.received.rows[0].daysInMonth, 4, '1–4 April');
  // The row's own money is neither created nor destroyed by the move.
  assert.equal(app.roundMoney(mar.received.inclVat + apr.received.inclVat), 3000);
});

test('E: the ARITHMETIC is untouched — only where the window came from changed', () => {
  /* Same window, expressed two ways: inferred from the due date, and
   * recorded explicitly. Every figure must be identical. */
  const inferred = pay({ dueDate: '2026-01-20' });
  const recorded = pay({ dueDate: '2026-01-20', coverageStart: '2026-01-20', coverageEnd: '2026-02-19' });
  for (const month of ['2026-01', '2026-02']) {
    const a = build({ month, payments: [inferred] });
    const b = build({ month, payments: [recorded] });
    assert.equal(a.received.inclVat, b.received.inclVat, month + ' received');
    assert.equal(a.received.exVat, b.received.exVat, month + ' received ex-VAT');
    assert.equal(a.expected.inclVat, b.expected.inclVat, month + ' expected');
    assert.equal(a.net.inclVat, b.net.inclVat, month + ' net');
  }
});

test('E: the CREDITS ledger reads the same recorded window', () => {
  /* A payment recorded as covering all of March, and a discharge on 10 March.
   * The credit must be 21 unused days of the RECORDED window — not the 30 the
   * Jan-20 cycle would have inferred, and not zero. */
  const p = Object.assign({}, PAT, { houseId: 'ramot', date: '2026-01-20' });   // residential
  const row = Object.assign(pay({ coverageStart: '2026-03-01', coverageEnd: '2026-03-31' }),
    { patientId: app.patientKey(p), houseId: 'ramot' });
  const got = app.suggestCredits(p, '2026-03-10', [row]);
  const du = got.find((c) => c.creditType === 'days_unused');
  assert.ok(du, 'the recorded window straddles the exit');
  assert.equal(du.basis.coverageStart, '2026-03-01');
  assert.equal(du.basis.coverageEnd, '2026-03-31');
  assert.equal(du.basis.coverageWindowSource, 'recorded');
  assert.equal(du.basis.unusedDays, 21, '11–31 March');
  // rate = amountPaid / 30, unchanged: the divisor is not the window length.
  assert.equal(du.basis.dailyRate, 100);
  assert.equal(du.calculatedAmount, 2100);
});

test('E: a blank-coverage row credits exactly what it always did', () => {
  const p = Object.assign({}, PAT, { houseId: 'ramot', date: '2026-01-20' });
  const row = Object.assign(pay(), { patientId: app.patientKey(p), houseId: 'ramot' });
  const got = app.suggestCredits(p, '2026-02-01', [row]);
  const du = got.find((c) => c.creditType === 'days_unused');
  assert.equal(du.basis.coverageStart, '2026-01-20');
  assert.equal(du.basis.coverageEnd, '2026-02-19');
  assert.equal(du.basis.coverageWindowSource, 'inferred');
  assert.equal(du.basis.unusedDays, 18, '2–19 February');
});

test('E: OVERLAPPING recorded windows still credit no day twice', () => {
  /* Two rows both recorded as covering March — a legitimate double-charge
   * correction, or two months paid at once and re-dated. The ledger's
   * creditedThrough de-duplication is what makes refusing overlaps at the
   * keyboard unnecessary, so this proves it still holds on recorded windows. */
  const p = Object.assign({}, PAT, { houseId: 'ramot', date: '2026-01-20' });
  const k = app.patientKey(p);
  const a = Object.assign(pay({ dueDate: '2026-02-20', coverageStart: '2026-03-01', coverageEnd: '2026-03-31' }),
    { id: 'a', patientId: k, houseId: 'ramot' });
  // Both windows START on or before the exit, so both take the days_unused
  // path where the de-duplication lives (a window starting AFTER the exit is
  // prepaid_return, which is a full return by design and exempt).
  const b = Object.assign(pay({ dueDate: '2026-03-01', coverageStart: '2026-03-03', coverageEnd: '2026-04-09' }),
    { id: 'b', patientId: k, houseId: 'ramot' });
  const got = app.suggestCredits(p, '2026-03-05', [a, b]);
  const unused = got.filter((c) => c.creditType === 'days_unused');
  const days = unused.reduce((s, c) => s + c.basis.unusedDays, 0);
  assert.equal(got.filter((c) => c.creditType === 'prepaid_return').length, 0,
    'neither window starts after the exit');
  /* Row a credits 6–31 March (26 days). Row b's window runs to 9 April but
   * 6–31 March is already credited, so it adds only 1–9 April (9). 35 days,
   * never 26 + 35 — the overlap costs nothing, which is WHY overlaps are not
   * refused at the keyboard. */
  assert.equal(days, 35, 'got ' + JSON.stringify(got.map((c) => [c.creditType, c.basis.unusedDays])));
  // JSON round-trip: values built inside the vm carry the VM's Array
  // prototype, which deepEqual's reference check rejects.
  assert.equal(JSON.stringify(unused.map((c) => c.basis.unusedDays).sort((x, y) => x - y)), '[9,26]');
  assert.equal(unused.every((c) => c.basis.coverageWindowSource === 'recorded'), true);
});

test("E: a credit's audit trail SAYS the window was recorded, not assumed", () => {
  /* creditBasisText is persisted into the Credits row's `reason` column at
   * creation. A refund computed against a period somebody recorded must not
   * read identically to one computed against the assumed cycle. */
  const src = fnSource(APP, 'creditBasisText');
  assert.match(src, /basis\.coverageWindowSource === 'recorded'/);
  assert.match(src, /תקופה שנרשמה על התשלום/);
  // …and an inferred window says nothing extra — labelling every row would
  // bury the ones that matter.
  assert.match(src, /: ''/);
});

/* ================= F. validation ================= */

const BAD_PERIODS = [
  ['2026-01-20', '', /יש למלא גם/],
  ['', '2026-02-19', /יש למלא גם/],
  ['not-a-date', '2026-02-19', /לא תקין/],
  ['2026-02-30', '2026-03-05', /לא תקין/],
  ['2026-13-01', '2026-13-05', /לא תקין/],
  ['2026-03-01', '2026-02-28', /מוקדם/],
  ['2026-01-01', '2027-01-05', /ארוכה מדי/],
  /* Half-filled AND malformed. The presence check must win on both sides:
   * deciding "half-filled" from the PARSED value would make the server say
   * "malformed" where the client says "missing". */
  ['', 'garbage', /יש למלא גם/],
  ['garbage', '', /יש למלא גם/],
  ['2026-02-30', '2026-02-30', /לא תקין/],
];

test('F: the CLIENT rule refuses exactly the impossible periods, and nothing else', () => {
  assert.equal(app.coveragePeriodError('', ''), '', 'a blank pair means "infer" — the default');
  assert.equal(app.coveragePeriodError(null, undefined), '');
  assert.equal(app.coveragePeriodError('2026-01-20', '2026-02-19'), '');
  assert.equal(app.COVERAGE_MAX_DAYS, 366);
  // Exactly at the cap is fine; one day over is not.
  assert.equal(app.coveragePeriodError('2026-01-01', '2026-12-31'), '', '365 days');
  assert.equal(app.coveragePeriodError('2026-01-01', '2027-01-01'), '', '366 days — the cap');
  assert.match(app.coveragePeriodError('2026-01-01', '2027-01-02'), /ארוכה מדי/);
  for (const [s, e, re] of BAD_PERIODS) {
    assert.match(app.coveragePeriodError(s, e), re, `${s} → ${e}`);
  }
});

test('F: the SERVER enforces the identical rule — the client is never the authority', () => {
  const { code } = loadCode();
  assert.equal(code.coveragePeriodError('', ''), '');
  assert.equal(code.coveragePeriodError('2026-01-20', '2026-02-19'), '');
  assert.equal(code.COVERAGE_MAX_DAYS, app.COVERAGE_MAX_DAYS);
  for (const [s, e, re] of BAD_PERIODS) {
    assert.match(code.coveragePeriodError(s, e), re, `server: ${s} → ${e}`);
    // …and the two implementations agree, message for message.
    assert.equal(code.coveragePeriodError(s, e), app.coveragePeriodError(s, e), `parity: ${s} → ${e}`);
  }
});

test('F: client and server agree on EVERY combination of a wide input sweep', () => {
  /* Two implementations of one rule drift. This sweeps every pairing of a
   * deliberately nasty value set and insists the two return the identical
   * string — so a future edit to one side that the hand-written cases above
   * happen to miss still goes red. */
  const { code } = loadCode();
  const VALUES = [
    '', '   ', null, undefined,
    '2026-01-20', '2026-02-19', '2026-01-01', '2026-12-31', '2027-01-01', '2027-01-02',
    '2024-02-29', '2025-02-29',            // leap and non-leap 29 February
    '2026-02-30', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-5',
    '2026-03-20', '2026-10-25',            // both DST switches
    'garbage', '  2026-01-20  ', '2026-01-20T00:00:00.000Z',
  ];
  let checked = 0;
  for (const a of VALUES) {
    for (const b of VALUES) {
      assert.equal(code.coveragePeriodError(a, b), app.coveragePeriodError(a, b),
        `disagreement on (${JSON.stringify(a)}, ${JSON.stringify(b)})`);
      checked++;
    }
  }
  assert.equal(checked, VALUES.length * VALUES.length);
  // And the sweep really does exercise both outcomes, not just refusals.
  assert.equal(app.coveragePeriodError('2026-01-20', '2026-02-19'), '');
  assert.ok(app.coveragePeriodError('2026-02-30', '2026-03-05'));
});

test('F: upsertPayment_ REFUSES a bad period and writes nothing', () => {
  const { code, sandbox } = loadCode();
  code.ensure(code.PAYMENTS_SHEET, arr(code.PAYMENT_COLUMNS));
  const before = sandbox.__sheets.Payments.grid.length;
  const res = code.upsert({
    id: 'pay::x::2026-01-20', patientId: 'x', dueDate: '2026-01-20',
    amount: 3000, status: 'paid', amountPaid: 3000, balance: 0,
    coverageStart: '2026-03-01', coverageEnd: '2026-02-01',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /מוקדם/, 'the reason is surfaced verbatim, not swallowed');
  assert.equal(sandbox.__sheets.Payments.grid.length, before, 'not one cell was written');
});

test('F: a hand-built request cannot smuggle a period past the server', () => {
  const { code, sandbox } = loadCode();
  code.ensure(code.PAYMENTS_SHEET, arr(code.PAYMENT_COLUMNS));
  // The client never sends these; a direct POST could.
  for (const bad of [
    { coverageStart: '2026-01-20', coverageEnd: '' },
    { coverageStart: '<script>', coverageEnd: '<script>' },
    { coverageStart: 0, coverageEnd: 0 },
    { coverageStart: true, coverageEnd: true },
    { coverageStart: '2026-01-01', coverageEnd: '2030-01-01' },
  ]) {
    const res = code.upsert(Object.assign({
      id: 'pay::x::2026-01-20', patientId: 'x', dueDate: '2026-01-20',
      amount: 3000, status: 'paid', amountPaid: 3000, balance: 0,
    }, bad));
    assert.equal(res.ok, false, JSON.stringify(bad) + ' must be refused');
  }
  assert.equal(sandbox.__sheets.Payments.grid.length, 1, 'header only — nothing landed');
});

test('F: a good period round-trips through the sheet as bare YYYY-MM-DD text', () => {
  const { code, sandbox } = loadCode();
  const res = code.handle({
    action: 'savePayment',
    payment: JSON.stringify({
      id: 'pay::x::2026-01-20', patientId: 'x', patientName: 'דנה', houseId: 'arfoni',
      dueDate: '2026-01-20', amount: 3000, status: 'paid', amountPaid: 3000, balance: 0,
      timestamp: '2026-01-20T08:00:00.000Z',
      coverageStart: '2026-03-01', coverageEnd: '2026-03-31',
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  const rows = code.readSheet(sandbox.__sheets.Payments, arr(code.PAYMENT_COLUMNS));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coverageStart, '2026-03-01');
  assert.equal(rows[0].coverageEnd, '2026-03-31');
  // Re-saving the same id replaces the row in place, period included.
  code.handle({
    action: 'savePayment',
    payment: {
      id: 'pay::x::2026-01-20', patientId: 'x', patientName: 'דנה', houseId: 'arfoni',
      dueDate: '2026-01-20', amount: 3000, status: 'paid', amountPaid: 3000, balance: 0,
      timestamp: '2026-01-21T08:00:00.000Z', coverageStart: '', coverageEnd: '',
    },
  });
  const after = code.readSheet(sandbox.__sheets.Payments, arr(code.PAYMENT_COLUMNS));
  assert.equal(after.length, 1, 'still one row — upsert by id');
  assert.equal(after[0].coverageStart, '', 'a blank pair is stored blank, never guessed at');
});

test('F: a Date-typed cell from a caller is normalized to its LOCAL day, not a UTC slice', () => {
  const { code } = loadCode();
  for (const norm of [code.coverageDateISO, app.coverageDateISO]) {
    // 2026-03-01T00:00 local in Israel. toISOString() would say 2026-02-28.
    assert.equal(norm(new Date(2026, 2, 1)), '2026-03-01');
    assert.equal(norm('2026-02-28T22:00:00.000Z'), '2026-03-01');
    assert.equal(norm('2026-03-01'), '2026-03-01');
    assert.equal(norm('  2026-03-01  '), '2026-03-01', 'trimmed');
    assert.equal(norm(''), '');
    assert.equal(norm('   '), '');
    assert.equal(norm(null), '');
    assert.equal(norm(undefined), '');
    assert.equal(norm('garbage'), null, 'unusable → refused by the caller');
    assert.equal(norm(42), null, 'a number is not a date');
    assert.equal(norm(true), null, 'nor a boolean');
    assert.equal(norm('2026-02-30'), null, 'nor a day that does not exist');
    /* Loose forms are refused on BOTH sides rather than handed to
     * `new Date()`, whose tolerance is engine-dependent — accepting one here
     * and rejecting it there is exactly how a shared rule forks. */
    assert.equal(norm('2026-1-5'), null);
    assert.equal(norm('5/1/2026'), null);
    assert.equal(norm('Jan 5 2026'), null);
  }
});

/* ================= G. the UI ================= */

test('G: the period has its own cell on the גבייה row, next to the amount', () => {
  const src = fnSource(APP, 'buildBillingRow');
  assert.match(src, /<span class="p-label">תקופת כיסוי<\/span>/);
  // Immediately after the amount cell, so "how much" and "for what period"
  // sit together.
  assert.ok(src.indexOf('bill-cov-cell') > src.indexOf('bill-amount-cell'));
  assert.ok(src.indexOf('bill-cov-cell') - src.indexOf('${amountCellHtml}') < 200,
    'the coverage cell follows the amount cell directly');
  // The row grid grew a column to hold it.
  assert.match(CSS, /grid-template-columns: 1\.2fr \.85fr \.95fr 2fr 1fr \.95fr \.85fr;/,
    'seven columns — the coverage cell is the widest, it prints two dates');
  assert.match(CSS, /\.bill-cov-view \{/);
  assert.match(CSS, /\.bill-cov-edit\.hidden \{ display: none; \}/);
});

test('G: editable in edit mode on a PERSISTED row — paid rows included, placeholders excluded', () => {
  const src = fnSource(APP, 'buildBillingRow');
  assert.match(src, /const paymentPersisted = state\.payments\.some\(x => x && x\.id === payment\.id\);/);
  assert.match(src, /const coverageEditable = state\.mode === 'edit' && paymentPersisted;/);
  /* Deliberately NOT the amount editor's rule: a paid row is exactly the one
   * whose period must be correctable, since that is the row revenue
   * allocates. So the paid/partial exclusion must not appear here. */
  const covBlock = src.slice(src.indexOf('const paymentPersisted'), src.indexOf('const amountCellHtml'));
  assert.doesNotMatch(covBlock, /status !== 'paid'/);
  assert.doesNotMatch(covBlock, /patientMatched/, 'the columns live on the row itself — no override key to orphan');
});

test('G: the editor writes through savePayment and validates with the SHARED rule', () => {
  const src = fnSource(APP, 'saveCoveragePeriod');
  assert.match(src, /coveragePeriodError\(start, end\)/, 'the same rule the server enforces');
  assert.match(src, /showError\(err\)/, 'a refusal is shown, never swallowed');
  assert.match(src, /await savePayment\(updated\)/, 'one write path — optimistic upsert + rollback');
  // Only the two columns move. If this ever changed the money, a period edit
  // could silently alter a balance.
  assert.match(src, /coverageStart: start,\n\s+coverageEnd: end,/);
  for (const money of ['amount:', 'amountPaid:', 'balance:', 'status:']) {
    assert.ok(!src.includes(money), 'a period edit must not touch ' + money);
  }
  // The reset button clears the pair; savePayment re-stamps the default.
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /saveCoveragePeriod\(payment, '', ''\)/);
});

test('G: savePayment stamps the default and refuses an invalid pair before writing', () => {
  const src = fnSource(APP, 'savePayment');
  assert.match(src, /coveragePeriodError\(payment && payment\.coverageStart, payment && payment\.coverageEnd\)/);
  assert.match(src, /payment = withDefaultCoverage\(payment\);/);
  assert.ok(src.indexOf('coveragePeriodError') < src.indexOf('apiPost'),
    'validated before the round-trip');
  assert.ok(src.indexOf('withDefaultCoverage') < src.indexOf('state.payments.findIndex'),
    'stamped before the optimistic local upsert, so state and sheet agree');
});

test('G: an adjusted period is marked — a badge on the row and a chip in the drill-down', () => {
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /covAdjusted \? '<span class="badge override"/);
  assert.match(row, /const covAdjusted = coverageDiffersFromDefault\(payment\);/);
  const detail = fnSource(APP, 'buildRevenueDetailRow');
  assert.match(detail, /row\.coverageAdjusted.*rev-chip/s);
  assert.match(detail, /תקופה מותאמת/);
});

/* ================= H. scope + security (PR #124 parity) ================= */

test('H: no new endpoint, and server.js is untouched by this change', () => {
  assert.ok(!SERVER.includes('coverageStart'), 'the proxy learned nothing about coverage');
  assert.ok(!SERVER.includes('coveragePeriod'));
  // The only actions that touch a payment row are the two that already did.
  const dispatch = GS_SRC.slice(GS_SRC.indexOf('function handle_'), GS_SRC.indexOf('function handle_') + 6000);
  const payActions = (dispatch.match(/action === '(\w+)'/g) || [])
    .filter((a) => /Payment/i.test(a));
  assert.deepEqual(payActions.sort(), [
    "action === 'getPayments'", "action === 'savePayment'", "action === 'updatePayment'",
  ].sort());
});

test('H: every coverage value reaching the DOM is escaped', () => {
  const row = fnSource(APP, 'buildBillingRow');
  // The displayed window and both input values go through escapeHtml.
  assert.match(row, /\$\{escapeHtml\(covText\)\}/);
  assert.match(row, /value="\$\{escapeHtml\(covStart\)\}"/);
  assert.match(row, /value="\$\{escapeHtml\(covEnd\)\}"/);
  // covStart/covEnd are produced by isoFromLocalDate, so they cannot carry
  // markup in the first place — escaping is belt-and-suspenders.
  assert.match(row, /const covStart = cov \? isoFromLocalDate\(cov\.start\) : '';/);
});

test('H: the index.html shell is unchanged — the cell is built by the renderer', () => {
  assert.ok(!INDEX.includes('bill-cov'), 'no new static markup to drift out of sync');
  // The two screens this touches still exist exactly as before.
  assert.match(INDEX, /<section id="screen-billing" class="screen hidden">/);
  assert.match(INDEX, /<section id="screen-revenue" class="screen hidden">/);
});
