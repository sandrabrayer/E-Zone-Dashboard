/* Personal PINs — PR B: the live login, with the 7-day dual-accept window.
 * See CHANGELOG-personal-pins-login.md and docs/billing-control-plan.md §11.5.
 *
 * server.js (real Express app on an ephemeral port, https.request stubbed):
 *   - GET /api/login-users lists ACTIVE records only (Ortal never)
 *   - POST /api/verify-pin { userId, pin }: success, wrong PIN, the per-user
 *     lock at 5 failures, unlock after the window, per-IP + global brakes,
 *     X-Forwarded-For spoofing, constant work for unknown users
 *   - PR C: the shared APP_PIN path is gone — { pin } → 400, a shared cookie
 *     → 401, no banner, no window (lib/shared-pin-window.js removed)
 *   - «קוד אישי חדש» (/api/pin-admin/*): Sandra's personal session only
 *   - a reset / revoked user is logged out (401); logout clears the cookie
 *   - un-void end to end: server → the exact forwarded body → Code.gs
 *   - meeting-report PIN unchanged
 * public/app.js (vm sandbox): the Hebrew errors, escapeHtml on names, the
 *   remembered name (and no localStorage), the admin steps.
 * public/sw.js: v26, the login + API routes are never cached. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = require.resolve('../server');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken, readSession } = require('../lib/session');

const SESSION_SECRET = 'session-secret-TEST-login-0123456789abcdef0123';
const PROXY_SECRET = 'proxy-secret-TEST-login-7f3a9c1e5b2d4f6a8c0e2b4d';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const APP_PIN = '4711';
const PEPPER = 'pepper-TEST-login-a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PINS = { vered: '583920', sandra: '402917', shiran: '719305', yael: '264081' };


const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES',
  'PIN_PEPPER', 'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL'];

/* Require a FRESH server.js with exactly `env` (others unset). Captures every
 * startup console line. */
function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => lines.push(a.map(String).join(' '));
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = (...a) => lines.push(a.map(String).join(' '));
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { mod, startup: lines };
}

function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push({ url: String(url), method: opts && opts.method, body });
      const r = respond({ url: String(url), body });
      const res = new EventEmitter();
      res.statusCode = r.status || 200;
      res.headers = {};
      res.setEncoding = () => {};
      res.resume = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('data', typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        res.emit('end');
      });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}

