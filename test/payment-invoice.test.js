/* The invoice on the payment report — «חשבונית?» כן / לא (no default) and
 * «על שם». See CHANGELOG-payment-invoice.md.
 *
 * Locked here:
 *   - Payments: invoiceWanted, invoiceTo APPENDED at the very end; nothing
 *     else moves; both text-forced; a header clash refuses the report;
 *   - the rules (Code.gs validatePaymentInvoice_ == lib rules, parity):
 *     no choice → invoice_choice_missing; כן without a name →
 *     invoice_to_missing; a bad name → invoice_to_invalid; לא → name '';
 *   - reportPayment refuses without the choice / without the name, nothing
 *     written; stores the values; the audit row carries the choice;
 *   - updatePayment changes both on a receipt (the one edit besides void),
 *     same validation, one payment_invoice_changed AuditLog row; nothing
 *     else on the receipt moves; an older client never wipes a choice;
 *   - a row from before the question shows «—» everywhere (page, «בקרת
 *     גבייה», the export, the email, the feed's null) — never כן / לא;
 *   - Ortal's email carries «חשבונית» / «על שם»; the feed carries the pair
 *     per cycle and per receipt; everything is escaped / formula-guarded;
 *   - restricted users can neither see nor set them.
 *
 * vm sandboxes on the real Code.gs, app.js and the shared rules. All names
 * are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ExcelJS = require('exceljs');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const rules = require('../lib/payment-report-rules');
const bcx = require('../lib/billing-control-xlsx');
const report = require('../lib/xlsx-report');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const SW_SRC = read('public', 'sw.js');
const CSS_SRC = read('public', 'style.css');
const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

const PROXY_SECRET = 'proxy-secret-INVOICE-0123456789abcdef0123456789abcdef';
const UTC_TODAY = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const p = iso.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); };
const addMonthsMinus1 = (iso) => { const p = iso.split('-').map(Number); const last = new Date(Date.UTC(p[0], p[1] + 1, 0)).getUTCDate(); return addDays(new Date(Date.UTC(p[0], p[1], Math.min(p[2], last))).toISOString().slice(0, 10), -1); };
const DUE = addDays(UTC_TODAY, -10);
const COV_END = addMonthsMinus1(DUE);
const RECEIVED = addDays(UTC_TODAY, -5);

const gsActor = (id, user, roles) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles });
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff']);

const PATIENT_KEY = 'arfoni::מטופל::2026-07-05';
const CYCLE_ID = 'pay::' + PATIENT_KEY + '::' + DUE;
const CYCLE_ROW = (extra) => Object.assign({
  id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE,
  amount: 30000, status: 'unpaid', amountPaid: 0, balance: 30000, coverageStart: DUE, coverageEnd: COV_END,
}, extra || {});
const cycleIdentity = () => ({ id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE, amount: 30000, coverageStart: DUE, coverageEnd: COV_END });
const VALID = (extra) => Object.assign({
  receivedDate: RECEIVED, amount: '10000', method: 'מזומן', payer: 'משפחת כהן', reference: '',
  funder: 'פרטי', coverageStart: DUE, coverageEnd: COV_END,
}, extra || {});

function world(opts) {
  const o = opts || {};
  const g = loadGs({ props: Object.assign({ PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' }, o.props || {}) });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' }[c] || '')));
  const paycols = arr(g.run('PAYMENT_COLUMNS'));
  S.Payments = richSheet('Payments', o.header || paycols);
  (o.rows || []).forEach((r) => S.Payments.appendRow(paycols.map((c) => (r[c] === undefined ? '' : r[c]))));
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const audits = (action) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !action || r.action === action);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  const rep = (r, who) => plain(g.post(Object.assign({ action: 'reportPayment', report: { cycle: cycleIdentity(), report: r } }, (who || VERED)())));
  const update = (payment, who) => plain(g.post(Object.assign({ action: 'updatePayment', payment }, (who || VERED)())));
  return { g, S, rows, audits, snapshot, rep, update };
}
const receiptOf = (w) => w.rows().find((r) => /^rcpt-/.test(r.id));

/* ============================ the column contract ============================ */

