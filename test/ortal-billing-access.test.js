/* Ortal: READ access to «גבייה» + the «בקרת גבייה» status dropdown and note
 * (server + schema — PR 1). CHANGELOG-ortal-billing-access.md.
 *
 * Code.gs (the REAL file in a vm, test/helpers/gs-sandbox.js):
 *   - permissions: Ortal (controller) reads every «גבייה» action; getData is
 *     cut to patients + overrides; every write / delete / void / approval of
 *     the tab stays refused with nothing written; Shiran and Yael are refused
 *     every «גבייה» read and both tab actions
 *   - the status enum: reported / confirmed / partial / flagged — nothing else;
 *     the savePayment path can never set 'partial'
 *   - partial bounds: 0 < amount < the reported amount, agorot, ONE receipt
 *   - remaining-debt math: verifiedAmount / openAmount / counts.partial /
 *     openDebt; the lib mirror agrees; «הכנסה מאומתת» counts only confirmed
 *     money
 *   - the note: 0–500, its own audit row, separate from flagNote
 *   - every change appends an AuditLog row with at / by / prev / next
 *   - savePayment never writes confirmedAmount / controlNote
 *   - a busy lock → lock_busy, nothing written; header names / clash
 *   - escaping: a formula lead-in and control characters never reach the
 *     sheet; HTML-looking text is stored as plain text and comes back escaped
 *     by the workbook (a string cell, never a formula)
 * server.js (real Express app, https stubbed):
 *   - Ortal: 200 on every «גבייה» read (getData cut again on this side even
 *     if Apps Script sent more), both exports; 403 on every write; Shiran /
 *     Yael 403 on every read and export, nothing proxied; /api/me billingRead
 * All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SERVER_PATH = require.resolve('../server');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const scope = require('../lib/finance-scope');
const rules = require('../lib/billing-control-rules');
const bcx = require('../lib/billing-control-xlsx');
const report = require('../lib/xlsx-report');
const { createSessionToken } = require('../lib/session');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-TEST-ortal-billing-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-ortal-billing-0123456789abcd';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-ortal-billing-a1b2c3d4e5f60718293a4b5c6d';
const FORBIDDEN = { ok: false, error: 'forbidden', message: 'אין הרשאה לפעולה זו' };

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ======================================================================
 * Code.gs world
 * ==================================================================== */

const gsActor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter'], []);
const YAEL = () => gsActor('yael', 'יעל', ['staff', 'reporter'], []);

const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: 'arfoni::דנה כהן::2026-09-15',
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const COV = { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' };

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const lcols = arr(g.run('LEAD_COLUMNS'));
  S.Leads = richSheet('Leads', lcols);
  S.Leads.appendRow(lcols.map((c) => ({ id: 'L1', name: 'ליד סודי', phone: '0500000000', status: 'new' }[c] || '')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportPay = (amount, receivedDate) => call({ action: 'reportPayment', report: { cycle: CYCLE, report: Object.assign({
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + amount, funder: 'פרטי', invoiceWanted: 'no',
  }, COV) } });
  const queue = (who) => call({ action: 'billingControlQueue' }, who || ORTAL);
  const decide = (confirm, who) => call({ action: 'confirmPayment', confirm }, who || ORTAL);
  const payRows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const receipt = (id) => payRows().find((r) => r.id === id);
  const audits = (prefix) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !prefix || String(r.action).indexOf(prefix) === 0);
  const details = (r) => JSON.parse(String(r.details));
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, call, reportPay, queue, decide, payRows, receipt, audits, details, snapshot };
}

/* One receipt of 10,000 reported by Vered. */
function withReceipt() {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(2)).ok, true);
  const id = w.queue().receipts[0].id;
  return Object.assign(w, { id });
}

/* =========================== 1. permissions =========================== */

const BILLING_READS = ['getData', 'getPayments', 'getCredits', 'refundPayoutForecast', 'debtAging', 'cleanupReport'];
const BILLING_WRITES = [
  ['savePayment', { payment: { id: 'x', status: 'unpaid' } }],
  ['updatePayment', { payment: { id: 'x' } }],
  ['reportPayment', { report: { cycle: CYCLE, report: {} } }],
  ['upsertBillingOverride', { override: { patientId: 'p1', month: '2026-09', amount: 1 } }],
  ['deleteBillingOverride', { override: { id: 'o1' } }],
  ['saveCredit', { credit: { id: 'c1', status: 'cancelled' } }],
  ['suggestRefunds', { houseId: 'arfoni' }],
  ['appendFunder', { funder: { patientId: 'p1', funder: 'פרטי', effectiveFrom: TODAY } }],
  ['saveAll', {}], ['removeLead', { lead: { id: 'L1' } }], ['deletePatientRow', { patient: { id: 'p1' } }],
];

