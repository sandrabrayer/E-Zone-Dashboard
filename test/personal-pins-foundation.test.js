/* Personal PINs — PR A, foundation (ZERO user-facing change).
 * See CHANGELOG-personal-pins-foundation.md and docs/billing-control-plan.md §11.5.
 *
 * server.js (real Express app on an ephemeral port, https.request stubbed):
 *   - APP_PIN login behaves exactly as before
 *   - X-Forwarded-For spoofing no longer resets the per-IP counter
 *   - the counter maps sweep expired entries and are capped
 *   - the USER_PIN_HASHES startup validator
 *   - the one-time Sandra bootstrap (/api/bootstrap-pin)
 *   - proxyRoles: from the session only, a shared session is staff only
 * lib/: pin-hash (scrypt + pepper + constant-time), weak-PIN policy, the user /
 *   role model, the per-user limiter (built, not wired), the personal cookie
 * Code.gs (vm sandbox): roles only from the verified proxy, DELETE_ACTIONS /
 *   APPROVER_ACTIONS, the actor column + stamps, getData keys. */

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

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { WindowCounter, PinLockout, PIN_LOCKOUT_LIMITS } = require('../lib/rate-limit');
const { createSessionToken, readSession, verifySessionToken, readSessionUser } = require('../lib/session');

const SESSION_SECRET = 'session-secret-TEST-0123456789abcdef0123456789';
const PROXY_SECRET = 'proxy-secret-TEST-7f3a9c1e5b2d4f6a8c0e2b4d6f8a0c2e';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const APP_PIN = '4711';
const PEPPER = 'pepper-TEST-a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BOOT = 'bootstrap-token-TEST-0123456789abcdef0123456789';
const SANDRA_PIN = '402917';

/* ====================================================================== */
/* ============================ helpers ================================= */
/* ====================================================================== */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES',
  'PIN_PEPPER', 'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL'];

/* Require a FRESH server.js with exactly `env` (others unset). Captures every
 * startup console line. Throws whatever the require throws. */
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

/* PR B: the shared APP_PIN (and its cookies) work only inside the dual
 * window, so the PR A suite runs with it open (7 days from today, Israel). */
const OPEN_UNTIL = require('../lib/shared-pin-window').israelDay(Date.now() + 7 * 864e5);
const BASE_ENV = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL, APP_PIN, APP_PIN_UNTIL: OPEN_UNTIL };

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

/* A valid USER_PIN_HASHES record for `id` (real scrypt hash under PEPPER). */
async function record(id, over) {
  const m = users.modelById(id);
  const hash = await pinHash.hashPin('583920', PEPPER);
  return Object.assign({ id, name: m.name, roles: m.roles.slice(), hash, pinVersion: 1, status: 'active' }, over || {});
}

/* ====================================================================== */
/* ============== server.js: APP_PIN login exactly as before ============ */
/* ====================================================================== */

test('APP_PIN login behaves exactly as before: 200 + cookie, 401 on a wrong PIN, 429 after 10, success resets', async () => {
  await withServer(BASE_ENV, async (port) => {
    const ok = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN, user: 'ורד' } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, { ok: true });
    const setCookie = String(ok.headers['set-cookie']);
    assert.match(setCookie, /^ezone_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    const token = setCookie.split(';')[0].slice('ezone_session='.length);
    assert.strictEqual(token.split('.').length, 3, 'the same user-bearing 3-part token as before');
    assert.strictEqual(readSessionUser(token, SESSION_SECRET), 'ורד');

    const me = await request(port, 'GET', '/api/me', { cookie: 'ezone_session=' + token });
    // PR B adds auth / approver / sharedUntil; `user` is unchanged.
    assert.strictEqual(me.json.ok, true);
    assert.strictEqual(me.json.user, 'ורד');
    assert.strictEqual(me.json.auth, 'shared');
    assert.strictEqual(me.json.approver, false);

    // An unknown name still mints the legacy user-less cookie.
    const anon = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN, user: 'סנדרה' } });
    const anonTok = String(anon.headers['set-cookie']).split(';')[0].slice('ezone_session='.length);
    assert.strictEqual(anonTok.split('.').length, 2);

    for (let i = 0; i < 9; i++) {
      const bad = await request(port, 'POST', '/api/verify-pin', { body: { pin: '0000' } });
      assert.strictEqual(bad.status, 401);
      assert.deepStrictEqual(bad.json, { ok: false, error: 'invalid_pin' });
    }
    // A success resets the counter (as before) …
    assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN } })).status, 200);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { pin: '0000' } })).status, 401);
    }
    // … and the 11th attempt in the window is 429 without checking the PIN.
    const limited = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN } });
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.json.error, 'rate_limited');
    assert.ok(limited.json.retryAfter >= 1 && limited.json.retryAfter <= 900);
    assert.strictEqual(limited.headers['retry-after'], String(limited.json.retryAfter));
  });
});

test('APP_PIN unset still fails closed (every attempt 401)', async () => {
  await withServer(Object.assign({}, BASE_ENV, { APP_PIN: undefined }), async (port) => {
    const r = await request(port, 'POST', '/api/verify-pin', { body: { pin: '' } });
    assert.strictEqual(r.status, 401);
  });
});

/* ====================================================================== */
/* ========================= XFF spoofing fix =========================== */
/* ====================================================================== */

