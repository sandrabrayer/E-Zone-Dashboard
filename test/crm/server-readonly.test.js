'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const source = 'dashboard', dashboard = source === 'dashboard';
const sessionSecret = 'synthetic-session-secret';
Object.assign(process.env, {SESSION_SECRET:sessionSecret, APP_PIN:'817491', PROXY_SECRET:'proxy-fixture', CRM_READ_SECRET:'crm-fixture', OCCUPANCY_SECRET:'roster-fixture',
  CRM_READS:'1', SHEETS_URL:'https://script.google.com/macros/s/fixture/exec', DASHBOARD_SHEETS_URL:'https://script.google.com/macros/s/roster-fixture/exec'});
let helper;
if(dashboard) {
  test('queue screen and endpoints stay off by default under the real server identity gates',async()=>{
    for(const path of ['/api/crm/queue','/api/crm/queue/refresh','/crm-work','/crm-work/app.js']) {
      const method=path.endsWith('refresh')?'POST':'GET';
      assert.equal((await request(path,'',method)).status,401);
      assert.equal((await request(path,cookie,method)).status,503);
      assert.equal((await request(path,helper.personalCookie(sessionSecret,'ortal'),method)).status,403);
      assert.equal((await request(path,helper.personalCookie(sessionSecret,'sandra'),method)).status,403);
    } assert.equal(calls.length,0);
  });
  helper=require('../helpers/personal-session'); process.env.PIN_PEPPER=helper.TEST_PEPPER;
  const registry=JSON.parse(helper.userPinHashes(['sandra','vered','shiran','yael','ortal']));
  registry.find(r=>r.id==='yael').status='revoked';
  registry.find(r=>r.id==='sandra').roles=['viewer'];
  process.env.USER_PIN_HASHES=JSON.stringify(registry);
}
const {createSessionToken}=require('../../lib/session');
const cookie = dashboard ? helper.personalCookie(sessionSecret,'vered') : 'ezone_session='+createSessionToken(sessionSecret);
let calls=[], response, fail=false;
const originalFetch=global.fetch;
global.fetch=async (url,opts)=>{
  const body=opts.body?JSON.parse(opts.body):null; calls.push({url,opts,body});
  if(fail) throw Error('PRIVATE_SECRET_FROM_UPSTREAM');
  const dataset=body.action==='getCrmAdmittedRoster'?'dashboard.admitted_roster':body.action==='getCrmContinuation'?'outpatient.continuation':source+'.leads';
  const rows=dataset==='dashboard.admitted_roster'?[]:dataset==='outpatient.continuation'?[]:[{id:'fixture-1',name:'שם בדוי',stage:dashboard?'new':'פרטים אישיים',assignedTo:'ורד',visitDate:'',meetingOutcome:'',meetingReportOutcome:'',introDateTime:'',updatedAt:'',phone:'PRIVATE_PHONE',note:'PRIVATE_CLINICAL',amount:'PRIVATE_AMOUNT'}];
  const data= typeof response==='function'?response(body,dataset):response||{ok:true,contract:'crm-source-v1',dataset,health:'fresh',complete:true,observedAt:new Date().toISOString(),rows};
  return {ok:true,status:200,json:async()=>data};
};
const mod=require('../../server'), app=mod.app||mod;
let server,port;
test.before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});port=server.address().port;});
test.after(async()=>{global.fetch=originalFetch;await new Promise(r=>server.close(r));});
test.beforeEach(()=>{calls=[];response=null;fail=false;});
function request(route,auth=cookie,method='GET',body) {
  return new Promise((resolve,reject)=>{
    const text=body?JSON.stringify(body):null;
    const req=http.request({host:'127.0.0.1',port,path:route,method,headers:{...(auth?{Cookie:auth}:{}),...(text?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}:{})}},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));
    });req.on('error',reject);req.end(text);
  });
}
test('real server rejects missing/expired/tampered sessions before source access',async()=>{
  for(const auth of ['', 'ezone_session=forged', dashboard?helper.personalCookie(sessionSecret,'vered',-1):'ezone_session='+createSessionToken(sessionSecret,-1)]) {
    assert.equal((await request('/api/crm/leads',auth)).status,401);
  } assert.equal(calls.length,0);
});
test('authorized source scope is projected and adapters run without leaking raw private fields',async()=>{
  const r=await request('/api/crm/leads'); assert.equal(r.status,200); assert.equal(r.data.dataset,source+'.leads');
  assert.equal(r.data.records[0].nativeRecordId,'fixture-1'); assert.equal(r.data.persistence,'none');
  assert.ok(!JSON.stringify(r).includes('PRIVATE')); assert.match(r.headers['cache-control'],/private.*no-store/);
  assert.equal(calls.length,1); assert.equal(calls[0].opts.method,'POST'); assert.equal(calls[0].body.action,'getCrmLeads');
  assert.ok(!calls[0].url.includes('secret')); if(dashboard) assert.equal(calls[0].body.proxyUserId,'vered');
});
test('client-supplied policy/scope/action fields are refused before upstream',async()=>{
  for(const query of ['userId=vered','allowedIds=fixture-1','showMoney=true','action=getData','dataset=dashboard.leads']) assert.equal((await request('/api/crm/leads?'+query)).status,400);
  assert.equal((await request('/api/crm/leads',cookie,'GET',{allowedIds:['fixture-1']})).status,400); assert.equal(calls.length,0);
});
test('reserved reads cannot bypass the dedicated gate through old GET/POST proxy',async()=>{
  for(const action of ['getCrmLeads','getCrmContinuation','getCrmAdmittedRoster']) {
    assert.equal((await request('/api/sheets?action='+action)).status,403);
    assert.equal((await request('/api/sheets',cookie,'POST',{action,crmReadSecret:'forged'})).status,403);
  } assert.equal(calls.length,0);
});
test('outage returns unavailable with no private exception; previous success is never reused',async()=>{
  assert.equal((await request('/api/crm/leads')).status,200); fail=true;
  const r=await request('/api/crm/leads'); assert.equal(r.status,503); assert.equal(r.data.health,'unavailable');assert.equal(r.data.complete,false);assert.deepEqual(r.data.records,[]);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for(const kind of ['old','future','shape','dataset','missing id','old deployment','not complete']) test('rejects malformed/stale contract: '+kind,async()=>{
  response={ok:true,contract:'crm-source-v1',dataset:source+'.leads',health:'fresh',complete:true,observedAt:new Date().toISOString(),rows:[]};
  if(kind==='old')response.observedAt='2020-01-01T00:00:00Z';
  if(kind==='future')response.observedAt='2099-01-01T00:00:00Z';
  if(kind==='shape')response.rows=[{}];
  if(kind==='dataset')response.dataset='other';
  if(kind==='missing id')response.rows=[{id:'',name:'',stage:'',assignedTo:'',visitDate:'',meetingOutcome:'',meetingReportOutcome:'',introDateTime:'',updatedAt:''}];
  if(kind==='old deployment')delete response.contract;
  if(kind==='not complete')response.complete=false;
  assert.equal((await request('/api/crm/leads')).status,503);
});
test('confirmed empty source remains distinguishable from an outage',async()=>{
  response={ok:true,contract:'crm-source-v1',dataset:source+'.leads',health:'fresh',complete:true,observedAt:new Date().toISOString(),rows:[]};
  const r=await request('/api/crm/leads');assert.equal(r.status,200);assert.equal(r.data.complete,true);assert.deepEqual(r.data.records,[]);
});
if(dashboard) {
  test('controller, revoked identity and narrowed staff role are refused',async()=>{
    for(const [id,status] of [['ortal',403],['yael',401],['sandra',403]]) assert.equal((await request('/api/crm/leads',helper.personalCookie(sessionSecret,id))).status,status);
    assert.equal(calls.length,0);
  });
} else {
  test('chosen name never grants cross-app data or roles',async()=>{
    const named='ezone_session='+createSessionToken(sessionSecret,undefined,undefined,'ורד');
    assert.equal((await request('/api/crm/leads',named)).status,200);
    assert.equal(calls[0].body.proxyUserId,undefined);assert.equal(calls[0].body.proxyRoles,undefined);
    assert.equal((await request('/api/crm/dashboard-leads',named)).status,404);
  });
  test('continuation workflow failure never invents blank decisions from a healthy roster',async()=>{
    response=(body,dataset)=>body.action==='getCrmContinuation'?{ok:false}:{ok:true,contract:'crm-source-v1',dataset,health:'fresh',complete:true,observedAt:new Date().toISOString(),rows:[{name:'דוגמה',house:'ramot',entryDate:'2026-10-01'}]};
    const r=await request('/api/crm/continuation');assert.equal(r.status,503);assert.equal(r.data.complete,false);assert.deepEqual(r.data.records,[]);
  });
  test('roster failure keeps available saved workflow explicit and partial; transfer is not acceptance',async()=>{
    response=(body,dataset)=>body.action==='getCrmAdmittedRoster'?{ok:false}:{ok:true,contract:'crm-source-v1',dataset,health:'fresh',complete:true,observedAt:new Date().toISOString(),rows:[{key:'דוגמה|ramot|2026-10-01',name:'דוגמה',house:'ramot',entryDate:'2026-10-01',meetingDate:'',outcome:'to_outpatient',updatedAt:''}]};
    const r=await request('/api/crm/continuation');assert.equal(r.status,200);assert.equal(r.data.health,'partial');assert.equal(r.data.complete,false);
    assert.ok(r.data.diagnostics.includes('roster_unavailable'));assert.ok(r.data.records.some(x=>x.reason==='destination_link_review'&&x.state==='active'));
  });
  test('both sources confirmed empty produce empty current observations',async()=>{assert.equal((await request('/api/crm/continuation')).status,200);});
}
