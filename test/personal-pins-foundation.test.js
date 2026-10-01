/* Personal PINs — Phase 0b-3, PR A (foundation, ZERO user-facing change).
 * docs/billing-control-plan.md §11.2–11.3, CHANGELOG-personal-pins-foundation.md.
 *
 * Covers:
 *   - lib/pin-hash.js: scrypt + pepper hash/verify (correct, wrong PIN, wrong
 *     pepper, wrong user, tampered, malformed), constant-time guard, weak PINs
 *   - lib/users.js: the user/role model decided 01/10/2026
 *   - lib/user-pins.js: the USER_PIN_HASHES startup validator (+ a real
 *     `node server.js` start that refuses an invalid value)
 *   - lib/session.js: the personal cookie format (id + pinVersion); legacy
 *     tokens unchanged, and the new token authorizes nothing yet
 *   - server.js: APP_PIN login exactly as before; X-Forwarded-For spoofing no
 *     longer resets the IP counter; bounded counter maps; the per-user limiter
 *     (built, not wired); POST /api/bootstrap-pin; proxyRoles
 *   - Code.gs: roles only from the verified proxy; DELETE_ACTIONS /
 *     APPROVER_ACTIONS (defined, not enforced) + a scan guard over handle_;
 *     the AuditLog `actor` column and the actor stamps; getData keys. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = require.resolve('../server');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const userPins = require('../lib/user-pins');
const session = require('../lib/session');
const { FixedWindowLimiter, createLoginLimiter, LOGIN_LIMITS } = require('../lib/rate-limit');

const PEPPER = 'pepper-TEST-0123456789abcdef0123456789abcdef';
const OTHER_PEPPER = 'pepper-OTHER-0123456789abcdef0123456789abcd';
const SESSION_SECRET = 'session-secret-TEST-0123456789abcdef0123456789';
const PROXY = 'proxy-secret-TEST-7f3a9c1e5b2d4f6a8c0e2b4d6f8a0c2e';
const APP_PIN = '4826';
const TOKEN = 'bootstrap-TOKEN-0123456789abcdef0123456789abcdef';
const GOOD_PIN = '482915';

/* ====================================================================== */
/* ============================ lib/pin-hash ============================ */
/* ====================================================================== */

test('pin-hash: the correct PIN verifies; a wrong PIN, wrong pepper, other user or tampered hash does not', () => {
  const h = pinHash.hashPin('vered', GOOD_PIN, PEPPER);
  assert.strictEqual(pinHash.verifyPinHash('vered', GOOD_PIN, h, PEPPER), true);
  assert.strictEqual(pinHash.verifyPinHash('vered', '482916', h, PEPPER), false, 'wrong PIN');
  assert.strictEqual(pinHash.verifyPinHash('vered', GOOD_PIN, h, OTHER_PEPPER), false, 'wrong pepper');
  assert.strictEqual(pinHash.verifyPinHash('sandra', GOOD_PIN, h, PEPPER), false, 'a hash is bound to its user id');
  const parts = h.split('$');
  const flipped = Buffer.from(parts[6], 'base64url');
  flipped[0] ^= 1;
  parts[6] = flipped.toString('base64url');
  assert.strictEqual(pinHash.verifyPinHash('vered', GOOD_PIN, parts.join('$'), PEPPER), false, 'tampered hash');
});

test('pin-hash: format = scrypt$v1$N$r$p$salt$hash, 16-byte per-user salt, production cost, no PIN inside', () => {
  const a = pinHash.hashPin('vered', GOOD_PIN, PEPPER);
  const b = pinHash.hashPin('vered', GOOD_PIN, PEPPER);
  assert.notStrictEqual(a, b, 'a fresh random salt every time');
  const parts = a.split('$');
  assert.strictEqual(parts.length, 7);
  assert.deepStrictEqual(parts.slice(0, 5), ['scrypt', 'v1', '32768', '8', '1']);
  assert.strictEqual(Buffer.from(parts[5], 'base64url').length, 16);
  assert.strictEqual(Buffer.from(parts[6], 'base64url').length, 32);
  assert.ok(!a.includes(GOOD_PIN), 'the PIN never appears in the stored value');
  assert.ok(!a.includes(PEPPER.slice(0, 12)), 'nor the pepper');
});

test('pin-hash: fail-closed — malformed inputs return false and never throw; hashPin refuses bad inputs', () => {
  const h = pinHash.hashPin('vered', GOOD_PIN, PEPPER);
  for (const [id, pin, stored, pep] of [
    ['vered', GOOD_PIN, h, ''], ['vered', GOOD_PIN, h, 'short'], ['vered', GOOD_PIN, '', PEPPER],
    ['vered', GOOD_PIN, 'scrypt$v1$1024$8$1$AAAA$BBBB', PEPPER], ['vered', GOOD_PIN, GOOD_PIN, PEPPER],
    ['vered', '', h, PEPPER], ['vered', 482915, h, PEPPER], ['VERED', GOOD_PIN, h, PEPPER],
    [null, null, null, null], ['vered', GOOD_PIN, { toString: () => h }, PEPPER],
  ]) {
    assert.strictEqual(pinHash.verifyPinHash(id, pin, stored, pep), false);
  }
  assert.throws(() => pinHash.hashPin('vered', GOOD_PIN, ''), /PIN_PEPPER/);
  assert.throws(() => pinHash.hashPin('vered', '12345', PEPPER), /6 digits/);
  assert.throws(() => pinHash.hashPin('Vered!', GOOD_PIN, PEPPER), /user id/);
  // A weakened cost can never be parsed back (no silent downgrade).
  assert.strictEqual(pinHash.parsePinHash(pinHash.hashPin('vered', GOOD_PIN, PEPPER, { params: { N: 1024 } })), null);
});

test('pin-hash: constant-time guard — timingSafeEqual over equal-length buffers, no early-exit compare', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'pin-hash.js'), 'utf8');
  const fn = src.slice(src.indexOf('function verifyPinHash('), src.indexOf('module.exports'));
  assert.ok(/crypto\.timingSafeEqual\(got, parsed\.hash\)/.test(fn), 'verify uses crypto.timingSafeEqual');
  assert.ok(!/===\s*parsed\.hash|parsed\.hash\s*===|\.equals\(/.test(fn), 'no plain equality on the digest');
  assert.ok(/hash\.length !== KEY_BYTES/.test(src), 'the stored digest length is fixed, so timingSafeEqual never throws');
  // The digest is compared whole: a near-miss and a far-miss both just say false.
  const h = pinHash.hashPin('yael', GOOD_PIN, PEPPER);
  assert.strictEqual(pinHash.verifyPinHash('yael', '482914', h, PEPPER), false);
  assert.strictEqual(pinHash.verifyPinHash('yael', '905173', h, PEPPER), false);
});

