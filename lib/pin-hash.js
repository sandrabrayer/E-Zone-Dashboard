'use strict';

/* Personal-PIN hashing (Phase 0b-3, docs/billing-control-plan.md §11.2).
 * Node crypto only — no dependency.
 *
 * A stored hash is one string:
 *
 *   scrypt$v1$<N>$<r>$<p>$<salt b64url>$<hash b64url>
 *
 * computed as
 *
 *   keyed = HMAC-SHA256(PIN_PEPPER, "ezone-pin.v1." + userId + "." + pin)
 *   hash  = scrypt(keyed, salt, 32 bytes, {N, r, p})
 *
 * Why each part:
 *   - PEPPER: a 6-digit PIN has only 10^6 values, so a leaked hash alone
 *     could be brute-forced offline even through scrypt. The pepper is a
 *     server secret (Railway PIN_PEPPER) that never sits next to the hashes,
 *     so a leaked USER_PIN_HASHES value is useless without it.
 *   - userId in the HMAC: Vered's hash pasted into Sandra's record does not
 *     verify as Sandra.
 *   - per-user random 16-byte SALT: two users with the same PIN get different
 *     hashes.
 *   - scrypt (memory-hard) with the cost parameters stored IN the string, so
 *     they can be raised later without invalidating existing hashes.
 *
 * verifyPinHash is CONSTANT-TIME (crypto.timingSafeEqual over equal-length
 * buffers) and FAIL-CLOSED: any malformed input, a missing pepper or an
 * unparsable hash returns false and never throws. The PIN itself is never
 * logged, returned or stored by anything in this module. */

const crypto = require('crypto');

const HASH_SCHEME = 'scrypt';
const HASH_VERSION = 'v1';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/* Production cost. N = 2^15 needs 32 MiB per hash (128 * N * r bytes). */
const DEFAULT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });
/* The validator refuses anything weaker than this, so a pasted record can
 * never silently downgrade the cost. */
const MIN_N = 16384;
const MAX_N = 1048576;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/* A pepper shorter than this is refused (32 hex chars = 128 bits). */
const MIN_PEPPER_LENGTH = 32;

const PIN_PATTERN = /^\d{6}$/;
const USER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

function isValidPepper(pepper) {
  return typeof pepper === 'string' && pepper.length >= MIN_PEPPER_LENGTH;
}

function keyedPin(userId, pin, pepper) {
  return crypto.createHmac('sha256', pepper)
    .update('ezone-pin.' + HASH_VERSION + '.' + userId + '.' + pin, 'utf8')
    .digest();
}

/* Why a candidate PIN is weak, or '' when it is acceptable. Refused:
 *   format     — not exactly 6 ASCII digits
 *   all_same   — 000000, 111111, …
 *   sequential — every digit is the previous one +1 (012345, 123456, 789012)
 *                or −1 (987654, 543210, 210987), wrapping 9↔0.
 * Pure. Never echoes the PIN. */
function pinWeakness(pin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return 'format';
  const d = pin.split('').map(Number);
  if (d.every((x) => x === d[0])) return 'all_same';
  let up = true;
  let down = true;
  for (let i = 1; i < d.length; i++) {
    if (d[i] !== (d[i - 1] + 1) % 10) up = false;
    if (d[i] !== (d[i - 1] + 9) % 10) down = false;
  }
  if (up || down) return 'sequential';
  return '';
}

/* Hash a PIN for one user. Throws (never returns a weak/unkeyed hash) on a
 * bad user id, a bad pepper or a PIN that is not 6 digits. Weakness is the
 * CALLER's check (pinWeakness) so a test can still hash a known value.
 * `opts.salt` (Buffer) and `opts.params` exist for tests only. */
function hashPin(userId, pin, pepper, opts) {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw new Error('hashPin: invalid user id');
  }
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
    throw new Error('hashPin: the PIN must be exactly 6 digits');
  }
  if (!isValidPepper(pepper)) {
    throw new Error('hashPin: PIN_PEPPER is missing or shorter than ' + MIN_PEPPER_LENGTH + ' characters');
  }
  const o = opts || {};
  const params = Object.assign({}, DEFAULT_PARAMS, o.params || {});
  const salt = Buffer.isBuffer(o.salt) ? o.salt : crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(keyedPin(userId, pin, pepper), salt, KEY_BYTES, {
    N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM,
  });
  return [HASH_SCHEME, HASH_VERSION, params.N, params.r, params.p,
    salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/* Parse a stored hash string, or null. Checks the scheme, the version, the
 * cost bounds and the salt/hash lengths. Pure, never throws. */
function parsePinHash(stored) {
  if (typeof stored !== 'string' || stored.length > 300) return null;
  const parts = stored.split('$');
  if (parts.length !== 7) return null;
  const [scheme, version, nStr, rStr, pStr, saltStr, hashStr] = parts;
  if (scheme !== HASH_SCHEME || version !== HASH_VERSION) return null;
  if (!/^\d{1,8}$/.test(nStr) || !/^\d{1,2}$/.test(rStr) || !/^\d{1,2}$/.test(pStr)) return null;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  // N must be a power of two (scrypt requirement) within bounds.
  if (N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!B64URL.test(saltStr) || !B64URL.test(hashStr)) return null;
  const salt = Buffer.from(saltStr, 'base64url');
  const hash = Buffer.from(hashStr, 'base64url');
  if (salt.length !== SALT_BYTES || hash.length !== KEY_BYTES) return null;
  return { N, r, p, salt, hash };
}

/* True iff `pin` is the PIN behind `stored` for `userId` under `pepper`.
 * Constant-time compare; false (never throws) on anything malformed. */
function verifyPinHash(userId, pin, stored, pepper) {
  try {
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) return false;
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return false;
    if (!isValidPepper(pepper)) return false;
    const parsed = parsePinHash(stored);
    if (!parsed) return false;
    const got = crypto.scryptSync(keyedPin(userId, pin, pepper), parsed.salt, KEY_BYTES, {
      N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM,
    });
    // Both are KEY_BYTES long (parsePinHash checked), so this never throws.
    return crypto.timingSafeEqual(got, parsed.hash);
  } catch (_) {
    return false;
  }
}

module.exports = {
  hashPin,
  verifyPinHash,
  parsePinHash,
  pinWeakness,
  isValidPepper,
  DEFAULT_PARAMS,
  MIN_N,
  MIN_PEPPER_LENGTH,
  USER_ID_PATTERN,
};