async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'error', 'warn', 'info']) {
    saved[k] = console[k];
    console[k] = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function request(port, method, urlPath, { cookie, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: buf,
        json: (() => { try { return JSON.parse(buf); } catch (_) { return null; } })(),
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(env, fn) {
  const { mod, startup } = freshServer(env);
  const srv = await listen(mod.app);
  try { return await fn(srv.address().port, mod, startup); } finally { srv.close(); }
}

/* A USER_PIN_HASHES record for `id` with its PIN from PINS (real scrypt). */
async function record(id, over) {
  const m = users.modelById(id);
  const hash = await pinHash.hashPin(PINS[id] || '583920', PEPPER);
  return Object.assign({ id, name: m.name, roles: m.roles.slice(), hash, pinVersion: 1, status: 'active' }, over || {});
}

let _team;
/* Vered v3, Sandra v1, Shiran active, Yael REVOKED. */
async function team() {
  if (!_team) {
    _team = [await record('vered', { pinVersion: 3 }), await record('sandra'), await record('shiran'),
      await record('yael', { status: 'revoked' })];
  }
  return _team.map((r) => Object.assign({}, r));
}

async function envWith(over, recs) {
  return Object.assign({
    PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER,
    USER_PIN_HASHES: JSON.stringify(recs || await team()),
  }, over || {});
}

const cookieOf = (r) => String(r.headers['set-cookie'] || '').split(';')[0];
const login = (port, userId, pin, headers) => request(port, 'POST', '/api/verify-pin', { body: { userId, pin }, headers });

/* Move every lock window of `counter` into the past (the 15 minutes elapse). */
function elapse(counter) {
  for (const rec of counter.map.values()) rec.resetAt = Date.now() - 1;
}

/* ====================================================================== */
/* ======================= step 1: the name list ======================== */
/* ====================================================================== */

test('login-users: ACTIVE records only, in model order, { id, name } only — revoked, missing and Ortal are hidden', async () => {
  const recs = await team();
  recs.push(await record('ortal', { status: 'inactive', roles: ['controller'] }));
  await withServer(await envWith({}, recs), async (port) => {
    const r = await request(port, 'GET', '/api/login-users');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.users, [{ id: 'vered', name: 'ורד' }, { id: 'sandra', name: 'סנדרה' }, { id: 'shiran', name: 'שירן' }]);
    assert.ok(!/scrypt|hash|roles|pinVersion|אורטל|יעל/.test(r.text), 'no hash, role, version — and no Ortal / revoked Yael');
    assert.ok(!('shared' in r.json), 'PR C: no shared-window field');
    assert.match(String(r.headers['cache-control']), /no-store/);
  });
  // No records at all → an empty list (the screen says to ask Sandra).
  await withServer(await envWith({ USER_PIN_HASHES: undefined }), async (port) => {
    assert.deepStrictEqual((await request(port, 'GET', '/api/login-users')).json.users, []);
  });
  // Phase 4: Ortal's model is active — her ACTIVE record lists her.
  assert.deepStrictEqual(users.loginUsers({ byId: { ortal: { status: 'active' } } }), [{ id: 'ortal', name: 'אורטל' }]);
});

/* ====================================================================== */
/* ===================== step 2: the personal PIN ======================= */
/* ====================================================================== */

test('personal login: success mints id + pinVersion; /api/me says personal; the PIN is never logged', async () => {
  await withServer(await envWith(), async (port) => {
    let ok;
    const lines = await captureConsole(async () => { ok = await login(port, 'vered', PINS.vered); });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, { ok: true });
    assert.match(String(ok.headers['set-cookie']), /^ezone_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    const token = cookieOf(ok).slice('ezone_session='.length);
    const s = readSession(token, SESSION_SECRET);
    assert.deepStrictEqual([s.auth, s.id, s.pinVersion, s.user], ['personal', 'vered', 3, 'ורד']);
    assert.ok(!lines.join('\n').includes(PINS.vered), 'the PIN never reaches a log line');
    const me = await request(port, 'GET', '/api/me', { cookie: cookieOf(ok) });
    assert.deepStrictEqual(me.json, { ok: true, user: 'ורד', auth: 'personal', approver: false, deleter: true, finance: true,
      // Phase 4 («בקרת גבייה»): the capability set, the view and the decision right.
      capabilities: ['finance', 'billingControl'], billingControl: true, view: 'full', canConfirm: false, billingRead: false });
  });
});

test('personal login: a wrong PIN is 401; an unknown, revoked or junk id answers the SAME 401 with the same work', async () => {
  await withServer(await envWith(), async (port) => {
    const wrong = await login(port, 'vered', '111222');
    assert.deepStrictEqual([wrong.status, wrong.json], [401, { ok: false, error: 'invalid_pin' }]);
    assert.ok(!wrong.headers['set-cookie']);
    const ids = ['yael', 'ortal', 'nobody', 'constructor', 'hasownproperty', 'Vered', '<b>', 42, null];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const before = pinHash.stats.derivations;
      // A separate client address per attempt, so the per-IP brake (10) stays out of it.
      const r = await login(port, id, PINS.yael, { 'X-Forwarded-For': '192.0.2.' + (10 + i) });
      assert.deepStrictEqual([r.status, r.json], [401, { ok: false, error: 'invalid_pin' }], String(id));
      assert.strictEqual(pinHash.stats.derivations - before, 1, 'exactly one scrypt derivation for ' + String(id));
    }
    // The right PIN for another user does not log in as Vered.
    assert.strictEqual((await login(port, 'vered', PINS.sandra, { 'X-Forwarded-For': '198.51.100.200' })).status, 401);
  });
});

test('per-user lock: 5 failures → 429 «locked» (the 5th already), even with the right PIN; others unaffected; unlocks after 15 min', async () => {
  await withServer(await envWith(), async (port, mod) => {
    for (let i = 0; i < 4; i++) assert.strictEqual((await login(port, 'vered', '111222', { 'X-Forwarded-For': '203.0.113.' + i })).status, 401);
    const fifth = await login(port, 'vered', '111222', { 'X-Forwarded-For': '203.0.113.50' });
    assert.strictEqual(fifth.status, 429);
    assert.strictEqual(fifth.json.error, 'locked');
    assert.ok(fifth.json.retryAfter > 890 && fifth.json.retryAfter <= 900);
    assert.strictEqual(fifth.headers['retry-after'], String(fifth.json.retryAfter));
    const before = pinHash.stats.derivations;
    const right = await login(port, 'vered', PINS.vered, { 'X-Forwarded-For': '198.51.100.1' });
    assert.deepStrictEqual([right.status, right.json.error], [429, 'locked'], 'a different IP does not unlock the user');
    assert.strictEqual(pinHash.stats.derivations, before, 'a locked user costs no scrypt');
    assert.strictEqual((await login(port, 'shiran', PINS.shiran)).status, 200, 'other users unaffected');
    elapse(mod.pinLockout.user);
    assert.strictEqual((await login(port, 'vered', PINS.vered)).status, 200, 'unlocked after the window');
    // A success resets the user's count: 4 more failures do not lock.
    for (let i = 0; i < 4; i++) assert.strictEqual((await login(port, 'vered', '111222', { 'X-Forwarded-For': '192.0.2.' + i })).status, 401);
    assert.strictEqual((await login(port, 'vered', PINS.vered, { 'X-Forwarded-For': '192.0.2.99' })).status, 200);
  });
});

test('per-IP (10) and global (30) brakes; X-Forwarded-For spoofing cannot bypass them', async () => {
  await withServer(await envWith(), async (port, mod) => {
    assert.strictEqual(mod.app.get('trust proxy'), 1);
    const REAL = '203.0.113.7';
    // 10 failures from one real address, spread over users (no user reaches
    // 5), each with a fresh fake leftmost XFF.
    const plan = ['vered', 'vered', 'vered', 'sandra', 'sandra', 'sandra', 'shiran', 'shiran', 'nobody', 'x'];
    for (let i = 0; i < plan.length; i++) {
      const headers = { 'X-Forwarded-For': `10.9.${i}.1, ${REAL}` };
      const r = await login(port, plan[i], '111222', headers);
      assert.strictEqual(r.status, 401, 'attempt ' + i);
    }
    for (const body of [{ userId: 'shiran', pin: PINS.shiran }, { userId: 'vered', pin: PINS.vered }]) {
      const r = await request(port, 'POST', '/api/verify-pin', { body, headers: { 'X-Forwarded-For': `198.51.100.99, ${REAL}` } });
      assert.deepStrictEqual([r.status, r.json.error], [429, 'rate_limited'], 'spoofed leftmost entry: ' + JSON.stringify(Object.keys(body)));
    }
    assert.strictEqual((await login(port, 'shiran', PINS.shiran, { 'X-Forwarded-For': `${REAL}, 192.0.2.44` })).status, 200, 'a really different client is fine');

    // Global: 30 failures from 30 addresses → everyone waits.
    elapse(mod.pinLockout.ip); elapse(mod.pinLockout.global); elapse(mod.pinLockout.user);
    for (let i = 0; i < 30; i++) {
      const id = ['vered', 'sandra', 'shiran', 'yael', 'nobody', 'x'][i % 6];
      await login(port, id, '111222', { 'X-Forwarded-For': `${REAL}, 100.64.${i}.1` });
    }
    const g = await login(port, 'shiran', PINS.shiran, { 'X-Forwarded-For': `${REAL}, 100.65.0.1` });
    assert.deepStrictEqual([g.status, g.json.error], [429, 'rate_limited']);
  });
});

test('personal login without PIN_PEPPER → 503 not_configured (fail-closed); no cookie', async () => {
  await withServer(await envWith({ PIN_PEPPER: undefined }), async (port) => {
    const r = await login(port, 'vered', PINS.vered);
    assert.deepStrictEqual([r.status, r.json], [503, { ok: false, error: 'not_configured' }]);
    assert.ok(!r.headers['set-cookie']);
  });
});

/* ====================================================================== */
/* =================== PR C: the shared path is gone ==================== */
/* ====================================================================== */

test('PR C: lib/shared-pin-window.js and every APP_PIN / APP_PIN_UNTIL read are gone from the server', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'shared-pin-window.js')));
  assert.ok(!/shared-pin-window|sharedLogin|sharedWindowNow|shared_pin_closed|process\.env\.APP_PIN\b|process\.env\.APP_PIN_UNTIL/.test(SERVER_SRC));
});