const BEFORE_36 = [
  'id', 'patientId', 'patientName', 'houseId', 'dueDate', 'amount', 'status', 'amountPaid', 'balance', 'timestamp',
  'coverageStart', 'coverageEnd', 'paymentUid', 'patientUid', 'payerUid',
  'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  'linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt',
  'receivedDate', 'method', 'payer', 'funder', 'reference', 'recordedBy', 'recordedAt',
  'confirmStatus', 'confirmedBy', 'confirmedAt', 'flagNote', 'legacyAmountPaid',
];

test('columns: invoiceWanted, invoiceTo are APPENDED at the very end; the 36 before them do not move; both text-forced', () => {
  const { g } = world();
  const cols = arr(g.run('PAYMENT_COLUMNS'));
  assert.deepEqual(cols.slice(0, 36), BEFORE_36, 'position IS the data contract');
  assert.deepEqual(cols.slice(36), ['invoiceWanted', 'invoiceTo']);
  assert.equal(cols.length, 38);
  assert.deepEqual(arr(g.run('PAYMENT_INVOICE_COLUMNS')), ['invoiceWanted', 'invoiceTo']);
  for (const c of ['invoiceWanted', 'invoiceTo']) assert.ok(arr(g.run('PAYMENT_TEXT_COLUMNS')).includes(c), c + ' text-forced');
  assert.deepEqual(arr(g.run('INVOICE_CHOICES')), ['yes', 'no']);
  assert.equal(g.run('INVOICE_TO_MAX'), 120);
});

test('columns: an existing 36-column sheet is extended in place; a hand-added column where invoiceWanted belongs refuses the report, nothing written', () => {
  const w = world({ header: BEFORE_36, rows: [] });
  w.g.run('getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS)');
  assert.deepEqual(w.S.Payments.grid[0], BEFORE_36.concat(['invoiceWanted', 'invoiceTo']));
  const clash = BEFORE_36.concat(['הערה ידנית']);
  assert.deepEqual(plain(w.g.sandbox.paymentInvoiceHeaderClash_(clash)), [{ column: 37, expected: 'invoiceWanted', found: 'הערה ידנית' }]);
  const w2 = world({ header: clash, rows: [] });
  const r = w2.rep(VALID({ invoiceWanted: 'no' }));
  assert.deepEqual([r.ok, r.error], [false, 'sheet_header_clash']);
  assert.equal(w2.rows().length, 0, 'no data row written');
  assert.equal(w2.S.Payments.grid[0][36], 'הערה ידנית', 'the hand-added column is left exactly as it was');
  assert.equal(w2.audits().length, 0);
});

/* ============================ the rules ============================ */

const CASES = [
  [{}, ['invoiceWanted:invoice_choice_missing']],
  [{ invoiceWanted: '' }, ['invoiceWanted:invoice_choice_missing']],
  [{ invoiceWanted: '   ' }, ['invoiceWanted:invoice_choice_missing']],
  [{ invoiceWanted: 'maybe' }, ['invoiceWanted:invoice_choice_invalid']],
  [{ invoiceWanted: 'כן' }, ['invoiceWanted:invoice_choice_invalid']],
  [{ invoiceWanted: 'YES' }, ['invoiceWanted:invoice_choice_invalid']],
  [{ invoiceWanted: 'no' }, []],
  [{ invoiceWanted: 'no', invoiceTo: 'anything — ignored' }, []],
  [{ invoiceWanted: 'yes' }, ['invoiceTo:invoice_to_missing']],
  [{ invoiceWanted: 'yes', invoiceTo: '   ' }, ['invoiceTo:invoice_to_missing']],
  [{ invoiceWanted: 'yes', invoiceTo: 'א' }, []],
  [{ invoiceWanted: 'yes', invoiceTo: 'א'.repeat(120) }, []],
  [{ invoiceWanted: 'yes', invoiceTo: 'א'.repeat(121) }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: '=HYPERLINK("x")' }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: '+972' }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: '-1' }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: '@x' }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: 'שם\nשני' }, ['invoiceTo:invoice_to_invalid']],
  [{ invoiceWanted: 'yes', invoiceTo: 'כהן בע"מ <script>' }, []],   // stored as text, escaped on output
];

