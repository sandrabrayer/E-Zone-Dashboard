'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = 'dashboard';
const isDashboard = source === 'dashboard';
const gs = fs.readFileSync(path.join(__dirname,'../../apps-script/Code.gs'),'utf8');
function fixture() {
  const attempts = [], reads = [], props = { CRM_READS: '1', CRM_READ_SECRET: 'fixture-secret', PROXY_SECRET: 'fixture-secret', ADMITTED_ROSTER_SECRET: 'roster-secret' };
  const tables = {
    Leads: isDashboard
      ? [['id','name','stage','assignedTo','visitDate','meetingOutcome','meetingReportOutcome','phone','note'],['lead-1','בדיקה בדויה','new','ורד','2026-10-01','','','PRIVATE_PHONE','PRIVATE_NOTE']]
      : [['id','name','stage','assignedTo','introDateTime','updatedAt','phone','note'],['lead-1','בדיקה בדויה','פרטים אישיים','ורד','2026-10-01T10:00','2026-10-01T10:00:00Z','PRIVATE_PHONE','PRIVATE_NOTE']],
    Patients: [['name','houseId','date','status','exitDate','notes','pay'],['בדיקה בדויה','ramot','2026-10-01','active','','PRIVATE_CLINICAL',9000],['released','ramot','2026-09-01','released','','',0]],
    'לידים לא רלוונטיים': [['id','name','not_relevant_note']],
    'לידים שהוסרו': [['id','name','note']],
    'מסלול המשך': [['key','name','house','entryDate','meetingDate','outcome','updatedAt','note'],['בדיקה בדויה|ramot|2026-10-01','בדיקה בדויה','ramot','2026-10-01','','to_outpatient','2026-10-12T10:00:00Z','PRIVATE_NOTE']],
  };
  const trap = name => () => { attempts.push(name); throw Error('WRITE_ATTEMPT'); };
  const guarded = (name, obj) => new Proxy(obj, { get: (o,k) => k in o ? o[k] : trap(name+'.'+String(k)) });
  const ctx = {
    SpreadsheetApp: guarded('SpreadsheetApp', { getActiveSpreadsheet: () => guarded('spreadsheet', {
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
      getSheetByName: name => { reads.push(name); return tables[name] ? guarded('sheet', {
        getLastRow: () => tables[name].length,
        getDataRange: () => guarded('range', { getValues: () => tables[name] }),
      }) : null; },
    }) }),
    PropertiesService: guarded('PropertiesService', { getScriptProperties: () => guarded('properties', { getProperty: name => props[name] || null }) }),
    ContentService: { MimeType: { JSON:'JSON' }, createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text }) },
    Utilities: guarded('Utilities', { formatDate: d => d.toISOString().slice(0,10) }),
  };
  for (const api of ['LockService','CacheService','DriveApp','MailApp','GmailApp','UrlFetchApp','ScriptApp','Logger']) ctx[api] = guarded(api, {});
  vm.createContext(ctx); vm.runInContext(gs,ctx);
  const body = isDashboard ? { action:'getCrmLeads', proxySecret:'fixture-secret', proxyAuth:'personal', proxyUserId:'vered', proxyRoles:['staff'] }
    : { action:'getCrmLeads', crmReadSecret:'fixture-secret' };
  const post = (p=body, query={}) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(p) }, parameter:query }).getContent());
  return {ctx,props,tables,attempts,reads,body,post};
}
function noWrites(f) { assert.deepEqual(f.attempts,[]); }
test('real Apps Script entry projects only operational fields with zero mutation attempts',()=>{
  const f=fixture(), r=f.post(); assert.equal(r.ok,true); assert.equal(r.dataset,source+'.leads');
  assert.equal(r.rows[0].id,'lead-1'); assert.ok(!JSON.stringify(r).includes('PRIVATE')); assert.equal(r.complete,true); noWrites(f);
});
for(const mode of ['log','enforce','']) test('bad/missing credentials fail closed with no auth-log writes, mode '+mode,()=>{
  const f=fixture(); f.props.PROXY_SECRET_MODE=mode;
  assert.equal(f.post({action:'getCrmLeads',__actor:{verified:true,roles:['staff']},proxyUserId:'vered',proxyRoles:['staff']}).ok,false);
  const bad={...f.body,proxySecret:'wrong',crmReadSecret:'wrong'};
  assert.equal(f.post(bad).ok,false); assert.deepEqual(f.reads,[]); noWrites(f);
});
test('GET and query-only secrets cannot authorize, even when all credentials are supplied',()=>{
  const f=fixture(); assert.equal(JSON.parse(f.ctx.doGet({parameter:f.body}).getContent()).ok,false);
  assert.equal(f.post({action:'getCrmLeads'},f.body).ok,false); assert.deepEqual(f.reads,[]); noWrites(f);
});
test('disabled/unconfigured readers never touch sheets',()=>{
  for(const key of ['CRM_READS',isDashboard?'PROXY_SECRET':'CRM_READ_SECRET']) {
    const f=fixture(); delete f.props[key]; assert.equal(f.post().ok,false); assert.deepEqual(f.reads,[]); noWrites(f);
  }
});
for(const kind of ['missing','missing header','duplicate header','missing id','wrong cell type','service failure','limit']) test('source failure is explicit, not repaired: '+kind,()=>{
  const f=fixture();
  if(kind==='missing') delete f.tables.Leads;
  if(kind==='missing header') f.tables.Leads[0][2]='unknown';
  if(kind==='duplicate header') f.tables.Leads[0].push('stage');
  if(kind==='missing id') f.tables.Leads[1][0]='';
  if(kind==='wrong cell type') f.tables.Leads[1][2]=42;
  if(kind==='service failure') f.ctx.SpreadsheetApp.getActiveSpreadsheet=()=>{throw Error('SECRET_INTERNAL_MESSAGE');};
  if(kind==='limit') f.tables.Leads.length=10002;
  const r=f.post(); assert.equal(r.ok,false); assert.equal(r.rows,undefined); assert.equal(r.error,'crm_source_unavailable'); noWrites(f);
});
test('header-only sheet is a confirmed empty source without mutation',()=>{
  const f=fixture(); f.tables.Leads.length=1; const r=f.post(); assert.equal(r.ok,true); assert.deepEqual(r.rows,[]); noWrites(f);
});
test('archive membership is explicit ID-only evidence, including removed rows with a still-active stage',()=>{
  const f=fixture();
  f.tables['לידים לא רלוונטיים'].push(['archive-1','PRIVATE_ARCHIVE_NAME','PRIVATE_NOTE']);
  f.tables['לידים שהוסרו'].push(['archive-2','PRIVATE_ARCHIVE_NAME','PRIVATE_NOTE']);
  const r=f.post(); assert.equal(r.contract,'crm-source-v2');
  assert.deepEqual(r.rows.map(x=>[x.id,x.leadLifecycle]),[['lead-1','active'],['archive-1','irrelevant'],['archive-2','removed']]);
  assert.ok(!JSON.stringify(r).includes('PRIVATE')); assert.equal(r.rows[1].name,''); assert.equal(r.rows[2].stage,'');
  assert.deepEqual(f.reads,['Leads','לידים לא רלוונטיים','לידים שהוסרו']); noWrites(f);
});
for(const sheet of ['לידים לא רלוונטיים','לידים שהוסרו']) for(const failure of ['missing','header','blank id','wrong type'])
test('archive failure never claims a complete snapshot: '+sheet+' / '+failure,()=>{
  const f=fixture();
  if(failure==='missing') delete f.tables[sheet];
  if(failure==='header') f.tables[sheet][0][0]='wrong';
  if(failure==='blank id') f.tables[sheet].push(['','private-name']);
  if(failure==='wrong type') f.tables[sheet].push([42]);
  assert.equal(f.post().error,'crm_source_unavailable'); noWrites(f);
});
test('active/archive ID overlap is preserved for downstream quarantine',()=>{
  const f=fixture(); f.tables['לידים שהוסרו'].push(['lead-1']);
  assert.equal(f.post().rows.filter(r=>r.id==='lead-1').length,2); noWrites(f);
});
test('columns are mapped by exact name, not physical order',()=>{
  const f=fixture(); f.tables.Leads=f.tables.Leads.map(r=>r.slice().reverse()); assert.equal(f.post().rows[0].id,'lead-1'); noWrites(f);
});
test('property read failure is unavailable and never repaired or logged',()=>{
  const f=fixture(); f.ctx.PropertiesService.getScriptProperties=()=>{throw Error('secret-detail');};
  assert.equal(f.post().error,'crm_source_unavailable'); assert.deepEqual(f.reads,[]); noWrites(f);
});
if(isDashboard) {
  for(const override of [{proxyAuth:'shared'}, {proxyUserId:'ortal'}, {proxyUserId:'unknown'}, {proxyRoles:[]}]) test('personal staff gate rejects '+JSON.stringify(override),()=>{
    const f=fixture(); assert.equal(f.post({...f.body,...override}).error,'forbidden'); assert.deepEqual(f.reads,[]); noWrites(f);
  });
  test('mismatching untrusted user cannot cause a SecurityLog write',()=>{ const f=fixture(); assert.equal(f.post({...f.body,user:'forged',proxyUser:'verified'}).ok,true); noWrites(f); });
  test('roster reuses ONLY existing roster authority/population; excludes phones, leads and released rows',()=>{
    const f=fixture(); const r=f.post({action:'getCrmAdmittedRoster',secret:'roster-secret'}); assert.equal(r.ok,true);
    assert.deepEqual(r.rows,[{name:'בדיקה בדויה',house:'ramot',entryDate:'2026-10-01'}]); assert.deepEqual(f.reads,['Patients']); noWrites(f);
    assert.equal(f.post({...f.body,action:'getCrmAdmittedRoster'}).error,'unauthorized'); noWrites(f);
  });
} else test('continuation returns existing states only, with no free-text note or new sheet',()=>{
  const f=fixture(),r=f.post({...f.body,action:'getCrmContinuation'}); assert.equal(r.rows[0].outcome,'to_outpatient');
  assert.equal(r.rows[0].note,undefined); delete f.tables['מסלול המשך']; assert.equal(f.post({...f.body,action:'getCrmContinuation'}).ok,false); noWrites(f);
});
