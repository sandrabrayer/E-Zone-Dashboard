'use strict';
/* The cycle balance — CHANGELOG-cycle-balance.md.
 *
 * Rule (Sandra, 11/10/2026): the cycle amount is owed ONCE per coverage
 * period (entry → +1 month). Splitting it across calendar months is revenue
 * allocation / display ONLY and never creates a balance. Balance = expected −
 * every payment attached to the cycle, whatever calendar month it falls in.
 * An open cycle's expected amount is the month override, else the patient's
 * agreed price, else the stamped amount; a settled cycle stays settled.
 *
 * Fixtures are the live cases of 11/10/2026 (Payments rows 95, 121, 125,
 * 127, 133). vm sandbox on the REAL public/app.js and apps-script/Code.gs. */

process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/cycle-balance.js');
const { loadPage } = require('./helpers/app-sandbox');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const TODAY = '2026-10-11';

/* ---- live fixtures ---- */
const P = {
  orian: { id: 'id-4xghygmxmucffaqw', houseId: 'rehab', name: 'אוריאן אלון', date: '2026-09-22', pay: 30000, status: 'active' },
  yinon: { id: 'id-ad890dc0', houseId: 'rehab', name: 'ינון כהן', date: '2026-06-23', pay: 30000, status: 'active' },
  eliyahu: { id: 'id-kwfkf1eimupdbvei', houseId: 'arfoni', name: 'אליהו חן', date: '2026-10-01', pay: 30000, status: 'active' },
  tamir: { id: 'id-8996c2a0', houseId: 'arfoni', name: 'טמיר בן מיור', date: '2026-07-27', pay: 33000, status: 'active' },
  shahar: { id: 'id-pwphgiknmtr7ufjh', houseId: 'arfoni', name: 'שחר חיון', date: '2026-09-07', pay: 32000, status: 'active' },
};
const key = (p) => `${p.houseId}::${p.name}::${p.date}`;
const cyc = (p, due, amount, status, amountPaid, cov) => ({
  id: `pay::${key(p)}::${due}`, patientId: key(p), patientName: p.name, houseId: p.houseId, dueDate: due,
  amount, status, amountPaid, balance: Math.max(0, amount - amountPaid), patientUid: p.id,
  coverageStart: cov ? cov[0] : '', coverageEnd: cov ? cov[1] : '',
});
const CYCLES = [
  cyc(P.orian, '2026-09-22', 30000, 'partial', 20000),                                 // row 95  — genuine
  cyc(P.yinon, '2026-09-23', 30000, 'partial', 25000, ['2026-09-23', '2026-10-22']),   // row 121 — open, needs a decision
  cyc(P.eliyahu, '2026-10-01', 33000, 'partial', 30000, ['2026-10-01', '2026-10-31']), // row 125 — stale stamp
  cyc(P.shahar, '2026-10-07', 35000, 'partial', 32000, ['2026-10-07', '2026-11-06']),  // row 127 — stale stamp
  cyc(P.tamir, '2026-09-27', 33000, 'partial', 30000, ['2026-09-27', '2026-10-26']),   // row 133 — open, needs a decision
];

/* ================= the pure module ================= */

test('a full payment across a calendar-month boundary → balance 0, «שולם»', () => {
  const win = R.cycleWindow('2026-09-22');
  assert.deepEqual(win, { start: '2026-09-22', end: '2026-10-21' }, '9 days of September + 21 of October');
  const st = R.cycleState({ stampedAmount: 30000, amountPaid: 30000, agreedPrice: 30000, status: 'paid' });
  assert.deepEqual(st, { expected: 30000, source: 'settled', paid: 30000, balance: 0, status: 'paid' });
  // Paid as one receipt dated in October, or as two slices in two months — the same.
  assert.equal(R.paidInCycle(win, [{ amount: 30000, coverageStart: '2026-09-22' }]), 30000);
  assert.equal(R.paidInCycle(win, [{ amount: 9000, coverageStart: '2026-09-22' }, { amount: 21000, coverageStart: '2026-10-01' }]), 30000);
});

test('a genuine partial payment → the correct balance (אוריאן אלון, 20,000 of 30,000)', () => {
  assert.deepEqual(R.cycleState({ stampedAmount: 30000, amountPaid: 20000, agreedPrice: 30000, status: 'partial' }),
    { expected: 30000, source: 'agreed', paid: 20000, balance: 10000, status: 'partial' });
  assert.deepEqual(R.cycleState({ stampedAmount: 30000, amountPaid: 0, agreedPrice: 30000, status: 'unpaid' }),
    { expected: 30000, source: 'agreed', paid: 0, balance: 30000, status: 'unpaid' });
});

