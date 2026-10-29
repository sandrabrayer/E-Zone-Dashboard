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
 *  - Any write that goes through this server clears the whole cache (`bust`),
 *    so a user never re-reads a stale answer after her own save.
 *  - Upstream failures are never cached.
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
  const entries = new Map();      // key → { at, data }
  const inflight = new Map();     // key → Promise
  const stats = { hits: 0, misses: 0, joined: 0, busts: 0 };

  function cacheable(action) { return ttl > 0 && CACHED_READ_ACTIONS.indexOf(String(action)) >= 0; }

  /* get(body, fetch) → Promise<data>. `fetch()` performs the upstream call. */
  function get(body, fetch) {
    const action = body && body.action;
    if (!cacheable(action)) return fetch();
    const key = keyOf(body);
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttl) { stats.hits++; return Promise.resolve(hit.data); }
    if (inflight.has(key)) { stats.joined++; return inflight.get(key); }
    stats.misses++;
    let started;
    try { started = Promise.resolve(fetch()); } catch (e) { return Promise.reject(e); }
    const p = started.then((data) => {
      inflight.delete(key);
      if (data && typeof data === 'object' && data.ok !== false) {
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
        entries.set(key, { at: now(), data });
      }
      return data;
    }, (err) => { inflight.delete(key); throw err; });
    inflight.set(key, p);
    return p;
  }
  function bust() { entries.clear(); stats.busts++; }
  function size() { return entries.size; }
  return { get, bust, size, stats, cacheable, keyOf };
}

module.exports = { createReadCache, CACHED_READ_ACTIONS, DEFAULT_TTL_MS, ttlFromEnv, keyOf };