test('PR C: { pin } → 400 user_required (PIN not checked, no cookie); a shared cookie → 401 everywhere; login-users has no window', async () => {
  const stub = stubHttps(() => ({ body: { ok: true, leads: [], patients: {} } }));
  try {
    // Even if APP_PIN / APP_PIN_UNTIL were left in Railway.
    await withServer(await envWith({ APP_PIN, APP_PIN_UNTIL: '2026-10-09' }), async (port, mod, startup) => {
      for (const body of [{ pin: APP_PIN }, { pin: APP_PIN, user: 'ורד' }, { pin: '0000' }]) {
        const r = await request(port, 'POST', '/api/verify-pin', { body });
        assert.deepStrictEqual([r.status, r.json], [400, { ok: false, error: 'user_required' }], JSON.stringify(body));
        assert.ok(!r.headers['set-cookie']);
      }
      assert.ok(!startup.join('\n').includes(APP_PIN) && !startup.join('\n').includes(PEPPER), 'no PIN / pepper in the log');
      assert.deepStrictEqual((await request(port, 'GET', '/api/login-users')).json,
        { ok: true, users: [{ id: 'vered', name: 'ורד' }, { id: 'sandra', name: 'סנדרה' }, { id: 'shiran', name: 'שירן' }] });
      // A shared cookie minted before PR C (named or not) is no session.
      for (const name of ['ורד', '']) {
        const old = 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, name);
        assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: old })).status, 401);
        assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getData', { cookie: old })).status, 401);
        assert.strictEqual((await request(port, 'POST', '/api/sheets', { cookie: old, body: { action: 'saveAll' } })).status, 401);
        assert.strictEqual(mod.sessionAuthStatus(old, SESSION_SECRET), 'unauthorized');
      }
      // Personal logins are unaffected.
      assert.strictEqual((await login(port, 'sandra', PINS.sandra)).status, 200);
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0, 'nothing reached Apps Script for a shared cookie');
});