test('permissions (Code.gs): Ortal READS every «גבייה» action; getData is cut to patients + overrides — no lead leaves', () => {
  const w = withReceipt();
  assert.deepEqual(arr(w.g.run('CONTROLLER_BILLING_READ_ACTIONS')), BILLING_READS);
  for (const action of BILLING_READS) {
    const r = w.call({ action, asOf: TODAY }, ORTAL);
    assert.notEqual(r.error, 'forbidden', action);
    assert.equal(r.ok, true, action + ': ' + JSON.stringify(r).slice(0, 120));
  }
  const d = w.call({ action: 'getData' }, ORTAL);
  assert.deepEqual(Object.keys(d).sort(), ['billingOverrides', 'ok', 'patients']);
  assert.ok(!JSON.stringify(d).includes('ליד סודי'), 'no lead in her answer');
  assert.ok(JSON.stringify(d).includes('דנה כהן'), 'the patients the «גבייה» rows need');
  // Sandra's getData is unchanged (every key).
  const full = w.call({ action: 'getData' }, SANDRA);
  for (const k of ['leads', 'patients', 'billingOverrides', 'dischargedPatients']) assert.ok(k in full, k);
  assert.equal(w.call({ action: 'getPayments' }, ORTAL).receipts.length, 1);
});

test('permissions (Code.gs): every «גבייה» write, delete, void and approval stays refused for Ortal — nothing written, even with a forged finance cap', () => {
  const w = withReceipt();
  const row = w.receipt(w.id);
  const before = w.snapshot();
  const forged = () => gsActor('ortal', 'אורטל', ['controller', 'deleter', 'approver'], ['finance', 'billingControl']);
  for (const who of [ORTAL, forged]) {
    for (const [action, body] of BILLING_WRITES) {
      assert.deepEqual(w.call(Object.assign({ action }, body), who), FORBIDDEN, action);
    }
    // A void of a receipt and an un-void are savePayment — refused before the role check.
    assert.deepEqual(w.call({ action: 'savePayment', payment: Object.assign({}, row, { status: 'void', linkStatus: 'duplicate', linkNote: 'x' }) }, who), FORBIDDEN);
  }
  assert.equal(w.snapshot(), before, 'nothing written');
});

test('permissions (Code.gs): Shiran and Yael are refused every «גבייה» read and both tab actions; their getData has no overrides', () => {
  const w = withReceipt();
  const before = w.snapshot();
  for (const who of [SHIRAN, YAEL]) {
    for (const action of BILLING_READS.filter((a) => a !== 'getData').concat(['billingControlQueue', 'confirmPayment'])) {
      const r = w.call({ action, asOf: TODAY, confirm: { ids: [w.id], status: 'confirmed' } }, who);
      assert.deepEqual([r.ok, r.error], [false, 'forbidden'], action);
    }
  }
  assert.equal(w.snapshot(), before, 'nothing read into a write, nothing written');
  // getData (it ensures its sheets for every caller — unchanged behaviour).
  for (const who of [SHIRAN, YAEL]) {
    const d = w.call({ action: 'getData' }, who);
    assert.equal(d.ok, true);
    assert.ok(!('billingOverrides' in d), 'restricted getData unchanged');
  }
});

/* =========================== 2. status enum =========================== */

