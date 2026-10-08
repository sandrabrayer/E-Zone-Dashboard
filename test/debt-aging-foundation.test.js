/* debtAging_ — debt aging as of any date (READ-ONLY foundation).
 * See CHANGELOG-debt-aging-foundation.md.
 *
 * Locked here (Sandra's rules, 2026-10-02):
 *   - as of D: cycles that STARTED on/before D, money RECEIVED on/before D
 *     (chargedAt); historical D (2026-08-31) vs today on one fixture
 *   - recorded_debt and unrecorded_cycles are two figures, never summed
 *   - partial payment, BillingOverrides, a recorded coverage period, void
 *     excluded, detached listed apart, the records cutoff, a discharge ends
 *     the cycles, bucket boundaries 7/8 30/31 60/61, the month clamp
 *   - an invalid asOf is refused; the action is PROXY_SECRET-gated (refused
 *     in enforce mode without it), not open, listed in PROXY_KNOWN_ACTIONS;
 *     getData keeps its keys; nothing is written
 *   - cross-check against the monthly revenue view (#133) where they overlap,
 *     with every disagreement asserted as a REPORTED divergence
 *
 * vm sandbox on the real Code.gs and public/app.js. TZ pinned to Israel.
 * All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const PROXY = 'proxy-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TODAY = '2026-09-30';
const NOW = '2026-09-30T09:00:00.000Z';   // 12:00 in Israel

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

/* A spreadsheet that can only be READ: every other method records + throws. */
function readOnly(target, label, attempts) {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => { attempts.push(label + '.' + String(prop)); throw new Error('read-only: ' + label + '.' + String(prop)); };
    },
  });
}
function roSheet(name, header, rows, attempts) {
  const grid = [header.slice()].concat(rows.map((r) => r.slice()));
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return readOnly({
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(26, width()),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const read = () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : ''); }
          out.push(row);
        }
        return out;
      };
      return readOnly({ getValues: read }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

function loadGs(opts) {
  const o = opts || {};
  const attempts = [];
  const sheets = (o.sheets || []).map((s) => roSheet(s.name, s.header, s.rows, attempts));
  const ss = readOnly({
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }, 'Spreadsheet', attempts);
  const props = Object.assign({}, o.props || {});
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: frozenDate(o.now || NOW), Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: { formatDate, getUuid: () => { attempts.push('Utilities.getUuid'); return 'x'; } },
    LockService: { getScriptLock: () => { attempts.push('LockService'); throw new Error('no lock'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__c = { PATIENT_COLUMNS, PAYMENT_COLUMNS, CREDIT_COLUMNS, BILLING_OVERRIDE_COLUMNS,
      PATIENTS_SHEET, PAYMENTS_SHEET, CREDITS_SHEET, BILLING_OVERRIDES_SHEET,
      OPEN_ACTIONS, PROXY_KNOWN_ACTIONS, DEBT_AGING_BUCKETS };`, sandbox);
  return { sandbox, attempts, C: sandbox.__c };
}

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__app = { buildMonthlyRevenue, normalizePayment, patientKey };`, sandbox);
  return sandbox.__app;
}

/* ---------- the synthetic world ---------- */
const AVI = 'ramot::אבי כהן::2026-07-10';
const GAL = 'rehab::גל דוד::2026-08-05';
const BAT = 'arfoni::בת-אל רון::2026-06-20';
const NOA = 'pardes::נועה ים::2026-07-15';
const HADAS = 'ramot::הדס שמעוני::2026-07-01';
const RON = 'asher::רון לוי::2026-07-31';

const PATIENTS = [
  { id: 'pt-1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', pay: 30000, status: 'active' },
  { id: 'pt-2', houseId: 'rehab', name: 'גל דוד', date: '2026-08-05', pay: 20000, status: 'active' },
  { id: 'pt-3', houseId: 'arfoni', name: 'בת-אל רון', date: '2026-06-20', pay: 35000, status: 'active' },
  { id: 'pt-4', houseId: 'pardes', name: 'נועה ים', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'pt-5', houseId: 'ramot', name: 'הדס שמעוני', date: '2026-07-01', pay: 30000, status: 'active' },
  { id: 'pt-6', houseId: 'asher', name: 'רון לוי', date: '2026-07-31', pay: 15000, status: 'active' },
  { id: 'pt-7', houseId: 'rehab', name: 'שי בלי יציאה', date: '2026-07-03', pay: 18000, status: 'released' },
];
const pay = (pid, due, f) => Object.assign({
  id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due,
}, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  // paid AFTER 31/08 → owed at 31/08, settled today
  pay(AVI, '2026-08-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-02T10:00:00+03:00' }),
  // unpaid, September override 25,000
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-08-05', { amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-08-05T09:00:00+03:00' }),
  // partial 12,000 of 20,000
  pay(GAL, '2026-09-05', { amount: 20000, status: 'partial', amountPaid: 12000, chargedAt: '2026-09-06T09:00:00+03:00' }),
  // pre-cutoff recorded row: excluded
  pay(BAT, '2026-06-20', { amount: 35000, status: 'unpaid', amountPaid: 0 }),
  // VOID row on בת-אל's 20/08 cycle: excluded, so it does NOT claim the cycle
  pay(BAT, '2026-08-20', { id: 'void-1', amount: 35000, status: 'void', amountPaid: 35000, chargedAt: '2026-08-20T09:00:00+03:00' }),
  pay(NOA, '2026-07-15', { amount: 28000, status: 'paid', amountPaid: 28000, chargedAt: '2026-07-15T09:00:00+03:00' }),
  // a row AFTER the exit: outside the stay, never debt
  pay(NOA, '2026-09-15', { amount: 28000, status: 'unpaid', amountPaid: 0 }),
  pay(HADAS, '2026-07-01', { amount: 30000, status: 'paid', amountPaid: 30000 }),   // historical: no chargedAt
  // a recorded coverage period 05/08–04/09 overrides the derived 01/08 cycle
  pay(HADAS, '2026-08-01', { amount: 30000, status: 'unpaid', amountPaid: 0, coverageStart: '2026-08-05', coverageEnd: '2026-09-04' }),
  // detached: matches no patient
  { id: 'p-eran', patientId: 'arfoni::ערן::2026-08-09', patientName: 'ערן', houseId: 'arfoni', dueDate: '2026-08-09', amount: 35000, status: 'paid', amountPaid: 35000, chargedAt: '2026-08-09T09:00:00+03:00' },
  // detached: a person marked it not a patient's money (its triple is אבי's)
  pay(AVI, '2026-09-11', { id: 'p-nap', amount: 5000, status: 'paid', amountPaid: 5000, linkStatus: 'not_a_patient', linkNote: 'החזר ספק', chargedAt: '2026-09-11T09:00:00+03:00' }),
];
const OVERRIDES = [{ id: 'ovr::' + AVI + '::2026-09', patientId: AVI, month: '2026-09', amount: 25000 }];
const CREDITS = [
  { id: 'c1', patientKey: NOA, patientName: 'נועה ים', houseId: 'pardes', amount: 5000, status: 'pending', createdAt: '2026-08-25T10:00:00+03:00' },
  { id: 'c2', patientKey: AVI, patientName: 'אבי כהן', houseId: 'ramot', amount: 3000, status: 'paid', paidDate: '2026-09-15', createdAt: '2026-08-10T10:00:00+03:00' },
  { id: 'c3', patientKey: GAL, patientName: 'גל דוד', houseId: 'rehab', amount: 2000, status: 'pending', createdAt: '2026-09-10T10:00:00+03:00' },
  { id: 'c4', patientKey: GAL, patientName: 'גל דוד', houseId: 'rehab', amount: 9000, status: 'cancelled', createdAt: '2026-08-01T10:00:00+03:00' },
];

