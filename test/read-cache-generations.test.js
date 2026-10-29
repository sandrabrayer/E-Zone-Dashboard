'use strict';

/* Read-cache races (review F1/F2, CHANGELOG-crm-read-cache-generations.md):
 *   F1 — an old in-flight read survives bust(): a later read joins it, and its
 *        pre-write answer repopulates the cache.
 *   F2 — invalidation only at write START: a read started during the write
 *        stores a pre-write snapshot that a read-after-save then reuses.
 * These tests FAIL against the pre-fix module (kept as a fixture check below)
 * and pass with generations + settle-time bust. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReadCache } = require('../lib/read-cache');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const KEY = { action: 'getTasks', status: 'open', proxyUserId: 'vered', proxyCaps: ['finance'] };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

/* The interleaving: read A starts → write (bust at start) → write completes (bust at settle) → read B (fresh) → A resolves late. */
async function f1(cache) {
  const a = deferred(); let fresh = 0;
  const pA = cache.get(KEY, () => a.promise);
  cache.bust();                                   // write starts
  cache.bust();                                   // write settled
  const pB = cache.get(KEY, () => { fresh++; return Promise.resolve({ ok: true, v: 'after-save' }); });
  a.resolve({ ok: true, v: 'before-save' });
  const [rA, rB] = await Promise.all([pA, pB]);
  const rC = await cache.get(KEY, () => { fresh++; return Promise.resolve({ ok: true, v: 'after-save-2' }); });
  return { rA: rA.v, rB: rB.v, rC: rC.v, fresh };
}
/* F2: read starts DURING the write (after the start bust), resolves before the write settles; then the write settles; then read-after-save. */
async function f2(cache, settleBust) {
  cache.bust();                                   // write starts
  const during = cache.get(KEY, () => Promise.resolve({ ok: true, v: 'before-save' }));   // the upstream has not committed yet
  await during;
  if (settleBust) cache.bust();                   // the fixed server busts when the write settles; the old one did not
  let fresh = 0;
  const after = await cache.get(KEY, () => { fresh++; return Promise.resolve({ ok: true, v: 'after-save' }); });
  return { after: after.v, fresh };
}

test('F1: a read in flight across a save is never joined and never stores its pre-write answer; the read-after-save fetches fresh', async () => {
  const r = await f1(createReadCache({ ttlMs: 30000 }));
  assert.equal(r.rA, 'before-save', 'the old caller gets what it asked for');
  assert.equal(r.rB, 'after-save', 'the read-after-save never joins the old promise');
  assert.equal(r.rC, 'after-save', 'and the old answer never lands in the cache');
  assert.equal(r.fresh, 1, 'one fresh upstream read, then the fresh answer is cached');
});

test('F2: a read started during the write cannot leave a reusable stale entry once the write settles', async () => {
  const r = await f2(createReadCache({ ttlMs: 30000 }), true);
  assert.equal(r.after, 'after-save'); assert.equal(r.fresh, 1);
});

test('the fixture: both races reproduce on the PRE-FIX module (so the tests above are real regressions)', async () => {
  const oldPath = path.join(__dirname, 'fixtures', 'read-cache-prefix.js');
  const old = require(oldPath);
  const r1 = await f1(old.createReadCache({ ttlMs: 30000 }));
  assert.equal(r1.rB, 'before-save'); assert.equal(r1.rC, 'before-save'); assert.equal(r1.fresh, 0);
  const r2 = await f2(old.createReadCache({ ttlMs: 30000 }), false);
  assert.equal(r2.after, 'before-save'); assert.equal(r2.fresh, 0);
});

test('generations: a newer read completing before an older one wins; the older one\'s cleanup never deletes the newer in-flight entry; an older generation is answered but dropped', async () => {
  const c = createReadCache({ ttlMs: 30000 });
  const a = deferred(), b = deferred();
  const pA = c.get(KEY, () => a.promise);
  c.bust();
  const pB = c.get(KEY, () => b.promise);
  b.resolve({ ok: true, v: 'new' });
  await pB;
  assert.equal((await c.get(KEY, () => Promise.resolve({ ok: true, v: 'x' }))).v, 'new', 'the new answer is cached');
  a.resolve({ ok: true, v: 'old' });
  assert.equal((await pA).v, 'old');
  assert.equal((await c.get(KEY, () => Promise.resolve({ ok: true, v: 'x' }))).v, 'new', 'the late old answer changed nothing');
  assert.equal(c.stats.dropped, 1);
  // the old entry's settle() must not have removed anything newer: a third concurrent read joins the current one
  const d = deferred();
  const p1 = c.get({ action: 'getData', proxyUserId: 'dana', proxyCaps: [] }, () => d.promise);
  c.bust();
  const e = deferred();
  const p2 = c.get({ action: 'getData', proxyUserId: 'dana', proxyCaps: [] }, () => e.promise);
  d.resolve({ ok: true, v: 'old' });
  await p1;
  const p3 = c.get({ action: 'getData', proxyUserId: 'dana', proxyCaps: [] }, () => Promise.resolve({ ok: true, v: 'should-not-fetch' }));
  e.resolve({ ok: true, v: 'current' });
  assert.deepEqual([(await p2).v, (await p3).v], ['current', 'current'], 'p3 joined p2 (current generation), not a fresh fetch');
  assert.equal(c.stats.joined, 1);
});

test('still true after the fix: different actors are separate keys; TTL = 0 disables; expiry refetches; a failed upstream read is never cached; a rejected/ambiguous write busts like a successful one (server wiring)', async () => {
  let t = 0; const c = createReadCache({ ttlMs: 1000, now: () => t });
  const v = { action: 'getData', proxyUserId: 'vered', proxyCaps: ['finance'] }, d = { action: 'getData', proxyUserId: 'dana', proxyCaps: [] };
  assert.equal((await c.get(v, () => Promise.resolve({ ok: true, v: 'v' }))).v, 'v');
  assert.equal((await c.get(d, () => Promise.resolve({ ok: true, v: 'd' }))).v, 'd');
  assert.equal((await c.get(v, () => Promise.resolve({ ok: true, v: 'x' }))).v, 'v');
  t = 1001;
  assert.equal((await c.get(v, () => Promise.resolve({ ok: true, v: 'v2' }))).v, 'v2', 'expired → refetched');
  const k = { action: 'getCredits', proxyUserId: 'vered' };
  assert.deepEqual(await c.get(k, () => Promise.resolve({ ok: false, error: 'boom' })), { ok: false, error: 'boom' });
  assert.deepEqual(await c.get(k, () => Promise.resolve({ ok: true, v: 'v3' })), { ok: true, v: 'v3' }, 'the failure was not stored');
  const off = createReadCache({ ttlMs: 0 }); let n = 0;
  await off.get(v, () => { n++; return Promise.resolve({ ok: true }); }); await off.get(v, () => { n++; return Promise.resolve({ ok: true }); });
  assert.equal(n, 2);
  // server: bust at START and in a finally (settle), on all three write routes
  assert.match(SERVER_SRC, /READ_CACHE\.bust\(\);\s*\/\/ a write STARTS[\s\S]*?finally \{ READ_CACHE\.bust\(\); \}/);
  assert.ok((SERVER_SRC.match(/res\.on\('finish', \(\) => READ_CACHE\.bust\(\)\)/g) || []).length >= 2, 'outpatient-lead + meeting-report settle busts');
});