test('rules: Code.gs validatePaymentInvoice_ == lib/payment-report-rules validatePaymentInvoice, case by case; messages in Hebrew', () => {
  const { g } = world();
  for (const [input, want] of CASES) {
    const gs = plain(g.sandbox.validatePaymentInvoice_(input));
    const client = plain(rules.validatePaymentInvoice(input));
    assert.deepEqual(gs, client, JSON.stringify(input));
    assert.deepEqual(gs.map((i) => i.field + ':' + i.code), want, JSON.stringify(input));
    for (const i of gs) assert.ok(/[֐-׿]/.test(i.hebrewMessage), i.code);
  }
  assert.deepEqual(plain(g.run('PAYMENT_REPORT_MESSAGES')), plain(rules.MESSAGES), 'the shared message map, word for word');
  assert.equal(rules.MESSAGES.invoice_choice_missing, 'חסר: חשבונית? — יש לבחור כן או לא');
  assert.equal(rules.MESSAGES.invoice_to_missing, 'חסר: על שם מי החשבונית');
  assert.deepEqual(arr(rules.INVOICE_FIELDS), ['invoiceWanted', 'invoiceTo']);
});

/* ============================ reportPayment ============================ */

test('reportPayment: refused WITHOUT the choice (invoice_choice_missing) and with כן but no name (invoice_to_missing) — nothing written', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  const before = w.snapshot();
  for (const [extra, field, code] of [
    [{}, 'invoiceWanted', 'invoice_choice_missing'],
    [{ invoiceWanted: 'yes' }, 'invoiceTo', 'invoice_to_missing'],
    [{ invoiceWanted: 'yes', invoiceTo: '' }, 'invoiceTo', 'invoice_to_missing'],
    [{ invoiceWanted: 'yes', invoiceTo: '=1+1' }, 'invoiceTo', 'invoice_to_invalid'],
    [{ invoiceWanted: 'true' }, 'invoiceWanted', 'invoice_choice_invalid'],
  ]) {
    const r = w.rep(VALID(extra));
    assert.deepEqual([r.ok, r.error], [false, 'invalid_report'], JSON.stringify(extra));
    assert.deepEqual(r.issues.map((i) => i.field + ':' + i.code), [field + ':' + code], JSON.stringify(extra));
    assert.equal(r.issues[0].hebrewMessage, rules.MESSAGES[code]);
  }
  assert.equal(w.snapshot(), before, 'nothing written by any refusal');
  assert.equal(w.audits().length, 0);
});

test('reportPayment: stores כן + the trimmed name, or לא + \'\' (a name sent with לא is dropped); the audit row carries the choice', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  const yes = w.rep(VALID({ amount: '10000', invoiceWanted: 'yes', invoiceTo: '  כהן אחזקות בע"מ  ' }));
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(yes.receipt.invoiceWanted, 'yes');
  assert.equal(yes.receipt.invoiceTo, 'כהן אחזקות בע"מ');
  const no = w.rep(VALID({ amount: '5000', invoiceWanted: 'no', invoiceTo: 'לא אמור להישמר' }));
  assert.equal(no.ok, true, JSON.stringify(no));
  const rs = w.rows().filter((r) => /^rcpt-/.test(r.id));
  assert.deepEqual(rs.map((r) => [r.invoiceWanted, r.invoiceTo]), [['yes', 'כהן אחזקות בע"מ'], ['no', '']]);
  const cyc = w.rows().find((r) => r.id === CYCLE_ID);
  assert.deepEqual([cyc.invoiceWanted, cyc.invoiceTo], ['', ''], 'the cycle row carries no choice of its own');
  const aud = w.audits('payment_reported').map((a) => JSON.parse(a.details).invoiceWanted);
  assert.deepEqual(aud, ['yes', 'no']);
});

/* ============================ updatePayment ============================ */

