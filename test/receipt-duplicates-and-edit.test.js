/* Receipts — the «אומתו» month-split line, duplicate receipts, and editing a
 * receipt's non-money fields. CHANGELOG-receipt-duplicates-and-edit.md.
 *
 * A  the «אומתו» line: a confirmed receipt split across months reads «חלק
 *    אוקטובר: … · הקבלה המלאה … (תקופה …) · שולם במלואו»; «שולם חלקית» only on
 *    a real partial; the «ייצוא אימות» month columns say the same.
 * B1 reportPayment: same patient + same amount within 14 days of a live
 *    receipt → possible_duplicate, nothing written; confirmDuplicate:true
 *    writes it and audits the override; a 15-day gap / another amount / a
 *    void receipt is not flagged.
 * B2 «כפילות» in Ortal's dropdown (confirmPayment 'duplicate'): controller or
 *    approver only, a note 2–300, ONE receipt, never the only live receipt of
 *    its cycle; voids through the PR #144 path (its audit), «נגבה» drops.
 *    Un-void stays Sandra's.
 * B3 listDuplicateReceiptsNow: read-only, lists every group.
 * C  editReceipt: the allow-list only (amount / receivedDate / status / … are
 *    refused server-side), validated like reportPayment, one audit row with
 *    prev / next, a confirmed receipt stays confirmed, Ortal 403 (Code.gs and
 *    server.js), escaping.
 * Mutation checks: a mutated Code.gs / lib must FAIL the core assertions.
 * Code.gs is the REAL file in a vm (test/helpers/gs-sandbox.js); server.js is
 * the real Express app with https stubbed. All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { richSheet, loadGs, GS_SRC } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'billing-control-rules.js'), 'utf8');
const PR_RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'payment-report-rules.js'), 'utf8');
const FUNDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'funder.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const SERVER_PATH = require.resolve('../server');
const rules = require('../lib/billing-control-rules');
const bcx = require('../lib/billing-control-xlsx');
const scope = require('../lib/finance-scope');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-TEST-receipt-dup-edit-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-receipt-dup-edit-0123456789';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-receipt-dup-edit-a1b2c3d4e5f60718293a4b5';

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ============================ Code.gs world ============================ */

const gsActor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter'], []);

const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: 'arfoni::דנה כהן::2026-09-15',
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const COV = { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' };

function world(src) {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' }, src });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportBody = (amount, receivedDate, over) => ({ cycle: CYCLE, report: Object.assign({
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + receivedDate.replace(/-/g, ''),
    funder: 'פרטי', invoiceWanted: 'no',
  }, COV, over || {}) });
  const reportPay = (amount, receivedDate, over, extra, who) =>
    call({ action: 'reportPayment', report: Object.assign(reportBody(amount, receivedDate, over), extra || {}) }, who);
  const decide = (confirm, who) => call({ action: 'confirmPayment', confirm }, who || ORTAL);
  const edit = (body, who) => call({ action: 'editReceipt', edit: body }, who || VERED);
  const payRows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const receipts = () => payRows().filter((r) => String(r.id).indexOf('rcpt-') === 0);
  const receipt = (id) => payRows().find((r) => r.id === id);
  const cycle = () => payRows().find((r) => r.id === CYCLE.id);
  const audits = (action) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !action || r.action === action);
  const details = (r) => JSON.parse(String(r.details));
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, call, reportPay, decide, edit, payRows, receipts, receipt, cycle, audits, details, snapshot };
}

/* Two receipts on the cycle: 10,000 and 12,000 (no duplicate between them). */
function twoReceipts(src) {
  const w = world(src);
  const a = w.reportPay(10000, daysAgo(3));
  const b = w.reportPay(12000, daysAgo(2));
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  return Object.assign(w, { a: a.receipt.id, b: b.receipt.id });
}

/* ============================ page (app.js in a vm) ============================ */

