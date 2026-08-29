/* Tests for the meeting-report micro-app's server layer (server.js + lib/session):
 *
 *   - Scoped session tokens: the mr_session cookie is signed in the
 *     'meeting-report' scope, so a MAIN-app cookie can never authorize a
 *     meeting-report route and a meeting-report cookie can never authorize a
 *     main-app data route — the core isolation requirement (managers holding
 *     the reporting PIN must gain zero dashboard access).
 *   - Fail-closed config: with MEETING_REPORT_PIN unset, /meeting-report and
 *     the meeting-report API return 503 — never open access.
 *   - The page handler serves the PIN entry page without a session and the
 *     form page with one.
 *
 * server.js only calls app.listen when run as the main module (same approach
 * as api-auth.test.js). Env is set BEFORE the require; the unset branches are
 * covered by re-requiring with a fresh module cache. */

const { test } = require('node:test');
const assert = require('node:assert');

const SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET;
process.env.MEETING_REPORT_PIN = '123456';
process.env.MEETING_REPORT_SECRET = 'mr-shared-secret-for-tests';

const { createSessionToken, verifySessionToken } = require('../lib/session');
const server = require('../server');

const MR_SCOPE = 'meeting-report';

function mkRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    type(t) { this.contentType = t; return this; },
    send(s) { this.sent = s; if (this.statusCode === null) this.statusCode = 200; return this; },
  };
}

const mainToken = () => createSessionToken(SECRET);
const mrToken = () => createSessionToken(SECRET, undefined, MR_SCOPE);

/* ===== lib/session scope partitioning ===== */

test('a scoped token verifies only in its own scope', () => {
  const t = mrToken();
  assert.strictEqual(verifySessionToken(t, SECRET, MR_SCOPE), true);
  assert.strictEqual(verifySessionToken(t, SECRET), false, 'mr token must NOT verify as a main token');
  assert.strictEqual(verifySessionToken(t, SECRET, 'other-scope'), false);

  const m = mainToken();
  assert.strictEqual(verifySessionToken(m, SECRET), true);
  assert.strictEqual(verifySessionToken(m, SECRET, MR_SCOPE), false, 'main token must NOT verify in the mr scope');
});

test('default (unscoped) tokens are unchanged by the scope addition', () => {
  // Pre-existing main-app cookies keep verifying exactly as before.
  assert.strictEqual(verifySessionToken(mainToken(), SECRET), true);
  assert.strictEqual(verifySessionToken(createSessionToken(SECRET, -10), SECRET), false, 'expired still rejected');
});

/* ===== mrSessionAuthStatus / parseMeetingReportCookie ===== */

test('parseMeetingReportCookie reads mr_session among other cookies', () => {
  assert.strictEqual(server.parseMeetingReportCookie('a=1; mr_session=TOK; ezone_session=X'), 'TOK');
  assert.strictEqual(server.parseMeetingReportCookie('ezone_session=X'), '');
  assert.strictEqual(server.parseMeetingReportCookie(undefined), '');
});

test('mrSessionAuthStatus: valid meeting-report cookie → ok', () => {
  assert.strictEqual(server.mrSessionAuthStatus(`mr_session=${mrToken()}`, SECRET), 'ok');
});

test('mrSessionAuthStatus: MAIN-app token in mr_session → unauthorized (cross-cookie isolation)', () => {
  assert.strictEqual(server.mrSessionAuthStatus(`mr_session=${mainToken()}`, SECRET), 'unauthorized');
});

test('mrSessionAuthStatus: mr token under the MAIN cookie name → unauthorized', () => {
  assert.strictEqual(server.mrSessionAuthStatus(`ezone_session=${mrToken()}`, SECRET), 'unauthorized');
});

test('mrSessionAuthStatus: unset secret → not_configured (fail-closed)', () => {
  assert.strictEqual(server.mrSessionAuthStatus(`mr_session=${mrToken()}`, ''), 'not_configured');
});

/* ===== the two middlewares reject each other's cookies ===== */

