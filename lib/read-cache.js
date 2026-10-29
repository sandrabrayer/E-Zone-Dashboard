'use strict';

/* Short read-through cache for Apps Script READS (CHANGELOG-crm-read-cache.md).
 *
 * Why: every CRM screen is built from 3–6 Apps Script reads of 2–8 s each, and
 * switching areas (or two tabs) repeated them. Apps Script is the slow part,
 * not Railway. A read answered in the last TTL_MS from the SAME key is served
 * from memory; concurrent identical reads share ONE upstream call (single
 * flight).
 *
 * Safety rules:
 *  - Only the listed READ actions are cached. Writes never are.
 *  - The key is the whole upstream body minus the secret — action, every
 *    parameter, and the verified actor (id, auth, roles, caps) — so a scoped
 *    answer (Dana's getData without money, Ortal's money tasks) can never be
 *    served to another actor or another scope.
 *  - Any write that goes through this server clears the whole cache (`bust`)
 *    at its START and again when it SETTLES (success, refusal, or an ambiguous
 *    failure where the upstream may have committed), so a user never re-reads
 *    a stale answer after her own save.
 *  - GENERATIONS (CHANGELOG-crm-read-cache-generations.md): `bust` advances a
 *    generation counter. A read that started in an older generation can
 *    neither be joined by a newer read nor store its (possibly pre-write)
 *    answer; its late cleanup never deletes a newer in-flight read of the
 *    same key. So a read in flight across a save cannot resurrect old data.
 *  - Upstream failures are never cached.
 *  - Bounded staleness that stays: a write made by ANOTHER app directly in
 *    Sheets (managers, therapists, outpatient) is seen up to TTL late; and
 *    the cache is per Node process — with more than one Railway replica a
 *    bust on one replica is not a bust on the other (today: one replica).
 *  - TTL default 30 s; `SHEETS_READ_CACHE_MS=0` disables (an env knob only —
 *    nothing to set for the default). Pure module; the clock is injectable. */

const CACHED_READ_ACTIONS = Object.freeze([
  'getData', 'getTasks', 'contactIndex', 'getActivity', 'debtAging', 'getPayments', 'getCredits',
  'billingControlQueue', 'expectedDischarges', 'upcomingCommittees', 'refundPayoutForecast', 'cleanupReport',
]);
const DEFAULT_TTL_MS = 30000;
const MAX_ENTRIES = 200;

function ttlFromEnv(env) {
  const raw = env && env.SHEETS_READ_CACHE_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300000) : DEFAULT_TTL_MS;
}

/* The cache key: a stable JSON of the body with the secret removed and keys sorted. */
function keyOf(body) {
  const b = Object.assign({}, body || {});
  delete b.proxySecret; delete b.secret;
  const sorted = {};
  Object.keys(b).sort().forEach((k) => { sorted[k] = b[k]; });
  return JSON.stringify(sorted);
}

function createReadCache(opts) {
  const o = opts || {};
  const ttl = o.ttlMs !== undefined ? o.ttlMs : DEFAULT_TTL_MS;
  const now = o.now || (() => Date.now());
  const entries = new Map();      // key → { at, data, gen }
  const inflight = new Map();     // key → { gen, promise }
  const stats = { hits: 0, misses: 0, joined: 0, busts: 0, dropped: 0 };
  let gen = 0;                    // advanced by every bust

  function cacheable(action) { return ttl > 0 && CACHED_READ_ACTIONS.indexOf(String(action)) >= 0; }

  /* get(body, fetch) → Promise<data>. `fetch()` performs the upstream call. */
  function get(body, fetch) {
    const action = body && body.action;
    if (!cacheable(action)) return fetch();
    const key = keyOf(body);
    const hit = entries.get(key);
    if (hit && hit.gen === gen && now() - hit.at < ttl) { stats.hits++; return Promise.resolve(hit.data); }
    const running = inflight.get(key);
    if (running && running.gen === gen) { stats.joined++; return running.promise; }   // an older generation is never joined
    stats.misses++;
    const myGen = gen;
    let started;
    try { started = Promise.resolve(fetch()); } catch (e) { return Promise.reject(e); }
    const entry = { gen: myGen, promise: null };
    const settle = () => { if (inflight.get(key) === entry) inflight.delete(key); };   // never delete a newer read of the same key
    entry.promise = started.then((data) => {
      settle();
      if (myGen !== gen) { stats.dropped++; return data; }                              // started before a write: answer the caller, store nothing
      if (data && typeof data === 'object' && data.ok !== false) {
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
        entries.set(key, { at: now(), data, gen: myGen });
      }
      return data;
    }, (err) => { settle(); throw err; });
    inflight.set(key, entry);
    return entry.promise;
  }
  /* A write started or settled: forget every stored answer and orphan every read in flight. */
  function bust() { entries.clear(); gen++; stats.busts++; }
  function generation() { return gen; }
  function size() { return entries.size; }
  return { get, bust, size, stats, cacheable, keyOf, generation };
}

module.exports = { createReadCache, CACHED_READ_ACTIONS, DEFAULT_TTL_MS, ttlFromEnv, keyOf };
