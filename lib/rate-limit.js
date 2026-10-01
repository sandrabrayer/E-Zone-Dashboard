'use strict';

/* Fixed-window failure counters for the PIN endpoints. In memory (resets on
 * redeploy, like every other in-memory store in server.js), with BOUNDED size:
 * expired keys are pruned as the map grows, and a hard key cap evicts the
 * oldest window so a flood of distinct keys can never grow memory without
 * limit (the old `pinAttempts` Map was never pruned).
 *
 * Semantics are exactly the old /api/verify-pin counter's:
 *   - blocked(key)  → while count >= max inside the window: { blocked, retryAfter }
 *   - fail(key)     → count one failure (opens a window if none is live)
 *   - reset(key)    → forget the key (a correct PIN)
 * A window opens on the first check or failure and lasts windowMs. */

const DEFAULT_MAX_KEYS = 10000;

class FixedWindowLimiter {
  constructor({ max, windowMs, maxKeys } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new Error('FixedWindowLimiter: max must be a positive integer');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('FixedWindowLimiter: windowMs must be positive');
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : DEFAULT_MAX_KEYS;
    this.map = new Map(); // key -> { count, resetAt }
  }

  get size() { return this.map.size; }

  /* Drop every expired window. */
  prune(now) {
    const t = now === undefined ? Date.now() : now;
    for (const [k, rec] of this.map) {
      if (t >= rec.resetAt) this.map.delete(k);
    }
  }

  /* The live record for key, opening a fresh window when none is live. */
  record(key, now) {
    const t = now === undefined ? Date.now() : now;
    const k = String(key);
    let rec = this.map.get(k);
    if (!rec || t >= rec.resetAt) {
      if (!rec && this.map.size >= this.maxKeys) {
        this.prune(t);
        // Still full: evict the oldest insertion (Map keeps insertion order).
        while (this.map.size >= this.maxKeys) {
          this.map.delete(this.map.keys().next().value);
        }
      }
      rec = { count: 0, resetAt: t + this.windowMs };
      this.map.delete(k); // re-insert so insertion order tracks recency
      this.map.set(k, rec);
    }
    return rec;
  }

  blocked(key, now) {
    const t = now === undefined ? Date.now() : now;
    const rec = this.record(key, t);
    if (rec.count >= this.max) {
      return { blocked: true, retryAfter: Math.max(1, Math.ceil((rec.resetAt - t) / 1000)) };
    }
    return { blocked: false, retryAfter: 0 };
  }

  fail(key, now) {
    const rec = this.record(key, now);
    rec.count++;
    return rec.count;
  }

  reset(key) {
    this.map.delete(String(key));
  }
}

/* The personal-PIN login limiter (decided 01/10/2026): 5 failures per USER,
 * 10 per IP, 30 across everyone, each per 15 minutes. A request is refused
 * when ANY of the three is exhausted. A correct PIN resets that user's and
 * that IP's counters, never the global one.
 *
 * BUILT, NOT WIRED in PR A — /api/verify-pin keeps its exact behaviour until
 * PR B adds the name + PIN login. */
const LOGIN_LIMITS = Object.freeze({
  perUser: Object.freeze({ max: 5, windowMs: 15 * 60 * 1000 }),
  perIp: Object.freeze({ max: 10, windowMs: 15 * 60 * 1000 }),
  global: Object.freeze({ max: 30, windowMs: 15 * 60 * 1000 }),
});

function createLoginLimiter(limits) {
  const l = limits || LOGIN_LIMITS;
  const user = new FixedWindowLimiter(l.perUser);
  const ip = new FixedWindowLimiter(l.perIp);
  const global = new FixedWindowLimiter(l.global);
  return {
    /* → { blocked:false } or { blocked:true, scope:'user'|'ip'|'global', retryAfter } */
    check({ userId, ip: addr }, now) {
      const checks = [['user', user, userId], ['ip', ip, addr], ['global', global, '*']];
      for (const [scope, lim, key] of checks) {
        const b = lim.blocked(key, now);
        if (b.blocked) return { blocked: true, scope, retryAfter: b.retryAfter };
      }
      return { blocked: false };
    },
    failure({ userId, ip: addr }, now) {
      user.fail(userId, now);
      ip.fail(addr, now);
      global.fail('*', now);
    },
    success({ userId, ip: addr }) {
      user.reset(userId);
      ip.reset(addr);
    },
    _limiters: { user, ip, global },
  };
}

module.exports = { FixedWindowLimiter, createLoginLimiter, LOGIN_LIMITS };
