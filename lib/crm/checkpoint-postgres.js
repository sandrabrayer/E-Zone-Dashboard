'use strict';

// Dormant library, deliberately NOT imported by server.js or the read routes.
// No implicit migration, pool creation, timer, environment read or source I/O.
const { createHash, createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { CheckpointError, scopeKey, normalize, mergeCheckpoint, projectCheckpoint } = require('./checkpoint-state');
const fail = code => { throw new CheckpointError(code); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_operational_checkpoints_v1 (
  scope_key text PRIMARY KEY,
  key_fingerprint text NOT NULL,
  epoch bigint NOT NULL DEFAULT 0,
  issued bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  accepted_hash text,
  payload bytea,
  CHECK (epoch >= 0 AND issued >= 0 AND accepted >= 0 AND accepted <= issued)
);`;

function createCheckpointStore({ pool, key }) {
  if (!pool || typeof pool.connect !== 'function' || !Buffer.isBuffer(key) || key.length !== 32) fail('checkpoint_not_configured');
  const encryptionKey = Buffer.from(key);
  const fingerprint = createHash('sha256').update(encryptionKey).digest('hex');
  function encrypt(scope, data) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(scopeKey(scope)));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), bytes]);
  }
  function decrypt(scope, bytes) {
    if (bytes === null) return null;
    if (!Buffer.isBuffer(bytes) || bytes[0] !== 1 || bytes.length < 30) fail('checkpoint_unavailable');
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(1, 13));
    cipher.setAAD(Buffer.from(scopeKey(scope))); cipher.setAuthTag(bytes.subarray(13, 29));
    const data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'));
    if (data.version !== 1 || !Array.isArray(data.tasks)) fail('checkpoint_unavailable');
    return data;
  }
  function verifyKey(row) { if (row.key_fingerprint !== fingerprint) fail('checkpoint_key_mismatch'); }
  async function transaction(fn) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* connection failed */ } }
      if (error instanceof CheckpointError) throw error;
      fail('checkpoint_unavailable');
    } finally { if (client) client.release(); }
  }
  async function locked(client, scope) {
    const { rows } = await client.query('SELECT * FROM crm_operational_checkpoints_v1 WHERE scope_key=$1 FOR UPDATE', [scopeKey(scope)]);
    if (!rows[0]) fail('checkpoint_not_started');
    verifyKey(rows[0]); return rows[0];
  }
  return {
    // Starting a collector fences ALL prior processes/tickets for this scope.
    // The old payload is retained and authenticated before the epoch advances.
    async start(scope) {
      const id = scopeKey(scope);
      return transaction(async client => {
        await client.query('INSERT INTO crm_operational_checkpoints_v1(scope_key,key_fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, fingerprint]);
        const row = await locked(client, scope); decrypt(scope, row.payload);
        const epoch = Number(row.epoch) + 1;
        if (!integer(epoch)) fail('checkpoint_capacity');
        await client.query('UPDATE crm_operational_checkpoints_v1 SET epoch=$2,issued=0,accepted=0,accepted_hash=NULL WHERE scope_key=$1', [id, epoch]);
        return epoch;
      });
    },
    // Reserve BEFORE requesting a source. Sequence allocation survives restart.
    async reserve(scope, epoch) {
      if (!integer(epoch)) fail('invalid_ticket');
      return transaction(async client => {
        const row = await locked(client, scope);
        if (Number(row.epoch) !== epoch) fail('collector_fenced');
        const sequence = Number(row.issued) + 1;
        if (!integer(sequence)) fail('checkpoint_capacity');
        await client.query('UPDATE crm_operational_checkpoints_v1 SET issued=$2 WHERE scope_key=$1', [scopeKey(scope), sequence]);
        return { epoch, sequence };
      });
    },
    async accept(scope, ticket, input) {
      if (!integer(ticket?.epoch) || !integer(ticket?.sequence)) fail('invalid_ticket');
      const observation = normalize(scope, input);
      const hash = createHash('sha256').update(JSON.stringify(observation)).digest('hex');
      return transaction(async client => {
        const row = await locked(client, scope);
        if (Number(row.epoch) !== ticket.epoch) fail('collector_fenced');
        if (ticket.sequence > Number(row.issued)) fail('invalid_ticket');
        if (ticket.sequence < Number(row.accepted)) fail('out_of_order');
        if (ticket.sequence === Number(row.accepted)) {
          if (row.accepted_hash !== hash) fail('replay_conflict');
          decrypt(scope, row.payload);
          return { accepted: true, replay: true };
        }
        const next = mergeCheckpoint(decrypt(scope, row.payload), observation);
        // Queue AND acceptance cursor commit together; no success precedes COMMIT.
        await client.query('UPDATE crm_operational_checkpoints_v1 SET accepted=$2,accepted_hash=$3,payload=$4 WHERE scope_key=$1',
          [scopeKey(scope), ticket.sequence, hash, encrypt(scope, next)]);
        return { accepted: true, replay: false };
      });
    },
    async read(scope, { authorize, today }) {
      scopeKey(scope);
      if (typeof authorize !== 'function') return null;
      // The caller supplies a CURRENT trusted server policy resolver, never a
      // browser grant. Recheck after async I/O to handle revocation in flight.
      const before = await authorize();
      if (!projectCheckpoint(scope, null, before, today)) return null;
      const checkpoint = await transaction(async client => {
        const { rows } = await client.query('SELECT key_fingerprint,payload FROM crm_operational_checkpoints_v1 WHERE scope_key=$1', [scopeKey(scope)]);
        if (!rows[0]) return null;
        verifyKey(rows[0]); return decrypt(scope, rows[0].payload);
      });
      const after = await authorize();
      if (JSON.stringify(before) !== JSON.stringify(after)) return null;
      return projectCheckpoint(scope, checkpoint, after, today);
    },
  };
}
module.exports = { SCHEMA_SQL, createCheckpointStore };
