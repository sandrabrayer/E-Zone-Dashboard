/* The strict payment report — Phase 3 PR 1, FOUNDATION (no user-facing change).
 * See CHANGELOG-payment-report-foundation.md, docs/billing-control-plan.md
 * Phase 3 and §14.1.
 *
 * Locked here (Sandra's decisions, 2026-10-04):
 *   - eleven columns APPENDED to PAYMENT_COLUMNS, nothing moved, all text-forced
 *   - validatePaymentReport_ (Code.gs, the authority) and
 *     lib/payment-report-rules.js give the same answer, rule by rule
 *   - receivedDate is append-only: set once, never re-stamped, a blank never
 *     erases it, a change writes an AuditLog row (old, new, actor)
 *   - recordedBy / recordedAt / confirmedBy / confirmedAt are server-stamped
 *   - confirmStatus / flagNote: controller or approver only (forbidden_role)
 *   - Funders: currentFunder_ with history, the פרטי default, append-only
 *   - debtAging_ and the Ortal digest prefer receivedDate, legacy rows as before
 *   - a savePayment without the new fields behaves exactly as before
 *
 * vm sandbox on the real Code.gs (test/helpers/gs-sandbox.js). All names are
 * SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');
const rules = require('../lib/payment-report-rules');
const cleanup = require('../lib/cleanup-xlsx');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-PAYMENT-REPORT-0123456789abcdef0123456789';
const ROLE_FORBIDDEN = { ok: false, error: 'forbidden_role', message: 'אין הרשאה לפעולה זו' };

const ORIGINAL_24 = [
  'id', 'patientId', 'patientName', 'houseId', 'dueDate',
  'amount', 'status', 'amountPaid', 'balance', 'timestamp',
  'coverageStart', 'coverageEnd',
  'paymentUid', 'patientUid', 'payerUid',
  'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  'linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt',
];
const REPORT_COLUMNS = [
  'receivedDate', 'method', 'payer', 'funder', 'reference',
  'recordedBy', 'recordedAt',
  'confirmStatus', 'confirmedBy', 'confirmedAt', 'flagNote',
];

/* Today and tomorrow in Asia/Jerusalem, for the "not in the future" rule. */
const TODAY = rules.jerusalemToday();
const TOMORROW = (() => {
  const p = TODAY.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10);
})();

/* ---------- actors (the shape proxyGate_ verifies) ---------- */
const gsActor = (id, user, roles) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer']);
/* Ortal has no login until Phase 4 (and no finance capability yet), so the
 * controller path is exercised on a finance user who holds `controller`. */
const CONTROLLER = () => gsActor('vered', 'ורד', ['staff', 'controller']);

/* A Code.gs with one patient (id p1) and, optionally, Funders rows. */
function world(opts) {
  const o = opts || {};
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01', pay: 30000, status: 'active' }[c] || '')));
  if (o.funders) {
    const fcols = arr(g.run('FUNDER_COLUMNS'));
    S.Funders = richSheet('Funders', fcols);
    o.funders.forEach((f) => S.Funders.appendRow(fcols.map((c) => (f[c] === undefined ? '' : f[c]))));
  }
  const base = { id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 0, balance: 30000, status: 'unpaid' };
  const row = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS')[0];
  /* Phase 4 item H (CHANGELOG-billing-control-tab.md): the HTTP save path no
   * longer writes MONEY (amountPaid / status) — money arrives only through
   * «דווח תשלום». These PR 1 tests are about the report COLUMNS on that path,
   * so when a payload moves the money, the money is put in place first the
   * way legacy data already sits on the sheet (a direct, editor-side
   * upsertPayment_), and the HTTP save then carries the same figures. The
   * refusal itself is tested in test/billing-control-tab.test.js. */
  const moneyFirst = (payment, who) => {
    const p = payment || {};
    if (g.sandbox.isVoidStatus_(p.status)) return;
    const cur = row();
    const paidNow = cur ? Number(cur.amountPaid) || 0 : 0;
    const statusNow = g.sandbox.paymentStatus_(cur ? cur.status : 'unpaid');
    const moves = (p.amountPaid !== undefined && Number(p.amountPaid) !== paidNow) ||
      (p.status !== undefined && g.sandbox.paymentStatus_(p.status) !== statusNow);
    if (!moves) return;
    const m = {};
    Object.keys(p).forEach((k) => { if (REPORT_COLUMNS.indexOf(k) < 0) m[k] = p[k]; });
    g.sandbox.upsertPayment_(JSON.parse(JSON.stringify(m)), (who || VERED)().user);
  };
  const save = (payment, who) => {
    moneyFirst(payment, who);
    return plain(g.post(Object.assign({ action: 'savePayment', payment }, (who || VERED)())));
  };
  const audits = (action) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !action || r.action === action);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, base, save, row, audits, snapshot };
}

/* The patient's funder on file. There is NO default funder any more
 * (CHANGELOG-patient-funder-on-funders.md): a first report that names none
 * takes the patient's Funders row, and is refused (funder_unset) without one. */
const FUNDED = { funders: [{ patientId: 'p1', funder: 'מכבי', effectiveFrom: '2026-01-01' }] };

