'use strict';
/* CHANGELOG-cancel-refund.md — «בטל זיכוי»: Vered (and Sandra) cancel a pending refund —
 * saved, or still only computed by policy — with a required reason. Synthetic names. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../public/crm/crm.js');
const scope = require('../lib/finance-scope');
const roleScope = require('../lib/role-scope');
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const VERED = { user: 'ורד', view: 'full', finance: true, deleter: true };
const SANDRA = { user: 'סנדרה', view: 'full', finance: true, deleter: true, approver: true };
const ORTAL = { user: 'אורטל', view: 'controller', finance: false, deleter: false, billingRead: true };
const DANA = { user: 'דנה', view: 'ops', finance: false, deleter: false };

test('who may cancel: finance + deleter (Vered, Sandra); never the controller or the ops view', () => {
  assert.equal(core.canCancelRefund(VERED), true); assert.equal(core.canCancelRefund(SANDRA), true);
  assert.equal(core.canCancelRefund(ORTAL), false); assert.equal(core.canCancelRefund(DANA), false);
  assert.equal(core.canCancelRefund({ finance: true, deleter: 'yes' }), false, 'only a literal true');
  assert.equal(core.canCancelRefund({ finance: true, deleter: true, view: 'controller' }), false);
  assert.equal(core.canCancelRefund(null), false);
  assert.ok(scope.FINANCE_ACTIONS.includes('cancelRefund')); assert.ok(roleScope.DELETE_ACTIONS.includes('cancelRefund'));
  assert.ok(!scope.CONTROLLER_ACTIONS.includes('cancelRefund'), 'Ortal pays refunds, she does not cancel them');
});

test('the target: a saved refund by its id; a computed one by stay + type + month; nothing otherwise', () => {
  assert.deepEqual(core.cancelRefundTarget({ id: 'credit::p1::2026-10::1', credit: { id: 'credit::p1::2026-10::1' }, auto: false }), { creditId: 'credit::p1::2026-10::1' });
  assert.deepEqual(core.cancelRefundTarget({ id: 'credit::p2::2026-10::1', auto: false }), { creditId: 'credit::p2::2026-10::1' });
  assert.deepEqual(core.cancelRefundTarget({ id: '', auto: true, patientKey: 'ramot::דנה כהן::2026-09-01', creditType: 'days_unused', allocationMonth: '2026-10' }),
    { patientKey: 'ramot::דנה כהן::2026-09-01', creditType: 'days_unused', allocationMonth: '2026-10' });
  assert.equal(core.cancelRefundTarget({ auto: true, patientKey: '', creditType: 'days_unused', allocationMonth: '2026-10' }), null);
  assert.equal(core.cancelRefundTarget({ auto: true, patientKey: 'k', creditType: 'days_unused', allocationMonth: '2026-13' }), null);
  assert.equal(core.cancelRefundTarget(null), null);
});

test('a reason is required; the body carries the target and the cleaned reason only', () => {
  assert.deepEqual(core.cancelRefundErrors({ reason: '' }), { reason: 'חובה לכתוב למה הזיכוי מבוטל' });
  assert.deepEqual(core.cancelRefundErrors({ reason: ' א ' }), { reason: 'חובה לכתוב למה הזיכוי מבוטל' });
  assert.ok(core.cancelRefundErrors({ reason: 'x'.repeat(301) }).reason);
  assert.deepEqual(core.cancelRefundErrors({ reason: 'שולם בהעברה ישירה' }), {});
  assert.deepEqual(core.cancelRefundBody({ creditId: 'c1' }, '  סוכם עם המשפחה\n'), { action: 'cancelRefund', creditId: 'c1', reason: 'סוכם עם המשפחה' });
  assert.equal(core.cancelRefundBody(null, 'x'), null);
});

test('proof: ok + a cancelled credit (the same id for a saved row); refusals in Hebrew', () => {
  assert.equal(core.cancelRefundAccepted({ ok: true, credit: { id: 'c1', status: 'cancelled' } }, { creditId: 'c1' }), true);
  assert.equal(core.cancelRefundAccepted({ ok: true, credit: { id: 'c2', status: 'cancelled' } }, { creditId: 'c1' }), false, 'another credit');
  assert.equal(core.cancelRefundAccepted({ ok: true, credit: { id: 'new1', status: 'cancelled' } }, { patientKey: 'k', creditType: 't', allocationMonth: '2026-10' }), true, 'a computed row gets its id from the server');
  assert.equal(core.cancelRefundAccepted({ ok: true, credit: { id: 'c1', status: 'pending' } }, { creditId: 'c1' }), false);
  assert.equal(core.cancelRefundAccepted({ ok: true }, { creditId: 'c1' }), false);
  assert.equal(core.cancelRefundAccepted({ ok: false, error: 'forbidden_role' }, { creditId: 'c1' }), false);
  assert.equal(core.cancelRefundRefusal({ ok: false, error: 'not_pending' }), 'הזיכוי כבר שולם או נסגר — אי אפשר לבטל');
  assert.equal(core.cancelRefundRefusal({ ok: false, error: 'forbidden_role' }), 'אין הרשאה לבטל זיכוי');
  assert.match(core.cancelRefundRefusal({ ok: false, error: 'odd' }), /odd/);
});

/* ---- the server function, run against a fake sheet ---- */
function server(credit, actor) {
  const start = GS.indexOf('const CANCEL_REFUND_REASON_MIN = 2;'), end = GS.indexOf('/* action=approveRefundException — the ONLY way');
  assert.ok(start > 0 && end > start);
  const written = [], audit = [];
  const box = {
    creditStr_: (v, n) => String(v == null ? '' : v).trim().slice(0, n),
    actingUser_: () => actor,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    lockBusy_: () => ({ ok: false, error: 'lock_busy' }),
    refundTargetLocked_: (p) => (credit ? { ok: true, sh: {}, row: 7, credit } : { ok: false, error: 'unknown_credit' }),
    refundPayoutClearApproval_: (r) => { r.payoutApprovalRequestedAt = ''; r.payoutApprovalRequestedBy = ''; r.payoutApprovalAmount = ''; r.payoutApprovedAt = ''; r.payoutApprovedBy = ''; },
    writeCreditRow_: (sh, row, out) => written.push({ row, out }),
    logAudit_: (...a) => audit.push(a),
  };
  vm.createContext(box);
  vm.runInContext(GS.slice(start, end), box);
  return { run: (params) => vm.runInContext('cancelRefund_', box)(params, 'ורד'), written, audit };
}
const veredActor = { verified: true, auth: 'personal', id: 'vered', roles: ['staff', 'reporter', 'deleter'] };
const pending = () => ({ id: 'c1', patientId: 'p1', patientName: 'דנה כהן', status: 'pending', amount: 1200, calculatedAmount: 1200, notes: 'הערה קודמת', payoutApprovalRequestedAt: '2026-11-10T08:00:00Z', payoutApprovalRequestedBy: 'vered', payoutApprovalAmount: 1200, payoutApprovedAt: '', payoutApprovedBy: '' });