test('pin-hash: weak PINs are rejected — 000000, 123456, all-same, sequential up or down (wrapping)', () => {
  const weak = {
    all_same: ['000000', '111111', '555555', '999999'],
    sequential: ['123456', '012345', '234567', '456789', '789012', '890123', '901234',
      '654321', '987654', '543210', '210987', '109876'],
    format: ['12345', '1234567', 'abcdef', ' 48291', '48291 ', '４８２９１５', '', undefined, null, 482915],
  };
  for (const [reason, list] of Object.entries(weak)) {
    for (const p of list) assert.strictEqual(pinHash.pinWeakness(p), reason, JSON.stringify(p));
  }
  for (const p of ['482915', '135792', '102938', '112233', '246802', '700145']) {
    assert.strictEqual(pinHash.pinWeakness(p), '', p + ' is acceptable');
  }
});

/* ====================================================================== */
/* ============================= lib/users ============================== */
/* ====================================================================== */

test('role model (decided 01/10/2026): exact roles per user, stable ASCII ids', () => {
  const byId = Object.fromEntries(users.USERS.map((u) => [u.id, u]));
  assert.deepStrictEqual(Object.keys(byId), ['sandra', 'vered', 'shiran', 'yael', 'ortal']);
  assert.deepStrictEqual([...byId.sandra.roles], ['staff', 'deleter', 'approver', 'viewer']);
  assert.deepStrictEqual([...byId.vered.roles], ['staff', 'reporter', 'deleter']);
  assert.deepStrictEqual([...byId.shiran.roles], ['staff', 'reporter']);
  assert.deepStrictEqual([...byId.yael.roles], ['staff', 'reporter']);
  assert.deepStrictEqual([...byId.ortal.roles], ['controller'], 'Ortal: controller only, no staff');
  assert.strictEqual(byId.ortal.status, 'inactive', 'Ortal: no login until phase 4');
  for (const id of ['sandra', 'vered', 'shiran', 'yael']) assert.strictEqual(byId[id].status, 'active');
  assert.deepStrictEqual(users.USERS.map((u) => u.name), ['סנדרה', 'ורד', 'שירן', 'יעל', 'אורטל']);
  for (const u of users.USERS) assert.ok(pinHash.USER_ID_PATTERN.test(u.id), u.id);
});

test('role model: Shiran and Yael have NO deleter; a shared APP_PIN session has NO deleter; approver is Sandra only', () => {
  assert.ok(!users.userById('shiran').roles.includes('deleter'));
  assert.ok(!users.userById('yael').roles.includes('deleter'));
  assert.deepStrictEqual([...users.SHARED_SESSION_ROLES], ['staff']);
  assert.ok(!users.SHARED_SESSION_ROLES.includes('deleter') && !users.SHARED_SESSION_ROLES.includes('approver'));
  const approvers = users.USERS.filter((u) => u.roles.includes('approver')).map((u) => u.id);
  assert.deepStrictEqual(approvers, ['sandra']);
  assert.strictEqual(users.APPROVER_USER_ID, 'sandra');
  for (const u of users.USERS) for (const r of u.roles) assert.ok(users.ROLES.includes(r), r);
  assert.ok(Object.isFrozen(users.USERS) && Object.isFrozen(users.USERS[0].roles), 'the model cannot be mutated at runtime');
  // The shared-PIN picker list is untouched in PR A.
  assert.deepStrictEqual(users.SESSION_USERS, ['ורד', 'שירן', 'יעל']);
});

test('role model: Code.gs KNOWN_ROLES === lib/users.js ROLES and APPROVER_USER_NAME === Sandra\'s name', () => {
  const g = loadGs();
  assert.deepStrictEqual(Array.from(gsConst(g, 'KNOWN_ROLES')), [...users.ROLES]);
  assert.strictEqual(gsConst(g, 'APPROVER_USER_NAME'), users.userById(users.APPROVER_USER_ID).name);
  assert.ok(Array.from(gsConst(g, 'PAYMENT_VOID_REVERSERS')).includes(gsConst(g, 'APPROVER_USER_NAME')));
});

/* ====================================================================== */
/* ======================= USER_PIN_HASHES validator ===================== */
/* ====================================================================== */

let SANDRA_REC;
let VERED_REC;
function sandraRec() { return (SANDRA_REC = SANDRA_REC || userPins.buildUserRecord('sandra', GOOD_PIN, PEPPER, 1)); }
function veredRec() { return (VERED_REC = VERED_REC || userPins.buildUserRecord('vered', '305718', PEPPER, 1)); }

test('validator: unset / empty → valid with no records (personal PINs are optional in PR A)', () => {
  for (const raw of [undefined, null, '', '   ', '\n']) {
    assert.deepStrictEqual(userPins.validateUserPinConfig(raw, ''), { ok: true, records: [], errors: [] });
  }
  assert.deepStrictEqual(userPins.validateUserPinConfig('[]', '').records, []);
});

test('validator: a good config passes; a NEW person (unknown id, non-approver) may be added without a deploy', () => {
  const extra = { id: 'noa', name: 'נועה', roles: ['staff'], status: 'active', pinVersion: 1, hash: pinHash.hashPin('noa', '730192', PEPPER) };
  const r = userPins.validateUserPinConfig(JSON.stringify([sandraRec(), veredRec(), extra]), PEPPER);
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.records.length, 3);
  assert.strictEqual(userPins.hasApprover(r.records), true);
  assert.strictEqual(userPins.hasApprover([veredRec()]), false);
});

