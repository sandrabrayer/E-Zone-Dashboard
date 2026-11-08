'use strict';

/* Session revocation (CHANGELOG-crm-dana-default-switch-user.md).
 *
 * Dashboard session tokens are stateless HMAC tokens (lib/session.js): before
 * this, POST /api/logout only expired the browser's cookie, and a copy of the
 * old value stayed valid until its 7-day expiry. «החלפת משתמש» must end the
 * session on the SERVER, so a logged-out token is remembered here until the
 * moment it would have expired anyway, and every session check refuses it.
 *
 * - The key is the SHA-256 of the token — the token itself is never stored or
 *   logged.
 * - Only a token that already VERIFIED is revoked (server.js checks first), so
 *   an anonymous caller cannot fill the store with junk; `max` bounds it anyway
 *   (oldest entry dropped first).
 * - Per process, in memory: a restart forgets the list. The browser's cookie
 *   is cleared at the same time, so this only matters for a copied token, and
 *   it is documented in DEPLOY.md. Pure apart from the injected clock. */

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 10000;

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function createRevocationStore(opts) {
  const o = opts || {};
  const max = Number.isInteger(o.max) && o.max > 0 ? o.max : DEFAULT_MAX_ENTRIES;
  const now = typeof o.now === 'function' ? o.now : () => Math.floor(Date.now() / 1000);
  const entries = new Map(); // key → expiry (unix seconds)

  function prune() {
    const t = now();
    for (const [k, exp] of entries) if (exp <= t) entries.delete(k);
  }

  /* Remember `token` as logged out until `expirySeconds` (its own expiry). */
  function revoke(token, expirySeconds) {
    if (typeof token !== 'string' || token === '') return false;
    const exp = Number(expirySeconds);
    if (!Number.isFinite(exp) || exp <= now()) return false; // already dead
    prune();
    const k = tokenKey(token);
    entries.delete(k);
    entries.set(k, exp);
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return true;
  }

  function isRevoked(token) {
    if (typeof token !== 'string' || token === '') return false;
    const k = tokenKey(token);
    const exp = entries.get(k);
    if (exp === undefined) return false;
    if (exp <= now()) { entries.delete(k); return false; }
    return true;
  }

  return { revoke, isRevoked, size: () => entries.size };
}

module.exports = { createRevocationStore, DEFAULT_MAX_ENTRIES };