test('updatePayment: a receipt\'s invoice may change (same rules), one payment_invoice_changed audit row; nothing else on it moves', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.rep(VALID({ amount: '10000', invoiceWanted: 'no' }));
  const rc = receiptOf(w);
  // refused: כן without a name — nothing written
  let before = w.snapshot();
  const bad = w.update(Object.assign({}, rc, { invoiceWanted: 'yes', invoiceTo: '' }));
  assert.deepEqual([bad.ok, bad.error], [false, 'validation']);
  assert.equal(bad.fields[0].code, 'invoice_to_missing');
  assert.equal(w.snapshot(), before);
  // accepted: כן + a name; the money and every other cell are the stored ones
  const ok = w.update(Object.assign({}, rc, { invoiceWanted: 'yes', invoiceTo: 'משפחת לוי', amountPaid: 99999, payer: 'מתחזה', method: 'ביט' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const after = receiptOf(w);
  assert.deepEqual([after.invoiceWanted, after.invoiceTo], ['yes', 'משפחת לוי']);
  for (const k of ['amountPaid', 'amount', 'payer', 'method', 'receivedDate', 'funder', 'status', 'confirmStatus', 'recordedBy']) {
    assert.equal(String(after[k]), String(rc[k]), k + ' unchanged');
  }
  const a = w.audits('payment_invoice_changed');
  assert.equal(a.length, 1);
  const d = JSON.parse(a[0].details);
  assert.deepEqual([d.old, d.new], [{ invoiceWanted: 'no', invoiceTo: '' }, { invoiceWanted: 'yes', invoiceTo: 'משפחת לוי' }]);
  assert.equal(d.by, 'ורד');
  assert.equal(a[0].actor, 'ורד');
  // back to לא: the name is cleared
  assert.equal(w.update(Object.assign({}, after, { invoiceWanted: 'no' })).ok, true);
  assert.deepEqual([receiptOf(w).invoiceWanted, receiptOf(w).invoiceTo], ['no', '']);
  assert.equal(w.audits('payment_invoice_changed').length, 2);
  // an older client (no invoice fields, or a blank choice) changes nothing — and a receipt stays immutable
  before = w.snapshot();
  const stale = Object.assign({}, receiptOf(w)); delete stale.invoiceWanted; delete stale.invoiceTo;
  assert.equal(w.update(Object.assign(stale, { amountPaid: 1 })).error, 'receipt_immutable');
  assert.equal(w.update(Object.assign({}, receiptOf(w), { invoiceWanted: '', invoiceTo: '' })).error, 'receipt_immutable');
  assert.equal(w.snapshot(), before);
});

test('updatePayment: a legacy receipt (no choice) can be given one; a cycle row takes the same rules', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.rep(VALID({ amount: '10000', invoiceWanted: 'no' }));
  // make the receipt look legacy: blank pair, as rows written before this change
  const rcRow = w.S.Payments.grid.findIndex((g) => /^rcpt-/.test(String(g[0])));
  const cols = arr(w.g.run('PAYMENT_COLUMNS'));
  w.S.Payments.grid[rcRow][cols.indexOf('invoiceWanted')] = '';
  const legacy = receiptOf(w);
  assert.equal(legacy.invoiceWanted, '');
  assert.equal(w.update(Object.assign({}, legacy, { invoiceWanted: 'yes', invoiceTo: 'קרן סיוע' })).ok, true);
  assert.deepEqual([receiptOf(w).invoiceWanted, receiptOf(w).invoiceTo], ['yes', 'קרן סיוע']);
  const cyc = w.rows().find((r) => r.id === CYCLE_ID);
  const bad = w.update(Object.assign({}, cyc, { invoiceWanted: 'maybe' }));
  assert.equal(bad.fields[0].code, 'invoice_choice_invalid');
  const good = w.update(Object.assign({}, cyc, { invoiceWanted: 'yes', invoiceTo: 'קרן' }));
  assert.equal(good.ok, true, JSON.stringify(good));
});

/* ============================ restricted ============================ */

test('restricted: Shiran can neither report nor change the invoice — refused, nothing written; she gets no payment rows to see it', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.rep(VALID({ amount: '10000', invoiceWanted: 'no' }));
  const before = w.snapshot();
  const r1 = w.rep(VALID({ invoiceWanted: 'yes', invoiceTo: 'x' }), SHIRAN);
  const r2 = w.update(Object.assign({}, receiptOf(w), { invoiceWanted: 'yes', invoiceTo: 'x' }), SHIRAN);
  const r3 = plain(w.g.post(Object.assign({ action: 'getPayments' }, SHIRAN())));
  for (const r of [r1, r2, r3]) assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(w.snapshot(), before);
  assert.ok(!JSON.stringify(r3).includes('invoice'));
});