test('validator: bad JSON, unknown role, non-Sandra approver and every other malformed record FAIL — errors never echo a hash', () => {
  const base = veredRec();
  const cases = {
    'bad JSON': ['[{"id":', /not valid JSON/],
    'not an array': ['{"id":"vered"}', /JSON array/],
    'unknown role': [[Object.assign({}, base, { roles: ['staff', 'superuser'] })], /unknown role/],
    'non-Sandra approver': [[Object.assign({}, base, { roles: ['staff', 'approver'] })], /approver role is pinned/],
    'duplicate role': [[Object.assign({}, base, { roles: ['staff', 'staff'] })], /duplicate role/],
    'empty roles': [[Object.assign({}, base, { roles: [] })], /non-empty/],
    'plaintext PIN as hash': [[Object.assign({}, base, { hash: '305718' })], /valid scrypt/],
    'weak-cost hash': [[Object.assign({}, base, { hash: pinHash.hashPin('vered', '305718', PEPPER, { params: { N: 1024 } }) })], /valid scrypt/],
    'bad status': [[Object.assign({}, base, { status: 'paused' })], /status/],
    'bad pinVersion': [[Object.assign({}, base, { pinVersion: 0 })], /pinVersion/],
    'string pinVersion': [[Object.assign({}, base, { pinVersion: '2' })], /pinVersion/],
    'bad id': [[Object.assign({}, base, { id: 'Vered' })], /id must match/],
    'name mismatch for a known id': [[Object.assign({}, base, { name: 'סנדרה' })], /name does not match/],
    'unknown field': [[Object.assign({}, base, { pin: '305718' })], /unknown field/],
    'duplicate id': [[base, base], /duplicate id/],
  };
  for (const [label, [value, re]] of Object.entries(cases)) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const r = userPins.validateUserPinConfig(raw, PEPPER);
    assert.strictEqual(r.ok, false, label);
    assert.deepStrictEqual(r.records, [], label + ': no records on failure');
    assert.ok(r.errors.some((e) => re.test(e)), label + ': ' + r.errors.join('; '));
    for (const e of r.errors) {
      assert.ok(!e.includes(base.hash.split('$')[6]) && !e.includes('305718'), label + ': error leaks a hash or PIN');
    }
  }
  const noPepper = userPins.validateUserPinConfig(JSON.stringify([base]), '');
  assert.strictEqual(noPepper.ok, false);
  assert.ok(noPepper.errors.some((e) => /PIN_PEPPER/.test(e)));
});

test('validator: `node server.js` with an invalid USER_PIN_HASHES REFUSES TO START (exit 1); require() never exits', () => {
  for (const [raw, re] of [
    ['not-json', /not valid JSON/],
    [JSON.stringify([Object.assign({}, veredRec(), { roles: ['approver'] })]), /approver role is pinned/],
    [JSON.stringify([Object.assign({}, veredRec(), { roles: ['root'] })]), /unknown role/],
  ]) {
    const r = spawnSync(process.execPath, [SERVER_PATH], {
      env: { PATH: process.env.PATH, PORT: '0', USER_PIN_HASHES: raw, PIN_PEPPER: PEPPER },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.strictEqual(r.status, 1, 'exit code for ' + re + ' — stderr: ' + r.stderr);
    assert.ok(re.test(r.stderr), r.stderr);
    assert.ok(/refuses to start/.test(r.stderr));
    assert.ok(!r.stderr.includes(veredRec().hash), 'the hash value is never printed');
  }
  // Required as a module (the test harness), an invalid value only logs.
  const { startupLines } = freshServer({ USER_PIN_HASHES: 'not-json', PIN_PEPPER: PEPPER });
  assert.ok(startupLines.some((l) => /USER_PIN_HASHES is invalid/.test(l)));
});

/* ====================================================================== */
/* ======================== cookie format (session) ====================== */
/* ====================================================================== */

test('cookie: personal token carries id + pinVersion, verifies, and rejects tampering / expiry / scope', () => {
  const t = session.createPersonalToken(SESSION_SECRET, 'vered', 3);
  assert.ok(/^p1\.\d+\.vered\.3\.[0-9a-f]{64}$/.test(t), t);
  const got = session.readPersonalToken(t, SESSION_SECRET);
  assert.strictEqual(got.userId, 'vered');
  assert.strictEqual(got.pinVersion, 3);
  const parts = t.split('.');
  assert.strictEqual(session.readPersonalToken([parts[0], parts[1], 'sandra', parts[3], parts[4]].join('.'), SESSION_SECRET), null, 'id swap');
  assert.strictEqual(session.readPersonalToken([parts[0], parts[1], parts[2], '4', parts[4]].join('.'), SESSION_SECRET), null, 'version bump');
  assert.strictEqual(session.readPersonalToken(t, 'other-secret'), null);
  assert.strictEqual(session.readPersonalToken(t, SESSION_SECRET, 'meeting-report'), null, 'scope');
  assert.strictEqual(session.readPersonalToken(session.createPersonalToken(SESSION_SECRET, 'vered', 3, -5), SESSION_SECRET), null, 'expired');
  assert.throws(() => session.createPersonalToken(SESSION_SECRET, 'ורד', 1), /user id/);
  assert.throws(() => session.createPersonalToken(SESSION_SECRET, 'vered', 0), /pinVersion/);
  assert.throws(() => session.createPersonalToken('', 'vered', 1), /SESSION_SECRET/);
});

test('cookie: current (legacy) tokens stay valid; a personal token authorizes NOTHING yet (wired in PR B)', () => {
  const legacy = session.createSessionToken(SESSION_SECRET);
  const named = session.createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
  assert.strictEqual(session.verifySessionToken(legacy, SESSION_SECRET), true);
  assert.strictEqual(session.readSessionUser(named, SESSION_SECRET), 'ורד');
  const personal = session.createPersonalToken(SESSION_SECRET, 'sandra', 1);
  assert.strictEqual(session.verifySessionToken(personal, SESSION_SECRET), false);
  assert.strictEqual(session.readSessionUser(personal, SESSION_SECRET), '');
  assert.strictEqual(session.readPersonalToken(legacy, SESSION_SECRET), null);
  assert.strictEqual(session.readPersonalToken(named, SESSION_SECRET), null);
  const { mod } = freshServer({});
  assert.strictEqual(mod.sessionAuthStatus('ezone_session=' + personal, SESSION_SECRET), 'unauthorized');
  assert.strictEqual(mod.sessionAuthStatus('ezone_session=' + legacy, SESSION_SECRET), 'ok');
});

/* ====================================================================== */
/* ================================ server ============================== */
/* ====================================================================== */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'MEETING_REPORT_PIN',
  'USER_PIN_HASHES', 'PIN_PEPPER', 'BOOTSTRAP_TOKEN'];

/* Require a fresh server.js under `env` (defaults below), capturing the
 * startup console lines. */
function freshServer(env) {
  const full = Object.assign({
    PROXY_SECRET: PROXY, SESSION_SECRET, SHEETS_URL: 'https://script.example/exec', APP_PIN,
    MEETING_REPORT_PIN: '613072',
  }, env);
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (full[k] === undefined) delete process.env[k]; else process.env[k] = full[k];
  }
  const startupLines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => startupLines.push(a.map(String).join(' '));
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { mod, startupLines };
}

