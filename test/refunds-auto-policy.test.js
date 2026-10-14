/* Automatic refunds by policy — CHANGELOG-refunds-auto-policy.md.
 *
 * Covers: the single REFUND_POLICY_CUTOVER literal (guard), the rule chosen by
 * the ENTRY date (day before / on / after the cutover), the unified rule's
 * day 13 / 14 / 15 exits in every house, the old per-house rule kept for
 * earlier entries, the prepaid full refund, the payment date by the EXIT date
 * (10th / 11th), the refund created at discharge with no approval step, the
 * no-zero-amount guard (never created, existing ones hidden, sheet kept), the
 * server-side exception (Sandra only), «סמן כשולם», and the one list on the
 * screen (totals per payment date + grand total, escaped). */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { loadPage } = require('./helpers/app-sandbox');
const roleScope = require('../lib/role-scope');
const financeScope = require('../lib/finance-scope');

const ROOT = path.join(__dirname, '..');
const plain = (x) => JSON.parse(JSON.stringify(x));
const arr = (x) => Array.from(x);
const PROXY_SECRET = 'proxy-secret-TEST-refunds-auto-policy-0123456789';
const DSHEET = 'מטופלים משוחררים';
const NAME = 'מטופל אוטומטי';

const actor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
  proxyCaps: caps || ['finance', 'billingControl'],
});
const VERED = () => actor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SANDRA = () => actor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer']);
const ORTAL = () => actor('ortal', 'אורטל', ['controller'], ['billingControl']);

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const col = (n) => arr(g.run(n));
  const add = (sheet, cols, obj) => {
    if (!S[sheet]) S[sheet] = richSheet(sheet, col(cols));
    S[sheet].appendRow(col(cols).map((c) => (obj[c] === undefined ? '' : obj[c])));
  };
  const key = (houseId, entry) => houseId + '::' + NAME + '::' + entry;
  return {
    g, S,
    call: (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)()))),
    payment: (houseId, entry, due, amountPaid) => add('Payments', 'PAYMENT_COLUMNS', {
      id: 'pay::' + key(houseId, entry) + '::' + due, patientId: key(houseId, entry), patientName: NAME, houseId,
      dueDate: due, amount: amountPaid, status: 'paid', amountPaid,
    }),
    discharged: (o) => add(DSHEET, 'DISCHARGED_PATIENT_COLUMNS', Object.assign({
      id: 'aud-' + Math.random().toString(36).slice(2), name: NAME, status: 'released', disposition: 'completed',
      discharge_note: '', restored: '',
    }, o)),
    credit: (o) => add('Credits', 'CREDIT_COLUMNS', o),
    credits: () => g.sheetRows('Credits', 'CREDIT_COLUMNS'),
    key,
  };
}

/* computeRefund_ for one paid cycle anchored on the entry. */
function refund(w, houseId, entry, exit, paid) {
  return plain(w.g.sandbox.computeRefund_({ houseId, entryDate: entry, exitDate: exit, amountPaid: paid == null ? 30000 : paid, decidedDate: exit }));
}
const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
const HOUSES = ['asher', 'ramot', 'rehab', 'pardes', 'arfoni', 'sde'];

/* ===================== 1. the cutover constant ===================== */

test('guard: REFUND_POLICY_CUTOVER = 2026-10-07 is written ONCE — no other copy of the literal in code', () => {
  const files = ['apps-script/Code.gs', 'server.js']
    .concat(fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f))
    .concat(fs.readdirSync(path.join(ROOT, 'public')).filter((f) => /\.(js|html)$/.test(f)).map((f) => 'public/' + f));
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/['"`]2026-10-07['"`]/g)) hits.push(f + ':' + src.slice(0, m.index).split('\n').length);
  }
  assert.equal(hits.length, 1, 'exactly one literal: ' + hits.join(', '));
  const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  assert.match(gs, /^const REFUND_POLICY_CUTOVER\s+= '2026-10-07';$/m);
  assert.ok(!/REFUND_RULE_V2_FROM/.test(gs + fs.readFileSync(path.join(ROOT, 'lib', 'refund-rules.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')), 'the old exit-date constant is gone');
  assert.equal(loadGs({}).run('REFUND_POLICY_CUTOVER'), '2026-10-07');
});

