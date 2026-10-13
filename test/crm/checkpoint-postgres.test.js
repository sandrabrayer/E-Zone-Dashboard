'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { SCHEMA_SQL, createCheckpointStore } = require('../../lib/crm/checkpoint-postgres');
const configured = process.env.CRM_TEST_POSTGRES_URL;
if (process.env.CRM_REQUIRE_POSTGRES_TESTS === '1' && !configured) throw Error('CRM_TEST_POSTGRES_URL is required');
// Dedicated fixture DB only. Never inherit DATABASE_URL or any app credential.
const run = configured ? test : (name, fn) => test(name, { skip: 'requires dedicated CRM_TEST_POSTGRES_URL' }, fn);
let pool, store, index = 0;
const key = randomBytes(32), now = '2026-10-13T16:00:00.000Z';
if (configured) {
  const url = new URL(configured);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || url.pathname !== '/crm_checkpoint_test') throw Error('refusing non-local/non-fixture DB');
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: configured, max: 5, connectionTimeoutMillis: 5000 });
  store = createCheckpointStore({ pool, key });
  test.before(async () => { await pool.query(SCHEMA_SQL); });
  test.after(async () => { await pool.end(); });
}
const scope = () => ({ tenant: 'fixture-' + process.pid + '-' + (++index), dataset: 'dashboard.leads' });
const row = extra => ({ nativeRecordId: 'fixture-1', identityKind: 'row', reason: 'lead_followup', state: 'active', displayName: 'SYNTHETIC_NAME', assignee: null, dueBasis: 'unknown', ...extra });
const obs = (s, records = [row()], extra = {}) => ({ dataset: s.dataset, health: 'fresh', complete: true, observedAt: now, records, ...extra });
const access = (s, extra = {}) => ({ ...s, allRecords: true, showName: true, policyRevision: '1', ...extra });
const read = (s, target = store, authorize = () => access(s)) => target.read(s, { authorize, today: '2026-10-13' });
async function initial(s) { const epoch = await store.start(s), ticket = await store.reserve(s, epoch); await store.accept(s, ticket, obs(s)); return { epoch, ticket }; }
run('real Postgres: accepted queue survives a fresh store/pool connection', async () => {
  const s = scope(); await initial(s);
  const { Pool } = require('pg'), second = new Pool({ connectionString: configured, max: 1 });
  try { assert.equal((await read(s, createCheckpointStore({ pool: second, key }))).totals.tasks, 1); } finally { await second.end(); }
});
run('real Postgres: restarting collector fences earlier tickets while retaining work', async () => {
  const s = scope(), { epoch } = await initial(s), old = await store.reserve(s, epoch);
  const next = await store.start(s); assert.ok(next > epoch);
  await assert.rejects(store.accept(s, old, obs(s, [])), { code: 'collector_fenced' });
  await assert.rejects(store.reserve(s, epoch), { code: 'collector_fenced' });
  assert.equal((await read(s)).totals.tasks, 1);
});
run('real Postgres: overlapping reads arriving backwards cannot overwrite newer state', async () => {
  const s = scope(), epoch = await store.start(s), first = await store.reserve(s, epoch), second = await store.reserve(s, epoch);
  await store.accept(s, second, obs(s));
  await assert.rejects(store.accept(s, first, obs(s, [row({ state: 'resolved' })])), { code: 'out_of_order' });
  assert.equal((await read(s)).totals.tasks, 1);
});
run('real Postgres: exact replay is idempotent; same ticket/different data is refused', async () => {
  const s = scope(), { ticket } = await initial(s);
  assert.deepEqual(await store.accept(s, ticket, obs(s)), { accepted: true, replay: true });
  await assert.rejects(store.accept(s, ticket, obs(s, [])), { code: 'replay_conflict' });
});
run('real Postgres: concurrent reservations have unique durable ordering', async () => {
  const s = scope(), epoch = await store.start(s);
  const tickets = await Promise.all(Array.from({ length: 12 }, () => store.reserve(s, epoch)));
  assert.deepEqual(tickets.map(t => t.sequence).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
});
run('real Postgres: unavailable snapshots and disappearance retain unresolved work across restart', async () => {
  const s = scope(), { epoch } = await initial(s);
  for (const value of [obs(s, []), obs(s, [], { health: 'unavailable', complete: false, observedAt: null })]) {
    await store.accept(s, await store.reserve(s, epoch), value);
  }
  await store.start(s); const result = await read(s); assert.equal(result.totals.tasks, 1); assert.equal(result.rows[0].uncertainty, 'source_unavailable');
});
run('real Postgres: payload is encrypted and key mismatch never resets a checkpoint', async () => {
  const s = scope(); await initial(s);
  const rows = await pool.query('SELECT * FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [JSON.stringify([s.tenant, s.dataset])]);
  assert.ok(!rows.rows[0].payload.toString('utf8').includes('SYNTHETIC_NAME'));
  const wrong = createCheckpointStore({ pool, key: randomBytes(32) });
  await assert.rejects(wrong.start(s), { code: 'checkpoint_key_mismatch' });
  await assert.rejects(read(s, wrong), { code: 'checkpoint_key_mismatch' });
  assert.equal((await read(s)).totals.tasks, 1);
});
run('real Postgres: encrypted payload cannot be copied into a different tenant', async () => {
  const a = scope(), b = scope(); await initial(a); await initial(b);
  await pool.query('UPDATE crm_operational_checkpoints_v1 SET payload=(SELECT payload FROM crm_operational_checkpoints_v1 WHERE scope_key=$1) WHERE scope_key=$2', [JSON.stringify([a.tenant, a.dataset]), JSON.stringify([b.tenant, b.dataset])]);
  await assert.rejects(read(b), { code: 'checkpoint_unavailable' }); await assert.rejects(store.start(b), { code: 'checkpoint_unavailable' });
  assert.equal((await read(a)).totals.tasks, 1);
});
run('real Postgres: revoked scope returns no rows/metadata, including revocation during I/O', async () => {
  const s = scope(); await initial(s); assert.equal(await read(s, store, () => null), null);
  let count = 0; assert.equal(await read(s, store, () => ++count === 1 ? access(s) : null), null);
  assert.equal(await read(s, store, () => access(s, { tenant: 'other' })), null);
});
run('real Postgres: filtering and redaction are current, never a stored old grant', async () => {
  const s = scope(), epoch = await store.start(s), ticket = await store.reserve(s, epoch);
  await store.accept(s, ticket, obs(s, [row(), row({ nativeRecordId: 'hidden-id', displayName: 'HIDDEN_NAME' })]));
  const v = await read(s, store, () => access(s, { allRecords: false, allowedIds: ['fixture-1'], showName: false }));
  assert.equal(v.totals.tasks, 1); assert.equal(v.source, null); assert.ok(!JSON.stringify(v).includes('HIDDEN')); assert.equal(v.rows[0].displayName, null);
});
function withCommitFault(afterCommit) {
  let injected = false;
  return { connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (sql, args) => {
      if (sql === 'COMMIT' && !injected) {
        injected = true; if (afterCommit) await client.query(sql, args); throw Error('PRIVATE_CONNECTION_DETAIL');
      }
      return client.query(sql, args);
    } };
  } };
}
run('real Postgres: failure before COMMIT rolls back both acceptance cursor and queue', async () => {
  const s = scope(), { epoch } = await initial(s), ticket = await store.reserve(s, epoch);
  const failing = createCheckpointStore({ pool: withCommitFault(false), key });
  await assert.rejects(failing.accept(s, ticket, obs(s, [row({ state: 'resolved' })])), { code: 'checkpoint_unavailable' });
  assert.equal((await read(s)).totals.tasks, 1);
  assert.equal((await store.accept(s, ticket, obs(s, [row({ state: 'resolved' })]))).replay, false);
  assert.equal((await read(s)).totals.tasks, 0);
});
run('real Postgres: lost COMMIT reply is retried safely as an exact replay', async () => {
  const s = scope(), { epoch } = await initial(s), ticket = await store.reserve(s, epoch), input = obs(s, [row({ state: 'resolved' })]);
  const failing = createCheckpointStore({ pool: withCommitFault(true), key });
  await assert.rejects(failing.accept(s, ticket, input), { code: 'checkpoint_unavailable' });
  assert.equal((await store.accept(s, ticket, input)).replay, true); assert.equal((await read(s)).totals.tasks, 0);
});
run('real Postgres: unissued ticket and duplicate task cannot advance state', async () => {
  const s = scope(), { epoch } = await initial(s);
  await assert.rejects(store.accept(s, { epoch, sequence: 999 }, obs(s)), { code: 'invalid_ticket' });
  await assert.rejects(store.accept(s, await store.reserve(s, epoch), obs(s, [row(), row()])), { code: 'duplicate_task' });
  assert.equal((await read(s)).totals.tasks, 1);
});
test('unavailable DB returns a bounded generic error and never an empty success', async () => {
  const broken = createCheckpointStore({ pool: { connect: async () => { throw Error('PRIVATE_PASSWORD'); } }, key });
  await assert.rejects(read({ tenant: 'fixture', dataset: 'dashboard.leads' }, broken), { message: 'checkpoint_unavailable' });
});
test('no authorization means no database access', async () => {
  const blocked = createCheckpointStore({ pool: { connect: async () => { throw Error('must not connect'); } }, key });
  assert.equal(await read({ tenant: 'fixture', dataset: 'dashboard.leads' }, blocked, () => null), null);
});