/* ============================ Ortal's email ============================ */

test('digest: «חשבונית» / «על שם» columns — כן + name, לא, and «—» for a row from before the question; escaped', () => {
  const { g } = world();
  const at = '2026-09-30T12:00:00+03:00';
  const base = { status: 'paid', amountPaid: 100, amount: 100, houseId: 'ramot', chargedAt: at, receivedDate: '2026-09-30', method: 'מזומן' };
  const rows = [
    Object.assign({ id: 'rcpt-1', patientName: 'א', invoiceWanted: 'yes', invoiceTo: '<b>כהן</b> & בניו' }, base),
    Object.assign({ id: 'rcpt-2', patientName: 'ב', invoiceWanted: 'no', invoiceTo: 'לא מוצג' }, base),
    Object.assign({ id: 'rcpt-3', patientName: 'ג' }, base),
  ].map((o) => g.sandbox.digestRow_(o, {}));
  assert.deepEqual(rows.map((r) => [r.invoice, r.invoiceTo]), [['כן', '<b>כהן</b> & בניו'], ['לא', ''], ['', '']]);
  const msg = g.sandbox.digestCompose_(rows, { todayDmy: '30/09/2026', sinceText: 'a', untilText: 'b', firstRun: false, test: false });
  assert.ok(msg.htmlBody.includes('>חשבונית<') && msg.htmlBody.includes('>על שם<'));
  assert.ok(msg.htmlBody.includes('&lt;b&gt;כהן&lt;/b&gt; &amp; בניו'), 'escaped');
  assert.ok(!msg.htmlBody.includes('<b>כהן'), 'never raw');
  assert.ok(!msg.htmlBody.includes('לא מוצג') && !msg.body.includes('לא מוצג'), 'a name under לא is never shown');
  assert.ok(msg.body.includes('| חשבונית | על שם |'));
  const legacyLine = msg.body.split('\n').find((l) => l.startsWith('ג |'));
  assert.ok(legacyLine && legacyLine.includes('| — | — |'), legacyLine);
});

/* ============================ the accounting feed ============================ */

test('feed: each cycle carries its receipts\' invoices (yes / no / null for legacy), its own pair null; the cycle re-surfaces when a receipt\'s invoice changes', () => {
  const w = world({ rows: [CYCLE_ROW()] });
  w.rep(VALID({ amount: '10000', invoiceWanted: 'yes', invoiceTo: 'משפחת לוי' }));
  w.rep(VALID({ amount: '5000', invoiceWanted: 'no' }));
  const cols = arr(w.g.run('PAYMENT_COLUMNS'));
  const rcRows = w.S.Payments.grid.map((g, i) => [g, i]).filter(([g]) => /^rcpt-/.test(String(g[0])));
  w.S.Payments.grid[rcRows[1][1]][cols.indexOf('invoiceWanted')] = '';   // a legacy-looking receipt
  const out = plain(w.g.sandbox.accountingPayments_({}));
  assert.equal(out.ok, true);
  assert.equal(out.payments.length, 1, 'still one record per cycle');
  const p = out.payments[0];
  assert.equal(p.invoiceWanted, null);
  assert.equal(p.invoiceTo, null);
  assert.deepEqual(p.invoices.map((x) => [x.invoiceWanted, x.invoiceTo, x.amount, x.void]), [['yes', 'משפחת לוי', 10000, false], [null, null, 5000, false]]);
  assert.ok(p.invoices.every((x) => /^pmt-/.test(String(x.receiptUid))));
  // An incremental read after a receipt's invoice changes returns the cycle again.
  const since = out.serverTime;
  const rc = receiptOf(w);
  assert.equal(w.update(Object.assign({}, rc, { invoiceWanted: 'no' })).ok, true);
  const later = plain(w.g.sandbox.accountingPayments_({ updatedSince: since }));
  assert.equal(later.ok, true);
  assert.equal(later.payments.length, 1);
  assert.equal(later.payments[0].invoices[0].invoiceWanted, 'no');
});

