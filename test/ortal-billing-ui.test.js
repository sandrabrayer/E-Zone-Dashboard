/* Ortal billing — the user-facing PR (PR 2). CHANGELOG-ortal-billing-ui.md.
 *
 * Code.gs (real file in a vm): the queue carries `problems` (owed cycles with
 * their discount key, discounts given) ONLY for accountant / approver;
 * Sandra's exceptions list every void and every discount with who / why.
 * app.js (real file in a vm): the reason / discount checks, the problems
 * model, the HTML (buttons by permission, «הנחה» chip, escaping), Sandra's
 * list; the page wiring and the SW bump. All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-TEST-ortal-billing-ui-0123456789abcdef';
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const gsActor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller', 'accountant'], ['billingControl']);
const ORTAL_NO_ACCT = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);

const PKEY = 'arfoni::דנה כהן::2026-09-15';
const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: PKEY,
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const COV = { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' };

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  S.Leads = richSheet('Leads', arr(g.run('LEAD_COLUMNS')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportPay = (amount, receivedDate) => call({ action: 'reportPayment', report: { cycle: CYCLE, report: Object.assign({
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + amount, funder: 'פרטי', invoiceWanted: 'no',
  }, COV) } });
  const queue = (who) => call({ action: 'billingControlQueue' }, who || ORTAL);
  return { g, call, reportPay, queue };
}

/* ============================ Code.gs ============================ */

