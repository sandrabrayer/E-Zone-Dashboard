'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDesk, PHONE, REF } = require('./helpers/contact-fixture');
const { richSheet } = require('./helpers/gs-sandbox');

function person(d, overrides = {}) {
  const cols = Array.from(d.g.run('PATIENT_COLUMNS'));
  const sh = d.g.sandbox.__sheets.Patients || (d.g.sandbox.__sheets.Patients = richSheet('Patients', cols));
  const r = Object.assign({ id:'person-at-house', name:'דוגמה לתרגול', houseId:'ramot', status:'active', date:'2020-01-01' },overrides);
  sh.appendRow(cols.map(c=>r[c] || ''));
  return sh;
}
function prior(d) {
  const at = new Date(Date.now()-3*86400000).toISOString();
  return d.staff('logContact',{submissionId:'sub-'+'7'.repeat(32),contact:{leadId:'test-card-a',channel:'phone',outcome:'spoke_follow_up',occurredAt:at,summary:'PRIVATE-NOTE'},
    next:{promises:[{code:'catalog',assignee:'ורד',dueDate:'2026-11-25'}]}});
}
function call(d,p,who='sandra') { return JSON.parse(JSON.stringify(d.staff('intakeContactDesk',p,who))); }
test('caller history on a current unique card combines manual and vendor time, withholds ambiguous identity and never links a lookup', () => {
  const d=makeDesk(); d.addLead(); assert.equal(prior(d).ok,true);
  const time=new Date(Date.now()-100).toISOString();
  const input={status:'ringing',occurredAt:time,observedAt:time};
  assert.equal(d.receive(input).ok,true); assert.equal(d.receive(input).ok,true);
  assert.deepEqual(call(d,{op:'signals'}).ids,['phone-'+REF]);
  assert.equal(call(d,{op:'lookup',eventId:'phone-'+REF}).match,'verify');
  const result=call(d,{op:'lookup',phone:'+972500000001',verified:true});
  assert.equal(result.match,'history'); assert.equal(result.prior.by,'ורד'); assert.equal(result.next.title,'לשלוח קטלוג');
  assert.equal(JSON.stringify(result).includes('PRIVATE-NOTE'),false); assert.equal(d.rows()[0].resolution,'pending');
  assert.equal(call(d,{op:'lookup',phone:'private',verified:true}).match,'unidentified');
  assert.equal(call(d,{op:'lookup',phone:'0500000777',verified:true}).match,'none');
  assert.equal(call(d,{op:'lookup',phone:PHONE,verified:true},'ortal').ok,false);
  d.addLead({id:'test-card-b',phone:'0500000111',contactPhone:PHONE});
  const shared=call(d,{op:'lookup',phone:PHONE,verified:true}); assert.deepEqual(shared,{ok:true,match:'review'});
});
test('saved per-number approval enables the foreground pop-up but a revoked grant or an archived match hides detail', () => {
  const d=makeDesk();d.addLead();prior(d);
  const earlier=new Date(Date.now()-600000).toISOString();
  d.receive({status:'answered',occurredAt:earlier,observedAt:earlier,agentKey:'vered'});
  assert.equal(d.link({remember:true}).ok,true);
  const at=new Date().toISOString(),ref='b'.repeat(32);
  d.receive({channel:'whatsapp',scope:'direct',status:'received',objectRef:ref,occurredAt:at,observedAt:at});
  const q={op:'lookup',eventId:'whatsapp-'+ref};
  const automatic=call(d,q);assert.equal(automatic.match,'history');assert.equal(automatic.prior.by,'ורד');
  assert.equal(automatic.prior.outcome,'שיחה שנענתה');
  assert.equal(d.staff('resolveCommunicationEvent',{id:'phone-'+REF,decision:'forget',leadId:'test-card-a'}).ok,true);
  assert.equal(call(d,q).match,'verify');
  d.addLead({id:'archive',phone:PHONE},'לידים לא רלוונטיים');
  assert.equal(call(d,{...q,verified:true}).match,'review');
});
test('family requests retain accountable handoff, distinguish relay and release, and recheck the current house', () => {
  const d=makeDesk(), sh=person(d), cols=Array.from(d.g.run('PATIENT_COLUMNS'));
  person(d,{id:'left',status:'released'});person(d,{id:'waiting',status:'wait'});
  assert.deepEqual(call(d,{op:'residents'}).residents.map(r=>r.id),['person-at-house']);
  const base={op:'create',requestId:'sub-'+'f'.repeat(32),kind:'information',channel:'whatsapp',phone:PHONE,owner:'vered',dueDate:'2026-11-25'};
  assert.equal(call(d,{...base,dueDate:'2026-02-31'}).error,'bad_input');
  assert.equal(call(d,base,'ortal').ok,false);assert.equal(call(d,base).request.state,'new');assert.equal(call(d,base).request.revision,1);
  assert.equal(call(d,{...base,kind:'message'}).error,'changed_request');
  const move={op:'advance',requestId:base.requestId,revision:1,to:'routed',patientId:'person-at-house',house:'ramot',confirmed:true};
  assert.equal(call(d,{...move,confirmed:false}).error,'bad_input');
  assert.equal(call(d,{...move,to:'answered',permissionVerified:true}).error,'bad_input');
  const routed=call(d,move,'vered').request; assert.equal(routed.routedBy,'vered');assert.equal(routed.house,'ramot');
  assert.equal(call(d,move).error,'changed_request');assert.equal(call(d,{...move,revision:2,to:'delivered'}).error,'bad_input');
  const answer={...move,revision:2,to:'answered'};
  assert.equal(call(d,answer).error,'check_permission');
  sh.getRange(2,cols.indexOf('houseId')+1).setValue('asher');
  assert.equal(call(d,{...answer,permissionVerified:true}).error,'check_resident');
  assert.equal(call(d,{...move,revision:2,house:'asher'}).request.house,'asher');
  const done=call(d,{...answer,revision:3,permissionVerified:true}).request;
  assert.equal(done.state,'answered');assert.equal(done.closedBy,'sandra');assert.equal(done.permissionCheckedAt,done.closedAt);
  const relay={...base,requestId:'sub-'+'e'.repeat(32),kind:'message'};
  call(d,relay);const relayMove={...move,requestId:relay.requestId,house:'asher'};
  call(d,relayMove);assert.equal(call(d,{...relayMove,revision:2,to:'answered',permissionVerified:true}).error,'bad_input');
  assert.equal(call(d,{...relayMove,revision:2,to:'delivered'}).request.state,'delivered');
  const requests=call(d,{op:'families'}).requests;assert.equal(requests.length,2);
  assert.equal(call(d,{op:'families'},'ortal').ok,false);
});