/* ============================ the page ============================ */

function fakeEl(id) {
  return {
    id: id || '', _html: '', textContent: '', value: '', children: [], style: {}, dataset: {},
    classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, toggle() {}, contains(c) { return this._c.has(c); } },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, remove() {}, closest() { return null; },
  };
}
function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: { addEventListener: noop, body: fakeEl('body'), getElementById: (id) => (els[id] || (els[id] = fakeEl(id))), createElement: () => fakeEl(), querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map, Intl,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      get state() { return state; },
      invoiceLabel, invoiceToLabel, normalizeReceipt, receiptsListHtml, bcReceiptHtml, paymentReportIssues, paymentReportDefaults,
      openPaymentReportModal, PAYMENT_REPORT_FORM_FIELDS,
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.receipts = [];
  return { app, els };
}

test('page: the form has «חשבונית?» with NO default; the shared rules refuse it unanswered, כן without a name; לא passes', () => {
  const { app } = loadApp();
  assert.deepEqual(arr(app.PAYMENT_REPORT_FORM_FIELDS).slice(-2), ['invoiceWanted', 'invoiceTo']);
  const d = app.paymentReportDefaults({ name: 'מטופל', houseId: 'arfoni', date: '2026-07-05', pay: 30000 }, CYCLE_ROW(), DUE, UTC_TODAY);
  assert.equal(d.report.invoiceWanted, '', 'no default');
  const codes = (v) => plain(app.paymentReportIssues(VALID(v), UTC_TODAY, false)).map((i) => i.code);
  assert.deepEqual(codes({}), ['invoice_choice_missing']);
  assert.deepEqual(codes({ invoiceWanted: 'yes', invoiceTo: '' }), ['invoice_to_missing']);
  assert.deepEqual(codes({ invoiceWanted: 'yes', invoiceTo: 'משפחת כהן' }), []);
  assert.deepEqual(codes({ invoiceWanted: 'no' }), []);
  // the markup: two radios, neither checked; «על שם» hidden until כן
  const src = APP_SRC.slice(APP_SRC.indexOf('function openPaymentReportModal('), APP_SRC.indexOf('async function submitPaymentReport('));
  assert.match(src, /<input type="radio" name="invoiceWanted" value="yes" \/> כן/);
  assert.match(src, /<input type="radio" name="invoiceWanted" value="no" \/> לא/);
  assert.ok(!/<input type="radio" name="invoiceWanted"[^>]*checked/.test(src), 'no radio is pre-checked');
  assert.match(src, /class="form-row pr-invoice-to hidden"/);
  assert.match(src, /to\.value = String\(\(ctl\('payer'\) \|\| \{\}\)\.value \|\| ''\)\.trim\(\)/, 'כן prefills «על שם» from the payer');
  assert.match(src, /if \(v\.invoiceWanted !== 'yes'\) v\.invoiceTo = '';/, 'לא sends an empty name');
  assert.ok(/\.pr-radio \{[^}]*min-height: 44px/.test(CSS_SRC), '44px tap targets');
});