test('queue: `problems` only for accountant / approver — owed cycles carry the discount key; Vered and Ortal without the role get none', () => {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(2)).ok, true);
  assert.ok(!('problems' in w.queue(ORTAL_NO_ACCT)), 'no problems list without the role');
  assert.ok('problems' in w.queue(VERED), 'Vered gets the list so she can give the discount');
  const q = w.queue(ORTAL);
  assert.equal(q.problems.complete, true);
  const sep = q.problems.cycles.find((c) => c.start === '2026-09-15');
  assert.deepEqual([sep.patientKey, sep.month, sep.balance, sep.kind, sep.discount], [PKEY, '2026-09', 20000, 'recorded', 0]);
  assert.ok(q.problems.cycles.some((c) => c.start === '2026-10-15' && c.kind === 'unrecorded'));
  assert.ok('problems' in w.queue(SANDRA));
  // After a discount the cycle carries it, and a full discount removes the cycle.
  assert.equal(w.call({ action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-09', discountAmount: 5000, discountReason: 'הנחה' } }, VERED).ok, true);
  assert.equal(w.call({ action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-10', discountAmount: 30000, discountReason: 'פטור' } }, VERED).ok, true);
  const q2 = w.queue(ORTAL);
  const sep2 = q2.problems.cycles.find((c) => c.start === '2026-09-15');
  assert.deepEqual([sep2.expected, sep2.balance, sep2.discount], [25000, 15000, 5000]);
  assert.ok(!q2.problems.cycles.some((c) => c.start === '2026-10-15'), 'fully discounted: never debt');
  assert.deepEqual(q2.problems.discounts.map((d) => [d.patientName, d.houseId, d.month, d.amount, d.by]).sort(),
    [['דנה כהן', 'arfoni', '2026-09', 5000, 'ורד'], ['דנה כהן', 'arfoni', '2026-10', 30000, 'ורד']]);
  // The follow-up queue still never carries a patient key.
  assert.ok(!JSON.stringify(q2.followup).includes(PKEY));
});

test('queue: Sandra\'s exceptions list every void and every discount with who / why; nobody else gets them', () => {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(2)).ok, true);
  const id = w.queue().receipts[0].id;
  assert.equal(w.call({ action: 'confirmPayment', confirm: { ids: [id], status: 'not_received', flagNote: 'לא הגיע לבנק' } }, ORTAL).ok, true);
  assert.equal(w.call({ action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-09', discountAmount: 1500, discountReason: 'הסדר' } }, VERED).ok, true);
  const ex = w.queue(SANDRA).exceptions;
  assert.deepEqual(ex.voids.map((v) => [v.id, v.receipt, v.amount, v.kind, v.reason, v.by]), [[id, true, 10000, 'not_received', 'לא הגיע לבנק', 'אורטל']]);
  assert.deepEqual(ex.discounts.map((d) => [d.patientName, d.month, d.amount, d.reason, d.by]), [['דנה כהן', '2026-09', 1500, 'הסדר', 'ורד']]);
  for (const who of [ORTAL, VERED]) assert.ok(!('exceptions' in w.queue(who)));
  assert.deepEqual(ex.discounts.map((d) => d.by), ['ורד'], 'the discount names Vered');
});

/* ============================ app.js ============================ */

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const LIB_SRCS = ['payment-report-rules.js', 'billing-control-rules.js', 'cycle-balance.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'))
  .concat([fs.readFileSync(path.join(ROOT, 'public', 'funder.js'), 'utf8')]);
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
      getElementById: () => null, createElement: () => ({}), querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const src of LIB_SRCS) vm.runInContext(src, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      get state() { return state; },
      bcReasonCheck, bcNotReceivedCheck, bcDiscountCheck, bcDiscountChipHtml, bcProblemsModel, bcProblemsHtml,
      bcDiscountRowsHtml, bcReceiptHtml, bcVoidRowsHtml, debtAmountCheck, debtCycleActionsHtml, debtCycleCardHtml, funderFillDebtHtml, funderFillHtml,
      revenueByFunder, revenueByFunderHtml, bcRules, bcExceptionsHtml, applySessionInfo, confirmReceipts, saveBillingDiscount,
      set apiPost(f) { apiPost = f; }, set showToast(f) { showToast = f; }, set showError(f) { showError = f; },
      set loadBillingControl(f) { loadBillingControl = f; }, billingControlState,
    };`, sandbox);
  return sandbox.__test;
}

test('checks: «לא שולם — בטל תביעה» reason 2–120 (refused, never cut); «הנחה» amount 0 < x ≤ 1,000,000 + reason 2–120', () => {
  const app = loadApp();
  assert.deepEqual(plain(app.bcNotReceivedCheck('  =לא הגיע\n')), { note: 'לא הגיע', error: '' });
  for (const bad of ['', 'א', '==', 'א'.repeat(121), null]) assert.ok(app.bcNotReceivedCheck(bad).error, JSON.stringify(bad));
  assert.equal(app.bcNotReceivedCheck('א'.repeat(120)).error, '');
  assert.deepEqual(plain(app.bcDiscountCheck('1,500.5', 'הנחת משפחה')), { amount: 1500.5, reason: 'הנחת משפחה', error: '' });
  for (const amt of ['', '0', '-1', 'abc', '1.234', '1000000.01', '1e3']) assert.ok(app.bcDiscountCheck(amt, 'סיבה').error, amt);
  assert.equal(app.bcDiscountCheck('1000000', 'סיבה').amount, 1000000);
  assert.match(app.bcDiscountCheck('100', 'א').error, /סיבה/);
});

const DATA = {
  receipts: [
    { id: 'rcpt-1', patientName: 'דנה כהן', houseId: 'arfoni', amount: 10000, confirmStatus: 'reported', receivedDate: '2026-10-20' },
    { id: 'rcpt-2', patientName: '<img src=x onerror=alert(1)>', houseId: 'asher', amount: 500, confirmStatus: 'flagged', receivedDate: '2026-10-01' },
    { id: 'rcpt-3', patientName: 'רון לוי', houseId: 'asher', amount: 900, confirmStatus: 'confirmed', receivedDate: '2026-10-01' },
  ],
  problems: {
    complete: true,
    cycles: [
      { patientName: 'דנה כהן', houseId: 'arfoni', patientKey: 'arfoni::דנה כהן::2026-09-15', month: '2026-09', start: '2026-09-15',
        kind: 'recorded', expected: 25000, balance: 15000, discount: 5000, days: 37 },
    ],
    discounts: [{ patientName: 'דנה כהן', houseId: 'arfoni', month: '2026-10', amount: 30000, reason: '<b>פטור</b>', by: 'אורטל', at: '2026-10-22 10:00' }],
  },
};

test('model: one entry per patient — unconfirmed receipts (waiting / «לא שולם») and owed cycles; confirmed receipts are not problems', () => {
  const app = loadApp();
  const m = plain(app.bcProblemsModel(DATA));
  assert.equal(m.complete, true);
  assert.deepEqual(m.patients.map((p) => [p.name, p.receipts.map((r) => r.id), p.cycles.length]),
    [['דנה כהן', ['rcpt-1'], 1], ['<img src=x onerror=alert(1)>', ['rcpt-2'], 0]], 'the oldest problem first');
  assert.equal(app.bcProblemsModel({ receipts: [] }).patients.length, 0);
  assert.equal(app.bcProblemsModel({ receipts: [], problems: { cycles: [{ balance: 0, patientName: 'x' }] } }).patients.length, 0, 'a settled cycle is no problem');
});

test('html: Ortal gets confirm + cancel on reported amounts and NO discount button; Vered gets the discount button; the chip; everything escaped', () => {
  const app = loadApp();
  const m = app.bcProblemsModel(DATA);
  const html = app.bcProblemsHtml(m, { state: {}, canConfirm: true, canAccount: true });
  assert.match(html, /data-bc-pr-confirm="rcpt-1">שולם - אשר</);
  assert.match(html, /data-bc-nr-open="rcpt-1"[^>]*>הסכום שדווח שגוי - בטל</);
  assert.ok(!/data-bc-disc-open/.test(html), 'Ortal gives no discount');
  const vered = app.bcProblemsHtml(m, { state: {}, canConfirm: false, canAccount: false, canDiscount: true });
  assert.match(vered, /data-bc-disc-open="arfoni::דנה כהן::2026-09-15\|2026-09"[^>]*>הנחה</);
  assert.ok(!/data-bc-(pr-confirm|nr-open)/.test(vered), 'Vered neither confirms nor cancels here');
  // Two subsections with counts; the unpaid-cycle subsection has no cancel/confirm buttons.
  assert.match(html, /סכומים שדווחו וממתינים לאימות <span class="count-pill">2</);
  assert.match(html, /מחזורים שלא שולמו ולא דווח עליהם תשלום — מינואר, מהחדש לישן <span class="count-pill">1</);
  const cyclesPart = html.slice(html.indexOf('מחזורים שלא שולמו'));
  assert.ok(!/<button/.test(cyclesPart), 'no buttons on unpaid cycles unless she may change the amount');
  assert.match(html, /«הנחה» ₪\s?5,000 · לתשלום ₪\s?25,000/);
  assert.ok(!html.includes('<img'), 'a name is never markup');
  assert.ok(html.includes('&lt;img'));
  const none = app.bcProblemsHtml(m, { state: {}, canConfirm: false, canAccount: false });
  assert.ok(!/data-bc-(pr-confirm|nr-open|disc-open)/.test(none), 'no button without the permission');
  // The forms open one at a time, with a required-reason label.
  const nr = app.bcProblemsHtml(m, { state: { nrOpen: 'rcpt-1', nrDraft: '<x>' }, canConfirm: true, canAccount: true });
  assert.match(nr, /data-bc-nr-save="rcpt-1"/);
  assert.match(nr, /2 עד 120 תווים/);
  assert.ok(nr.includes('&lt;x&gt;') && !nr.includes('<x>'));
  const disc = app.bcProblemsHtml(m, { state: { discOpen: 'arfoni::דנה כהן::2026-09-15|2026-09' }, canConfirm: false, canAccount: false, canDiscount: true });
  assert.match(disc, /data-bc-disc-save=/);
  assert.match(disc, /data-bc-disc-amount=/);
  assert.equal(app.bcDiscountChipHtml(0), '');
  const empty = app.bcProblemsHtml(app.bcProblemsModel({ receipts: [] }), {});
  assert.match(empty, /אין סכומים שממתינים לאימות/);
  assert.match(empty, /אין מחזורים פתוחים/);
});

test('Sandra\'s read-only list: «ביטולים» and «הנחות» with who / why, escaped, no button', () => {
  const app = loadApp();
  const html = app.bcExceptionsHtml({
    voids: [{ id: 'rcpt-9', patientName: 'דנה כהן', houseId: 'arfoni', amount: 10000, kind: 'not_received', reason: '<script>x</script>', by: 'אורטל', at: '2026-10-22 09:00' }],
    discounts: DATA.problems.discounts,
  });
  assert.match(html, /ביטולים <span class="count-pill">1/);
  assert.match(html, /הנחות <span class="count-pill">1/);
  assert.match(html, /לא שולם — תביעה בוטלה/);
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert.ok(html.includes('&lt;b&gt;פטור') && html.includes('אורטל'));
  assert.ok(!/<button/.test(html), 'read-only');
});

test('actions: the void sends status not_received + the reason; the discount sends the cycle key and is proven before it is applied', async () => {
  const app = loadApp();
  const posts = []; const posts0 = () => posts.length;
  app.showToast = () => {}; const errors = []; app.showError = (e) => errors.push(e);
  app.applySessionInfo({ auth: 'personal', user: 'ורד', canConfirm: false, canAccount: false, canDiscount: true, view: 'full' });
  assert.equal(app.state.canDiscount, true);
  app.applySessionInfo({ auth: 'personal', user: 'אורטל', canConfirm: true, canAccount: true, canDiscount: false, view: 'controller' });
  assert.equal(app.state.canAccount, true);
  assert.equal(app.state.canDiscount, false);
  assert.equal(await app.saveBillingDiscount('k', '2026-09', 1, 'rr'), null, 'Ortal: nothing sent');
  assert.equal(posts0(), 0);
  assert.equal(errors.length, 1, 'refused with the role message'); errors.length = 0;
  app.loadBillingControl = async () => {};
  app.apiPost = async (b) => {
    posts.push(JSON.parse(JSON.stringify(b)));
    if (b.action === 'confirmPayment') return { ok: true, changed: [], voided: [{ id: 'rcpt-1' }] };
    return { ok: true, changed: true, override: { id: 'ovr::k::2026-09', patientId: 'k', month: '2026-09', amount: '', discountAmount: 5000, discountReason: 'r', discountBy: 'ורד', discountAt: 't' } };
  };
  app.billingControlState().data = { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] };
  await app.confirmReceipts(['rcpt-1'], 'not_received', { flagNote: 'לא הגיע' });
  assert.deepEqual(posts[0], { action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'not_received', flagNote: 'לא הגיע' } });
  app.applySessionInfo({ auth: 'personal', user: 'ורד', canConfirm: false, canAccount: false, canDiscount: true, view: 'full' });
  await app.saveBillingDiscount('k', '2026-09', 5000, 'r');
  assert.deepEqual(posts[1], { action: 'setBillingDiscount', discount: { patientId: 'k', month: '2026-09', discountAmount: 5000, discountReason: 'r' } });
  assert.equal(app.state.billingOverrides.find((o) => o.id === 'ovr::k::2026-09').discountAmount, 5000);
  assert.deepEqual(errors, []);
  // Unproven answer → nothing applied, an error shown.
  app.apiPost = async () => ({ ok: true, override: { patientId: 'other', month: '2026-09' } });
  assert.equal(await app.saveBillingDiscount('k2', '2026-09', 1, 'rr'), null);
  assert.equal(errors.length, 1);
  // Without the permission nothing is sent.
  app.applySessionInfo({ auth: 'personal', user: 'ורד', canConfirm: false, canAccount: false, canDiscount: false, view: 'full' });
  const n = posts.length;
  assert.equal(await app.saveBillingDiscount('k', '2026-09', 1, 'rr'), null);
  assert.equal(posts.length, n);
});

test('page wiring: the hidden «בעיות גבייה» section, the billing-row chip, the CSS and SW v86', () => {
  assert.match(HTML, /<div id="bc-problems-group" class="[^"]*hidden"/);
  for (const id of ['bc-problems-count', 'bc-problems', 'bc-discounts-given']) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.match(APP_SRC, /!isVoid && payment\.discount > 0 \? bcDiscountChipHtml\(payment\.discount\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'), /\.badge\.discount \{/);
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  assert.equal(v, 'v86');
  assert.notEqual(v, 'v17');
});

test('layout: queue rows get «הסכום שדווח שגוי - בטל» only when unconfirmed and canAccount; confirmed / partial never', () => {
  const app = loadApp();
  app.applySessionInfo({ auth: 'personal', user: 'אורטל', canConfirm: true, canAccount: true, canDiscount: false, view: 'controller' });
  const r = (st) => ({ id: 'rcpt-7', patientName: 'דנה', houseId: 'arfoni', amount: 100, confirmStatus: st, receivedDate: '2026-10-01' });
  for (const [mode, st, want] of [['queue', 'reported', true], ['flagged', 'flagged', true], ['confirmed', 'confirmed', false], ['partial', 'partial', false]]) {
    const html = app.bcReceiptHtml(r(st), mode);
    assert.equal(/data-bc-nr-open="rcpt-7"/.test(html), want, mode);
  }
  app.applySessionInfo({ auth: 'personal', user: 'ורד', canConfirm: false, canAccount: false, canDiscount: true, view: 'full' });
  assert.ok(!/data-bc-nr-open/.test(app.bcReceiptHtml(r('reported'), 'queue')), 'Vered: no cancel');
});

test('layout: the accountant tab hides releases / committees and puts «בעיות גבייה» first; the race fix redraws on a late /api/me', () => {
  assert.match(APP_SRC, /if \(typeof state !== 'undefined' && state\.canAccount === true\) \{\n\s+\[card, document\.getElementById\('upcoming-committees'\)\]/);
  assert.match(APP_SRC, /accessChanged/);
  assert.match(APP_SRC, /if \(accessChanged && state\.currentScreen === 'billing-control'\) renderBillingControl\(\)/);
  assert.match(APP_SRC, /\(state\.canAccount === true \|\| state\.canDiscount === true\) && !!s\.data\.problems/);
});

/* ===================== CHANGELOG-open-debts-cleanup.md ===================== */

const DEBT_P = { patientKey: 'arfoni::דנה כהן::2026-07-01', patientId: 'pid-1', name: 'דנה כהן', houseId: 'arfoni' };
const DEBT_C = { kind: 'recorded', month: '2026-09', start: '2026-09-15', end: '2026-10-14', expected: 30000, received: 0, balance: 30000, paymentId: 'pay-9' };

test('debt amount: a real amount (up to 2 decimals, 1,000,000 max); nothing else', () => {
  const app = loadApp();
  assert.deepEqual(plain(app.debtAmountCheck('25000')), { amount: 25000, error: '' });
  assert.deepEqual(plain(app.debtAmountCheck(' 1500.5 ')), { amount: 1500.5, error: '' });
  assert.equal(app.debtAmountCheck('0').amount, 0);
  for (const bad of ['', 'abc', '-5', '1e3', '1.234', '1000000.01', '12345678', null]) assert.ok(app.debtAmountCheck(bad).error, JSON.stringify(bad));
});

test('debt actions: «שולם» only with pay, «שנה סכום» only with amount and nothing received; none → nothing; every value escaped', () => {
  const app = loadApp();
  assert.equal(app.debtCycleActionsHtml(DEBT_P, DEBT_C, {}), '');
  const both = app.debtCycleActionsHtml(DEBT_P, DEBT_C, { pay: true, amount: true });
  assert.match(both, /data-debt-pay>שולם</);
  assert.match(both, /data-debt-amt-open>שנה סכום</);
  assert.match(both, /data-debt-pk="arfoni::דנה כהן::2026-07-01"/);
  assert.match(both, /data-debt-month="2026-09"/);
  assert.match(both, /data-debt-payid="pay-9"/);
  assert.match(both, /value="30000"/);
  const payOnly = app.debtCycleActionsHtml(DEBT_P, DEBT_C, { pay: true });
  assert.ok(payOnly.includes('data-debt-pay>') && !payOnly.includes('data-debt-amt-open'));
  const amountOnly = app.debtCycleActionsHtml(DEBT_P, DEBT_C, { amount: true });
  assert.ok(amountOnly.includes('data-debt-amt-open') && !amountOnly.includes('data-debt-pay>'));
  const partial = app.debtCycleActionsHtml(DEBT_P, Object.assign({}, DEBT_C, { received: 5000 }), { pay: true, amount: true });
  assert.ok(partial.includes('data-debt-pay>') && !partial.includes('data-debt-amt-open'), 'a part-paid cycle can only be paid, not re-priced');
  const evil = app.debtCycleActionsHtml(Object.assign({}, DEBT_P, { patientKey: '"><img src=x>' }), DEBT_C, { pay: true });
  assert.ok(!evil.includes('<img') && evil.includes('&lt;img'));
});

test('fill screen: a released patient with debt shows the debt, every owed cycle and the actions; a settled one shows nothing', () => {
  const app = loadApp();
  const d = Object.assign({}, DEBT_P, { cycles: [DEBT_C, Object.assign({}, DEBT_C, { kind: 'unrecorded', start: '2026-10-15', end: '2026-11-14', month: '2026-10', balance: 30000, expected: 30000, paymentId: '' }), Object.assign({}, DEBT_C, { balance: 0 })] });
  const html = app.funderFillDebtHtml(d, { pay: true, amount: true });
  assert.match(html, /חוב פתוח/);
  assert.match(html, /60,000/, 'the sum of the owed cycles only');
  assert.match(html, /פירוט וטיפול \(2\)/);
  assert.equal((html.match(/data-debt-pay>/g) || []).length, 2);
  assert.equal(app.funderFillDebtHtml(undefined, { pay: true }), '');
  assert.equal(app.funderFillDebtHtml(Object.assign({}, DEBT_P, { cycles: [Object.assign({}, DEBT_C, { balance: 0 })] }), { pay: true }), '');
  const row = [{ patient: { id: 'pid-1', name: 'דנה כהן', houseId: 'arfoni', date: '2026-07-01', status: 'released' }, released: true, defaultFrom: '2026-07-01' }];
  assert.ok(typeof app.funderFillHtml === 'function');
});

test('Ortal / Vered list: unpaid cycles only from January 2026, newest first; «שנה סכום» only with canAmount', () => {
  const app = loadApp();
  const cyc = (start, balance) => ({ patientKey: 'arfoni::דנה::' + start, month: start.slice(0, 7), start, end: start, kind: 'unrecorded', expected: balance, balance, discount: 0, days: 10, houseId: 'arfoni', patientName: 'דנה' });
  const data = { receipts: [], problems: { complete: true, discounts: [], cycles: [cyc('2025-12-15', 111), cyc('2026-01-15', 222), cyc('2026-09-15', 333), cyc('2026-05-15', 444)] } };
  const m = app.bcProblemsModel(data);
  const html = app.bcProblemsHtml(m, { state: {}, canConfirm: false, canAccount: true, canDiscount: false, canAmount: true });
  const order = ['333', '444', '222'].map((n) => html.indexOf('₪' + n) >= 0 ? html.indexOf('₪' + n) : html.indexOf(n));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'newest first');
  assert.ok(!html.includes('111'), 'December 2025 is before January: not listed');
  assert.match(html, /מחזורים שלא שולמו ולא דווח עליהם תשלום — מינואר, מהחדש לישן <span class="count-pill">3</);
  assert.equal((html.match(/data-debt-amt-open/g) || []).length, 3);
  assert.ok(!/data-bc-disc-open/.test(html), 'Ortal: no discount');
  const noAmount = app.bcProblemsHtml(m, { state: {}, canConfirm: false, canAccount: true, canDiscount: false, canAmount: false });
  assert.ok(!/data-debt-amt-open/.test(noAmount));
});

test('revenue by funder: verified money by received date, per funder and house; waiting is a separate column; void / flagged count nowhere', () => {
  const app = loadApp();
  const R = app.bcRules();
  const F = (patientId, funder, effectiveFrom) => ({ patientId, funder, effectiveFrom, setBy: 'x', setAt: effectiveFrom + 'T00:00:00' });
  const rc = (o) => Object.assign({ id: 'r' + Math.random(), houseId: 'arfoni', status: 'paid', confirmStatus: 'confirmed', receivedDate: '2026-09-10', amount: 1000, funder: '', patientId: 'pid-1' }, o);
  const receipts = [
    rc({ amount: 1000, funder: 'ביטוח לאומי' }),
    rc({ amount: 2000, houseId: 'ramot', funder: 'פרטי' }),
    rc({ amount: 500, patientId: 'pid-2' }),                                   // no own funder → patient's: מכבי
    rc({ amount: 700, patientId: 'pid-3' }),                                   // nothing known → unset
    rc({ amount: 900, confirmStatus: 'reported', funder: 'פרטי' }),            // waiting
    rc({ amount: 800, confirmStatus: 'flagged', funder: 'פרטי' }),             // «לא שולם»: nowhere
    rc({ amount: 400, status: 'void', funder: 'פרטי' }),                       // void: nowhere
    rc({ amount: 600, receivedDate: '2026-08-31', funder: 'פרטי' }),           // before the period
    rc({ amount: 300, receivedDate: '2026-09-30', funder: 'פרטי' }),           // last day: in
    rc({ amount: 1500, confirmStatus: 'partial', confirmedAmount: 400, funder: 'פרטי' }), // only 400 verified
  ];
  const m = app.revenueByFunder(receipts, '2026-09-01', '2026-09-30', [F('pid-2', 'מכבי', '2026-01-01')], R);
  assert.equal(m.ok, true);
  const row = (k) => plain(m.rows.find((r) => r.funder === k));
  assert.equal(row('btl').total, 1000);
  assert.equal(row('private').total, 2000 + 300 + 400);
  assert.equal(row('private').byHouse.ramot, 2000);
  assert.equal(row('private').waiting, 900);
  assert.equal(row('maccabi').total, 500);
  assert.equal(row('unset').total, 700);
  assert.equal(m.totals.total, 1000 + 2700 + 500 + 700);
  assert.equal(m.totals.waiting, 900, 'waiting is never in the income');
  assert.equal(app.revenueByFunder(receipts, '2026-09-30', '2026-09-01', [], R).ok, false, 'a reversed range is refused');
  assert.equal(app.revenueByFunder(receipts, '', '2026-09-01', [], R).ok, false);
  const html = app.revenueByFunderHtml(m, '2026-09-01', '2026-09-30');
  assert.match(html, /סה"כ הכנסה/);
  assert.match(html, /ממתין לאימות/);
  assert.match(html, /רק מה שאומת בבנק/);
  assert.match(app.revenueByFunderHtml({ ok: false }, '', ''), /בחרו תקופה תקינה/);
});

test('page wiring: revenue-by-funder section (no new data-finance node), the explainer, labels, SW v86; refresh hooks; Ortal loses the revenue section', () => {
  assert.match(HTML, /<details id="revenue-funder-view"/);
  assert.ok(!/id="revenue-funder-view"[^>]*data-finance/.test(HTML));
  for (const id of ['revf-from', 'revf-to', 'revf-this-month', 'revf-last-month', 'revf-year', 'revenue-funder']) assert.ok(HTML.includes('id="' + id + '"'), id);
  assert.match(HTML, /איך קוראים: <b>חוב רשום<\/b>/);
  assert.match(HTML, /פירוט לפי בית — חיובי החודש/);
  assert.match(APP_SRC, /שולם ₪\$\{col\.toLocaleString/);
  assert.match(APP_SRC, /חוב פתוח ₪\$\{out\.toLocaleString/);
  assert.match(APP_SRC, /if \(typeof refreshDebtViews === 'function'\) refreshDebtViews\(\);/);
  assert.match(APP_SRC, /const rf = document\.getElementById\('revenue-funder-view'\);\n\s+if \(rf && rf\.remove\) rf\.remove\(\);/);
  assert.match(APP_SRC, /debtAgingHtml\(s\.data, filters, debtAgingTodayIso\(\), debtActionCtx\(\)\)/);
  assert.match(SW_SRC, /var CACHE_VERSION = 'v86'/);
});
