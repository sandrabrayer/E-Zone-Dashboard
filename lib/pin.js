'use strict';

/* Server-side edit-PIN check. The PIN never ships to the browser; the client
 * POSTs a candidate to /api/verify-pin and this module decides.
 *
 * checkPin(candidate, expected) is:
 *   - FAIL-CLOSED: any missing / empty / non-string argument returns false,
 *     so an unconfigured APP_PIN (expected === '') can never match, and a
 *     malformed request body can never be coerced into a match.
 *   - CONSTANT-TIME: both sides are SHA-256 hashed to a fixed 32-byte digest
 *     and compared with crypto.timingSafeEqual. Hashing first means the
 *     comparison length is independent of the inputs, so neither the PIN's
 *     length nor how many leading characters matched leaks through timing.
 */

const crypto = require('crypto');

function checkPin(candidate, expected) {
  // Fail closed on anything that isn't a non-empty string on BOTH sides.
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;

  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();

  // Digests are always 32 bytes, so timingSafeEqual never throws on length.
  return crypto.timingSafeEqual(a, b);
}

module.exports = { checkPin };
