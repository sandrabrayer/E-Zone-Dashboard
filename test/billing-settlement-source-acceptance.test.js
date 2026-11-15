'use strict';
// Source-backed synthetic settlement acceptance: actual Code.gs handles writes,
// actual CRM computes the verification overlay from fresh source replies.
// No copied financial engine, no production identity, network or bank access.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {richSheet,loadGs} = require('./helpers/gs-sandbox');
const core = require('../public/crm/crm');
const plain = (x) => JSON.parse(JSON.stringify(x));
const ASOF = '2026-11-15';
const SECRET = 'synthetic-billing-settlement-acceptance-only-0123456789';
const NAME = 'בדיקת תשלום והנחה';
const KEY = 'arfoni::' + NAME + '::2026-11-01';
const PAT = {id:'synthetic-settlement-patient',houseId:'arfoni',name:NAME,date:'2026-11-01',pay:5000,status:'active'};
const CYCLE = {id:'pay::'+KEY+'::2026-11-01',patientId:KEY,patientName:NAME,houseId:'arfoni',dueDate:'2026-11-01',amount:5000};
function world() {
  const g=loadGs({props:{PROXY_SECRET:SECRET,PROXY_SECRET_MODE:'enforce'}});
  const S=g.sandbox.__sheets;
  const cols=Array.from(g.run('PATIENT_COLUMNS'));
  S.Patients=richSheet('Patients',cols);
  S.Patients.appendRow(cols.map(k=>PAT[k]===undefined?'':PAT[k]));
  S.Leads=richSheet('Leads',Array.from(g.run('LEAD_COLUMNS')));
  const actors={
    vered:{proxyUserId:'vered',proxyUser:'ורד',user:'ורד',proxyRoles:['staff','reporter','deleter'],proxyCaps:['finance','billingControl']},
    ortal:{proxyUserId:'ortal',proxyUser:'אורטל',user:'אורטל',proxyRoles:['controller','accountant'],proxyCaps:['billingControl']},
    sandra:{proxyUserId:'sandra',proxyUser:'סנדרה',user:'סנדרה',proxyRoles:['staff','deleter','approver','viewer'],proxyCaps:['finance','billingControl']}
  };
  const call=(body,who='vered')=>plain(g.post(Object.assign({},body,actors[who],{proxySecret:SECRET,proxyAuth:'personal'})));
  function report(amount,seq) {
    const r=call({action:'reportPayment',report:{cycle:CYCLE,report:{receivedDate:'2026-11-10',amount,method:'העברה בנקאית',payer:'משלם בדיקה',reference:'SYN-'+seq,funder:'פרטי',invoiceWanted:'no',coverageStart:'2026-11-01',coverageEnd:'2026-11-30'}}});
    assert.equal(r.ok,true,JSON.stringify(r));
    const rows=call({action:'getPayments'},'ortal').receipts;
    const found=rows.find(x=>x.reference==='SYN-'+seq);
    assert.ok(found,'source returns the newly reported exact receipt');
    return found.id;
  }
  function confirm(id,status,amount) {
    const c={ids:[id],status};
    if(amount!==undefined)c.confirmedAmount=amount;
    const r=call({action:'confirmPayment',confirm:c},'ortal');
    assert.equal(r.ok,true,JSON.stringify(r));
    return r;
  }
  function discount(amount,who='vered') {
    return call({action:'setBillingDiscount',discount:{patientId:KEY,month:'2026-11',discountAmount:amount,discountReason:'הנחה מפורשת לצורכי בדיקה'}},who);
  }
  function read(who='ortal') {
    const d=call({action:'debtAging',asOf:ASOF},who);
    const p=call({action:'getPayments'},who);
    assert.equal(d.ok,true,JSON.stringify(d));assert.equal(p.ok,true,JSON.stringify(p));
    return {d,p,collection:core.collectionDebtors(d,p,ASOF,'',null,[PAT]),account:core.patientAccount(PAT,d,p)};
  }
  const rows=()=>g.sheetRows('Payments','PAYMENT_COLUMNS');
  return {g,call,report,confirm,discount,read,rows};
}
function expectUnresolved(w,n,who) {
  const r=w.read(who);
  assert.equal(r.collection.ok,true);
  assert.equal(r.collection.total,n,'fresh CRM collection total from actual source');
  assert.equal(r.account.openTotal+r.account.unverifiedTotal,n,'account and collection agree');
  return r;
}