function tabsOf(f) {
  const rows = (list) => ({ rows: (list || []).map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  return { patients: rows(f.patients), payments: rows(f.payments), credits: rows(f.credits), overrides: rows(f.overrides) };
}
const WORLD = { patients: PATIENTS, payments: PAYMENTS, credits: CREDITS, overrides: OVERRIDES };

let GS;
function gs() { return GS || (GS = loadGs()); }
function aging(asOf, world) { return plain(gs().sandbox.debtAging_(asOf, tabsOf(world || WORLD))); }
const patientOf = (r, name) => r.byPatient.find((p) => p.name === name);
const cycleOf = (r, name, start) => { const p = patientOf(r, name); return p && p.cycles.find((c) => c.start === start); };

/* ===== the as-of logic ===== */

test('a payment received AFTER D is not counted at D; it is at a later D', () => {
  const hist = aging('2026-08-31');
  const c = cycleOf(hist, 'אבי כהן', '2026-08-10');
  assert.deepEqual([c.kind, c.expected, c.received, c.balance], ['recorded', 30000, 0, 30000]);
  const now = aging(TODAY);
  assert.equal(cycleOf(now, 'אבי כהן', '2026-08-10'), undefined, 'settled today');
  assert.ok(patientOf(now, 'אבי כהן').settledCycles >= 2);
});

test('a cycle starting AFTER D is not counted', () => {
  const hist = aging('2026-08-31');
  assert.equal(cycleOf(hist, 'אבי כהן', '2026-09-10'), undefined);
  assert.equal(cycleOf(hist, 'בת-אל רון', '2026-09-20'), undefined);
  for (const p of hist.byPatient) for (const c of p.cycles) assert.ok(c.start <= '2026-08-31', p.name + ' ' + c.start);
  // a cycle starting ON D is counted, age 0
  const onD = aging('2026-09-20');
  const c = cycleOf(onD, 'בת-אל רון', '2026-09-20');
  assert.deepEqual([c.kind, c.days, c.bucket], ['unrecorded', 0, 'd0_7']);
});

test('historical 2026-08-31 vs today, same fixture: exact totals and buckets', () => {
  const hist = aging('2026-08-31');
  assert.equal(hist.asOf, '2026-08-31');
  // recorded at 31/08: אבי 10/08 (30,000, 21 d) + הדס 05/08 coverage (30,000, 26 d)
  assert.deepEqual(hist.totals.recorded_debt, { count: 2, total: 60000, d0_7: 0, d8_30: 60000, d31_60: 0, d61_plus: 0 });
  // unrecorded at 31/08: בת-אל 20/07 (42 d) + 20/08 (11 d); נועה 15/08 (16 d);
  // רון 31/07 (31 d) + 31/08 (0 d)
  assert.deepEqual(hist.totals.unrecorded_cycles,
    { count: 5, total: 35000 + 35000 + 28000 + 15000 + 15000, d0_7: 15000, d8_30: 35000 + 28000, d31_60: 35000 + 15000, d61_plus: 0 });

  const now = aging(TODAY);
  // recorded today: אבי 10/09 (override 25,000, 20 d) + גל 05/09 (8,000, 25 d) + הדס 05/08 (30,000, 56 d)
  assert.deepEqual(now.totals.recorded_debt, { count: 3, total: 63000, d0_7: 0, d8_30: 33000, d31_60: 30000, d61_plus: 0 });
  // unrecorded today: בת-אל 20/07 (72), 20/08 (41), 20/09 (10); נועה 15/08 (46);
  // הדס 01/09 (29); רון 31/07 (61), 31/08 (30), 30/09 (0)
  assert.deepEqual(now.totals.unrecorded_cycles, {
    count: 8, total: 35000 * 3 + 28000 + 30000 + 15000 * 3,
    d0_7: 15000, d8_30: 35000 + 30000 + 15000, d31_60: 35000 + 28000, d61_plus: 35000 + 15000,
  });
});

test('recorded and unrecorded are two figures and are NEVER summed', () => {
  const r = aging(TODAY);
  const keys = [];
  (function walk(o, pre) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) { keys.push(pre + k); walk(o[k], pre + k + '.'); }
  })(r, '');
  for (const k of keys) assert.ok(!/grand|combined|overall|debtTotal|sum_?all|allDebt/i.test(k), 'blended key ' + k);
  assert.deepEqual(Object.keys(r.totals).sort(), ['recorded_debt', 'unrecorded_cycles']);
  for (const h of r.byHouse) assert.deepEqual(Object.keys(h).sort(), ['houseId', 'recorded_debt', 'unrecorded_cycles']);
  const src = GS_SRC.slice(GS_SRC.indexOf('function debtAging_('), GS_SRC.indexOf('function debtAgingAction_('));
  assert.ok(!/recorded_debt\.total\s*\+|unrecorded_cycles\.total\s*\+/.test(src), 'no code adds the two');
  // the per-house figures add up to the totals, per figure
  for (const f of ['recorded_debt', 'unrecorded_cycles']) {
    const sum = r.byHouse.reduce((s, h) => s + h[f].total, 0);
    assert.equal(Math.round(sum * 100) / 100, r.totals[f].total, f);
  }
  const u = cycleOf(r, 'בת-אל רון', '2026-07-20');
  assert.equal(u.note, 'לא שולם, או ששולם ולא הוזן');
});

