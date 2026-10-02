'use strict';

/* Personal-PIN hashing (docs/billing-control-plan.md §11.2, PR A — foundation).
 * Node crypto only — no deps. Nothing here is wired to a login route yet.
 *
 * Stored format (one string per user, inside USER_PIN_HASHES):
 *
 *     scrypt$<N>$<r>$<p>$<saltB64url>$<keyB64url>
 *
 *   salt — 16 random bytes, fresh per user (and per reset)
 *   key  — scrypt(HMAC-SHA256(PIN_PEPPER, pin), salt, 32 bytes)
 *
 * The PEPPER is a Railway variable that is never stored next to the hashes,
 * so a leaked USER_PIN_HASHES value alone cannot be brute-forced offline
 * (a 6-digit PIN space is only 10^6).
 *
 * Design rules:
 *   - FAIL-CLOSED: no pepper → hashPin throws, verifyPin returns false.
 *   - CONSTANT-WORK: verifyPin ALWAYS runs exactly one scrypt derivation, even
 *     for a malformed/missing stored hash or a non-string candidate, so the
 *     response time does not reveal whether a user/record exists.
 *   - CONSTANT-TIME compare via crypto.timingSafeEqual on equal-length keys.
 *   - The PIN is never logged, returned or stored anywhere by this module. */

const crypto = require('crypto');

const SCRYPT_N = 16384;      // 2^14 — ~16 MB, well inside Node's default maxmem
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const PIN_LENGTH = 6;
const HASH_PREFIX = 'scrypt';

/* A fixed dummy record used to keep verifyPin's work constant when the stored
 * hash is missing or malformed. Its key can never match (all zero bytes are not
 * a possible scrypt output for practical purposes, and the result is discarded). */
const DUMMY_SALT = Buffer.alloc(SALT_LEN, 0);
const DUMMY_KEY = Buffer.alloc(KEY_LEN, 0);

/* Test hook: how many scrypt derivations ran. Lets the constant-work guard be
 * asserted without timing measurements. Never read by production code. */
const stats = { derivations: 0 };

function pepperOk(pepper) {
  return typeof pepper === 'string' && pepper.length > 0;
}

/* HMAC the PIN with the pepper before scrypt. A non-string candidate is
 * treated as '' so the work stays constant; the caller has already decided
 * the result is false in that case. */
function pepperedInput(pin, pepper) {
  const p = typeof pin === 'string' ? pin : '';
  const k = pepperOk(pepper) ? pepper : '\u0000no-pepper';
  return crypto.createHmac('sha256', k).update(p, 'utf8').digest();
}

function derive(input, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    stats.derivations++;
    crypto.scrypt(input, salt, KEY_LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

/* Parse a stored hash string → { n, r, p, salt, key } or null. Only the exact
 * parameters this module writes are accepted, so a tampered record can neither
 * downgrade the work factor nor request an absurd one (memory DoS). */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length !== SALT_LEN || key.length !== KEY_LEN) return null;
  return { n, r, p, salt, key };
}

function isWellFormedHash(stored) {
  return parseHash(stored) !== null;
}

/* Hash a PIN for storage. Throws on a missing pepper or a PIN that is not a
 * non-empty string — callers validate the PIN policy (pinPolicyError) first. */
async function hashPin(pin, pepper) {
  if (!pepperOk(pepper)) throw new Error('hashPin: PIN_PEPPER must be a non-empty string');
  if (typeof pin !== 'string' || pin.length === 0) throw new Error('hashPin: pin must be a non-empty string');
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await derive(pepperedInput(pin, pepper), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [HASH_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/* true iff `pin` matches `stored` under `pepper`. Never throws; always runs one
 * derivation (see CONSTANT-WORK above). */
async function verifyPin(pin, stored, pepper) {
  const parsed = parseHash(stored);
  const usable = parsed !== null && typeof pin === 'string' && pin.length > 0 && pepperOk(pepper);
  const salt = parsed ? parsed.salt : DUMMY_SALT;
  const expected = parsed ? parsed.key : DUMMY_KEY;
  let got;
  try {
    got = await derive(pepperedInput(pin, pepper), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  } catch (_) {
    return false;
  }
  // Both buffers are KEY_LEN bytes by construction, so this never throws.
  const same = crypto.timingSafeEqual(got, expected);
  return usable && same;
}

/* Weak-PIN policy. '' when acceptable, otherwise a stable reason code:
 *   not_six_digits — anything but exactly 6 ASCII digits
 *   all_same       — 000000, 111111, …
 *   sequential     — every step +1 (123456, 345678) or −1 (654321, 987654)
 * 000000 and 123456 are covered by the rules above. */
function pinPolicyError(pin) {
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return 'not_six_digits';
  const d = pin.split('').map(Number);
  if (d.every((x) => x === d[0])) return 'all_same';
  let up = true;
  let down = true;
  for (let i = 1; i < d.length; i++) {
    if (d[i] !== d[i - 1] + 1) up = false;
    if (d[i] !== d[i - 1] - 1) down = false;
  }
  if (up || down) return 'sequential';
  return '';
}

module.exports = {
  hashPin,
  verifyPin,
  pinPolicyError,
  isWellFormedHash,
  PIN_LENGTH,
  SALT_LEN,
  SCRYPT_N,
  stats,
};