test('source: partial payment, partial verification, repeat, full receipt verification and remainder payment',()=>{
  const w=world(),id=w.report(2000,'one');
  let r=expectUnresolved(w,5000);
  assert.equal(r.account.openTotal,3000);assert.equal(r.account.unverifiedTotal,2000);
  w.confirm(id,'partial',1000);
  r=expectUnresolved(w,4000);
  assert.equal(r.account.openTotal,3000);assert.equal(r.account.unverifiedTotal,1000);
  w.confirm(id,'partial',1000);expectUnresolved(w,4000,'sandra');
  assert.equal(w.read().p.receipts.length,1,'repeat confirmation is not a receipt');
  w.confirm(id,'confirmed');expectUnresolved(w,3000,'vered');
  w.confirm(id,'confirmed');expectUnresolved(w,3000);
  assert.equal(w.read().p.receipts.length,1);
  const id2=w.report(3000,'two');expectUnresolved(w,3000);
  w.confirm(id2,'confirmed');expectUnresolved(w,0,'sandra');
  assert.equal(w.read().p.receipts.length,2,'only actual reports created receipts');
});

test('source: explicit 1000 discount plus 4000 payment against 5000 leaves zero after verification',()=>{
  const w=world(),id=w.report(4000,'discount');
  assert.equal(w.discount(1000).ok,true);
  let r=expectUnresolved(w,4000);
  assert.equal(r.account.openTotal,0,'discount removed only the unpaid balance');
  assert.equal(r.account.unverifiedTotal,4000,'received money still awaits bank verification');
  w.confirm(id,'confirmed');r=expectUnresolved(w,0,'vered');
  assert.equal(r.p.receipts.length,1);
  assert.equal(r.p.receipts.reduce((n,x)=>n+Number(x.amount),0),4000,'discount did not become money');
  assert.ok(w.g.sheetRows('BillingOverrides','BILLING_OVERRIDE_COLUMNS').some(x=>Number(x.discountAmount)===1000),'explicit discount retained in source');
  w.confirm(id,'confirmed');expectUnresolved(w,0,'sandra');
  assert.equal(w.read().p.receipts.length,1);
});

test('source: smaller discount preserves legitimate remainder through partial then full verification',()=>{
  const w=world(),id=w.report(4000,'part-discount');
  assert.equal(w.discount(500).ok,true);
  expectUnresolved(w,4500);
  w.confirm(id,'partial',1000);expectUnresolved(w,3500,'sandra');
  w.confirm(id,'confirmed');
  const r=expectUnresolved(w,500);
  assert.equal(r.account.openTotal,500);assert.equal(r.account.unverifiedTotal,0);
});

test('source: Ortal cannot turn unpaid remainder into a discount; invalid verification cannot close it',()=>{
  const w=world(),id=w.report(2000,'guard');
  const before=JSON.stringify(w.rows());
  assert.equal(w.discount(3000,'ortal').ok,false);
  for(const amount of [0,-1,2000,2001,1000.001]) {
    const r=w.call({action:'confirmPayment',confirm:{ids:[id],status:'partial',confirmedAmount:amount}},'ortal');
    assert.equal(r.ok,false,JSON.stringify({amount,r}));
  }
  assert.equal(JSON.stringify(w.rows()),before,'invalid inputs did not change source payment rows');
  expectUnresolved(w,5000);
});