test('X-Forwarded-For spoofing no longer resets the IP counter (trust proxy = 1 hop, req.ip)', async () => {
  await withServer(BASE_ENV, async (port, mod) => {
    assert.strictEqual(mod.TRUST_PROXY_HOPS, 1);
    assert.strictEqual(mod.app.get('trust proxy'), 1);
    /* Railway's edge APPENDS the real client address; a client may put
     * anything to its left. A fresh fake leftmost entry per request used to
     * open a fresh counter — now all 10 count against the real address. */
    const REAL = '203.0.113.7';
    for (let i = 0; i < 10; i++) {
      const r = await request(port, 'POST', '/api/verify-pin', {
        body: { pin: '0000' }, headers: { 'X-Forwarded-For': `10.0.0.${i}, ${REAL}` },
      });
      assert.strictEqual(r.status, 401, 'attempt ' + i);
    }
    const spoofed = await request(port, 'POST', '/api/verify-pin', {
      body: { pin: APP_PIN }, headers: { 'X-Forwarded-For': `198.51.100.99, ${REAL}` },
    });
    assert.strictEqual(spoofed.status, 429, 'a new spoofed leftmost entry does not reset the counter');
    // A genuinely different client (different appended address) is unaffected.
    const other = await request(port, 'POST', '/api/verify-pin', {
      body: { pin: APP_PIN }, headers: { 'X-Forwarded-For': `${REAL}, 192.0.2.44` },
    });
    assert.strictEqual(other.status, 200);
    // The meeting-report PIN route uses the same address.
    assert.ok(/app\.post\('\/api\/meeting-report\/verify-pin'[\s\S]{0,120}pinClientIp\(req\)/.test(SERVER_SRC));
  });
});

test('pinClientIp reads req.ip only — never the raw X-Forwarded-For header', () => {
  const { mod } = freshServer(BASE_ENV);
  assert.strictEqual(mod.pinClientIp({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '1.2.3.4' } }), '203.0.113.7');
  assert.strictEqual(mod.pinClientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.strictEqual(mod.pinClientIp({ headers: {}, socket: {} }), 'unknown');
  const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function pinClientIp('), SERVER_SRC.indexOf('function sendRateLimited('));
  assert.ok(!/x-forwarded-for/i.test(fn), 'the header is not parsed by hand any more');
  assert.strictEqual(mod.trustProxyHops(undefined), 1);
  assert.strictEqual(mod.trustProxyHops('2'), 2);
  for (const bad of ['-1', '9', 'true', '1.5', 'abc']) assert.strictEqual(mod.trustProxyHops(bad), 1, bad);
});

test('the PIN counter maps sweep expired entries and are capped (no unbounded growth)', () => {
  const c = new WindowCounter({ max: 10, windowMs: 1000, maxKeys: 3 });
  c.fail('a', 0); c.fail('b', 0); c.fail('c', 0);
  assert.strictEqual(c.size, 3);
  c.fail('d', 10);                     // at the cap → oldest evicted
  assert.strictEqual(c.size, 3);
  assert.ok(!c.map.has('a'));
  c.check('e', 5000);                  // a window later → every expired entry swept
  assert.deepStrictEqual([...c.map.keys()], ['e']);
  // Same semantics as the old inline Map: max failures → limited until reset.
  const d = new WindowCounter({ max: 2, windowMs: 60000 });
  d.fail('ip', 0); d.fail('ip', 0);
  assert.deepStrictEqual(d.check('ip', 1000), { limited: true, retryAfter: 59 });
  d.reset('ip');
  assert.deepStrictEqual(d.check('ip', 1000), { limited: false });
  const { mod } = freshServer(BASE_ENV);
  assert.ok(mod.pinAttempts instanceof WindowCounter && mod.mrPinAttempts instanceof WindowCounter);
  assert.strictEqual(mod.pinAttempts.max, 10);
  assert.strictEqual(mod.pinAttempts.windowMs, 15 * 60 * 1000);
});

/* ====================================================================== */
/* ======================= lib/pin-hash.js ============================== */
/* ====================================================================== */

test('pin-hash: correct PIN verifies; wrong PIN, wrong pepper, no pepper fail', async () => {
  const h = await pinHash.hashPin('583920', PEPPER);
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!h.includes('583920'));
  assert.strictEqual(await pinHash.verifyPin('583920', h, PEPPER), true);
  assert.strictEqual(await pinHash.verifyPin('583921', h, PEPPER), false);
  assert.strictEqual(await pinHash.verifyPin('583920', h, PEPPER + 'x'), false, 'wrong pepper');
  assert.strictEqual(await pinHash.verifyPin('583920', h, ''), false, 'no pepper fails closed');
  await assert.rejects(pinHash.hashPin('583920', ''), /PIN_PEPPER/);
  // A fresh 16-byte salt per hash: the same PIN never hashes the same twice.
  const h2 = await pinHash.hashPin('583920', PEPPER);
  assert.notStrictEqual(h, h2);
  assert.strictEqual(Buffer.from(h.split('$')[4], 'base64url').length, 16);
});

test('pin-hash: constant-time guard — always one derivation, timingSafeEqual, tampered params rejected', async () => {
  const h = await pinHash.hashPin('583920', PEPPER);
  const cases = [
    ['583920', 'not-a-hash'], ['583920', undefined], [123456, h], [undefined, h], ['', h],
    ['583920', h.replace('$16384$', '$2$')],             // work-factor downgrade
    ['583920', h.replace('$16384$', '$1048576$')],       // memory blow-up
  ];
  for (const [pin, stored] of cases) {
    const before = pinHash.stats.derivations;
    assert.strictEqual(await pinHash.verifyPin(pin, stored, PEPPER), false, String(stored).slice(0, 20));
    assert.strictEqual(pinHash.stats.derivations - before, 1, 'exactly one scrypt run, whatever the input');
  }
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'pin-hash.js'), 'utf8');
  const verify = src.slice(src.indexOf('async function verifyPin('), src.indexOf('function pinPolicyError('));
  assert.ok(/crypto\.timingSafeEqual\(got, expected\)/.test(verify));
  assert.ok(!/===\s*expected|expected\s*===|\.equals\(/.test(verify), 'no early-exit comparison');
});

test('weak PINs are rejected: 000000, 123456, all-same, sequential up or down, wrong length/format', () => {
  for (const p of ['000000', '123456', '111111', '999999', '234567', '456789', '654321', '987654', '543210', '012345']) {
    assert.ok(pinHash.pinPolicyError(p), p + ' must be rejected');
  }
  assert.strictEqual(pinHash.pinPolicyError('000000'), 'all_same');
  assert.strictEqual(pinHash.pinPolicyError('123456'), 'sequential');
  assert.strictEqual(pinHash.pinPolicyError('654321'), 'sequential');
  for (const p of ['12345', '1234567', 'abcdef', '12 456', '١٢٣٤٥٦', 123456, null, undefined, '']) {
    assert.strictEqual(pinHash.pinPolicyError(p), 'not_six_digits', String(p));
  }
  for (const p of ['402917', '135790', '901234', '112233', '583920']) {
    assert.strictEqual(pinHash.pinPolicyError(p), '', p + ' is acceptable');
  }
});

/* ====================================================================== */
/* ===================== USER_PIN_HASHES validator ====================== */
/* ====================================================================== */

test('startup validator: unset / blank is fine (today\'s state)', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const r = users.validateUserPinHashes(raw);
    assert.deepStrictEqual([r.users.length, r.approverId], [0, '']);
  }
  const { mod } = freshServer(BASE_ENV);
  assert.strictEqual(mod.USER_REGISTRY.users.length, 0);
});

