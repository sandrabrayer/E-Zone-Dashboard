'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { fixtureUrl } = require('../../scripts/crm-fixture-config');
const { SCHEMA_SQL, createCheckpointStore } = require('../../lib/crm/checkpoint-postgres');
const { inspectCrmCheckpoint } = require('../../scripts/crm-checkpoint-preflight');
const configured = process.env.CRM_TEST_POSTGRES_URL;
if (process.env.CRM_REQUIRE_POSTGRES_TESTS === '1' && !configured) throw Error('CRM_TEST_POSTGRES_URL is required');
const run = configured ? test : (name, fn) => test(name, { skip: 'requires dedicated CRM_TEST_POSTGRES_URL' }, fn);
const suffix = randomBytes(8).toString('hex'), schema = 'crm_rights_' + suffix, role = 'crm_runtime_' + suffix;
const key = randomBytes(32), scope = { tenant: 'synthetic-rights', dataset: 'dashboard.leads' };
let admin, owner, runtime, provisioner, store, epoch;
const observation = { dataset: scope.dataset, health: 'fresh', complete: true, observedAt: '2026-10-14T08:00:00.000Z', records: [
  { nativeRecordId: 'fixture-only', identityKind: 'row', reason: 'lead_followup', state: 'active', dueBasis: 'unknown' },
] };
const access = () => ({ ...scope, allRecords: true, policyRevision: 'fixture' });
if (configured) {
  const { Pool } = require('pg');
  const connectionString = fixtureUrl(configured, 'crm_checkpoint_test');
  admin = new Pool({ connectionString, max: 1 });
  owner = new Pool({ connectionString, options: '-c search_path=' + schema, max: 1 });
  test.before(async () => {
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await owner.query(SCHEMA_SQL);
    await owner.query('CREATE TABLE excluded_fixture_table (value text)');
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, UPDATE (issued, accepted, accepted_hash, payload) ON ${schema}.crm_operational_checkpoints_v1 TO ${role}`);
    const restricted = new URL(connectionString); restricted.username = role; restricted.password = password;
    runtime = new Pool({ connectionString: restricted.href, options: '-c search_path=' + schema, max: 1 });
    provisioner = createCheckpointStore({ pool: owner, key });
    store = createCheckpointStore({ pool: runtime, key });
    epoch = await provisioner.start(scope);
  });
  test.after(async () => {
    if (runtime) await runtime.end();
    await owner.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.query(`DROP ROLE IF EXISTS ${role}`); }
    finally { await admin.end(); }
  });
}
run('real Postgres permissions: runtime SELECT/UPDATE can reserve, accept and read a provisioned checkpoint', async () => {
  const ticket = await store.reserve(scope, epoch); await store.accept(scope, ticket, observation);
  const result = await store.read(scope, { authorize: access, today: '2026-10-14' });
  assert.equal(result.totals.tasks, 1);
});
run('real Postgres permissions: runtime cannot create, alter or drop schema objects', async () => {
  for (const sql of ['CREATE TABLE forbidden_fixture_table (x int)',
    'ALTER TABLE crm_operational_checkpoints_v1 ADD COLUMN forbidden int', 'DROP TABLE crm_operational_checkpoints_v1'])
    await assert.rejects(runtime.query(sql), { code: '42501' });
});
run('real Postgres permissions: runtime cannot insert, delete or truncate checkpoints', async () => {
  for (const sql of ["INSERT INTO crm_operational_checkpoints_v1(scope_key,key_fingerprint) VALUES('fixture','fixture')",
    'DELETE FROM crm_operational_checkpoints_v1', 'TRUNCATE crm_operational_checkpoints_v1'])
    await assert.rejects(runtime.query(sql), { code: '42501' });
});
run('real Postgres permissions: runtime cannot read unrelated tables or take the owner role', async () => {
  await assert.rejects(runtime.query('SELECT * FROM excluded_fixture_table'), { code: '42501' });
  const { rows } = await owner.query('SELECT current_user AS name');
  assert.match(rows[0].name, /^[a-zA-Z0-9_]+$/);
  await assert.rejects(runtime.query('SET ROLE "' + rows[0].name + '"'), { code: '42501' });
});
run('real Postgres permissions: runtime cannot provision or advance the collector generation', async () => {
  await assert.rejects(store.start(scope), { code: 'checkpoint_unavailable' });
  await assert.rejects(runtime.query('UPDATE crm_operational_checkpoints_v1 SET epoch=epoch+1'), { code: '42501' });
  await assert.rejects(runtime.query("UPDATE crm_operational_checkpoints_v1 SET key_fingerprint='different'"), { code: '42501' });
  const { rows } = await owner.query('SELECT epoch FROM crm_operational_checkpoints_v1');
  assert.equal(Number(rows[0].epoch), epoch);
});
run('real Postgres preflight: count closed and open tasks without returning records; wrong key fails closed', async () => {
  const closed = { ...observation.records[0], nativeRecordId: 'SYNTHETIC_PRIVATE_ID', displayName: 'SYNTHETIC_PRIVATE_NAME', state: 'resolved' };
  await store.accept(scope, await store.reserve(scope, epoch), { ...observation, records: [...observation.records, closed] });
  const report = await inspectCrmCheckpoint({ pool: runtime, key, scope });
  assert.equal(report.available, true); assert.equal(report.totalTasks, 2);
  assert.equal(report.openTasks, 1); assert.equal(report.closedTasks, 1);
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE'));
  const wrong = await inspectCrmCheckpoint({ pool: runtime, key: randomBytes(32), scope });
  assert.deepEqual(wrong, { contract: 'crm-checkpoint-preflight-v1', available: false, error: 'checkpoint_inspection_unavailable' });
});
run('real Postgres preflight: database enforces read-only inspection', async () => {
  let code;
  const wrapped = { connect: async () => {
    const client = await runtime.connect();
    return { release: () => client.release(), query: async (sql, args) => {
      if (sql.startsWith('SELECT key_fingerprint,payload')) {
        try { await client.query('UPDATE crm_operational_checkpoints_v1 SET issued=issued+1'); }
        catch (error) { code = error.code; throw error; }
      }
      return client.query(sql, args);
    } };
  } };
  const result = await inspectCrmCheckpoint({ pool: wrapped, key, scope });
  assert.equal(result.available, false); assert.equal(code, '25006');
  assert.equal((await inspectCrmCheckpoint({ pool: runtime, key, scope })).totalTasks, 2);
});
