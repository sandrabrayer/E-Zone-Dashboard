'use strict';
/* Refund payout must be explicitly requested by Vered, approved by Sandra
 * for the current amount, and executed only by Ortal. Uses the ACTUAL Apps
 * Script source in a Google-services VM, never production records. */
process.env.TZ = 'Asia/Jerusalem';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const roleScope = require('../lib/role-scope');
const financeScope = require('../lib/finance-scope');

const PROXY_SECRET = 'test-proxy-secret-ezone-payout-approval-0123456789';
const CKEY = 'credit::test-2026-10::1';
const ACTOR = {
  vered: ['ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']],
  sandra: ['סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']],
  ortal: ['אורטל', ['controller', 'accountant'], ['billingControl']],
  dana: ['דנה', ['staff'], []],
};
function auth(id, override) {
  const row = ACTOR[id];
  if (!row) throw Error('Unknown fixture identity');
  return Object.assign({
    proxySecret: PROXY_SECRET, proxyUser: row[0], user: row[0],
    proxyAuth: 'personal', proxyUserId: id,
    proxyRoles: row[1], proxyCaps: row[2],
  }, override || {});
}
function fixture() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const columns = Array.from(g.run('CREDIT_COLUMNS'));
  const saved = {
    id: CKEY, patientId: 'patient-abc', patientKey: 'ramot::dummy::2026-10-01',
    patientName: 'איש בדיקה', houseId: 'ramot', facilityType: 'residential',
    creditType: 'days_unused', allocationMonth: '2026-10', calculatedAmount: 3000,
    amount: 3000, overrideReason: '', reason: 'מדיניות', approvedBy: 'מדיניות אוטומטית',
    decidedDate: '2026-10-14', payoutDate: '2026-11-15', status: 'pending',
    paidDate: '', method: '', notes: '', basis: '{}', createdAt: '2026-10-14T10:00:00.000Z',
    createdBy: 'ורד', updatedAt: '2026-10-14T10:00:00.000Z', updatedBy: 'ורד',
    creditUid: 'crd-dummy',
  };
  const sh = richSheet('Credits', columns);
  sh.appendRow(columns.map(key => Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : ''));
  g.sandbox.__sheets.Credits = sh;
  const post = (action, who, props = {}) => JSON.parse(JSON.stringify(g.post({
    action, ...props, ...auth(who),
  })));
  const row = () => g.sheetRows('Credits', 'CREDIT_COLUMNS')[0];
  const snapshot = () => JSON.stringify(sh.grid);
  const request = () => post('requestRefundPayoutApproval', 'vered', { creditId: CKEY });
  const approve = () => post('approveRefundPayout', 'sandra', { creditId: CKEY });
  const pay = (who='ortal') => post('settleRefund', who, { creditId: CKEY, paidDate: '2026-11-03', method: 'העברה' });
  return {g,sh,post,row,snapshot,request,approve,pay};
}
test('identity gates require Vered to request, Sandra to approve, and Ortal to pay', () => {
  const actor = id => ({auth:'personal',id,roles:ACTOR[id][1]});
  for(const id of ['vered','sandra','ortal','dana']) {
    assert.equal(roleScope.roleAllowed(actor(id),'requestRefundPayoutApproval'),id==='vered',id+' request');
    assert.equal(roleScope.roleAllowed(actor(id),'approveRefundPayout'),id==='sandra',id+' approve');
    assert.equal(roleScope.roleAllowed(actor(id),'settleRefund'),id==='ortal',id+' pay');
  }
  assert.ok(financeScope.FINANCE_ACTIONS.includes('requestRefundPayoutApproval'));
  assert.ok(financeScope.FINANCE_ACTIONS.includes('approveRefundPayout'));
  assert.ok(financeScope.CONTROLLER_ACTIONS.includes('settleRefund'));
  assert.ok(!financeScope.CONTROLLER_ACTIONS.includes('approveRefundPayout'));
  assert.equal(roleScope.roleAllowed(actor('vered'),'setBillingDiscount'),true,
    'Vered may still grant cycle discounts');
});
test('no payout before request and approval: all failed actions leave credits unchanged', () => {
  const f=fixture(),before=f.snapshot();
  assert.equal(f.pay().error,'approval_required');
  assert.equal(f.approve().error,'request_required');
  assert.equal(f.snapshot(),before);
  for(const id of ['sandra','ortal','dana']) {
    assert.equal(f.post('requestRefundPayoutApproval',id,{creditId:CKEY}).ok,false,id);
    assert.equal(f.snapshot(),before);
  }
  for(const id of ['vered','ortal','dana']) {
    assert.equal(f.post('approveRefundPayout',id,{creditId:CKEY}).ok,false,id);
    assert.equal(f.snapshot(),before);
  }
});
test('policy auto-approver is NOT Sandra: Vered request -> Sandra approval -> Ortal payment', () => {
  const f=fixture();
  assert.equal(f.row().approvedBy,'מדיניות אוטומטית');
  const request=f.request();
  assert.equal(request.ok,true);
  const requested=f.row();
  assert.equal(requested.payoutApprovalRequestedBy,'vered');
  assert.equal(Number(requested.payoutApprovalAmount),3000);
  assert.ok(requested.payoutApprovalRequestedAt);
  assert.equal(requested.payoutApprovedBy,'');
  assert.equal(f.pay().error,'approval_required');
  const approved=f.approve();
  assert.equal(approved.ok,true);
  assert.equal(f.row().payoutApprovedBy,'sandra');
  assert.ok(f.row().payoutApprovedAt);
  for(const id of ['vered','sandra','dana']) assert.equal(f.pay(id).ok,false);
  const settlement=f.pay();
  assert.equal(settlement.ok,true,JSON.stringify(settlement));
  assert.equal(f.row().status,'paid');
  assert.equal(f.row().paidDate,'2026-11-03');
  assert.equal(f.pay().error,'not_pending');
});
test('retries of unchanged request or approval do not rewrite rows',()=>{
 const f=fixture();
 assert.equal(f.request().ok,true);
 let snap=f.snapshot();
 assert.equal(f.request().replayed,true);
 assert.equal(f.snapshot(),snap);
 assert.equal(f.approve().ok,true);
 snap=f.snapshot();
 assert.equal(f.approve().replayed,true);
 assert.equal(f.snapshot(),snap);
});
test('direct saveCredit paid/forged approvedBy cannot bypass approval', () => {
  const f=fixture(), before=f.snapshot();
  const p={id:CKEY,updatedAt:f.row().updatedAt,status:'paid',approvedBy:'סנדרה',paidDate:'2026-11-03',method:'העברה'};
  assert.equal(f.post('saveCredit','vered',{credit:p}).error,'use_settleRefund');
  assert.equal(f.snapshot(),before);
  assert.equal(f.post('saveCredit','sandra',{credit:p}).error,'use_settleRefund');
  assert.equal(f.snapshot(),before);
  const forged=Object.assign({},p,{status:'pending',paidDate:'',method:''});
  assert.equal(f.post('saveCredit','vered',{credit:forged}).ok,true);
  assert.notEqual(f.row().approvedBy,'סנדרה','free-text client approval is ignored');
  assert.equal(f.pay().error,'approval_required');
});
test('exception amount edit invalidates prior request and approval; requires new signature', () => {
  const f=fixture();
  assert.equal(f.request().ok,true);
  assert.equal(f.approve().ok,true);
  const ex=f.post('approveRefundException','sandra',{creditId:CKEY,amount:2500,reason:'אישור חריגה מסודר'});
  assert.equal(ex.ok,true,JSON.stringify(ex));
  const now=f.row();
  assert.equal(now.amount,2500);
  assert.equal(now.payoutApprovalRequestedBy,'');
  assert.equal(now.payoutApprovedBy,'');
  assert.equal(f.pay().error,'approval_required');
  assert.equal(f.request().ok,true);
  assert.equal(f.approve().ok,true);
  assert.equal(f.pay().ok,true);
});
test('forged identity/capabilities and an unset approval ID cannot make payment', () => {
 const f=fixture();
 assert.equal(f.post('requestRefundPayoutApproval','vered',{creditId:CKEY}).ok,true);
 assert.equal(f.post('approveRefundPayout','sandra',{creditId:CKEY}).ok,true);
 for (const id of ['vered','sandra','dana']) {
   const out=f.post('settleRefund',id,{creditId:CKEY,paidDate:'2026-11-03',method:'העברה',
    proxyUserId:'ortal',proxyRoles:['controller'],proxyCaps:['billingControl']});
   assert.notEqual(out.ok,true,id);
 }
 assert.equal(f.post('settleRefund','ortal',{patientKey:f.row().patientKey,
   creditType:'days_unused',allocationMonth:'2026-10',paidDate:'2026-11-03',method:'העברה'}).error,
   'approval_required','unkeyed computed row is not a payout approval');
});