test('status enum: reported / confirmed / partial / flagged — nothing else; savePayment can never set partial', () => {
  const w = withReceipt();
  assert.deepEqual(arr(w.g.run('CONTROL_STATUSES')), ['reported', 'confirmed', 'partial', 'flagged']);
  assert.deepEqual(arr(w.g.run('CONFIRM_STATUSES')), ['reported', 'confirmed', 'flagged'], 'the savePayment list is unchanged');
  assert.deepEqual([...rules.CONTROL_STATUSES], arr(w.g.run('CONTROL_STATUSES')));
  assert.deepEqual(rules.DECISION_OPTIONS.map((o) => [o.value, o.label]), [['confirmed', 'שולם'], ['partial', 'שולם חלקית'], ['flagged', 'לא שולם']]);
  const before = w.snapshot();
  for (const status of ['paid', 'PARTIAL', 'Confirmed', 'void', 'partial ', null, 7]) {
    const r = w.decide({ ids: [w.id], status, confirmedAmount: 100 });
    if (status === 'partial ') { assert.equal(r.ok, true, 'trimmed'); continue; }
    assert.deepEqual([r.ok, r.error], [false, 'confirm_status_invalid'], String(status));
  }
  // The trimmed 'partial ' above was the one legal write; undo the check by
  // comparing from here on.
  const after = w.snapshot();
  assert.notEqual(after, before);
  // No status and no note → refused.
  assert.deepEqual(w.decide({ ids: [w.id] }).error, 'confirm_status_invalid');
  // The savePayment path (Sandra, privileged) cannot carry 'partial'.
  const cyc = w.payRows().find((r) => r.id === CYCLE.id) || null;
  if (cyc) {
    const r = w.call({ action: 'savePayment', payment: Object.assign({}, cyc, { confirmStatus: 'partial' }) }, SANDRA);
    assert.equal(r.ok, false);
  }
  assert.equal(w.snapshot(), after);
});

/* =========================== 3. partial bounds =========================== */

test('partial bounds: 0 < amount < the reported amount, at most agorot, ONE receipt — every refusal writes nothing', () => {
  const w = withReceipt();
  const before = w.snapshot();
  const bad = [
    [0, 'partial_amount_invalid'], [-5, 'partial_amount_invalid'], ['', 'partial_amount_invalid'], [null, 'partial_amount_invalid'],
    ['abc', 'partial_amount_invalid'], ['1e3', 'partial_amount_invalid'], [NaN, 'partial_amount_invalid'], [Infinity, 'partial_amount_invalid'],
    [12.345, 'partial_amount_invalid'], ['12.345', 'partial_amount_invalid'], [{}, 'partial_amount_invalid'],
    [10000, 'partial_amount_range'], [10000.01, 'partial_amount_range'], [25000, 'partial_amount_range'],
  ];
  for (const [amount, code] of bad) {
    const r = w.decide({ ids: [w.id], status: 'partial', confirmedAmount: amount });
    assert.deepEqual([r.ok, r.error], [false, code], JSON.stringify(amount));
    assert.ok(r.message && /[֐-׿]/.test(r.message), 'a Hebrew message');
  }
  assert.equal(w.snapshot(), before, 'nothing written');
  // Two receipts at once → refused (an amount belongs to one receipt).
  assert.equal(w.reportPay(4000, daysAgo(1)).ok, true);
  const ids = w.queue().receipts.map((r) => r.id);
  const snap = w.snapshot();
  assert.equal(w.decide({ ids, status: 'partial', confirmedAmount: 100 }).error, 'partial_single');
  assert.equal(w.snapshot(), snap);
  // The edges that ARE legal.
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 0.01 }).ok, true);
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: '9999.99' }).ok, true);
  assert.equal(w.receipt(w.id).confirmedAmount, 9999.99);
  // The lib check judges the same way.
  assert.deepEqual(rules.partialAmountCheck('9999.99', 10000), { amount: 9999.99, error: '' });
  for (const raw of ['0', '10000', '-1', 'abc', '1.234', '', '20000']) assert.equal(rules.partialAmountCheck(raw, 10000).amount, null, raw);
  assert.equal(rules.partialAmountCheck('1,500', 10000).amount, 1500, 'a thousands comma is fine in the form');
});

/* ======================== 4. remaining-debt math ======================== */

