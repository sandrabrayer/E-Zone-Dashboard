'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { loadGs, richSheet } = require('../helpers/gs-sandbox');
const { collectLeads } = require('../../lib/crm/read-routes');
const { normalize, mergeCheckpoint, projectCheckpoint } = require('../../lib/crm/checkpoint-state');
const { CRM_STAFF_IDS, crmStaffPrincipal } = require('../../lib/crm/policy');
const scope = { tenant: 'synthetic-archive', dataset: 'dashboard.leads' };
const grant = { ...scope, allRecords: true, showName: true, policyRevision: 'fixture' };
function world() {
  // Optional local mutation probe. CI always loads the checked-out real Code.gs.
  const src = process.env.CRM_TEST_GS_PATH ? fs.readFileSync(process.env.CRM_TEST_GS_PATH, 'utf8') : undefined;
  const g = loadGs({ src, props: { CRM_READS: '1', PROXY_SECRET: 'fixture' } });
  const sheets = g.sandbox.__sheets;
  for (const [name, columns] of [['Leads','LEAD_COLUMNS'],['לידים לא רלוונטיים','IRRELEVANT_LEAD_COLUMNS'],['לידים שהוסרו','REMOVED_LEAD_COLUMNS']]) {
    const sh = richSheet(name, Array.from(g.run(columns))); sheets[name] = sh;
    sh.getDataRange = () => sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn());
  }
  const lead = { id: 'fixture-lead-1', name: 'PRIVATE_ARCHIVE_NAME', stage: 'visit', visitDate: '2020-01-01', assignedTo: 'דוגמה', meetingOutcome: '', meetingReportOutcome: '' };
  sheets.Leads.appendRow(Array.from(g.run('LEAD_COLUMNS')).map(k => lead[k] || ''));
  const body = { action: 'getCrmLeads', proxySecret: 'fixture', proxyAuth: 'personal', proxyUserId: 'vered', proxyRoles: ['staff'] };
  let checkpoint = null;
  const snapshot = () => JSON.stringify(sheets);
  const read = async () => {
    const before = snapshot(), result = await collectLeads('dashboard', () => g.post(body));
    assert.equal(snapshot(), before, 'projection does not mutate Sheets');
    checkpoint = mergeCheckpoint(checkpoint, normalize(scope, result.envelope));
    return projectCheckpoint(scope, checkpoint, grant, '2026-10-13');
  };
  return { g, sheets, lead, read, checkpoint: () => checkpoint, body };
}
for (const [action, lifecycle] of [['moveLeadIrrelevant_','irrelevant'],['removeLead_','removed']]) {
  test('archive action '+action+' closes both prior tasks via real Code.gs, transport validation, adapter and checkpoint', async () => {
    const w = world(); assert.equal((await w.read()).totals.tasks,2);
    assert.equal(w.g.sandbox[action](w.lead,'synthetic actor').ok,true);
    assert.equal(w.g.sheetRows('Leads','LEAD_COLUMNS').length,0);
    assert.equal((await w.read()).totals.tasks,0);
    assert.ok(w.checkpoint().tasks.every(t => t.closed && t.record.resolutionBasis === 'archived_'+lifecycle));
    for (let i=0;i<3;i++) assert.equal((await w.read()).totals.tasks,0);
    const projection = w.g.post(w.body); assert.equal(projection.rows[0].leadLifecycle,lifecycle);
    assert.ok(!JSON.stringify(projection).includes('PRIVATE_ARCHIVE_NAME'));
    if(lifecycle==='irrelevant') assert.equal(w.g.sandbox.restoreLead_({...w.lead,stage:'visit'},'synthetic actor').ok,true);
    else {
      // The documented remove flow has only manual Sheets restoration. Model
      // that source operation here; do not add a restore endpoint or app rule.
      w.sheets['לידים שהוסרו'].grid.length=1;
      w.sheets.Leads.appendRow(Array.from(w.g.run('LEAD_COLUMNS')).map(k => w.lead[k] || ''));
    }
    assert.equal((await w.read()).totals.tasks,2,'explicit restored active source reopens its tasks');
    assert.ok(w.checkpoint().tasks.every(t=>t.record.resolutionBasis===null));
  });
}
test('archive closes an earlier meeting reminder even if the archived date was cleared', async () => {
  const w=world(); await w.read(); w.g.sandbox.removeLead_({...w.lead,visitDate:''},'synthetic actor');
  assert.equal((await w.read()).totals.tasks,0);
});
test('active/archive overlap is partial; neither arbitrary precedence nor row order closes tasks', async () => {
  const w=world(); await w.read(); w.g.sandbox.removeLead_(w.lead,'synthetic actor');
  w.sheets.Leads.appendRow(Array.from(w.g.run('LEAD_COLUMNS')).map(k=>w.lead[k]||''));
  const r=await w.read(); assert.equal(r.totals.tasks,2); assert.equal(r.source.health,'partial'); assert.equal(r.source.complete,false);
  assert.ok(w.checkpoint().tasks.every(t=>!t.closed));
});
test('missing archive and empty active sheets never clear prior tasks or invent completeness', async () => {
  const w=world(); await w.read(); w.g.sandbox.removeLead_(w.lead,'synthetic actor'); delete w.sheets['לידים שהוסרו'];
  const r=await w.read(); assert.equal(r.source.health,'unavailable'); assert.equal(r.totals.tasks,2);
  assert.ok(r.rows.every(r=>r.uncertainty==='source_unavailable'));
});
test('a date cleared on an active lead remains a review item, not invented meeting completion (R7)', async () => {
  const w=world(); await w.read();
  w.sheets.Leads.grid[1][w.sheets.Leads.grid[0].indexOf('visitDate')]='';
  const r=await w.read(); assert.equal(r.totals.tasks,2); assert.equal(r.rows.find(x=>x.reason==='meeting_result').uncertainty,'missing_in_source');
});
test('Node and Apps Script source identity sets cannot drift; a new generic staff identity remains denied (R4)', () => {
  const w=world(); assert.deepEqual(Array.from(w.g.run('CRM_STAFF_IDS')), [...CRM_STAFF_IDS]);
  for(const id of CRM_STAFF_IDS) assert.equal(crmStaffPrincipal({id,auth:'personal',roles:['staff']}),true);
  for(const p of [{id:'new-staff',auth:'personal',roles:['staff']},{id:'vered',auth:'shared',roles:['staff']},{id:'vered',auth:'personal',roles:['viewer']},null]) assert.equal(crmStaffPrincipal(p),false);
});
