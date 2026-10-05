/* The strict payment-report form — Phase 3 PR 2 of 2, LIVE.
 * See CHANGELOG-payment-report-form.md, docs/billing-control-plan.md Phase 3
 * and §14.1.
 *
 * Locked here (Sandra's decisions, 2026-10-04):
 *   A. one row per money received: reportPayment APPENDS a receipt row and
 *      never edits an amount; the cycle's amountPaid / balance / status are
 *      derived from its receipts (recomputeCycleFromReceipts_); a legacy cycle
 *      with amountPaid and no receipt derives unchanged
 *   B. strict: every rule is an inline Hebrew error in the form AND a server
 *      refusal ({ok:false, error:'invalid_report', issues}) with NOTHING
 *      written
 *   C. the גבייה row has no status dropdown / «שולם בפועל»; un-doing a
 *      receipt = voiding it (deleter), which re-derives the cycle
 *   D. the funder editor appends to Funders (appendFunder); no row → «פרטי
 *      (ברירת מחדל)»
 *   E. receivedDate > 90 days back: refused for staff, allowed for Sandra
 *   F. restricted sessions (Shiran / Yael): refused by Code.gs and listed in
 *      FINANCE_ACTIONS (server.js 403 — test/restricted-view.test.js loops
 *      over that list); no button, no form, no funder editor
 *   G. Ortal's digest: one line per receipt, with method and reference
 *   + monthly revenue (app.js) and debtAging_ (Code.gs) agree with the
 *     derived cycles on one fixture.
 *
 * vm sandboxes on the REAL Code.gs (test/helpers/gs-sandbox.js) and the REAL
 * app.js + lib/payment-report-rules.js. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');
const rules = require('../lib/payment-report-rules');
const scope = require('../lib/finance-scope');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'payment-report-rules.js'), 'utf8');
const FUNDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'funder.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-PAYMENT-FORM-0123456789abcdef0123456789';

/* ---------- dates, relative to today (the Code.gs sandbox's today is UTC) ---------- */
const UTC_TODAY = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const p = iso.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); };
const addMonthsMinus1 = (iso) => { const p = iso.split('-').map(Number); const last = new Date(Date.UTC(p[0], p[1] + 1, 0)).getUTCDate(); return addDays(new Date(Date.UTC(p[0], p[1], Math.min(p[2], last))).toISOString().slice(0, 10), -1); };
const DUE = addDays(UTC_TODAY, -10);
const COV_END = addMonthsMinus1(DUE);
const RECEIVED = addDays(UTC_TODAY, -5);
const dmy = (iso) => iso.split('-').reverse().join('/');

/* ---------- actors (the shape proxyGate_ verifies) ---------- */
const gsActor = (id, user, roles) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff']);

const PATIENT_KEY = 'arfoni::מטופל::2026-07-05';
const CYCLE_ID = 'pay::' + PATIENT_KEY + '::' + DUE;

/* A Code.gs with one patient (id p1) and, optionally, a cycle row. */
function world(opts) {
  const o = opts || {};
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' }[c] || '')));
  const paycols = arr(g.run('PAYMENT_COLUMNS'));
  S.Payments = richSheet('Payments', paycols);
  (o.rows || []).forEach((r) => S.Payments.appendRow(paycols.map((c) => (r[c] === undefined ? '' : r[c]))));
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const audits = (action) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !action || r.action === action);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  const report = (rep, who, cycle) => plain(g.post(Object.assign({ action: 'reportPayment',
    report: { cycle: Object.assign(cycleIdentity(), cycle || {}), report: rep } }, (who || VERED)())));
  const save = (payment, who) => plain(g.post(Object.assign({ action: 'savePayment', payment }, (who || VERED)())));
  const getPayments = (who) => plain(g.post(Object.assign({ action: 'getPayments' }, (who || VERED)())));
  return { g, S, rows, audits, snapshot, report, save, getPayments };
}
const cycleIdentity = () => ({
  id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE, amount: 30000,
  coverageStart: DUE, coverageEnd: COV_END,
});
const CYCLE_ROW = (extra) => Object.assign({
  id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE,
  amount: 30000, status: 'unpaid', amountPaid: 0, balance: 30000, coverageStart: DUE, coverageEnd: COV_END,
}, extra || {});
const VALID = (extra) => Object.assign({
  receivedDate: RECEIVED, amount: '10000', method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-2026/0042',
  funder: 'פרטי', coverageStart: DUE, coverageEnd: COV_END,
}, extra || {});

/* ---------- app.js in a vm (the same rules file the page loads) ---------- */
/* A fake element: querySelector hands back a (cached) fake child, so a modal
 * or a billing row can wire its controls. */