test('PR C: /api/me has no sharedUntil; the client has no banner, no shared field, no picker', async () => {
  await withServer(await envWith(), async (port) => {
    const me = await request(port, 'GET', '/api/me', { cookie: cookieOf(await login(port, 'shiran', PINS.shiran)) });
    assert.deepStrictEqual(me.json, { ok: true, user: 'שירן', auth: 'personal', approver: false, deleter: false, finance: false,
      capabilities: [], billingControl: false, view: 'restricted', canConfirm: false, billingRead: false });
  });
  assert.ok(!/id="shared-banner"|id="pin-input"|id="login-shared-link"|id="user-screen"/.test(HTML_SRC));
  assert.ok(!/\.shared-banner \{/.test(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')));
  assert.ok(!/sharedBannerText|shared_pin_closed|login-shared-link|function tryPin\b|showUserPicker/.test(APP_SRC));
});

/* ====================================================================== */
/* ======================== «קוד אישי חדש» ============================= */
/* ====================================================================== */

async function sandraCookie(port) {
  return cookieOf(await login(port, 'sandra', PINS.sandra));
}

test('new-code page: 401 without a session or with a shared cookie; 403 for every non-approver personal session', async () => {
  await withServer(await envWith(), async (port) => {
    for (const [m, p] of [['GET', '/api/pin-admin/users'], ['POST', '/api/pin-admin/record']]) {
      assert.strictEqual((await request(port, m, p, { body: { userId: 'shiran', pin: '719305', pin2: '719305' } })).status, 401);
    }
    const shared = 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
    assert.strictEqual((await request(port, 'GET', '/api/pin-admin/users', { cookie: shared })).status, 401, 'PR C: no session');
    const vered = cookieOf(await login(port, 'vered', PINS.vered));
    const shiran = cookieOf(await login(port, 'shiran', PINS.shiran));
    for (const cookie of [vered, shiran]) {
      const g = await request(port, 'GET', '/api/pin-admin/users', { cookie });
      const p = await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'yael', pin: '264081', pin2: '264081' } });
      assert.deepStrictEqual([g.status, g.json], [403, { ok: false, error: 'forbidden' }]);
      assert.deepStrictEqual([p.status, p.json], [403, { ok: false, error: 'forbidden' }]);
    }
    // A forged personal cookie for Sandra with a stale version is not her session.
    const stale = 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'סנדרה', { id: 'sandra', pinVersion: 9 });
    assert.strictEqual((await request(port, 'GET', '/api/pin-admin/users', { cookie: stale })).status, 401);
    // Sandra: approver flag on /api/me, and the list.
    const sandra = await sandraCookie(port);
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: sandra })).json.approver, true);
    const list = await request(port, 'GET', '/api/pin-admin/users', { cookie: sandra });
    assert.deepStrictEqual(list.json.users, [
      { id: 'vered', name: 'ורד', hasRecord: true, status: 'active' },
      { id: 'sandra', name: 'סנדרה', hasRecord: true, status: 'active' },
      { id: 'shiran', name: 'שירן', hasRecord: true, status: 'active' },
      { id: 'yael', name: 'יעל', hasRecord: true, status: 'revoked' },
      // Phase 4: Sandra creates Ortal's code here (new, no record yet).
      { id: 'ortal', name: 'אורטל', hasRecord: false, status: '' },
    ], 'Ortal offered as new; no hash, no roles');
  });
});

test('new-code page: returns ONLY a valid record line; new → v1, reset → current + 1 (narrowed roles kept); the PIN is never logged or echoed', async () => {
  const recs = (await team()).filter((r) => r.id !== 'shiran');
  recs[0].roles = ['staff', 'reporter']; // Vered narrowed (no deleter)
  await withServer(await envWith({}, recs), async (port) => {
    const cookie = await sandraCookie(port);
    const NEW_PIN = '730418';
    let r;
    const lines = await captureConsole(async () => {
      r = await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'shiran', pin: NEW_PIN, pin2: NEW_PIN } });
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json), ['ok', 'record'], 'only the line');
    assert.ok(!r.text.includes(NEW_PIN), 'the PIN is not echoed');
    assert.ok(!lines.join('\n').includes(NEW_PIN), 'the PIN is not logged');
    const line = JSON.parse(r.json.record);
    assert.deepStrictEqual([line.id, line.name, line.pinVersion, line.status, line.roles], ['shiran', 'שירן', 1, 'active', ['staff', 'reporter']]);
    assert.ok(await pinHash.verifyPin(NEW_PIN, line.hash, PEPPER), 'the hash verifies the PIN under the pepper');
    // The line validates when appended to the array, exactly as Sandra pastes it.
    const reg = users.validateUserPinHashes(JSON.stringify(recs.concat([line])));
    assert.strictEqual(reg.byId.shiran.pinVersion, 1);

    const reset = JSON.parse((await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'vered', pin: '846203', pin2: '846203' } })).json.record);
    assert.deepStrictEqual([reset.pinVersion, reset.roles, reset.status], [4, ['staff', 'reporter'], 'active'], 'reset: v3 → v4, narrowed roles kept');
    const own = JSON.parse((await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'sandra', pin: '951736', pin2: '951736' } })).json.record);
    assert.deepStrictEqual([own.id, own.pinVersion, own.roles], ['sandra', 2, ['staff', 'deleter', 'approver', 'viewer']], 'Sandra: a reset of her own');
    const revoked = JSON.parse((await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'yael', pin: '264081', pin2: '264081' } })).json.record);
    assert.deepStrictEqual([revoked.pinVersion, revoked.status], [2, 'active'], 'a reset re-activates a revoked user');
    // Phase 4: Ortal's first code — controller ONLY, active, v1; the line
    // validates as Sandra pastes it.
    const ortal = await request(port, 'POST', '/api/pin-admin/record', { cookie, body: { userId: 'ortal', pin: '264081', pin2: '264081' } });
    assert.strictEqual(ortal.status, 200);
    const oline = JSON.parse(ortal.json.record);
    assert.deepStrictEqual([oline.id, oline.name, oline.roles, oline.status, oline.pinVersion], ['ortal', 'אורטל', ['controller'], 'active', 1]);
    assert.strictEqual(users.validateUserPinHashes(JSON.stringify(recs.concat([oline]))).byId.ortal.status, 'active');
  });
});