test('Code.gs cancelRefund_: a pending refund becomes «cancelled» — kept, reasoned, stamped, its payout request cleared', () => {
  const s = server(pending(), veredActor);
  const res = s.run({ creditId: 'c1', reason: 'שולם ישירות למשפחה' });
  assert.equal(res.ok, true); assert.deepEqual([res.credit.id, res.credit.status], ['c1', 'cancelled']);
  assert.ok(!('amount' in res.credit) && !('notes' in res.credit), 'no money and no free text in the answer');
  assert.equal(s.written.length, 1);
  const out = s.written[0].out;
  assert.deepEqual([s.written[0].row, out.status, out.amount, out.calculatedAmount], [7, 'cancelled', 1200, 1200], 'the amounts are untouched — the row is a record, not a deletion');
  assert.equal(out.notes, 'הערה קודמת · בוטל: שולם ישירות למשפחה');
  assert.deepEqual([out.payoutApprovalRequestedAt, out.payoutApprovalRequestedBy, out.payoutApprovalAmount], ['', '', '']);
  assert.equal(out.updatedBy, 'ורד');
  assert.deepEqual([s.audit[0][0], s.audit[0][1]], ['credit_cancelled', 'cancelRefund_']);
});

test('Code.gs cancelRefund_: refusals write nothing — no deleter role, no reason, a paid refund, an unknown row; a repeat is a no-op', () => {
  for (const actor of [{ verified: true, auth: 'personal', id: 'ortal', roles: ['controller', 'accountant'] }, { verified: false, auth: 'personal', id: 'vered', roles: ['deleter'] }, { verified: true, auth: 'shared', id: 'vered', roles: ['deleter'] }]) {
    const s = server(pending(), actor);
    assert.equal(s.run({ creditId: 'c1', reason: 'סיבה טובה' }).error, 'forbidden_role'); assert.equal(s.written.length, 0);
  }
  let s = server(pending(), veredActor);
  assert.equal(s.run({ creditId: 'c1', reason: ' ' }).error, 'reason_required');
  assert.equal(s.run({ creditId: 'c1', reason: 'x'.repeat(301) }).error, 'reason_too_long');
  assert.equal(s.written.length, 0);
  s = server(Object.assign(pending(), { status: 'paid' }), veredActor);
  assert.equal(s.run({ creditId: 'c1', reason: 'סיבה טובה' }).error, 'not_pending'); assert.equal(s.written.length, 0, 'a paid refund is never cancelled');
  s = server(null, veredActor);
  assert.equal(s.run({ creditId: 'nope', reason: 'סיבה טובה' }).error, 'unknown_credit');
  s = server(Object.assign(pending(), { status: 'cancelled' }), veredActor);
  const again = s.run({ creditId: 'c1', reason: 'סיבה טובה' });
  assert.deepEqual([again.ok, again.replayed, s.written.length], [true, true, 0]);
  // a formula-looking reason is defused before it reaches the sheet
  s = server(pending(), veredActor);
  s.run({ creditId: 'c1', reason: '=HYPERLINK("x")' });
  assert.equal(s.written[0].out.notes, 'הערה קודמת · בוטל: HYPERLINK("x")');
});

