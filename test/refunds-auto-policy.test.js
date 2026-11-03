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
const SHIRAN = () => actor('shiran', 'שירן', ['staff', 'reporter'], []);
const YAEL = () => actor('yael', 'יעל', ['staff', 'reporter'], []);

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

test('settleRefund: a computed policy row first needs Vered request + Sandra signoff, then Ortal records payment once', () => {
  const w = world();
  const entry = '2026-09-01';
  w.payment('sde', entry, entry, 30000);
  w.discharged({ houseId: 'sde', date: entry, exitDate: '2026-09-10' });
  const row = w.call({ action: 'refundPayoutForecast' }).toPay.rows[0];
  const target = { patientKey: row.patientKey, creditType: row.creditType, allocationMonth: row.allocationMonth };
  assert.equal(w.call(Object.assign({ action: 'settleRefund', paidDate: '2026-10-01', method: 'העברה' }, target), ORTAL).error, 'approval_required');
  assert.equal(w.S.Credits, undefined, 'a premature settle never creates a credit');
  const requested = w.call({ action: 'requestRefundPayoutApproval', ...target }, VERED);
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const creditId = requested.credit.id;
  assert.equal(w.call({ action:'settleRefund',creditId,paidDate:'2026-10-01',method:'העברה' },ORTAL).error,'approval_required');
  assert.equal(w.call({ action:'approveRefundPayout',creditId },SANDRA).ok,true);
  const paid = w.call({ action:'settleRefund',creditId,paidDate:'2026-10-01',method:'=HYPERLINK("x")',
    amount:99999,calculatedAmount:99999 },ORTAL);
  assert.equal(paid.ok,true,JSON.stringify(paid));
  assert.deepEqual(Object.keys(paid.credit).sort(), ['id','paidDate','status','updatedAt']);
  const c=w.credits();
  assert.deepEqual(c.map(x=>[x.status,x.paidDate,x.amount,x.calculatedAmount,x.approvedBy,x.payoutApprovedBy]),
    [['paid','2026-10-01',20000,20000,'מדיניות אוטומטית','sandra']]);
  assert.ok(!/^[=+\-@]/.test(c[0].method));
  assert.equal(w.call({action:'refundPayoutForecast'}).toPay.count,0);
  assert.equal(w.call({action:'settleRefund',creditId,paidDate:'2026-10-01',method:'x'},ORTAL).error,'not_pending');
  assert.ok(arr(w.g.run('PROXY_KNOWN_ACTIONS')).includes('requestRefundPayoutApproval'));
  assert.ok(arr(w.g.run('PROXY_KNOWN_ACTIONS')).includes('approveRefundPayout'));
});

/* ---- «סמן כשולם» permissions: Vered, Ortal, Sandra yes; Shiran, Yael no ---- */