test('new-code page: weak PIN and mismatch are refused (400); the endpoint is rate-limited (429 after 10)', async () => {
  await withServer(await envWith(), async (port) => {
    const cookie = await sandraCookie(port);
    const post = (body) => request(port, 'POST', '/api/pin-admin/record', { cookie, body });
    for (const [pin, reason] of [['000000', 'all_same'], ['123456', 'sequential'], ['654321', 'sequential'], ['12345', 'not_six_digits'], ['abcdef', 'not_six_digits'], ['', 'not_six_digits']]) {
      const r = await post({ userId: 'shiran', pin, pin2: pin });
      assert.deepStrictEqual([r.status, r.json], [400, { ok: false, error: 'weak_pin', reason }], pin);
    }
    const mm = await post({ userId: 'shiran', pin: '730418', pin2: '730419' });
    assert.deepStrictEqual([mm.status, mm.json], [400, { ok: false, error: 'pin_mismatch' }]);
    for (let i = 0; i < 3; i++) await post({ userId: 'shiran', pin: '000000', pin2: '000000' });
    const limited = await post({ userId: 'shiran', pin: '730418', pin2: '730418' });
    assert.deepStrictEqual([limited.status, limited.json.error], [429, 'rate_limited'], '10 calls per 15 min, every call counts');
  });
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/pin-admin/record'"), SERVER_SRC.indexOf('/* GET /api/me'));
  assert.ok(!/console\./.test(route), 'the route logs nothing');
});

/* ====================================================================== */
/* ================== reset / revoke → logged out; logout =============== */
/* ====================================================================== */

test('a reset (pinVersion++) or revoked user is logged out: the old cookie → 401 everywhere; logout clears the cookie', async () => {
  let veredCookie, shiranCookie;
  const stub = stubHttps(() => ({ body: { ok: true, leads: [], patients: {} } }));
  try {
    await withServer(await envWith(), async (port) => {
      veredCookie = cookieOf(await login(port, 'vered', PINS.vered));
      shiranCookie = cookieOf(await login(port, 'shiran', PINS.shiran));
      assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getData', { cookie: veredCookie })).status, 200);
      const out = await request(port, 'POST', '/api/logout', { cookie: veredCookie });
      assert.match(String(out.headers['set-cookie']), /^ezone_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
    });
    // Sandra pastes a reset line for Vered (v4) and a revoke for Shiran; Railway redeploys.
    const recs = await team();
    recs[0].pinVersion = 4;
    recs[2].status = 'revoked';
    await withServer(await envWith({}, recs), async (port) => {
      for (const cookie of [veredCookie, shiranCookie]) {
        assert.strictEqual((await request(port, 'GET', '/api/me', { cookie })).status, 401);
        assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getData', { cookie })).status, 401);
        assert.strictEqual((await request(port, 'POST', '/api/sheets', { cookie, body: { action: 'saveAll' } })).status, 401);
      }
      assert.deepStrictEqual((await request(port, 'GET', '/api/login-users')).json.users.map((u) => u.id), ['vered', 'sandra'], 'Shiran leaves the name list');
      assert.strictEqual((await login(port, 'shiran', PINS.shiran)).status, 401, 'a revoked user cannot log in');
    });
  } finally { stub.restore(); }
  // The frontend: any 401 goes back to the login screen.
  assert.ok(/if \(res\.status === 401\) \{ showPinScreen\(\); throw new Error\('unauthorized'\); \}/.test(APP_SRC));
});

/* ====================================================================== */
/* ================== un-void: server → Code.gs, end to end ============= */
/* ====================================================================== */

function richSheet(name, headerRow) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()] : [];
  let hidden = false;
  const sh = {
    grid,
    getName: () => name,
    getLastRow() {
      let n = grid.length;
      while (n > 0 && (grid[n - 1] || []).every((v) => v === '' || v === undefined || v === null)) n--;
      return n;
    },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    getMaxColumns() { return 50; },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.splice(sh.getLastRow(), 0, row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() { return this; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; const v = g ? g[c - 1 + j] : ''; row.push(v === undefined ? '' : v); }
            out.push(row);
          }
          return out;
        },
        getValue() { const g = grid[r - 1]; return g && g[c - 1] !== undefined ? g[c - 1] : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; return this; },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
          return this;
        },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const g = grid[r - 1 + i];
            if (g) for (let j = 0; j < nc; j++) g[c - 1 + j] = '';
          }
          return this;
        },
      };
    },
  };
  return sh;
}

