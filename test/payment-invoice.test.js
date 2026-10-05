/* The invoice choice on the payment report. See CHANGELOG-payment-invoice.md.
 *
 * Locked here (Sandra, 2026-10-05):
 *   - Payments gains invoiceWanted ('yes' | 'no') and invoiceTo (free text,
 *     1–120 chars, formula-guarded), APPENDED at the end, text-forced
 *   - «חשבונית?» has NO default: reportPayment refuses a report without it
 *     (invoice_choice_missing) and, when כן, without «על שם»
 *     (invoice_to_missing) — nothing written; when לא, invoiceTo is ''
 *   - the server rule (validateInvoiceChoice_) and the form's
 *     (PaymentReportRules.validateInvoiceChoice) answer the same
 *   - updatePayment may change both — the same validation — and writes one
 *     AuditLog row (payment_invoice_changed: old, new, by); every other
 *     column of a receipt stays immutable
 *   - shown on the receipt line, Ortal's card, the daily email («חשבונית» /
 *     «על שם»), the accounting feed and the workbooks; a row from before the
 *     choice shows «—», never כן / לא; everything escaped
 *   - restricted users (Shiran / Yael) can neither see nor set it
 *
 * vm sandboxes on the real Code.gs and app.js. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');
const rules = require('../lib/payment-report-rules');
const scope = require('../lib/finance-scope');
const cleanup = require('../lib/cleanup-xlsx');
const bcx = require('../lib/billing-control-xlsx');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'payment-report-rules.js'), 'utf8');
const FUNDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'funder.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
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
const YAEL = () => gsActor('yael', 'יעל', ['staff']);

const PATIENT_KEY = 'arfoni::מטופל::2026-07-05';
const CYCLE_ID = 'pay::' + PATIENT_KEY + '::' + DUE;
const CYCLE_ROW = () => ({ id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE,
  amount: 30000, status: 'unpaid', amountPaid: 0, balance: 30000, coverageStart: DUE, coverageEnd: COV_END });
const cycleIdentity = () => ({ id: CYCLE_ID, patientId: PATIENT_KEY, patientName: 'מטופל', houseId: 'arfoni', dueDate: DUE, amount: 30000,
  coverageStart: DUE, coverageEnd: COV_END });
const VALID = (extra) => Object.assign({
  receivedDate: RECEIVED, amount: '10000', method: 'מזומן', payer: 'משפחת כהן', reference: '',
  funder: 'פרטי', coverageStart: DUE, coverageEnd: COV_END,
}, extra || {});

function world(opts) {
  const o = opts || {};
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-07-05', pay: 30000, status: 'active' }[c] || '')));
  const paycols = arr(g.run('PAYMENT_COLUMNS'));
  S.Payments = richSheet('Payments', paycols);
  (o.rows || [CYCLE_ROW()]).forEach((r) => S.Payments.appendRow(paycols.map((c) => (r[c] === undefined ? '' : r[c]))));
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const audits = (action) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !action || r.action === action);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  const report = (rep, who) => plain(g.post(Object.assign({ action: 'reportPayment',
    report: { cycle: cycleIdentity(), report: rep } }, (who || VERED)())));
  const update = (payment, who) => plain(g.post(Object.assign({ action: 'updatePayment', payment }, (who || VERED)())));
  return { g, S, rows, audits, snapshot, report, update };
}
const receiptOf = (w) => w.rows().find((r) => /^rcpt-/.test(String(r.id)));
const receiptPayload = (r, extra) => Object.assign({ id: r.id, patientId: r.patientId, patientName: r.patientName, houseId: r.houseId,
  dueDate: r.dueDate, status: r.status, linkStatus: r.linkStatus, linkNote: r.linkNote }, extra || {});

/* ============================ the columns ============================ */