test('a payment dated in the NEXT calendar month still counts for its cycle', () => {
  const win = R.cycleWindow('2026-09-27', '2026-09-27', '2026-10-26');
  // received 11/10, coverage from the cycle start → in the cycle
  assert.ok(R.paymentInCycle(win, { coverageStart: '2026-09-27', receivedDate: '2026-10-11' }));
  // the dueDate anchor alone is enough; the received month never matters
  assert.ok(R.paymentInCycle(win, { dueDate: '2026-09-27', receivedDate: '2026-11-02' }));
  assert.ok(!R.paymentInCycle(win, { coverageStart: '2026-10-27' }), 'the NEXT cycle\'s money is not this cycle\'s');
  // Code.gs links a receipt received a month later to its cycle and derives «שולם».
  const g = loadGs();
  g.sandbox.__x = [
    { id: 'pay::rehab::x::2026-09-22::2026-09-22', patientId: 'rehab::x::2026-09-22', patientUid: 'u1', dueDate: '2026-09-22', amount: 30000, status: 'unpaid', amountPaid: 0 },
    { id: 'rcpt-1', patientId: 'rehab::x::2026-09-22', patientUid: 'u1', dueDate: '2026-09-22', amount: 30000, amountPaid: 30000, status: 'paid',
      coverageStart: '2026-09-22', coverageEnd: '2026-10-21', receivedDate: '2026-10-15' },
  ];
  const d = plain(g.run('paymentRowsDerived_(globalThis.__x)'));
  assert.deepEqual([d.cycles[0].status, d.cycles[0].amountPaid, d.cycles[0].balance], ['paid', 30000, 0]);
});

test('expected-amount source: agreed price over a stale stamped / house-default amount; override over agreed; settled stays settled', () => {
  // אליהו חן: stamped 33,000 (his pay after the 04/10 house move), paid 30,000,
  // agreed price corrected to 30,000 two minutes later → paid in full.
  assert.deepEqual(R.cycleState({ stampedAmount: 33000, amountPaid: 30000, agreedPrice: 30000, status: 'partial' }),
    { expected: 30000, source: 'agreed', paid: 30000, balance: 0, status: 'paid' });
  // 33,000 vs 30,000 is NOT VAT: both VAT-inclusive (18% would be 35,400).
  assert.notEqual(Math.round(30000 * 1.18), 33000);
  // טמיר בן מיור: agreed price still 33,000 → a real 3,000 balance until Sandra decides.
  assert.equal(R.cycleState({ stampedAmount: 33000, amountPaid: 30000, agreedPrice: 33000, status: 'partial' }).balance, 3000);
  // An override for the month beats the agreed price.
  assert.deepEqual(R.cycleState({ stampedAmount: 33000, amountPaid: 30000, agreedPrice: 33000, overrideAmount: 30000, status: 'partial' }),
    { expected: 30000, source: 'override', paid: 30000, balance: 0, status: 'paid' });
  // A cycle already paid at its stamp stays paid even if the price changes
  // later — it is never reopened; a HIGHER price only flags it (underStamped).
  assert.deepEqual(R.cycleState({ stampedAmount: 30000, amountPaid: 30000, agreedPrice: 35000, status: 'paid' }),
    { expected: 30000, source: 'settled', paid: 30000, balance: 0, status: 'paid', underStamped: true, priceExpected: 35000, gap: 5000 });
  assert.equal(R.cycleState({ stampedAmount: 30000, amountPaid: 0, agreedPrice: 35000, status: 'paid' }).status, 'paid', 'stored «שולם» is history');
  // No agreed price → the stamp; void owes nothing.
  assert.equal(R.cycleExpected({ stampedAmount: 30000, amountPaid: 0, agreedPrice: 0 }).source, 'stamped');
  assert.deepEqual(R.cycleState({ stampedAmount: 30000, amountPaid: 0, status: 'void' }).balance, 0);
});