test('remaining-debt math: only confirmed money counts — partial leaves its rest open, «לא שולם» leaves all of it; the lib agrees with Code.gs', () => {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(3)).ok, true);
  assert.equal(w.reportPay(4000, daysAgo(2)).ok, true);
  assert.equal(w.reportPay(2500, daysAgo(1)).ok, true);
  let q = w.queue();
  const [c, b, a] = q.receipts.map((r) => r.id);   // newest first: 2500, 4000, 10000
  assert.deepEqual(plain(q.openDebt), { partial: { count: 0, amount: 0 }, notReceived: { count: 0, amount: 0 }, total: 0 }, 'waiting is not debt here');
  assert.equal(w.decide({ ids: [a], status: 'partial', confirmedAmount: 6000 }).ok, true);
  assert.equal(w.decide({ ids: [b], status: 'flagged', flagNote: 'לא הגיע' }).ok, true);
  assert.equal(w.decide({ ids: [c], status: 'confirmed' }).ok, true);
  q = w.queue();
  const by = Object.fromEntries(q.receipts.map((r) => [r.id, r]));
  assert.deepEqual([by[a].confirmStatus, by[a].amount, by[a].verifiedAmount, by[a].openAmount, by[a].confirmedAmount], ['partial', 10000, 6000, 4000, 6000]);
  assert.deepEqual([by[b].confirmStatus, by[b].verifiedAmount, by[b].openAmount, by[b].confirmedAmount], ['flagged', 0, 4000, '']);
  assert.deepEqual([by[c].confirmStatus, by[c].verifiedAmount, by[c].openAmount, by[c].confirmedAmount], ['confirmed', 2500, 0, '']);
  assert.deepEqual(plain(q.counts.partial), { count: 1, amount: 10000, verified: 6000, open: 4000 });
  assert.deepEqual(plain(q.openDebt), { partial: { count: 1, amount: 4000 }, notReceived: { count: 1, amount: 4000 }, total: 8000 });
  // The reported amount (and so the shared cycle money) is never touched.
  assert.equal(Number(w.receipt(a).amountPaid), 10000);
  // The lib mirror, on the same receipts.
  assert.deepEqual(plain(rules.openDebt(q.receipts)), plain(q.openDebt));
  for (const r of q.receipts) {
    assert.equal(rules.verifiedAmountOf(r), r.verifiedAmount, r.id);
    assert.equal(rules.openAmountOf(r), r.openAmount, r.id);
  }
  // Raw rows (no projection) give the same answer as Code.gs's own rule.
  for (const raw of w.payRows().filter((r) => /^rcpt-/.test(r.id))) {
    const lib = Object.assign({}, raw, { amount: Number(raw.amountPaid), verifiedAmount: undefined });
    assert.equal(rules.verifiedAmountOf(lib), w.g.sandbox.receiptVerifiedAmount_(raw), raw.id);
    assert.equal(rules.openAmountOf(lib), w.g.sandbox.receiptOpenAmount_(raw), raw.id);
  }
  // «הכנסה מאומתת»: 6,000 + 2,500 over the same window; the flagged 4,000 is not income.
  const months = rules.verifiedMonths(q.receipts);
  const total = months.reduce((s, k) => Math.round((s + rules.verifiedForMonth(q.receipts, k, 'all').total) * 100) / 100, 0);
  assert.equal(total, 8500);
  const cards = rules.summaryCards(q, months[0]);
  assert.deepEqual(plain(cards.openDebt), plain(q.openDebt));
  assert.deepEqual(cards.partial, { count: 1, amount: 10000 });
  // Partial → confirmed clears the rest; → reported puts it back to waiting.
  assert.equal(w.decide({ ids: [a], status: 'confirmed' }).ok, true);
  assert.equal(w.queue().openDebt.partial.amount, 0);
  assert.equal(w.receipt(a).confirmedAmount, 10000, 'confirmed stores the full reported amount');
  assert.equal(w.decide({ ids: [a], status: 'reported' }).ok, true);
  assert.equal(w.receipt(a).confirmedAmount, '');
  assert.equal(w.queue().receipts.find((r) => r.id === a).verifiedAmount, 0);
});

test('remaining-debt math: a receipt confirmed BEFORE the column existed (blank confirmedAmount) counts in full, and re-confirming it is a no-op', () => {
  const w = withReceipt();
  // Confirm, then blank the new cell as an older deploy would have left it.
  assert.equal(w.decide({ ids: [w.id], status: 'confirmed' }).ok, true);
  const S = w.S.Payments;
  const col = arr(w.g.run('PAYMENT_COLUMNS')).indexOf('confirmedAmount');
  const rowIdx = S.grid.findIndex((r) => r[0] === w.id);
  S.grid[rowIdx][col] = '';
  const q = w.queue();
  assert.deepEqual([q.receipts[0].verifiedAmount, q.receipts[0].openAmount], [10000, 0]);
  assert.equal(rules.verifiedAmountOf({ confirmStatus: 'confirmed', amount: 10000, confirmedAmount: '' }), 10000);
  const n = w.audits('payment_confirm_').length;
  const r = w.decide({ ids: [w.id], status: 'confirmed' });
  assert.deepEqual([r.ok, r.changed.length, r.unchanged], [true, 0, 1]);
  assert.equal(w.audits('payment_confirm_').length, n, 'no audit row for a no-op');
});