function listen(app) {
  return new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
}

function request(port, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
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
  const { mod, startupLines } = freshServer(env);
  const srv = await listen(mod.app);
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  console.error = console.warn = console.log = console.info = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    return await fn({ port: srv.address().port, mod, lines, startupLines });
  } finally {
    Object.assign(console, orig);
    srv.close();
  }
}

/* What Railway's edge would forward: whatever the client claimed, then the
 * real address Railway appends. */
const viaRailway = (claimed, real) => ({ 'X-Forwarded-For': (claimed ? claimed + ', ' : '') + real });

test('APP_PIN login behaves exactly as before: 200 + legacy cookie, picker name, 401, 429 after 10, reset on success', async () => {
  await withServer({}, async ({ port }) => {
    const ok = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, { ok: true });
    const cookie = ok.headers['set-cookie'][0];
    assert.ok(/^ezone_session=\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/.test(cookie), cookie);

    const named = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN, user: 'ורד' } });
    const tok = /ezone_session=([^;]+)/.exec(named.headers['set-cookie'][0])[1];
    assert.strictEqual(session.readSessionUser(tok, SESSION_SECRET), 'ורד');
    const sandra = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN, user: 'סנדרה' } });
    const sTok = /ezone_session=([^;]+)/.exec(sandra.headers['set-cookie'][0])[1];
    assert.strictEqual(session.readSessionUser(sTok, SESSION_SECRET), '', 'the shared PIN still cannot claim Sandra');

    const h = viaRailway('', '198.51.100.20');
    for (let i = 0; i < 10; i++) {
      const bad = await request(port, 'POST', '/api/verify-pin', { body: { pin: '0000' }, headers: h });
      assert.strictEqual(bad.status, 401);
      assert.deepStrictEqual(bad.json, { ok: false, error: 'invalid_pin' });
    }
    const limited = await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN }, headers: h });
    assert.strictEqual(limited.status, 429, 'blocked before the PIN is even checked');
    assert.strictEqual(limited.json.error, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) > 0);

    const h2 = viaRailway('', '198.51.100.21');
    for (let i = 0; i < 9; i++) await request(port, 'POST', '/api/verify-pin', { body: { pin: '0000' }, headers: h2 });
    assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { pin: APP_PIN }, headers: h2 })).status, 200);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { pin: '0000' }, headers: h2 })).status, 401,
        'a correct PIN reset the counter, so 10 fresh failures are allowed');
    }
  });
  await withServer({ APP_PIN: undefined }, async ({ port }) => {
    assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { pin: '' } })).status, 401, 'unset APP_PIN fails closed');
  });
});

test('X-Forwarded-For spoofing no longer resets the IP counter (verify-pin AND meeting-report verify-pin)', async () => {
  await withServer({}, async ({ port }) => {
    for (const route of ['/api/verify-pin', '/api/meeting-report/verify-pin']) {
      const real = route === '/api/verify-pin' ? '203.0.113.7' : '203.0.113.8';
      for (let i = 0; i < 10; i++) {
        // A different forged left-most entry on every request — the old
        // pinClientIp keyed on exactly this value.
        const r = await request(port, 'POST', route, { body: { pin: '0000' }, headers: viaRailway('10.0.0.' + i, real) });
        assert.strictEqual(r.status, 401);
      }
      const r = await request(port, 'POST', route, { body: { pin: '0000' }, headers: viaRailway('10.9.9.9', real) });
      assert.strictEqual(r.status, 429, route + ': the forged entry did not open a fresh window');
      // Another real client is unaffected.
      const other = await request(port, 'POST', route, { body: { pin: '0000' }, headers: viaRailway('', '203.0.113.99') });
      assert.strictEqual(other.status, 401, route);
    }
  });
});

test('client IP: trust proxy = Railway\'s one hop; req.ip is used, never the left-most X-Forwarded-For', () => {
  const { mod } = freshServer({});
  assert.strictEqual(mod.TRUST_PROXY_HOPS, 1);
  assert.strictEqual(mod.app.get('trust proxy'), 1);
  // The override only accepts 1–5; anything else (incl. 'true', which would
  // trust EVERY hop and re-open the spoof) falls back to 1.
  for (const [raw, n] of [[undefined, 1], ['', 1], ['2', 2], [' 3 ', 3], ['5', 5], ['0', 1], ['6', 1], ['true', 1], ['1,2', 1], ['-1', 1]]) {
    assert.strictEqual(mod.trustProxyHops(raw), n, String(raw));
  }
  assert.strictEqual(mod.pinClientIp({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } }), '203.0.113.7');
  assert.strictEqual(mod.pinClientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function pinClientIp('), SERVER_SRC.indexOf("app.post('/api/verify-pin'"));
  assert.ok(!/x-forwarded-for/i.test(fn), 'pinClientIp no longer reads the header itself');
  assert.ok(!/new Map\(\)/.test(SERVER_SRC.slice(SERVER_SRC.indexOf('const PIN_RATE_LIMIT'))), 'no unbounded attempt maps remain');
});

test('counter maps are bounded: expired windows are pruned and the key count is capped', () => {
  const lim = new FixedWindowLimiter({ max: 3, windowMs: 1000, maxKeys: 5 });
  for (let i = 0; i < 5; i++) lim.fail('ip' + i, 0);
  assert.strictEqual(lim.size, 5);
  lim.fail('ip-new', 500); // full and nothing expired → the oldest key is evicted
  assert.strictEqual(lim.size, 5);
  assert.ok(!lim.map.has('ip0') && lim.map.has('ip-new'));
  lim.fail('late', 2000);   // everything else expired → pruned
  assert.strictEqual(lim.size, 1);
  for (let i = 0; i < 20000; i++) lim.fail('flood' + i, 3000);
  assert.ok(lim.size <= 5, 'a flood of distinct keys never grows the map past the cap');
  // Same semantics as the old counter.
  const l2 = new FixedWindowLimiter({ max: 2, windowMs: 1000 });
  assert.strictEqual(l2.blocked('a', 0).blocked, false);
  l2.fail('a', 0); l2.fail('a', 10);
  assert.deepStrictEqual(l2.blocked('a', 400), { blocked: true, retryAfter: 1 });
  assert.strictEqual(l2.blocked('a', 1000).blocked, false, 'a new window after windowMs');
  l2.fail('a', 1001); l2.reset('a');
  assert.strictEqual(l2.blocked('a', 1002).blocked, false);
});

test('per-user limiter (BUILT, NOT WIRED): 5/user, 10/IP, 30 global per 15 min; success resets user + IP only', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(LOGIN_LIMITS)), {
    perUser: { max: 5, windowMs: 900000 }, perIp: { max: 10, windowMs: 900000 }, global: { max: 30, windowMs: 900000 },
  });
  const L = createLoginLimiter();
  for (let i = 0; i < 5; i++) L.failure({ userId: 'vered', ip: 'ip' + i }, 0);
  assert.deepStrictEqual(L.check({ userId: 'vered', ip: 'fresh' }, 1), { blocked: true, scope: 'user', retryAfter: 900 });
  assert.strictEqual(L.check({ userId: 'yael', ip: 'fresh' }, 1).blocked, false, 'other users unaffected');

  const L2 = createLoginLimiter();
  for (let i = 0; i < 10; i++) L2.failure({ userId: 'u' + i, ip: 'same' }, 0);
  assert.strictEqual(L2.check({ userId: 'new', ip: 'same' }, 1).scope, 'ip');

  const L3 = createLoginLimiter();
  for (let i = 0; i < 30; i++) L3.failure({ userId: 'u' + (i % 7), ip: 'ip' + (i % 4) }, 0);
  assert.strictEqual(L3.check({ userId: 'other', ip: 'other' }, 1).scope, 'global');

  const L4 = createLoginLimiter();
  for (let i = 0; i < 4; i++) L4.failure({ userId: 'vered', ip: 'a' }, 0);
  L4.success({ userId: 'vered', ip: 'a' });
  assert.strictEqual(L4._limiters.user.blocked('vered', 1).blocked, false);
  assert.strictEqual(L4._limiters.global.map.get('*').count, 4, 'the global counter is never reset by a success');
  assert.strictEqual(L4.check({ userId: 'vered', ip: 'a' }, 900001).blocked, false, 'windows expire');

  assert.ok(!SERVER_SRC.includes('createLoginLimiter'), 'not wired into server.js in PR A');
});

