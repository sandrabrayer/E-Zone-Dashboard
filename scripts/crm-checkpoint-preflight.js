'use strict';

// Explicit operator-only inspection; never imported or exposed by the app.
// Same v1 envelope as checkpoint-postgres.js. Decrypt only in process memory;
// return counts, never task records, identifiers, keys or raw exception text.
const { createHash, createDecipheriv } = require('node:crypto');
const { scopeKey } = require('../lib/crm/checkpoint-state');
async function inspectCrmCheckpoint({ pool, key, scope }) {
  let client;
  try {
    const id = scopeKey(scope);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('invalid_key');
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows } = await client.query('SELECT key_fingerprint,payload FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [id]);
    const row = rows[0]; let tasks = [];
    if (row) {
      if (row.key_fingerprint !== createHash('sha256').update(key).digest('hex')) throw Error('wrong_key');
      if (row.payload !== null) {
        const bytes = row.payload;
        if (!Buffer.isBuffer(bytes) || bytes[0] !== 1 || bytes.length < 30) throw Error('bad_envelope');
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
        cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(bytes.subarray(13, 29));
        const data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'));
        if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.some(t => typeof t?.closed !== 'boolean')) throw Error('bad_state');
        tasks = data.tasks;
      }
    }
    const closed = tasks.filter(t => t.closed).length;
    await client.query('COMMIT');
    return { contract: 'crm-checkpoint-preflight-v1', measuredAt: new Date().toISOString(),
      available: true, provisioned: !!row, hasSnapshot: !!row && row.payload !== null,
      totalTasks: tasks.length, openTasks: tasks.length - closed, closedTasks: closed, capacity: 25000 };
  } catch (_) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* bounded result only */ } }
    return { contract: 'crm-checkpoint-preflight-v1', available: false, error: 'checkpoint_inspection_unavailable' };
  } finally { if (client) client.release(); }
}
module.exports = { inspectCrmCheckpoint };