/* ============================= 5. audit trail ============================= */

test('audit: every change appends at / by / prev / next — status, partial amount and note each leave their own row; nothing silent', () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 3000 }).ok, true);
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 3000 }).changed.length, 0, 'same again: no-op');
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 3500 }).ok, true, 'a new amount is a change');
  assert.equal(w.decide({ ids: [w.id], controlNote: 'העברה שנייה צפויה ביום ה׳' }).ok, true);
  assert.equal(w.decide({ ids: [w.id], status: 'flagged', flagNote: 'לא נמצא' }).ok, true);
  assert.equal(w.decide({ ids: [w.id], status: 'confirmed', controlNote: '' }).ok, true);
  const rows = w.audits().filter((r) => /^payment_(confirm_|control_note)/.test(String(r.action)));
  assert.deepEqual(rows.map((r) => r.action), [
    'payment_confirm_partial', 'payment_confirm_partial', 'payment_control_note', 'payment_confirm_flagged',
    'payment_confirm_confirmed', 'payment_control_note',
  ]);
  for (const r of rows) {
    const d = w.details(r);
    assert.ok(d.at && d.by === 'אורטל' && d.prev && d.next, r.action + ' carries at / by / prev / next');
    assert.equal(d.paymentId, w.id);
    assert.equal(r.actor, 'אורטל');
  }
  const d = rows.map((r) => w.details(r));
  assert.deepEqual([d[0].prev, d[0].next], [{ status: 'reported', confirmedAmount: '', flagNote: '' }, { status: 'partial', confirmedAmount: 3000, flagNote: '' }]);
  assert.deepEqual([d[1].prev.confirmedAmount, d[1].next.confirmedAmount, d[1].openAmount], [3000, 3500, 6500]);
  assert.deepEqual([d[2].prev, d[2].next], [{ controlNote: '' }, { controlNote: 'העברה שנייה צפויה ביום ה׳' }]);
  assert.deepEqual([d[3].prev.status, d[3].prev.confirmedAmount, d[3].next.status, d[3].next.confirmedAmount, d[3].next.flagNote], ['partial', 3500, 'flagged', '', 'לא נמצא']);
  assert.deepEqual([d[4].prev.flagNote, d[4].next.confirmedAmount], ['לא נמצא', 10000]);
  assert.deepEqual([d[5].prev.controlNote, d[5].next.controlNote], ['העברה שנייה צפויה ביום ה׳', '']);
  // confirmedBy / At: stamped ONCE, at the first partial — never re-stamped.
  const r = w.receipt(w.id);
  assert.equal(r.confirmedBy, 'אורטל');
  assert.equal(r.confirmedAt, d[0].at);
});

test('the note: separate from flagNote, editable any time without moving the status; ONE receipt; Sandra may edit it, Vered may not', () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'flagged', flagNote: 'לא נמצא בבנק' }).ok, true);
  const r1 = w.decide({ ids: [w.id], controlNote: 'בירור מול הבנק' });
  assert.equal(r1.ok, true);
  assert.deepEqual([r1.changed[0].confirmStatus, r1.changed[0].flagNote, r1.changed[0].controlNote], ['flagged', 'לא נמצא בבנק', 'בירור מול הבנק']);
  const row = w.receipt(w.id);
  assert.deepEqual([row.confirmStatus, row.flagNote, row.controlNote], ['flagged', 'לא נמצא בבנק', 'בירור מול הבנק']);
  // A status change does not wipe the note.
  assert.equal(w.decide({ ids: [w.id], status: 'confirmed' }).ok, true);
  assert.equal(w.receipt(w.id).controlNote, 'בירור מול הבנק');
  assert.equal(w.queue().receipts[0].controlNote, 'בירור מול הבנק');
  // Sandra (approver) may edit; Vered may not (role).
  assert.equal(w.decide({ ids: [w.id], controlNote: 'נבדק' }, SANDRA).ok, true);
  assert.equal(w.decide({ ids: [w.id], controlNote: 'x' }, VERED).error, 'forbidden_role');
  // Bulk note → refused.
  assert.equal(w.reportPay(100, daysAgo(1)).ok, true);
  const ids = w.queue().receipts.map((r) => r.id);
  assert.equal(w.decide({ ids, controlNote: 'x' }).error, 'control_note_single');
});