/* ---------- POST /api/bootstrap-pin ---------- */

test('bootstrap: absent token → 404; short token or missing pepper → 503 (closed)', async () => {
  await withServer({ BOOTSTRAP_TOKEN: undefined, PIN_PEPPER: PEPPER }, async ({ port }) => {
    const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: GOOD_PIN } });
    assert.strictEqual(r.status, 404);
  });
  await withServer({ BOOTSTRAP_TOKEN: 'short-token', PIN_PEPPER: PEPPER }, async ({ port, startupLines }) => {
    const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: 'short-token', pin: GOOD_PIN } });
    assert.strictEqual(r.status, 503);
    assert.ok(startupLines.some((l) => /BOOTSTRAP_TOKEN is shorter/.test(l)));
  });
  await withServer({ BOOTSTRAP_TOKEN: TOKEN, PIN_PEPPER: undefined }, async ({ port }) => {
    const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: GOOD_PIN } });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error, 'bootstrap_not_configured');
  });
});

test('bootstrap: once only — creates Sandra\'s record (never another id), the PIN is never logged or echoed', async () => {
  await withServer({ BOOTSTRAP_TOKEN: TOKEN, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify([veredRec()]) },
    async ({ port, lines, startupLines, mod }) => {
      assert.ok(startupLines.some((l) => /BOOTSTRAP_TOKEN is set — the one-time \/api\/bootstrap-pin is OPEN/.test(l)),
        'the startup log warns while the token is set');
      assert.strictEqual(mod.bootstrapState(), 'open');

      const weak = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: '123456' } });
      assert.strictEqual(weak.status, 400);
      assert.deepStrictEqual(weak.json, { ok: false, error: 'weak_pin', reason: 'sequential' });

      const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: GOOD_PIN, id: 'vered' } });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.id, 'sandra', 'the id is not a request field');
      const rec = JSON.parse(r.json.record);
      assert.deepStrictEqual(Object.keys(rec), ['id', 'name', 'roles', 'status', 'pinVersion', 'hash']);
      assert.deepStrictEqual([rec.id, rec.name, rec.roles, rec.status, rec.pinVersion],
        ['sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], 'active', 1]);
      assert.strictEqual(pinHash.verifyPinHash('sandra', GOOD_PIN, rec.hash, PEPPER), true);
      // The full value to paste passes the startup validator and keeps Vered.
      const v = userPins.validateUserPinConfig(r.json.value, PEPPER);
      assert.strictEqual(v.ok, true, v.errors.join('; '));
      assert.deepStrictEqual(v.records.map((x) => x.id), ['vered', 'sandra']);
      assert.ok(!r.text.includes(GOOD_PIN), 'the PIN is not in the response');
      assert.strictEqual(r.headers['cache-control'].includes('no-store'), true);

      const again = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: '730192' } });
      assert.strictEqual(again.status, 410, 'once only');
      assert.strictEqual(again.json.error, 'bootstrap_disabled');
      assert.strictEqual(mod.bootstrapState(), 'disabled');

      const all = lines.concat(startupLines).join('\n');
      for (const secret of [GOOD_PIN, '123456', '730192', TOKEN, PEPPER]) {
        assert.ok(!all.includes(secret), 'logged: ' + secret);
      }
      assert.ok(lines.some((l) => /\[bootstrap-pin\] record created for sandra/.test(l)));
    });
});

test('bootstrap: disabled once an approver exists (startup warns to delete the token)', async () => {
  await withServer({ BOOTSTRAP_TOKEN: TOKEN, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify([sandraRec()]) },
    async ({ port, startupLines }) => {
      assert.ok(startupLines.some((l) => /BOOTSTRAP_TOKEN is still set, but an approver record exists/.test(l)));
      const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: '730192' } });
      assert.strictEqual(r.status, 410);
    });
});