function loadGs(opts) {
  const o = opts || {};
  const logs = [];
  const capture = (...a) => logs.push(a.map(String).join(' '));
  const sandbox = {
    console: { log: capture, warn: capture, error: capture, info: capture },
    Logger: { log: capture },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      insertSheet: (n) => (sandbox.__sheets[n] = richSheet(n, [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
      getId: () => 'ss',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty: (k, v) => { sandbox.__props[k] = String(v); },
      deleteProperty: (k) => { delete sandbox.__props[k]; },
    }),
  };
  sandbox.CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in sandbox.__cache ? sandbox.__cache[k] : null),
      put: (k, v) => { sandbox.__cache[k] = v; },
      remove: (k) => { delete sandbox.__cache[k]; },
    }),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s), raw: s }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + crypto.randomBytes(6).toString('hex'),
    formatDate: (d) => new Date(d).toISOString().slice(0, 10),
    computeDigest: () => [],
    DigestAlgorithm: {},
    Charset: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  const calls = [];
  if (o.spyHandle) {
    sandbox.handle_ = (params) => {
      calls.push(params);
      return sandbox.jsonOut_({ ok: true, served: params.action });
    };
  }
  const post = (body) => sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body || {}) } }).json;
  const postQ = (body, query) => sandbox.doPost({ parameter: query || {}, postData: { contents: JSON.stringify(body || {}) } }).json;
  const run = (expr) => vm.runInContext(expr, sandbox);
  const sheetRows = (name, colsExpr) => {
    const sh = sandbox.__sheets[name];
    if (!sh) return [];
    const cols = Array.from(run(colsExpr));
    return sh.grid.slice(1).filter((r) => r.some((v) => v !== '' && v !== undefined)).map((r) => {
      const o2 = {};
      cols.forEach((c, i) => { o2[c] = r[i] === undefined ? '' : r[i]; });
      return o2;
    });
  };
  return { sandbox, calls, logs, post, postQ, run, sheetRows };
}

test('un-void from Sandra\'s personal session works end to end; from Vered\'s personal session it is refused (forbidden_role); a shared cookie never reaches Apps Script', async () => {
  const pay = {
    id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni',
    dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0,
  };
  const voidIt = Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' });
  const unvoid = Object.assign({}, pay, { status: 'paid' });
  // 1. The real server forwards each session's request; capture the exact bodies.
  const stub = stubHttps(() => ({ body: { ok: true } }));
  try {
    await withServer(await envWith(), async (port) => {
      const vered = cookieOf(await login(port, 'vered', PINS.vered));
      const sandra = cookieOf(await login(port, 'sandra', PINS.sandra));
      const shared = 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
      await request(port, 'POST', '/api/sheets', { cookie: vered, body: { action: 'savePayment', payment: voidIt } });
      // Each un-void attempt also tries to forge Sandra in the body.
      for (const cookie of [vered, shared, sandra]) {
        await request(port, 'POST', '/api/sheets', { cookie, body: { action: 'savePayment', payment: unvoid, user: 'סנדרה', proxyUserId: 'sandra', proxyRoles: ['approver'] } });
      }
    });
  } finally { stub.restore(); }
  const bodies = stub.calls.map((c) => JSON.parse(c.body));
  assert.strictEqual(bodies.length, 3, 'PR C: the shared cookie is 401 — never proxied');
  assert.deepStrictEqual([bodies[2].user, bodies[2].proxyAuth, bodies[2].proxyUserId, bodies[2].proxyRoles],
    ['סנדרה', 'personal', 'sandra', ['staff', 'deleter', 'approver', 'viewer']]);
  assert.deepStrictEqual([bodies[1].user, bodies[1].proxyUserId], ['ורד', 'vered'], 'the body forgery never survives the proxy');

  // 2. Feed those exact bodies to Code.gs (with the matching PROXY_SECRET).
  for (const mode of ['log', 'enforce']) {
    const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: mode } });
    assert.strictEqual(g.post(bodies[0]).ok, true, 'Vered marks the duplicate');
    const r = g.post(bodies[1]);
    assert.deepStrictEqual([r.ok, r.error, r.message], [false, 'forbidden_role', 'אין הרשאה לפעולה זו'], 'Vered cannot un-void');
    const ok = g.post(bodies[2]);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    const rev = g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').find((r) => r.action === 'payment_void_reversed');
    assert.strictEqual(rev.actor, 'סנדרה');
  }
  // 3. The client offers the control to Sandra's personal session only.
  const { app } = loadApp();
  app.applySessionInfo({ user: 'סנדרה', auth: 'personal', approver: true });
  assert.strictEqual(app.canReverseVoid(), true);
  app.applySessionInfo({ user: 'ורד', auth: 'personal', approver: false });
  assert.strictEqual(app.canReverseVoid(), false);
});

test('Code.gs: getData keeps every top-level key (PR B adds none)', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const out = g.post({ action: 'getData', proxySecret: PROXY_SECRET, user: 'סנדרה', proxyUser: 'סנדרה', proxyAuth: 'personal', proxyUserId: 'sandra', proxyRoles: ['staff', 'deleter', 'approver', 'viewer'] });
  assert.deepStrictEqual(Object.keys(out), [
    'ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource',
  ]);
});