function fakeEl(deep) {
  const sub = {};
  const el = {
    className: '', dataset: {}, innerHTML: '', textContent: '', value: '', children: [], style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); }, remove() { this.removed = true; },
    querySelector(sel) { if (!deep) return null; if (!sub[sel]) sub[sel] = fakeEl(true); return sub[sel]; },
    querySelectorAll() { return []; }, addEventListener() {}, focus() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
  };
  return el;
}
function loadApp(opts) {
  const o = opts || {};
  const noop = () => {};
  const created = [];
  const posts = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
      getElementById: (id) => (id === 'modal-root' ? { appendChild: (c) => created.push(c) } : null),
      createElement: () => fakeEl(true),
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      posts.push(body);
      const answer = o.answer ? o.answer(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
    },
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (o.rules !== false) vm.runInContext(RULES_SRC, sandbox);
  // public/funder.js — the page loads it before app.js (global Funder).
  if (o.funder !== false) vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    renderBilling = () => {}; renderDashboard = () => {}; renderPatients = () => {};
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    showError = (m) => { globalThis.__errors.push(String(m)); };
    globalThis.__toasts = []; globalThis.__errors = [];
    globalThis.__test = {
      get state() { return state; },
      normalizePayment, normalizeReceipt, normalizeFunderRow, buildBillingRow, buildMonthlyRevenue,
      paymentReportIssues, paymentReportDefaults, openPaymentReportModal, submitPaymentReport,
      currentFunderFor, funderHistoryFor, funderLabel, patientFunderCellHtml, openFunderModal, saveFunder,
      receiptsForCycle, receiptsListHtml, confirmRenewPatient, paymentStatusLabel, PAYMENT_REPORT_TOAST,
      toasts: () => globalThis.__toasts, errors: () => globalThis.__errors,
    };`, sandbox);
  const app = sandbox.__test;
  app.state.mode = 'edit';
  app.state.finance = true;
  app.state.patients = [];
  app.state.payments = [];
  app.state.receipts = [];
  app.state.funders = [];
  app.state.billingOverrides = [];
  return { app, sandbox, created, posts };
}

/* ======================= A + B: every rule, both sides ======================= */

/* [name, the form values changed, field, code, approver?] */
const RULE_CASES = [
  ['receivedDate missing', { receivedDate: '' }, 'receivedDate', 'received_date_missing'],
  ['receivedDate not a date', { receivedDate: '31/02/2026' }, 'receivedDate', 'received_date_invalid'],
  ['receivedDate in the future', { receivedDate: addDays(UTC_TODAY, 2) }, 'receivedDate', 'received_date_future'],
  ['receivedDate > 90 days back (staff)', { receivedDate: addDays(UTC_TODAY, -120) }, 'receivedDate', 'received_date_too_old'],
  ['amount missing', { amount: '' }, 'amount', 'amount_missing'],
  ['amount zero', { amount: '0' }, 'amount', 'amount_not_positive'],
  ['amount with a comma', { amount: '1,500' }, 'amount', 'amount_invalid'],
  ['method missing', { method: '' }, 'method', 'method_missing'],
  ['method unknown', { method: 'קריפטו' }, 'method', 'method_invalid'],
  ['payer missing', { payer: '' }, 'payer', 'payer_missing'],
  ['payer formula-like', { payer: '=HYPERLINK("x")' }, 'payer', 'payer_invalid'],
  ['reference missing for a bank transfer', { reference: '' }, 'reference', 'reference_missing'],
  ["reference missing for a cheque", { method: "צ'ק", reference: '' }, 'reference', 'reference_missing'],
  ['reference malformed', { reference: '!!' }, 'reference', 'reference_invalid'],
  ['funder missing', { funder: '' }, 'funder', 'funder_missing'],
  ['funder unknown', { funder: 'כללית' }, 'funder', 'funder_invalid'],
  ['coverage start missing', { coverageStart: '' }, 'coverageStart', 'coverage_start_missing'],
  ['coverage end missing', { coverageEnd: '' }, 'coverageEnd', 'coverage_end_missing'],
  ['coverage reversed', { coverageEnd: addDays(DUE, -1) }, 'coverageEnd', 'coverage_reversed'],
];

for (const [name, change, field, code] of RULE_CASES) {
  test(`rule «${name}» → an inline Hebrew error in the form AND a server refusal with nothing written`, () => {
    // The form (app.js through the shared lib)
    const { app } = loadApp();
    const issues = plain(app.paymentReportIssues(VALID(change), UTC_TODAY, false));
    const hit = issues.find((i) => i.field === field && i.code === code);
    assert.ok(hit, JSON.stringify(issues));
    assert.equal(hit.hebrewMessage, rules.MESSAGES[code], 'the Hebrew line under the field');
    // The server (Code.gs): refused, NOTHING written — not the cycle, not a receipt, not an audit row.
    const w = world({ rows: [CYCLE_ROW()] });
    const before = w.snapshot();
    const r = w.report(VALID(change));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_report');
    assert.ok(r.issues.some((i) => i.field === field && i.code === code), JSON.stringify(r.issues));
    assert.equal(r.message, 'הדיווח לא נשמר — יש להשלים את השדות המסומנים');
    assert.equal(w.snapshot(), before, 'nothing written');
  });
}

test('rules: a valid report has no issue on either side; reference is optional for cash / credit / Bit / other', () => {
  const { app } = loadApp();
  assert.deepEqual(plain(app.paymentReportIssues(VALID(), UTC_TODAY, false)), []);
  for (const m of ['מזומן', 'אשראי', 'ביט', 'אחר']) {
    assert.deepEqual(plain(app.paymentReportIssues(VALID({ method: m, reference: '' }), UTC_TODAY, false)), [], m);
  }
  assert.deepEqual(plain(rules.validatePaymentReport(VALID(), { todayIso: UTC_TODAY, maxDaysBack: 90 })), []);
});

test('E: > 90 days back — refused for Vered (staff), «פנו לסנדרה»; accepted for Sandra (approver); exactly 90 is fine', () => {
  const old = addDays(UTC_TODAY, -120);
  const w = world({ rows: [CYCLE_ROW()] });
  const r = w.report(VALID({ receivedDate: old }));
  assert.equal(r.error, 'invalid_report');
  assert.match(r.issues[0].hebrewMessage, /פנו לסנדרה/);
  const ok = w.report(VALID({ receivedDate: old }), SANDRA);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const edge = w.report(VALID({ receivedDate: addDays(UTC_TODAY, -90), amount: '1' }));
  assert.equal(edge.ok, true, '90 days back is still allowed: ' + JSON.stringify(edge));
  // The form says the same, for the same people.
  const { app } = loadApp();
  assert.equal(app.paymentReportIssues(VALID({ receivedDate: old }), UTC_TODAY, false)[0].code, 'received_date_too_old');
  assert.deepEqual(plain(app.paymentReportIssues(VALID({ receivedDate: old }), UTC_TODAY, true)), []);
});

test('B: a coverage window that starts outside the cycle is refused, nothing written', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  const before = w.snapshot();
  const r = w.report(VALID({ coverageStart: addDays(COV_END, 1), coverageEnd: addDays(COV_END, 20) }));
  assert.equal(r.error, 'invalid_report');
  assert.equal(r.issues[0].code, 'coverage_outside_cycle');
  assert.equal(w.snapshot(), before);
});

/* ======================= A: one row per money received ======================= */

test('A: a valid report APPENDS one receipt row and re-derives the cycle — partial, then paid by a second receipt', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  const r1 = w.report(VALID({ amount: '10000' }));
  assert.equal(r1.ok, true, JSON.stringify(r1));
  let rows = w.rows();
  assert.equal(rows.length, 2, 'the cycle + ONE new row');
  const cycle = rows[0], rc1 = rows[1];
  assert.equal(cycle.id, CYCLE_ID, 'the cycle stays in place');
  assert.equal(cycle.amount, 30000, 'the charge is never edited');
  assert.equal(cycle.amountPaid, 10000);
  assert.equal(cycle.balance, 20000);
  assert.equal(cycle.status, 'partial');
  assert.match(rc1.id, /^rcpt-/, 'the server mints the receipt id');
  assert.equal(rc1.status, 'paid');
  assert.equal(rc1.amountPaid, 10000);
  assert.equal(rc1.amount, 10000);
  assert.equal(rc1.receivedDate, RECEIVED);
  assert.equal(rc1.method, 'העברה בנקאית');
  assert.equal(rc1.reference, 'TRX-2026/0042');
  assert.equal(rc1.payer, 'משפחת כהן');
  assert.equal(rc1.funder, 'פרטי');
  assert.equal(rc1.recordedBy, 'ורד', 'from the signed session');
  assert.ok(rc1.recordedAt);
  assert.equal(rc1.confirmStatus, 'reported');
  assert.equal(rc1.patientId, PATIENT_KEY);
  assert.equal(rc1.patientUid, cycle.patientUid, 'the same patient as its cycle');
  assert.equal(rc1.chargedBy, 'ורד');

  const r2 = w.report(VALID({ amount: '20000', method: 'מזומן', reference: '' }));
  assert.equal(r2.ok, true);
  rows = w.rows();
  assert.equal(rows.length, 3, 'ANOTHER new row — never an edit of the first');
  assert.equal(rows[0].amountPaid, 30000, 'two receipts sum');
  assert.equal(rows[0].balance, 0);
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[1].amountPaid, 10000, 'the first receipt is untouched');
  assert.equal(r2.cycle.status, 'paid');
  assert.equal(r2.receipt.cycleId, CYCLE_ID);

  const audits = w.audits('payment_reported');
  assert.equal(audits.length, 2);
  assert.equal(audits[0].actor, 'ורד');
  const d = JSON.parse(audits[1].details);
  assert.equal(d.cycleId, CYCLE_ID);
  assert.equal(d.amount, 20000);
  assert.equal(d.cycleStatus, 'paid');

  // getPayments: every existing key, the cycle derived, the receipts on a new key.
  const gp = w.getPayments();
  assert.deepEqual(Object.keys(gp).sort(), ['funders', 'ok', 'payments', 'receipts']);
  assert.equal(gp.payments.length, 1, 'receipts are not cycles');
  assert.equal(gp.payments[0].status, 'paid');
  assert.equal(gp.receipts.length, 2);
  assert.ok(gp.receipts.every((x) => x.cycleId === CYCLE_ID));
});

test('A: reporting on a cycle that has no row yet creates the cycle (unpaid charge) and the receipt', () => {
  const w = world({ rows: [] });
  const r = w.report(VALID({ amount: '30000' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  const rows = w.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, CYCLE_ID);
  assert.equal(rows[0].amount, 30000);
  assert.equal(rows[0].status, 'paid');
  assert.match(rows[0].paymentUid, /^pmt-/);
  assert.equal(r.cycle.paymentUid, rows[0].paymentUid, 'the echo carries the stored uid');
  assert.match(rows[1].id, /^rcpt-/);
});

test('A: the cycle amount of an unpaid month freezes its per-month override, as the old save did', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  const ocols = arr(w.g.run('BILLING_OVERRIDE_COLUMNS'));
  w.S.BillingOverrides = richSheet('BillingOverrides', ocols);
  w.S.BillingOverrides.appendRow(ocols.map((c) => ({ id: 'o1', patientId: PATIENT_KEY, month: DUE.slice(0, 7), amount: '25000' }[c] || '')));
  const r = w.report(VALID({ amount: '25000' }));
  assert.equal(r.ok, true);
  assert.equal(w.rows()[0].amount, 25000);
  assert.equal(w.rows()[0].status, 'paid', '25,000 of an overridden 25,000 is paid in full');
});

test('A: a legacy cycle with amountPaid and no receipt derives UNCHANGED; its first receipt keeps the legacy money', () => {
  const legacy = CYCLE_ROW({ status: 'partial', amountPaid: 12000, balance: 18000, chargedAt: '2026-08-01T10:00:00+03:00', chargedBy: 'ורד' });
  const w = world({ rows: [legacy] });
  // Pure: no receipt → the stored figures, flagged legacy.
  const d = plain(w.g.sandbox.recomputeCycleFromReceipts_(w.rows()[0], []));
  assert.equal(d.legacy, true);
  assert.equal(d.amountPaid, 12000);
  assert.equal(d.balance, 18000);
  assert.equal(d.status, 'partial');
  // getPayments hands the row back exactly as stored.
  const stored = w.rows()[0];
  const gp = w.getPayments();
  for (const k of ['amount', 'amountPaid', 'balance', 'status']) assert.equal(gp.payments[0][k], stored[k], k);
  assert.deepEqual(gp.receipts, []);
  // The first receipt: legacy 12,000 + 18,000 = paid.
  const r = w.report(VALID({ amount: '18000' }));
  assert.equal(r.ok, true);
  const cycle = w.rows()[0];
  assert.equal(cycle.legacyAmountPaid, 12000, 'the legacy money is kept, once');
  assert.equal(cycle.amountPaid, 30000);
  assert.equal(cycle.status, 'paid');
  assert.equal(cycle.chargedAt, '2026-08-01T10:00:00+03:00', 'the legacy charge stamp still dates the legacy part');
  // Voiding that receipt falls back to exactly the legacy figure.
  const rc = w.rows()[1];
  const v = w.save({ id: rc.id, status: 'void', linkStatus: 'duplicate', linkNote: 'נרשם בטעות' });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(w.rows()[0].amountPaid, 12000);
  assert.equal(w.rows()[0].status, 'partial');
});

/* ======================= C: un-doing a receipt ======================= */

test('C: voiding a receipt (deleter) re-derives the cycle; the receipt row stays, as void', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.report(VALID({ amount: '10000' }));
  w.report(VALID({ amount: '20000', method: 'מזומן', reference: '' }));
  assert.equal(w.rows()[0].status, 'paid');
  const second = w.rows()[2];
  const v = w.save({ id: second.id, status: 'void', linkStatus: 'duplicate', linkNote: 'נרשם פעמיים' });
  assert.equal(v.ok, true, JSON.stringify(v));
  const rows = w.rows();
  assert.equal(rows.length, 3, 'nothing deleted');
  assert.equal(rows[2].status, 'void');
  assert.equal(rows[2].amountPaid, 20000, 'the receipt keeps its money as evidence');
  assert.equal(rows[0].amountPaid, 10000, 're-derived');
  assert.equal(rows[0].status, 'partial');
  assert.equal(rows[0].balance, 20000);
  assert.equal(v.cycle.status, 'partial', 'the echo carries the re-derived cycle');
  // Shiran (no deleter, no finance) cannot void — refused before anything is read.
  const before = w.snapshot();
  const refused = w.save({ id: rows[1].id, status: 'void', linkStatus: 'duplicate', linkNote: 'x' }, SHIRAN);
  assert.equal(refused.ok, false);
  assert.equal(w.snapshot(), before);
});

test('C: a receipt is never edited, never born through savePayment, and a cycle with live receipts cannot be voided', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.report(VALID({ amount: '10000' }));
  const rc = w.rows()[1];
  const before = w.snapshot();
  const edit = w.save(Object.assign({}, rc, { amountPaid: 99999, amount: 99999 }));
  assert.equal(edit.error, 'receipt_immutable');
  const born = w.save({ id: 'rcpt-hand-built', patientId: PATIENT_KEY, status: 'paid', amountPaid: 5 });
  assert.equal(born.error, 'receipt_via_report_only');
  const cycleVoid = w.save(Object.assign({}, CYCLE_ROW(), { status: 'void', linkStatus: 'duplicate', linkNote: 'x' }));
  assert.equal(cycleVoid.error, 'cycle_has_receipts');
  assert.equal(w.snapshot(), before, 'nothing written by any of the three');
  // A stale copy of the cycle (amountPaid 0, unpaid) cannot overwrite the derived money.
  const stale = w.save(CYCLE_ROW({ coverageStart: DUE, coverageEnd: COV_END }));
  assert.equal(stale.ok, true);
  assert.equal(w.rows()[0].amountPaid, 10000);
  assert.equal(w.rows()[0].status, 'partial');
});

/* ======================= F: restricted sessions ======================= */

test('F: Shiran / Yael — reportPayment and appendFunder are finance actions, refused by Code.gs with nothing written', () => {
  for (const a of ['reportPayment', 'appendFunder']) {
    assert.ok(scope.FINANCE_ACTIONS.includes(a), a + ' is in lib/finance-scope.js (server.js answers 403)');
    assert.ok(!['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster'].includes(a));
  }
  const w = world({ rows: [CYCLE_ROW()] });
  const before = w.snapshot();
  const r = w.report(VALID(), SHIRAN);
  assert.deepEqual(r, { ok: false, error: 'forbidden', message: 'אין הרשאה לצפות בנתוני גבייה' });
  const f = plain(w.g.post(Object.assign({ action: 'appendFunder', funder: { patientId: 'p1', funder: 'מכבי', effectiveFrom: '2026-10-01' } }, SHIRAN())));
  assert.equal(f.error, 'forbidden');
  assert.equal(w.snapshot(), before);
  // Not an open action: without the proxy secret, enforce mode refuses it at the gate.
  const open = plain(w.g.post({ action: 'reportPayment', report: { cycle: cycleIdentity(), report: VALID() } }));
  assert.equal(open.ok, false);
  assert.equal(w.snapshot(), before);
});

test('F: a restricted session gets no form, no button and no funder editor in the page', () => {
  const { app, created } = loadApp();
  app.state.finance = false;
  const P = { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' };
  const pay = app.normalizePayment(CYCLE_ROW());
  app.openPaymentReportModal(P, pay, DUE);
  assert.equal(created.length, 0, 'no form');
  assert.equal(app.patientFunderCellHtml(P), '', 'no funder cell');
  app.openFunderModal(P);
  assert.equal(created.length, 0, 'no funder editor');
  const row = app.buildBillingRow(P, pay, DUE, false);
  assert.ok(!/bill-report-btn/.test(row.innerHTML), 'no «דווח תשלום» button');
  // …and full view gets all three.
  app.state.finance = true;
  assert.match(app.buildBillingRow(P, pay, DUE, false).innerHTML, /bill-report-btn/);
  assert.match(app.patientFunderCellHtml(P), /funder-edit-btn/);
  app.openPaymentReportModal(P, pay, DUE);
  assert.equal(created.length, 1);
});

/* ======================= D: the funder ======================= */

test('D: appendFunder appends one Funders row (audited); the current funder and a small history come back; getPayments carries them', () => {
  const w = world({ rows: [] });
  const fcols = arr(w.g.run('FUNDER_COLUMNS'));
  const r = plain(w.g.post(Object.assign({ action: 'appendFunder', funder: { patientId: 'p1', funder: 'ביטוח לאומי', effectiveFrom: '2026-08-01' } }, VERED())));
  assert.equal(r.ok, true, JSON.stringify(r));
  const r2 = plain(w.g.post(Object.assign({ action: 'appendFunder', funder: { patientId: 'p1', funder: 'מכבי', effectiveFrom: '01/09/2026' } }, VERED())));
  assert.equal(r2.ok, true);
  assert.equal(r2.current.funder, 'מכבי');
  assert.deepEqual(r2.history.map((h) => h.funder), ['מכבי', 'ביטוח לאומי'], 'newest first');
  const rows = w.g.sheetRows('Funders', 'FUNDER_COLUMNS');
  assert.equal(rows.length, 2, 'appended, never edited');
  assert.equal(rows[1].effectiveFrom, '2026-09-01');
  assert.equal(rows[1].setBy, 'ורד', 'from the signed session');
  assert.equal(fcols.length, 5);
  assert.equal(w.audits('funder_set').length, 2);
  const bad = plain(w.g.post(Object.assign({ action: 'appendFunder', funder: { patientId: 'p1', funder: 'כללית', effectiveFrom: '2026-09-01' } }, VERED())));
  assert.equal(bad.error, 'funder_invalid');
  assert.equal(w.g.sheetRows('Funders', 'FUNDER_COLUMNS').length, 2, 'a bad funder writes nothing');
  const gp = w.getPayments();
  assert.deepEqual(gp.funders.map((f) => f.funder), ['ביטוח לאומי', 'מכבי']);
  // The page: «לא הוגדר» with no row (there is no default funder); the
  // current one with rows; the form prefills it.
  const { app } = loadApp();
  const none = app.currentFunderFor('p2');
  assert.equal(app.funderLabel(none), 'לא הוגדר');
  assert.equal(none.unset, true);
  app.state.funders = gp.funders.map(app.normalizeFunderRow);
  assert.equal(app.funderLabel(app.currentFunderFor('p1', '2026-10-04')), 'מכבי');
  assert.equal(app.currentFunderFor('p1', '2026-08-15').funder, 'ביטוח לאומי', 'history by effectiveFrom');
  assert.equal(app.funderHistoryFor('p1').length, 2);
  const P = { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' };
  assert.match(app.patientFunderCellHtml(P), /מכבי/);
  const d = app.paymentReportDefaults(P, app.normalizePayment(CYCLE_ROW()), DUE, UTC_TODAY);
  assert.equal(d.report.funder, 'מכבי', 'the form opens with the patient\'s current funder');
});

/* ======================= the page: the form, the toast, the receipts ======================= */

test('form: submitting a valid report posts reportPayment once, adopts the receipt + derived cycle, and the toast names Ortal', async () => {
  const answer = (body) => body.action === 'reportPayment'
    ? { ok: true, receipt: { id: 'rcpt-1', cycleId: CYCLE_ID, amountPaid: 10000, status: 'paid', receivedDate: RECEIVED, method: 'מזומן', recordedBy: 'ורד' },
        cycle: Object.assign(CYCLE_ROW(), { amountPaid: 10000, balance: 20000, status: 'partial' }) }
    : { ok: true };
  const { app, posts } = loadApp({ answer });
  await app.submitPaymentReport(cycleIdentity(), VALID({ method: 'מזומן', reference: '' }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, 'reportPayment');
  assert.deepEqual(Object.keys(posts[0].report).sort(), ['cycle', 'report']);
  assert.equal(app.state.receipts.length, 1);
  assert.equal(app.state.payments[0].status, 'partial', 'the money shown is the server\'s');
  assert.equal(app.PAYMENT_REPORT_TOAST, 'התשלום נרשם — יופיע אצל אורטל מחר בבוקר');
  // A refusal throws with the issues, and changes nothing.
  const refused = loadApp({ answer: () => ({ ok: false, error: 'invalid_report', message: 'הדיווח לא נשמר', issues: [{ field: 'payer', code: 'payer_missing', hebrewMessage: 'חסר: שם משלם' }] }) });
  await assert.rejects(refused.app.submitPaymentReport(cycleIdentity(), VALID()), (e) => e.data.issues[0].code === 'payer_missing');
  assert.equal(refused.app.state.receipts.length, 0);
});

test('C: the גבייה row shows the derived state and its receipts (date, amount, method, reference, who); the void control is for a deleter only', () => {
  const { app } = loadApp();
  const P = { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' };
  const pay = app.normalizePayment(CYCLE_ROW({ amountPaid: 10000, balance: 20000, status: 'partial' }));
  app.state.payments = [pay];
  app.state.receipts = [app.normalizeReceipt({ id: 'rcpt-1', cycleId: CYCLE_ID, amountPaid: 10000, status: 'paid', receivedDate: RECEIVED,
    method: 'העברה בנקאית', reference: 'TRX-1', recordedBy: 'ורד' })];
  app.state.deleter = false;
  let html = app.buildBillingRow(P, pay, DUE, false).innerHTML;
  assert.ok(!/<select class="billing-status"/.test(html), 'no status dropdown');
  assert.ok(!/class="billing-paid"/.test(html), 'no «שולם בפועל»');
  assert.match(html, /שולם חלקית/);
  assert.match(html, /תשלומים שהתקבלו/);
  assert.ok(html.includes(dmy(RECEIVED)), 'DD/MM/YYYY');
  assert.match(html, /העברה בנקאית/);
  assert.match(html, /אסמכתא TRX-1/);
  assert.match(html, /ורד/);
  assert.ok(!/receipt-void-btn/.test(html), 'not for a non-deleter');
  app.state.deleter = true;
  html = app.buildBillingRow(P, pay, DUE, false).innerHTML;
  assert.match(html, /receipt-void-btn/);
  // A cycle paid in full offers no second report; a void cycle offers none.
  const paid = app.normalizePayment(CYCLE_ROW({ amountPaid: 30000, balance: 0, status: 'paid' }));
  assert.ok(!/bill-report-btn/.test(app.buildBillingRow(P, paid, DUE, false).innerHTML));
  const voided = app.normalizePayment(CYCLE_ROW({ status: 'void', linkStatus: 'duplicate', linkNote: 'x' }));
  assert.ok(!/bill-report-btn/.test(app.buildBillingRow(P, voided, DUE, false).innerHTML));
});

test('form: opens prefilled — patient, house, cycle window, expected amount (remaining balance), current funder, today', () => {
  const { app, created } = loadApp();
  const P = { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' };
  const pay = app.normalizePayment(CYCLE_ROW({ amountPaid: 10000, balance: 20000, status: 'partial' }));
  const d = app.paymentReportDefaults(P, pay, DUE, UTC_TODAY);
  assert.equal(d.cycle.id, CYCLE_ID);
  assert.equal(d.expected, 30000);
  assert.equal(d.remaining, 20000);
  assert.equal(d.report.amount, '20000');
  assert.equal(d.report.coverageStart, DUE);
  assert.equal(d.report.coverageEnd, COV_END);
  assert.equal(d.report.receivedDate, UTC_TODAY);
  assert.equal(d.report.funder, '', 'no Funders row → the report must name one (no default)');
  app.openPaymentReportModal(P, pay, DUE);
  const html = created[0].innerHTML;
  assert.match(html, /דווח תשלום/);
  assert.match(html, /מטופל/);
  for (const f of ['receivedDate', 'amount', 'method', 'payer', 'reference', 'funder', 'coverageStart', 'coverageEnd']) {
    assert.match(html, new RegExp(`data-err="${f}"`), 'an inline error slot for ' + f);
  }
  assert.ok(html.includes(`max="${rules.jerusalemToday()}"`), 'the date picker stops at today');
  for (const m of rules.PAYMENT_METHODS) assert.ok(html.includes(m), m);
});

/* ======================= G: Ortal's digest ======================= */

test('G: the digest lists one line per receipt (never the cycle they pay), with receivedDate, method and reference', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.report(VALID({ amount: '10000' }));
  w.report(VALID({ amount: '20000', method: 'מזומן', reference: '' }));
  const objs = w.rows();
  const sel = plain(w.g.sandbox.digestSelect_(objs, 0, Date.now() + 86400000, {}));
  assert.equal(sel.length, 2, 'two receipts, and the paid cycle is NOT a third line: ' + JSON.stringify(sel));
  assert.deepEqual(sel.map((r) => r.amount).sort((a, b) => a - b), [10000, 20000]);
  assert.ok(sel.every((r) => r.paymentDate === dmy(RECEIVED)), '«תאריך תשלום» = receivedDate');
  const t = sel.find((r) => r.amount === 10000);
  assert.equal(t.method, 'העברה בנקאית');
  assert.equal(t.reference, 'TRX-2026/0042');
  const msg = w.g.sandbox.digestCompose_(w.g.sandbox.digestSelect_(objs, 0, Date.now() + 86400000, {}),
    { todayDmy: '04/10/2026', sinceText: 'x', untilText: 'y', firstRun: false, test: false });
  assert.match(msg.htmlBody, />אסמכתא</);
  assert.match(msg.htmlBody, /TRX-2026\/0042/);
  assert.match(msg.body, /אמצעי \| אסמכתא \|/);
  assert.equal(msg.total, 30000);
  // A legacy paid row with no receipt is still listed as before.
  const legacy = Object.assign({}, objs[0], { id: 'legacy-1', patientId: 'arfoni::אחר::2026-07-05', patientUid: 'p9', chargedAt: objs[1].chargedAt });
  const withLegacy = plain(w.g.sandbox.digestSelect_(objs.concat([legacy]), 0, Date.now() + 86400000, {}));
  assert.equal(withLegacy.length, 3);
});

/* ============ monthly revenue (app.js) and debtAging_ (Code.gs) agree on the derived cycles ============ */

test('fixture: getPayments → monthly revenue, and debtAging_, agree with the derived cycles; a top-up is owed only between its two dates', () => {
  const key = PATIENT_KEY;
  const base = { patientId: key, patientName: 'מטופל', houseId: 'arfoni', amount: 30000, balance: 30000, status: 'unpaid', amountPaid: 0 };
  const w = world({ rows: [
    // July: a LEGACY paid cycle (no receipt), as every row before this PR.
    Object.assign({}, base, { id: 'pay::' + key + '::2026-07-05', dueDate: '2026-07-05', coverageStart: '2026-07-05', coverageEnd: '2026-08-04',
      status: 'paid', amountPaid: 30000, balance: 0, chargedAt: '2026-07-06T09:00:00+03:00', chargedBy: 'ורד' }),
    Object.assign({}, base, { id: 'pay::' + key + '::2026-08-05', dueDate: '2026-08-05', coverageStart: '2026-08-05', coverageEnd: '2026-09-04' }),
    Object.assign({}, base, { id: 'pay::' + key + '::2026-09-05', dueDate: '2026-09-05', coverageStart: '2026-09-05', coverageEnd: '2026-10-04' }),
  ] });
  const rep = (due, end, amount, received) => w.report(
    VALID({ amount: String(amount), receivedDate: received, coverageStart: due, coverageEnd: end, method: 'מזומן', reference: '' }),
    SANDRA, { id: 'pay::' + key + '::' + due, dueDate: due, coverageStart: due, coverageEnd: end });
  assert.equal(rep('2026-08-05', '2026-09-04', 30000, '2026-08-07').ok, true);
  assert.equal(rep('2026-09-05', '2026-10-04', 10000, '2026-09-06').ok, true);
  assert.equal(rep('2026-09-05', '2026-10-04', 5000, '2026-09-20').ok, true);

  const gp = w.getPayments();
  const byDue = {};
  gp.payments.forEach((p) => { byDue[p.dueDate] = p; });
  assert.deepEqual([byDue['2026-07-05'].status, byDue['2026-08-05'].status, byDue['2026-09-05'].status], ['paid', 'paid', 'partial']);
  assert.equal(byDue['2026-09-05'].amountPaid, 15000);
  const derivedPaid = gp.payments.reduce((s, p) => s + Number(p.amountPaid), 0);
  assert.equal(derivedPaid, 75000);

  // The page's monthly revenue, from exactly what getPayments returned.
  const { app } = loadApp();
  const payments = gp.payments.map(app.normalizePayment);
  const patients = [{ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, adv: 0, status: 'active' }];
  let received = 0;
  for (const month of ['2026-07', '2026-08', '2026-09', '2026-10']) {
    const m = app.buildMonthlyRevenue({ month, patients, payments, credits: [], overrides: [], today: '2026-10-04' });
    received += m.received.rows.reduce((s, r) => s + r.amountInMonth, 0);
  }
  assert.ok(Math.abs(received - derivedPaid) < 0.05, `revenue received ${received} = derived ${derivedPaid}`);

  // debtAging_, from the same sheet.
  const at = (asOf) => plain(w.g.sandbox.debtAgingAction_({ asOf }));
  const end = at('2026-10-04');
  assert.equal(end.ok, true, JSON.stringify(end));
  assert.equal(end.totals.recorded_debt.total, 15000, 'the September balance, as the page shows it');
  const sepCycle = end.byPatient[0].cycles.find((c) => c.start === '2026-09-05');
  assert.equal(sepCycle.received, byDue['2026-09-05'].amountPaid);
  assert.equal(sepCycle.balance, 30000 - byDue['2026-09-05'].amountPaid);
  assert.equal(sepCycle.receivedDateSource, 'receipts');
  assert.equal(end.byPatient[0].settledCycles, 2, 'July (legacy) and August are settled');
  // Between the two September receipts only the first had arrived.
  const mid = at('2026-09-10');
  assert.equal(mid.byPatient[0].cycles.find((c) => c.start === '2026-09-05').received, 10000);
  assert.equal(mid.totals.recorded_debt.total, 20000);
  // Before August's receipt arrived, August was owed in full.
  const aug = at('2026-08-06');
  assert.equal(aug.byPatient[0].cycles.find((c) => c.start === '2026-08-05').balance, 30000);
  // Receipts never count as cycles anywhere downstream.
  assert.ok(!end.byPatient[0].cycles.some((c) => /^rcpt-/.test(c.paymentId || '')));
  assert.equal(end.detachedPayments.count, 0, 'a receipt is not a detached payment');
  // The cleanup workbook reads the same derived cycles (its gaps index the
  // payment rows in parallel with the model — receipts must not shift them).
  const cu = plain(w.g.sandbox.cleanupReport_('2026-10-04', w.g.sandbox.recCollect_().tabs));
  assert.equal(cu.ok, true, JSON.stringify(cu).slice(0, 300));
  const gaps = cu.sections.gaps;
  const gap = gaps.find((r) => r.start === '2026-09-05');
  assert.equal(gap.received, 15000);
  assert.equal(gap.balance, 15000);
  assert.equal(gaps.filter((r) => r.kind === 'recorded_debt').length, 1);
});

test('other readers: the accounting feed exports cycles only, the refund suggestion sees the derived amountPaid', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.report(VALID({ amount: '30000' }));
  const rows = w.rows();
  const cycles = plain(w.g.sandbox.paymentCyclesDerived_(rows));
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].amountPaid, 30000);
  const feedSrc = GS_SRC.slice(GS_SRC.indexOf('function accountingPayments_'), GS_SRC.indexOf('function ', GS_SRC.indexOf('function accountingPayments_') + 10));
  assert.match(feedSrc, /paymentCyclesDerived_\(rows\)/, 'receipts are not exported as payment records');
  for (const fn of ['refundSuggestionsFor_', 'refundPayoutForecastFor_', 'debtAging_', 'recModel_', 'digestSelect_']) {
    const src = GS_SRC.slice(GS_SRC.indexOf('function ' + fn + '('), GS_SRC.indexOf('function ' + fn + '(') + 700);
    assert.match(src, /paymentCyclesDerived_|paymentTabsDerived_|linkReceiptsToCycles_/, fn + ' knows receipts are not cycles');
  }
});

/* ======================= scope, wiring, versions ======================= */

test('scope: the two new actions are proxied through the finance gate, nothing new is open, and Code.gs dispatches them', () => {
  assert.ok(/action === 'reportPayment'/.test(GS_SRC) && /action === 'appendFunder'/.test(GS_SRC));
  const g = loadGs({ props: { PROXY_SECRET } });
  assert.deepEqual(arr(g.run('OPEN_ACTIONS')), ['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster']);
  assert.deepEqual(arr(g.run('FINANCE_ACTIONS')), [...scope.FINANCE_ACTIONS]);
  assert.ok(arr(g.run('PROXY_KNOWN_ACTIONS')).includes('reportPayment'));
  // server.js knows no action name of its own for them: the finance list is the gate.
  assert.ok(!SERVER_SRC.includes("'reportPayment'") && !SERVER_SRC.includes("'appendFunder'"));
  assert.match(SERVER_SRC, /app\.get\('\/payment-report-rules\.js'/);
  // The page loads the shared rules before app.js; the worker serves them network-first.
  assert.ok(HTML_SRC.indexOf('payment-report-rules.js') < HTML_SRC.indexOf('src="app.js'));
  // v30 shipped the form; later PRs bump it again (v32: patient funder on
  // Funders; v33: Phase 4 «בקרת גבייה») — v30 or later.
  const ver = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(ver >= 30, 'SW v30 or later');
  assert.match(SW_SRC, /v29 → v30:/);
});

test('lib: in a browser the rules are ONE global (window.PaymentReportRules) and the same rules as Node', () => {
  const sandbox = { Intl, Date, Math, Number, String, Object, Array, RegExp, JSON };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  const R = sandbox.PaymentReportRules;
  assert.ok(R && typeof R.validatePaymentReport === 'function');
  assert.equal(sandbox.PAYMENT_METHODS, undefined, 'no other name leaks into the page scope');
  assert.equal(sandbox.MESSAGES, undefined);
  assert.equal(R.RECEIVED_DATE_STAFF_MAX_DAYS, 90);
  for (const [, change] of RULE_CASES) {
    assert.deepEqual(plain(R.validatePaymentReport(VALID(change), { todayIso: UTC_TODAY, maxDaysBack: 90 })),
      plain(rules.validatePaymentReport(VALID(change), { todayIso: UTC_TODAY, maxDaysBack: 90 })));
  }
  // Code.gs (the authority) agrees with the lib on the new age rule, both ways.
  const g = loadGs({ props: { PROXY_SECRET } });
  for (const [, change] of RULE_CASES) {
    const gs = plain(g.sandbox.validatePaymentReport_(VALID(change), { todayIso: UTC_TODAY, maxDaysBack: 90 }));
    assert.deepEqual(gs, plain(rules.validatePaymentReport(VALID(change), { todayIso: UTC_TODAY, maxDaysBack: 90 })), JSON.stringify(change));
  }
  assert.equal(g.run('PAYMENT_REPORT_MESSAGES').received_date_too_old, rules.MESSAGES.received_date_too_old);
  assert.equal(g.run('RECEIVED_DATE_STAFF_MAX_DAYS'), rules.RECEIVED_DATE_STAFF_MAX_DAYS);
});