test('bootstrap: a wrong token → 403 and rate-limited (5 per IP per 15 min, then 429 even with the right token)', async () => {
  await withServer({ BOOTSTRAP_TOKEN: TOKEN, PIN_PEPPER: PEPPER }, async ({ port, lines }) => {
    const h = viaRailway('', '192.0.2.50');
    for (let i = 0; i < 5; i++) {
      const r = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: 'wrong-' + i, pin: GOOD_PIN }, headers: viaRailway('1.1.1.' + i, '192.0.2.50') });
      assert.strictEqual(r.status, 403);
      assert.deepStrictEqual(r.json, { ok: false, error: 'forbidden' });
    }
    const blocked = await request(port, 'POST', '/api/bootstrap-pin', { body: { token: TOKEN, pin: GOOD_PIN }, headers: h });
    assert.strictEqual(blocked.status, 429);
    const missing = await request(port, 'POST', '/api/bootstrap-pin', { body: { pin: GOOD_PIN }, headers: viaRailway('', '192.0.2.51') });
    assert.strictEqual(missing.status, 403, 'a missing token is a wrong token');
    assert.ok(!lines.join('\n').includes(GOOD_PIN), 'the PIN is never logged');
  });
  const fn = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/bootstrap-pin'"), SERVER_SRC.indexOf('/* GET /api/me — '));
  assert.ok(/checkPin\(typeof body\.token === 'string' \? body\.token : '', BOOTSTRAP_TOKEN\)/.test(fn), 'constant-time token compare');
  // Every console call in the handler, with its string literals removed, may
  // reference no variable at all except the fixed id constant.
  const consoleArgs = [...fn.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => m[1].replace(/'[^']*'/g, "''"));
  assert.ok(consoleArgs.length >= 2);
  for (const a of consoleArgs) {
    assert.ok(!/\b(body|pin|record|req|token)\b/.test(a), 'nothing request- or PIN-derived is logged: ' + a);
  }
});

test('PIN_PEPPER and BOOTSTRAP_TOKEN are redacted like every other secret', () => {
  const { mod } = freshServer({ PIN_PEPPER: PEPPER, BOOTSTRAP_TOKEN: TOKEN });
  assert.strictEqual(mod.safeErrorMessage(new Error('a ' + PEPPER + ' b ' + TOKEN)), 'a [REDACTED] b [REDACTED]');
});

/* ---------- proxyRoles from the server ---------- */

test('server: a shared APP_PIN session forwards proxyRoles ["staff"] — never deleter — and a client cannot inject roles', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push(JSON.parse(body));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', '{"ok":true}'); res.emit('end'); });
    };
    return req;
  };
  try {
    await withServer({}, async ({ port, mod }) => {
      const cookie = 'ezone_session=' + session.createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');
      assert.deepStrictEqual(mod.sessionRolesFromRequest({ headers: { cookie } }), ['staff']);
      assert.deepStrictEqual(mod.sessionRolesFromRequest({ headers: {} }), []);
      await request(port, 'POST', '/api/sheets', {
        headers: { Cookie: cookie },
        body: { action: 'removeLead', lead: { id: 'L1' }, proxyRoles: ['deleter', 'approver'], _verifiedActor: { user: 'סנדרה', roles: ['approver'] } },
      });
      await request(port, 'GET', '/api/sheets?action=getData&proxyRoles=approver', { headers: { Cookie: cookie } });
    });
  } finally {
    https.request = original;
  }
  assert.strictEqual(calls.length, 2);
  for (const b of calls) {
    assert.deepStrictEqual(b.proxyRoles, ['staff']);
    assert.ok(!('_verifiedActor' in b), 'a client _verifiedActor is dropped');
    assert.strictEqual(b.proxyUser, 'ורד');
  }
});

/* ====================================================================== */
/* =============================== Code.gs ============================== */
/* ====================================================================== */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()].concat((dataRows || []).map((r) => r.slice())) : [];
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() {},
    isSheetHidden() { return true; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() { ++opSeq; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        clearContent() {
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = '';
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

/* Load Code.gs with the GAS globals stubbed. `spy` replaces handle_ with a
 * recorder (the gate is what's tested); otherwise the real handlers run. */
function loadGs(opts) {
  const o = opts || {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isNaN, isFinite,
    Logger: { log: noop },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
      getId: () => 'ss',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty: (k, v) => { sandbox.__props[k] = v; },
    }),
  };
  sandbox.CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in sandbox.__cache ? sandbox.__cache[k] : null),
      put: (k, v) => { sandbox.__cache[k] = v; },
      remove: (k) => { delete sandbox.__cache[k]; },
    }),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: noop, releaseLock: noop }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s), raw: s }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
    formatDate: (d) => new Date(d).toISOString().slice(0, 10),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  const calls = [];
  if (o.spy) {
    sandbox.handle_ = (params) => {
      calls.push(params);
      return sandbox.jsonOut_({ ok: true, served: params.action });
    };
  }
  const post = (body, query) => sandbox.doPost({
    parameter: Object.assign({}, query || {}),
    postData: { contents: JSON.stringify(body || {}) },
  }).json;
  return { sandbox, calls, post };
}

const gsConst = (g, name) => vm.runInContext(name, g.sandbox);
const arr = (x) => Array.from(x);

test('Code.gs: roles ONLY for the verified proxy — never for no-secret, wrong-secret or open-action callers', () => {
  for (const mode of ['log', 'enforce']) {
    const g = loadGs({ spy: true, props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: mode } });
    g.post({ action: 'removeLead', proxySecret: PROXY, proxyUser: 'ורד', proxyRoles: ['staff', 'reporter', 'deleter'] });
    const ok = g.calls[0];
    assert.strictEqual(g.sandbox.actingUser_(ok), 'ורד');
    assert.strictEqual(g.sandbox.hasRole_(ok, 'deleter'), true);
    assert.strictEqual(g.sandbox.hasRole_(ok, 'approver'), false);
    assert.ok(!('proxyRoles' in ok) && !('proxySecret' in ok), 'proxy fields never reach a handler');
  }
  const g = loadGs({ spy: true, props: { PROXY_SECRET: PROXY } }); // log mode serves everything
  const forged = { user: 'סנדרה', proxyRoles: ['deleter', 'approver'], _verifiedActor: { user: 'סנדרה', roles: ['approver', 'deleter'] } };
  g.post(Object.assign({ action: 'removeLead' }, forged));                                  // no secret
  g.post(Object.assign({ action: 'removeLead', proxySecret: 'wrong' }, forged));            // wrong secret
  g.post(Object.assign({ action: 'managersOverview' }, forged));                            // open action
  g.post({ action: 'removeLead' }, { proxyRoles: '["approver"]', _verifiedActor: '{"user":"סנדרה","roles":["approver"]}' }); // querystring
  g.post({ action: 'removeLead', proxySecret: PROXY, proxyUser: 'ורד', proxyRoles: ['staff'] }, { _verifiedActor: 'x', proxyRoles: '["deleter"]' });
  assert.strictEqual(g.calls.length, 5);
  for (const p of g.calls.slice(0, 4)) {
    assert.strictEqual(g.sandbox.actingUser_(p), '', 'no verified identity');
    for (const r of ['staff', 'deleter', 'approver']) assert.strictEqual(g.sandbox.hasRole_(p, r), false, r);
    assert.ok(!('proxyRoles' in p));
  }
  // A verified request: query-string roles are ignored (body only), a query _verifiedActor dropped.
  assert.strictEqual(g.sandbox.hasRole_(g.calls[4], 'staff'), true);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[4], 'deleter'), false);
});

