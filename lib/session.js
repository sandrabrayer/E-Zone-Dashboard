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
 * PERSONAL variant (personal PINs, plan §11.2 — PR A builds it, no route mints
 * it yet): `<expiry>.<userB64>.<id>-<pinVersion>.<signature>` where id is the
 * user's stable ASCII id (lib/users.js) and pinVersion a positive integer. The
 * signature covers all three payload parts. Resetting a PIN (pinVersion++) or
 * revoking a user (status) invalidates every older personal cookie — the
 * server compares both against USER_PIN_HASHES on every request. A token's
 * part count fixes its format, so no format can be re-read as another.
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
const PERSONAL_ID_RE = /^[a-z][a-z0-9]{0,31}$/;
const PERSONAL_PART_RE = /^([a-z][a-z0-9]{0,31})-([1-9][0-9]{0,8})$/;

function createSessionToken(secret, ttlSeconds, scope, user, ident) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('createSessionToken: SESSION_SECRET must be a non-empty string');
  }
  const ttl = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : Math.floor(ttlSeconds);
  const expiry = nowSeconds() + ttl;
  if (ident !== undefined && ident !== null) {
    // Personal token: id + pinVersion are mandatory and strictly shaped.
    if (!ident || !PERSONAL_ID_RE.test(String(ident.id)) ||
        !Number.isInteger(ident.pinVersion) || ident.pinVersion < 1 || ident.pinVersion > 999999999) {
      throw new Error('createSessionToken: a personal token needs a valid { id, pinVersion }');
    }
    const userB64 = Buffer.from(typeof user === 'string' ? user : '', 'utf8').toString('base64url');
    const payload = expiry + '.' + userB64 + '.' + ident.id + '-' + ident.pinVersion;
    return payload + '.' + sign(payload, secret, scope);
  }
  if (typeof user === 'string' && user.length > 0) {
    const userB64 = Buffer.from(user, 'utf8').toString('base64url');
    const payload = expiry + '.' + userB64;
    return payload + '.' + sign(payload, secret, scope);
  }
  return expiry + '.' + sign(String(expiry), secret, scope);
}

/* Split a token into its verified parts, or null. Shared by verify + read:
 * accepts ALL THREE formats (legacy `<expiry>.<sig>`, user-bearing
 * `<expiry>.<userB64>.<sig>` and personal `<expiry>.<userB64>.<id>-<v>.<sig>`),
 * checks shape, expiry, and the constant-time signature compare. Never throws. */
function parseVerified(token, secret, scope) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 2 && parts.length !== 3 && parts.length !== 4) return null;
  const expiryStr = parts[0];
  const userB64 = parts.length >= 3 ? parts[1] : '';
  const identStr = parts.length === 4 ? parts[2] : '';
  const sig = parts[parts.length - 1];
  if (!/^\d+$/.test(expiryStr) || sig.length === 0) return null;
  if (parts.length === 3 && !/^[A-Za-z0-9_-]+$/.test(userB64)) return null;
  // A personal token may carry an empty name part; its id is what counts.
  if (parts.length === 4 && !/^[A-Za-z0-9_-]*$/.test(userB64)) return null;
  const identMatch = parts.length === 4 ? PERSONAL_PART_RE.exec(identStr) : null;
  if (parts.length === 4 && !identMatch) return null;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return null;
  if (nowSeconds() >= expiry) return null; // expired

  const payload = parts.length === 4 ? expiryStr + '.' + userB64 + '.' + identStr
    : parts.length === 3 ? expiryStr + '.' + userB64 : expiryStr;
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
  if (identMatch) {
    return { expiry, user, id: identMatch[1], pinVersion: Number(identMatch[2]), auth: 'personal' };
  }
  return { expiry, user, id: '', pinVersion: 0, auth: 'shared' };
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

/* The full verified session — { expiry, user, id, pinVersion, auth } with
 * auth 'personal' (id + pinVersion set) or 'shared' (no id: the retired
 * APP_PIN format — the dashboard refuses it since PR C — and the
 * meeting-report scope's own cookie) — or
 * null for anything that fails verification. Never throws. Whether a personal
 * session is still CURRENT (record active, same pinVersion) is decided by the
 * caller against USER_PIN_HASHES (lib/users.js resolvePrincipal). */
function readSession(token, secret, scope) {
  return parseVerified(token, secret, scope);
}

module.exports = { createSessionToken, verifySessionToken, readSessionUser, readSession, DEFAULT_TTL_SECONDS };
