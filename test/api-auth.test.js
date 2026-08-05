/* Tests for the API session-auth layer in server.js:
 *   - parseSessionCookie / sessionAuthStatus / buildSessionCookie / requestIsHttps
 *     (pure helpers), and the requireSession Express middleware.
 *
 * server.js only calls app.listen when run as the main module, so it is safe to
 * require() here and exercise the exported helpers (same approach as
 * getpayments-502-fix.test.js). SESSION_SECRET is read from env at require time,
 * so it is set BEFORE the require below; the fail-closed (unset) branch is
 * covered by re-requiring with a fresh module cache. */

const { test } = require('node:test');
const assert = require('node:assert');

const SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET; // must be set before server.js is required

const { createSessionToken } = require('../lib/session');
const server = require('../server');

function mkRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
function cookieHeader(token) { return token == null ? undefined : `ezone_session=${token}`; }

/* ===== parseSessionCookie ===== */

test('parseSessionCookie extracts the session token among other cookies', () => {
  assert.strictEqual(server.parseSessionCookie('a=1; ezone_session=TOK; b=2'), 'TOK');
  assert.strictEqual(server.parseSessionCookie('ezone_session=TOK'), 'TOK');
});

test('parseSessionCookie returns empty for absent cookie / bad input', () => {
  assert.strictEqual(server.parseSessionCookie('a=1; b=2'), '');
  assert.strictEqual(server.parseSessionCookie(''), '');
  assert.strictEqual(server.parseSessionCookie(undefined), '');
  assert.strictEqual(server.parseSessionCookie(null), '');
});

/* ===== sessionAuthStatus (pure, explicit secret) ===== */

test('sessionAuthStatus: valid cookie → ok', () => {
  const token = createSessionToken(SECRET);
  assert.strictEqual(server.sessionAuthStatus(cookieHeader(token), SECRET), 'ok');
});

test('sessionAuthStatus: missing / expired / tampered cookie → unauthorized', () => {
  assert.strictEqual(server.sessionAuthStatus(undefined, SECRET), 'unauthorized');
  assert.strictEqual(server.sessionAuthStatus('other=1', SECRET), 'unauthorized');
  assert.strictEqual(server.sessionAuthStatus(cookieHeader(createSessionToken(SECRET, -10)), SECRET), 'unauthorized');
  assert.strictEqual(server.sessionAuthStatus(cookieHeader('123.deadbeef'), SECRET), 'unauthorized');
});

test('sessionAuthStatus: unset secret → not_configured (fail-closed)', () => {
  assert.strictEqual(server.sessionAuthStatus(cookieHeader(createSessionToken(SECRET)), ''), 'not_configured');
});

/* ===== buildSessionCookie / requestIsHttps ===== */

test('buildSessionCookie sets the security attributes; Secure only when HTTPS', () => {
  const https = server.buildSessionCookie('TOK', true);
  assert.ok(https.includes('ezone_session=TOK'));
  assert.ok(https.includes('HttpOnly'));
  assert.ok(https.includes('SameSite=Strict'));
  assert.ok(https.includes('Path=/'));
  assert.ok(https.includes('Max-Age=604800'));
  assert.ok(https.includes('Secure'), 'HTTPS request must get Secure');

  const http = server.buildSessionCookie('TOK', false);
  assert.ok(!/;\s*Secure/.test(http) && !http.endsWith('Secure'), 'plain HTTP (localhost) must omit Secure');
});

test('requestIsHttps detects Railway x-forwarded-proto and req.secure', () => {
  assert.strictEqual(server.requestIsHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.strictEqual(server.requestIsHttps({ headers: {}, secure: true }), true);
  assert.strictEqual(server.requestIsHttps({ headers: {} }), false);
  assert.strictEqual(server.requestIsHttps({ headers: { 'x-forwarded-proto': 'http' } }), false);
});

/* ===== requireSession middleware ===== */

test('requireSession: request without a cookie → 401, next NOT called', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireSession({ headers: {} }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'unauthorized' });
  assert.strictEqual(nextCalled, false);
});

test('requireSession: valid cookie → next() called, no response written', () => {
  let nextCalled = false;
  const res = mkRes();
  const token = createSessionToken(SECRET);
  server.requireSession({ headers: { cookie: cookieHeader(token) } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null, 'middleware must not write a response on success');
});

test('requireSession: expired cookie → 401', () => {
  let nextCalled = false;
  const res = mkRes();
  const expired = createSessionToken(SECRET, -10);
  server.requireSession({ headers: { cookie: cookieHeader(expired) } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('requireSession: SESSION_SECRET unset → 503 (fail-closed), via fresh module load', () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = '';
  delete require.cache[require.resolve('../server')];
  const serverNoSecret = require('../server');
  try {
    let nextCalled = false;
    const res = mkRes();
    serverNoSecret.requireSession({ headers: { cookie: cookieHeader(createSessionToken(SECRET)) } }, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, 'session_not_configured');
    assert.strictEqual(nextCalled, false);
  } finally {
    // Restore env + module cache so other test files see the configured server.
    process.env.SESSION_SECRET = prev;
    delete require.cache[require.resolve('../server')];
    require('../server');
  }
});
