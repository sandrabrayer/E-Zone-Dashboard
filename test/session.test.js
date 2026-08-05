/* Tests for the signed session token — lib/session.js.
 *
 * Direct require() (a Node module, no browser globals), same as pin.test.js. The
 * contract locked here:
 *   - a freshly created token verifies against the same secret;
 *   - a tampered signature is rejected;
 *   - an expired token is rejected;
 *   - malformed tokens are rejected without throwing;
 *   - creation refuses an empty/undefined secret (fail-closed);
 *   - verification against a wrong secret / empty secret is false.
 *
 * A throwaway secret is used; nothing here depends on the real SESSION_SECRET. */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createSessionToken, verifySessionToken, DEFAULT_TTL_SECONDS } = require('../lib/session');

const SECRET = 'test-secret-do-not-use-in-prod-0123456789abcdef';

test('a freshly created token round-trips (verifies against the same secret)', () => {
  const token = createSessionToken(SECRET);
  assert.strictEqual(verifySessionToken(token, SECRET), true);
});

test('default TTL is 7 days and the token encodes a future expiry', () => {
  assert.strictEqual(DEFAULT_TTL_SECONDS, 7 * 24 * 60 * 60);
  const token = createSessionToken(SECRET);
  const expiry = Number(token.split('.')[0]);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(expiry > now, 'expiry must be in the future');
  assert.ok(expiry <= now + DEFAULT_TTL_SECONDS + 2, 'expiry must be ~now + TTL');
});

test('a token verified against a WRONG secret is rejected', () => {
  const token = createSessionToken(SECRET);
  assert.strictEqual(verifySessionToken(token, SECRET + 'x'), false);
});

test('a tampered signature is rejected', () => {
  const token = createSessionToken(SECRET);
  const [expiry, sig] = token.split('.');
  // Flip the last hex char of the signature.
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
  assert.strictEqual(verifySessionToken(expiry + '.' + flipped, SECRET), false);
});

test('a tampered expiry (re-signed for a different expiry) is rejected', () => {
  // Take a valid token, bump the expiry but keep the OLD signature → mismatch.
  const token = createSessionToken(SECRET);
  const [expiry, sig] = token.split('.');
  const forged = (Number(expiry) + 999999) + '.' + sig;
  assert.strictEqual(verifySessionToken(forged, SECRET), false);
});

test('an expired token is rejected (negative TTL mints one in the past)', () => {
  const expired = createSessionToken(SECRET, -10); // expired 10s ago, validly signed
  assert.strictEqual(verifySessionToken(expired, SECRET), false);
});

test('malformed tokens are rejected without throwing', () => {
  const bad = ['', 'nodot', '.', '.abc', 'abc.', 'notanumber.deadbeef',
    '123', '12.34.56', null, undefined, 42, {}];
  for (const t of bad) {
    assert.doesNotThrow(() => verifySessionToken(t, SECRET));
    assert.strictEqual(verifySessionToken(t, SECRET), false, `should reject: ${String(t)}`);
  }
});

test('creation refuses an empty/undefined secret (fail-closed)', () => {
  assert.throws(() => createSessionToken(''), /non-empty/);
  assert.throws(() => createSessionToken(undefined), /non-empty/);
  assert.throws(() => createSessionToken(null), /non-empty/);
});

test('verification with an empty secret is always false', () => {
  // A token signed with a real secret cannot verify under an empty secret, and
  // an empty secret can never produce a match regardless of the token.
  const token = createSessionToken(SECRET);
  assert.strictEqual(verifySessionToken(token, ''), false);
  assert.strictEqual(verifySessionToken('123.abc', ''), false);
});

test('signature matches the documented HMAC formula', () => {
  // Lock the wire format: HMAC-SHA256("ezone-session." + expiry, secret) hex.
  const token = createSessionToken(SECRET);
  const [expiry, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update('ezone-session.' + expiry).digest('hex');
  assert.strictEqual(sig, expected);
});