test('startup validator: valid records are accepted and indexed by stable id', async () => {
  const recs = [await record('vered'), await record('sandra'), await record('shiran'), await record('yael'),
    await record('ortal', { status: 'inactive' })];
  const r = users.validateUserPinHashes(JSON.stringify(recs));
  assert.deepStrictEqual(r.users.map((u) => u.id), ['vered', 'sandra', 'shiran', 'yael', 'ortal']);
  assert.strictEqual(r.approverId, 'sandra');
  assert.ok(Object.isFrozen(r.byId.vered.roles));
  // A record may NARROW roles (e.g. revoke deleter) …
  const narrowed = users.validateUserPinHashes(JSON.stringify([await record('vered', { roles: ['staff', 'reporter'] })]));
  assert.deepStrictEqual(narrowed.byId.vered.roles, ['staff', 'reporter']);
});

test('startup validator: bad JSON, unknown role, non-Sandra approver and every other bad record FAIL', async () => {
  const bad = [
    ['{not json', /not valid JSON/],
    ['{"id":"vered"}', /JSON array/],
    [JSON.stringify([await record('vered', { roles: ['staff', 'superuser'] })]), /unknown role/],
    [JSON.stringify([await record('vered', { roles: ['staff', 'approver'] })]), /approver role is pinned to sandra/],
    [JSON.stringify([await record('shiran', { roles: ['staff', 'approver'] })]), /approver role is pinned to sandra/],
    [JSON.stringify([await record('shiran', { roles: ['staff', 'reporter', 'deleter'] })]), /deleter is not allowed/],
    [JSON.stringify([await record('yael', { roles: ['staff', 'deleter'] })]), /deleter is not allowed/],
    [JSON.stringify([await record('vered', { id: 'mallory' })]), /unknown user id/],
    [JSON.stringify([await record('vered'), await record('vered')]), /duplicate id/],
    [JSON.stringify([await record('vered', { name: 'סנדרה' })]), /name does not match/],
    [JSON.stringify([Object.assign(await record('vered'), { extra: 1 })]), /exactly the keys/],
    [JSON.stringify([await record('vered', { hash: 'plain-583920' })]), /hash is malformed/],
    [JSON.stringify([await record('vered', { pinVersion: 0 })]), /pinVersion/],
    [JSON.stringify([await record('vered', { pinVersion: '1' })]), /pinVersion/],
    [JSON.stringify([await record('vered', { status: 'enabled' })]), /status must be one of/],
    [JSON.stringify([await record('ortal', { status: 'active' })]), /no login until Phase 4/],
    [JSON.stringify([await record('vered', { roles: ['staff', 'staff'] })]), /duplicate role/],
  ];
  for (const [raw, re] of bad) {
    assert.throws(() => users.validateUserPinHashes(raw), re, raw.slice(0, 60));
  }
  // The server refuses to START, with a [config] line that never echoes a hash.
  const withHash = JSON.stringify([await record('vered', { roles: ['staff', 'approver'] })]);
  const hash = JSON.parse(withHash)[0].hash;
  let lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    assert.throws(() => freshServer(Object.assign({}, BASE_ENV, { USER_PIN_HASHES: withHash })), /pinned to sandra/);
  } finally { console.error = orig; }
  lines = lines.join('\n');
  assert.ok(!lines.includes(hash.split('$')[5]), 'no hash in the startup log');
  assert.throws(() => freshServer(Object.assign({}, BASE_ENV, { USER_PIN_HASHES: '{bad' })), /not valid JSON/);
  delete require.cache[SERVER_PATH];
});

/* ====================================================================== */
/* ======================= user / role model ============================ */
/* ====================================================================== */

test('role model: Vered / Sandra / Shiran / Yael / Ortal exactly as decided; stable ASCII ids', () => {
  const by = Object.fromEntries(users.USER_MODEL.map((u) => [u.id, u]));
  assert.deepStrictEqual(Object.keys(by), ['vered', 'sandra', 'shiran', 'yael', 'ortal']);
  for (const id of Object.keys(by)) assert.match(id, /^[a-z]+$/);
  assert.deepStrictEqual([...by.vered.roles], ['staff', 'reporter', 'deleter']);
  assert.deepStrictEqual([...by.sandra.roles], ['staff', 'deleter', 'approver', 'viewer']);
  assert.deepStrictEqual([...by.shiran.roles], ['staff', 'reporter']);
  assert.deepStrictEqual([...by.yael.roles], ['staff', 'reporter']);
  assert.ok(!by.shiran.roles.includes('deleter') && !by.yael.roles.includes('deleter'), 'Shiran / Yael: NO deleter');
  assert.strictEqual(by.ortal.status, 'inactive');
  assert.deepStrictEqual([...by.ortal.roles], ['controller'], 'Phase 4: controller only, no staff');
  const approvers = users.USER_MODEL.filter((u) => u.roles.includes('approver')).map((u) => u.id);
  assert.deepStrictEqual(approvers, ['sandra'], 'approver is Sandra only');
  assert.strictEqual(users.APPROVER_ID, 'sandra');
  assert.ok(Object.isFrozen(users.USER_MODEL) && Object.isFrozen(users.USER_MODEL[0].roles));
  // The name picker list is untouched (guarded against app.js elsewhere).
  assert.deepStrictEqual(users.SESSION_USERS, ['ורד', 'שירן', 'יעל']);
});

test('role model: a shared APP_PIN session is staff only — never deleter, whatever name it carries', () => {
  for (const user of ['ורד', 'שירן', '']) {
    const p = users.resolvePrincipal({ user, id: '', pinVersion: 0, auth: 'shared' }, users.validateUserPinHashes(''));
    assert.deepStrictEqual(p, { auth: 'shared', id: '', user, roles: ['staff'] });
  }
  assert.deepStrictEqual([...users.SHARED_SESSION_ROLES], ['staff']);
});

test('role model: a personal session resolves to its CURRENT record — reset (pinVersion++) and revoke (status) kill it', async () => {
  const reg = users.validateUserPinHashes(JSON.stringify([await record('vered', { pinVersion: 2 })]));
  const ses = { user: 'x', id: 'vered', pinVersion: 2, auth: 'personal' };
  assert.deepStrictEqual(users.resolvePrincipal(ses, reg),
    { auth: 'personal', id: 'vered', user: 'ורד', roles: ['staff', 'reporter', 'deleter'] });
  assert.strictEqual(users.resolvePrincipal(Object.assign({}, ses, { pinVersion: 1 }), reg), null, 'old pinVersion');
  assert.strictEqual(users.resolvePrincipal(Object.assign({}, ses, { id: 'shiran' }), reg), null, 'no record');
  const revoked = users.validateUserPinHashes(JSON.stringify([await record('vered', { pinVersion: 2, status: 'revoked' })]));
  assert.strictEqual(users.resolvePrincipal(ses, revoked), null, 'revoked');
});