test('parity: lib/cycle-balance.js === Code.gs cycleBalanceState_ / receiptCycleWindow_ over a grid', () => {
  const g = loadGs();
  const money = [null, '', 0, 25000, 28000, 30000, 33000, 35000, -5, 'x'];
  const statuses = ['unpaid', 'partial', 'paid', 'void', '', 'PAID'];
  let n = 0;
  for (const stampedAmount of money) for (const amountPaid of [0, 20000, 30000, 33000, ''])
    for (const agreedPrice of [null, 0, 30000, 33000]) for (const overrideAmount of [null, '', 30000])
      for (const status of statuses) {
        const input = { stampedAmount, amountPaid, agreedPrice, overrideAmount, status };
        g.sandbox.__i = input;
        assert.deepEqual(plain(g.run('cycleBalanceState_(globalThis.__i)')), plain(R.cycleState(input)), JSON.stringify(input));
        n++;
      }
  assert.ok(n >= 3600, 'grid size ' + n);
  for (const start of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-09-22', '2026-10-01', '2026-12-15', '2028-01-30']) {
    g.sandbox.__c = { dueDate: start };
    assert.deepEqual(plain(g.run('receiptCycleWindow_(globalThis.__c)')), R.cycleWindow(start), start);
  }
});

/* ================= the page: גבייה, «מטופלים», the patient card ================= */

function page(cycles, patients, overrides) {
  const p = loadPage();
  p.sandbox.CycleBalance = R;
  p.sandbox.__fx = { cycles, patients, overrides: overrides || [] };
  p.run(`Object.assign(state, {
    patients: globalThis.__fx.patients, leads: [], irrelevantLeads: [], removedLeads: [], receipts: [], funders: [],
    payments: globalThis.__fx.cycles.map(normalizePayment), billingOverrides: globalThis.__fx.overrides,
  })`);
  const call = (fn, ...args) => { p.sandbox.__args = args; return p.run(`${fn}(...globalThis.__args)`); };
  return Object.assign(p, { call });
}

/* What יתרות פתוחות lists (renderBillingOpenList's data, without the DOM). */
function openBalances(p, selectedISO) {
  return plain(p.run(`state.payments
    .filter(x => !isVoidPayment(x) && x.dueDate && x.dueDate < ${JSON.stringify(selectedISO)})
    .map(x => cycleView(x, findPatientForPayment(x)))
    .filter(x => x.status === 'unpaid' || x.status === 'partial')
    .map(x => ({ name: x.patientName, amount: x.amount, paid: x.amountPaid, balance: x.balance, status: x.status }))`));
}

test('גבייה: a full payment at the agreed price is «שולם», no «דווח תשלום», not under «יתרות פתוחות מתאריכים קודמים»', () => {
  const p = page(CYCLES, Object.values(P));
  const open = openBalances(p, TODAY);
  assert.deepEqual(open.map((o) => [o.name, o.balance]), [
    ['אוריאן אלון', 10000], ['ינון כהן', 5000], ['טמיר בן מיור', 3000],
  ], 'אליהו חן (due 01/10) and שחר חיון are paid; only real balances remain');
  const eli = p.call('paymentForPatientOnDate', p.run(`state.patients.find(x => x.id === '${P.eliyahu.id}')`), '2026-10-01');
  assert.deepEqual([eli.amount, eli.amountPaid, eli.balance, eli.status, eli.stampedAmount, eli.expectedSource],
    [30000, 30000, 0, 'paid', 33000, 'agreed']);
  const row = p.call('buildBillingRow', p.run(`state.patients.find(x => x.id === '${P.eliyahu.id}')`), eli, '2026-10-01', false);
  assert.ok(!row.innerHTML.includes('bill-report-btn'), 'no «דווח תשלום»');
  assert.ok(row.innerHTML.includes('שולם'));
  // The genuine partial keeps its button.
  const ori = p.call('paymentForPatientOnDate', p.run(`state.patients.find(x => x.id === '${P.orian.id}')`), '2026-09-22');
  const oriRow = p.call('buildBillingRow', p.run(`state.patients.find(x => x.id === '${P.orian.id}')`), ori, '2026-09-22', true);
  assert.ok(oriRow.innerHTML.includes('bill-report-btn'));
});

test('«מטופלים» card reads the same status as the גבייה row', () => {
  const p = page(CYCLES, Object.values(P));
  const st = (id) => plain(p.call('patientPaymentState', p.run(`state.patients.find(x => x.id === '${id}')`), p.run('state.payments'), null, TODAY));
  assert.equal(st(P.eliyahu.id).key, 'paid');
  assert.equal(st(P.shahar.id).key, 'paid');
  assert.equal(st(P.orian.id).key, 'partial');
  assert.equal(st(P.tamir.id).key, 'partial');
  const rows = plain(p.call('patientListRows', p.run('state'), { status: 'active' }, TODAY));
  const eliRow = rows.find((r) => r.patient.id === P.eliyahu.id);
  assert.equal(eliRow.payment.key, 'paid');
});

