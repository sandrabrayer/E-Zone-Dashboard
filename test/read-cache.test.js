'use strict';

/* lib/read-cache.js + its wiring in server.js (CHANGELOG-crm-read-cache.md). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReadCache, CACHED_READ_ACTIONS, ttlFromEnv, keyOf } = require('../lib/read-cache');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('only read actions are cached; the key is the body minus the secret with the actor inside; TTL from env (0 disables, capped)', () => {
  assert.ok(CACHED_READ_ACTIONS.includes('getData') && CACHED_READ_ACTIONS.includes('getTasks') && CACHED_READ_ACTIONS.includes('debtAging'));
  for (const w of ['saveAll', 'logContact', 'createTask', 'reportPayment', 'savePayment', 'dischargePatient', 'confirmPayment', 'moveLeadIrrelevant']) assert.ok(!CACHED_READ_ACTIONS.includes(w), w);
  assert.equal(keyOf({ action: 'getData', proxySecret: 'S', proxyUserId: 'dana', proxyCaps: [] }), keyOf({ proxyCaps: [], proxyUserId: 'dana', action: 'getData', proxySecret: 'OTHER' }));
  assert.notEqual(keyOf({ action: 'getData', proxyUserId: 'dana', proxyCaps: [] }), keyOf({ action: 'getData', proxyUserId: 'vered', proxyCaps: ['finance'] }), 'a scoped answer never crosses actors');
  assert.notEqual(keyOf({ action: 'getTasks', status: 'open' }), keyOf({ action: 'getTasks', status: 'done' }));
  assert.equal(ttlFromEnv({}), 30000); assert.equal(ttlFromEnv({ SHEETS_READ_CACHE_MS: '0' }), 0); assert.equal(ttlFromEnv({ SHEETS_READ_CACHE_MS: '9999999' }), 300000); assert.equal(ttlFromEnv({ SHEETS_READ_CACHE_MS: 'x' }), 30000);
});

test('get: a miss fetches; a second read within the TTL is served from memory; concurrent identical reads share ONE upstream call; a different actor fetches again; expiry refetches; failures are never cached; a write busts everything', async () => {
  let t = 1000; let calls = 0;
  const c = createReadCache({ ttlMs: 30000, now: () => t });
  const fetch = (v) => () => { calls++; return Promise.resolve(v); };
  const vered = { action: 'getData', proxyUserId: 'vered', proxyCaps: ['finance'] };
  assert.deepEqual(await c.get(vered, fetch({ ok: true, v: 1 })), { ok: true, v: 1 }); assert.equal(calls, 1);
  assert.deepEqual(await c.get(vered, fetch({ ok: true, v: 2 })), { ok: true, v: 1 }, 'served from memory'); assert.equal(calls, 1);
  const dana = { action: 'getData', proxyUserId: 'dana', proxyCaps: [] };
  assert.deepEqual(await c.get(dana, fetch({ ok: true, v: 'd' })), { ok: true, v: 'd' }); assert.equal(calls, 2);
  // single flight
  const c2 = createReadCache({ ttlMs: 30000, now: () => t });
  let resolve; let n = 0;
  const slow = () => { n++; return new Promise((r) => { resolve = r; }); };
  const p1 = c2.get(vered, slow), p2 = c2.get(vered, slow);
  assert.equal(n, 1, 'one upstream call for two concurrent readers');
  resolve({ ok: true, v: 'x' });
  assert.deepEqual(await Promise.all([p1, p2]), [{ ok: true, v: 'x' }, { ok: true, v: 'x' }]);
  assert.equal(c2.stats.joined, 1);
  // expiry
  t += 30001;
  assert.deepEqual(await c.get(vered, fetch({ ok: true, v: 3 })), { ok: true, v: 3 }); assert.equal(calls, 3);
  // failures are not cached
  assert.deepEqual(await c.get({ action: 'getTasks', proxyUserId: 'vered' }, fetch({ ok: false, error: 'boom' })), { ok: false, error: 'boom' });
  assert.deepEqual(await c.get({ action: 'getTasks', proxyUserId: 'vered' }, fetch({ ok: true, tasks: [] })), { ok: true, tasks: [] }, 'the failure was not kept');
  await assert.rejects(c.get({ action: 'getCredits' }, () => Promise.reject(new Error('net'))), /net/);
  assert.deepEqual(await c.get({ action: 'getCredits' }, fetch({ ok: true })), { ok: true });
  // a write busts
  c.bust();
  assert.deepEqual(await c.get(vered, fetch({ ok: true, v: 4 })), { ok: true, v: 4 });
  assert.equal(c.stats.busts, 1);
  // writes are never cached
  let w = 0;
  await c.get({ action: 'saveAll' }, () => { w++; return Promise.resolve({ ok: true }); });
  await c.get({ action: 'saveAll' }, () => { w++; return Promise.resolve({ ok: true }); });
  assert.equal(w, 2);
  // ttl 0 = off
  const off = createReadCache({ ttlMs: 0 }); let k = 0;
  await off.get(vered, () => { k++; return Promise.resolve({ ok: true }); }); await off.get(vered, () => { k++; return Promise.resolve({ ok: true }); });
  assert.equal(k, 2);
});

test('server wiring: sheetsGet goes through the cache keyed by the FULL upstream body (actor included, secret excluded); every write route busts it', () => {
  assert.match(SERVER_SRC, /const READ_CACHE = createReadCache\(\{ ttlMs: ttlFromEnv\(process\.env\) \}\)/);
  assert.match(SERVER_SRC, /const upstream = buildAppsScriptBody\(body, body\.user, '', principal \|\| NO_PRINCIPAL\);\s*\/\/ the key: no secret\s*return READ_CACHE\.get\(upstream, \(\) => sheetsPost\(body, principal\)\)/);
  const busts = SERVER_SRC.match(/READ_CACHE\.bust\(\)/g) || [];
  assert.ok(busts.length >= 3, 'POST /api/sheets, /api/outpatient-lead, /api/meeting-report/submit');
  assert.match(SERVER_SRC, /console\.log\('\[sheets POST\] →', summary\);\s*READ_CACHE\.bust\(\)/);
});