/* ====================================================================== */
/* =================== per-user limiter (built, not wired) ============== */
/* ====================================================================== */

test('per-user limiter: 5 failures/user → 15 min, 10/IP/15 min, 30 global/15 min — wired in PR B', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(PIN_LOCKOUT_LIMITS)), {
    perUser: { max: 5, windowMs: 900000 }, perIp: { max: 10, windowMs: 900000 }, global: { max: 30, windowMs: 900000 },
  });
  const L = new PinLockout();
  for (let i = 0; i < 5; i++) { assert.ok(L.check('vered', 'ip1', 0).ok); L.recordFailure('vered', 'ip1', 0); }
  assert.deepStrictEqual(L.check('vered', 'ip1', 1000), { ok: false, scope: 'user', retryAfter: 899 });
  assert.deepStrictEqual(L.check('vered', 'ip9', 1000).scope, 'user', 'a different IP does not unlock the user');
  assert.ok(L.check('shiran', 'ip1', 1000).ok, 'other users unaffected');
  assert.ok(L.check('vered', 'ip1', 900001).ok, 'unlocked after 15 minutes');

  const I = new PinLockout();
  for (let i = 0; i < 10; i++) I.recordFailure('u' + i, 'ip1', 0);
  assert.strictEqual(I.check('fresh', 'ip1', 0).scope, 'ip');
  assert.ok(I.check('fresh', 'ip2', 0).ok);

  const G = new PinLockout();
  for (let i = 0; i < 30; i++) G.recordFailure('u' + (i % 6), 'ip' + i, 0);
  assert.strictEqual(G.check('fresh', 'fresh-ip', 0).scope, 'global');
  G.recordSuccess('fresh', 'fresh-ip');
  assert.strictEqual(G.check('fresh', 'fresh-ip', 0).scope, 'global', 'a success never resets the global brake');

  const S = new PinLockout();
  for (let i = 0; i < 4; i++) S.recordFailure('vered', 'ip1', 0);
  S.recordSuccess('vered', 'ip1');
  for (let i = 0; i < 4; i++) S.recordFailure('vered', 'ip1', 0);
  assert.ok(S.check('vered', 'ip1', 0).ok, 'a success resets the user + IP counters');

  // PR B wires it into /api/verify-pin (test/personal-pins-login.test.js).
  assert.ok(/const pinLockout = new PinLockout\(\)/.test(SERVER_SRC), 'wired into server.js in PR B');
});

/* ====================================================================== */
/* ======================== cookie format =============================== */
/* ====================================================================== */

test('cookie: the personal format carries id + pinVersion; current tokens stay valid', () => {
  const legacy = createSessionToken(SESSION_SECRET);
  const named = createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
  const personal = createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד', { id: 'vered', pinVersion: 3 });
  assert.deepStrictEqual([legacy, named, personal].map((t) => t.split('.').length), [2, 3, 4]);
  for (const t of [legacy, named, personal]) assert.ok(verifySessionToken(t, SESSION_SECRET));
  assert.deepStrictEqual(Object.assign({}, readSession(legacy, SESSION_SECRET), { expiry: 0 }),
    { expiry: 0, user: '', id: '', pinVersion: 0, auth: 'shared' });
  assert.deepStrictEqual(Object.assign({}, readSession(named, SESSION_SECRET), { expiry: 0 }),
    { expiry: 0, user: 'ורד', id: '', pinVersion: 0, auth: 'shared' });
  assert.deepStrictEqual(Object.assign({}, readSession(personal, SESSION_SECRET), { expiry: 0 }),
    { expiry: 0, user: 'ורד', id: 'vered', pinVersion: 3, auth: 'personal' });
  assert.strictEqual(readSessionUser(personal, SESSION_SECRET), 'ורד');
  // Tamper-proof: bumping the version, swapping the id, or grafting the part
  // onto a 3-part token all break the signature.
  const [e, u, ident, sig] = personal.split('.');
  assert.strictEqual(readSession([e, u, 'vered-4', sig].join('.'), SESSION_SECRET), null);
  assert.strictEqual(readSession([e, u, 'sandra-3', sig].join('.'), SESSION_SECRET), null);
  assert.strictEqual(readSession([...named.split('.').slice(0, 2), ident, named.split('.')[2]].join('.'), SESSION_SECRET), null);
  assert.strictEqual(readSession([e, u, 'Vered-3', sig].join('.'), SESSION_SECRET), null, 'id shape enforced');
  assert.throws(() => createSessionToken(SESSION_SECRET, undefined, undefined, 'x', { id: 'vered', pinVersion: 0 }));
  assert.throws(() => createSessionToken(SESSION_SECRET, undefined, undefined, 'x', { id: 'ורד', pinVersion: 1 }));
  // Scopes still partition personal tokens too.
  assert.strictEqual(readSession(personal, SESSION_SECRET, 'meeting-report'), null);
});