test('the monthly summary counts one balance per cycle, at the shared rule', () => {
  const p = page(CYCLES, Object.values(P));
  const thisMonth = plain(p.run(`state.payments.filter(x => monthKey(x.dueDate) === '2026-10').map(x => cycleView(x, findPatientForPayment(x)))`));
  assert.equal(thisMonth.reduce((s, x) => s + x.balance, 0), 0, 'October: אליהו חן + שחר חיון, both paid in full');
});

test('without the module the page keeps the stored figures (graceful)', () => {
  const p = page(CYCLES, Object.values(P));
  delete p.sandbox.CycleBalance;
  const eli = p.call('paymentForPatientOnDate', p.run(`state.patients.find(x => x.id === '${P.eliyahu.id}')`), '2026-10-01');
  assert.deepEqual([eli.amount, eli.balance, eli.status], [33000, 3000, 'partial']);
});

/* ================= בקרת גבייה = גבייה ================= */

test('בקרת גבייה totals match גבייה: Code.gs debtAging_ recorded debt === the sum of יתרות פתוחות', () => {
  const g = loadGs();
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  g.sandbox.__t = { patients: rows(Object.values(P)), payments: rows(CYCLES), credits: rows([]), overrides: rows([]) };
  const aging = plain(g.run(`debtAging_('${TODAY}', globalThis.__t)`));
  const recorded = aging.byPatient.flatMap((x) => x.cycles.filter((c) => c.kind === 'recorded').map((c) => [x.name, c.balance]));
  const p = page(CYCLES, Object.values(P));
  const open = openBalances(p, '2026-10-12');
  assert.deepEqual(recorded.sort(), open.map((o) => [o.name, o.balance]).sort());
  assert.equal(aging.totals.recorded_debt.total, open.reduce((s, o) => s + o.balance, 0));
  assert.equal(aging.totals.recorded_debt.total, 18000, '10,000 + 5,000 + 3,000');
});

/* ================= the dry-run repair ================= */

function gsWorld(cycles, patients) {
  const g = loadGs();
  const cols = (name) => Array.from(g.run(name));
  const sheet = (name, columns, list) => {
    const sh = richSheet(name, columns);
    list.forEach((o) => sh.grid.push(columns.map((c) => (o[c] === undefined ? '' : o[c]))));
    g.sandbox.__sheets[name] = sh;
    return sh;
  };
  sheet('Patients', cols('PATIENT_COLUMNS'), patients);
  const pay = sheet('Payments', cols('PAYMENT_COLUMNS'), cycles);
  return { g, pay, PAY_COLS: cols('PAYMENT_COLUMNS') };
}

test('repairStaleCycleAmountsNow: DRY RUN by default — plans only the stale stamps, writes nothing', () => {
  const { g, pay, PAY_COLS } = gsWorld(CYCLES, Object.values(P));
  const before = JSON.stringify(pay.grid);
  const res = plain(g.run('repairStaleCycleAmountsNow()'));
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.plan.map((x) => [x.row, x.patientName, x.fromAmount, x.toAmount, x.toStatus, x.toBalance]), [
    [4, 'אליהו חן', 33000, 30000, 'paid', 0],
    [5, 'שחר חיון', 35000, 32000, 'paid', 0],
  ]);
  assert.equal(JSON.stringify(pay.grid), before, 'not one cell written');
  assert.equal(g.sandbox.__sheets.AuditLog, undefined, 'no audit row');
  assert.equal(pay.grid[0].indexOf('amount'), PAY_COLS.indexOf('amount'));
});

test('repairStaleCycleAmountsNow(true): rewrites amount / balance / status of the planned rows only, audited; re-checks under the lock', () => {
  const { g, pay, PAY_COLS } = gsWorld(CYCLES, Object.values(P));
  const c = (k) => PAY_COLS.indexOf(k);
  // A row that moved since the plan is skipped: change שחר's amountPaid under it.
  const origRun = g.sandbox.recCollect_;
  g.sandbox.recCollect_ = () => { const out = origRun(); pay.grid[4][c('amountPaid')] = 32500; return out; };
  const res = plain(g.run('repairStaleCycleAmountsNow(true)'));
  assert.equal(res.dryRun, false);
  assert.deepEqual(res.rewritten.map((x) => x.patientName), ['אליהו חן']);
  assert.deepEqual(res.skipped.map((x) => [x.row, x.reason]), [[5, 'changed_since_plan']]);
  const eli = pay.grid[3];
  assert.deepEqual([eli[c('amount')], eli[c('balance')], eli[c('status')], eli[c('amountPaid')]], [30000, 0, 'paid', 30000]);
  const shahar = pay.grid[4];
  assert.deepEqual([shahar[c('amount')], shahar[c('status')]], [35000, 'partial'], 'skipped row untouched');
  const audit = g.sandbox.__sheets.AuditLog.grid.slice(1).filter((r) => r[1] === 'cycle_amount_repaired');
  assert.equal(audit.length, 1);
  assert.match(audit[0][5], /"fromAmount":33000,"toAmount":30000/);
});

