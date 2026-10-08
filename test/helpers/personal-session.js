'use strict';

/* Test helper (not a test): personal-PIN records and cookies.
 *
 * Since personal PINs PR C (2026-10-04) the shared APP_PIN is gone and a
 * cookie without a personal id is 401 everywhere, so every server test that
 * needs a session uses a PERSONAL one: a real USER_PIN_HASHES record (the
 * exact lib/users.js recordLine shape, a real scrypt hash of TEST_PIN under
 * TEST_PEPPER) and the cookie the login would mint for it.
 *
 * Synchronous on purpose (crypto.scryptSync with the lib/pin-hash.js
 * parameters), so a test file can set process.env.USER_PIN_HASHES BEFORE it
 * requires server.js. node --test also loads this file; it defines no test. */

const crypto = require('node:crypto');
const users = require('../../lib/users');
const { createSessionToken } = require('../../lib/session');

const TEST_PIN = '583920';
const TEST_PEPPER = 'pepper-TEST-personal-session-0123456789abcdef0123456789ab';

/* lib/pin-hash.js hashPin, synchronously: scrypt(HMAC-SHA256(pepper, pin)). */
function hashPinSync(pin, pepper) {
  const salt = crypto.randomBytes(16);
  const input = crypto.createHmac('sha256', pepper).update(pin, 'utf8').digest();
  const key = crypto.scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

let HASH;
/* The USER_PIN_HASHES value for `ids` (default: the four active users), each
 * record exactly as the «קוד אישי חדש» page prints it, pinVersion 1. */
function userPinHashes(ids) {
  if (!HASH) HASH = hashPinSync(TEST_PIN, TEST_PEPPER);
  const list = ids || ['sandra', 'vered', 'shiran', 'yael'];
  return JSON.stringify(list.map((id) => JSON.parse(users.recordLine(id, HASH, 1))));
}

/* The signed personal session token for `id` (pinVersion 1) — what
 * POST /api/verify-pin { userId, pin } mints. */
function personalToken(secret, id, ttlSeconds) {
  const model = users.modelById(id);
  if (!model) throw new Error('personalToken: unknown id ' + id);
  return createSessionToken(secret, ttlSeconds, undefined, model.name, { id, pinVersion: 1 });
}

/* "ezone_session=<token>" for a Cookie header. */
function personalCookie(secret, id, ttlSeconds) {
  return 'ezone_session=' + personalToken(secret, id, ttlSeconds);
}

/* The retired shared APP_PIN cookie shape (no personal id): 401 since PR C. */
function sharedCookie(secret, name) {
  return 'ezone_session=' + createSessionToken(secret, undefined, undefined, name || '');
}

/* Set the env a personal session needs, before server.js is required. */
function applyPersonalEnv(env) {
  const e = env || process.env;
  e.USER_PIN_HASHES = userPinHashes();
  e.PIN_PEPPER = TEST_PEPPER;
  return e;
}

module.exports = {
  TEST_PIN,
  TEST_PEPPER,
  hashPinSync,
  userPinHashes,
  personalToken,
  personalCookie,
  sharedCookie,
  applyPersonalEnv,
};