/* A full, valid report on top of the base row. */
const REPORT = {
  receivedDate: '20/09/2026', method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-2026/0042',
  coverageStart: '2026-09-07', coverageEnd: '2026-10-06', status: 'paid', amountPaid: 30000, balance: 0,
};

/* ================== 1. the column contract ================== */

test('columns: the eleven report columns are APPENDED; the original 24 do not move', () => {
  const { g } = world();
  const cols = arr(g.run('PAYMENT_COLUMNS'));
  assert.deepEqual(cols.slice(0, 24), ORIGINAL_24, 'position IS the data contract');
  assert.deepEqual(cols.slice(24, 35), REPORT_COLUMNS);
  // PR 2 (CHANGELOG-payment-report-form.md) appended one more after them.
  assert.deepEqual(cols.slice(35, 36), ['legacyAmountPaid']);
  // …and the invoice choice after it (CHANGELOG-payment-invoice.md).
  assert.deepEqual(cols.slice(36), ['invoiceWanted', 'invoiceTo']);
  assert.deepEqual(arr(g.run('PAYMENT_REPORT_COLUMNS')), REPORT_COLUMNS);
  for (const c of REPORT_COLUMNS) {
    assert.equal(cols.filter((x) => x === c).length, 1, c + ' appears once');
    assert.ok(arr(g.run('PAYMENT_TEXT_COLUMNS')).includes(c), c + ' is text-forced (Sheets would coerce a date / a cheque number)');
  }
  assert.deepEqual(arr(g.run('FUNDER_COLUMNS')), ['patientId', 'funder', 'effectiveFrom', 'setBy', 'setAt']);
});

test('columns: an existing 24-column Payments sheet is extended in place — no existing cell rewritten', () => {
  const { g, S } = world();
  S.Payments = richSheet('Payments', ORIGINAL_24);
  const legacy = ORIGINAL_24.map((c) => ({ id: 'old1', patientName: 'ותיק', status: 'paid', amountPaid: 100 }[c] || ''));
  S.Payments.appendRow(legacy);
  g.run('getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS)');
  assert.deepEqual(S.Payments.grid[0], ORIGINAL_24.concat(REPORT_COLUMNS, ['legacyAmountPaid', 'invoiceWanted', 'invoiceTo']));
  assert.deepEqual(S.Payments.grid[1].slice(0, 24), legacy, 'the legacy row is untouched');
});