test('requireMeetingReportSession: main-app session cookie → 401', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireMeetingReportSession(
    { headers: { cookie: `ezone_session=${mainToken()}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('requireMeetingReportSession: main token smuggled AS mr_session → 401', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireMeetingReportSession(
    { headers: { cookie: `mr_session=${mainToken()}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('requireMeetingReportSession: valid mr cookie → next()', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireMeetingReportSession(
    { headers: { cookie: `mr_session=${mrToken()}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireSession (main app): meeting-report cookie grants NOTHING → 401', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireSession(
    { headers: { cookie: `mr_session=${mrToken()}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('requireSession (main app): mr token smuggled AS ezone_session → 401', () => {
  let nextCalled = false;
  const res = mkRes();
  server.requireSession(
    { headers: { cookie: `ezone_session=${mrToken()}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

/* ===== the /meeting-report page handler ===== */

test('handleMeetingReportPage: no session → PIN entry page (maxlength 6, mr verify endpoint)', () => {
  const res = mkRes();
  server.handleMeetingReportPage({ headers: {} }, res);
  assert.strictEqual(res.contentType, 'html');
  assert.ok(res.sent.includes('maxlength="6"'), 'PIN input must cap at 6');
  assert.ok(res.sent.includes('/api/meeting-report/verify-pin'), 'PIN page posts to the mr verify endpoint');
  assert.ok(!res.sent.includes('id="mr-form"'), 'the form must NOT be served without a session');
});

test('handleMeetingReportPage: valid mr session → the form page', () => {
  const res = mkRes();
  server.handleMeetingReportPage({ headers: { cookie: `mr_session=${mrToken()}` } }, res);
  assert.strictEqual(res.contentType, 'html');
  assert.ok(res.sent.includes('id="mr-form"'), 'form page expected');
});

test('handleMeetingReportPage: MAIN-app cookie only → still the PIN page', () => {
  const res = mkRes();
  server.handleMeetingReportPage({ headers: { cookie: `ezone_session=${mainToken()}` } }, res);
  assert.ok(!res.sent.includes('id="mr-form"'), 'a dashboard session must not open the form');
});

/* ===== cookie attributes ===== */

test('buildMeetingReportCookie sets the security attributes; Secure only when HTTPS', () => {
  const https = server.buildMeetingReportCookie('TOK', true);
  assert.ok(https.includes('mr_session=TOK'));
  assert.ok(https.includes('HttpOnly'));
  assert.ok(https.includes('SameSite=Strict'));
  assert.ok(https.includes('Path=/'));
  assert.ok(https.includes('Max-Age=604800'), '7-day validity like the main cookie');
  assert.ok(https.includes('Secure'));

  const http = server.buildMeetingReportCookie('TOK', false);
  assert.ok(!/;\s*Secure/.test(http) && !http.endsWith('Secure'));
});

/* ===== fail-closed: MEETING_REPORT_PIN unset ===== */

test('MEETING_REPORT_PIN unset → /meeting-report page and API middleware both 503', () => {
  const prevPin = process.env.MEETING_REPORT_PIN;
  process.env.MEETING_REPORT_PIN = '';
  delete require.cache[require.resolve('../server')];
  const serverNoPin = require('../server');
  try {
    const pageRes = mkRes();
    serverNoPin.handleMeetingReportPage({ headers: { cookie: `mr_session=${mrToken()}` } }, pageRes);
    assert.strictEqual(pageRes.statusCode, 503, 'page must be closed, even with a valid cookie');
    assert.strictEqual(pageRes.body.error, 'meeting_report_not_configured');

    let nextCalled = false;
    const apiRes = mkRes();
    serverNoPin.requireMeetingReportSession(
      { headers: { cookie: `mr_session=${mrToken()}` } }, apiRes, () => { nextCalled = true; });
    assert.strictEqual(apiRes.statusCode, 503);
    assert.strictEqual(nextCalled, false);
  } finally {
    process.env.MEETING_REPORT_PIN = prevPin;
    delete require.cache[require.resolve('../server')];
    require('../server');
  }
});

test('SESSION_SECRET unset → meeting-report middleware 503 (fail-closed), never open', () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = '';
  delete require.cache[require.resolve('../server')];
  const serverNoSecret = require('../server');
  try {
    let nextCalled = false;
    const res = mkRes();
    serverNoSecret.requireMeetingReportSession(
      { headers: { cookie: `mr_session=${mrToken()}` } }, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(nextCalled, false);
  } finally {
    process.env.SESSION_SECRET = prev;
    delete require.cache[require.resolve('../server')];
    require('../server');
  }
});