test('columns: invoiceWanted, invoiceTo APPENDED at the END, in that order, text-forced; nothing above moves', () => {
  const g = loadGs();
  const cols = arr(g.run('PAYMENT_COLUMNS'));
  assert.deepEqual(cols.slice(-2), ['invoiceWanted', 'invoiceTo']);
  assert.equal(cols.length, 38);
  assert.equal(cols[35], 'legacyAmountPaid', 'the previous last column did not move');
  assert.deepEqual(arr(g.run('PAYMENT_INVOICE_COLUMNS')), ['invoiceWanted', 'invoiceTo']);
  const text = arr(g.run('PAYMENT_TEXT_COLUMNS'));
  assert.ok(text.includes('invoiceWanted') && text.includes('invoiceTo'), 'text-forced: a name is never coerced');
  assert.ok(!arr(g.run('PAYMENT_SERVER_COLUMNS')).includes('invoiceWanted'), 'a person\'s choice, not a server stamp');
  assert.deepEqual(arr(rules.INVOICE_FIELDS), ['invoiceWanted', 'invoiceTo']);
  assert.deepEqual(arr(rules.INVOICE_CHOICES), arr(g.run('INVOICE_CHOICES')));
  assert.equal(rules.INVOICE_TO_MAX, g.run('INVOICE_TO_MAX'));
  assert.equal(rules.INVOICE_TO_MAX, 120);
  // a hand-added column where an invoice column belongs is a clash
  const header = cols.slice(); header[36] = 'הערה';
  assert.deepEqual(plain(g.sandbox.invoiceHeaderClash_(header)), [{ column: 37, expected: 'invoiceWanted', found: 'הערה' }]);
  assert.deepEqual(plain(g.sandbox.invoiceHeaderClash_(cols)), []);
});

/* ============================ the rule ============================ */

test('rule: Code.gs validateInvoiceChoice_ == the form\'s validateInvoiceChoice on every case; Hebrew messages pinned', () => {
  const g = loadGs();
  const long = 'א'.repeat(120), tooLong = 'א'.repeat(121);
  const cases = [
    [{}, ['invoiceWanted:invoice_choice_missing']],
    [{ invoiceWanted: '' }, ['invoiceWanted:invoice_choice_missing']],
    [{ invoiceWanted: '  ' }, ['invoiceWanted:invoice_choice_missing']],
    [{ invoiceWanted: 'כן' }, ['invoiceWanted:invoice_choice_invalid']],
    [{ invoiceWanted: 'YES' }, ['invoiceWanted:invoice_choice_invalid']],
    [{ invoiceWanted: 'no' }, []],
    [{ invoiceWanted: 'no', invoiceTo: '=HYPERLINK("x")' }, []],
    [{ invoiceWanted: 'yes' }, ['invoiceTo:invoice_to_missing']],
    [{ invoiceWanted: 'yes', invoiceTo: '   ' }, ['invoiceTo:invoice_to_missing']],
    [{ invoiceWanted: 'yes', invoiceTo: 'א' }, []],
    [{ invoiceWanted: 'yes', invoiceTo: long }, []],
    [{ invoiceWanted: 'yes', invoiceTo: tooLong }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: '=1+1' }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: '+972' }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: '@SUM(A1)' }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: '-2' }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: 'שם\nשורה' }, ['invoiceTo:invoice_to_invalid']],
    [{ invoiceWanted: 'yes', invoiceTo: 'בע"מ <חברה> & שות\'' }, []],
    [{ invoiceWanted: ' yes ', invoiceTo: ' משפחת כהן ' }, []],
  ];
  for (const [input, want] of cases) {
    const gs = plain(g.sandbox.validateInvoiceChoice_(input));
    const js = plain(rules.validateInvoiceChoice(input));
    assert.deepEqual(gs.map((i) => i.field + ':' + i.code), want, JSON.stringify(input));
    assert.deepEqual(js, gs, 'parity ' + JSON.stringify(input));
  }
  assert.equal(rules.MESSAGES.invoice_choice_missing, 'חסר: האם להפיק חשבונית (כן / לא)');
  assert.equal(rules.MESSAGES.invoice_to_missing, 'חסר: על שם מי החשבונית');
  for (const k of ['invoice_choice_missing', 'invoice_choice_invalid', 'invoice_to_missing', 'invoice_to_invalid']) {
    assert.equal(g.run('PAYMENT_REPORT_MESSAGES.' + k), rules.MESSAGES[k], k);
  }
});

/* ============================ reportPayment ============================ */