/* ============================ 6. escaping ============================ */

test('escaping: a formula lead-in and control characters never reach the sheet; 500 stored, 501 refused (never cut); HTML-looking text stays plain text', () => {
  const w = withReceipt();
  const before = w.snapshot();
  for (const bad of ['x'.repeat(501), 42, { a: 1 }, ['x']]) {
    assert.equal(w.decide({ ids: [w.id], controlNote: bad }).error, 'control_note_invalid', typeof bad);
  }
  assert.equal(w.snapshot(), before);
  assert.equal(w.decide({ ids: [w.id], controlNote: 'א'.repeat(500) }).ok, true);
  assert.equal(w.receipt(w.id).controlNote.length, 500);
  assert.equal(w.decide({ ids: [w.id], controlNote: '=HYPERLINK("http://x","y")' }).ok, true);
  assert.equal(w.receipt(w.id).controlNote, 'HYPERLINK("http://x","y")', 'formula lead-in dropped');
  assert.equal(w.decide({ ids: [w.id], controlNote: '+-@=SUM(A1)\nשורה\tשנייה' }).ok, true);
  assert.equal(w.receipt(w.id).controlNote, 'SUM(A1) שורה שנייה');
  const html = '<img src=x onerror=alert(1)> & "q"';
  assert.equal(w.decide({ ids: [w.id], controlNote: html }).ok, true);
  assert.equal(w.receipt(w.id).controlNote, html, 'stored verbatim as text — escaping is the renderer\'s job');
  assert.ok(arr(w.g.run('PAYMENT_TEXT_COLUMNS')).includes('controlNote'), 'text-forced column');
  // The lib check stores what the server stores.
  for (const raw of ['=1+1', ' -x ', 'a\u0007b', html, 'א'.repeat(500)]) {
    const s = plain(w.g.sandbox.controlNoteClean_(raw));
    assert.deepEqual(rules.controlNoteCheck(raw), { note: s.note, error: '' }, JSON.stringify(raw));
  }
  assert.equal(rules.controlNoteCheck('x'.repeat(501)).error !== '', true);
});

test('escaping: the «ייצוא אימות» workbook keeps the note as a plain string cell (never a formula) and lists the partial receipt with its rest', async () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 2500 }).ok, true);
  assert.equal(w.decide({ ids: [w.id], controlNote: '<b>x</b> & y' }).ok, true);
  const q = w.queue(SANDRA);
  q.receipts[0].controlNote = '=HYPERLINK("http://evil","x")';   // even if one slipped in
  const buf = await report.buildXlsxReport(bcx.buildBillingControlSpec(q, new Date()));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sh = wb.getWorksheet('שולם חלקית');
  assert.ok(sh, 'the partial sheet');
  let found = false;
  wb.worksheets.forEach((s) => s.eachRow((r) => r.eachCell((c) => {
    assert.ok(!(c.value && typeof c.value === 'object' && 'formula' in c.value), 'no formula cell in ' + s.name);
    if (String(c.value && c.value.richText ? c.value.richText.map((t) => t.text).join('') : c.value).includes('HYPERLINK')) found = true;
  })));
  assert.ok(found, 'the note is there, as text');
  const text = [];
  sh.eachRow((r) => text.push(r.values.slice(1).map((v) => String(v == null ? '' : v)).join('|')));
  assert.ok(text.some((t) => t.includes('2500') && t.includes('7500')), 'verified 2,500 and the open 7,500');
});

/* ============================ 7. write path ============================ */

