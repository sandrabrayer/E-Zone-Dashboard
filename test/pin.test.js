/* Tests for the server-side edit-PIN check — lib/pin.js checkPin().
 *
 * The contract these tests lock:
 *   - a candidate equal to the configured PIN matches;
 *   - any mismatch (wrong value, wrong case, extra/missing chars) does not;
 *   - it is FAIL-CLOSED: an empty expected PIN (i.e. APP_PIN unset) can never
 *     match, and any non-string / empty candidate is rejected without throwing.
 *
 * A throwaway test PIN is used deliberately — the old hardcoded value never
 * appears here, and none of these assertions depend on the real APP_PIN. */

const { test } = require('node:test');
const assert = require('node:assert');
const { checkPin } = require('../lib/pin');

const TEST_PIN = '4815'; // arbitrary; NOT the retired hardcoded value

test('checkPin matches an identical PIN', () => {
  assert.strictEqual(checkPin(TEST_PIN, TEST_PIN), true);
});

test('checkPin rejects a wrong PIN of the same length', () => {
  assert.strictEqual(checkPin('0000', TEST_PIN), false);
});

test('checkPin rejects a PIN with a differing length', () => {
  assert.strictEqual(checkPin(TEST_PIN + '9', TEST_PIN), false);
  assert.strictEqual(checkPin(TEST_PIN.slice(0, 3), TEST_PIN), false);
});

test('checkPin is fail-closed when APP_PIN is unset (expected is empty)', () => {
  // An unconfigured server passes expected === ''. Nothing may match it,
  // including an empty candidate.
  assert.strictEqual(checkPin(TEST_PIN, ''), false);
  assert.strictEqual(checkPin('', ''), false);
  assert.strictEqual(checkPin('anything', ''), false);
});

test('checkPin rejects an empty candidate', () => {
  assert.strictEqual(checkPin('', TEST_PIN), false);
});

test('checkPin rejects non-string candidates without throwing', () => {
  for (const bad of [undefined, null, 4815, {}, [], true, NaN]) {
    assert.strictEqual(checkPin(bad, TEST_PIN), false);
  }
});

test('checkPin rejects non-string expected values without throwing', () => {
  for (const bad of [undefined, null, 4815, {}, []]) {
    assert.strictEqual(checkPin(TEST_PIN, bad), false);
  }
});

test('checkPin returns a real boolean, never a truthy digest', () => {
  assert.strictEqual(typeof checkPin(TEST_PIN, TEST_PIN), 'boolean');
  assert.strictEqual(typeof checkPin('nope', TEST_PIN), 'boolean');
});