test('report: REFUSED without the choice — invoice_choice_missing in Hebrew, nothing written', () => {
  const w = world();
  const before = w.snapshot();
  const r = w.report(VALID());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_report');
  assert.deepEqual(r.issues.map((i) => [i.field, i.code, i.hebrewMessage]),
    [['invoiceWanted', 'invoice_choice_missing', 'חסר: האם להפיק חשבונית (כן / לא)']]);
  assert.equal(w.snapshot(), before, 'nothing written');
  assert.equal(w.audits('payment_reported').length, 0);
});

test('report: כן without «על שם» → invoice_to_missing; a formula lead-in or 121 chars → invoice_to_invalid; nothing written', () => {
  const w = world();
  const before = w.snapshot();
  for (const [to, code] of [[undefined, 'invoice_to_missing'], ['', 'invoice_to_missing'], ['=cmd|calc', 'invoice_to_invalid'], ['א'.repeat(121), 'invoice_to_invalid']]) {
    const r = w.report(VALID({ invoiceWanted: 'yes', invoiceTo: to }));
    assert.equal(r.error, 'invalid_report', String(to));
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
  }
  // other issues are still reported beside it, in one answer
  const both = w.report(VALID({ payer: '', invoiceWanted: '' }));
  assert.deepEqual(both.issues.map((i) => i.code), ['payer_missing', 'invoice_choice_missing']);
  assert.equal(w.snapshot(), before);
});

test('report: the stored values — כן keeps the trimmed name; לא stores \'\' whatever was typed; the audit row carries the choice', () => {
  const w = world();
  const yes = w.report(VALID({ invoiceWanted: 'yes', invoiceTo: '  משפחת כהן בע"מ  ' }));
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.deepEqual([yes.receipt.invoiceWanted, yes.receipt.invoiceTo], ['yes', 'משפחת כהן בע"מ']);
  const r1 = receiptOf(w);
  assert.deepEqual([r1.invoiceWanted, r1.invoiceTo], ['yes', 'משפחת כהן בע"מ']);
  const no = w.report(VALID({ amount: '5000', invoiceWanted: 'no', invoiceTo: 'לא אמור להישמר' }));
  assert.equal(no.ok, true);
  const r2 = w.rows().filter((r) => /^rcpt-/.test(String(r.id)))[1];
  assert.deepEqual([r2.invoiceWanted, r2.invoiceTo], ['no', '']);
  // the cycle row keeps no invoice of its own
  const cyc = w.rows().find((r) => r.id === CYCLE_ID);
  assert.deepEqual([cyc.invoiceWanted, cyc.invoiceTo], ['', '']);
  const a = w.audits('payment_reported').map((x) => JSON.parse(x.details));
  assert.equal(a.length, 2);
  assert.deepEqual([a[0].invoiceWanted, a[0].invoiceTo], ['yes', 'משפחת כהן בע"מ'], 'the audit row carries the choice');
  assert.deepEqual([a[1].invoiceWanted, a[1].invoiceTo], ['no', '']);
});

/* ============================ updatePayment ============================ */

