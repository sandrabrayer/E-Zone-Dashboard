'use strict';

/* Signed session token for the API auth cookie. Node crypto only — no deps.
 *
 * A token is  `<expiry>.<signature>`  where
 *   expiry    = epoch SECONDS at which the token stops being valid
 *   signature = HMAC-SHA256("ezone-session." + expiry, SESSION_SECRET) as hex
 *
 * USER-BEARING variant (who/when stamping): `<expiry>.<userB64>.<signature>`
 * where userB64 is base64url(UTF-8 user name) and the signature covers
 * "<expiry>.<userB64>" — the name rides INSIDE the signed payload, so it is
 * tamper-proof (any edit breaks the HMAC) and never a separate cookie.
 * Legacy 2-part tokens keep validating unchanged; the two formats cannot be
 * confused (a legacy signing message ends in digits only, a user-bearing one
 * always contains the '.' + base64url part).
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
 * (number) and verify (string) produce the identical signature.
 *
 * `scope` (optional) partitions token families sharing one SESSION_SECRET: a
 * scoped token signs "ezone-session.<scope>.<expiry>" so it can NEVER verify
 * under a different scope (or under the default no-scope family). This is what
 * keeps the meeting-report cookie and the main-app cookie from unlocking each
 * other's routes despite both being signed with SESSION_SECRET. The default ''
 * signs the original message, so every pre-existing main-app cookie stays
 * valid. */
function sign(payload, secret, scope) {
  const scopePart = scope ? scope + '.' : '';
  return crypto.createHmac('sha256', secret).update(SIGN_PREFIX + scopePart + payload).digest('hex');
}

/* Build a token valid for ttlSeconds from now (default 7 days). The optional
 * ttlSeconds keeps the documented createSessionToken(secret) shape while letting
 * tests mint an already-expired token (negative ttl). The optional `scope`
 * binds the token to a named token family (see sign). The optional `user`
 * (non-empty string) embeds a tamper-proof user name — see the user-bearing
 * format above; omitted/empty keeps the legacy 2-part format byte-for-byte.
 * Refuses an empty secret. */
function createSessionToken(secret, ttlSeconds, scope, user) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('createSessionToken: SESSION_SECRET must be a non-empty string');
  }
  const ttl = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : Math.floor(ttlSeconds);
  const expiry = nowSeconds() + ttl;
  if (typeof user === 'string' && user.length > 0) {
    const userB64 = Buffer.from(user, 'utf8').toString('base64url');
    const payload = expiry + '.' + userB64;
    return payload + '.' + sign(payload, secret, scope);
  }
  return expiry + '.' + sign(String(expiry), secret, scope);
}

/* Split a token into its verified parts, or null. Shared by verify + read:
 * accepts BOTH formats (legacy `<expiry>.<sig>` and user-bearing
 * `<expiry>.<userB64>.<sig>`), checks shape, expiry, and the constant-time
 * signature compare. Never throws. */
function parseVerified(token, secret, scope) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const expiryStr = parts[0];
  const userB64 = parts.length === 3 ? parts[1] : '';
  const sig = parts[parts.length - 1];
  if (!/^\d+$/.test(expiryStr) || sig.length === 0) return null;
  if (parts.length === 3 && !/^[A-Za-z0-9_-]+$/.test(userB64)) return null;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return null;
  if (nowSeconds() >= expiry) return null; // expired

  const payload = parts.length === 3 ? expiryStr + '.' + userB64 : expiryStr;
  const expected = sign(payload, secret, scope);
  // Equal-length hex digests; check length before timingSafeEqual so a
  // wrong-length (tampered) signature can't make it throw.
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let user = '';
  if (userB64) {
    try { user = Buffer.from(userB64, 'base64url').toString('utf8'); } catch (_) { return null; }
  }
  return { expiry, user };
}

/* True iff `token` is a well-formed, correctly-signed, unexpired token for
 * `secret` in the given `scope` family (default: the original no-scope family).
 * Returns false (never throws) on any malformed/tampered/expired input, an
 * empty secret, or a scope mismatch. */
function verifySessionToken(token, secret, scope) {
  return parseVerified(token, secret, scope) !== null;
}

/* The user name embedded in a VERIFIED token, '' for a legacy token without
 * one or for any token that fails verification. Never throws — safe to call
 * on raw cookie input. */
function readSessionUser(token, secret, scope) {
  const parsed = parseVerified(token, secret, scope);
  return parsed ? parsed.user : '';
}

module.exports = { createSessionToken, verifySessionToken, readSessionUser, DEFAULT_TTL_SECONDS };
