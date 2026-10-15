'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixtureUrl } = require('../../scripts/crm-fixture-config');
const { inspectCrmCheckpoint } = require('../../scripts/crm-checkpoint-preflight');
test('recovery drill accepts only explicit localhost source/restore fixture databases', () => {
  for (const db of ['crm_checkpoint_test', 'crm_checkpoint_restore_test'])
    assert.equal(fixtureUrl('postgres://fixture:dummy@127.0.0.1:5432/' + db, db), 'postgres://fixture:dummy@127.0.0.1:5432/' + db);
});
test('recovery drill refuses remote, production, missing and URL-option overrides without echoing credentials', () => {
  for (const value of [undefined, '', 'SECRET', 'postgres://u:SECRET@db.example/crm_checkpoint_test',
    'postgres://u:SECRET@localhost/production', 'postgres://u:SECRET@localhost/crm_checkpoint_restore_test',
    'postgres://u:SECRET@localhost/crm_checkpoint_test?host=remote', 'postgres://u:SECRET@localhost/crm_checkpoint_test#remote',
    'https://u:SECRET@localhost/crm_checkpoint_test']) {
    assert.throws(() => fixtureUrl(value, 'crm_checkpoint_test'), { message: 'fixture_database_required' });
  }
});
test('checkpoint preflight returns unavailable rather than zero counts or credential-bearing errors', async () => {
  const pool = { connect: async () => { throw Error('PRIVATE_CONNECTION_STRING'); } };
  const result = await inspectCrmCheckpoint({ pool, key: Buffer.alloc(32), scope: { tenant: 'fixture', dataset: 'dashboard.leads' } });
  assert.deepEqual(result, { contract: 'crm-checkpoint-preflight-v1', available: false, error: 'checkpoint_inspection_unavailable' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