test('update: a receipt\'s choice may change — validated like a report, ONE AuditLog row (old, new, by); everything else stays immutable', () => {
  const w = world();
  assert.equal(w.report(VALID({ invoiceWanted: 'no' })).ok, true);
  const rc = receiptOf(w);
  const before = w.snapshot();
  // invalid → refused, nothing written
  const bad = w.update(receiptPayload(rc, { invoiceWanted: 'yes', invoiceTo: '' }));
  assert.deepEqual([bad.ok, bad.error], [false, 'validation']);
  assert.equal(bad.message, 'חסר: על שם מי החשבונית');
  const bad2 = w.update(receiptPayload(rc, { invoiceWanted: 'maybe' }));
  assert.equal(bad2.error, 'validation');
  assert.equal(w.snapshot(), before, 'nothing written');
  // valid → stored + audited
  const ok = w.update(receiptPayload(rc, { invoiceWanted: 'yes', invoiceTo: 'קרן הסיוע', amountPaid: 99999, payer: 'מתחזה' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const after = receiptOf(w);
  assert.deepEqual([after.invoiceWanted, after.invoiceTo], ['yes', 'קרן הסיוע']);
  assert.equal(Number(after.amountPaid), 10000, 'the money never moves');
  assert.equal(after.payer, 'משפחת כהן', 'no other column is edited');
  const au = w.audits('payment_invoice_changed');
  assert.equal(au.length, 1);
  const det = JSON.parse(au[0].details);
  assert.deepEqual(det.old, { invoiceWanted: 'no', invoiceTo: '' });
  assert.deepEqual(det.new, { invoiceWanted: 'yes', invoiceTo: 'קרן הסיוע' });
  assert.equal(det.by, 'ורד');
  assert.equal(det.paymentId, rc.id);
  // the same choice again is no change: the receipt stays immutable, no second audit row
  const again = w.update(receiptPayload(after, { invoiceWanted: 'yes', invoiceTo: 'קרן הסיוע' }));
  assert.equal(again.error, 'receipt_immutable');
  assert.equal(w.audits('payment_invoice_changed').length, 1);
  // לא clears the name
  assert.equal(w.update(receiptPayload(after, { invoiceWanted: 'no', invoiceTo: 'קרן הסיוע' })).ok, true);
  assert.deepEqual([receiptOf(w).invoiceWanted, receiptOf(w).invoiceTo], ['no', '']);
  assert.equal(w.audits('payment_invoice_changed').length, 2);
  // an edit that is not an invoice change is still refused
  assert.equal(w.update(receiptPayload(receiptOf(w), { payer: 'אחר' })).error, 'receipt_immutable');
});

test('update: a legacy cycle row may get a choice too; a save that does not send the fields keeps them', () => {
  const w = world({ rows: [Object.assign(CYCLE_ROW(), { invoiceWanted: 'yes', invoiceTo: 'משפחה' })] });
  const cyc = () => w.rows().find((r) => r.id === CYCLE_ID);
  // a client that has never heard of the fields (link-only save): unchanged
  const r = w.update(Object.assign(CYCLE_ROW(), { linkNote: '' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([cyc().invoiceWanted, cyc().invoiceTo], ['yes', 'משפחה']);
  // blank is "not sending", never "clear"
  assert.equal(w.update(Object.assign(CYCLE_ROW(), { invoiceWanted: '' })).ok, true);
  assert.equal(cyc().invoiceWanted, 'yes');
  assert.equal(w.audits('payment_invoice_changed').length, 0);
  // a formula in the name is refused on the edit path too
  assert.equal(w.update(Object.assign(CYCLE_ROW(), { invoiceTo: '=HYPERLINK("http://x")' })).error, 'validation');
  assert.equal(cyc().invoiceTo, 'משפחה');
});

/* ============================ display ============================ */

test('display: a row from before the choice shows «—» everywhere — never כן or לא', () => {
  const g = loadGs();
  const cases = [
    [{}, { wanted: '—', to: '—' }],
    [{ invoiceWanted: '' , invoiceTo: 'שם תועה' }, { wanted: '—', to: '—' }],
    [{ invoiceWanted: 'maybe' }, { wanted: '—', to: '—' }],
    [{ invoiceWanted: 'no', invoiceTo: 'x' }, { wanted: 'לא', to: '—' }],
    [{ invoiceWanted: 'yes', invoiceTo: 'משפחת כהן' }, { wanted: 'כן', to: 'משפחת כהן' }],
    [{ invoiceWanted: 'yes', invoiceTo: '' }, { wanted: 'כן', to: '—' }],
  ];
  for (const [row, want] of cases) {
    assert.deepEqual(plain(g.sandbox.paymentInvoiceDisplay_(row)), want, JSON.stringify(row));
    assert.deepEqual(plain(rules.invoiceDisplay(row)), want, 'parity ' + JSON.stringify(row));
  }
});

/* ============================ the daily email ============================ */

test('digest: columns «חשבונית» / «על שם» in the HTML and the text; legacy «—»; the name is HTML-escaped', () => {
  const g = loadGs();
  const since = Date.parse('2026-09-01T00:00:00+03:00'), until = Date.parse('2026-10-01T00:00:00+03:00');
  const row = (id, f) => Object.assign({ id, patientName: id, houseId: 'ramot', dueDate: '2026-09-10', amount: 1000, amountPaid: 1000,
    status: 'paid', chargedAt: '2026-09-12T10:00:00+03:00' }, f);
  const rows = plain(g.sandbox.digestSelect_([
    row('יש', { invoiceWanted: 'yes', invoiceTo: '<b>חברה</b> & בניו' }),
    row('אין', { invoiceWanted: 'no' }),
    row('ישן', {}),
  ], since, until, {}));
  const byName = Object.fromEntries(rows.map((r) => [r.patientName, r]));
  assert.deepEqual([byName['יש'].invoiceWanted, byName['יש'].invoiceTo], ['כן', '<b>חברה</b> & בניו']);
  assert.deepEqual([byName['אין'].invoiceWanted, byName['אין'].invoiceTo], ['לא', '—']);
  assert.deepEqual([byName['ישן'].invoiceWanted, byName['ישן'].invoiceTo], ['—', '—']);
  const msg = plain(g.sandbox.digestCompose_(g.sandbox.digestSelect_([row('יש', { invoiceWanted: 'yes', invoiceTo: '<b>חברה</b> & בניו' }), row('ישן', {})], since, until, {}),
    { todayDmy: '30/09/2026', sinceText: 'a', untilText: 'b', firstRun: false, test: false }));
  assert.match(msg.htmlBody, />חשבונית</); assert.match(msg.htmlBody, />על שם</);
  assert.match(msg.htmlBody, /&lt;b&gt;חברה&lt;\/b&gt; &amp; בניו/);
  assert.ok(!msg.htmlBody.includes('<b>חברה</b>'), 'never raw HTML');
  assert.match(msg.body, /\| חשבונית \| על שם \|/);
  assert.match(msg.body, /כן \| <b>חברה<\/b> & בניו/, 'the text part is plain text');
});

/* ============================ the accounting feed ============================ */

test('feed: each cycle carries `invoices` (one per live receipt: yes / no / null) and an invoice edit re-surfaces its cycle', () => {
  const w = world();
  assert.equal(w.report(VALID({ invoiceWanted: 'yes', invoiceTo: 'משפחת כהן' })).ok, true);
  assert.equal(w.report(VALID({ amount: '5000', invoiceWanted: 'no' })).ok, true);
  // a legacy receipt with no choice (written straight onto the sheet)
  const paycols = arr(w.g.run('PAYMENT_COLUMNS'));
  const legacy = Object.assign({}, receiptOf(w), { id: 'rcpt-legacy', paymentUid: '', amountPaid: 1000, amount: 1000, invoiceWanted: '', invoiceTo: '' });
  w.S.Payments.appendRow(paycols.map((c) => (legacy[c] === undefined ? '' : legacy[c])));
  // The feed's own gate (ACCOUNTING_SECRET) is test/accounting-source-feed.test.js's; here the function itself.
  const feed = (since) => plain(w.g.sandbox.accountingPayments_(since ? { updatedSince: since } : {}));
  const res = feed();
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
  assert.equal(res.payments.length, 1, 'one record per cycle — receipts are not records');
  const p = res.payments[0];
  assert.deepEqual([p.invoiceWanted, p.invoiceTo], [null, null], 'the cycle row has no choice of its own');
  assert.deepEqual(p.invoices.map((i) => [i.invoiceWanted, i.invoiceTo, i.amount]).sort(),
    [['no', null, 5000], ['yes', 'משפחת כהן', 10000], [null, null, 1000]].sort());
  for (const i of p.invoices) assert.deepEqual(Object.keys(i).sort(), ['amount', 'invoiceTo', 'invoiceWanted', 'receiptId', 'receivedDate']);
  // an incremental sync after the edit returns the cycle again: age every
  // row's stamp first, so "since" sees nothing until the edit
  const at = paycols.indexOf('sourceUpdatedAt');
  w.S.Payments.grid.slice(1).forEach((g) => { g[at] = '2026-01-01T09:00:00+02:00'; });
  const mark = '2026-06-01T00:00:00+03:00';
  assert.equal(feed(mark).payments.length, 0, 'nothing changed since the mark');
  // only a RECEIPT's stamp moves past the mark → its cycle is returned
  const rcAt = w.S.Payments.grid.findIndex((g) => g[paycols.indexOf('invoiceWanted')] === 'no');
  w.S.Payments.grid[rcAt][at] = '2026-07-01T09:00:00+03:00';
  assert.equal(feed(mark).payments.length, 1, 'a receipt newer than the mark re-surfaces its (older) cycle');
  w.S.Payments.grid[rcAt][at] = '2026-01-01T09:00:00+02:00';
  // and the real edit, end to end
  const rc = w.rows().find((r) => r.id !== CYCLE_ID && r.invoiceWanted === 'no');
  assert.equal(w.update(receiptPayload(rc, { invoiceWanted: 'yes', invoiceTo: 'קרן' })).ok, true);
  const inc = feed(mark);
  assert.equal(inc.ok, true, JSON.stringify(inc).slice(0, 300));
  assert.equal(inc.payments.length, 1, 'the cycle comes back after its receipt\'s invoice changed');
  assert.ok(inc.payments[0].invoices.some((i) => i.invoiceWanted === 'yes' && i.invoiceTo === 'קרן'));
  // a void receipt's invoice is not listed
  assert.ok(GS_SRC.includes("if (!cid || isVoidStatus_(rc.status)) return;"));
});

/* ============================ Ortal's card and the workbooks ============================ */

test('«בקרת גבייה» + «ייצוא אימות»: the queue carries the choice; the workbook has «חשבונית» / «על שם», «—» for legacy', () => {
  const g = loadGs();
  const r = (id, f) => Object.assign({ id, patientName: 'מטופל', houseId: 'ramot', amount: 1000, amountPaid: 1000, status: 'paid',
    receivedDate: '2026-09-20', confirmStatus: 'reported', recordedAt: '2026-09-20T10:00:00+03:00' }, f);
  const q = plain(g.sandbox.billingControlQueueFor_([r('rcpt-a', { invoiceWanted: 'yes', invoiceTo: '=evil' }), r('rcpt-b', {}), r('rcpt-c', { invoiceWanted: 'no', invoiceTo: 'x' })], {}, { todayIso: '2026-09-30' }));
  const by = Object.fromEntries(q.receipts.map((x) => [x.id, x]));
  assert.deepEqual([by['rcpt-a'].invoiceWanted, by['rcpt-a'].invoiceTo], ['yes', '=evil']);
  assert.deepEqual([by['rcpt-b'].invoiceWanted, by['rcpt-b'].invoiceTo], ['', '']);
  assert.deepEqual([by['rcpt-c'].invoiceWanted, by['rcpt-c'].invoiceTo], ['no', '']);
  const spec = bcx.buildBillingControlSpec(q, new Date('2026-09-30T07:00:00Z'));
  const sheet = spec.sheets.find((s) => s.name === 'ממתין לאימות');
  assert.ok(sheet.columns.some((c) => c.header === 'חשבונית') && sheet.columns.some((c) => c.header === 'על שם'));
  const rows = Object.fromEntries(sheet.rows.map((x, i) => [q.receipts.filter((y) => y.confirmStatus === 'reported')[i].id, x]));
  assert.deepEqual([rows['rcpt-a'].invoiceWanted, rows['rcpt-a'].invoiceTo], ['כן', '=evil'], 'the workbook helper formula-guards text cells');
  assert.deepEqual([rows['rcpt-b'].invoiceWanted, rows['rcpt-b'].invoiceTo], ['—', '—']);
  assert.deepEqual([rows['rcpt-c'].invoiceWanted, rows['rcpt-c'].invoiceTo], ['לא', '—']);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'xlsx-report.js'), 'utf8'), /formula-guarded/);
});

test('cleanup workbook: «קבלות ללא בחירת חשבונית» lists live receipts with no choice, shown «—»; last tab, owner ורד', () => {
  const w = world();
  assert.equal(w.report(VALID({ invoiceWanted: 'yes', invoiceTo: 'משפחה' })).ok, true);
  const paycols = arr(w.g.run('PAYMENT_COLUMNS'));
  const legacy = Object.assign({}, receiptOf(w), { id: 'rcpt-legacy', paymentUid: '', amountPaid: 1000, invoiceWanted: '', invoiceTo: '' });
  const voided = Object.assign({}, legacy, { id: 'rcpt-void', status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' });
  [legacy, voided].forEach((o) => w.S.Payments.appendRow(paycols.map((c) => (o[c] === undefined ? '' : o[c]))));
  const res = plain(w.g.sandbox.cleanupReportAction_());
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  assert.equal(res.sections.invoiceMissing.length, 1, 'the void receipt and the one with a choice are not listed');
  const row = res.sections.invoiceMissing[0];
  assert.deepEqual([row.kind, row.invoiceWanted, row.invoiceTo, row.amount], ['invoice_missing', '—', '—', 1000]);
  assert.equal(arr(w.g.run('CLEANUP_SECTION_KEYS')).slice(-1)[0], 'invoiceMissing');
  const t = cleanup.TABS.slice(-1)[0];
  assert.deepEqual([t.key, t.name], ['invoiceMissing', 'קבלות ללא בחירת חשבונית']);
  assert.equal(cleanup.KINDS.invoice_missing.owner, 'vered');
  const spec = cleanup.buildCleanupSpec(res, new Date());
  const sheet = spec.sheets.find((s) => s.name === t.name);
  assert.deepEqual([sheet.rows[0].invoiceWanted, sheet.rows[0].invoiceTo], ['—', '—']);
  const old = Object.assign({}, res, { sections: Object.assign({}, res.sections) });
  delete old.sections.invoiceMissing;
  assert.equal(cleanup.isCleanupResponse(old), true, 'a Code.gs from before still exports');
});

/* ============================ restricted ============================ */

test('restricted: Shiran / Yael can neither set nor see it — reportPayment / updatePayment / getPayments refused, nothing written', () => {
  for (const a of ['reportPayment', 'updatePayment', 'savePayment', 'getPayments']) assert.ok(scope.FINANCE_ACTIONS.includes(a), a);
  const w = world();
  assert.equal(w.report(VALID({ invoiceWanted: 'no' })).ok, true);
  const rc = receiptOf(w);
  const before = w.snapshot();
  for (const who of [SHIRAN, YAEL]) {
    assert.equal(w.report(VALID({ invoiceWanted: 'yes', invoiceTo: 'x' }), who).error, 'forbidden');
    assert.equal(w.update(receiptPayload(rc, { invoiceWanted: 'yes', invoiceTo: 'x' }), who).error, 'forbidden');
    const got = plain(w.g.post(Object.assign({ action: 'getPayments' }, who())));
    assert.equal(got.error, 'forbidden');
    assert.ok(!JSON.stringify(got).includes('invoice'));
  }
  assert.equal(w.snapshot(), before);
});

/* ============================ app.js ============================ */

function fakeEl() {
  return {
    _html: '', value: '', textContent: '', children: [], style: {}, dataset: {},
    classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, toggle() {}, contains(c) { return this._c.has(c); } },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {}, closest() { return null; },
  };
}
function loadApp(finance) {
  const els = {};
  const posts = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload() {} },
    document: { addEventListener() {}, body: fakeEl(), getElementById: (id) => (els[id] || (els[id] = fakeEl())), createElement: () => fakeEl(), querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {},
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map, Intl,
    fetch: (url, init) => { const b = init && init.body ? JSON.parse(init.body) : null; posts.push(b);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, payment: Object.assign({ id: 'rcpt-1', status: 'paid' }, b && b.payment) }) }); },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    showError = () => {}; showToast = () => {}; renderAll = () => {}; renderBilling = () => {};
    globalThis.__test = { get state() { return state; }, receiptInvoiceHtml, receiptsListHtml, invoiceDisplayOf, paymentReportIssues,
      paymentReportDefaults, normalizeReceipt, saveReceiptInvoice, invoiceFieldsHtml, openInvoiceEditModal, bcReceiptHtml };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = finance;
  app.state.mode = 'edit';
  return { app, els, posts };
}