/* ===================== 2. rule by ENTRY date ===================== */

test('entry the day before / on / after the cutover: old per-house rule before, the new unified rule from it', () => {
  const w = world();
  const ver = (e) => w.g.sandbox.refundRuleVersion_(e);
  assert.deepEqual([ver('2026-10-06'), ver('2026-10-07'), ver('2026-10-08')], [1, 2, 2]);
  // A balance house, exit on stay day 14: the old rule refunds (not the cycle's last 7 days); the new one does not.
  const before = refund(w, 'asher', '2026-10-06', '2026-10-19');
  assert.deepEqual([before.ruleVersion, before.rule, before.refund], [1, 'residential_prorata', 17000]);
  const on = refund(w, 'asher', '2026-10-07', '2026-10-20');
  assert.deepEqual([on.ruleVersion, on.rule, on.refund], [2, 'stay_day14_zero', 0]);
  const after = refund(w, 'asher', '2026-10-08', '2026-10-21');
  assert.deepEqual([after.ruleVersion, after.rule, after.refund], [2, 'stay_day14_zero', 0]);
  // The EXIT date no longer decides: an old entry exiting long after the cutover keeps the old rule.
  const late = refund(w, 'ramot', '2026-09-20', '2026-10-25');
  assert.equal(late.ruleVersion, 1);
});

test('new rule, every house: exit on stay day 13 → pro-rata of the unused days; day 14 and 15 → no refund', () => {
  const w = world();
  const entry = '2026-10-08';                     // cycle 08/10 – 07/11 (31 days)
  for (const h of HOUSES) {
    const d13 = refund(w, h, entry, addDays(entry, 12));
    const d14 = refund(w, h, entry, addDays(entry, 13));
    const d15 = refund(w, h, entry, addDays(entry, 14));
    assert.deepEqual([d13.stayDay, d13.rule, d13.daysNotStayed, d13.refund], [13, 'stay_prorata', 18, 18000], h + ' day 13');
    assert.deepEqual([d14.stayDay, d14.rule, d14.refund], [14, 'stay_day14_zero', 0], h + ' day 14');
    assert.deepEqual([d15.stayDay, d15.rule, d15.refund], [15, 'stay_day14_zero', 0], h + ' day 15');
    assert.equal(d13.ruleVersion, 2);
  }
});

test('old rule kept exactly for an entry before the cutover: balance houses by the last 7 days, the others by stay day 14', () => {
  const w = world();
  const entry = '2026-09-01';                     // cycle 01/09 – 30/09
  for (const h of ['asher', 'ramot']) {
    assert.deepEqual([refund(w, h, entry, '2026-09-20').rule, refund(w, h, entry, '2026-09-20').refund], ['residential_prorata', 10000], h);
    assert.deepEqual([refund(w, h, entry, '2026-09-24').rule, refund(w, h, entry, '2026-09-24').refund], ['residential_last_days_zero', 0], h + ' last 7 days');
  }
  for (const h of ['rehab', 'pardes', 'arfoni', 'sde']) {
    const d13 = refund(w, h, entry, '2026-09-13');
    const d14 = refund(w, h, entry, '2026-09-14');
    assert.deepEqual([d13.rule, d13.refund], ['detox_prorata', 17000], h + ' day 13');
    assert.deepEqual([d14.rule, d14.refund], ['detox_tenure_cutoff_zero', 0], h + ' day 14');
  }
});

