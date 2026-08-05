'use strict';

/* Signed session token for the API auth cookie. Node crypto only — no deps.
 *
 * A token is  `<expiry>.<signature>`  where
 *   expiry    = epoch SECONDS at which the token stops being valid
 *   signature = HMAC-SHA256("ezone-session." + expiry, SESSION_SECRET) as hex
 *
 * The server sets this as an HttpOnly cookie on a correct PIN and verifies it on
 * every data request. The secret never leaves the server and is never in the
 * token, so the browser can hold the cookie but cannot forge one. Design notes:
 *   - FAIL-CLOSED: creation refuses an empty/non-string secret, and verification
 *     returns false for an empty secret, a malformed/tampered token, or an
 *     expired one — never throws for the caller to have to guard.
 *   - CONSTANT-TIME signature compare via crypto.timingSafeEqual over the hex
 *     digests (equal length is checked first so it never throws).
 */

const crypto = require('crypto');

const SIGN_PREFIX = 'ezone-session.';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800 (7 days)

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/* HMAC over the documented message. `expiry` is coerced to string so create
 * (number) and verify (string) produce the identical signature. */
function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(SIGN_PREFIX + expiry).digest('hex');
}

/* Build a token valid for ttlSeconds from now (default 7 days). The optional
 * ttlSeconds keeps the documented createSessionToken(secret) shape while letting
 * tests mint an already-expired token (negative ttl). Refuses an empty secret. */
function createSessionToken(secret, ttlSeconds) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('createSessionToken: SESSION_SECRET must be a non-empty string');
  }
  const ttl = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : Math.floor(ttlSeconds);
  const expiry = nowSeconds() + ttl;
  return expiry + '.' + sign(expiry, secret);
}

/* True iff `token` is a well-formed, correctly-signed, unexpired token for
 * `secret`. Returns false (never throws) on any malformed/tampered/expired input
 * or an empty secret. */
function verifySessionToken(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false; // need a non-empty expiry before the dot

  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expiryStr) || sig.length === 0) return false;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return false;
  if (nowSeconds() >= expiry) return false; // expired

  const expected = sign(expiryStr, secret);
  // Equal-length hex digests; check length before timingSafeEqual so a
  // wrong-length (tampered) signature can't make it throw.
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createSessionToken, verifySessionToken, DEFAULT_TTL_SECONDS };