test('client: the receipt line shows «חשבונית: כן · על שם …» / «לא» / «—» (legacy), escaped; the edit button is finance-only', () => {
  const { app } = loadApp(true);
  const rc = (f) => app.normalizeReceipt(Object.assign({ id: 'rcpt-1', cycleId: 'c1', amountPaid: 1000, status: 'paid', receivedDate: '2026-09-20' }, f));
  assert.match(app.receiptInvoiceHtml(rc({ invoiceWanted: 'yes', invoiceTo: '<img src=x onerror=alert(1)>' })),
    /חשבונית: כן · על שם &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(app.receiptInvoiceHtml(rc({ invoiceWanted: 'no', invoiceTo: 'x' })), /חשבונית: לא<\/span>/);
  assert.match(app.receiptInvoiceHtml(rc({})), /חשבונית: —<\/span>/);
  assert.ok(!/כן|לא/.test(app.receiptInvoiceHtml(rc({}))), 'legacy is never כן / לא');
  app.state.receipts = [rc({})];
  assert.match(app.receiptsListHtml('c1'), /receipt-invoice-btn/);
  const r = loadApp(false);
  r.app.state.receipts = [r.app.normalizeReceipt({ id: 'rcpt-1', cycleId: 'c1', status: 'paid' })];
  assert.ok(!/receipt-invoice-btn/.test(r.app.receiptsListHtml('c1')), 'restricted: no edit control');
  // Ortal's card
  const card = app.bcReceiptHtml({ id: 'rcpt-1', amount: 1000, invoiceWanted: 'yes', invoiceTo: 'א<ב' }, 'confirmed', {});
  assert.match(card, /חשבונית<\/span> <span class="bc-v">כן/);
  assert.match(card, /א&lt;ב/);
});

test('client: the form opens with NO choice and cannot be sent until one is made; כן needs «על שם»', () => {
  const { app } = loadApp(true);
  const d = app.paymentReportDefaults({ name: 'מטופל', houseId: 'arfoni', pay: 30000, id: 'p1' }, { id: 'c1', amount: 30000, dueDate: '2026-09-07' }, '2026-09-07', '2026-09-20');
  assert.deepEqual([d.report.invoiceWanted, d.report.invoiceTo], ['', '']);
  const base = { receivedDate: '2026-09-20', amount: '1000', method: 'מזומן', payer: 'משפחת כהן', reference: '', funder: 'פרטי', coverageStart: '2026-09-07', coverageEnd: '2026-10-06' };
  const codes = (v) => plain(app.paymentReportIssues(v, '2026-09-30', false)).map((i) => i.code);
  assert.deepEqual(codes(base), ['invoice_choice_missing']);
  assert.deepEqual(codes(Object.assign({}, base, { invoiceWanted: 'yes', invoiceTo: '' })), ['invoice_to_missing']);
  assert.deepEqual(codes(Object.assign({}, base, { invoiceWanted: 'yes', invoiceTo: 'משפחת כהן' })), []);
  assert.deepEqual(codes(Object.assign({}, base, { invoiceWanted: 'no' })), []);
  const html = app.invoiceFieldsHtml('pr', '', '');
  assert.ok(!/checked/.test(html), 'no radio is pre-checked');
  assert.match(html, /value="yes"[^>]*\/> כן/); assert.match(html, /value="no"[^>]*\/> לא/);
  assert.match(html, /pr-invoice-to hidden/, '«על שם» hidden until כן');
  assert.match(html, /maxlength="120"/);
});

test('client: saveReceiptInvoice posts updatePayment with the stored receipt + the choice and adopts the echo; SW bumped', async () => {
  const { app, posts } = loadApp(true);
  app.state.receipts = [app.normalizeReceipt({ id: 'rcpt-1', cycleId: 'c1', patientId: 'k', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', status: 'paid', amountPaid: 1000 })];
  await app.saveReceiptInvoice(app.state.receipts[0], { invoiceWanted: 'yes', invoiceTo: 'משפחה' });
  const body = posts.find((p) => p && p.action === 'updatePayment');
  assert.ok(body);
  assert.deepEqual([body.payment.id, body.payment.invoiceWanted, body.payment.invoiceTo, body.payment.status], ['rcpt-1', 'yes', 'משפחה', 'paid']);
  assert.ok(!('amountPaid' in body.payment), 'no money in the payload');
  assert.deepEqual([app.state.receipts[0].invoiceWanted, app.state.receipts[0].invoiceTo, app.state.receipts[0].cycleId], ['yes', 'משפחה', 'c1']);
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 36);
  assert.match(SW_SRC, /v35 → v36: invoice on the payment report/);
});