test('a fully prepaid later cycle after the exit is refunded in full (new rule), beside the day-13 pro-rata', () => {
  const w = world();
  const entry = '2026-10-08';
  w.payment('rehab', entry, entry, 30000);
  w.payment('rehab', entry, '2026-11-08', 30000);
  const lines = plain(w.g.sandbox.autoRefundLines_({
    houseId: 'rehab', entryDate: entry, exitDate: '2026-10-20', payKey: w.key('rehab', entry),
  }, w.g.sheetRows('Payments', 'PAYMENT_COLUMNS')));
  assert.deepEqual(lines.map((l) => [l.creditType, l.calculatedAmount, l.basis.rule]),
    [['days_unused', 18000, 'stay_prorata'], ['prepaid_return', 30000, 'prepaid_return']]);
});

/* ===================== 3. payment date by the EXIT date ===================== */

test('payment date: exit on/before the 10th → the 15th of that month; after the 10th → the 15th of the next', () => {
  const w = world();
  const pd = (exit) => w.g.sandbox.refundPayoutDate_(exit);
  assert.equal(pd('2026-11-10'), '2026-11-15');
  assert.equal(pd('2026-11-11'), '2026-12-15');
  assert.equal(pd('2026-12-11'), '2027-01-15');
  // The auto refund is decided ON the exit date, so its row carries exactly that date.
  const entry = '2026-11-01';                       // exits on stay day 10 / 11 → a refund is due
  for (const [exit, want] of [['2026-11-10', '2026-11-15'], ['2026-11-11', '2026-12-15']]) {
    const x = world();
    x.payment('pardes', entry, entry, 30000);
    x.discharged({ houseId: 'pardes', date: entry, exitDate: exit });
    const f = plain(x.g.sandbox.refundPayoutForecastFor_(x.g.sheetRows(DSHEET, 'DISCHARGED_PATIENT_COLUMNS'), [],
      x.g.sheetRows('Payments', 'PAYMENT_COLUMNS'), '2026-11-20'));
    assert.deepEqual(f.toPay.rows.map((r) => [r.exitDate, r.payoutDate, r.auto]), [[exit, want, true]], exit);
  }
});

/* ===================== 4. created at discharge, no approval ===================== */

