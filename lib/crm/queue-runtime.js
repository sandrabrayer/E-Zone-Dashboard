'use strict';

// Explicit configuration only: never borrow the read-model database/key. No
// connection, migration, epoch claim, source call or timer occurs at import.
const { createCheckpointStore } = require('./checkpoint-postgres');
function queueConfig(env) {
  if (env.CRM_QUEUE_ENABLED !== '1' || env.CRM_READS !== '1') return null;
  try {
    const url = new URL(env.CRM_QUEUE_DATABASE_URL);
    const key = Buffer.from(env.CRM_QUEUE_KEY || '', 'base64');
    const epoch = Number(env.CRM_QUEUE_EPOCH);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(env.CRM_QUEUE_TENANT || '') ||
        key.length !== 32 || key.toString('base64') !== env.CRM_QUEUE_KEY ||
        !/^[1-9]\d*$/.test(env.CRM_QUEUE_EPOCH || '') || !Number.isSafeInteger(epoch)) return null;
    return { scope: { tenant: env.CRM_QUEUE_TENANT, dataset: 'dashboard.leads' }, epoch, key, connectionString: url.href };
  } catch (_) { return null; }
}
function createQueueRuntime(env) {
  const config = queueConfig(env);
  let pool, store;
  return {
    enabled: !!config,
    scope: config?.scope,
    epoch: config?.epoch,
    getStore() {
      if (!config) throw Error('crm_queue_disabled');
      if (!store) {
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: config.connectionString, max: 3,
          connectionTimeoutMillis: 5000, query_timeout: 15000, idleTimeoutMillis: 30000 });
        // Idle client failures must not crash the host or log DB credentials.
        pool.on('error', () => {});
        store = createCheckpointStore({ pool, key: config.key });
      }
      return store;
    },
    async close() { if (pool) await pool.end(); },
  };
}
module.exports = { queueConfig, createQueueRuntime };