test('meeting-report PIN flow is unchanged: own PIN, own counter, no window, no personal PIN', async () => {
  const env = await envWith({ MEETING_REPORT_PIN: '135792', MEETING_REPORT_SECRET: 'mr-secret-TEST', APP_PIN_UNTIL: undefined });
  await withServer(env, async (port, mod) => {
    const r = await request(port, 'POST', '/api/meeting-report/verify-pin', { body: { pin: '135792' } });
    assert.strictEqual(r.status, 200);
    assert.match(String(r.headers['set-cookie']), /^mr_session=/);
    assert.strictEqual((await request(port, 'POST', '/api/meeting-report/verify-pin', { body: { userId: 'vered', pin: PINS.vered } })).status, 401,
      'a personal PIN is not the reporting PIN');
    assert.notStrictEqual(mod.mrPinAttempts, mod.pinAttempts, 'its own counter');
  });
});

/* ====================================================================== */
/* ============================ public/app.js ============================ */
/* ====================================================================== */

function fakeEl(id) {
  const el = {
    id, children: [], _text: '', _html: '', value: '', disabled: false, onclick: null,
    classes: new Set(['hidden']),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
      contains: (c) => el.classes.has(c),
    },
    set textContent(v) { el._text = String(v); el.children.length = 0; },
    get textContent() { return el._text + el.children.map((c) => c.textContent || '').join(''); },
    set innerHTML(v) { el._html = String(v); el.children.length = 0; },
    get innerHTML() { return el._html; },
    appendChild(c) { el.children.push(c); },
    addEventListener() {},
    querySelectorAll() { return []; },
    focus() {},
    _attrs: {},
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    removeAttribute(k) { delete el._attrs[k]; },
  };
  return el;
}