test('partial payment: balance = expected − received by D', () => {
  const now = cycleOf(aging(TODAY), 'גל דוד', '2026-09-05');
  assert.deepEqual([now.kind, now.expected, now.received, now.balance, now.bucket], ['recorded', 20000, 12000, 8000, 'd8_30']);
  // on 05/09 the 12,000 (reported 06/09) had not arrived yet
  const before = cycleOf(aging('2026-09-05'), 'גל דוד', '2026-09-05');
  assert.deepEqual([before.received, before.balance], [0, 20000]);
});

test('BillingOverrides: the month override sets the expected amount (recorded AND unrecorded)', () => {
  const c = cycleOf(aging(TODAY), 'אבי כהן', '2026-09-10');
  assert.deepEqual([c.expected, c.balance], [25000, 25000]);
  const ovr = [{ patientId: BAT, month: '2026-08', amount: 33000 }];
  const r = aging(TODAY, Object.assign({}, WORLD, { overrides: OVERRIDES.concat(ovr) }));
  assert.equal(cycleOf(r, 'בת-אל רון', '2026-08-20').expected, 33000);
  assert.equal(cycleOf(r, 'בת-אל רון', '2026-07-20').expected, 35000, 'another month is untouched');
});

test('a recorded coverage period overrides the derived cycle', () => {
  const r = aging(TODAY);
  const c = cycleOf(r, 'הדס שמעוני', '2026-08-05');
  assert.deepEqual([c.kind, c.start, c.end, c.coverageSource, c.days, c.bucket], ['recorded', '2026-08-05', '2026-09-04', 'recorded', 56, 'd31_60']);
  assert.equal(cycleOf(r, 'הדס שמעוני', '2026-08-01'), undefined, 'the derived 01/08 cycle is claimed, not unrecorded');
  // the coverage starts 05/08: on 03/08 that cycle had not started
  assert.equal(cycleOf(aging('2026-08-03'), 'הדס שמעוני', '2026-08-05'), undefined);
});