test('wiring: dispatched, on the role lists, in the known-actions list; the CRM button is gated and escaped', () => {
  assert.match(GS, /if \(action === 'cancelRefund'\) return jsonOut_\(cancelRefund_\(params, requestUser_\(params\)\)\);/);
  for (const list of ['DELETE_ACTIONS', 'FINANCE_ACTIONS', 'PROXY_KNOWN_ACTIONS']) {
    const i = GS.indexOf('const ' + list + ' = ['), body = GS.slice(i, GS.indexOf('];', i));
    assert.ok(body.includes("'cancelRefund'"), list);
  }
  const ctl = GS.slice(GS.indexOf('const CONTROLLER_ACTIONS = ['), GS.indexOf('];', GS.indexOf('const CONTROLLER_ACTIONS = [')));
  assert.ok(!ctl.includes('cancelRefund'));
  assert.match(SRC, /canCancelRefund\(state\.me\) && cancelRefundTarget\(r\) \? ' <button type="button" class="btn small" data-refund-void="' \+ i \+ '">בטל זיכוי<\/button>'/);
  const open = SRC.slice(SRC.indexOf('function openCancelRefund(index)'), SRC.indexOf('function submitCancelRefund(form)'));
  assert.match(open, /if \(!canCancelRefund\(state\.me\) \|\| !state\.billing\) return/);
  assert.ok(open.includes("esc(r.name)"));
  const submit = SRC.slice(SRC.indexOf('function submitCancelRefund(form)'), SRC.indexOf('function submitRefundAction(form)'));
  assert.match(submit, /if \(!requireFreshBilling\(\)\) return/, 'never on unverified billing answers');
  assert.match(submit, /resetBilling\(\['debt', 'credits', 'refunds'\]\)/);
});