test('server: a personal cookie authorizes only while its record is active with the same pinVersion', async () => {
  const hashes = JSON.stringify([await record('vered', { pinVersion: 2 }), await record('shiran', { status: 'revoked' })]);
  const { mod } = freshServer(Object.assign({}, BASE_ENV, { USER_PIN_HASHES: hashes }));
  const ck = (t) => 'ezone_session=' + t;
  const tok = (id, v) => createSessionToken(SESSION_SECRET, undefined, undefined, '', { id, pinVersion: v });
  assert.strictEqual(mod.sessionAuthStatus(ck(tok('vered', 2)), SESSION_SECRET), 'ok');
  assert.strictEqual(mod.sessionAuthStatus(ck(tok('vered', 1)), SESSION_SECRET), 'unauthorized', 'after a reset');
  assert.strictEqual(mod.sessionAuthStatus(ck(tok('shiran', 1)), SESSION_SECRET), 'unauthorized', 'revoked');
  assert.strictEqual(mod.sessionAuthStatus(ck(tok('yael', 1)), SESSION_SECRET), 'unauthorized', 'no record');
  // Shared cookies never consult the registry — exactly as before.
  assert.strictEqual(mod.sessionAuthStatus(ck(createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד')), SESSION_SECRET), 'ok');
  assert.strictEqual(mod.sessionAuthStatus(ck(createSessionToken(SESSION_SECRET)), SESSION_SECRET), 'ok');
  const p = mod.sessionPrincipalFromRequest({ headers: { cookie: ck(tok('vered', 2)) } });
  assert.deepStrictEqual(p, { auth: 'personal', id: 'vered', user: 'ורד', roles: ['staff', 'reporter', 'deleter'] });
  delete require.cache[SERVER_PATH];
});

/* ====================================================================== */
/* =================== proxyRoles: session → Code.gs ==================== */
/* ====================================================================== */

test('server: proxyRoles come from the session only — a shared session sends staff only; a body copy is dropped', async () => {
  const stub = stubHttps(() => ({ body: { ok: true, leads: [], patients: {} } }));
  try {
    await withServer(BASE_ENV, async (port) => {
      const cookie = 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
      await request(port, 'POST', '/api/sheets', {
        cookie, body: { action: 'removeLead', lead: { id: 'L1' }, proxyRoles: ['deleter', 'approver'], proxyAuth: 'personal', proxyUserId: 'sandra' },
      });
      await request(port, 'GET', '/api/sheets?action=getData&proxyRoles=approver&proxyAuth=personal&proxyUserId=sandra', { cookie });
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 2);
  for (const c of stub.calls) {
    const b = JSON.parse(c.body);
    assert.deepStrictEqual(b.proxyRoles, ['staff'], 'a shared APP_PIN session: staff only, NO deleter');
    assert.strictEqual(b.proxyAuth, 'shared');
    assert.strictEqual(b.proxyUserId, '');
    assert.strictEqual(b.user, 'ורד');
  }
});

test('server: meeting-report calls carry no roles; buildAppsScriptBody without a principal is unchanged', () => {
  const { mod } = freshServer(BASE_ENV);
  const b = mod.buildAppsScriptBody({ action: 'x', proxyRoles: ['approver'] }, 'ורד', PROXY_SECRET);
  assert.deepStrictEqual(b, { action: 'x', user: 'ורד', proxyUser: 'ורד', proxySecret: PROXY_SECRET });
  const n = mod.buildAppsScriptBody({ action: 'meetingReportLeads' }, '', PROXY_SECRET, mod.NO_PRINCIPAL);
  assert.deepStrictEqual([n.proxyRoles, n.proxyAuth, n.proxyUserId], [[], 'none', '']);
  assert.ok(/buildAppsScriptBody\(b, b\.user, PROXY_SECRET, principal \|\| NO_PRINCIPAL\)/.test(SERVER_SRC));
});

/* ====================================================================== */
/* ======================= /api/bootstrap-pin =========================== */
/* ====================================================================== */

const BOOT_ENV = Object.assign({}, BASE_ENV, { PIN_PEPPER: PEPPER, BOOTSTRAP_TOKEN: BOOT });

test('bootstrap: returns Sandra\'s record line ONCE; the line validates and its hash verifies the PIN', async () => {
  let res1;
  let res2;
  const lines = await captureConsole(async () => {
    await withServer(BOOT_ENV, async (port) => {
      res1 = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: SANDRA_PIN, id: 'vered' } });
      res2 = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: '839201' } });
    });
  });
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.json.ok, true);
  const rec = JSON.parse(res1.json.record);
  assert.deepStrictEqual(Object.keys(rec), ['id', 'name', 'roles', 'hash', 'pinVersion', 'status']);
  assert.deepStrictEqual([rec.id, rec.name, rec.pinVersion, rec.status], ['sandra', 'סנדרה', 1, 'active'],
    'always Sandra — the request cannot pick another user');
  assert.deepStrictEqual(rec.roles, ['staff', 'deleter', 'approver', 'viewer']);
  assert.strictEqual(await pinHash.verifyPin(SANDRA_PIN, rec.hash, PEPPER), true);
  // Pasting it as the whole value passes the startup validator, with Sandra as approver.
  assert.strictEqual(users.validateUserPinHashes('[' + res1.json.record + ']').approverId, 'sandra');
  assert.strictEqual(res2.status, 404, 'once only');
  assert.strictEqual(res2.json.error, 'bootstrap_disabled');
  // PIN never logged, never echoed.
  const all = lines.join('\n') + res1.text + res2.text;
  assert.ok(!all.includes(SANDRA_PIN) && !all.includes('839201'), 'the PIN leaked');
  assert.ok(!all.includes(BOOT), 'the token leaked');
});

test('bootstrap: disabled once an approver exists (and the startup log still warns about the token)', async () => {
  const hashes = JSON.stringify([await record('sandra')]);
  await withServer(Object.assign({}, BOOT_ENV, { USER_PIN_HASHES: hashes }), async (port, mod, startup) => {
    const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: SANDRA_PIN } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(mod.bootstrapState(), 'approver_exists');
    assert.ok(startup.some((l) => /BOOTSTRAP_TOKEN is still set/.test(l) && /approver already exists/.test(l)), startup.join('\n'));
  });
  // A revoked approver record still counts — the bootstrap never reopens.
  const revoked = JSON.stringify([await record('sandra', { status: 'revoked' })]);
  await withServer(Object.assign({}, BOOT_ENV, { USER_PIN_HASHES: revoked }), async (port) => {
    assert.strictEqual((await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: SANDRA_PIN } })).status, 404);
  });
});

test('bootstrap: closed without a token, with a short token, or without PIN_PEPPER; warns while the token is set', async () => {
  const cases = [
    [Object.assign({}, BOOT_ENV, { BOOTSTRAP_TOKEN: undefined }), 'no_token'],
    [Object.assign({}, BOOT_ENV, { BOOTSTRAP_TOKEN: 'short' }), 'no_token'],
    [Object.assign({}, BOOT_ENV, { PIN_PEPPER: undefined }), 'no_pepper'],
  ];
  for (const [env, state] of cases) {
    await withServer(env, async (port, mod, startup) => {
      assert.strictEqual(mod.bootstrapState(), state);
      const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: env.BOOTSTRAP_TOKEN, pin: SANDRA_PIN } });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(startup.some((l) => /BOOTSTRAP_TOKEN is still set/.test(l)), env.BOOTSTRAP_TOKEN !== undefined);
    });
  }
  await withServer(BOOT_ENV, async (_port, _mod, startup) => {
    assert.ok(startup.some((l) => /BOOTSTRAP_TOKEN is still set/.test(l)));
    assert.ok(!startup.join('\n').includes(BOOT), 'the warning never prints the token');
  });
});

