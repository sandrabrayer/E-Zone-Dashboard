import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptLeads, adaptContinuation, continuationKey, introDate } from '../../lib/crm/source-adapters.mjs';
import { assemble } from './queue-reference.mjs';

const now='2026-10-13T15:30:00Z',today='2026-10-13';
const observedAt='2026-10-13T15:29:00Z';
const input=(rows,extra={})=>({rows,observedAt,health:'fresh',complete:true,...extra});
const d={id:'synthetic-d-1',name:'דוגמה בלבד',stage:'new',assignedTo:'מבצעת דמה'};
const grant=(dataset,ids,extra={})=>({dataset,allowedIds:ids,showName:true,showAssignee:true,...extra});
const dg=grant('dashboard.leads',[d.id]);
const lead=(rows=[d],extra={})=>adaptLeads({dataset:'dashboard.leads',input:input(rows),access:dg,now,today,...extra});
const queue=(a,access=dg,previous=[])=>assemble({today,current:a.envelope?[a.envelope]:[],previous,access:[access]});
const p={name:'דוגמת המשך בדויה',house:'ramot',entryDate:'2026-10-01',phone:'must-not-leak'};
const key=continuationKey(p),cg=grant('outpatient.continuation',[key]);
const w={...p,key,meetingDate:'2026-10-10',outcome:'to_outpatient',updatedAt:'2026-10-13T15:00:00Z'};
const cont=(extra={})=>adaptContinuation({workflow:input([w]),roster:input([p]),access:cg,now,...extra});