function loadApp(answer) {
  const noop = () => {};
  const sent = [];
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
    fetch: (url, opts) => {
      const body = JSON.parse((opts && opts.body) || '{}');
      sent.push(body);
      const data = typeof answer === 'function' ? answer(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    },
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PR_RULES_SRC, sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    renderBilling = function () {};
    renderDashboard = function () {};
    globalThis.__test = {
      get state() { return state; },
      bcReceiptHtml, bcStatusSelectHtml, bcDuplicateFormHtml, billingControlState, BC_ERRORS, confirmReceipts,
      possibleDuplicateText, submitPaymentReport, receiptsListHtml, receiptEditChanges, canEditReceipt,
      normalizeReceipt, normalizePayment, buildMonthlyRevenue, RECEIPT_EDIT_FIELDS,
    };`, sandbox);
  return { app: sandbox.__test, sent };
}

/* ============================ A — the «אומתו» line ============================ */

const SPLIT = { id: 'rcpt-s', patientName: 'דנה כהן', houseId: 'arfoni', amount: 38000, receivedDate: '2026-10-02',
  coverageStart: '2026-10-02', coverageEnd: '2026-11-01', method: 'העברה בנקאית', confirmStatus: 'confirmed' };

test('A: a confirmed month-split receipt reads «חלק אוקטובר … · הקבלה המלאה … (תקופה 02/10–01/11) · שולם במלואו» — never the partial shape', () => {
  const v = rules.verifiedForMonth([SPLIT], '2026-10');
  assert.equal(v.rows[0].amountInMonth, 36774.19);
  assert.equal(rules.confirmedMonthLine(SPLIT, '2026-10', v.rows[0].amountInMonth),
    'חלק אוקטובר: ₪36,774.19 · הקבלה המלאה ₪38,000 (תקופה 02/10–01/11) · שולם במלואו');
  const nov = rules.verifiedForMonth([SPLIT], '2026-11');
  assert.equal(rules.confirmedMonthLine(SPLIT, '2026-11', nov.rows[0].amountInMonth),
    'חלק נובמבר: ₪1,225.81 · הקבלה המלאה ₪38,000 (תקופה 02/10–01/11) · שולם במלואו');
  // One month only → the full amount, «שולם במלואו».
  const one = Object.assign({}, SPLIT, { coverageEnd: '2026-10-31' });
  assert.equal(rules.confirmedMonthLine(one, '2026-10', 38000), '₪38,000 · שולם במלואו');
  // Never «מתוך» / «שולם חלקית» on a confirmed receipt.
  for (const line of [rules.confirmedMonthLine(SPLIT, '2026-10', 36774.19), rules.confirmedMonthLine(one, '2026-10', 38000)]) {
    assert.ok(!/מתוך|חלקית/.test(line), line);
  }
});

test('A: a REAL partial keeps «שולם חלקית» (and only it): its confirmed part, the whole receipt and the period', () => {
  const p = Object.assign({}, SPLIT, { confirmStatus: 'partial', confirmedAmount: 20000 });
  const v = rules.verifiedForMonth([p], '2026-10');
  const line = rules.confirmedMonthLine(p, '2026-10', v.rows[0].amountInMonth);
  assert.equal(line, `חלק אוקטובר: ₪${v.rows[0].amountInMonth.toLocaleString('he-IL')} · אומת ₪20,000 מתוך ₪38,000 (תקופה 02/10–01/11) · שולם חלקית`);
  assert.ok(!/במלואו/.test(line));
});

test('A: the tab renders the line (escaped) in «אומתו»; the confirmed row carries no partial badge', () => {
  const { app } = loadApp();
  const s = app.billingControlState();
  s.month = '2026-10';
  const html = app.bcReceiptHtml(Object.assign({}, SPLIT, { patientName: '<b>x</b>' }), 'confirmed', { inMonth: 36774.19 });
  assert.match(html, /<span class="bc-month-line">חלק אוקטובר: ₪ 36,774.19 · הקבלה המלאה ₪ 38,000 \(תקופה 02\/10–01\/11\) · שולם במלואו<\/span>/);
  assert.ok(!/bc-partial-badge|מתוך/.test(html), 'no partial wording on a confirmed row');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'escaped');
  // The queue row (not «אומתו») still shows the plain amount.
  assert.match(app.bcReceiptHtml(SPLIT, 'queue'), /<span class="bc-amount">₪ 38,000<\/span>/);
});

test('A: «ייצוא אימות» month columns — «חלק <חודש>», «הקבלה המלאה», «סטטוס» שולם במלואו / שולם חלקית', () => {
  const data = { ok: true, today: '2026-10-07', counts: {}, receipts: [
    SPLIT, Object.assign({}, SPLIT, { id: 'rcpt-p', confirmStatus: 'partial', confirmedAmount: 20000, patientName: 'רון לוי' })] };
  const spec = bcx.buildBillingControlSpec(data, new Date('2026-10-07T08:00:00Z'));
  const sheet = spec.sheets.find((x) => x.name === 'אומתו');
  const oct = sheet.sections.find((x) => x.heading.startsWith('10/2026'));
  const headers = oct.columns.map((c) => c.header);
  assert.ok(headers.includes('חלק אוקטובר') && headers.includes('הקבלה המלאה') && headers.includes('סטטוס'), headers.join('|'));
  assert.ok(!headers.includes('סכום הקבלה') && !headers.includes('החלק בחודש'));
  assert.ok(headers.indexOf('חלק אוקטובר') < headers.indexOf('הקבלה המלאה'));
  const byId = Object.fromEntries(oct.rows.map((r) => [r.patient, r]));
  assert.deepEqual([byId['דנה כהן'].paidStatus, byId['דנה כהן'].amountInMonth, byId['דנה כהן'].amount], ['שולם במלואו', 36774.19, 38000]);
  assert.equal(byId['רון לוי'].paidStatus, 'שולם חלקית');
  assert.ok(sheet.sections.find((x) => x.heading.startsWith('11/2026')).columns.some((c) => c.header === 'חלק נובמבר'));
});

/* ============================ B1 — report time ============================ */

test('B1: same patient + same amount within 14 days → possible_duplicate with the existing receipt, NOTHING written', () => {
  const w = world();
  const first = w.reportPay(10000, daysAgo(10));
  assert.equal(first.ok, true);
  const before = w.snapshot();
  const dup = w.reportPay(10000, daysAgo(2), { reference: 'OTHER-1' });
  assert.deepEqual([dup.ok, dup.error, dup.message], [false, 'possible_duplicate', 'קיימת כבר קבלה דומה']);
  assert.deepEqual(dup.existing, { id: first.receipt.id, receivedDate: daysAgo(10), reference: first.receipt.reference });
  assert.equal(w.snapshot(), before, 'nothing written');
  // 14 days exactly, either side, is still flagged.
  assert.equal(w.reportPay(10000, daysAgo(24)).error, 'possible_duplicate');
});

test('B1: confirmDuplicate:true is honoured — the receipt is written and the override audited with both receipts', () => {
  const w = world();
  const first = w.reportPay(10000, daysAgo(10));
  const ok = w.reportPay(10000, daysAgo(4), { reference: 'TRX-2' }, { confirmDuplicate: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(w.receipts().length, 2);
  const [row] = w.audits('payment_duplicate_override');
  assert.ok(row, 'audited');
  const d = w.details(row);
  assert.deepEqual([d.receiptId, d.existingId, d.existingReceivedDate, d.amount, d.by], [ok.receipt.id, first.receipt.id, daysAgo(10), 10000, 'ורד']);
  assert.equal(row.actor, 'ורד');
  // Only a strict true counts.
  for (const v of ['true', 1, 'yes']) assert.equal(w.reportPay(10000, daysAgo(3), {}, { confirmDuplicate: v }).error, 'possible_duplicate', String(v));
  // A report that is not a duplicate writes no override row.
  assert.equal(w.reportPay(7000, daysAgo(3)).ok, true);
  assert.equal(w.audits('payment_duplicate_override').length, 1);
});

test('B1: NOT flagged — a 15-day gap, another amount, a voided receipt, another patient', () => {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(20)).ok, true);
  const gap15 = w.reportPay(10000, daysAgo(5));
  assert.equal(gap15.ok, true, '15 days apart: ' + JSON.stringify(gap15));
  assert.equal(w.reportPay(10000.5, daysAgo(5)).ok, true, 'another amount (agorot count)');
  // A void receipt is no money: the same amount again is fine.
  const w2 = world();
  const r = w2.reportPay(9000, daysAgo(3));
  assert.equal(w2.call({ action: 'savePayment', payment: { id: r.receipt.id, status: 'void', linkStatus: 'duplicate', linkNote: 'נרשם פעמיים' } }).ok, true);
  assert.equal(w2.reportPay(9000, daysAgo(2)).ok, true, 'the voided receipt does not count');
  // Another patient, same amount, same day.
  const other = Object.assign({}, CYCLE, { id: 'pay::arfoni::רון לוי::2026-09-15::2026-09-15', patientId: 'arfoni::רון לוי::2026-09-15', patientName: 'רון לוי' });
  const res = w2.call({ action: 'reportPayment', report: { cycle: other, report: Object.assign({ receivedDate: daysAgo(2), amount: 9000,
    method: 'מזומן', payer: 'רון', funder: 'פרטי', invoiceWanted: 'no' }, COV) } });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test('B1 page: «קיימת כבר קבלה דומה (dd/mm, אסמכתא X). האם זו קבלה נוספת?»; confirmDuplicate is sent ONLY after «כן, קבלה נוספת»', async () => {
  // A confirmed save carries the persisted receipt id (CHANGELOG-payment-report-persistence.md).
  const { app, sent } = loadApp(() => ({ ok: true, receipt: { id: 'rcpt-b1' } }));
  assert.equal(app.possibleDuplicateText({ receivedDate: '2026-10-05', reference: 'TRX-9' }), 'קיימת כבר קבלה דומה (05/10, אסמכתא TRX-9). האם זו קבלה נוספת?');
  assert.equal(app.possibleDuplicateText({ receivedDate: '2026-10-05', reference: '' }), 'קיימת כבר קבלה דומה (05/10, ללא אסמכתא). האם זו קבלה נוספת?');
  app.state.receipts = []; app.state.payments = [];
  await app.submitPaymentReport({ id: 'pay::x' }, { amount: '1' });
  await app.submitPaymentReport({ id: 'pay::x' }, { amount: '1' }, true);
  // POSTs only — the post-save reconcile GET carries no body.
  sent.splice(0, sent.length, ...sent.filter((b) => b.action));
  assert.equal(sent[0].action, 'reportPayment');
  assert.equal('confirmDuplicate' in sent[0].report, false, 'the first send never carries it');
  assert.equal(sent[1].report.confirmDuplicate, true);
  // The form: a hidden prompt box, the two buttons, the text escaped.
  assert.match(APP_SRC, /<div class="pr-dup-confirm hidden" role="alertdialog"/);
  assert.match(APP_SRC, /\$\{escapeHtml\(possibleDuplicateText\(data\.existing\)\)\}/);
  assert.match(APP_SRC, /data-action="dup-yes">כן, קבלה נוספת<\/button>/);
  assert.match(APP_SRC, /data-action="dup-no">ביטול<\/button>/);
  assert.match(APP_SRC, /onclick = \(\) => sendReport\(v, true\)/);
});

/* ============================ B2 — «כפילות» ============================ */

test('B2: Ortal marks «כפילות» — void + linkStatus duplicate + her reason, the PR #144 audit, the cycle re-derived («נגבה» drops)', () => {
  const w = twoReceipts();
  assert.equal(Number(w.cycle().amountPaid), 22000);
  const res = w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'אותה העברה דווחה פעמיים' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.voided, [{ id: w.b, status: 'void', linkStatus: 'duplicate', linkNote: 'אותה העברה דווחה פעמיים' }]);
  const r = w.receipt(w.b);
  assert.deepEqual([r.status, r.linkStatus, r.linkNote], ['void', 'duplicate', 'אותה העברה דווחה פעמיים']);
  assert.equal(Number(r.amountPaid), 12000, 'the amount itself is never touched');
  assert.equal(r.confirmStatus, 'reported', 'not a confirm status');
  assert.equal(Number(w.cycle().amountPaid), 10000, 'the cycle no longer counts it');
  const [audit] = w.audits('payment_link_duplicate');
  assert.ok(audit, 'the #144 audit row');
  assert.deepEqual([w.details(audit).paymentId, w.details(audit).note, audit.actor], [w.b, 'אותה העברה דווחה פעמיים', 'אורטל']);
  // Her queue drops it; getPayments shows it void.
  const q = w.call({ action: 'billingControlQueue' }, ORTAL);
  assert.deepEqual(q.receipts.map((x) => x.id), [w.a]);
  const gp = w.call({ action: 'getPayments' }, VERED);
  assert.equal(gp.receipts.find((x) => x.id === w.b).status, 'void');
  // «נגבה» (הכנסות חודשיות) from the server's cycles: 10,000, not 22,000.
  const { app } = loadApp();
  const model = app.buildMonthlyRevenue({ month: '2026-09', patients: [], payments: gp.payments.map(app.normalizePayment), credits: [], overrides: [], today: TODAY });
  const total = model.received.rows.reduce((a, x) => a + x.amountInMonth, 0);
  const w0 = twoReceipts();
  const gp0 = w0.call({ action: 'getPayments' }, VERED);
  const model0 = app.buildMonthlyRevenue({ month: '2026-09', patients: [], payments: gp0.payments.map(app.normalizePayment), credits: [], overrides: [], today: TODAY });
  const total0 = model0.received.rows.reduce((a, x) => a + x.amountInMonth, 0);
  assert.ok(total0 > total && Math.abs((total0 - total) - 12000 * (16 / 30)) < 0.02, `נגבה ${total0} → ${total}`);
});

test('B2: role gates — Ortal and Sandra may; Vered (no controller role) and Shiran are refused; nothing written', () => {
  const w = twoReceipts();
  const before = w.snapshot();
  const vered = w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'כפול' }, VERED);
  assert.deepEqual([vered.ok, vered.error], [false, 'forbidden_role']);
  const shiran = w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'כפול' }, SHIRAN);
  assert.equal(shiran.ok, false);
  assert.equal(w.snapshot(), before);
  assert.equal(w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'כפול' }, SANDRA).ok, true, 'Sandra (approver)');
});

test('B2: the note is required (2–300), ONE receipt only — every refusal writes nothing', () => {
  const w = twoReceipts();
  const before = w.snapshot();
  for (const flagNote of [undefined, '', ' ', 'א', '=', '=א', 'א'.repeat(301)]) {
    const r = w.decide({ ids: [w.b], status: 'duplicate', flagNote });
    assert.deepEqual([r.ok, r.error], [false, 'duplicate_note_invalid'], JSON.stringify(flagNote));
    assert.match(r.message, /כפילות/);
  }
  assert.deepEqual(w.decide({ ids: [w.a, w.b], status: 'duplicate', flagNote: 'כפול' }).error, 'duplicate_single');
  assert.equal(w.snapshot(), before);
  // 300 is fine, and a formula lead-in / control characters never land.
  const ok = w.decide({ ids: [w.b], status: 'duplicate', flagNote: '=HYPERLINK("x")\nכפול' });
  assert.equal(ok.ok, true);
  assert.equal(w.receipt(w.b).linkNote, 'HYPERLINK("x") כפול');
});

test('B2: the ONLY live receipt of its cycle cannot be a duplicate — Hebrew refusal, nothing written; after a void the last one is protected', () => {
  const w = world();
  const only = w.reportPay(10000, daysAgo(3));
  const before = w.snapshot();
  const r = w.decide({ ids: [only.receipt.id], status: 'duplicate', flagNote: 'כפול' });
  assert.deepEqual([r.ok, r.error], [false, 'duplicate_last_receipt']);
  assert.match(r.message, /^זו הקבלה היחידה של המחזור/);
  assert.equal(w.snapshot(), before, 'nothing written');
  const w2 = twoReceipts();
  assert.equal(w2.decide({ ids: [w2.b], status: 'duplicate', flagNote: 'כפול' }).ok, true);
  assert.equal(w2.decide({ ids: [w2.a], status: 'duplicate', flagNote: 'כפול' }).error, 'duplicate_last_receipt');
  // Re-marking a receipt already marked «כפילות» is a retry whose answer was
  // lost: answered, nothing written (CHANGELOG-write-path-hardening.md).
  const snap = w2.snapshot();
  const again = w2.decide({ ids: [w2.b], status: 'duplicate', flagNote: 'כפול' });
  assert.deepEqual([again.ok, again.replayed, again.voided[0].id], [true, true, w2.b]);
  assert.equal(w2.snapshot(), snap, 'the replay writes nothing');
  // An unknown id / a cycle id.
  assert.equal(w2.decide({ ids: ['rcpt-nope'], status: 'duplicate', flagNote: 'כפול' }).error, 'not_found');
  assert.equal(w2.decide({ ids: [CYCLE.id], status: 'duplicate', flagNote: 'כפול' }).error, 'bad_ids');
});

test('B2: un-void stays Sandra\'s alone — Ortal and Vered cannot put it back', () => {
  const w = twoReceipts();
  w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'כפול' });
  const back = { id: w.b, status: 'paid', linkStatus: '', linkNote: '' };
  assert.equal(w.call({ action: 'savePayment', payment: back }, VERED).error, 'forbidden_role');
  assert.equal(w.call({ action: 'savePayment', payment: back }, ORTAL).error, 'forbidden');
  for (const status of ['reported', 'confirmed']) assert.equal(w.decide({ ids: [w.b], status }).error, 'receipt_void');
  assert.equal(w.receipt(w.b).status, 'void');
  assert.equal(w.call({ action: 'savePayment', payment: back }, SANDRA).ok, true);
  assert.equal(w.receipt(w.b).status, 'paid');
});

test('B2 page: «כפילות» is the fourth option; its form needs the note; a voided answer drops the row', async () => {
  const { app, sent } = loadApp((b) => (b.action === 'confirmPayment'
    ? { ok: true, changed: [], unchanged: 0, voided: [{ id: 'rcpt-2', status: 'void', linkStatus: 'duplicate', linkNote: 'כפול' }] }
    : { ok: true }));
  const opts = [...app.bcStatusSelectHtml({ id: 'rcpt-1', confirmStatus: 'reported' }).matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(opts, ['', 'confirmed', 'partial', 'flagged', 'duplicate']);
  const form = app.bcDuplicateFormHtml({ id: 'rcpt-"1' });
  assert.match(form, /maxlength="300"/);
  assert.match(form, /data-bc-dup-save="rcpt-&quot;1"/, 'the id is escaped');
  assert.match(app.BC_ERRORS.duplicate_last_receipt, /^זו הקבלה היחידה/);
  app.state.canConfirm = true;
  const s = app.billingControlState();
  s.data = { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported', amount: 1 }, { id: 'rcpt-2', confirmStatus: 'reported', amount: 1 }] };
  s.dupOpen = 'rcpt-2';
  const res = await app.confirmReceipts(['rcpt-2'], 'duplicate', { flagNote: 'כפול' });
  assert.ok(res);
  assert.deepEqual(plain(sent[0].confirm), { ids: ['rcpt-2'], status: 'duplicate', flagNote: 'כפול' });
  assert.equal(s.dupOpen, '', 'the form closes');
  assert.deepEqual(s.data.receipts.map((r) => r.id), ['rcpt-1'], 'the voided receipt leaves every list');
  // The handler wiring: «כפילות» opens the note form; the save validates first.
  assert.match(APP_SRC, /else if \(value === 'duplicate'\) \{ s\.dupOpen = id;/);
  assert.match(APP_SRC, /bcInlineError\(t, '\.bc-dup-form', '\.bc-dup-error', 'textarea', BC_ERRORS\.duplicate_note_invalid\)/);
  assert.match(APP_SRC, /s\.data\.receipts = s\.data\.receipts\.filter\(r => !voided\[r\.id\]\)/);
});

/* ============================ B3 — listDuplicateReceiptsNow ============================ */

test('B3: listDuplicateReceiptsNow logs every patient with 2+ live receipts of the same amount within 14 days — and changes NOTHING', () => {
  const w = world();
  w.reportPay(10000, daysAgo(30));
  w.reportPay(10000, daysAgo(20), {}, { confirmDuplicate: true });     // 10 days later → a pair
  w.reportPay(10000, daysAgo(5));                                       // 15 days after → not in the pair
  w.reportPay(5000, daysAgo(4));
  const v1 = w.reportPay(5000, daysAgo(3), {}, { confirmDuplicate: true });
  w.call({ action: 'savePayment', payment: { id: v1.receipt.id, status: 'void', linkStatus: 'duplicate', linkNote: 'כפול' } });
  const before = w.snapshot();
  w.g.logs.length = 0;
  const out = plain(w.g.sandbox.listDuplicateReceiptsNow());
  assert.equal(w.snapshot(), before, 'read-only');
  assert.equal(out.groups.length, 1, JSON.stringify(out));
  assert.deepEqual([out.groups[0].patientName, out.groups[0].amount, out.groups[0].receipts.map((r) => r.receivedDate)],
    ['דנה כהן', 10000, [daysAgo(30), daysAgo(20)]]);
  assert.equal(out.receipts, 2);
  const log = w.g.logs.join('\n');
  assert.match(log, /READ-ONLY: nothing was changed/);
  assert.match(log, /• דנה כהן \(arfoni\) ₪10000 × 2/);
  assert.ok(log.includes(daysAgo(30)) && log.includes(daysAgo(20)) && !log.includes(daysAgo(5) + ' ·'));
  // Not dispatched by handle_: an editor function only.
  assert.ok(!/action === 'listDuplicateReceiptsNow'/.test(GS_SRC));
});

/* ============================ C — editReceipt ============================ */

test('C: every allowed field edits; ONE audit row with prev / next / reason; amount, date, status and confirmation untouched', () => {
  const w = twoReceipts();
  assert.equal(w.decide({ ids: [w.a], status: 'confirmed' }).ok, true);
  const before = w.receipt(w.a);
  const res = w.edit({ id: w.a, reason: 'תיקון אסמכתא', fields: {
    reference: 'TRX-777', method: "צ'ק", payer: 'אבי כהן', invoiceWanted: 'yes', invoiceTo: 'אבי כהן בע"מ',
    coverageStart: '2026-09-16', coverageEnd: '2026-10-15' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.fields.slice().sort(), ['coverageEnd', 'coverageStart', 'invoiceTo', 'invoiceWanted', 'method', 'payer', 'reference']);
  const after = w.receipt(w.a);
  assert.deepEqual([after.reference, after.method, after.payer, after.invoiceWanted, after.invoiceTo, after.coverageStart, after.coverageEnd],
    ['TRX-777', "צ'ק", 'אבי כהן', 'yes', 'אבי כהן בע"מ', '2026-09-16', '2026-10-15']);
  for (const k of ['amount', 'amountPaid', 'receivedDate', 'status', 'confirmStatus', 'confirmedBy', 'confirmedAt', 'confirmedAmount',
    'recordedBy', 'recordedAt', 'sourceVersion', 'sourceUpdatedAt', 'chargedAt', 'chargedBy', 'funder', 'paymentUid', 'patientUid', 'timestamp']) {
    assert.deepEqual(after[k], before[k], k + ' re-stamped');
  }
  assert.equal(after.confirmStatus, 'confirmed', 'a confirmed receipt stays confirmed');
  const rows = w.audits('receipt_edited');
  assert.equal(rows.length, 1);
  const d = w.details(rows[0]);
  assert.deepEqual(d.prev, { reference: before.reference, method: 'העברה בנקאית', payer: 'משפחת כהן', invoiceWanted: 'no', invoiceTo: '',
    coverageStart: '2026-09-15', coverageEnd: '2026-10-14' });
  assert.equal(d.next.reference, 'TRX-777');
  assert.deepEqual([d.reason, d.by, d.receiptId, rows[0].actor], ['תיקון אסמכתא', 'ורד', w.a, 'ורד']);
  // The same edit again → no change, no second row.
  const again = w.edit({ id: w.a, fields: { reference: 'TRX-777' } });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal(w.audits('receipt_edited').length, 1);
  // Reason optional; Sandra may edit too.
  assert.equal(w.edit({ id: w.a, fields: { payer: 'סבתא כהן' } }, SANDRA).ok, true);
  assert.equal(w.details(w.audits('receipt_edited')[1]).reason, '');
});

test('C: forbidden fields are refused SERVER-side (field_not_editable) — amount, receivedDate, status, … — nothing written', () => {
  const w = twoReceipts();
  const before = w.snapshot();
  for (const k of ['amount', 'amountPaid', 'receivedDate', 'status', 'confirmStatus', 'confirmedAmount', 'funder', 'patientId',
    'houseId', 'dueDate', 'id', 'recordedBy', 'linkStatus', 'controlNote', '__proto__x']) {
    const r = w.edit({ id: w.a, fields: { reference: 'OK-1', [k]: '1' } });
    assert.deepEqual([r.ok, r.error], [false, 'field_not_editable'], k);
    assert.deepEqual(r.fields, [k]);
    assert.match(r.message, /אינם ניתנים לעריכה/);
  }
  for (const body of [{ id: w.a }, { id: w.a, fields: {} }, { id: w.a, fields: [] }, { id: CYCLE.id, fields: { reference: 'X1' } },
    { id: w.a, fields: { reference: 5 } }, { id: 'rcpt-\u0001x', fields: { reference: 'X1' } }]) {
    assert.equal(w.edit(body).error, 'bad_edit', JSON.stringify(body));
  }
  assert.equal(w.edit({ id: 'rcpt-nope', fields: { reference: 'X1' } }).error, 'not_found');
  assert.equal(w.snapshot(), before, 'nothing written');
});

test('C: validated like reportPayment — bad method / missing reference / bad payer / bad invoice / coverage out of its cycle — nothing written', () => {
  const w = twoReceipts();
  const before = w.snapshot();
  const code = (fields) => { const r = w.edit({ id: w.a, fields }); return r.ok ? 'ok' : (r.issues ? r.issues.map((i) => i.code).join(',') : r.error); };
  assert.equal(code({ method: 'קריפטו' }), 'method_invalid');
  assert.equal(code({ reference: '' }), 'reference_missing', 'a bank transfer needs its reference');
  assert.equal(code({ reference: '=cmd()' }), 'reference_invalid');
  assert.equal(code({ payer: '=HYPERLINK("x")' }), 'payer_invalid');
  assert.equal(code({ payer: '' }), 'payer_missing');
  assert.equal(code({ invoiceWanted: 'yes', invoiceTo: '' }), 'invoice_to_missing');
  assert.equal(code({ invoiceWanted: 'maybe' }), 'invoice_choice_invalid');
  assert.equal(code({ coverageStart: '2026-10-20', coverageEnd: '2026-10-30' }), 'coverage_outside_cycle', 'money never moves cycles here');
  assert.equal(code({ coverageStart: '2026-09-20', coverageEnd: '2026-09-19' }), 'coverage_reversed');
  assert.equal(code({ coverageStart: '31/02/2026' }), 'coverage_invalid');
  assert.equal(w.edit({ id: w.a, fields: { reference: 'X1' }, reason: 'א'.repeat(301) }).error, 'reason_invalid');
  assert.equal(w.snapshot(), before, 'nothing written');
  // Cash needs no reference: switching to מזומן and clearing it is fine.
  assert.equal(code({ method: 'מזומן', reference: '' }), 'ok');
  // A void receipt cannot be edited.
  w.call({ action: 'savePayment', payment: { id: w.b, status: 'void', linkStatus: 'duplicate', linkNote: 'כפול' } });
  assert.equal(w.edit({ id: w.b, fields: { reference: 'X1' } }).error, 'receipt_void');
});

test('C: escaping — control characters / a formula lead-in never reach the sheet; the reason is one clean line; HTML stays text on the page', () => {
  const w = twoReceipts();
  assert.equal(w.edit({ id: w.a, reason: '=SUM(A1)\n\tבדיקה', fields: { payer: '<img src=x onerror=alert(1)>' } }).ok, true);
  const r = w.receipt(w.a);
  assert.equal(r.payer, '<img src=x onerror=alert(1)>', 'stored as plain text (a text-forced cell)');
  assert.equal(w.details(w.audits('receipt_edited')[0]).reason, 'SUM(A1)  בדיקה');
  const { app } = loadApp();
  app.state.mode = 'edit'; app.state.finance = true; app.state.view = 'full';
  app.state.receipts = [app.normalizeReceipt(Object.assign({}, r, { cycleId: 'pay::c', reference: '"><script>x</script>' }))];
  const html = app.receiptsListHtml('pay::c');
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'), 'escaped');
  assert.match(html, /class="btn small receipt-edit-btn" data-rid="rcpt-/);
});

test('C: page — ✏️ only for finance in edit mode (never Ortal / view mode / a void receipt); the edit sends ONLY changed allow-listed fields', () => {
  const { app } = loadApp();
  const rc = app.normalizeReceipt({ id: 'rcpt-1', cycleId: 'pay::c', amountPaid: 9000, status: 'paid', receivedDate: '2026-10-01',
    method: 'העברה בנקאית', reference: 'A1', payer: 'משפחת כהן', funder: 'פרטי', invoiceWanted: 'no', coverageStart: '2026-10-01', coverageEnd: '2026-10-30' });
  app.state.receipts = [rc];
  app.state.mode = 'edit'; app.state.finance = true; app.state.view = 'full';
  assert.equal(app.canEditReceipt(), true);
  assert.match(app.receiptsListHtml('pay::c'), /receipt-edit-btn/);
  app.state.view = 'controller'; app.state.finance = false;
  assert.equal(app.canEditReceipt(), false, 'Ortal');
  assert.ok(!/receipt-edit-btn/.test(app.receiptsListHtml('pay::c')));
  app.state.view = 'full'; app.state.finance = true; app.state.mode = 'view';
  assert.ok(!/receipt-edit-btn/.test(app.receiptsListHtml('pay::c')), 'view mode');
  app.state.mode = 'edit';
  app.state.receipts = [Object.assign({}, rc, { status: 'void' })];
  assert.ok(!/receipt-edit-btn/.test(app.receiptsListHtml('pay::c')), 'void');
  // Only what changed, and never a money field.
  assert.deepEqual(plain(app.RECEIPT_EDIT_FIELDS), ['reference', 'method', 'payer', 'invoiceWanted', 'invoiceTo', 'coverageStart', 'coverageEnd']);
  assert.deepEqual(plain(app.receiptEditChanges(rc, { reference: 'TRX-22', method: rc.method, payer: rc.payer, invoiceWanted: 'no', invoiceTo: '',
    coverageStart: rc.coverageStart, coverageEnd: rc.coverageEnd, amount: '1', receivedDate: '2020-01-01' })), { fields: { reference: 'TRX-22' }, issues: [] });
  const bad = app.receiptEditChanges(rc, { reference: '' });
  assert.deepEqual(plain(bad.issues).map((i) => i.code), ['reference_missing']);
  assert.deepEqual(Object.keys(app.receiptEditChanges(rc, { coverageEnd: '2026-10-29' }).fields).sort(), ['coverageEnd', 'coverageStart'], 'the pair travels together');
  // The modal has no amount / receivedDate / status input.
  const modal = APP_SRC.slice(APP_SRC.indexOf('function openReceiptEditModal('), APP_SRC.indexOf('async function submitReceiptEdit('));
  assert.ok(!/name="(amount|receivedDate|status|funder)"/.test(modal));
});

/* ============================ server.js gates ============================ */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

async function withServer(fn) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs) };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push(JSON.parse(body || '{}'));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify({ ok: true })); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port, calls); } finally {
    srv.close(); https.request = original; Object.assign(console, orig);
  }
}

function request(port, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/sheets',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('server.js: editReceipt — Vered / Sandra proxied; Ortal (controller view) 403 and Shiran / Yael 403, nothing proxied; «כפילות» needs controller / approver', async () => {
  await withServer(async (port, calls) => {
    const edit = { action: 'editReceipt', edit: { id: 'rcpt-1', fields: { reference: 'X1' } } };
    for (const id of ['ortal', 'shiran', 'yael']) {
      const r = await request(port, edit, personal(id));
      assert.equal(r.status, 403, id);
    }
    assert.equal(calls.length, 0, 'nothing proxied');
    for (const id of ['vered', 'sandra']) assert.equal((await request(port, edit, personal(id))).status, 200, id);
    assert.equal(calls.filter((c) => c.action === 'editReceipt').length, 2);
    const dup = { action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'duplicate', flagNote: 'כפול' } };
    assert.equal((await request(port, dup, personal('vered'))).status, 403, 'Vered cannot decide');
    assert.equal((await request(port, dup, personal('ortal'))).status, 200, 'Ortal decides');
  });
});

test('Code.gs: editReceipt for the controller view → forbidden even with a forged finance cap; lists stay in step', () => {
  const w = twoReceipts();
  const before = w.snapshot();
  const forged = () => Object.assign(ORTAL(), { proxyCaps: ['finance', 'billingControl'] });
  assert.equal(w.edit({ id: w.a, fields: { reference: 'X1' } }, ORTAL).error, 'forbidden');
  assert.equal(w.edit({ id: w.a, fields: { reference: 'X1' } }, forged).error, 'forbidden');
  assert.equal(w.edit({ id: w.a, fields: { reference: 'X1' } }, SHIRAN).error, 'forbidden');
  assert.equal(w.snapshot(), before);
  assert.deepEqual(arr(w.g.run('FINANCE_ACTIONS')), [...scope.FINANCE_ACTIONS]);
  assert.equal([...scope.FINANCE_ACTIONS].pop(), 'editReceipt', 'appended');
  assert.ok(!scope.CONTROLLER_ACTIONS.includes('editReceipt'));
  assert.ok(arr(w.g.run('PROXY_KNOWN_ACTIONS')).includes('editReceipt'));
  assert.ok(!arr(w.g.run('OPEN_ACTIONS')).includes('editReceipt'));
  // No new column: PAYMENT_COLUMNS unchanged (append-only, nothing needed).
  assert.equal(arr(w.g.run('PAYMENT_COLUMNS')).slice(-3).join(','), 'confirmedAmount,controlNote,submissionId');   // + CHANGELOG-payment-report-persistence.md
});

test('SW: CACHE_VERSION v44 or later (v44 shipped this PR; v17 burned)', () => {
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  // v45: the «מטופלים» tab (CHANGELOG-patients-tab-ui.md) bumped past it.
  assert.ok(Number(v.slice(1)) >= 44 && v !== 'v17', v);
});

/* ============================ mutation checks ============================ */

/* The core assertions as functions returning a failure string ('' = pass),
 * so a mutated Code.gs / lib can be shown to FAIL them. */
const CHECKS = {
  detects: (src) => {
    const w = world(src);
    w.reportPay(10000, daysAgo(10));
    return w.reportPay(10000, daysAgo(2)).error === 'possible_duplicate' ? '' : 'duplicate not detected';
  },
  gap15: (src) => {
    const w = world(src);
    w.reportPay(10000, daysAgo(20));
    return w.reportPay(10000, daysAgo(5)).ok === true ? '' : '15-day gap flagged';
  },
  lastReceipt: (src) => {
    const w = world(src);
    const only = w.reportPay(10000, daysAgo(3));
    return w.decide({ ids: [only.receipt.id], status: 'duplicate', flagNote: 'כפול' }).error === 'duplicate_last_receipt' ? '' : 'last receipt voided';
  },
  noteRequired: (src) => {
    const w = twoReceipts(src);
    // 1 character: upsertPayment_ alone would accept it (it only refuses blank).
    return w.decide({ ids: [w.b], status: 'duplicate', flagNote: 'א' }).ok === false ? '' : 'voided without a real note';
  },
  allowList: (src) => {
    const w = twoReceipts(src);
    const r = w.edit({ id: w.a, fields: { amount: '1', reference: 'X1' } });
    return r.error === 'field_not_editable' && Number(w.receipt(w.a).amountPaid) === 10000 ? '' : 'amount edited';
  },
  audit: (src) => {
    const w = twoReceipts(src);
    const r = w.edit({ id: w.a, fields: { reference: 'TRX-100' } });
    return r.ok === true && w.audits('receipt_edited').length === 1 ? '' : 'no audit row';
  },
};

test('mutation check: the real Code.gs passes every core check', () => {
  for (const [name, fn] of Object.entries(CHECKS)) assert.equal(fn(undefined), '', name);
});

const MUTANTS = [
  ['B1 check removed', 'detects', "if (dup && b.confirmDuplicate !== true) {", 'if (false) {'],
  ['window widened to 15 days', 'gap15', 'const DUPLICATE_WINDOW_DAYS = 14;', 'const DUPLICATE_WINDOW_DAYS = 15;'],
  ['last-receipt guard dropped', 'lastReceipt', "if (voidMove && isVoidStatus_(payment.status) && c.duplicateGuard === true", 'if (false'],
  ['duplicate note not checked', 'noteRequired', 'if (dupNote.length < FLAG_NOTE_MIN || dupNote.length > FLAG_NOTE_MAX) return confirmError_(\'duplicate_note_invalid\');', ''],
  ['allow-list bypassed', 'allowList', "const forbidden = sent.filter(function (k) { return RECEIPT_EDIT_FIELDS.indexOf(k) < 0; });", 'const forbidden = [];'],
  ['audit row removed', 'audit', "logAudit_('receipt_edited',", "(function () {})('receipt_edited',"],
];

for (const [name, check, from, to] of MUTANTS) {
  test(`mutation check: «${name}» FAILS its check`, () => {
    assert.equal(GS_SRC.split(from).length, 2, 'the mutation site exists exactly once: ' + from);
    const mutated = GS_SRC.replace(from, to);
    let failure;
    try { failure = CHECKS[check](mutated); } catch (e) { failure = 'threw: ' + e.message; }
    assert.notEqual(failure, '', 'the mutant survived');
  });
}

test('mutation check: the «אומתו» line — a lib that prints the partial shape for a confirmed receipt FAILS', () => {
  const ok = (R) => R.confirmedMonthLine(SPLIT, '2026-10', 36774.19) === 'חלק אוקטובר: ₪36,774.19 · הקבלה המלאה ₪38,000 (תקופה 02/10–01/11) · שולם במלואו';
  assert.equal(ok(rules), true);
  const from = "if (statusOf(o) === 'partial') {";
  assert.equal(RULES_SRC.split(from).length, 2);
  const sandbox = { Intl, Date, Math, Number, String, Object, Array, RegExp, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC.replace(from, 'if (true) {'), sandbox);
  assert.equal(ok(sandbox.BillingControlRules), false, 'the mutant survived');
});
