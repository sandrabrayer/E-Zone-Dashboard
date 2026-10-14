'use strict';

// CI-only logical dump/restore verification. No production config fallbacks.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { fixtureUrl } = require('./crm-fixture-config');
const { SCHEMA_SQL, createCheckpointStore } = require('../lib/crm/checkpoint-postgres');
const action = process.argv[2];
const schema = 'crm_recovery_fixture', scope = { tenant: 'synthetic-backup', dataset: 'dashboard.leads' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  if (!['seed', 'verify'].includes(action)) throw Error('fixture_action_required');
  const database = action === 'seed' ? 'crm_checkpoint_test' : 'crm_checkpoint_restore_test';
  const connectionString = fixtureUrl(process.env.CRM_TEST_POSTGRES_URL, database);
  const dir = process.env.CRM_TEST_RECOVERY_DIR;
  if (!dir || !path.isAbsolute(dir)) throw Error('fixture_directory_required');
  const keyFile = path.join(dir, 'synthetic-key.bin'), manifestFile = path.join(dir, 'synthetic-manifest.json');
  if (action === 'seed') {
    fs.mkdirSync(dir, { mode: 0o700 }); // Refuse reuse/overwrite of another run.
    fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = fs.readFileSync(keyFile);
  assert.equal(key.length, 32);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, options: '-c search_path=' + schema, max: 1 });
  const store = createCheckpointStore({ pool, key });
  const grant = () => ({ ...scope, allRecords: true, showName: false, policyRevision: 'fixture' });
  const read = target => (target || store).read(scope, { authorize: grant, today: '2026-10-14' });
  const persisted = async () => {
    const { rows } = await pool.query('SELECT epoch,issued,accepted,accepted_hash,key_fingerprint,payload FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [JSON.stringify([scope.tenant, scope.dataset])]);
    assert.equal(rows.length, 1); const row = rows[0];
    return { epoch: row.epoch, issued: row.issued, accepted: row.accepted, acceptedHash: row.accepted_hash,
      fingerprint: row.key_fingerprint, payloadHash: digest(row.payload) };
  };
  try {
    if (action === 'seed') {
      await pool.query('CREATE SCHEMA ' + schema); // Only the disposable fixture DB.
      await pool.query(SCHEMA_SQL);
      const epoch = await store.start(scope);
      const record = (id, state = 'active') => ({ nativeRecordId: id, identityKind: 'row', reason: 'lead_followup', state,
        displayName: 'SYNTHETIC_BACKUP_NAME', dueBasis: 'source', originalDueDate: '2026-10-01' });
      const observation = records => ({ dataset: scope.dataset, health: 'fresh', complete: true, observedAt: '2026-10-14T08:00:00.000Z', records });
      await store.accept(scope, await store.reserve(scope, epoch), observation([record('a'), record('b'), record('c')]));
      await store.accept(scope, await store.reserve(scope, epoch), observation([record('a'), record('b'), record('c', 'resolved')]));
      const oldTicket = await store.reserve(scope, epoch);
      const manifest = { ...await persisted(), oldTicket, expectedOpen: 2, expectedDate: '2026-10-01' };
      fs.writeFileSync(manifestFile, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      assert.equal((await read()).totals.tasks, manifest.expectedOpen);
      console.log('Synthetic backup fixture seeded; random recovery key is outside the database dump.');
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      assert.deepEqual(await persisted(), Object.fromEntries(['epoch','issued','accepted','acceptedHash','fingerprint','payloadHash'].map(k => [k, manifest[k]])));
      const recovered = await read(); assert.equal(recovered.totals.tasks, manifest.expectedOpen);
      assert.ok(recovered.rows.every(r => r.originalDueDate === manifest.expectedDate && r.displayName === null));
      const wrong = createCheckpointStore({ pool, key: randomBytes(32) });
      await assert.rejects(read(wrong), { code: 'checkpoint_key_mismatch' });
      const before = await persisted(); await assert.rejects(wrong.start(scope), { code: 'checkpoint_key_mismatch' });
      assert.deepEqual(await persisted(), before, 'wrong key never resets restored data');
      const epoch = await store.start(scope); assert.equal(epoch, Number(manifest.epoch) + 1);
      const outage = { dataset: scope.dataset, health: 'unavailable', complete: false, observedAt: null, records: [] };
      await assert.rejects(store.accept(scope, manifest.oldTicket, outage), { code: 'collector_fenced' });
      await store.accept(scope, await store.reserve(scope, epoch), outage);
      const retained = await read(); assert.equal(retained.totals.tasks, manifest.expectedOpen);
      assert.ok(retained.rows.every(r => r.originalDueDate === manifest.expectedDate && r.uncertainty === 'source_unavailable'));
      // A partial observation must not resurrect the restored closed task.
      await store.accept(scope, await store.reserve(scope, epoch), { dataset: scope.dataset, health: 'partial', complete: false,
        observedAt: '2026-10-14T08:01:00.000Z', records: [{ nativeRecordId: 'c', identityKind: 'row', reason: 'lead_followup', state: 'active', dueBasis: 'unknown' }] });
      assert.equal((await read()).totals.tasks, manifest.expectedOpen);
      console.log('Dump restored into a separate database: ciphertext/cursors match; key recovery, dates, closed state, fencing and outage retention passed.');
    }
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Synthetic checkpoint backup/restore verification failed.'); process.exitCode = 1; });