test('savePayment / updatePayment never write confirmedAmount or controlNote (cycle or receipt) — the stored cells stay', () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 1234 }).ok, true);
  assert.equal(w.decide({ ids: [w.id], controlNote: 'מקור' }).ok, true);
  const rec = w.receipt(w.id);
  // A receipt invoice edit (the one edit it takes) carrying forged cells.
  const r = w.call({ action: 'savePayment', payment: Object.assign({}, rec, { invoiceWanted: 'yes', invoiceTo: 'משפחת כהן', confirmedAmount: 1, controlNote: 'זיוף' }) }, SANDRA);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([w.receipt(w.id).confirmedAmount, w.receipt(w.id).controlNote], [1234, 'מקור']);
  // A cycle row (non-receipt) — new and existing.
  const cyc = w.payRows().find((x) => !/^rcpt-/.test(x.id));
  const r2 = w.call({ action: 'savePayment', payment: Object.assign({}, cyc, { confirmedAmount: 99, controlNote: 'זיוף' }) }, SANDRA);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const after = w.payRows().find((x) => x.id === cyc.id);
  assert.deepEqual([after.confirmedAmount, after.controlNote], ['', '']);
  const r3 = w.call({ action: 'savePayment', payment: { id: 'pay::new', patientName: 'חדש', houseId: 'arfoni', dueDate: TODAY, amount: 100, status: 'unpaid', confirmedAmount: 5, controlNote: 'x' } }, SANDRA);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  const neu = w.payRows().find((x) => x.id === 'pay::new');
  assert.deepEqual([neu.confirmedAmount, neu.controlNote], ['', '']);
});

test('checked tryLock: a busy lock answers lock_busy and writes nothing', () => {
  const w = withReceipt();
  const before = w.snapshot();
  w.g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, waitLock() {}, releaseLock() {} }) };
  const r = w.decide({ ids: [w.id], status: 'partial', confirmedAmount: 10 });
  assert.deepEqual([r.ok, r.error], [false, 'lock_busy']);
  assert.equal(w.snapshot(), before);
});

test('header: the two column names are written when blank; a hand-added column where one belongs refuses, nothing written', () => {
  const w = withReceipt();
  const S = w.S.Payments;
  const cols = arr(w.g.run('PAYMENT_COLUMNS'));
  const i = cols.indexOf('confirmedAmount');
  S.grid[0][i] = ''; S.grid[0][i + 1] = '';
  assert.equal(w.decide({ ids: [w.id], status: 'confirmed' }).ok, true);
  assert.deepEqual([S.grid[0][i], S.grid[0][i + 1]], ['confirmedAmount', 'controlNote']);
  S.grid[0][i + 1] = 'הערה ידנית';
  const before = w.snapshot();
  assert.equal(w.decide({ ids: [w.id], controlNote: 'x' }).error, 'sheet_header_clash');
  assert.equal(w.snapshot(), before);
  assert.deepEqual(plain(w.g.sandbox.paymentControlHeaderClash_(S.grid[0])), [{ column: i + 2, expected: 'controlNote', found: 'הערה ידנית' }]);
});

/* ======================================================================
 * server.js
 * ==================================================================== */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

let _hash;
async function records() {
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  return ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, _hash, 1)));
}

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return mod;
}

function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push(JSON.parse(body || '{}'));
      const answer = respond(JSON.parse(body || '{}'));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}

function request(port, method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {};
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(fn) {
  const mod = freshServer({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records()) });
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port, mod); } finally { srv.close(); }
}

/* What Apps Script would answer per action (real Code.gs output). */
function realAnswers() {
  const w = withReceipt();
  const out = {};
  for (const a of BILLING_READS) out[a] = w.call({ action: a, asOf: TODAY }, SANDRA);   // the FULL answers
  return out;
}

test('permissions (server.js): Ortal 200 on every «גבייה» read (GET and POST) with her principal; getData is cut AGAIN here even if Apps Script sends every key', async () => {
  const answers = realAnswers();
  assert.ok('leads' in answers.getData, 'the stub answers the full getData');
  const stub = stubHttps((b) => answers[b.action] || { ok: true });
  try {
    await withServer(async (port) => {
      for (const action of BILLING_READS) {
        const g = await request(port, 'GET', '/api/sheets?action=' + action + '&asOf=' + TODAY, { cookie: personal('ortal') });
        assert.equal(g.status, 200, 'GET ' + action);
        const p = await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: { action, asOf: TODAY } });
        assert.equal(p.status, 200, 'POST ' + action);
      }
      for (const c of stub.calls) {
        assert.deepEqual([c.proxyUserId, c.proxyRoles, c.proxyCaps], ['ortal', ['controller'], ['billingControl']], 'never finance');
      }
      const d = await request(port, 'GET', '/api/sheets?action=getData', { cookie: personal('ortal') });
      assert.deepEqual(Object.keys(d.json).sort(), ['billingOverrides', 'ok', 'patients']);
      assert.ok(!d.text.includes('ליד סודי'));
      // Sandra's getData is unchanged.
      const s = await request(port, 'GET', '/api/sheets?action=getData', { cookie: personal('sandra') });
      assert.ok('leads' in s.json);
      const me = await request(port, 'GET', '/api/me', { cookie: personal('ortal') });
      assert.deepEqual([me.json.view, me.json.billingRead, me.json.finance, me.json.deleter, me.json.approver], ['controller', true, false, false, false]);
      for (const id of ['vered', 'sandra', 'shiran', 'yael']) {
        assert.equal((await request(port, 'GET', '/api/me', { cookie: personal(id) })).json.billingRead, false, id);
      }
    });
  } finally { stub.restore(); }
});