test('Code.gs: approver is pinned to Sandra; unknown roles dropped; a JSON-string role list is accepted', () => {
  const g = loadGs({ spy: true, props: { PROXY_SECRET: PROXY } });
  g.post({ action: 'savePayment', proxySecret: PROXY, proxyUser: 'ורד', proxyRoles: ['staff', 'approver', 'root', 'deleter', 'deleter'] });
  g.post({ action: 'savePayment', proxySecret: PROXY, proxyUser: 'סנדרה', proxyRoles: JSON.stringify(['staff', 'deleter', 'approver', 'viewer']) });
  g.post({ action: 'savePayment', proxySecret: PROXY, proxyUser: 'סנדרה' });
  assert.deepStrictEqual(arr(g.calls[0]._verifiedActor.roles), ['staff', 'deleter']);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[0], 'approver'), false);
  assert.strictEqual(g.sandbox.hasRole_(g.calls[1], 'approver'), true);
  assert.deepStrictEqual(arr(g.calls[2]._verifiedActor.roles), [], 'no roles sent → none');
  // Even a hand-built actor cannot make a non-Sandra user an approver.
  assert.strictEqual(g.sandbox.hasRole_({ _verifiedActor: { user: 'ורד', roles: ['approver'] } }, 'approver'), false);
});

test('Code.gs: DELETE_ACTIONS / DELETE_OPERATIONS / APPROVER_ACTIONS are pinned, and roleCheck_ maps them', () => {
  const g = loadGs();
  assert.deepStrictEqual(arr(gsConst(g, 'DELETE_ACTIONS')), ['removeLead', 'deleteMeetingReport', 'deletePatientRow', 'deleteBillingOverride']);
  assert.deepStrictEqual(arr(gsConst(g, 'DELETE_OPERATIONS')), ['payment_void', 'credit_cancel']);
  assert.deepStrictEqual(arr(gsConst(g, 'APPROVER_ACTIONS')),
    ['payment_unvoid', 'credit_exception', 'opening_balance_write_off', 'opening_balance_accept']);
  const vered = { _verifiedActor: { user: 'ורד', roles: ['staff', 'reporter', 'deleter'] } };
  const shiran = { _verifiedActor: { user: 'שירן', roles: ['staff', 'reporter'] } };
  const shared = { _verifiedActor: { user: 'ורד', roles: ['staff'] } };
  const sandra = { _verifiedActor: { user: 'סנדרה', roles: ['staff', 'deleter', 'approver', 'viewer'] } };
  const rc = (p, k) => JSON.parse(JSON.stringify(g.sandbox.roleCheck_(p, k)));
  assert.deepStrictEqual(rc(vered, 'removeLead'), { ok: true, role: 'deleter' });
  assert.deepStrictEqual(rc(shiran, 'removeLead'), { ok: false, role: 'deleter', error: 'requires_deleter' });
  assert.deepStrictEqual(rc(shared, 'payment_void'), { ok: false, role: 'deleter', error: 'requires_deleter' });
  assert.deepStrictEqual(rc(vered, 'payment_unvoid'), { ok: false, role: 'approver', error: 'requires_approver' });
  assert.deepStrictEqual(rc(sandra, 'credit_exception'), { ok: true, role: 'approver' });
  assert.deepStrictEqual(rc({}, 'saveAll'), { ok: true, role: '' });
  assert.deepStrictEqual(rc({ user: 'סנדרה' }, 'removeLead').ok, false, 'a body user is not an identity');
});