test('void rows are excluded: no money, and they do not claim their cycle', () => {
  const r = aging(TODAY);
  assert.equal(r.voidExcluded, 1);
  const c = cycleOf(r, 'בת-אל רון', '2026-08-20');
  assert.deepEqual([c.kind, c.received, c.balance], ['unrecorded', 0, 35000]);
  assert.ok(!r.detachedPayments.rows.some((x) => x.paymentId === 'void-1'));
});

test('detached payments are listed apart with a total, never matched to anyone', () => {
  const r = aging(TODAY);
  assert.deepEqual(r.detachedPayments.rows.map((x) => [x.paymentId, x.reason]).sort(),
    [['p-eran', 'unmatched'], ['p-nap', 'not_a_patient']]);
  assert.equal(r.detachedPayments.count, 2);
  assert.equal(r.detachedPayments.amount, 40000);
  assert.equal(r.detachedPayments.receivedByAsOf, 40000);
  // the not_a_patient row sits on אבי's triple and still never touches אבי
  assert.ok(!patientOf(r, 'אבי כהן').cycles.some((c) => c.paymentId === 'p-nap'));
  // as of 31/08 only the 09/08 row had started
  const h = aging('2026-08-31');
  assert.deepEqual(h.detachedPayments.rows.map((x) => x.paymentId), ['p-eran']);
});

test('the pre-cutoff cycle is excluded (derived and recorded)', () => {
  const r = aging(TODAY);
  assert.equal(r.recordsCutoff, '2026-07-01');
  assert.equal(cycleOf(r, 'בת-אל רון', '2026-06-20'), undefined);
  for (const p of r.byPatient) for (const c of p.cycles) assert.ok(c.start >= '2026-07-01');
  assert.equal(aging('2026-06-30').totals.unrecorded_cycles.count, 0);
});