test('permissions (server.js): Ortal 403 on every «גבייה» write / delete / void / approval and the debug routes — nothing proxied', async () => {
  const stub = stubHttps(() => ({ ok: true }));
  try {
    await withServer(async (port) => {
      for (const [action, body] of BILLING_WRITES) {
        const r = await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: Object.assign({ action }, body) });
        assert.equal(r.status, 403, action);
      }
      for (const p of ['/api/debug/last-save', '/api/debug/last-load', '/api/pin-admin/line']) {
        assert.equal((await request(port, 'GET', p, { cookie: personal('ortal') })).status, 403, p);
      }
      assert.equal(stub.calls.length, 0);
    });
  } finally { stub.restore(); }
});

test('permissions (server.js): Shiran and Yael are DENIED every «גבייה» read and all three exports — nothing proxied; Ortal gets the exports', async () => {
  const answers = realAnswers();
  const stub = stubHttps((b) => answers[b.action] || { ok: true });
  try {
    await withServer(async (port) => {
      for (const id of ['shiran', 'yael']) {
        for (const action of BILLING_READS.filter((a) => a !== 'getData').concat(scope.BILLING_CONTROL_ACTIONS)) {
          const g = await request(port, 'GET', '/api/sheets?action=' + action, { cookie: personal(id) });
          assert.equal(g.status, 403, id + ' GET ' + action);
          const p = await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: { action } });
          assert.equal(p.status, 403, id + ' POST ' + action);
        }
        for (const p of ['/api/export/refund-forecast.xlsx', '/api/export/cleanup.xlsx', `/api/export/debt-aging.xlsx?asOf=${TODAY}&house=all&status=all`]) {
          assert.equal((await request(port, 'GET', p, { cookie: personal(id) })).status, 403, id + ' ' + p);
        }
      }
      assert.equal(stub.calls.length, 0, 'nothing proxied for Shiran / Yael');
      for (const p of ['/api/export/refund-forecast.xlsx', '/api/export/cleanup.xlsx']) {
        const r = await request(port, 'GET', p, { cookie: personal('ortal') });
        assert.equal(r.status, 200, 'Ortal ' + p + ': ' + r.text.slice(0, 80));
        assert.equal(r.headers['content-type'], report.XLSX_MIME);
      }
    });
  } finally { stub.restore(); }
});

test('lists: lib/finance-scope.js and Code.gs agree; the controller read list holds no write; the route list adds only the two exports', () => {
  const w = world();
  assert.deepEqual([...scope.CONTROLLER_BILLING_READ_ACTIONS], BILLING_READS);
  assert.deepEqual(arr(w.g.run('CONTROLLER_ACTIONS')), [...scope.CONTROLLER_ACTIONS]);
  assert.deepEqual(arr(w.g.run('CONTROLLER_GETDATA_KEYS')), [...scope.CONTROLLER_GETDATA_KEYS]);
  for (const [a] of BILLING_WRITES) assert.ok(!scope.CONTROLLER_ACTIONS.includes(a), a + ' is not hers');
  for (const a of BILLING_READS) assert.ok(scope.CONTROLLER_ACTIONS.includes(a), a);
  assert.deepEqual([...scope.CONTROLLER_ROUTES].slice(-2), ['/api/export/refund-forecast.xlsx', '/api/export/cleanup.xlsx']);
  assert.deepEqual(plain(scope.controllerGetDataView({ ok: true, leads: [1], patients: { a: [] }, billingOverrides: [], houseManagers: {} })),
    { ok: true, patients: { a: [] }, billingOverrides: [] });
  assert.deepEqual(plain(scope.controllerGetDataView({ ok: false, error: 'x', leads: [1] })), { ok: false, error: 'x' });
  // Ortal's roles are unchanged: controller only — no deleter, no approver.
  assert.deepEqual([...users.modelById('ortal').roles], ['controller']);
});
