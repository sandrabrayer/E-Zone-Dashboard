'use strict';

/* Fixed-window failure counters for the PIN routes. No deps.
 *
 * WindowCounter is the exact behavior the PIN routes had with their inline
 * Map (a window opens on the first attempt; `max` failures inside it → limited
 * until the window ends; a success deletes the key), plus housekeeping the old
 * Maps lacked:
 *   - expired entries are swept (at most once per window, and whenever the map
 *     reaches maxKeys), so the map cannot grow without bound;
 *   - a hard cap (maxKeys) evicts the oldest entry as a last resort.
 *
 * PinLockout combines three counters for the personal-PIN login (plan §11.2,
 * decision 5): 5 failures per USER → 15-minute lockout, 10 per IP per 15 min,
 * 30 globally per 15 min. Wired into POST /api/verify-pin in PR B: the
 * personal login uses all three; the shared APP_PIN login (dual window) passes
 * userId null, which skips the per-user counter but shares the IP and global
 * ones — so neither path can be used to dodge the other's limits. */

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

class WindowCounter {
  constructor({ max, windowMs, maxKeys } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new Error('WindowCounter: max must be a positive integer');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('WindowCounter: windowMs must be positive');
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : 10000;
    this.map = new Map(); // key -> { count, resetAt }
    this.lastSweep = 0;
  }

  get size() { return this.map.size; }

  /* Drop every entry whose window has ended. */
  sweep(now) {
    const t = now === undefined ? Date.now() : now;
    for (const [k, rec] of this.map) if (t >= rec.resetAt) this.map.delete(k);
    this.lastSweep = t;
  }

  /* The live record for `key`, opening a fresh window when there is none or
   * the old one ended (same semantics as the original inline code). */
  record(key, now) {
    const t = now === undefined ? Date.now() : now;
    if (t - this.lastSweep >= this.windowMs || this.map.size >= this.maxKeys) this.sweep(t);
    let rec = this.map.get(key);
    if (!rec || t >= rec.resetAt) {
      if (!rec && this.map.size >= this.maxKeys) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
      rec = { count: 0, resetAt: t + this.windowMs };
      this.map.set(key, rec);
    }
    return rec;
  }

  /* { limited:false } or { limited:true, retryAfter } (seconds, ≥ 1). */
  check(key, now) {
    const t = now === undefined ? Date.now() : now;
    const rec = this.record(key, t);
    if (rec.count >= this.max) {
      return { limited: true, retryAfter: Math.max(1, Math.ceil((rec.resetAt - t) / 1000)) };
    }
    return { limited: false };
  }

  fail(key, now) { this.record(key, now).count++; }

  reset(key) { this.map.delete(key); }
}

/* The three personal-PIN limits. */
const PIN_LOCKOUT_LIMITS = Object.freeze({
  perUser: { max: 5, windowMs: FIFTEEN_MIN_MS },
  perIp: { max: 10, windowMs: FIFTEEN_MIN_MS },
  global: { max: 30, windowMs: FIFTEEN_MIN_MS },
});

const GLOBAL_KEY = '*';

class PinLockout {
  constructor(limits) {
    const l = limits || PIN_LOCKOUT_LIMITS;
    this.user = new WindowCounter(l.perUser);
    this.ip = new WindowCounter(l.perIp);
    this.global = new WindowCounter(l.global);
  }

  /* { ok:true } or { ok:false, scope:'user'|'ip'|'global', retryAfter }.
   * Checked BEFORE the PIN is verified, so a locked user costs no scrypt.
   * userId null/undefined = a login with no user (the shared APP_PIN): the
   * per-user counter is skipped. */
  check(userId, ip, now) {
    const g = this.global.check(GLOBAL_KEY, now);
    if (g.limited) return { ok: false, scope: 'global', retryAfter: g.retryAfter };
    const i = this.ip.check(String(ip || 'unknown'), now);
    if (i.limited) return { ok: false, scope: 'ip', retryAfter: i.retryAfter };
    if (userId === null || userId === undefined) return { ok: true };
    const u = this.user.check(String(userId || ''), now);
    if (u.limited) return { ok: false, scope: 'user', retryAfter: u.retryAfter };
    return { ok: true };
  }

  recordFailure(userId, ip, now) {
    this.global.fail(GLOBAL_KEY, now);
    this.ip.fail(String(ip || 'unknown'), now);
    if (userId !== null && userId !== undefined) this.user.fail(String(userId || ''), now);
  }

  /* A correct PIN clears that user's and that IP's counters. The global
   * counter is never reset by a success — an attacker holding one valid PIN
   * must not be able to wipe the global brake. */
  recordSuccess(userId, ip) {
    if (userId !== null && userId !== undefined) this.user.reset(String(userId || ''));
    this.ip.reset(String(ip || 'unknown'));
  }
}

module.exports = { WindowCounter, PinLockout, PIN_LOCKOUT_LIMITS, FIFTEEN_MIN_MS };