test('the repair never touches an ambiguous owner, a genuine partial, a void or a receipt', () => {
  const twin = Object.assign({}, P.eliyahu, { id: 'id-twin' });
  const rows = CYCLES.map((x) => Object.assign({}, x, { patientUid: '' })).concat([
    Object.assign(cyc(P.shahar, '2026-09-07', 35000, 'void', 0), { patientUid: P.shahar.id }),
    Object.assign(cyc(P.shahar, '2026-10-07', 32000, 'paid', 32000), { id: 'rcpt-x', patientUid: P.shahar.id }),
  ]);
  const { g } = gsWorld(rows, Object.values(P).concat([twin]));
  const plan = plain(g.run('repairStaleCycleAmountsNow()')).plan;
  assert.deepEqual(plan.map((x) => x.patientName), ['שחר חיון'], 'אליהו חן has two namesakes → refused; others are genuine or not open');
});

/* ================= wiring ================= */

test('wiring: /cycle-balance.js is served like the other lib rules, loaded before app.js, hashed by the SW; SW v61', () => {
  const SERVER = read('server.js'), INDEX = read('public', 'index.html'), SW = read('public', 'sw.js'), APP = read('public', 'app.js');
  assert.match(SERVER, /'\/cycle-balance\.js': \{ file: path\.join\(__dirname, 'lib', 'cycle-balance\.js'\)/);
  assert.match(SERVER, /app\.get\('\/cycle-balance\.js', sendLibAsset\('\/cycle-balance\.js'\)\);/);
  assert.ok(INDEX.indexOf('cycle-balance.js?v=__BUILD__') > 0);
  assert.ok(INDEX.indexOf('cycle-balance.js?v=__BUILD__') < INDEX.indexOf('app.js?v=__BUILD__'));
  assert.match(SW, /var BUNDLE_PATHS = \[[^\]]*'\/cycle-balance\.js'[^\]]*\]/);
  assert.equal(/var CACHE_VERSION = '(v\d+)';/.exec(SW)[1], 'v61');
  assert.doesNotMatch(read('lib', 'cycle-balance.js'), /fetch\(|require\(|Date\.now|new Date\(\)/, 'pure: no I/O, no clock');
  // ONE rule: every money screen goes through cycleView.
  for (const [fn, re] of [['paymentForPatientOnDate', /cycleView\(existing, patient\)/], ['renderBillingOpenList', /cycleView\(rawPay, matched\)/],
    ['renderBillingMonthlySummary', /cycleView\(p, findPatientForPayment\(p\)\)/], ['patientPaymentState', /cycleView\(pay, patient\)/],
    ['openDebtPatientIds', /cycleView\(pay, hit\)/]]) {
    const i = APP.indexOf('function ' + fn + '(');
    assert.match(APP.slice(i, APP.indexOf('\n}\n', i)), re, fn);
  }
  // Shared revenue rules are untouched: buildMonthlyRevenue does not use it.
  const i = APP.indexOf('function buildMonthlyRevenue(');
  assert.doesNotMatch(APP.slice(i, APP.indexOf('\n}\n', i)), /cycleView|CycleBalance/);
});

/* ================= underStamped — the silent-underpayment gap ================= */

test('underStamped: stamped 28,000 / agreed 30,000 / paid 28,000 → «שולם» + underStamped gap 2,000', () => {
  assert.deepEqual(R.cycleState({ stampedAmount: 28000, agreedPrice: 30000, amountPaid: 28000, status: 'paid' }),
    { expected: 28000, source: 'settled', paid: 28000, balance: 0, status: 'paid', underStamped: true, priceExpected: 30000, gap: 2000 });
  // An override is the price too.
  assert.equal(R.cycleState({ stampedAmount: 28000, overrideAmount: 29000, agreedPrice: 25000, amountPaid: 28000, status: 'partial' }).gap, 1000);
});

test('underStamped: stamped 30,000 / agreed 28,000 / paid 30,000 → «שולם», no flag', () => {
  const st = R.cycleState({ stampedAmount: 30000, agreedPrice: 28000, amountPaid: 30000, status: 'paid' });
  assert.deepEqual(st, { expected: 30000, source: 'settled', paid: 30000, balance: 0, status: 'paid' });
  assert.equal(st.underStamped, undefined);
  // Equal price: no flag. Open cycles never carry it (they owe the price instead).
  assert.equal(R.cycleState({ stampedAmount: 30000, agreedPrice: 30000, amountPaid: 30000, status: 'paid' }).underStamped, undefined);
  assert.equal(R.cycleState({ stampedAmount: 28000, agreedPrice: 30000, amountPaid: 20000, status: 'partial' }).underStamped, undefined);
});

test('parity covers the flag: the grid hits underStamped and Code.gs agrees on every field', () => {
  const g = loadGs();
  let flagged = 0;
  for (const stampedAmount of [0, 25000, 28000, 30000]) for (const agreedPrice of [null, 28000, 30000, 33000])
    for (const overrideAmount of [null, 29000]) for (const status of ['paid', 'partial'])
      for (const amountPaid of [25000, 28000, 30000]) {
        const input = { stampedAmount, agreedPrice, overrideAmount, status, amountPaid };
        g.sandbox.__i = input;
        const a = plain(R.cycleState(input));
        assert.deepEqual(plain(g.run('cycleBalanceState_(globalThis.__i)')), a, JSON.stringify(input));
        if (a.underStamped) { flagged++; assert.equal(a.status, 'paid'); assert.equal(a.balance, 0); assert.ok(a.gap > 0); }
      }
  assert.ok(flagged > 10, 'flagged ' + flagged);
});

const UNDER = [
  { id: 'id-u1', houseId: 'ramot', name: 'דנה לוי', date: '2026-09-05', pay: 30000, status: 'active' },
];
const UNDER_CYCLE = cyc(UNDER[0], '2026-09-05', 28000, 'paid', 28000, ['2026-09-05', '2026-10-04']);

test('debtAging_ lists underStamped cycles (never in totals); בקרת גבייה shows them to Ortal AND in Sandra\'s exceptions', () => {
  const g = loadGs();
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  g.sandbox.__t = { patients: rows(Object.values(P).concat(UNDER)), payments: rows(CYCLES.concat([UNDER_CYCLE])), credits: rows([]), overrides: rows([]) };
  const aging = plain(g.run(`debtAging_('${TODAY}', globalThis.__t)`));
  assert.deepEqual(aging.underStamped.rows.map((r) => [r.name, r.houseId, r.start, r.end, r.stamped, r.expected, r.gap]),
    [['דנה לוי', 'ramot', '2026-09-05', '2026-10-04', 28000, 30000, 2000]]);
  assert.equal(aging.totals.recorded_debt.total, 18000, 'the gap is NOT debt');
  g.sandbox.__aging = aging;
  for (const approver of [false, true]) {
    g.sandbox.__o = { todayIso: TODAY, approver, aging };
    const q = plain(g.run('billingControlQueueFor_([], {}, globalThis.__o)'));
    assert.deepEqual(q.underStamped.map((r) => [r.patientName, r.houseId, r.start, r.end, r.stamped, r.expected, r.gap]),
      [['דנה לוי', 'ramot', '2026-09-05', '2026-10-04', 28000, 30000, 2000]], 'every billing-control session');
    if (approver) assert.equal(q.exceptions.underStamped.length, 1, 'Sandra\'s read-only exceptions');
    else assert.equal(q.exceptions, undefined, 'Ortal: no exceptions block, but the list above');
  }
});

test('בקרת גבייה UI: «שולם מתחת למחיר» — patient, house, cycle, stamped, expected, gap; escaped; read-only; never hidden', () => {
  const p = page(CYCLES, Object.values(P));
  const html = p.call('bcUnderStampedHtml', [{ patientName: '<b>דנה</b>', houseId: 'ramot', start: '2026-09-05', end: '2026-10-04', stamped: 28000, expected: 30000, gap: 2000 }]);
  for (const s of ['&lt;b&gt;דנה&lt;/b&gt;', 'רמות השבים', '05/09/2026', '04/10/2026', 'חויב', 'לפי המחיר', 'פער']) assert.ok(html.includes(s), s);
  for (const n of [28000, 30000, 2000]) assert.ok(html.includes(p.call('fmtShekel', n)), String(n));
  assert.doesNotMatch(html, /<button|<input|<select/, 'read-only');
  assert.match(p.call('bcUnderStampedHtml', []), /אין מחזורים ששולמו מתחת למחיר/);
  const ex = p.call('bcExceptionsHtml', { underStamped: [{ patientName: 'דנה', houseId: 'ramot', start: '2026-09-05', stamped: 28000, expected: 30000, gap: 2000 }] });
  assert.match(ex, /שולם מתחת למחיר <span class="count-pill">1<\/span>/);
  const INDEX = read('public', 'index.html');
  const grp = INDEX.slice(INDEX.indexOf('data-group="bc-understamped"') - 80, INDEX.indexOf('id="bc-understamped"') + 40);
  assert.ok(grp.includes('id="bc-understamped"') && !/hidden/.test(grp.split('\n')[1] || ''), 'always visible in the tab');
  const APP = read('public', 'app.js');
  const i = APP.indexOf('function renderBillingControl(');
  assert.match(APP.slice(i, APP.indexOf('\n}\n', i)), /set\('bc-understamped', bcUnderStampedHtml\(under\)\)/);
});

test('repairStaleCycleAmountsNow never touches an underStamped row — dry run lists it as «needs human decision»', () => {
  const rows = CYCLES.concat([UNDER_CYCLE]);
  const { g, pay, PAY_COLS } = gsWorld(rows, Object.values(P).concat(UNDER));
  const logs = [];
  g.sandbox.console.log = (m) => logs.push(String(m));
  const dry = plain(g.run('repairStaleCycleAmountsNow()'));
  assert.deepEqual(dry.plan.map((x) => x.patientName), ['אליהו חן', 'שחר חיון']);
  assert.deepEqual(dry.underStamped.map((x) => [x.row, x.patientName, x.stamped, x.expected, x.gap]), [[7, 'דנה לוי', 28000, 30000, 2000]]);
  assert.ok(logs.some((l) => /NEEDS HUMAN DECISION — row 7 דנה לוי/.test(l)), 'logged apart');
  const before = JSON.stringify(pay.grid[6]);
  const res = plain(g.run('repairStaleCycleAmountsNow(true)'));
  assert.ok(!res.rewritten.some((x) => x.row === 7));
  assert.equal(JSON.stringify(pay.grid[6]), before, 'the under-stamped row is untouched');
  assert.equal(pay.grid[6][PAY_COLS.indexOf('status')], 'paid');
});

/* ================= Vered's in-app price path (patient ✏️ → «תשלום חודשי») ================= */

function setPay(p, id, pay) {
  p.run(`state.patients.find(x => x.id === ${JSON.stringify(id)}).pay = ${Number(pay)}`);
}
const yinonDue = (p) => p.call('paymentForPatientOnDate', p.run(`state.patients.find(x => x.id === '${P.yinon.id}')`), '2026-09-23');

test('editing the agreed price recomputes the open cycle everywhere — new price = paid → balance 0, «שולם»', () => {
  const p = page(CYCLES, Object.values(P));
  assert.deepEqual([yinonDue(p).balance, yinonDue(p).status], [5000, 'partial'], 'left OPEN today (121): price unknown');
  setPay(p, P.yinon.id, 25000);   // Vered corrects the price to what was paid
  const v = yinonDue(p);
  assert.deepEqual([v.amount, v.balance, v.status], [25000, 0, 'paid']);
  const st = plain(p.call('patientPaymentState', p.run(`state.patients.find(x => x.id === '${P.yinon.id}')`), p.run('state.payments'), null, TODAY));
  assert.equal(st.key, 'paid', '«מטופלים» card');
  assert.ok(!openBalances(p, TODAY).some((o) => o.name === 'ינון כהן'), 'off «יתרות פתוחות»');
  const row = p.call('buildBillingRow', p.run(`state.patients.find(x => x.id === '${P.yinon.id}')`), v, '2026-09-23', true);
  assert.ok(!row.innerHTML.includes('bill-report-btn'), 'no «דווח תשלום»');
});

test('editing the price can also create / grow a balance on an open cycle, and never reopens a settled one', () => {
  const p = page(CYCLES, Object.values(P));
  setPay(p, P.yinon.id, 27000);
  assert.deepEqual([yinonDue(p).balance, yinonDue(p).status], [2000, 'partial']);
  setPay(p, P.yinon.id, 32000);
  assert.deepEqual([yinonDue(p).balance, yinonDue(p).status], [7000, 'partial']);
  // טמיר (133): the same path.
  setPay(p, P.tamir.id, 30000);
  const t = p.call('paymentForPatientOnDate', p.run(`state.patients.find(x => x.id === '${P.tamir.id}')`), '2026-09-27');
  assert.deepEqual([t.balance, t.status], [0, 'paid']);
  // A SETTLED cycle (שחר חיון's paid September) is never reopened by a later price.
  const settled = cyc(P.shahar, '2026-09-07', 35000, 'paid', 35000);
  const q = page([settled], [Object.assign({}, P.shahar)]);
  setPay(q, P.shahar.id, 40000);
  const s = q.call('paymentForPatientOnDate', q.run(`state.patients[0]`), '2026-09-07');
  assert.deepEqual([s.amount, s.balance, s.status], [35000, 0, 'paid']);
});

test('the ✏️ save re-renders גבייה / «מטופלים» at once and re-reads בקרת גבייה after a price change', () => {
  const APP = read('public', 'app.js');
  const i = APP.indexOf('function openEditPatientModal(');
  const body = APP.slice(i, APP.indexOf('\n}\n', i));
  assert.match(body, /name: 'pay', label: 'תשלום חודשי \(₪\)'/);
  assert.match(body, /p\.pay\s+= Number\(v\.pay\) \|\| 0;[\s\S]*renderAll\(\);[\s\S]*saveAll\(/, 'optimistic re-render before the save');
  assert.match(body, /if \(prev\.pay !== p\.pay\) refreshBillingControlAfterPriceChange\(\);/);
  const ra = APP.slice(APP.indexOf('function renderAll('), APP.indexOf('\n}\n', APP.indexOf('function renderAll(')));
  for (const fn of ['renderBilling()', 'renderPatientsTab()', 'renderBillingControl()']) assert.ok(ra.includes(fn), fn);
  // The refresh only runs when בקרת גבייה was loaded for this session.
  const p = page(CYCLES, Object.values(P));
  let calls = 0;
  p.sandbox.__count = () => { calls++; return Promise.resolve(); };
  p.run('loadBillingControl = () => globalThis.__count()');
  p.run('refreshBillingControlAfterPriceChange()');
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(calls, 0, 'not loaded → no request');
    p.run('billingControlState().data = { receipts: [] }');
    p.run('refreshBillingControlAfterPriceChange()');
    return new Promise((r) => setImmediate(r));
  }).then(() => assert.equal(calls, 1));
});