test('a discharged patient\'s cycles stop at the exit', () => {
  const r = aging(TODAY);
  const p = patientOf(r, 'נועה ים');
  assert.equal(p.status, 'released');
  assert.equal(p.inHouseAtAsOf, false);
  assert.deepEqual(p.cycles.map((c) => [c.start, c.end, c.kind]), [['2026-08-15', '2026-08-20', 'unrecorded']]);
  // the recorded row after the exit is outside the stay, never debt
  assert.deepEqual(r.outsideStay.rows.map((x) => [x.name, x.start]), [['נועה ים', '2026-09-15']]);
  // released with no exit date: no invented cycles, listed instead
  assert.deepEqual(r.releasedWithoutExit.rows.map((x) => x.name), ['שי בלי יציאה']);
  assert.equal(patientOf(r, 'שי בלי יציאה'), undefined);
});

test('bucket boundaries: 7/8, 30/31, 60/61', () => {
  const b = gs().sandbox.debtAgingBucket_;
  assert.deepEqual([0, 7, 8, 30, 31, 60, 61, 400].map(b), ['d0_7', 'd0_7', 'd8_30', 'd8_30', 'd31_60', 'd31_60', 'd61_plus', 'd61_plus']);
  assert.deepEqual(plain(gs().C.DEBT_AGING_BUCKETS).map((x) => x.key), ['d0_7', 'd8_30', 'd31_60', 'd61_plus']);
  // through the engine, on בת-אל's 20/09 cycle
  const at = (d) => cycleOf(aging(d), 'בת-אל רון', '2026-09-20');
  assert.deepEqual([at('2026-09-27').days, at('2026-09-27').bucket], [7, 'd0_7']);
  assert.deepEqual([at('2026-09-28').days, at('2026-09-28').bucket], [8, 'd8_30']);
  assert.deepEqual([at('2026-10-20').days, at('2026-10-20').bucket], [30, 'd8_30']);
  assert.deepEqual([at('2026-10-21').days, at('2026-10-21').bucket], [31, 'd31_60']);
  assert.deepEqual([at('2026-11-19').days, at('2026-11-19').bucket], [60, 'd31_60']);
  assert.deepEqual([at('2026-11-20').days, at('2026-11-20').bucket], [61, 'd61_plus']);
});

test('month clamp: entry on the 31st (same clamp as computeRefund_)', () => {
  const r = aging(TODAY);
  const p = patientOf(r, 'רון לוי');
  assert.deepEqual(p.cycles.map((c) => [c.start, c.end]),
    [['2026-07-31', '2026-08-30'], ['2026-08-31', '2026-09-29'], ['2026-09-30', '2026-10-30']]);
  const s = gs().sandbox;
  // one clamp: the cycle ends agree with computeRefund_'s entry-anchored windows
  for (const c of p.cycles) {
    const b = s.computeRefund_({ houseId: 'asher', entryDate: '2026-07-31', exitDate: '2026-12-31', amountPaid: 1, decidedDate: TODAY, cycleStart: c.start });
    assert.equal(b.cycleEnd, c.end, c.start);
  }
  // February: 31/01 entry → 28/02, then back to 31/03
  const feb = aging('2027-04-01', { patients: [{ id: 'x', houseId: 'asher', name: 'פ', date: '2027-01-31', pay: 100, status: 'active' }] });
  assert.deepEqual(feb.byPatient[0].cycles.map((c) => [c.start, c.end]),
    [['2027-01-31', '2027-02-27'], ['2027-02-28', '2027-03-30'], ['2027-03-31', '2027-04-29']]);
});

test('an invalid asOf → error; blank → today in Asia/Jerusalem', () => {
  const s = gs().sandbox;
  for (const bad of ['2026-02-30', '2026-13-01', '30/09/2026', '2026-9-30', 'x', ' 2026-09-30x', 20260930, {}, ['2026-09-30'], true]) {
    assert.deepEqual(plain(s.debtAging_(bad, tabsOf(WORLD))), { ok: false, error: 'bad_asOf' }, JSON.stringify(bad));
  }
  assert.equal(plain(s.debtAging_('', tabsOf(WORLD))).asOf, TODAY);
  assert.equal(plain(s.debtAging_(undefined, tabsOf(WORLD))).asOf, TODAY);
  // 23:30 UTC on 30/09 is already 01/10 in Israel
  const late = loadGs({ now: '2026-09-30T23:30:00.000Z' });
  assert.equal(plain(late.sandbox.debtAging_(undefined, tabsOf(WORLD))).asOf, '2026-10-01');
});