test('Code.gs scan guard: DELETE_ACTIONS covers every delete / remove / void / cancel action handle_ dispatches', () => {
  const body = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  const dispatched = [...new Set([...body.matchAll(/action === '([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];
  assert.ok(dispatched.length >= 20, 'the scan found handle_\'s dispatch list');
  const g = loadGs();
  const del = arr(gsConst(g, 'DELETE_ACTIONS'));
  const destructive = dispatched.filter((a) => /delete|remove|void|purge|cancel|drop|wipe|erase|destroy|clear/i.test(a));
  for (const a of destructive) assert.ok(del.includes(a), a + ' is a delete-like action missing from DELETE_ACTIONS');
  for (const a of del) assert.ok(dispatched.includes(a), a + ' is not an action handle_ dispatches');
  // Nothing enforces yet: roleCheck_ is defined but handle_ never calls it.
  assert.ok(!/roleCheck_\(|hasRole_\(/.test(body), 'PR A defines role checks but does not enforce them');
});

test('Code.gs: role checks are NOT enforced — a staff-only proxy request still removes a lead', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const LC = arr(gsConst(g, 'LEAD_COLUMNS'));
  g.sandbox.__sheets.Leads = fakeSheet(LC, [LC.map((c) => (c === 'id' ? 'L1' : c === 'name' ? 'ליד' : ''))]);
  const out = g.post({ action: 'removeLead', lead: { id: 'L1', name: 'ליד' }, proxySecret: PROXY, proxyUser: 'שירן', proxyRoles: ['staff', 'reporter'] });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
});

/* ---------- actor stamps ---------- */

function auditRows(g) {
  const sh = g.sandbox.__sheets.AuditLog;
  const cols = arr(gsConst(g, 'AUDIT_LOG_COLUMNS'));
  return sh ? sh.grid.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))) : [];
}

test('AuditLog: `actor` is APPENDED (an existing 6-column tab grows a 7th header cell, nothing moves)', () => {
  const g = loadGs();
  const old = ['timestamp', 'action', 'fn', 'patientId', 'name', 'details'];
  g.sandbox.__sheets.AuditLog = fakeSheet(old, [['2026-09-01T00:00:00.000Z', 'x', 'f', 'p', 'n', '{}']]);
  g.sandbox.logAudit_('test_action', 'fn_', 'P1', 'שם', { a: 1 }, 'ורד');
  const grid = g.sandbox.__sheets.AuditLog.grid;
  assert.deepStrictEqual(grid[0], old.concat('actor'));
  assert.deepStrictEqual(grid[1].slice(0, 6), ['2026-09-01T00:00:00.000Z', 'x', 'f', 'p', 'n', '{}'], 'old row untouched');
  assert.strictEqual(grid[2][6], 'ורד');
  // Pre-existing call sites fill it from the who-field they already log.
  g.sandbox.logAudit_('a', 'f', '', '', { updatedBy: 'יעל' });
  g.sandbox.logAudit_('a', 'f', '', '', { by: 'סנדרה' });
  g.sandbox.logAudit_('a', 'f', '', '', {});
  assert.deepStrictEqual(grid.slice(3).map((r) => r[6]), ['יעל', 'סנדרה', '']);
});

test('actor stamps: lead move / restore / remove, meeting-report delete and billing overrides record who did it', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  const LC = arr(gsConst(g, 'LEAD_COLUMNS'));
  const row = (id, extra) => LC.map((c) => (c === 'id' ? id : c === 'name' ? 'ליד ' + id : (extra && extra[c]) || ''));
  g.sandbox.__sheets.Leads = fakeSheet(LC, [row('L1'), row('L2'), row('L3', { meetingReportedAt: '2026-09-30T10:00:00.000Z', meetingOutcome: 'x' })]);
  const call = (body) => g.post(Object.assign({ proxySecret: PROXY, proxyUser: 'ורד', proxyRoles: ['staff', 'reporter', 'deleter'], user: 'סנדרה' }, body));

  assert.strictEqual(call({ action: 'moveLeadIrrelevant', lead: { id: 'L1', name: 'ליד L1', not_relevant_reason: 'r' } }).ok, true);
  assert.strictEqual(call({ action: 'restoreLead', lead: { id: 'L1', name: 'ליד L1' } }).ok, true);
  assert.strictEqual(call({ action: 'removeLead', lead: { id: 'L2', name: 'ליד L2' } }).ok, true);
  const mr = call({ action: 'deleteMeetingReport', leadId: 'L3' });
  assert.strictEqual(mr.ok, true, JSON.stringify(mr));
  const up = call({ action: 'upsertBillingOverride', override: { patientId: 'P1', month: '2026-09', amount: 12000, updatedBy: 'סנדרה' } });
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.override.updatedBy, 'ורד', 'server-owned: a payload updatedBy is ignored');
  call({ action: 'upsertBillingOverride', override: { patientId: 'P1', month: '2026-09', amount: 13000 }, proxyUser: 'יעל' });
  call({ action: 'deleteBillingOverride', override: { patientId: 'P1', month: '2026-09' } });

  const rows = auditRows(g);
  const byAction = (a) => rows.filter((r) => r.action === a);
  for (const a of ['lead_moved_irrelevant', 'lead_restored', 'lead_removed', 'meeting_report_deleted',
    'billing_override_created', 'billing_override_deleted']) {
    assert.strictEqual(byAction(a).length, 1, a);
    assert.strictEqual(byAction(a)[0].actor, 'ורד', a + ' actor (the proxy user, not the body user)');
  }
  assert.strictEqual(byAction('billing_override_updated')[0].actor, 'יעל');

  const BOC = arr(gsConst(g, 'BILLING_OVERRIDE_COLUMNS'));
  assert.deepStrictEqual(BOC, ['id', 'patientId', 'month', 'amount', 'created', 'updatedBy']);
});

test('actor stamps: billing-override updatedBy is appended on an existing 5-column tab', () => {
  const g = loadGs();
  g.sandbox.__sheets.BillingOverrides = fakeSheet(['id', 'patientId', 'month', 'amount', 'created'],
    [['ovr::P9::2026-08', 'P9', '2026-08', '5000', '2026-08-01']]);
  const out = g.sandbox.upsertBillingOverride_({ patientId: 'P9', month: '2026-08', amount: 5500 }, 'ורד');
  assert.strictEqual(out.updated, true);
  const grid = g.sandbox.__sheets.BillingOverrides.grid;
  assert.deepStrictEqual(grid[0], ['id', 'patientId', 'month', 'amount', 'created', 'updatedBy']);
  assert.strictEqual(grid[1][5], 'ורד');
  // A direct call without a user (editor-run) stamps blank, never undefined.
  g.sandbox.upsertBillingOverride_({ patientId: 'P8', month: '2026-08', amount: 1 });
  assert.strictEqual(grid[2][5], '');
});

test('getData keeps its keys, and billing overrides keep theirs plus updatedBy', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  g.sandbox.__sheets.BillingOverrides = fakeSheet(['id', 'patientId', 'month', 'amount', 'created', 'updatedBy'],
    [['ovr::P1::2026-09', 'P1', '2026-09', '12000', '2026-09-01', 'ורד']]);
  const out = g.post({ action: 'getData', proxySecret: PROXY, proxyUser: 'ורד', proxyRoles: ['staff'] });
  assert.strictEqual(out.ok, true, JSON.stringify(out).slice(0, 300));
  for (const k of ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']) {
    assert.ok(k in out, 'getData lost ' + k);
  }
  assert.ok(!('_verifiedActor' in out) && !JSON.stringify(out).includes('_verifiedActor'), 'the actor never leaves Code.gs');
  const bo = out.billingOverrides[0];
  for (const k of ['id', 'patientId', 'month', 'amount', 'created']) assert.ok(k in bo, k);
});

/* sanity: the hash never crosses into Code.gs or the browser bundle */
test('no PIN hash or pepper handling in Code.gs or public/', () => {
  assert.ok(!/USER_PIN_HASHES|PIN_PEPPER|scrypt/.test(GS_SRC));
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    const p = path.join(ROOT, 'public', f);
    if (fs.statSync(p).isFile() && /\.(js|html)$/.test(f)) {
      assert.ok(!/USER_PIN_HASHES|PIN_PEPPER|BOOTSTRAP_TOKEN|bootstrap-pin/.test(fs.readFileSync(p, 'utf8')), f);
    }
  }
  assert.ok(crypto.timingSafeEqual, 'node crypto present');
});