test('no grant means no rows, source metadata or diagnostics, including malformed inputs',()=>{
 assert.deepEqual(lead(null,{access:null}),{envelope:null,diagnostics:[]});
 assert.deepEqual(cont({access:null,workflow:null}),{envelope:null,diagnostics:[]});
});
test('wrong dataset and empty grants are denied',()=>{
 assert.equal(lead([d],{access:cg}).envelope,null);
 assert.equal(lead([d],{access:grant('dashboard.leads',[])}).envelope,null);
});
for(const stage of ['new','visit','paid','waitlist','בטיפול פעיל','רשימת המתנה'])
test(`dashboard active source stage: ${stage}`,()=>{
 const q=queue(lead([{...d,stage}]));assert.equal(q.rows.length,1);assert.equal(q.rows[0].uncertainty,'none');
});
for(const stage of ['admitted','irrelevant','נקלט','לא רלוונטי'])
test(`explicit dashboard terminal stage closes only its lead reason: ${stage}`,()=>{
 const old=lead().envelope;assert.equal(queue(lead([{...d,stage}]),dg,[old]).rows.length,0);
});
for(const stage of ['entry','entered','', 'not-a-source-stage'])
test(`dashboard ambiguous/unknown stage is not invented as new or complete: ${stage}`,()=>{
 const q=queue(lead([{...d,stage}]));assert.equal(q.rows.length,1);assert.equal(q.rows[0].uncertainty,'unknown_status');
 assert.equal(q.rows[0].sourceStatus,'unrecognized');
});
test('source disappearance retains a previous source task as uncertain',()=>{
 const old=lead().envelope,q=queue(lead([]),dg,[old]);assert.equal(q.rows.length,1);assert.equal(q.rows[0].uncertainty,'not_seen_in_current_snapshot');
});
test('failed load is not a successful empty list and never accepts its response payload',()=>{
 const q=queue(lead([d],{input:input([{...d,stage:'admitted'}],{health:'unavailable'})}),dg,[lead().envelope]);
 assert.equal(q.rows.length,1);assert.equal(q.totals.incomplete,true);
});
test('stale and partial terminal snapshots cannot resolve a previous task',()=>{
 for(const meta of [{health:'stale'},{health:'partial'},{complete:false}]){
  const q=queue(lead([],{input:input([{...d,stage:'admitted'}],meta)}),dg,[lead().envelope]);
  assert.equal(q.rows.length,1);assert.equal(q.totals.incomplete,true);
 }
});
test('missing required stage is schema drift and does not fabricate an empty all-clear',()=>{
 const row={...d};delete row.stage;const a=lead([row]);
 assert.equal(a.envelope.health,'partial');assert.ok(a.diagnostics.includes('missing_or_invalid_required_field'));
 const q=queue(a,dg,[lead().envelope]);assert.equal(q.rows.length,1);assert.equal(q.totals.incomplete,true);
});
test('duplicates, including a malformed duplicate, quarantine instead of choosing array order',()=>{
 for(const second of [{...d,stage:'admitted'},{id:d.id}]){
  const a=lead([d,second]);assert.equal(a.envelope.records.length,0);assert.equal(a.envelope.complete,false);
  assert.ok(a.diagnostics.includes('duplicate_authorized_id'));assert.equal(queue(a,dg,[lead().envelope]).rows.length,1);
 }
});
test('unrelated unauthorized malformed rows do not leak diagnostics or break an authorized view',()=>{
 assert.deepEqual(lead([d,{id:'hidden'},{id:'hidden',stage:'admitted'}]),lead([d]));
});
test('unknown raw status, notes, phone, billing and clinical payload never reach output',()=>{
 const row={...d,stage:'private-secret',phone:'private-secret',note:'private-secret',meetingNote:'private-secret',diagnosis:'private-secret',paymentLink:'private-secret'};
 assert.ok(!JSON.stringify(lead([row])).includes('private-secret'));
});
test('field denial removes names and assignees before the queue and in the final output',()=>{
 const g={...dg,showName:false,showAssignee:false};const a=lead([d],{access:g});
 assert.equal(a.envelope.records[0].displayName,null);assert.equal(a.envelope.records[0].assignee,null);
 assert.ok(!JSON.stringify(queue(a,g)).includes(d.name));
});
test('a meeting date is an event and never an invented follow-up deadline',()=>{
 const q=queue(lead([{...d,visitDate:'2026-10-10'}]));assert.equal(q.rows.length,2);
 for(const r of q.rows){assert.equal(r.dueState,'missing');assert.equal(r.originalDueDate,null);assert.equal(r.eventState,'past');}
});
test('a valid report alone does not close both meeting result tracks',()=>{
 for(const result of [{meetingOutcome:'entered'},{meetingReportOutcome:'advancing'}]){
  const q=queue(lead([{...d,visitDate:'2026-10-10',...result}]));assert.ok(q.rows.some(r=>r.reason==='meeting_result'));
 }
});
test('both recorded results close meeting-result lookup only, without declaring attendance or transfer completion',()=>{
 const old=lead([{...d,visitDate:'2026-10-10'}]).envelope;
 const q=queue(lead([{...d,visitDate:'2026-10-10',meetingOutcome:'cancelled',meetingReportOutcome:'no_show'}]),dg,[old]);
 assert.equal(q.rows.length,1);assert.equal(q.rows[0].reason,'lead_followup');assert.equal(q.rows[0].personLink,'unknown');
});
test('admission does not silently close a missing meeting result',()=>{
 const q=queue(lead([{...d,stage:'admitted',visitDate:'2026-10-10'}]));assert.equal(q.rows.length,1);assert.equal(q.rows[0].reason,'meeting_result');
});
test('impossible event date remains invalid even with known results',()=>{
 const q=queue(lead([{...d,visitDate:'2026-02-30',meetingOutcome:'entered',meetingReportOutcome:'advancing'}]));
 assert.ok(q.rows.some(r=>r.reason==='meeting_result'&&r.eventState==='invalid'));
});
test('missing/future/invalid timestamp blocks source freshness and ignores response data',()=>{
 for(const time of [null,'2026-10-13T18:00:00','2026-10-14T00:00:00Z','2026-02-30T00:00:00Z','2026-10-12T24:00:00Z']){
  const a=lead([],{input:input([d],{observedAt:time})});assert.equal(a.envelope.health,'unavailable');assert.equal(a.envelope.records.length,0);
 }
});
test('dashboard created or ad-hoc updatedAt is not projected as a general source update',()=>{
 assert.equal(lead([{...d,created:observedAt,updatedAt:observedAt}]).envelope.records[0].sourceUpdatedAt,null);
});
for(const stage of ['פרטים אישיים','שיחת היכרות','תוכנית טיפול','הסכם נחתם','לא רלוונטי','new','לא מוכר'])
test(`outpatient stored stage is mapped explicitly: ${stage}`,()=>{
 const g=grant('outpatient.leads',['synthetic-o-1']);
 const a=adaptLeads({dataset:g.dataset,input:input([{id:g.allowedIds[0],stage,name:'בדוי',introDateTime:'2026-10-12T10:30',updatedAt:observedAt}]),access:g,now,today});
 const c=a.envelope.records[0];assert.equal(c.state,stage==='לא רלוונטי'?'resolved':['new','לא מוכר'].includes(stage)?'unknown':'active');
 assert.equal(c.eventDate,'2026-10-12');assert.equal(c.sourceUpdatedAt,observedAt);assert.equal(c.dueBasis,'unknown');
});
test('date conversion uses Jerusalem and rejects impossible dates and rollover hours',()=>{
 assert.equal(introDate('2026-10-12T22:30:00Z'),'2026-10-13');
 assert.equal(introDate('2026-10-12T10:30'),'2026-10-12');
 for(const value of ['2026-02-30T10:00','2026-10-12T24:00','2026-10-12T24:00:00Z','nonsense'])assert.equal(introDate(value),'invalid');
});
test('same ID/name/phone across apps never unifies people or tasks',()=>{
 const od=grant('outpatient.leads',[d.id]);const a=lead();
 const b=adaptLeads({dataset:od.dataset,input:input([{...d,stage:'פרטים אישיים'}]),access:od,now,today});
 const q=assemble({today,current:[a.envelope,b.envelope],access:[dg,od]});assert.equal(q.rows.length,2);assert.notEqual(q.rows[0].taskKey,q.rows[1].taskKey);
});
test('continuation key matches existing trim semantics and rejects ambiguous delimiters',()=>{
 assert.equal(continuationKey({...p,name:' '+p.name+' '}),key);
 assert.equal(continuationKey({...p,name:'A|B'}),null);assert.equal(continuationKey({...p,house:''}),null);
});
test('fresh complete workflow absence creates a decision task for an authorized roster entry',()=>{
 const q=queue(cont({workflow:input([])}),cg);assert.equal(q.rows.length,1);assert.equal(q.rows[0].reason,'continuation_decision');assert.equal(q.rows[0].identityCertainty,'unstable_source_key');
});
test('failed workflow load never invents blank outcomes from the roster',()=>{
 const a=cont({workflow:input([],{health:'unavailable'})});assert.equal(a.envelope.records.length,0);assert.equal(a.envelope.health,'unavailable');
});
test('incomplete/stale workflow absence cannot establish an undecided new workflow',()=>{
 for(const meta of [{complete:false},{health:'stale'},{health:'partial'}])assert.equal(cont({workflow:input([],meta)}).envelope.records.length,0);
});
test('to_outpatient asks for target acceptance instead of asserting completion',()=>{
 const q=queue(cont(),cg);assert.equal(q.rows.length,1);assert.equal(q.rows[0].reason,'destination_link_review');
 assert.equal(q.rows[0].personLink,'unknown');assert.equal(q.rows[0].contactPermission,'unknown');
});
test('continuing or stopping resolves only the decision, preserving any earlier target-link task',()=>{
 const old=cont().envelope;
 for(const outcome of ['continuing','stopping']){
  const q=queue(cont({workflow:input([{...w,outcome}])}),cg,[old]);assert.equal(q.rows.length,1);
  assert.equal(q.rows[0].reason,'destination_link_review');assert.equal(q.rows[0].uncertainty,'not_seen_in_current_snapshot');
 }
});
test('unknown continuation outcome is not silently reset to undecided',()=>{
 const q=queue(cont({workflow:input([{...w,outcome:'secret-invalid'}])}),cg);assert.equal(q.rows.length,1);assert.equal(q.rows[0].uncertainty,'unknown_status');
 assert.ok(!JSON.stringify(q).includes('secret-invalid'));
});
test('saved continuation state survives disappearance from active roster',()=>{
 const q=queue(cont({roster:input([])}),cg);assert.equal(q.rows.length,1);assert.equal(q.rows[0].reason,'destination_link_review');
});
test('roster outage leaves known workflow tasks visible but incomplete',()=>{
 const q=queue(cont({roster:input([],{health:'unavailable'})}),cg);assert.equal(q.totals.incomplete,true);
 assert.ok(q.rows.some(r=>r.reason==='destination_link_review'));
});
test('duplicate/malformed saved workflow is quarantined, never replaced with roster blank',()=>{
 for(const rows of [[w,{...w,outcome:'stopping'}],[{...p,key}]]){
  const a=cont({workflow:input(rows)});assert.equal(a.envelope.records.length,0);assert.equal(a.envelope.complete,false);
 }
});
test('duplicate roster key is quarantined even if saved workflow appears valid',()=>{
 const a=cont({roster:input([p,{...p}])});assert.equal(a.envelope.records.length,0);assert.ok(a.diagnostics.includes('duplicate_authorized_roster_key'));
});
test('hidden names in composite source keys are not included in rendered references',()=>{
 const g={...cg,showName:false};const q=queue(cont({access:g}),g);assert.equal(q.rows[0].sourceRef.nativeRecordId,null);
 assert.ok(!JSON.stringify(q).includes(p.name));assert.ok(!JSON.stringify(q).includes(p.phone));
});
test('permission removal also excludes previous candidates and their counts',()=>{
 const old=cont().envelope;const g={...cg,allowedIds:[]};const q=queue(cont({access:g}),g,[old]);
 assert.equal(q.rows.length,0);assert.deepEqual(q.sources,[]);
});
test('all transformations preserve supplied rows, metadata and permissions',()=>{
 const args={workflow:input([w]),roster:input([p]),access:cg,now};const before=structuredClone(args);
 adaptContinuation(args);assert.deepEqual(args,before);
 const args2={dataset:dg.dataset,input:input([d]),access:dg,now,today};const before2=structuredClone(args2);
 adaptLeads(args2);assert.deepEqual(args2,before2);
});