test('pending credits at D, per house, reported beside the debt and never subtracted', () => {
  const hist = aging('2026-08-31');
  assert.deepEqual(hist.pendingCredits.byHouse.map((h) => [h.houseId, h.total]), [['pardes', 5000], ['ramot', 3000]]);
  assert.equal(hist.pendingCredits.total, 8000);
  const now = aging(TODAY);
  assert.deepEqual(now.pendingCredits.byHouse.map((h) => [h.houseId, h.total]), [['pardes', 5000], ['rehab', 2000]]);
  // the debt is identical with and without credits
  const noCredits = aging(TODAY, Object.assign({}, WORLD, { credits: [] }));
  assert.deepEqual(noCredits.totals, now.totals);
});

test('received date: chargedAt; a historical paid row without it is dated to its cycle and counted apart', () => {
  const r = aging(TODAY);
  assert.deepEqual(r.receivedDateUnknown, { count: 1, amount: 30000 });   // הדס 01/07
  assert.equal(cycleOf(r, 'הדס שמעוני', '2026-07-01'), undefined, 'still counted as received');
});

test('VAT-inclusive: amounts are the stored figures, not divided', () => {
  const r = aging(TODAY);
  assert.equal(r.vatInclusive, true);
  assert.equal(cycleOf(r, 'בת-אל רון', '2026-07-20').expected, 35000);
});

test('pure: the input tabs are byte-identical afterwards, and no service is touched', () => {
  const tabs = tabsOf(WORLD);
  const before = JSON.stringify(tabs);
  const g = loadGs();
  g.sandbox.debtAging_(TODAY, tabs);
  assert.equal(JSON.stringify(tabs), before);
  assert.deepEqual(g.attempts, []);
});

/* ===== the action ===== */

function sheetsOf(C, world) {
  const grid = (cols, list) => (list || []).map((o) => Array.from(cols).map((c) => (o[c] === undefined ? '' : o[c])));
  return [
    { name: C.PATIENTS_SHEET, header: Array.from(C.PATIENT_COLUMNS), rows: grid(C.PATIENT_COLUMNS, world.patients) },
    { name: C.PAYMENTS_SHEET, header: Array.from(C.PAYMENT_COLUMNS), rows: grid(C.PAYMENT_COLUMNS, world.payments) },
    { name: C.CREDITS_SHEET, header: Array.from(C.CREDIT_COLUMNS), rows: grid(C.CREDIT_COLUMNS, world.credits) },
    { name: C.BILLING_OVERRIDES_SHEET, header: Array.from(C.BILLING_OVERRIDE_COLUMNS), rows: grid(C.BILLING_OVERRIDE_COLUMNS, world.overrides) },
  ];
}

test('action debtAging: reads the sheets, answers the same as debtAging_, writes nothing', () => {
  const C = gs().C;
  const g = loadGs({ sheets: sheetsOf(C, WORLD), props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const out = plain(g.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'debtAging', asOf: '2026-08-31', proxySecret: PROXY, proxyUser: '' }) } }).json);
  assert.equal(out.ok, true);
  assert.equal(typeof out.generatedAt, 'string');
  delete out.generatedAt;
  assert.deepEqual(out, aging('2026-08-31'));
  assert.deepEqual(g.attempts, [], 'no write, no lock, no tab created');
  const bad = plain(g.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'debtAging', asOf: '2026-02-30', proxySecret: PROXY }) } }).json);
  assert.deepEqual(bad, { ok: false, error: 'bad_asOf' });
  // empty spreadsheet: answered, not crashed, nothing created
  const empty = loadGs({ props: { PROXY_SECRET: PROXY } });
  const e = plain(empty.sandbox.handle_({ action: 'debtAging' }).json);
  assert.equal(e.ok, true);
  assert.equal(e.totals.recorded_debt.total + e.totals.unrecorded_cycles.total, 0);
  assert.deepEqual(empty.attempts, []);
});