test('page: the גבייה receipt and the «בקרת גבייה» card show כן + name / לא, and «—» for a row from before the question; escaped', () => {
  const { app } = loadApp();
  assert.equal(app.invoiceLabel('yes'), 'כן');
  assert.equal(app.invoiceLabel('no'), 'לא');
  for (const v of ['', undefined, null, 'maybe', 'toString', '__proto__']) assert.equal(app.invoiceLabel(v), '—', String(v));
  const mk = (id, extra) => app.normalizeReceipt(Object.assign({ id, cycleId: CYCLE_ID, amountPaid: 100, status: 'paid', receivedDate: RECEIVED, method: 'מזומן' }, extra));
  app.state.receipts = [
    mk('rcpt-y', { invoiceWanted: 'yes', invoiceTo: '<img src=x onerror=alert(1)>' }),
    mk('rcpt-n', { invoiceWanted: 'no', invoiceTo: 'לא מוצג' }),
    mk('rcpt-l', {}),
  ];
  assert.equal(app.state.receipts[2].invoiceWanted, '');
  const html = app.receiptsListHtml(CYCLE_ID);
  assert.ok(html.includes('חשבונית: כן · על שם &lt;img src=x onerror=alert(1)&gt;'), html);
  assert.ok(!html.includes('<img'), 'escaped');
  assert.ok(html.includes('חשבונית: לא<'));
  assert.ok(html.includes('חשבונית: —<'), 'legacy → «—»');
  assert.ok(!html.includes('לא מוצג'));
  const card = (r) => app.bcReceiptHtml(r, 'confirmed', {});
  assert.match(card({ id: 'a', invoiceWanted: 'yes', invoiceTo: 'קרן' }), /<span class="bc-k">חשבונית<\/span> <span class="bc-v">כן<\/span>[\s\S]*<span class="bc-k">על שם<\/span> <span class="bc-v">קרן<\/span>/);
  assert.match(card({ id: 'b' }), /<span class="bc-k">חשבונית<\/span> <span class="bc-v">—<\/span>[\s\S]*<span class="bc-k">על שם<\/span> <span class="bc-v">—<\/span>/);
});

test('page: a restricted session never opens the form (no invoice field to see or set)', () => {
  const { app, els } = loadApp({ finance: false });
  app.state.mode = 'edit';
  // openPaymentReportModal returns before touching the DOM for a restricted view
  app.openPaymentReportModal({ name: 'x' }, CYCLE_ROW(), DUE);
  assert.equal(els['modal-root'], undefined, 'the modal root is never even looked up');
  assert.ok(/function openPaymentReportModal\(patient, payment, dueDateISO\) \{\n  if \(!financeView\(\) \|\| state\.mode !== 'edit'\) return;/.test(APP_SRC));
});

/* ============================ the export workbook ============================ */

test('«ייצוא אימות»: «חשבונית» / «על שם» columns after «גורם מממן»; legacy «—»; formula-guarded', async () => {
  const today = '2026-10-04';
  const r = (id, extra) => Object.assign({ id, patientName: 'מטופל', houseId: 'arfoni', amount: 100, receivedDate: today, confirmStatus: 'reported', recordedAt: '', method: 'מזומן', funder: 'פרטי', recordedBy: 'ורד' }, extra);
  const data = { ok: true, today, counts: {}, receipts: [
    r('rcpt-1', { invoiceWanted: 'yes', invoiceTo: '=HYPERLINK("x")' }),
    r('rcpt-2', { invoiceWanted: 'no', invoiceTo: '' }),
    r('rcpt-3', {}),
  ] };
  const buf = await report.buildXlsxReport(bcx.buildBillingControlSpec(data, new Date()));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('ממתין לאימות');
  const lines = [];
  ws.eachRow((row) => lines.push(row.values.slice(1).map((v) => (v instanceof Date ? 'D' : String(v == null ? '' : v))).join('|')));
  const all = lines.join('\n');
  assert.ok(all.includes('גורם מממן|חשבונית|על שם|נרשם ע״י'), all.slice(0, 400));
  assert.ok(all.includes(`|כן|'=HYPERLINK("x")|`), 'formula-guarded');
  assert.ok(lines.some((l) => l.includes('|פרטי|לא|—|')));
  assert.ok(lines.some((l) => l.includes('|פרטי|—|—|')), 'legacy → «—»');
});

test('SW: at least v38 (above the live v34 and open PRs #181 / #182 / #183), with its bump comment', () => {
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 38, 'v' + v);   // a later PR may bump it again
  assert.ok(SW_SRC.includes('v37 → v38:'));
});