test('a price change is audited: who, when, old price → new price', () => {
  const { g } = gsWorld([], []);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = g.sandbox.__sheets.Patients;
  const pt = { houseId: 'rehab', name: 'ינון כהן', date: '2026-06-23', pay: 30000, adv: 0, status: 'active', id: 'id-ad890dc0', updatedAt: '', updatedBy: '' };
  sh.grid.push(cols.map((c) => (pt[c] === undefined ? '' : pt[c])));
  g.sandbox.__p = { rehab: [Object.assign({}, pt, { pay: 25000 })] };
  g.run(`saveAll_(null, globalThis.__p, 'ורד')`);
  const audit = g.sandbox.__sheets.AuditLog.grid.slice(1).find((r) => r[1] === 'patient_edited');
  assert.ok(audit, 'patient_edited row');
  const d = JSON.parse(audit[5]);
  assert.deepEqual(d.price, { from: 30000, to: 25000 });
  assert.equal(d.updatedBy, 'ורד');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(audit[0])), 'when');
  assert.deepEqual(d.changed, ['pay']);
});

test('never hidden: an underStamped cycle outside the recorded stay or before the records cutoff is still listed (live Payments 59 shape)', () => {
  const g = loadGs();
  const aviad = { id: 'id-12d6739f', houseId: 'rehab', name: 'אביעד חביבאן', date: '2026-07-08', pay: 35000, status: 'released', exitDate: '2026-07-14' };
  const old = { id: 'id-old', houseId: 'sde', name: 'ותיק', date: '2026-05-02', pay: 32000, status: 'active' };
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  g.sandbox.__t = {
    patients: rows([aviad, old]),
    payments: rows([cyc(aviad, '2026-08-16', 30000, 'paid', 30000), cyc(old, '2026-06-02', 30000, 'paid', 30000)]),
    credits: rows([]), overrides: rows([]),
  };
  const aging = plain(g.run(`debtAging_('${TODAY}', globalThis.__t)`));
  assert.deepEqual(aging.underStamped.rows.map((r) => [r.name, r.start, r.gap, r.outsideStay]),
    [['אביעד חביבאן', '2026-08-16', 5000, true], ['ותיק', '2026-06-02', 2000, false]]);
  g.sandbox.__o = { todayIso: TODAY, approver: false, aging };
  const q = plain(g.run('billingControlQueueFor_([], {}, globalThis.__o)'));
  assert.equal(q.underStamped.length, 2);
  const p = page([], []);
  assert.match(p.call('bcUnderStampedHtml', q.underStamped), /מחוץ לתקופת השהייה הרשומה/);
});