test('bootstrap: wrong token → 403, rate-limited (429) after 5 per IP; a weak PIN → 400 and nothing is consumed', async () => {
  await withServer(BOOT_ENV, async (port, mod) => {
    const weak = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: '123456' } });
    assert.strictEqual(weak.status, 400);
    assert.deepStrictEqual(weak.json, { ok: false, error: 'weak_pin', reason: 'sequential' });
    assert.strictEqual(mod.bootstrapState(), 'open', 'a weak PIN does not use up the bootstrap');
    for (let i = 0; i < 5; i++) {
      const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT + 'x', pin: SANDRA_PIN } });
      assert.strictEqual(r.status, 403);
      assert.deepStrictEqual(r.json, { ok: false, error: 'forbidden' });
    }
    const limited = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: BOOT, pin: SANDRA_PIN } });
    assert.strictEqual(limited.status, 429, 'even the right token waits out the window');
    assert.ok(limited.headers['retry-after']);
    // A spoofed X-Forwarded-For does not escape the limit: the proxy hop
    // (here 127.0.0.1, standing in for Railway) appends the real address last.
    const spoof = await request(port, 'POST', '/api/bootstrap-pin', {
      body: { token: BOOT, pin: SANDRA_PIN }, headers: { 'X-Forwarded-For': '10.9.8.7, 127.0.0.1' },
    });
    assert.strictEqual(spoof.status, 429);
    const missing = await request(port, 'POST', '/api/bootstrap-pin', { body: {} });
    assert.ok([403, 429].includes(missing.status));
  });
  // The token compare is constant-time (lib/pin checkPin → SHA-256 + timingSafeEqual).
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/bootstrap-pin'"), SERVER_SRC.indexOf('/* GET /api/me'));
  assert.ok(/checkPin\(typeof b\.token === 'string' \? b\.token : '', BOOTSTRAP_TOKEN\)/.test(route));
  assert.ok(!/console\./.test(route), 'the route logs nothing');
});

/* ====================================================================== */
/* =============================== Code.gs ============================== */
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

const PROXY = (extra) => Object.assign({
  proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד',
  proxyAuth: 'personal', proxyUserId: 'vered', proxyRoles: ['staff', 'reporter', 'deleter'],
}, extra || {});

test('Code.gs: roles are NEVER granted to a non-proxy caller (no secret, wrong secret, querystring, forged __actor)', () => {
  for (const mode of [undefined, 'log']) {
    const props = { PROXY_SECRET };
    if (mode) props.PROXY_SECRET_MODE = mode;
    const g = loadGs({ props, spyHandle: true });
    const forged = { verified: true, user: 'סנדרה', id: 'sandra', auth: 'personal', roles: ['approver', 'deleter'] };
    g.post({ action: 'removeLead', user: 'סנדרה', proxyUser: 'סנדרה', proxyAuth: 'personal', proxyUserId: 'sandra', proxyRoles: ['approver', 'deleter'], __actor: forged });
    g.post({ action: 'removeLead', proxySecret: 'wrong', proxyUserId: 'sandra', proxyAuth: 'personal', proxyRoles: ['deleter'], __actor: forged });
    g.postQ({ action: 'removeLead', __actor: forged }, { proxySecret: PROXY_SECRET, proxyRoles: '["deleter"]', proxyAuth: 'personal', proxyUserId: 'sandra', __actor: 'x' });
    assert.strictEqual(g.calls.length, 3);
    for (const params of g.calls) {
      const a = g.sandbox.actingUser_(params);
      assert.strictEqual(a.verified, false);
      assert.deepStrictEqual(Array.from(a.roles), []);
      for (const r of ['staff', 'deleter', 'approver']) assert.strictEqual(g.sandbox.hasRole_(params, r), false, r);
      for (const k of ['proxySecret', 'proxyUser', 'proxyRoles', 'proxyAuth', 'proxyUserId']) assert.ok(!(k in params), k);
      assert.ok(/\(unverified\)$/.test(g.sandbox.actorLabel_(params)));
    }
  }
  // enforce mode refuses outright — no handler, no actor.
  const e = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' }, spyHandle: true });
  assert.deepStrictEqual(e.post({ action: 'removeLead', proxyRoles: ['deleter'] }), { ok: false, error: 'unauthorized' });
  assert.strictEqual(e.calls.length, 0);
  // Open actions (Managers / Therapists) never get a role either.
  const o = loadGs({ props: { PROXY_SECRET }, spyHandle: true });
  o.post({ action: 'managersOverview', proxyRoles: ['deleter'], proxyAuth: 'personal', proxyUserId: 'vered' });
  assert.deepStrictEqual(Array.from(o.sandbox.actingUser_(o.calls[0]).roles), []);
  // A direct handler call that never passed the gate has no role.
  assert.strictEqual(o.sandbox.hasRole_({ user: 'סנדרה', __actor: undefined }, 'staff'), false);
});

test('Code.gs: a VERIFIED proxy call gets its roles — capped: shared → staff only, approver → Sandra\'s personal session only', () => {
  const g = loadGs({ props: { PROXY_SECRET }, spyHandle: true });
  g.post(Object.assign({ action: 'removeLead' }, PROXY()));
  g.post(Object.assign({ action: 'removeLead' }, PROXY({ proxyAuth: 'shared', proxyUserId: '', proxyRoles: ['staff', 'deleter', 'approver'] })));
  g.post(Object.assign({ action: 'removeLead' }, PROXY({ proxyRoles: ['staff', 'deleter', 'approver'] })));            // Vered claiming approver
  g.post(Object.assign({ action: 'removeLead' }, PROXY({ proxyUser: 'סנדרה', user: 'סנדרה', proxyUserId: 'sandra', proxyRoles: ['staff', 'deleter', 'approver', 'viewer'] })));
  g.post(Object.assign({ action: 'removeLead' }, PROXY({ proxyUser: 'שירן', user: 'שירן', proxyUserId: 'shiran', proxyRoles: '["staff","reporter","bogus"]' })));
  g.post(Object.assign({ action: 'removeLead' }, PROXY({ proxyAuth: 'none', proxyRoles: ['deleter'] })));
  const roles = g.calls.map((p) => Array.from(g.sandbox.actingUser_(p).roles));
  assert.deepStrictEqual(roles, [
    ['staff', 'reporter', 'deleter'],
    ['staff'],                                     // shared APP_PIN session: NO deleter
    ['staff', 'deleter'],                          // approver stripped — not Sandra
    ['staff', 'deleter', 'approver', 'viewer'],
    ['staff', 'reporter'],                         // Shiran: no deleter; unknown role dropped
    [],
  ]);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[0], 'deleter'), true);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[1], 'deleter'), false, 'shared session has no deleter');
  assert.strictEqual(g.sandbox.hasRole_(g.calls[3], 'approver'), true, 'Sandra');
  assert.strictEqual(g.sandbox.hasRole_(g.calls[2], 'approver'), false);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[4], 'deleter'), false, 'Shiran');
  assert.strictEqual(g.sandbox.actorLabel_(g.calls[0]), 'ורד');
  assert.strictEqual(g.run('APPROVER_USER_ID'), 'sandra');
});