test('settleRefund permissions (Code.gs): only Ortal may pay an approved credit; Vered and Sandra must not pay', () => {
  for (const [who, fn, allowed] of [['vered',VERED,false],['ortal',ORTAL,true],['sandra',SANDRA,false],['shiran',SHIRAN,false],['yael',YAEL,false]]) {
    const w=world(),entry='2026-09-01';
    w.payment('rehab',entry,entry,30000);
    w.discharged({houseId:'rehab',date:entry,exitDate:'2026-09-10'});
    const row=w.call({action:'refundPayoutForecast'},SANDRA).toPay.rows[0];
    const target={patientKey:row.patientKey,creditType:row.creditType,allocationMonth:row.allocationMonth};
    const req=w.call({action:'requestRefundPayoutApproval',...target},VERED);
    assert.equal(req.ok,true);
    const creditId=req.credit.id;
    assert.equal(w.call({action:'approveRefundPayout',creditId},SANDRA).ok,true);
    const before=JSON.stringify(w.credits());
    const r=w.call({action:'settleRefund',creditId,paidDate:'2026-10-01',method:'העברה'},fn);
    if(allowed) { assert.equal(r.ok,true,who+' '+JSON.stringify(r));assert.deepEqual(w.credits().map(x=>x.status),['paid']); }
    else {
      assert.equal(r.ok,false,who);
      assert.equal(r.error, who==='shiran'||who==='yael'?'forbidden':'forbidden_role',who);
      assert.equal(JSON.stringify(w.credits()),before,'denied payout has no side effects');
    }
  }
  assert.ok(financeScope.FINANCE_ACTIONS.includes('settleRefund'));
  assert.ok(financeScope.CONTROLLER_ACTIONS.includes('settleRefund'));
  const g=loadGs({});
  assert.deepEqual(arr(g.run('FINANCE_ACTIONS')),[...financeScope.FINANCE_ACTIONS]);
  assert.deepEqual(arr(g.run('CONTROLLER_ACTIONS')),[...financeScope.CONTROLLER_ACTIONS]);
  assert.ok(!financeScope.CONTROLLER_ACTIONS.includes('approveRefundPayout'));
  assert.ok(!financeScope.CONTROLLER_ACTIONS.includes('approveRefundException'));
});

/* server.js (the first lock): the same decision from the signed session cookie. */
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const SESSION_SECRET = 'session-secret-TEST-refunds-auto-policy-0123456789';
const PEPPER = 'pepper-TEST-refunds-auto-policy-a1b2c3d4e5f60718293a4b5';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
const cookieFor = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

