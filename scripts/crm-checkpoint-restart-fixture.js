'use strict';

// CI-only synthetic recovery fixture. Never use DATABASE_URL or production keys.
const { Pool } = require('pg');
const { SCHEMA_SQL, createCheckpointStore } = require('../lib/crm/checkpoint-postgres');
const connectionString = process.env.CRM_TEST_POSTGRES_URL;
const target = new URL(connectionString || 'https://invalid.example');
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/crm_checkpoint_test') throw Error('fixture database required');
const action = process.argv[2];
if (!['seed', 'verify'].includes(action)) throw Error('expected seed or verify');
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
const scope = { tenant: 'synthetic-db-restart', dataset: 'dashboard.leads' };
const key = Buffer.alloc(32, 37); // Public fixture key: never a runtime default.
const store = createCheckpointStore({ pool, key });
async function main() {
  try {
    if (action === 'seed') {
      await pool.query(SCHEMA_SQL);
      const epoch = await store.start(scope), ticket = await store.reserve(scope, epoch);
      await store.accept(scope, ticket, { dataset: scope.dataset, health: 'fresh', complete: true, observedAt: '2026-10-13T16:00:00.000Z', records: [
        { nativeRecordId: 'synthetic-restart-row', identityKind: 'row', reason: 'lead_followup', state: 'active',
          displayName: 'Synthetic restart fixture', assignee: null, dueBasis: 'source', originalDueDate: '2026-10-01' },
      ] });
      console.log('Synthetic checkpoint committed before database restart.');
    } else {
      const result = await store.read(scope, { today: '2026-10-13', authorize: () => ({ ...scope, allRecords: true, showName: false, policyRevision: 'fixture' }) });
      if (result.totals.tasks !== 1 || result.rows[0].originalDueDate !== '2026-10-01' || result.rows[0].displayName !== null) throw Error('checkpoint did not survive restart');
      const epoch = await store.start(scope);
      await store.accept(scope, await store.reserve(scope, epoch), { dataset: scope.dataset, health: 'unavailable', complete: false, observedAt: null, records: [] });
      const retained = await store.read(scope, { today: '2026-10-13', authorize: () => ({ ...scope, allRecords: true, policyRevision: 'fixture' }) });
      if (retained.totals.tasks !== 1 || retained.rows[0].uncertainty !== 'source_unavailable') throw Error('outage lost recovered checkpoint');
      console.log('Database/process restart verified; source outage retains the task and original deadline.');
    }
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Synthetic checkpoint restart verification failed.'); process.exitCode = 1; });