test('Code.gs: DELETE_ACTIONS / APPROVER_ACTIONS are defined — and NOT enforced yet', () => {
  const g = loadGs({});
  assert.deepStrictEqual(Array.from(g.run('DELETE_ACTIONS')),
    ['removeLead', 'deletePatientRow', 'deleteBillingOverride', 'deleteMeetingReport', 'voidPayment', 'cancelCredit']);
  assert.deepStrictEqual(Array.from(g.run('APPROVER_ACTIONS')),
    ['unvoidPayment', 'approveRefundException', 'writeOffOpeningBalance', 'acceptOpeningBalance']);
  const s = g.sandbox;
  for (const a of g.run('DELETE_ACTIONS')) assert.strictEqual(s.requiredRoleFor_(a), 'deleter', a);
  for (const a of g.run('APPROVER_ACTIONS')) assert.strictEqual(s.requiredRoleFor_(a), 'approver', a);
  assert.strictEqual(s.requiredRoleFor_('saveAll'), '');
  assert.strictEqual(s.roleOperationFor_('savePayment', { payment: JSON.stringify({ status: 'void' }) }), 'voidPayment');
  assert.strictEqual(s.roleOperationFor_('updatePayment', { payment: { status: 'מבוטל' } }), 'voidPayment');
  assert.strictEqual(s.roleOperationFor_('savePayment', { payment: { status: 'paid' } }), '');
  assert.strictEqual(s.roleOperationFor_('saveCredit', { credit: { status: 'cancelled' } }), 'cancelCredit');
  assert.strictEqual(s.roleOperationFor_('saveCredit', { credit: { status: 'pending' } }), '');
  assert.strictEqual(s.roleOperationFor_('removeLead', {}), 'removeLead');
  assert.strictEqual(s.roleAllowed_({}, 'removeLead'), false, 'defined: a non-proxy caller would be refused');
  assert.strictEqual(s.roleAllowed_({}, 'saveAll'), true);
  // NOT enforced: handle_ never calls the checks …
  const h = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(!/roleAllowed_|hasRole_|requiredRoleFor_/.test(h), 'role checks are not wired into handle_ in PR A');
  // … so a non-proxy delete in log mode is still served exactly as before.
  const live = loadGs({ props: { PROXY_SECRET } });
  live.sandbox.__sheets.Leads = richSheet('Leads', Array.from(live.run('LEAD_COLUMNS')));
  live.sandbox.__sheets.Leads.appendRow(['L1', 'דנה']);
  assert.strictEqual(live.post({ action: 'removeLead', lead: JSON.stringify({ id: 'L1', name: 'דנה' }) }).ok, true);
});

