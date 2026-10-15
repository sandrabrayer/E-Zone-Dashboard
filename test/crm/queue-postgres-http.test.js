'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const configured = process.env.CRM_TEST_POSTGRES_URL;
if (process.env.CRM_REQUIRE_POSTGRES_TESTS === '1' && !configured) throw Error('CRM_TEST_POSTGRES_URL is required');
const run = configured ? test : (name, fn) => test(name, { skip: 'requires dedicated CRM_TEST_POSTGRES_URL' }, fn);
let server, origin, pool, store, runtime, cookie, helper, sourceRows, unavailable, sourceCalls = 0;
const scope = { tenant: 'http-fixture-' + process.pid, dataset: 'dashboard.leads' };
const key = Buffer.alloc(32, 24), secret = 'synthetic-http-session', originalFetch = global.fetch;
if (configured) {
  const url = new URL(configured);
  if (!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname) || url.pathname !== '/crm_checkpoint_test') throw Error('refusing non-local/non-fixture DB');
  const { Pool } = require('pg'), { SCHEMA_SQL, createCheckpointStore } = require('../../lib/crm/checkpoint-postgres');
  const { scopeKey } = require('../../lib/crm/checkpoint-state');
  helper = require('../helpers/personal-session');
  const registry = JSON.parse(helper.userPinHashes(['vered','sandra','ortal','yael']));
  registry.find(r => r.id === 'sandra').roles = ['viewer']; registry.find(r => r.id === 'yael').status = 'revoked';
  Object.assign(process.env, { SESSION_SECRET: secret, USER_PIN_HASHES: JSON.stringify(registry), PIN_PEPPER: helper.TEST_PEPPER,
    CRM_QUEUE_ENABLED: '1', CRM_READS: '1', CRM_QUEUE_DATABASE_URL: configured, CRM_QUEUE_TENANT: scope.tenant,
    CRM_QUEUE_KEY: key.toString('base64'), CRM_QUEUE_EPOCH: '1', PROXY_SECRET: 'fixture-only', SHEETS_URL: 'https://script.google.com/macros/s/fixture/exec' });
  // Capture the actual runtime ONLY for test teardown. No mock DB/store/route.
  const factory = require('../../lib/crm/queue-runtime'), create = factory.createQueueRuntime;
  factory.createQueueRuntime = env => { runtime = create(env); return runtime; };
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://script.google.com/')) return originalFetch(url, opts);
    sourceCalls++; const body = JSON.parse(opts.body); assert.equal(body.action, 'getCrmLeads'); assert.equal(body.proxyUserId, 'vered');
    if (unavailable) throw Error('PRIVATE_GOOGLE_ERROR');
    return { status: 200, ok: true, json: async () => ({ ok: true, contract: 'crm-source-v2', dataset: scope.dataset, health: 'fresh', complete: true, observedAt: new Date().toISOString(), rows: sourceRows }) };
  };
  const { app } = require('../../server'); factory.createQueueRuntime = create;
  cookie = helper.personalCookie(secret, 'vered');
  pool = new Pool({ connectionString: configured, max: 2 }); store = createCheckpointStore({ pool, key });
  test.before(async () => {
    await pool.query(SCHEMA_SQL);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); origin = `http://127.0.0.1:${server.address().port}`;
  });
  test.beforeEach(async () => {
    await pool.query('DELETE FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [scopeKey(scope)]);
    assert.equal(await store.start(scope), 1); sourceCalls = 0; unavailable = false;
    sourceRows = [{ leadLifecycle: 'active', id: 'synthetic-1', name: 'בדיקת מסלול בלבד', stage: 'new', assignedTo: '', visitDate: '', meetingOutcome: '', meetingReportOutcome: '' }];
  });
  test.after(async () => { global.fetch = originalFetch; await new Promise(r => server.close(r)); await runtime.close(); await pool.end(); });
}
async function request(refresh = false, auth = cookie) {
  const r = await originalFetch(origin + '/api/crm/queue' + (refresh ? '/refresh' : ''), {
    method: refresh ? 'POST' : 'GET', headers: { Cookie: auth, ...(refresh ? { Origin: origin, 'Content-Type': 'application/json', 'X-CRM-Refresh': '1' } : {}) }, ...(refresh ? { body: '{}' } : {}),
  }); return { status: r.status, data: await r.json() };
}
run('real PostgreSQL + server: only current personal staff can collect or read retained tasks', async () => {
  for (const [id, status] of [['ortal',403],['sandra',403],['yael',401]]) {
    assert.equal((await request(false, helper.personalCookie(secret, id))).status, status);
    assert.equal((await request(true, helper.personalCookie(secret, id))).status, status);
  }
  assert.equal(sourceCalls, 0); assert.equal((await request(true)).status, 200);
  const { rows } = await pool.query('SELECT payload FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [JSON.stringify([scope.tenant,scope.dataset])]);
  assert.equal(rows[0].payload.includes(Buffer.from(sourceRows[0].name)), false);
});
run('real PostgreSQL + server: page reload and source outage preserve work without GET collection', async () => {
  assert.equal((await request(true)).data.queue.totals.tasks, 1);
  assert.equal((await request()).data.queue.totals.tasks, 1); assert.equal(sourceCalls, 1);
  unavailable = true; const r = await request(true); assert.equal(r.status, 200); assert.equal(r.data.queue.rows[0].uncertainty, 'source_unavailable');
  assert.equal((await request()).data.queue.totals.tasks, 1); assert.equal(sourceCalls, 2);
});
run('real PostgreSQL + server: fenced server cannot fetch, reacquire ownership or close work', async () => {
  await request(true); const next = await store.start(scope); assert.equal(next, 2);
  sourceRows = []; assert.equal((await request(true)).status, 409); assert.equal(sourceCalls, 1);
  assert.equal((await request()).data.queue.totals.tasks, 1);
});
run('real PostgreSQL + server: disappearance retains work; explicit resolution closes its own reason', async () => {
  const initial = sourceRows[0]; await request(true); sourceRows = []; assert.equal((await request(true)).data.queue.totals.tasks, 1);
  sourceRows = [{ ...initial, stage: 'admitted', visitDate: '2020-01-01' }];
  const r = await request(true); assert.equal(r.data.queue.totals.tasks, 1); assert.equal(r.data.queue.rows[0].reason, 'meeting_result');
});
run('real PostgreSQL + server: explicit archive membership durably closes prior lead and meeting tasks', async () => {
  sourceRows[0].visitDate='2020-01-01'; assert.equal((await request(true)).data.queue.totals.tasks,2);
  sourceRows=[{id:'synthetic-1',name:'',stage:'',assignedTo:'',visitDate:'',meetingOutcome:'',meetingReportOutcome:'',leadLifecycle:'removed'}];
  assert.equal((await request(true)).data.queue.totals.tasks,0);
  assert.equal((await request()).data.queue.totals.tasks,0);
  unavailable=true; assert.equal((await request(true)).data.queue.totals.tasks,0);
});