test('discharge creates the refund on the server — pending, approved by policy, paid by the exit date; nothing to decide', () => {
  const w = world();
  const entry = '2026-10-08', exit = '2026-10-20';
  w.payment('arfoni', entry, entry, 30000);
  const res = w.call({ action: 'dischargePatient', patient: {
    id: 'aud-1', houseId: 'arfoni', name: NAME, date: entry, exitDate: exit, status: 'released', disposition: 'stopped_early', discharge_note: 'עזב',
  } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.refund, { created: 1, skipped: '' });
  const rows = w.credits();
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.deepEqual([c.status, c.amount, c.calculatedAmount, c.creditType, c.approvedBy, c.decidedDate, c.payoutDate, c.overrideReason],
    ['pending', 18000, 18000, 'days_unused', 'מדיניות אוטומטית', exit, '2026-11-15', '']);
  assert.match(String(c.id), /^credit::.+::2026-10::1$/);
  assert.equal(JSON.parse(c.basis).ruleVersion, 2);
  // A retried discharge of the same stay never adds a second refund.
  w.call({ action: 'dischargePatient', patient: { id: 'aud-1', houseId: 'arfoni', name: NAME, date: entry, exitDate: exit, status: 'released', disposition: 'stopped_early', discharge_note: 'עזב' } });
  w.call({ action: 'dischargePatient', patient: { id: 'aud-9', houseId: 'arfoni', name: NAME, date: entry, exitDate: exit, status: 'released' } });
  assert.equal(w.credits().length, 1);
  // The list shows it as a saved row (no computed duplicate).
  const f = w.call({ action: 'refundPayoutForecast' });
  assert.deepEqual(f.toPay.rows.map((r) => [r.creditId === c.id, r.auto, r.amount, r.dischargeNote, r.disposition]),
    [[true, false, 18000, 'עזב', 'stopped_early']]);
});

test('no-zero guard: a discharge whose policy refund is 0 writes NO credit row (and no Credits tab); a failure never blocks the discharge', () => {
  const w = world();
  const entry = '2026-10-08';
  w.payment('asher', entry, entry, 30000);
  const res = w.call({ action: 'dischargePatient', patient: { id: 'aud-2', houseId: 'asher', name: NAME, date: entry, exitDate: '2026-10-21', status: 'released' } });
  assert.deepEqual([res.ok, res.refund.created, res.refund.skipped], [true, 0, 'zero']);
  assert.equal(w.S.Credits, undefined, 'no Credits tab, no zero row');
  const bad = w.call({ action: 'dischargePatient', patient: { id: 'aud-3', houseId: 'nowhere', name: 'אחר', date: entry, exitDate: '2026-10-12', status: 'released' } });
  assert.deepEqual([bad.ok, bad.discharged, bad.refund.error], [true, true, 'unknown_house']);
});

test('no-zero guard: saveCredit never creates a zero-amount credit, even for Sandra', () => {
  const w = world();
  const c = { patientId: 'p1', patientKey: w.key('rehab', '2026-10-08'), patientName: NAME, houseId: 'rehab',
    creditType: 'days_unused', allocationMonth: '2026-10', calculatedAmount: 0, amount: 0 };
  assert.equal(w.call({ action: 'saveCredit', credit: c }, SANDRA).error, 'zero_amount_credit');
  assert.equal(w.g.sandbox.upsertCredit_(c, 'סנדרה', { approver: true }).error, 'zero_amount_credit');
  assert.equal(w.credits().length, 0);
});

test('existing zero-amount «ימים שלא נוצלו» rows are hidden, counted, kept on the sheet — and the stay is recomputed', () => {
  const w = world();
  const entry = '2026-09-01';
  w.payment('rehab', entry, entry, 30000);
  w.discharged({ houseId: 'rehab', date: entry, exitDate: '2026-09-10' });
  for (let i = 1; i <= 7; i++) {
    const k = i === 1 ? w.key('rehab', entry) : 'rehab::אחר' + i + '::2026-08-0' + i;
    w.credit({ id: 'credit::z' + i, patientId: 'z' + i, patientKey: k, patientName: 'z' + i, houseId: 'rehab',
      creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 0, amount: 0, status: 'pending' });
  }
  const before = JSON.stringify(w.S.Credits.grid);
  const f = w.call({ action: 'refundPayoutForecast' });
  assert.equal(f.zeroCreditsHidden, 7);
  assert.ok(f.toPay.rows.every((r) => r.amount > 0), 'no ₪0 row is ever listed');
  assert.deepEqual(f.toPay.rows.map((r) => [r.patientName, r.auto, r.amount, r.ruleVersion]), [[NAME, true, 20000, 1]]);
  assert.equal(JSON.stringify(w.S.Credits.grid), before, 'read-only: the 7 rows stay on the sheet');
});

/* ===================== 5. the exception — Sandra only, server-side ===================== */

test('override: approveRefundException is APPROVER-only (Sandra) on both servers; Vered and Ortal are refused, nothing written', () => {
  assert.ok(roleScope.APPROVER_ACTIONS.includes('approveRefundException'));
  const p = (id, roles) => ({ auth: 'personal', id, roles });
  assert.equal(roleScope.roleAllowed(p('sandra', ['staff', 'approver']), 'approveRefundException'), true);
  assert.equal(roleScope.roleAllowed(p('vered', ['staff', 'deleter']), 'approveRefundException'), false);
  assert.equal(roleScope.roleAllowed(p('vered', ['approver']), 'approveRefundException'), false, 'approver is pinned to Sandra');
  assert.equal(roleScope.roleOperationFor('saveCredit', { credit: { creditType: 'other', amount: 5 } }), 'approveRefundException');
  assert.equal(roleScope.roleOperationFor('saveCredit', { credit: { id: 'credit::x', notes: 'n' } }), '');

  const w = world();
  const entry = '2026-10-08';
  w.payment('rehab', entry, entry, 30000);
  w.call({ action: 'dischargePatient', patient: { id: 'aud-1', houseId: 'rehab', name: NAME, date: entry, exitDate: '2026-10-20', status: 'released' } });
  const id = w.credits()[0].id;
  const before = JSON.stringify(w.S.Credits.grid);
  assert.equal(w.call({ action: 'approveRefundException', creditId: id, amount: 0, reason: 'ויתור' }, VERED).error, 'forbidden_role');
  assert.equal(w.call({ action: 'approveRefundException', creditId: id, amount: 0, reason: 'ויתור' }, ORTAL).error, 'forbidden');
  // Vered cannot change the amount through saveCredit either.
  const stored = w.credits()[0];
  const edit = w.call({ action: 'saveCredit', credit: { id, updatedAt: stored.updatedAt, amount: 1, overrideReason: 'x' } }, VERED);
  assert.equal(edit.error, 'override_requires_approver');
  assert.equal(JSON.stringify(w.S.Credits.grid), before, 'nothing written by a refused override');
  // Sandra: the reason is required; then the amount changes, calculatedAmount does not.
  assert.equal(w.call({ action: 'approveRefundException', creditId: id, amount: 0, reason: ' ' }, SANDRA).error, 'reason_required');
  assert.equal(w.call({ action: 'approveRefundException', creditId: id, amount: -1, reason: 'סיבה' }, SANDRA).error, 'bad_amount');
  const ok = w.call({ action: 'approveRefundException', creditId: id, amount: 0, reason: 'בקשת המשפחה' }, SANDRA);
  assert.equal(ok.ok, true);
  const c = w.credits()[0];
  assert.deepEqual([c.amount, c.calculatedAmount, c.overrideReason, c.approvedBy], [0, 18000, 'בקשת המשפחה', 'סנדרה']);
  // An approved zero is a decision: not listed, not recomputed, not counted as a hidden artefact.
  const f = w.call({ action: 'refundPayoutForecast' });
  assert.deepEqual([f.toPay.count, f.zeroCreditsHidden], [0, 0]);
});

test('override on a computed row: Sandra changes the amount — the stay is written first, then the line is overridden', () => {
  const w = world();
  const entry = '2026-09-01';
  w.payment('pardes', entry, entry, 30000);
  w.discharged({ houseId: 'pardes', date: entry, exitDate: '2026-09-10' });
  const row = w.call({ action: 'refundPayoutForecast' }).toPay.rows[0];
  assert.equal(row.auto, true);
  const r = w.call({ action: 'approveRefundException', patientKey: row.patientKey, creditType: row.creditType,
    allocationMonth: row.allocationMonth, amount: 15000, reason: 'הסכם מיוחד' }, SANDRA);
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = w.credits();
  assert.deepEqual(c.map((x) => [x.amount, x.calculatedAmount, x.overrideReason]), [[15000, 20000, 'הסכם מיוחד']]);
  const after = w.call({ action: 'refundPayoutForecast' }).toPay.rows;
  assert.deepEqual(after.map((x) => [x.auto, x.amount, x.overridden]), [[false, 15000, true]]);
});

/* ===================== 6. «סמן כשולם» ===================== */

test('settleRefund: Vered marks a computed row paid (written once), a saved row paid; Ortal is refused; bad input refused', () => {
  const w = world();
  const entry = '2026-09-01';
  w.payment('sde', entry, entry, 30000);
  w.discharged({ houseId: 'sde', date: entry, exitDate: '2026-09-10' });
  const row = w.call({ action: 'refundPayoutForecast' }).toPay.rows[0];
  const target = { patientKey: row.patientKey, creditType: row.creditType, allocationMonth: row.allocationMonth };
  assert.equal(w.call(Object.assign({ action: 'settleRefund', paidDate: '2026-10-01', method: 'העברה' }, target), ORTAL).error, 'forbidden');
  assert.equal(w.call(Object.assign({ action: 'settleRefund', paidDate: '01/10/2026', method: 'העברה' }, target)).error, 'bad_paidDate');
  assert.equal(w.call(Object.assign({ action: 'settleRefund', paidDate: '2026-10-01', method: '' }, target)).error, 'missing_method');
  assert.equal(w.call(Object.assign({ action: 'settleRefund', paidDate: '2999-01-01', method: 'x' }, target)).error, 'paidDate_in_future');
  assert.equal(w.S.Credits, undefined, 'refusals write nothing');
  const ok = w.call(Object.assign({ action: 'settleRefund', paidDate: '2026-10-01', method: '=HYPERLINK("x")' }, target));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const c = w.credits();
  assert.deepEqual(c.map((x) => [x.status, x.paidDate, x.amount]), [['paid', '2026-10-01', 20000]]);
  assert.ok(!/^[=+\-@]/.test(c[0].method), 'formula lead-in stripped');
  assert.equal(w.call({ action: 'refundPayoutForecast' }).toPay.count, 0, 'paid → off the list');
  assert.equal(w.call({ action: 'settleRefund', creditId: c[0].id, paidDate: '2026-10-01', method: 'x' }).error, 'not_pending');
  assert.ok(financeScope.FINANCE_ACTIONS.includes('settleRefund'));
  assert.ok(!financeScope.CONTROLLER_ACTIONS.includes('settleRefund'));
  assert.deepEqual(arr(w.g.run('FINANCE_ACTIONS')), [...financeScope.FINANCE_ACTIONS], 'Code.gs ⇄ lib in step');
  assert.ok(arr(w.g.run('PROXY_KNOWN_ACTIONS')).includes('settleRefund'));
  assert.ok(arr(w.g.run('PROXY_KNOWN_ACTIONS')).includes('approveRefundException'));
});

test('Ortal sees the whole list: every row column, totals by payment date and the grand total; never overrideReason', () => {
  const w = world();
  const entry = '2026-10-08';
  w.payment('rehab', entry, entry, 30000);
  w.call({ action: 'dischargePatient', patient: { id: 'aud-1', houseId: 'rehab', name: NAME, date: entry, exitDate: '2026-10-20', status: 'released', disposition: 'completed', discharge_note: 'סיים' } });
  const f = w.call({ action: 'refundPayoutForecast' }, ORTAL);
  assert.equal(f.ok, true);
  assert.deepEqual(f.toPay.byPayoutDate, [{ payoutDate: '2026-11-15', count: 1, total: 18000 }]);
  assert.deepEqual([f.toPay.count, f.toPay.total], [1, 18000]);
  const r = f.toPay.rows[0];
  assert.deepEqual([r.patientName, r.houseId, r.totalPaid, r.entryDate, r.exitDate, r.disposition, r.dischargeNote, r.daysStayed, r.refundDays, r.amount, r.ruleVersion, r.payoutDate],
    [NAME, 'rehab', 30000, entry, '2026-10-20', 'completed', 'סיים', 13, 18, 18000, 2, '2026-11-15']);
  assert.ok(!JSON.stringify(f).includes('overrideReason'));
});

/* ===================== 7. the screen ===================== */

test('screen: ONE «זיכויים לתשלום» list — totals per payment date + grand total above, every row column, escaped; no «ממתין להחלטה»', () => {
  const page = loadPage({});
  const data = { ok: true, toPay: { count: 2, total: 21000, byPayoutDate: [{ payoutDate: '2026-11-15', count: 2, total: 21000 }], rows: [
    { creditId: 'c1', auto: false, patientName: '<img src=x onerror=1>', houseId: 'rehab', totalPaid: 30000, entryDate: '2026-10-08', exitDate: '2026-10-20',
      disposition: 'stopped_early', dischargeNote: '<b>עזב</b>', daysStayed: 13, refundDays: 18, amount: 18000, calculatedAmount: 18000, overridden: false,
      ruleVersion: 2, rule: 'stay_prorata', creditType: 'days_unused', allocationMonth: '2026-10', payoutDate: '2026-11-15' },
    { creditId: '', auto: true, patientName: 'ב', houseId: 'asher', totalPaid: 3000, entryDate: '2026-09-01', exitDate: '2026-09-28',
      disposition: 'completed', dischargeNote: '', daysStayed: 28, refundDays: 3, amount: 3000, calculatedAmount: 3000, overridden: false,
      ruleVersion: 1, rule: 'residential_prorata', creditType: 'days_unused', allocationMonth: '2026-09', payoutDate: '2026-11-15' },
  ] }, missing_payment_data: { count: 0, rows: [] }, unresolved: { count: 0, rows: [] } };
  page.run('globalThis.__d = ' + JSON.stringify(data));
  const html = page.run('payoutForecastHtml(__d, { settle: true, exception: false })');
  assert.ok(!html.includes('ממתין להחלטה'));
  assert.match(html, /refund-totals-table/);
  assert.match(html, /<tr class="refund-grand-total"><th>סה"כ<\/th><th>2<\/th>/);
  for (const label of ['מטופל', 'בית', 'סה"כ שולם', 'כניסה', 'יציאה', 'סיבת עזיבה', 'ימי שהייה', 'ימי זיכוי', 'סכום זיכוי', 'כלל', 'תאריך תשלום']) {
    assert.ok(html.includes(`<span class="p-label">${label.replace(/"/g, '&quot;')}</span>`), label);
  }
  assert.ok(html.includes('הפסיק לפני הזמן — &lt;b&gt;עזב&lt;/b&gt;'), 'disposition label + escaped note');
  assert.ok(!html.includes('<img src=x') && !html.includes('<b>עזב'), 'escaped');
  assert.ok(html.includes('חדש (אחיד)') && html.includes('ישן (לפי בית)'), 'new / old rule');
  assert.equal((html.match(/data-refund-action="settle"/g) || []).length, 2, '«סמן כשולם» on every row');
  assert.ok(!html.includes('data-refund-action="exception"'), 'no exception button without approver');
  assert.ok(html.includes('refund-row--auto'));
  const ro = page.run('payoutForecastHtml(__d, { settle: false, exception: false })');
  assert.ok(!ro.includes('data-refund-action'), 'read-only (Ortal) view has no write buttons');
  // The controls follow the session: Ortal never, Vered settle, Sandra settle + exception.
  page.run("state.mode = 'edit'; state.finance = true; state.view = ''; state.approver = false");
  assert.deepEqual(plain(page.run('refundRowControls()')), { settle: true, exception: false });
  page.run('state.approver = true');
  assert.deepEqual(plain(page.run('refundRowControls()')), { settle: true, exception: true });
  page.run("state.view = 'controller'");
  assert.deepEqual(plain(page.run('refundRowControls()')), { settle: false, exception: false });
  const html2 = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!html2.includes('ממתין להחלטה') && !html2.includes('credits-payout-list'));
  assert.equal((html2.match(/>זיכויים לתשלום </g) || []).length, 1);
});

test('discharge on the client: no credits modal, a notice instead — never an amount', () => {
  const page = loadPage({});
  assert.deepEqual(plain(page.run("autoRefundNotice({ created: 1, skipped: '' })")).error, false);
  assert.ok(!/\d{3}/.test(page.run("autoRefundNotice({ created: 2 }).text")), 'no amount in the toast');
  assert.equal(page.run("autoRefundNotice({ created: 0, skipped: 'zero' })"), null);
  assert.equal(page.run("autoRefundNotice({ error: 'unknown_house' }).error"), true);
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const body = src.slice(src.indexOf('async function dischargePatient('), src.indexOf('function autoRefundNotice('));
  assert.ok(!/showCreditsModal\(/.test(body), 'the decision modal is gone from the discharge flow');
  assert.ok(!/fetchRefundSuggestions|action: 'suggestRefunds'/.test(src), 'the client never asks for a suggestion to decide on');
});