test('Code.gs scan guard: DELETE_ACTIONS covers every delete / remove / void action handle_ dispatches', () => {
  const g = loadGs({});
  const del = new Set(Array.from(g.run('DELETE_ACTIONS')));
  const h = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  const dispatched = [...new Set([...h.matchAll(/action === '([A-Za-z]+)'/g)].map((m) => m[1]))];
  // 1. By name.
  for (const a of dispatched) {
    if (/delete|remove|void|cancel|purge|drop|wipe|clear/i.test(a)) assert.ok(del.has(a), a + ' must be in DELETE_ACTIONS');
  }
  // 2. By behavior: an action whose handler deletes rows must be listed, or be
  //    one of the documented MOVES (the row survives in another tab and can
  //    be restored) / whole-sheet rewrites below.
  const NOT_A_DELETE = {
    moveLeadIrrelevant: 'move Leads → לידים לא רלוונטיים (restorable via restoreLead)',
    restoreLead: 'move back to Leads',
    saveAll: 'whole-house rewrite; patient deletion is deletePatientRow',
  };
  const fnBody = (name) => {
    const i = GS_SRC.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = GS_SRC.indexOf('\nfunction ', i + 10);
    return GS_SRC.slice(i, j < 0 ? undefined : j);
  };
  for (const a of dispatched) {
    const start = h.indexOf("action === '" + a + "'");
    const seg = h.slice(start, h.indexOf('\n    if (action', start + 10));
    const fns = [...seg.matchAll(/([A-Za-z]+_)\(/g)].map((m) => m[1]).filter((f) => !/^(jsonOut_|parseJsonParam_|requestUser_|actorLabel_|actingUser_|refreshDigestBestEffort_)$/.test(f));
    const deletes = fns.some((f) => /deleteRowsById_\(|\.deleteRow\(|\.deleteRows\(|clearContent\(\)/.test(fnBody(f)));
    if (deletes) assert.ok(del.has(a) || NOT_A_DELETE[a], a + ' deletes rows but is not in DELETE_ACTIONS');
  }
  // 3. The void lives inside savePayment / updatePayment → its operation is listed.
  assert.ok(dispatched.includes('savePayment') && /isVoidStatus_/.test(fnBody('upsertPayment_')));
  assert.ok(del.has('voidPayment'));
  // 4. Every listed action is either dispatched or a documented payload operation.
  for (const a of del) assert.ok(dispatched.includes(a) || ['voidPayment', 'cancelCredit'].includes(a), a);
});

test('Code.gs: AuditLog gains an APPENDED actor column; BillingOverrides an APPENDED updatedBy', () => {
  const g = loadGs({});
  assert.deepStrictEqual(Array.from(g.run('AUDIT_LOG_COLUMNS')),
    ['timestamp', 'action', 'fn', 'patientId', 'name', 'details', 'actor']);
  assert.deepStrictEqual(Array.from(g.run('BILLING_OVERRIDE_COLUMNS')),
    ['id', 'patientId', 'month', 'amount', 'created', 'updatedBy']);
  // An existing AuditLog tab (6 columns) gets the header cell, rows untouched.
  g.sandbox.__sheets.AuditLog = richSheet('AuditLog', ['timestamp', 'action', 'fn', 'patientId', 'name', 'details']);
  g.sandbox.__sheets.AuditLog.appendRow(['t0', 'old', 'f', 'p', 'n', '{}']);
  g.sandbox.logAudit_('x', 'fn', 'p', 'n', {}, 'ורד');
  const grid = g.sandbox.__sheets.AuditLog.grid;
  assert.strictEqual(grid[0][6], 'actor');
  assert.deepStrictEqual(grid[1].slice(0, 6), ['t0', 'old', 'f', 'p', 'n', '{}']);
  assert.strictEqual(grid[2][6], 'ורד');
  // Legacy 5-argument callers keep working (actor '').
  g.sandbox.logAudit_('y', 'fn', 'p', 'n', {});
  assert.strictEqual(grid[3][6], '');
});

test('Code.gs: actor stamps on every delete, the lead moves, the billing overrides and the void', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const S = g.sandbox.__sheets;
  S.Leads = richSheet('Leads', Array.from(g.run('LEAD_COLUMNS')));
  ['L1', 'L2', 'L3', 'L4'].forEach((id, i) => S.Leads.appendRow([id, 'ליד ' + i]));
  const call = (body, extra) => g.post(Object.assign(body, PROXY(extra)));

  assert.strictEqual(call({ action: 'upsertBillingOverride', override: { patientId: 'P1', month: '2026-09', amount: 1000 } }).ok, true);
  const ov = g.sheetRows('BillingOverrides', 'BILLING_OVERRIDE_COLUMNS');
  assert.strictEqual(ov[0].updatedBy, 'ורד', 'updatedBy from the verified session');
  // A body-supplied updatedBy never wins.
  call({ action: 'upsertBillingOverride', override: { patientId: 'P1', month: '2026-09', amount: 1200, updatedBy: 'סנדרה' } });
  assert.strictEqual(g.sheetRows('BillingOverrides', 'BILLING_OVERRIDE_COLUMNS')[0].updatedBy, 'ורד');

  assert.strictEqual(call({ action: 'deleteBillingOverride', override: { patientId: 'P1', month: '2026-09' } }).ok, true);
  assert.strictEqual(call({ action: 'moveLeadIrrelevant', lead: { id: 'L1', name: 'ליד 0' } }).ok, true);
  assert.strictEqual(call({ action: 'restoreLead', lead: { id: 'L1', name: 'ליד 0' } }).ok, true);
  assert.strictEqual(call({ action: 'removeLead', lead: { id: 'L2', name: 'ליד 1' } }).ok, true);
  assert.strictEqual(call({ action: 'deleteMeetingReport', leadId: 'L3' }).ok, true);

  S.Patients = richSheet('Patients', Array.from(g.run('PATIENT_COLUMNS')));
  const pcols = Array.from(g.run('PATIENT_COLUMNS'));
  const prow = pcols.map((c) => ({ id: 'id-x', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' }[c] || ''));
  S.Patients.appendRow(prow);
  const del = call({ action: 'deletePatientRow', patient: { id: 'id-x', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' } });
  assert.strictEqual(del.ok, true, JSON.stringify(del));

  // The duplicate-void marking (a void) records its actor too.
  const pay = {
    id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni',
    dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0, status: 'paid',
  };
  assert.strictEqual(call({ action: 'savePayment', payment: pay }).ok, true);
  const voided = call({ action: 'savePayment', payment: Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של pay0' }) });
  assert.strictEqual(voided.ok, true, JSON.stringify(voided));

  const audit = g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS');
  const byAction = Object.fromEntries(audit.map((r) => [r.action, r]));
  for (const action of ['billing_override_deleted', 'lead_moved_irrelevant', 'lead_restored', 'lead_removed',
    'meeting_report_deleted', 'patient_deleted', 'payment_link_duplicate']) {
    assert.ok(byAction[action], action + ' was logged: ' + audit.map((r) => r.action).join(','));
    assert.strictEqual(byAction[action].actor, 'ורד', action + ' actor');
  }
  assert.strictEqual(byAction.lead_removed.patientId, 'L2');
  assert.strictEqual(JSON.parse(byAction.billing_override_deleted.details).removed, 1);

  // Without a valid secret (log mode) the actor is marked unverified.
  const u = loadGs({ props: { PROXY_SECRET } });
  u.sandbox.__sheets.Leads = richSheet('Leads', Array.from(u.run('LEAD_COLUMNS')));
  u.sandbox.__sheets.Leads.appendRow(['L9', 'ליד']);
  assert.strictEqual(u.post({ action: 'removeLead', user: 'סנדרה', lead: JSON.stringify({ id: 'L9' }) }).ok, true);
  assert.strictEqual(u.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').find((r) => r.action === 'lead_removed').actor, 'סנדרה (unverified)');
});

test('Code.gs: an un-void claimed by a NON-proxy body user "סנדרה" is refused (it could be spoofed in log mode)', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const pay = {
    id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni',
    dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0,
  };
  const voidIt = Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' });
  assert.strictEqual(g.post(Object.assign({ action: 'savePayment', payment: voidIt }, PROXY())).ok, true);
  const spoof = g.post({ action: 'savePayment', user: 'סנדרה', payment: Object.assign({}, pay, { status: 'paid' }) });
  assert.strictEqual(spoof.ok, false);
  assert.match(spoof.error, /לסנדרה בלבד/);
  // Sandra through the verified proxy still can (unchanged rule).
  const real = g.post(Object.assign({ action: 'savePayment', payment: Object.assign({}, pay, { status: 'paid' }) },
    PROXY({ proxyUser: 'סנדרה', user: 'סנדרה', proxyUserId: 'sandra', proxyRoles: ['staff', 'deleter', 'approver', 'viewer'] })));
  assert.strictEqual(real.ok, true, JSON.stringify(real));
  const rev = g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').find((r) => r.action === 'payment_void_reversed');
  assert.strictEqual(rev.actor, 'סנדרה');
});

test('Code.gs: getData keeps every top-level key', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const out = g.post(Object.assign({ action: 'getData' }, PROXY()));
  // Pinned to the base branch's getData_ return — personal PINs add nothing.
  assert.deepStrictEqual(Object.keys(out), [
    'ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource',
  ]);
  assert.strictEqual(out.ok, true);
  assert.ok(!JSON.stringify(out).includes(PROXY_SECRET));
  assert.ok(!/__actor|proxyRoles/.test(JSON.stringify(out)));
});

/* ====================================================================== */
/* ======================= no public/ change ============================ */
/* ====================================================================== */

test('the shared PIN input is still maxlength 4 (PR B adds a separate 6-digit personal field); the client never sees roles or the bootstrap', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="pin-input"[^>]*maxlength="4"/);
  assert.match(html, /id="login-pin-input"[^>]*maxlength="6"/);
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // USER_PIN_HASHES now appears in the «קוד אישי חדש» Railway instructions;
  // roles and the bootstrap route still never reach the browser.
  assert.ok(!/bootstrap-pin|proxyRoles/.test(app));
});