test('columns: a hand-added column sitting where a report column belongs is detected and left alone', () => {
  const { g, S, base, save, row } = world();
  const header = ORIGINAL_24.concat(['אמצעי תשלום']);   // position 25 = receivedDate's place
  S.Payments = richSheet('Payments', header);
  const clash = plain(g.sandbox.paymentReportHeaderClash_(header));
  assert.deepEqual(clash, [{ column: 25, expected: 'receivedDate', found: 'אמצעי תשלום' }]);
  assert.deepEqual(plain(g.sandbox.paymentReportHeaderClash_(ORIGINAL_24)), []);
  assert.deepEqual(plain(g.sandbox.paymentReportHeaderClash_(ORIGINAL_24.concat(REPORT_COLUMNS))), []);
  // The save still works, and the hand-typed value is carried as it was — never validated as a date.
  S.Payments.appendRow(ORIGINAL_24.map((c) => base[c] === undefined ? '' : base[c]).concat(['מזומן']));
  const r = save(Object.assign({}, base, { status: 'paid', amountPaid: 30000, receivedDate: 'מזומן' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().receivedDate, 'מזומן');
  assert.equal(row().recordedBy, '', 'nothing stamped under a clashing header');
});

/* ================== 2. the rules, both sides ================== */

/* Each case: the report, the expected codes (field:code), in field order. */
const FULL = {
  receivedDate: '2026-09-20', amount: 30000, method: 'העברה בנקאית', payer: 'משפחת כהן',
  coverageStart: '2026-09-07', coverageEnd: '2026-10-06', funder: 'פרטי', reference: '123456',
};
const CASES = [
  ['valid, ISO date', {}, []],
  ['valid, DD/MM/YYYY', { receivedDate: '20/09/2026' }, []],
  ['valid, received today', { receivedDate: TODAY }, []],
  ['missing receivedDate', { receivedDate: '' }, ['receivedDate:received_date_missing']],
  ['bad date 2026-02-30', { receivedDate: '2026-02-30' }, ['receivedDate:received_date_invalid']],
  ['bad date 30/02/2026', { receivedDate: '30/02/2026' }, ['receivedDate:received_date_invalid']],
  ['bad date text', { receivedDate: 'אתמול' }, ['receivedDate:received_date_invalid']],
  ['bad date loose ISO', { receivedDate: '2026-9-1' }, ['receivedDate:received_date_invalid']],
  ['future receivedDate (tomorrow)', { receivedDate: TOMORROW }, ['receivedDate:received_date_future']],
  ['missing amount', { amount: '' }, ['amount:amount_missing']],
  ['amount 0', { amount: 0 }, ['amount:amount_not_positive']],
  ['amount -5', { amount: -5 }, ['amount:amount_not_positive']],
  ['amount "-5"', { amount: '-5' }, ['amount:amount_not_positive']],
  ['amount abc', { amount: 'abc' }, ['amount:amount_invalid']],
  ['amount 1.234', { amount: 1.234 }, ['amount:amount_invalid']],
  ['amount "1,5"', { amount: '1,5' }, ['amount:amount_invalid']],
  ['amount "29999.50"', { amount: '29999.50' }, []],
  ['missing method', { method: '' }, ['method:method_missing']],
  ['bad method paypal', { method: 'paypal' }, ['method:method_invalid']],
  ['method with geresh צ׳ק', { method: 'צ׳ק', reference: '000123' }, []],
  ['missing payer', { payer: '   ' }, ['payer:payer_missing']],
  ['payer one character', { payer: 'א' }, ['payer:payer_invalid']],
  ['payer formula lead-in', { payer: '=HYPERLINK("x")' }, ['payer:payer_invalid']],
  ['payer too long', { payer: 'א'.repeat(101) }, ['payer:payer_invalid']],
  ['missing coverageStart', { coverageStart: '' }, ['coverageStart:coverage_start_missing']],
  ['missing coverageEnd', { coverageEnd: '' }, ['coverageEnd:coverage_end_missing']],
  ['bad coverage date', { coverageEnd: '2026-13-01' }, ['coverageEnd:coverage_invalid']],
  ['coverage reversed', { coverageStart: '2026-10-06', coverageEnd: '2026-09-07' }, ['coverageEnd:coverage_reversed']],
  ['coverage too long', { coverageStart: '2026-01-01', coverageEnd: '2027-01-02' }, ['coverageEnd:coverage_too_long']],
  ['missing funder', { funder: '' }, ['funder:funder_missing']],
  ['bad funder', { funder: 'כללית' }, ['funder:funder_invalid']],
  ['every funder is accepted', { funder: 'מכבי' }, []],
  ['reference required for העברה בנקאית', { reference: '' }, ['reference:reference_missing']],
  ["reference required for צ'ק", { method: "צ'ק", reference: '' }, ['reference:reference_missing']],
  ['reference optional for מזומן', { method: 'מזומן', reference: '' }, []],
  ['reference optional for אשראי / ביט / אחר', { method: 'ביט', reference: '' }, []],
  ['reference <script>', { reference: '<script>' }, ['reference:reference_invalid']],
  ['reference too short', { reference: '12' }, ['reference:reference_invalid']],
  ['reference leading dash', { reference: '-12345' }, ['reference:reference_invalid']],
  ['reference TRX-2026/0042', { reference: 'TRX-2026/0042' }, []],
  ['everything missing', null, [
    'receivedDate:received_date_missing', 'amount:amount_missing', 'method:method_missing', 'payer:payer_missing',
    'coverageStart:coverage_start_missing', 'coverageEnd:coverage_end_missing', 'funder:funder_missing',
  ]],
];

test('rules: every case gives the expected field + code — in Code.gs AND lib, identically (parity)', () => {
  const { g } = world();
  for (const [name, patch, want] of CASES) {
    const report = patch === null ? {} : Object.assign({}, FULL, patch);
    const ctx = { todayIso: TODAY };
    const server = plain(g.sandbox.validatePaymentReport_(report, ctx));
    const client = rules.validatePaymentReport(report, ctx);
    assert.deepEqual(server.map((i) => i.field + ':' + i.code), want, 'Code.gs: ' + name);
    assert.deepEqual(client, server, 'lib mirrors Code.gs: ' + name);
    for (const i of server) assert.ok(i.hebrewMessage && /[֐-׿]/.test(i.hebrewMessage), 'Hebrew message: ' + i.code);
  }
});

test('rules: the shared lists are the same on both sides, and exactly Sandra\'s', () => {
  const { g } = world();
  assert.deepEqual(arr(g.run('PAYMENT_METHODS')), ['העברה בנקאית', 'אשראי', "צ'ק", 'מזומן', 'ביט', 'אחר']);
  assert.deepEqual(arr(g.run('PAYMENT_FUNDERS')), ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי']);
  assert.deepEqual(arr(g.run('PAYMENT_METHODS')), arr(rules.PAYMENT_METHODS));
  assert.deepEqual(arr(g.run('PAYMENT_FUNDERS')), arr(rules.PAYMENT_FUNDERS));
  assert.deepEqual(arr(g.run('REFERENCE_REQUIRED_METHODS')), arr(rules.REFERENCE_REQUIRED_METHODS));
  assert.deepEqual(arr(g.run('CONFIRM_STATUSES')), arr(rules.CONFIRM_STATUSES));
  assert.deepEqual(arr(g.run('PAYMENT_REPORT_FIELDS')), arr(rules.REPORT_FIELDS));
  assert.equal(g.run('FUNDER_UNSET'), rules.FUNDER_UNSET, 'no default funder on either side');
  assert.equal(rules.FUNDER_UNSET, 'unset');
  assert.equal(rules.DEFAULT_FUNDER, undefined);
  assert.deepEqual(plain(g.run('PAYMENT_REPORT_MESSAGES')), plain(rules.MESSAGES), 'the same Hebrew, word for word');
});

test('rules: a Payments row is read as a report with amountPaid as the amount; DD/MM display', () => {
  const r = rules.reportFromPaymentRow({ amount: 30000, amountPaid: 12000, receivedDate: '2026-09-20' });
  assert.equal(r.amount, 12000);
  assert.equal(rules.formatReportDate('2026-09-20'), '20/09/2026');
  assert.equal(rules.parseReportDate('5/9/2026'), '2026-09-05');
  const { g } = world();
  assert.deepEqual(plain(g.sandbox.paymentReportFromRow_({ amountPaid: 12000, method: 'ביט' })), plain(rules.reportFromPaymentRow({ amountPaid: 12000, method: 'ביט' })));
});

/* ================== 3. the save path ================== */

test('save: a payload WITHOUT the new fields behaves exactly as before — blank report columns, same response', () => {
  const { base, save, row, audits } = world();
  const r1 = save(base);
  assert.deepEqual(Object.keys(r1).sort(), ['created', 'ok', 'payment']);
  const r2 = save(Object.assign({}, base, { status: 'paid', amountPaid: 30000, balance: 0 }));
  assert.deepEqual(Object.keys(r2).sort(), ['ok', 'payment', 'updated'], 'no reportIssues on a legacy row');
  for (const c of REPORT_COLUMNS) assert.equal(row()[c], '', c + ' stays blank');
  assert.equal(row().status, 'paid');
  assert.equal(row().chargedBy, 'ורד', 'the existing charge stamp still works');
  assert.equal(audits().length, 0, 'no new audit rows for an ordinary save');
});

test('save: an incomplete report is NOT refused yet (foundation) — the gaps come back as reportIssues', () => {
  const { base, save, row } = world(FUNDED);
  const r = save(Object.assign({}, base, { status: 'paid', amountPaid: 30000, receivedDate: '2026-09-20' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().receivedDate, '2026-09-20');
  assert.deepEqual(r.reportIssues.map((i) => i.code).sort(), ['coverage_end_missing', 'coverage_start_missing', 'method_missing', 'payer_missing'].sort());
});

test('save: a first report naming no funder, for a patient with NO Funders row, is refused (funder_unset) — never written as פרטי', () => {
  const { base, save, row, snapshot } = world();
  save(base);
  /* Phase 4 item H: the money is put in place first (as legacy data sits on
   * the sheet — see moneyFirst), so the snapshot below isolates the report. */
  save(Object.assign({}, base, { status: REPORT.status, amountPaid: REPORT.amountPaid, balance: REPORT.balance }));
  const before = snapshot();
  const r = save(Object.assign({}, base, REPORT));
  assert.deepEqual([r.ok, r.error], [false, 'funder_unset']);
  assert.equal(r.message, 'לא הוגדר גורם מממן למטופל — יש לבחור גורם מממן בדיווח או להגדיר אותו בכרטיס המטופל');
  assert.equal(snapshot(), before, 'nothing written');
  assert.equal(row().funder, '');
  // naming the funder in the report itself is enough
  const ok = save(Object.assign({}, base, REPORT, { funder: 'ביטוח לאומי' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(row().funder, 'ביטוח לאומי');
});

test('receivedDate: first report stores ISO, stamps recordedBy/At from the session, sets reported, fills the funder', () => {
  const { base, save, row, audits } = world({ funders: [{ patientId: 'p1', funder: 'ביטוח לאומי', effectiveFrom: '2026-09-01' }] });
  save(base);
  const r = save(Object.assign({}, base, REPORT, { recordedBy: 'מתחזה', recordedAt: '2020-01-01', confirmedBy: 'מתחזה' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const x = row();
  assert.equal(x.receivedDate, '2026-09-20', 'DD/MM/YYYY in, ISO stored');
  assert.equal(x.recordedBy, 'ורד', 'from the signed session, not the payload');
  assert.notEqual(x.recordedAt, '2020-01-01');
  assert.ok(x.recordedAt, 'server-stamped');
  assert.equal(x.confirmStatus, 'reported', 'a new report is always reported');
  assert.equal(x.confirmedBy, '', 'server-owned — the payload\'s value is dropped');
  assert.equal(x.funder, 'ביטוח לאומי', 'the patient\'s current funder (Funders)');
  assert.equal(x.method, 'העברה בנקאית');
  assert.equal(x.payer, 'משפחת כהן');
  assert.equal(x.reference, 'TRX-2026/0042');
  assert.deepEqual(r.reportIssues, [], 'a complete report');
  assert.equal(audits('payment_received_date_changed').length, 0, 'setting it the first time is not a change');
});

test('receivedDate: APPEND-ONLY — omitted or blank never erases it, re-saves never re-stamp it', () => {
  const { base, save, row } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const first = row();
  // the current client: omits the field entirely
  const omit = Object.assign({}, base, { status: 'paid', amountPaid: 30000, balance: 0 });
  assert.equal(save(omit).ok, true);
  // a client that sends it blank
  assert.equal(save(Object.assign({}, omit, { receivedDate: '', recordedAt: '' })).ok, true);
  // an amount correction (re-stamps chargedAt — never receivedDate)
  assert.equal(save(Object.assign({}, omit, { amountPaid: 29000 })).ok, true);
  const after = row();
  assert.equal(after.receivedDate, first.receivedDate);
  assert.equal(after.recordedAt, first.recordedAt);
  assert.equal(after.recordedBy, first.recordedBy);
});

test('receivedDate: a change is allowed and writes ONE AuditLog row with old, new and the actor', () => {
  const { base, save, row, audits } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const before = row();
  const r = save(Object.assign({}, base, REPORT, { receivedDate: '2026-09-18' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().receivedDate, '2026-09-18');
  assert.equal(row().recordedAt, before.recordedAt, 'recordedAt is the first report, not the edit');
  const a = audits('payment_received_date_changed');
  assert.equal(a.length, 1);
  const d = JSON.parse(a[0].details);
  assert.deepEqual([d.old, d.new, d.paymentId], ['2026-09-20', '2026-09-18', 'pay1']);
  assert.equal(a[0].actor, 'ורד', 'the verified actor');
  // the same date in the other notation is not a change
  assert.equal(save(Object.assign({}, base, REPORT, { receivedDate: '18/09/2026' })).ok, true);
  assert.equal(audits('payment_received_date_changed').length, 1);
});

test('receivedDate / method / funder / payer / reference: a bad NEW value is refused and nothing is written', () => {
  const { base, save, snapshot } = world();
  save(Object.assign({}, base, REPORT));
  const before = snapshot();
  const bad = [
    [{ receivedDate: TOMORROW }, 'received_date_future'],
    [{ receivedDate: '2026-02-30' }, 'received_date_invalid'],
    [{ method: 'paypal' }, 'method_invalid'],
    [{ funder: 'כללית' }, 'funder_invalid'],
    [{ payer: '=cmd' }, 'payer_invalid'],
    [{ reference: '<script>' }, 'reference_invalid'],
  ];
  for (const [patch, code] of bad) {
    const r = save(Object.assign({}, base, REPORT, patch));
    assert.equal(r.ok, false, code);
    assert.equal(r.error, 'validation');
    assert.deepEqual(r.fields.map((i) => i.code), [code]);
    assert.ok(/[֐-׿]/.test(r.message), 'a Hebrew message the existing client shows');
  }
  assert.equal(snapshot(), before, 'not one cell moved');
});

test('round-trip: a value already stored is carried, not re-validated (a hand-typed cell never blocks a save)', () => {
  const { base, save, S, row } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const cols = arr(S.Payments.grid[0]);
  S.Payments.grid[1][cols.indexOf('method')] = 'paypal';   // typed by hand into the sheet
  const r = save(Object.assign({}, row(), { amountPaid: 29000 }));   // the client sends back what it read
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().method, 'paypal');
  assert.ok(r.reportIssues.some((i) => i.code === 'method_invalid'), 'still reported, never silently accepted');
});

/* ================== 4. the confirmation: controller / approver only ================== */

test('confirm: staff (Vered) may not set confirmStatus or flagNote → forbidden_role, logged, nothing written', () => {
  const { g, base, save, snapshot } = world();
  save(Object.assign({}, base, REPORT));
  const before = snapshot();
  for (const patch of [{ confirmStatus: 'confirmed' }, { confirmStatus: 'flagged', flagNote: 'לא בבנק' }, { flagNote: 'הערה' }]) {
    assert.deepEqual(save(Object.assign({}, base, REPORT, patch)), ROLE_FORBIDDEN, JSON.stringify(patch));
  }
  assert.equal(snapshot(), before);
  assert.ok(g.logs.includes('[role] forbidden_role user=vered op=confirmPayment'), g.logs.join('\n'));
  assert.ok(!g.logs.join('\n').includes('מטופל'), 'no names in the log');
});

test('confirm: Sandra (approver) confirms and flags; confirmedBy/At stamped; each decision audited', () => {
  const { base, save, row, audits } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const r = save(Object.assign({}, row(), { confirmStatus: 'confirmed', confirmedBy: 'מתחזה' }), SANDRA);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().confirmStatus, 'confirmed');
  assert.equal(row().confirmedBy, 'סנדרה');
  assert.ok(row().confirmedAt);
  // flagged needs a note
  const noNote = save(Object.assign({}, row(), { confirmStatus: 'flagged' }), SANDRA);
  assert.equal(noNote.error, 'validation');
  assert.deepEqual(noNote.fields.map((i) => i.code), ['flag_note_missing']);
  assert.equal(save(Object.assign({}, row(), { confirmStatus: 'flagged', flagNote: 'הסכום לא תואם לבנק' }), SANDRA).ok, true);
  assert.equal(row().flagNote, 'הסכום לא תואם לבנק');
  assert.deepEqual(audits().filter((a) => /^payment_confirm_/.test(a.action)).map((a) => a.action),
    ['payment_confirm_confirmed', 'payment_confirm_flagged']);
  // unknown status
  assert.deepEqual(save(Object.assign({}, row(), { confirmStatus: 'ok' }), SANDRA).fields.map((i) => i.code), ['confirm_status_invalid']);
});

test('confirm: the controller role (Ortal, Phase 4) may confirm', () => {
  const { base, save, row } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const r = save(Object.assign({}, row(), { confirmStatus: 'confirmed' }), CONTROLLER);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().confirmStatus, 'confirmed');
});

test('confirm: echoing \'reported\' on a first report is not a decision — staff may send it', () => {
  const { base, save, row } = world(FUNDED);
  const r = save(Object.assign({}, base, REPORT, { confirmStatus: 'reported' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(row().confirmStatus, 'reported');
  assert.equal(row().confirmedBy, '', 'no decision stamped');
});

test('confirm: a row with no report cannot be confirmed', () => {
  const { base, save } = world();
  save(base);
  assert.deepEqual(save(Object.assign({}, base, { confirmStatus: 'confirmed' }), SANDRA).fields.map((i) => i.code), ['confirm_without_report']);
});

test('confirm: Vered re-saving a row Ortal/Sandra already decided does NOT undo it (stale copy, blank or same value)', () => {
  const { base, save, row } = world(FUNDED);
  save(Object.assign({}, base, REPORT));
  const stale = row();   // Vered's copy: confirmStatus 'reported'
  save(Object.assign({}, row(), { confirmStatus: 'confirmed' }), SANDRA);
  // the same value she holds now → fine; a blank → fine; neither changes the decision
  assert.equal(save(Object.assign({}, row(), { amountPaid: 30000 })).ok, true);
  assert.equal(save(Object.assign({}, stale, { confirmStatus: '' })).ok, true);
  assert.equal(row().confirmStatus, 'confirmed');
  assert.equal(row().confirmedBy, 'סנדרה');
  // her stale non-blank value is an attempt to change it → refused
  assert.deepEqual(save(stale), ROLE_FORBIDDEN);
});

/* ================== 5. Funders ================== */

test('currentFunder_: the latest effectiveFrom ≤ the date wins; history, future rows, ties, bad rows, default', () => {
  const rows = [
    { patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-01-01', setAt: '2026-01-01T09:00:00+02:00' },
    { patientId: 'p1', funder: 'ביטוח לאומי', effectiveFrom: '2026-08-01', setAt: '2026-08-01T09:00:00+03:00' },
    { patientId: 'p1', funder: 'משרד הביטחון', effectiveFrom: '2026-08-01', setAt: '2026-08-02T09:00:00+03:00' },   // same day, set later
    { patientId: 'p1', funder: 'מכבי', effectiveFrom: '2026-12-01', setAt: '2026-09-01T09:00:00+03:00' },   // future
    { patientId: 'p1', funder: 'כללית', effectiveFrom: '2026-10-01' },   // not on the list → «לא הוגדר» from its day
    { patientId: 'p1', funder: 'פרטי', effectiveFrom: 'לא תאריך' },      // unreadable → skipped
    { patientId: 'p2', funder: 'מכבי', effectiveFrom: '2026-01-01' },
  ];
  const { g } = world();
  const at = (id, d) => plain(g.sandbox.currentFunderFrom_(rows, id, d));
  assert.equal(at('p1', '2026-07-31').funder, 'פרטי');
  assert.deepEqual(at('p1', '2026-09-15'), { funder: 'משרד הביטחון', effectiveFrom: '2026-08-01', unset: false });
  assert.deepEqual(at('p1', '2026-10-15'), { funder: 'unset', effectiveFrom: '', unset: true },
    'an unrecognized label on the effective row → «לא הוגדר», never read past to an older row');
  assert.equal(at('p1', '2026-12-01').funder, 'מכבי', 'a later recognized row applies from its day (a future row does not apply before it)');
  assert.equal(at('p1', '2026-11-30').funder, 'unset');
  assert.equal(at('p2', '2026-09-15').funder, 'מכבי');
  assert.deepEqual(at('p9', '2026-09-15'), { funder: 'unset', effectiveFrom: '', unset: true }, 'no row → unset, never פרטי');
  assert.deepEqual(at('', '2026-09-15').unset, true);
  assert.equal(at('p1', '2025-12-31').unset, true, 'before the first row → unset');
});

test('currentFunder_: reads the tab without creating it; no tab → unset (no default)', () => {
  const { g, S } = world();
  assert.equal(g.sandbox.currentFunder_('p1', '2026-09-15'), 'unset');
  assert.ok(!S.Funders, 'a read never creates the tab');
  const w = world({ funders: [{ patientId: 'p1', funder: 'מכבי', effectiveFrom: '2026-09-01' }] });
  assert.equal(w.g.sandbox.currentFunder_('p1', '2026-09-15'), 'מכבי');
  assert.equal(w.g.sandbox.currentFunder_('p1', '2026-08-31'), 'unset', 'before its first row');
});

test('appendFunder_: appends one row (never edits), stamps setBy/At, audits; bad input refused', () => {
  const { g, S } = world();
  const ok = plain(g.sandbox.appendFunder_('p1', 'ביטוח לאומי', '01/09/2026', { user: 'סנדרה' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  plain(g.sandbox.appendFunder_('p1', 'מכבי', '2026-10-01', { user: 'סנדרה' }));
  const rows = g.sheetRows('Funders', 'FUNDER_COLUMNS');
  assert.equal(rows.length, 2, 'append-only: the change is a second row');
  assert.deepEqual([rows[0].funder, rows[0].effectiveFrom, rows[0].setBy], ['ביטוח לאומי', '2026-09-01', 'סנדרה']);
  assert.ok(rows[0].setAt);
  assert.deepEqual(S.Funders.grid[0], ['patientId', 'funder', 'effectiveFrom', 'setBy', 'setAt']);
  assert.equal(g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((a) => a.action === 'funder_set').length, 2);
  assert.equal(g.sandbox.appendFunder_('p1', 'כללית', '2026-10-01', {}).error, 'funder_invalid');
  assert.equal(g.sandbox.appendFunder_('p1', 'מכבי', '2026-02-30', {}).error, 'effective_from_invalid');
  assert.equal(g.sandbox.appendFunder_('', 'מכבי', '2026-10-01', {}).error, 'patient_id_invalid');
  assert.equal(g.sheetRows('Funders', 'FUNDER_COLUMNS').length, 2);
  // not reachable over HTTP in this PR
  const handle = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(!/appendFunder_|currentFunder_/.test(handle), 'handle_ dispatches neither');
});

/* ================== 6. debtAging_ prefers receivedDate ================== */

/* Partial then top-up. Entry 05/07/2026, ₪30,000 a month. The August cycle
 * (05/08) was paid ₪10,000 on 10/08 and topped up to ₪30,000 later; the top-up
 * was recorded on 10/09, which re-stamped chargedAt to 10/09. As of 31/08 at
 * least ₪10,000 was in hand. */
const P_ENTRY = { id: 'pt-1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-05', pay: 30000, status: 'active' };
const KEY = 'ramot::אבי כהן::2026-07-05';
const julyRow = { id: 'j', patientId: KEY, patientName: 'אבי כהן', houseId: 'ramot', dueDate: '2026-07-05', amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-06T10:00:00+03:00' };
const augRow = (extra) => Object.assign({ id: 'a', patientId: KEY, patientName: 'אבי כהן', houseId: 'ramot', dueDate: '2026-08-05', amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-10T10:00:00+03:00' }, extra);
const tabs = (payments) => {
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  return { patients: rows([P_ENTRY]), payments: rows(payments), credits: rows([]), overrides: rows([]) };
};
const augCycle = (rep) => {
  const p = rep.byPatient.find((x) => x.name === 'אבי כהן');
  return p && p.cycles.find((c) => c.start === '2026-08-05');
};

test('debtAging_: partial then top-up — as of 31/08 the legacy chargedAt overstated the debt; receivedDate does not', () => {
  const { g } = world();
  const legacy = plain(g.sandbox.debtAging_('2026-08-31', tabs([julyRow, augRow()])));
  const c0 = augCycle(legacy);
  assert.deepEqual([c0.received, c0.balance, c0.receivedDateSource], [0, 30000, 'chargedAt'], 'legacy: the whole ₪30,000 shown as owed at 31/08');
  const now = plain(g.sandbox.debtAging_('2026-08-31', tabs([julyRow, augRow({ receivedDate: '2026-08-10' })])));
  assert.equal(augCycle(now), undefined, 'received 10/08 → settled at 31/08, no longer listed as owed');
  assert.equal(now.totals.recorded_debt.total, 0);
  assert.ok(now.totals.recorded_debt.total < legacy.totals.recorded_debt.total, 'no longer overstates');
  // before the money arrived it is still owed
  const early = plain(g.sandbox.debtAging_('2026-08-09', tabs([julyRow, augRow({ receivedDate: '2026-08-10' })])));
  assert.deepEqual([augCycle(early).received, augCycle(early).balance, augCycle(early).receivedDateSource], [0, 30000, 'receivedDate']);
});

test('debtAging_: legacy rows (no receivedDate) are unaffected — identical with the key absent or blank', () => {
  const { g } = world();
  for (const asOf of ['2026-08-31', '2026-09-30']) {
    const absent = plain(g.sandbox.debtAging_(asOf, tabs([julyRow, augRow()])));
    const blank = plain(g.sandbox.debtAging_(asOf, tabs([Object.assign({}, julyRow, { receivedDate: '' }), augRow({ receivedDate: '' })])));
    assert.deepEqual(blank, absent, asOf);
  }
  // a historical row with neither date is still "received date unknown"
  const unknown = plain(g.sandbox.debtAging_('2026-09-30', tabs([julyRow, augRow({ chargedAt: '' })])));
  assert.equal(unknown.receivedDateUnknown.count, 1);
});

/* ================== 7. the Ortal digest shows receivedDate ================== */

test('digest: «תאריך תשלום» is receivedDate when present, the due date for a legacy row; method from its column', () => {
  const { g } = world();
  const base = { id: 'd1', paymentUid: 'pmt-1', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, status: 'paid', chargedAt: '2026-09-21T10:00:00+03:00', chargedBy: 'ורד' };
  const legacy = plain(g.sandbox.digestRow_(base, {}));
  assert.equal(legacy.paymentDate, '07/09/2026');
  assert.equal(legacy.method, '');
  const rep = plain(g.sandbox.digestRow_(Object.assign({}, base, { receivedDate: '2026-09-20', method: 'ביט' }), {}));
  assert.equal(rep.paymentDate, '20/09/2026');
  assert.equal(rep.method, 'ביט');
  assert.deepEqual(Object.keys(rep).sort(), Object.keys(legacy).sort(), 'the allow-list did not grow');
  // which rows are listed is still "recorded since the last digest" (chargedAt)
  const t = Date.parse('2026-09-21T10:00:00+03:00');
  assert.equal(g.sandbox.digestSelect_([Object.assign({}, base, { receivedDate: '2026-09-01' })], t - 1000, t + 1000, {}).length, 1);
});

/* ================== 8. the cleanup workbook: «חסר גורם מממן» ================== */

test('cleanup: a patient who is not released and has no Funders row is listed «חסר גורם מממן»', () => {
  const { g } = world();
  const rows = (list) => ({ rows: list.map((o, i) => ({ rowNumber: i + 2, obj: o })) });
  const t = {
    patients: rows([
      { id: 'pt-1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-05', pay: 30000, status: 'active' },
      { id: 'pt-2', houseId: 'rehab', name: 'גל דוד', date: '2026-08-05', pay: 20000, status: 'active' },
      { id: 'pt-3', houseId: 'arfoni', name: 'שוחרר', date: '2026-07-01', pay: 20000, status: 'released', exitDate: '2026-08-01' },
    ]),
    payments: rows([]), credits: rows([]), overrides: rows([]),
    funders: rows([{ patientId: 'pt-2', funder: 'מכבי', effectiveFrom: '2026-08-05' }]),
  };
  const r = plain(g.sandbox.cleanupReport_('2026-09-30', t));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.sections.noFunder.map((x) => [x.kind, x.name, x.funder]), [['no_funder', 'אבי כהן', 'unset']]);
  assert.equal(r.counts.noFunder, 1);
  assert.deepEqual(Object.keys(r.sections), cleanup.SECTION_KEYS);
  // no funders tab at all → every active patient
  delete t.funders;
  assert.equal(plain(g.sandbox.cleanupReport_('2026-09-30', t)).sections.noFunder.length, 2);
});

test('cleanup workbook: the «חסר גורם מממן» tab is built (owner ורד); an older Code.gs without the section still renders', () => {
  const data = {
    ok: true, today: '2026-09-30', sections: {}, counts: {},
  };
  cleanup.SECTION_KEYS.forEach((k) => { data.sections[k] = []; });
  data.sections.noFunder = [{ kind: 'no_funder', houseId: 'ramot', name: 'אבי כהן', status: 'active', entryDate: '2026-07-05', funder: 'unset' }];
  assert.equal(cleanup.isCleanupResponse(data), true);
  const spec = cleanup.buildCleanupSpec(data, new Date('2026-09-30T09:00:00Z'));
  const tab = spec.sheets.find((s) => s.name === 'חסר גורם מממן');
  assert.ok(tab, 'tab exists');
  assert.equal(tab.rows.length, 1);
  assert.equal(tab.rows[0].owner, 'ורד');
  assert.equal(tab.rows[0].problem, 'חסר גורם מממן');
  const older = JSON.parse(JSON.stringify(data));
  delete older.sections.noFunder;
  assert.equal(cleanup.isCleanupResponse(older), true, 'Railway may deploy before the clasp CI');
  assert.equal(cleanup.buildCleanupSpec(older, new Date()).sheets.find((s) => s.name === 'חסר גורם מממן').rows.length, 0);
  const broken = JSON.parse(JSON.stringify(data));
  broken.sections.noFunder = 'x';
  assert.equal(cleanup.isCleanupResponse(broken), false, 'present but not a list is still refused');
});

/* ================== 9. nothing else moved ================== */

test('scope: no new HTTP action, no new role list entry, and the accounting feed does not leak the new fields', () => {
  const { g } = world();
  const known = arr(g.run('PROXY_KNOWN_ACTIONS'));
  /* PR 2 (CHANGELOG-payment-report-form.md) added exactly two, both behind
   * PROXY_SECRET and the finance gate: reportPayment and appendFunder.
   * Phase 4 (CHANGELOG-billing-control-tab.md) added the confirm action and
   * the queue read, behind PROXY_SECRET and the billingControl gate. */
  const pr2 = ['reportPayment', 'appendFunder', 'confirmPayment', 'billingControlQueue'];
  assert.ok(pr2.every((a) => known.includes(a)), known.join(','));
  assert.ok(!known.filter((a) => pr2.indexOf(a) < 0).some((a) => /funder|confirm|paymentReport/i.test(a)), known.join(','));
  assert.ok(!arr(g.run('APPROVER_ACTIONS')).includes('confirmPayment'));
  assert.ok(!arr(g.run('DELETE_ACTIONS')).includes('confirmPayment'));
  // The accounting feed is an explicit projection (the object around chargedAt): no new key reaches it.
  const at = GS_SRC.indexOf('chargedAt:      accIsraelStamp_(r.chargedAt)');
  const feed = GS_SRC.slice(GS_SRC.lastIndexOf('sourceRecordId:', at), GS_SRC.indexOf('deleted:        false', at));
  for (const c of REPORT_COLUMNS) assert.ok(!new RegExp('\\b' + c + '\\s*:').test(feed), 'accounting projection has no ' + c);
});
