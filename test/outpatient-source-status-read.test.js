'use strict';

/* Dashboard → Outpatient exact handoff source and projection.
 * Real Apps Script in-memory sandbox. No network, no production writes.
 * Synthetic IDs only. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { projectOutpatientStatus, createStatusReader } = require('../lib/outpatient-handoff-status');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const crm = fs.readFileSync(path.join(root, 'public/crm/crm.js'), 'utf8');
const VERIFIED = { verified: true, user: 'ורד', id: 'vered', auth: 'personal', roles: ['editor'], caps: [] };
function world(events = []) {
  const g = loadGs(), headers = Array.from(g.run('AUDIT_LOG_COLUMNS'));
  const sh = richSheet('AuditLog', headers);
  events.forEach(e => sh.grid.push(headers.map(k => e[k] ?? '')));
  g.sandbox.__sheets.AuditLog = sh;
  const read = (query, actor = VERIFIED) => JSON.parse(JSON.stringify(
    g.sandbox.getOutpatientHandoffRef_(Object.assign({ __actor: actor }, query))));
  return { g, sh, read, before: JSON.stringify(sh.grid) };
}
function sent(patientId, outpatientId) {
  return { action: 'outpatient_lead_sent', patientId,
    details: JSON.stringify({ outpatientId }) };
}
test('source only exposes an EXACT audited outpatient id, never phone or name', () => {
  const w = world([sent('L11', 'out-22'), sent('discharge:aud-1', 'out-33')]);
  assert.deepEqual(w.read({ leadId: 'L11' }), { ok: true, linked: true, outpatientId: 'out-22' });
  assert.deepEqual(w.read({ dischargeId: 'aud-1' }), { ok: true, linked: true, outpatientId: 'out-33' });
  assert.deepEqual(w.read({ leadId: 'L12' }), { ok: true, linked: false, reason: 'no_verified_send' });
  assert.equal(JSON.stringify(w.sh.grid), w.before, 'read did not write or change the sheet');
});
test('unknown, missing id, duplicate links and unauthenticated access fail closed', () => {
  const w = world([sent('L1', ''), sent('L2', 'out-1'), sent('L2', 'out-2')]);
  assert.equal(w.read({ leadId: 'L1' }).reason, 'missing_exact_id');
  assert.equal(w.read({ leadId: 'L2' }).reason, 'conflicting_ids');
  assert.equal(w.read({}).error, 'choose_one_id');
  assert.equal(w.read({ leadId: 'L1', dischargeId: 'aud-1' }).error, 'choose_one_id');
  assert.equal(w.read({ leadId: 'bad,other' }).error, 'invalid_id');
  assert.equal(w.read({ leadId: 'L2' }, { verified: false, roles: [] }).error, 'forbidden');
  assert.equal(JSON.stringify(w.sh.grid), w.before);
});
test('OUT status is source-owned, exact one result, strips unexpected money/clinical/phone', () => {
  const good = { ok: true, sourceApp: 'ezone-outpatient', results: [{
    outpatientId: 'out-22', entity: 'lead', state: 'contacted',
    assignedTo: 'ורד', nextAction: 'חזרה טלפונית',
    nextActionDate: '2026-11-10', phone: 'NEVER', amount: 999, clinicalNotes: 'NEVER',
  }] };
  assert.deepEqual(projectOutpatientStatus(good), {
    verified: true, state: 'contacted', entity: 'lead', stateDate: '',
    assignedTo: 'ורד', nextAction: 'חזרה טלפונית', nextActionDate: '2026-11-10',
    lastActionDate: '',
  });
  assert.equal(projectOutpatientStatus({ ...good, results: [] }).verified, false);
  assert.equal(projectOutpatientStatus({ ...good, results: good.results.concat(good.results) }).verified, false);
  assert.equal(projectOutpatientStatus({ ...good, results: [{ ...good.results[0], state: 'paid' }] }).verified, false);
  assert.equal(projectOutpatientStatus({ ...good, sourceApp: 'unknown' }).verified, false);
});
test('bounded cache reuses verified status for 60 seconds but never caches unknown/failure', async () => {
  let current = 100000, hits = 0;
  const read = createStatusReader(async id => {
    hits++;
    if (id === 'fail') throw Error('down');
    if (id === 'unknown') return { ok: true, sourceApp: 'ezone-outpatient', results: [] };
    return { ok: true, sourceApp: 'ezone-outpatient', results: [{
      outpatientId: id, entity: 'client', state: 'active',
    }] };
  }, () => current);
  assert.equal((await read('out-1')).state, 'active');
  assert.equal((await read('out-1')).state, 'active');
  assert.equal(hits, 1);
  current += 59999; await read('out-1'); assert.equal(hits, 1);
  current += 1; await read('out-1'); assert.equal(hits, 2);
  assert.equal((await read('unknown')).verified, false);
  await read('unknown'); assert.equal(hits, 4);
  assert.equal((await read('fail')).verified, false);
  assert.equal((await read('bad id')).verified, false);
  assert.equal(hits, 5);
});
test('route is session gated, the source action is browser-blocked and UI is manual', () => {
  assert.match(source, /app\.get\('\/api\/outpatient-handoff-status', requireSession, requireProxySecret/);
  assert.match(source, /isControllerView\(principal\)/);
  assert.match(source, /'getOutpatientHandoffRef'\]/);
  assert.match(source, /sheetsPost\(\{ action: 'getOutpatientHandoffRef'/);
  assert.match(source, /action=getHandoffStatus/);
  assert.match(source, /status_feed_not_configured/);
  assert.match(crm, /data-check-outpatient-status/);
  assert.match(crm, /בדיקת המשך טיפול באמבולטורי/);
  assert.match(crm, /הסטטוס לא אומת/);
  assert.ok(!source.includes('phone: req.query.phone'));
});