function loadApp(opts) {
  const o = opts || {};
  const noop = () => {};
  const els = {};
  const store = {};
  const fetchCalls = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    document: {
      addEventListener: noop,
      getElementById: (id) => (els[id] || (els[id] = fakeEl(id))),
      createElement: (tag) => fakeEl('<' + tag + '>'),
      createTextNode: (t) => ({ textContent: String(t) }),
      querySelectorAll: () => [],
    },
    localStorage: o.noStorage
      ? { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
    fetch: async (url, opts2) => {
      fetchCalls.push({ url, opts: opts2 });
      const r = (o.respond && o.respond(url, opts2)) || { status: 200, body: { ok: true } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      loginErrorMessage, loginNamesHtml, applySessionInfo, canReverseVoid,
      loadLoginOptions, tryPersonalLoginWorker, chooseLoginUser, rememberLoginUser, rememberedLoginUser,
      pinAdminSteps, pinAdminOptionLabel, pinAdminErrorMessage,
      stubEnterApp(fn) { enterApp = fn; },
    };`, sandbox);
  return { app: sandbox.__test, els, store, fetchCalls };
}

test('client: Hebrew login errors — wrong code, locked «נעול ל־15 דקות», rate limited, not configured', () => {
  const { app } = loadApp();
  assert.strictEqual(app.loginErrorMessage(401, 'invalid_pin'), 'קוד שגוי');
  assert.match(app.loginErrorMessage(429, 'locked'), /^נעול ל־15 דקות/);
  assert.match(app.loginErrorMessage(429, 'rate_limited'), /יותר מדי ניסיונות/);
  assert.match(app.loginErrorMessage(503, 'not_configured'), /לא הוגדרה/);
  assert.match(app.loginErrorMessage(0, ''), /נכשלה/);
});

test('client: escapeHtml on every name in the step-1 buttons', () => {
  const { app } = loadApp();
  const html = app.loginNamesHtml([{ id: 'x"><img src=x onerror=alert(1)>', name: '<script>alert(1)</script>ורד' }]);
  assert.ok(!/<script>|<img/.test(html), html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;ורד'));
  assert.ok(html.includes('data-user-id="x&quot;&gt;&lt;img'));
  assert.strictEqual(app.loginNamesHtml(null), '');
});

test('client: the name list comes from /api/login-users; the last name is remembered per device and jumps to step 2', async () => {
  const respond = (url) => (url === '/api/login-users'
    ? { status: 200, body: { ok: true, users: [{ id: 'vered', name: 'ורד' }, { id: 'sandra', name: 'סנדרה' }] } }
    : null);
  const a = loadApp({ respond });
  await a.app.loadLoginOptions();
  assert.match(a.els['login-names'].innerHTML, /data-user-id="vered">ורד<\/button>.*data-user-id="sandra">סנדרה/);
  assert.strictEqual(a.els['login-step-name'].classList.contains('hidden'), false, 'step 1 first');

  // A successful login remembers the id …
  let entered = 0;
  const b = loadApp({ respond: (url) => (url === '/api/verify-pin' ? { status: 200, body: { ok: true } } : respond(url)) });
  b.app.stubEnterApp(() => { entered++; });
  b.app.chooseLoginUser({ id: 'sandra', name: 'סנדרה' });
  b.els['login-pin-input'].value = '402917';
  await b.app.tryPersonalLoginWorker();
  assert.strictEqual(entered, 1);
  assert.deepStrictEqual(JSON.parse(b.fetchCalls.find((c) => c.url === '/api/verify-pin').opts.body), { userId: 'sandra', pin: '402917' });
  assert.strictEqual(b.els['login-pin-input'].value, '', 'the PIN field is cleared');
  assert.strictEqual(b.store['ezone.lastLoginUser'], 'sandra');
  assert.ok(!JSON.stringify(b.store).includes('402917'), 'the PIN is never stored');
  // … and the next load goes straight to step 2 for that name.
  await b.app.loadLoginOptions();
  assert.strictEqual(b.els['login-step-pin'].classList.contains('hidden'), false);
  assert.strictEqual(b.els['login-chosen-name'].textContent, 'סנדרה');

});

test('client: works without localStorage (blocked / private mode) and shows the server error in Hebrew', async () => {
  const a = loadApp({ noStorage: true, respond: (url) => (url === '/api/verify-pin' ? { status: 429, body: { ok: false, error: 'locked', retryAfter: 900 } } : null) });
  a.app.rememberLoginUser('vered');
  assert.strictEqual(a.app.rememberedLoginUser(), '');
  a.app.chooseLoginUser({ id: 'vered', name: 'ורד' });
  a.els['login-pin-input'].value = '111222';
  await a.app.tryPersonalLoginWorker();
  assert.match(a.els['login-error'].textContent, /^נעול ל־15 דקות/);
  assert.strictEqual(a.els['login-error'].classList.contains('hidden'), false);
});

test('client: «קוד אישי חדש» — labels, Railway steps for new vs reset, Hebrew errors; the button shows for the approver only', () => {
  const { app, els } = loadApp();
  assert.strictEqual(app.pinAdminOptionLabel({ id: 'sandra', name: 'סנדרה', hasRecord: true }), 'סנדרה — איפוס הקוד שלי');
  assert.strictEqual(app.pinAdminOptionLabel({ id: 'shiran', name: 'שירן', hasRecord: false }), 'שירן (חדש)');
  assert.strictEqual(app.pinAdminOptionLabel({ id: 'vered', name: 'ורד', hasRecord: true, status: 'active' }), 'ורד (איפוס)');
  const fresh = app.pinAdminSteps('שירן', false).join('\n');
  assert.match(fresh, /USER_PIN_HASHES/);
  assert.match(fresh, /מוסיפים פסיק אחרי הרשומה האחרונה/);
  const reset = app.pinAdminSteps('ורד', true).join('\n');
  assert.match(reset, /מוחקים את הרשומה הקיימת של ורד/);
  assert.match(reset, /מתנתק/);
  assert.match(app.pinAdminErrorMessage(400, 'weak_pin'), /קוד חלש/);
  assert.match(app.pinAdminErrorMessage(403, 'forbidden'), /רק סנדרה/);
  app.applySessionInfo({ user: 'סנדרה', auth: 'personal', approver: true });
  assert.strictEqual(els['pin-admin-open'].classList.contains('hidden'), false);
  app.applySessionInfo({ user: 'ורד', auth: 'personal', approver: false });
  assert.strictEqual(els['pin-admin-open'].classList.contains('hidden'), true);
});

test('index.html: step 1 / step 2 — the 6-digit personal input, RTL; PR C: no shared field', () => {
  assert.match(HTML_SRC, /<html lang="he" dir="rtl">/);
  assert.match(HTML_SRC, /<input type="password" id="login-pin-input" inputmode="numeric" pattern="\[0-9\]\*" maxlength="6" autocomplete="off"/);
  assert.ok(!/id="pin-input"/.test(HTML_SRC), 'the 4-digit shared field is gone');
  assert.ok(!/one-time-code/.test(HTML_SRC), 'no one-time-code autofill');
  assert.ok(!/כניסה עם הקוד המשותף/.test(HTML_SRC));
  assert.match(HTML_SRC, /id="pin-admin-screen"/);
  assert.match(HTML_SRC, /id="pin-admin-copy"[^>]*>העתקה</);
});

/* ====================================================================== */
/* ============================ service worker ========================== */
/* ====================================================================== */

test('service worker: v26 or later; the login and every API route are never cached', () => {
  // v26 shipped the login; later PRs bump it again (v27: restricted view).
  const m = /var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC);
  assert.ok(m && Number(m[1]) >= 26, m && m[1]);
  const sandbox = { self: { addEventListener() {} }, module: { exports: {} }, URL, caches: {}, fetch() {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  const sw = sandbox.module.exports;
  for (const u of ['/api/verify-pin', '/api/login-users', '/api/me', '/api/logout', '/api/pin-admin/users', '/api/pin-admin/record', '/api/bootstrap-pin']) {
    assert.strictEqual(sw.cacheStrategy(u), 'network-only', u);
    assert.strictEqual(sw.shouldCache(u), false, u);
  }
  assert.ok(!/'\/api\//.test(SW_SRC.slice(SW_SRC.indexOf('var PRECACHE_URLS'), SW_SRC.indexOf('];', SW_SRC.indexOf('var PRECACHE_URLS')))), 'no API route is precached');
});
