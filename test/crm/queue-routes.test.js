'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('../helpers/crm-queue-fixture');
const { queueConfig, createQueueRuntime } = require('../../lib/crm/queue-runtime');
let f;
test.beforeEach(async () => { f = await fixture(); });
test.afterEach(async () => { await f.close(); });
test('queue runtime is disabled by default and cannot inherit database or read-model credentials', () => {
  for (const env of [{}, { CRM_QUEUE_ENABLED: '1', CRM_READS: '1', DATABASE_URL: 'postgres://test@localhost/fixture', READ_MODEL_KEY: 'unused' }]) {
    const r = createQueueRuntime(env); assert.equal(r.enabled, false); assert.throws(() => r.getStore(), /disabled/);
  }
  const env = { CRM_QUEUE_ENABLED: '1', CRM_READS: '1', CRM_QUEUE_DATABASE_URL: 'postgres://fixture@localhost/crm_checkpoint_test', CRM_QUEUE_KEY: Buffer.alloc(32, 12).toString('base64'), CRM_QUEUE_TENANT: 'fixture', CRM_QUEUE_EPOCH: '1' };
  assert.equal(queueConfig(env).scope.dataset, 'dashboard.leads');
  for (const [key, value] of [['CRM_READS','0'],['CRM_QUEUE_ENABLED','0'],['CRM_QUEUE_DATABASE_URL','https://example.org'],['CRM_QUEUE_KEY','invalid'],['CRM_QUEUE_TENANT','bad|scope'],['CRM_QUEUE_EPOCH','0'],['CRM_QUEUE_EPOCH','9007199254740992']]) assert.equal(queueConfig({ ...env, [key]: value }), null);
});
test('opening the protected page or reading an empty checkpoint never collects, claims or writes', async () => {
  assert.equal((await f.request('/crm-work')).status, 200);
  const r = await f.request(); assert.equal(r.status, 200); assert.equal(r.data.queue.historyAvailable, false);
  assert.deepEqual([f.state.reads, f.state.reserves, f.state.accepts], [0,0,0]);
  assert.match(r.headers.get('cache-control'), /private.*no-store/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('unauthenticated, denied, disabled and browser-supplied scopes cannot touch source or checkpoint', async () => {
  for (const path of ['/api/crm/queue','/crm-work','/crm-work/app.js']) assert.equal((await f.request(path, { headers: { Cookie: '' } })).status, 401);
  f.state.allowed = false; assert.equal((await f.refresh()).status, 403);
  f.state.allowed = true; f.runtime.enabled = false; assert.equal((await f.refresh()).status, 503);
  f.runtime.enabled = true;
  assert.equal((await f.refresh({ body: JSON.stringify({ dataset: 'outpatient.leads', records: [] }) })).status, 400);
  assert.equal((await f.request('/api/crm/queue?tenant=other')).status, 400);
  assert.deepEqual([f.state.reads, f.state.reserves, f.state.accepts], [0,0,0]);
});
test('refresh requires exact same-origin JSON and a custom header, including against same-site sibling origins', async () => {
  for (const headers of [{Origin:''}, {Origin:'https://attacker.example'}, {Origin:f.origin.replace('127.0.0.1','localhost')}, {'X-CRM-Refresh':''}, {'Content-Type':'text/plain'}, {'Sec-Fetch-Site':'same-site'}]) assert.equal((await f.refresh({headers})).status, 403);
  assert.equal(f.state.reserves, 0);
});
test('trusted source observations persist; outages and disappearance retain unresolved tasks', async () => {
  let r = await f.refresh(); assert.equal(r.status, 200); assert.equal(r.data.queue.rows[0].displayName, f.state.rows[0].name);
  f.state.source = 'unavailable'; r = await f.refresh(); assert.equal(r.status, 200);
  assert.equal(r.data.queue.source.health, 'unavailable'); assert.equal(r.data.queue.rows[0].uncertainty, 'source_unavailable');
  assert.ok(!JSON.stringify(r.data).includes('PRIVATE'));
  f.state.source = 'fresh'; f.state.rows = []; r = await f.refresh(); assert.equal(r.data.queue.rows[0].uncertainty, 'missing_in_source');
  assert.equal((await f.request()).data.queue.totals.tasks, 1);
});
test('source duplicates are partial and do not falsely close prior work', async () => {
  await f.refresh(); f.state.rows = [{ ...f.state.rows[0], stage: 'admitted' }, { ...f.state.rows[0] }];
  const r = await f.refresh(); assert.equal(r.data.queue.source.health, 'partial'); assert.equal(r.data.queue.totals.tasks, 1);
});
test('revocation or authority revision during source read aborts checkpoint acceptance', async () => {
  for (const revoke of [() => { f.state.allowed = false; }, () => { f.state.revision = 'staff-v2'; }]) {
    f.state.allowed = true; f.state.revision = 'staff-v1'; let release;
    f.state.waitSource = new Promise(r => { release = r; }); const count = f.state.reads;
    const pending = f.refresh(); while (f.state.reads === count) await new Promise(r => setImmediate(r));
    revoke(); release(); assert.equal((await pending).status, 403); assert.equal(f.state.accepts, 0);
  }
});
test('one in-flight source request; fenced generations never auto-claim or return fake success', async () => {
  let release; f.state.waitSource = new Promise(r => { release = r; });
  const pending = f.refresh(); while (!f.state.reads) await new Promise(r => setImmediate(r));
  assert.equal((await f.refresh()).status, 409); release(); assert.equal((await pending).status, 200);
  f.state.failure = 'collector_fenced'; const r = await f.refresh(); assert.equal(r.status, 409);
  assert.equal(f.state.reads, 1); assert.equal(f.state.accepts, 1);
});
test('database/key failures return an error without a fabricated empty queue or exception text', async () => {
  await f.refresh(); f.state.failure = 'checkpoint_key_mismatch';
  const r = await f.request(); assert.equal(r.status, 503); assert.equal(r.data.queue, undefined);
  assert.deepEqual(r.data, { ok: false, error: 'crm_queue_unavailable' });
});