test('the action is refused WITHOUT PROXY_SECRET in enforce mode, and is not an open action', () => {
  const C = gs().C;
  assert.ok(Array.from(C.PROXY_KNOWN_ACTIONS).includes('debtAging'));
  assert.ok(!Array.from(C.OPEN_ACTIONS).includes('debtAging'));
  const g = loadGs({ sheets: sheetsOf(C, WORLD), props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const post = (body) => plain(g.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).json);
  assert.deepEqual(post({ action: 'debtAging' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(post({ action: 'debtAging', proxySecret: 'nope' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(plain(g.sandbox.doGet({ parameter: { action: 'debtAging', proxySecret: PROXY } }).json), { ok: false, error: 'unauthorized' },
    'a secret in the URL does not count');
  assert.equal(post({ action: 'debtAging', proxySecret: PROXY, proxyUser: '' }).ok, true);
});

test('read-only by source: no writer, lock, audit, property or fetch in the debt-aging block', () => {
  const start = GS_SRC.indexOf('/* ===== Debt aging, as of any date');
  const end = GS_SRC.indexOf('function debtAgingAction_(');
  const block = GS_SRC.slice(start, GS_SRC.indexOf('\n}\n', end) + 3);
  assert.ok(start > 0 && end > start);
  for (const bad of ['setValue', 'setValues', 'appendRow', 'insertSheet', 'getOrCreateSheet_', 'deleteRow', 'LockService',
    'logAudit_', 'PropertiesService', 'UrlFetchApp', 'MailApp', 'DriveApp', 'clear(']) {
    assert.ok(!block.includes(bad), bad);
  }
  // reuses the existing helpers rather than a second engine
  for (const reuse of ['recModel_(', 'recCycleDueDates_(', 'recApplyOverride_(', 'recBeforeCutoff_(', 'recExitISO_(', 'recStayCovers_(', 'refundAddMonths_(']) {
    assert.ok(block.includes(reuse), 'reuses ' + reuse);
  }
  // The UI (PR feat/debt-aging-ui) only READS it: app.js through apiPost and
  // server.js through the export route — see test/debt-aging-ui.test.js.
  assert.ok(/apiPost\(\{ action: 'debtAging', asOf \}\)/.test(APP_SRC));
});

test('getData keeps its keys', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  // getData creates missing tabs; give it a writable spreadsheet
  const sheets = {};
  const fake = (name) => {
    const grid = [];
    return {
      getName: () => name, getLastRow: () => grid.length, getLastColumn: () => (grid[0] || []).length,
      getMaxRows: () => 1000, getMaxColumns: () => 26, setFrozenRows() {}, hideSheet() {}, isSheetHidden: () => false,
      appendRow(r) { grid.push(r.slice()); },
      getRange: (r, c, nr, nc) => ({
        setNumberFormat() { return this; }, setValue(v) { (grid[r - 1] = grid[r - 1] || [])[c - 1] = v; },
        setValues(v) { v.forEach((row, i) => { grid[r - 1 + i] = grid[r - 1 + i] || []; row.forEach((x, j) => { grid[r - 1 + i][c - 1 + j] = x; }); }); },
        getValues: () => Array.from({ length: nr || 1 }, (_, i) => Array.from({ length: nc || 1 }, (_, j) => ((grid[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        getValue: () => ((grid[r - 1] || [])[c - 1] ?? ''),
      }),
    };
  };
  g.sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => ({
    getSheetByName: (n) => sheets[n] || null, getSheets: () => Object.values(sheets),
    insertSheet: (n) => (sheets[n] = fake(n)), getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }) };
  g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) };
  const out = plain(g.sandbox.handle_({ action: 'getData' }).json);
  assert.equal(out.ok, true);
  for (const k of ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']) {
    assert.ok(k in out, 'getData lost ' + k);
  }
  assert.ok(!('debtAging' in out) && !('totals' in out), 'getData is not widened');
});

/* ===== cross-check with the monthly revenue view (#133) ===== */

/* September 2026, today = 30/09. Where the two overlap:
 *   - revenue `unbilled_past` (a past cycle with no row)  ↔ debt `unrecorded`
 *     — same patient, same start, fullAmount === expected;
 *   - revenue `billed_unpaid` (a row's shortfall)          ↔ debt `recorded`
 *     — same row, fullAmount === balance (D = today, every charge before D).
 * Every place they part is asserted below as a REPORTED divergence. */
test('cross-check: debtAging_ agrees with buildMonthlyRevenue for September 2026 where they overlap', () => {
  const app = loadApp();
  const r = aging(TODAY);
  const rev = app.buildMonthlyRevenue({
    month: '2026-09', today: TODAY,
    patients: PATIENTS.map((p) => Object.assign({}, p)),
    payments: PAYMENTS.map((p) => app.normalizePayment(p)),
    credits: [], overrides: OVERRIDES.map((o) => Object.assign({}, o)),
  });
  const rows = rev.expected.rows || rev.expectedRows || [];
  assert.ok(Array.isArray(rows) && rows.length > 0, 'revenue rows found');

  const debtCycles = [];
  r.byPatient.forEach((p) => p.cycles.forEach((c) => debtCycles.push(Object.assign({ patientKey: p.patientKey }, c))));
  const inSeptember = (c) => c.start <= '2026-09-30' && c.end >= '2026-09-01';

  // unrecorded ↔ unbilled_past
  const unbilled = rows.filter((x) => x.kind === 'unbilled_past');
  const debtUnrec = debtCycles.filter((c) => c.kind === 'unrecorded' && inSeptember(c));
  assert.ok(unbilled.length >= 5);
  assert.deepEqual(plain(unbilled.map((x) => [x.patientId, x.dueDate, x.fullAmount])).sort(),
    debtUnrec.map((c) => [c.patientKey, c.start, c.expected]).sort());

  // recorded ↔ billed_unpaid, by payment row
  const billed = rows.filter((x) => x.kind === 'billed_unpaid');
  const byId = {};
  billed.forEach((x) => { byId[x.paymentId] = x; });
  const debtRec = debtCycles.filter((c) => c.kind === 'recorded' && inSeptember(c));
  assert.ok(debtRec.length >= 3);
  for (const c of debtRec) {
    assert.ok(byId[c.paymentId], 'revenue has ' + c.paymentId);
    assert.equal(byId[c.paymentId].fullAmount, c.balance, c.paymentId);
  }

  // DIVERGENCE 1 (reported): a recorded row AFTER the exit. The revenue view
  // counts its shortfall as EXPECTED; debt aging lists it as outside the stay.
  const afterExit = 'pay::' + NOA + '::2026-09-15';
  assert.ok(byId[afterExit], 'revenue counts the after-exit row');
  assert.ok(!debtRec.some((c) => c.paymentId === afterExit));
  assert.ok(r.outsideStay.rows.some((x) => x.paymentId === afterExit));
  // and nothing else differs on the billed side
  assert.deepEqual(plain(Object.keys(byId).filter((id) => !debtRec.some((c) => c.paymentId === id))), [afterExit]);
});

test('cross-check: the reported divergences beyond September — pre-cutoff recorded rows, released without exit', () => {
  const app = loadApp();
  // DIVERGENCE 2 (reported): a recorded row before the cutoff stays in the
  // revenue view's EXPECTED (#140 "a recorded pre-cutoff row still counts");
  // debt aging excludes it (rule 4).
  const rev = app.buildMonthlyRevenue({
    month: '2026-07', today: TODAY,
    patients: PATIENTS.map((p) => Object.assign({}, p)),
    payments: PAYMENTS.map((p) => app.normalizePayment(p)), credits: [], overrides: [],
  });
  const rows = rev.expected.rows || [];
  assert.ok(rows.some((x) => x.kind === 'billed_unpaid' && x.dueDate === '2026-06-20'), 'revenue keeps the June row');
  assert.equal(cycleOf(aging(TODAY), 'בת-אל רון', '2026-06-20'), undefined, 'debt aging drops it');
  // AGREEMENT: released with no exit date is out of both (no projected cycle in revenue either)
  assert.ok(!rows.some((x) => x.patientId === 'rehab::שי בלי יציאה::2026-07-03'));
});