async function withServer(fn) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs) };
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
  const srv = await new Promise((resolve) => { const s2 = mod.app.listen(0, '127.0.0.1', () => resolve(s2)); });
  try { return await fn(srv.address().port, calls); } finally {
    srv.close(); https.request = original; Object.assign(console, orig);
  }
}
function post(port, body, cookie) {
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

test('settleRefund permissions (Express): only Ortal is proxied; Vered can request, Sandra can approve', async () => {
  await withServer(async (port, calls) => {
    const settle={action:'settleRefund',creditId:'credit::p::2026-09::1',paidDate:'2026-10-01',method:'העברה'};
    for(const id of ['shiran','yael','vered','sandra'])
      assert.equal((await post(port,settle,cookieFor(id))).status,403,id);
    assert.equal(calls.length,0);
    assert.equal((await post(port,settle,cookieFor('ortal'))).status,200);
    assert.deepEqual(calls.map(c=>c.proxyUserId),['ortal']);
    const request={action:'requestRefundPayoutApproval',creditId:'credit::p::2026-09::1'};
    for(const id of ['sandra','ortal','shiran','yael'])
      assert.equal((await post(port,request,cookieFor(id))).status,403,id+' request');
    assert.equal((await post(port,request,cookieFor('vered'))).status,200);
    const approve={action:'approveRefundPayout',creditId:'credit::p::2026-09::1'};
    for(const id of ['vered','ortal','shiran','yael'])
      assert.equal((await post(port,approve,cookieFor(id))).status,403,id+' approval');
    assert.equal((await post(port,approve,cookieFor('sandra'))).status,200);
    assert.deepEqual(calls.map(c=>c.proxyUserId),['ortal','vered','sandra']);
    const ex={action:'approveRefundException',creditId:'credit::p::2026-09::1',amount:0,reason:'סיבה'};
    for(const id of ['vered','ortal','shiran','yael'])
      assert.equal((await post(port,ex,cookieFor(id))).status,403,id);
    assert.equal((await post(port,ex,cookieFor('sandra'))).status,200);
  });
});

/* ---- saving from the browser: the server recalculates the policy figure ---- */

function savedStay(houseId) {
  const w = world();
  const entry = '2026-09-01';
  w.payment(houseId, entry, entry, 30000);
  w.discharged({ houseId, date: entry, exitDate: '2026-09-10' });   // old rule, day 10 → 20 days × ₪1,000
  const line = { patientId: 'p1', patientKey: w.key(houseId, entry), patientName: NAME, houseId, creditType: 'days_unused', allocationMonth: '2026-09' };
  return { w, line };
}

test('policy-matching save from the browser: Vered saves the policy amount with NO approval — the server recalculates it and keeps its own figure, trail and dates', () => {
  const { w, line } = savedStay('rehab');
  // The client claims a different policy figure / basis / label: ignored.
  const r = w.call({ action: 'saveCredit', credit: Object.assign({}, line, {
    amount: 20000, calculatedAmount: 5, basis: { rule: 'prepaid_return', basisVersion: 2 }, reason: 'מזויף', approvedBy: 'סנדרה', decidedDate: '2026-12-31',
  }) }, VERED);
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = w.credits()[0];
  assert.deepEqual([c.amount, c.calculatedAmount, c.overrideReason, c.approvedBy, c.decidedDate, c.payoutDate],
    [20000, 20000, '', 'מדיניות אוטומטית', '2026-09-10', '2026-09-15']);
  assert.equal(JSON.parse(c.basis).rule, 'detox_prorata', 'the server\'s basis, not the client\'s');
  assert.match(c.reason, /^אוטומטי לפי מדיניות/);
  // The amount omitted → the server's figure, still no approval.
  const { w: w2, line: l2 } = savedStay('asher');
  assert.equal(w2.call({ action: 'saveCredit', credit: l2 }, VERED).ok, true);
  assert.equal(w2.credits()[0].amount, 20000);
});

test('a different amount, or a manual credit, needs Sandra\'s approver session AND a reason — whatever the client calls it', () => {
  const { w, line } = savedStay('pardes');
  // Vered: a different amount, even if she also sends calculatedAmount equal to it ("policy" label) → refused.
  const forged = w.call({ action: 'saveCredit', credit: Object.assign({}, line, { amount: 25000, calculatedAmount: 25000 }) }, VERED);
  assert.equal(forged.error, 'override_requires_approver');
  // A rule line the policy does not have (no such month) → not policy → refused.
  assert.equal(w.call({ action: 'saveCredit', credit: Object.assign({}, line, { allocationMonth: '2026-11', amount: 20000, calculatedAmount: 20000 }) }, VERED).error,
    'override_requires_approver');
  // A manual credit → refused up front for Vered (server.js + handle_), and for Ortal.
  const manual = Object.assign({}, line, { creditType: 'other', amount: 500, reason: 'פיצוי' });
  assert.equal(w.call({ action: 'saveCredit', credit: manual }, VERED).error, 'forbidden_role');
  assert.equal(w.call({ action: 'saveCredit', credit: manual }, ORTAL).error, 'forbidden');
  assert.equal(w.credits().length, 0, 'no row written by any refusal');
  // Sandra without a reason → refused; with one → saved, the policy figure kept beside it.
  assert.equal(w.call({ action: 'saveCredit', credit: Object.assign({}, line, { amount: 25000 }) }, SANDRA).error, 'override_reason_required');
  const ok = w.call({ action: 'saveCredit', credit: Object.assign({}, line, { amount: 25000, overrideReason: 'הסכם מיוחד' }) }, SANDRA);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const c = w.credits()[0];
  assert.deepEqual([c.amount, c.calculatedAmount, c.overrideReason, c.approvedBy], [25000, 20000, 'הסכם מיוחד', 'סנדרה']);
  // Sandra's manual credit: its policy figure is 0, its reason is the override reason.
  const m = w.call({ action: 'saveCredit', credit: Object.assign({}, manual, { allocationMonth: '2026-10' }) }, SANDRA);
  assert.equal(m.ok, true, JSON.stringify(m));
  const mc = w.credits().find((x) => x.creditType === 'other');
  assert.deepEqual([mc.amount, mc.calculatedAmount, mc.overrideReason], [500, 0, 'פיצוי']);
  assert.deepEqual(JSON.parse(mc.basis), { manual: true });
});

test('editing a saved refund\'s amount: back to the recalculated policy figure needs no approval; any other amount needs Sandra', () => {
  const { w, line } = savedStay('ramot');
  w.call({ action: 'saveCredit', credit: Object.assign({}, line, { amount: 25000, overrideReason: 'הסכם' }) }, SANDRA);
  let c = w.credits()[0];
  assert.equal(w.call({ action: 'saveCredit', credit: { id: c.id, updatedAt: c.updatedAt, amount: 22000 } }, VERED).error, 'override_requires_approver');
  const back = w.call({ action: 'saveCredit', credit: { id: c.id, updatedAt: c.updatedAt, amount: 20000 } }, VERED);
  assert.equal(back.ok, true, JSON.stringify(back));
  c = w.credits()[0];
  assert.deepEqual([c.amount, c.calculatedAmount, c.overrideReason], [20000, 20000, '']);
});

test('Ortal sees the whole list: every row column, totals by payment date and the grand total — the reason for leaving as the disposition only, never free text', () => {
  const w = world();
  const entry = '2026-10-08';
  const NOTE = 'הערה חופשית רגישה על השחרור';
  w.payment('rehab', entry, entry, 30000);
  w.call({ action: 'dischargePatient', patient: { id: 'aud-1', houseId: 'rehab', name: NAME, date: entry, exitDate: '2026-10-20', status: 'released', disposition: 'stopped_early', discharge_note: NOTE } });
  const raw = w.call({ action: 'refundPayoutForecast' }, SANDRA);
  assert.equal(raw.toPay.rows[0].dischargeNote, NOTE, 'Sandra / Vered still read the note');
  const f = w.call({ action: 'refundPayoutForecast' }, ORTAL);
  assert.equal(f.ok, true);
  assert.deepEqual(f.toPay.byPayoutDate, [{ payoutDate: '2026-11-15', count: 1, total: 18000 }]);
  assert.deepEqual([f.toPay.count, f.toPay.total], [1, 18000]);
  const r = f.toPay.rows[0];
  assert.deepEqual([r.patientName, r.houseId, r.totalPaid, r.entryDate, r.exitDate, r.disposition, r.daysStayed, r.refundDays, r.amount, r.ruleVersion, r.payoutDate],
    [NAME, 'rehab', 30000, entry, '2026-10-20', 'stopped_early', 13, 18, 18000, 2, '2026-11-15']);
  assert.ok(!('dischargeNote' in r), 'no dischargeNote field for Ortal');
  assert.ok(!JSON.stringify(f).includes(NOTE), 'the free text reaches her nowhere');
  assert.ok(!JSON.stringify(f).includes('overrideReason'));
  // The same cut on the server.js side (lib) — both schemas in step, no note.
  assert.ok(!financeScope.CONTROLLER_FORECAST_SCHEMA.toPay.rows.includes('dischargeNote'));
  assert.deepEqual(arr(w.g.run('CONTROLLER_FORECAST_ROW_FIELDS_')), [...financeScope.CONTROLLER_FORECAST_SCHEMA.toPay.rows]);
  const viaLib = financeScope.controllerResponseView('refundPayoutForecast', raw);
  assert.ok(!JSON.stringify(viaLib).includes(NOTE));
  // On her screen the reason for leaving is the label: «הפסיק לפני הזמן».
  const page = loadPage({});
  page.run('globalThis.__r = ' + JSON.stringify(r));
  assert.equal(page.run('refundLeaveReasonText(__r)'), 'הפסיק לפני הזמן');
  for (const [k, label] of [['completed', 'סיים טיפול'], ['stopped_early', 'הפסיק לפני הזמן'], ['not_relevant', 'לא רלוונטי']]) {
    assert.equal(page.run(`refundLeaveReasonText({ disposition: '${k}' })`), label, k);
  }
});

/* ===================== 7. the screen ===================== */

test('screen: payout list keeps totals and uses role- and approval-specific actions, not implicit automatic approval', () => {
  const page = loadPage({});
  const data={ok:true,toPay:{count:2,total:21000,byPayoutDate:[{payoutDate:'2026-11-15',count:2,total:21000}],rows:[
    {creditId:'c1',auto:false,patientName:'<img src=x onerror=1>',houseId:'rehab',totalPaid:30000,
      entryDate:'2026-10-08',exitDate:'2026-10-20',disposition:'stopped_early',dischargeNote:'<b>עזב</b>',
      daysStayed:13,refundDays:18,amount:18000,calculatedAmount:18000,overridden:false,
      ruleVersion:2,rule:'stay_prorata',creditType:'days_unused',allocationMonth:'2026-10',
      payoutDate:'2026-11-15',payoutApprovalRequestedBy:'vered',payoutApprovalValid:true},
    {creditId:'',auto:true,patientName:'ב',houseId:'asher',totalPaid:3000,entryDate:'2026-09-01',
      exitDate:'2026-09-28',disposition:'completed',dischargeNote:'',daysStayed:28,refundDays:3,
      amount:3000,calculatedAmount:3000,overridden:false,ruleVersion:1,rule:'residential_prorata',
      creditType:'days_unused',allocationMonth:'2026-09',payoutDate:'2026-11-15'},
  ]},missing_payment_data:{count:0,rows:[]},unresolved:{count:0,rows:[]}};
  page.run('globalThis.__d = '+JSON.stringify(data));
  const html=page.run('payoutForecastHtml(__d,{request:true,approve:true,settle:true,exception:false})');
  assert.match(html,/refund-totals-table/);
  assert.match(html,/<tr class="refund-grand-total"><th>סה"כ<\/th><th>2<\/th>/);
  for(const label of ['מטופל','בית','סה"כ שולם','כניסה','יציאה','סיבת עזיבה','ימי שהייה','ימי זיכוי','סכום זיכוי','כלל','תאריך תשלום','אישור לתשלום'])
    assert.ok(html.includes('<span class="p-label">'+label+'</span>'),label);
  assert.ok(html.includes('הפסיק לפני הזמן — &lt;b&gt;עזב&lt;/b&gt;'));
  assert.ok(!html.includes('<img src=x')&&!html.includes('<b>עזב'));
  assert.ok(html.includes('חדש (אחיד)')&&html.includes('ישן (לפי בית)'));
  assert.equal((html.match(/data-refund-action="settle"/g)||[]).length,1,'only approved row can be paid');
  assert.equal((html.match(/data-refund-action="request"/g)||[]).length,1,'computed row needs request first');
  assert.ok(!html.includes('data-refund-action="exception"'));
  const ro=page.run('payoutForecastHtml(__d,{request:false,approve:false,settle:false,exception:false})');
  assert.ok(!ro.includes('data-refund-action'),'read-only has no write buttons');
  page.run("state.mode='edit';state.finance=true;state.view='';state.sessionUser='ורד';state.approver=false");
  assert.deepEqual(plain(page.run('refundRowControls()')),{request:true,approve:false,settle:false,exception:false});
  page.run("state.sessionUser='סנדרה';state.approver=true");
  assert.deepEqual(plain(page.run('refundRowControls()')),{request:false,approve:true,settle:false,exception:true});
  page.run("state.sessionUser='אורטל';state.view='controller';state.billingRead=true;state.mode='view'");
  assert.deepEqual(plain(page.run('refundRowControls()')),{request:false,approve:false,settle:true,exception:false});
  const html2=fs.readFileSync(path.join(ROOT,'public','index.html'),'utf8');
  assert.ok(!html2.includes('ממתין להחלטה')&&!html2.includes('credits-payout-list'));
  assert.equal((html2.match(/>זיכויים לתשלום </g)||[]).length,1);
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
