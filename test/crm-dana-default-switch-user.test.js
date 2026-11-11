'use strict';

/* Dana on the CRM by default + «החלפת משתמש» (CHANGELOG-crm-dana-default-switch-user.md).
 *
 *   1. routing (REAL server, CRM_ENABLED + CRM_DEFAULT): Dana → CRM at `/`;
 *      Ortal → classic; `?view=classic` → classic for everyone; /api/me.landing
 *   2. Dana gets 403 + a Hebrew message on EVERY billing / money-write route the
 *      CRM uses (and every FINANCE action, export and debug route), before the proxy
 *   3. the UI: no «גבייה» area and no «חשבון» tab for her (pure core + drawer source)
 *   4. logout: same-origin POST revokes the token server-side — the old cookie gets
 *      401 everywhere; a cross-origin POST is refused and revokes nothing; other
 *      sessions stay valid; no PIN / token in the logs
 *   5. lib/session-revocation.js (expiry, bound, junk)
 *   6. the switch-user controls: both headers, 44px, escaped name, login landing rule */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = require.resolve('../server');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');
const CRM_CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { FINANCE_ACTIONS, FINANCE_ROUTES, BILLING_CONTROL_ACTIONS } = require('../lib/finance-scope');
const core = require('../public/crm/crm.js');
const { createSessionToken } = require('../lib/session');
const { createRevocationStore } = require('../lib/session-revocation');

const SESSION_SECRET = 'session-secret-TEST-switch-0123456789abcdef01';
const PROXY_SECRET = 'proxy-secret-TEST-switch-7f3a9c1e5b2d4f6a8c0e1';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-switch-a1b2c3d4e5f60718293a4b5c6d7';
const PIN = '583920';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN', 'CRM_ENABLED', 'CRM_DEFAULT'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', dana: 'דנה', ortal: 'אורטל' };
/* `ttl` varies the token so two sessions of one user are two different tokens. */
const tokenFor = (id, ttl) => createSessionToken(SESSION_SECRET, ttl, undefined, NAMES[id], { id, pinVersion: 1 });
const cookieOf = (token) => 'ezone_session=' + token;
const HEBREW = /[֐-׿]/;

const GETDATA = { ok: true, leads: [{ id: 'L1', name: 'ליד', advance: 500 }], patients: { ramot: [{ id: 'p1', name: 'דנה כהן', pay: 6000 }] }, billingOverrides: [] };

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  console.error = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' '));
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { mod, lines };
}
function stubHttps() {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch (_) { /* */ }
      calls.push(parsed);
      const answer = parsed.action === 'getData' ? GETDATA : { ok: true, served: parsed.action };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}
function request(port, method, urlPath, { cookie, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf, json: (() => { try { return JSON.parse(buf); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
let _hash;
async function records() {
  if (!_hash) _hash = await pinHash.hashPin(PIN, PEPPER);
  return ['vered', 'sandra', 'dana', 'ortal'].map((id) => JSON.parse(users.recordLine(id, _hash, 1)));
}
async function withServer(fn, extra) {
  const env = Object.assign({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records()), CRM_ENABLED: 'true', CRM_DEFAULT: 'true' }, extra || {});
  const { mod, lines } = freshServer(env);
  const stub = stubHttps();
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
  try { return await fn(srv.address().port, mod, stub, lines); } finally { srv.close(); stub.restore(); Object.assign(console, quiet); }
}
const isCrm = (r) => /id="crm-root"/.test(r.text);
const sameOrigin = (port) => ({ Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });

/* ===== 1. routing ===== */

test('routing: CRM_DEFAULT — Dana and Vered/Sandra land on the CRM at `/`, Ortal on classic; `?view=classic` is classic for everyone; /api/me.landing says the same', async () => {
  await withServer(async (port) => {
    for (const id of ['dana', 'vered', 'sandra']) {
      const c = cookieOf(tokenFor(id));
      assert.ok(isCrm(await request(port, 'GET', '/', { cookie: c })), id + ' → CRM at /');
      const classic = await request(port, 'GET', '/?view=classic', { cookie: c });
      assert.strictEqual(classic.status, 200);
      assert.ok(!isCrm(classic) && /id="pin-screen"/.test(classic.text), id + ' ?view=classic → classic');
      assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: c })).json.landing, 'crm', id);
    }
    const ortal = cookieOf(tokenFor('ortal'));
    // Ortal lands on the CRM too (CHANGELOG-ortal-crm-default.md); her classic page stays one link away
    assert.ok(isCrm(await request(port, 'GET', '/', { cookie: ortal })), 'Ortal → CRM at /');
    assert.ok(!isCrm(await request(port, 'GET', '/?view=classic', { cookie: ortal })));
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: ortal })).json.landing, 'crm');
    // no session → the PIN page, never the CRM
    assert.ok(!isCrm(await request(port, 'GET', '/')));
  });
  // without CRM_DEFAULT nobody lands on the CRM (and landing says classic)
  await withServer(async (port) => {
    const c = cookieOf(tokenFor('dana'));
    assert.ok(!isCrm(await request(port, 'GET', '/', { cookie: c })));
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: c })).json.landing, 'classic');
  }, { CRM_DEFAULT: undefined });
});

/* ===== 2. Dana: 403 on every billing / money-write route ===== */

/* What the CRM's «גבייה» area and «חשבון» pane call — reads of billing data
 * and every money write. Each must be called by crm.js (so the list cannot rot)
 * and refused for Dana. */
const CRM_MONEY_ACTIONS = ['getPayments', 'debtAging', 'getCredits', 'billingControlQueue',
  'reportPayment', 'savePayment', 'setBillingDiscount', 'upsertBillingOverride', 'settleRefund', 'editReceipt', 'appendFunder'];

test('server: Dana gets 403 + a Hebrew message on every billing read and money write (CRM list, every FINANCE action, «בקרת גבייה», the accountant void, exports, debug) — nothing reaches the proxy', async () => {
  for (const a of CRM_MONEY_ACTIONS) assert.ok(new RegExp("(api\\(\\s*'" + a + "'|action: '" + a + "')").test(CRM_SRC), 'crm.js calls ' + a);
  const actions = Array.from(new Set([...CRM_MONEY_ACTIONS, ...FINANCE_ACTIONS, ...BILLING_CONTROL_ACTIONS, 'confirmPayment', 'voidUnpaidClaim']));
  await withServer(async (port, _mod, stub) => {
    const dana = cookieOf(tokenFor('dana'));
    const before = stub.calls.length;
    for (const action of actions) {
      for (const [method, url, body] of [['POST', '/api/sheets', { action, id: 'x' }], ['GET', '/api/sheets?action=' + action, null]]) {
        const r = await request(port, method, url, { cookie: dana, body });
        assert.strictEqual(r.status, 403, `${method} ${action}: ${r.text}`);
        assert.strictEqual(r.json.ok, false);
        assert.ok(HEBREW.test(r.json.message), `${method} ${action}: Hebrew message, got ${r.json.message}`);
      }
    }
    for (const route of [...FINANCE_ROUTES, '/api/export/billing-control.xlsx']) {
      const r = await request(port, 'GET', route, { cookie: dana });
      assert.strictEqual(r.status, 403, route);
      assert.ok(HEBREW.test(r.json.message), route);
    }
    assert.strictEqual(stub.calls.length, before, 'no refused request reached Apps Script');
    // her operational work is untouched (CRM spec §2 — see the report): getData passes, projected
    const g = await request(port, 'GET', '/api/sheets?action=getData', { cookie: dana });
    assert.strictEqual(g.status, 200);
    assert.ok(!/"pay"|"advance"/.test(g.text), 'no money field in her getData');
    // Vered (finance) still reaches the same money reads
    const v = await request(port, 'GET', '/api/sheets?action=getPayments', { cookie: cookieOf(tokenFor('vered')) });
    assert.strictEqual(v.status, 200);
  });
});

/* ===== 3. the UI: no «גבייה», no «חשבון» for Dana ===== */

test('CRM UI: Dana (view ops) has no «גבייה» area and no «חשבון» tab; Vered and Ortal keep theirs; the drawer builds the tab only through accountTabVisible', () => {
  const dana = { view: 'ops', ops: true, finance: false, billingRead: false };
  assert.ok(!core.areasFor(dana).includes('billing'), 'no «גבייה» area');
  assert.strictEqual(core.accountTabVisible(dana), false, 'no «חשבון» tab');
  assert.strictEqual(core.accountTabVisible({ view: 'ops', finance: true }), false, 'ops never, even with a stray flag');
  assert.strictEqual(core.accountTabVisible({ view: 'full', finance: true }), true, 'Vered');
  assert.strictEqual(core.accountTabVisible({ view: 'controller', billingRead: true }), true, 'Ortal (read)');
  assert.strictEqual(core.accountTabVisible({ view: 'restricted', finance: false }), false);
  assert.strictEqual(core.accountTabVisible(null), false);
  assert.ok(core.areasFor({ view: 'full', finance: true }).includes('billing'));
  // the drawer: the tab list and the pane both go through the rule
  assert.ok(/\['account', 'חשבון'\], \['docs', 'מסמכים'\]\]\.filter\(function \(t\) \{ return t\[0\] !== 'account' \|\| accountTabVisible\(state\.me\); \}\)/.test(CRM_SRC));
  assert.ok(/\(accountTabVisible\(state\.me\) \? '<section data-pane="account"/.test(CRM_SRC));
  assert.ok(/if \(prevTab === 'account' && !accountTabVisible\(state\.me\)\) prevTab = 'overview';/.test(CRM_SRC), 'a kept «חשבון» tab falls back to «סקירה»');
});

/* ===== 4. logout ===== */

test('logout: a same-origin POST ends the session on the server — the old cookie gets 401 on /api/me, /api/sheets and every data route; `/` serves the PIN page; other sessions stay valid', async () => {
  await withServer(async (port, _mod, stub) => {
    const tok = tokenFor('dana');
    const old = cookieOf(tok);
    const other = cookieOf(tokenFor('dana', 3600)); // her other device: a different token
    const vered = cookieOf(tokenFor('vered'));
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: old })).status, 200);
    const out = await request(port, 'POST', '/api/logout', { cookie: old, headers: sameOrigin(port) });
    assert.strictEqual(out.status, 200);
    assert.match(String(out.headers['set-cookie']), /ezone_session=;.*Max-Age=0/);
    const calls = stub.calls.length;
    for (const [m, u, b] of [['GET', '/api/me'], ['GET', '/api/sheets?action=getData'], ['POST', '/api/sheets', { action: 'saveAll', leads: [], patients: {} }], ['GET', '/api/export/debt-aging.xlsx']]) {
      const r = await request(port, m, u, { cookie: old, body: b });
      assert.strictEqual(r.status, 401, `${m} ${u} with the logged-out cookie → 401 (got ${r.status})`);
    }
    assert.strictEqual(stub.calls.length, calls, 'nothing proxied for the dead cookie');
    const page = await request(port, 'GET', '/', { cookie: old });
    assert.ok(!isCrm(page) && !page.text.includes('דנה'), '`/` with the dead cookie is the PIN page, without her name');
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: other })).status, 200, 'her other session is not touched');
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: vered })).status, 200, 'other users are not touched');
    // a second logout with the dead cookie is harmless
    assert.strictEqual((await request(port, 'POST', '/api/logout', { cookie: old, headers: sameOrigin(port) })).status, 200);
  });
});

test('logout: cross-origin (Origin of another site, or Sec-Fetch-Site cross-site) → 403 Hebrew and the session stays valid; no header (curl) passes', async () => {
  await withServer(async (port) => {
    const c = cookieOf(tokenFor('vered'));
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site', Origin: `http://127.0.0.1:${port}` }, { Origin: 'not a url' }]) {
      const r = await request(port, 'POST', '/api/logout', { cookie: c, headers });
      assert.strictEqual(r.status, 403, JSON.stringify(headers));
      assert.strictEqual(r.json.error, 'forbidden_origin');
      assert.ok(HEBREW.test(r.json.message));
      assert.ok(!r.headers['set-cookie'], 'the cookie is not touched');
      assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: c })).status, 200, 'still logged in');
    }
    const plain = await request(port, 'POST', '/api/logout', { cookie: c });
    assert.strictEqual(plain.status, 200, 'no Origin / Sec-Fetch-Site → not a cross-site browser request');
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: c })).status, 401);
    // GET is not a logout
    assert.strictEqual((await request(port, 'GET', '/api/logout')).status, 404);
  });
});

test('login → logout → login: no PIN, no token and no name in the server logs (user id only); the next login gets a fresh session', async () => {
  await withServer(async (port, _mod, _stub, lines) => {
    const login = await request(port, 'POST', '/api/verify-pin', { body: { userId: 'dana', pin: PIN } });
    assert.strictEqual(login.status, 200, login.text);
    const tok = /ezone_session=([^;]+)/.exec(String(login.headers['set-cookie']))[1];
    assert.strictEqual((await request(port, 'POST', '/api/logout', { cookie: cookieOf(tok), headers: sameOrigin(port) })).status, 200);
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: cookieOf(tok) })).status, 401);
    const again = await request(port, 'POST', '/api/verify-pin', { body: { userId: 'vered', pin: PIN } });
    assert.strictEqual(again.status, 200);
    const tok2 = /ezone_session=([^;]+)/.exec(String(again.headers['set-cookie']))[1];
    const me = await request(port, 'GET', '/api/me', { cookie: cookieOf(tok2) });
    assert.strictEqual(me.json.user, 'ורד', 'the new session is the new user');
    assert.strictEqual(me.json.landing, 'crm');
    const log = lines.join('\n');
    assert.ok(!log.includes(PIN), 'no PIN in the logs');
    assert.ok(!log.includes(tok) && !log.includes(tok2), 'no token in the logs');
    assert.ok(log.includes('[logout] session ended user=dana'), 'the logout is logged with the id only');
    assert.ok(!/\[logout\][^\n]*דנה/.test(log), 'no name on the logout line');
  });
});

/* ===== 5. the revocation store ===== */

test('session-revocation: revoked until its own expiry, then forgotten; bounded; junk ignored; the key is a hash, never the token', () => {
  let t = 1000;
  const st = createRevocationStore({ max: 3, now: () => t });
  assert.strictEqual(st.revoke('tok-a', 1100), true);
  assert.strictEqual(st.isRevoked('tok-a'), true);
  assert.strictEqual(st.isRevoked('tok-b'), false);
  t = 1100;
  assert.strictEqual(st.isRevoked('tok-a'), false, 'expired tokens are dead anyway — forgotten');
  assert.strictEqual(st.revoke('tok-x', 900), false, 'an already-expired token is not stored');
  for (const bad of ['', null, undefined, 42]) { assert.strictEqual(st.revoke(bad, 2000), false); assert.strictEqual(st.isRevoked(bad), false); }
  ['t1', 't2', 't3', 't4'].forEach((k) => st.revoke(k, 5000));
  assert.strictEqual(st.size(), 3, 'bounded');
  assert.strictEqual(st.isRevoked('t1'), false, 'oldest dropped first');
  assert.strictEqual(st.isRevoked('t4'), true);
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'session-revocation.js'), 'utf8');
  assert.ok(/createHash\('sha256'\)/.test(src) && /entries\.set\(k, exp\)/.test(src), 'stored by SHA-256 key');
  // every session check in server.js goes through the store
  assert.ok(/function readLiveSession\(token, secret\) \{\n  if \(!token \|\| REVOKED_SESSIONS\.isRevoked\(token\)\) return null;/.test(SERVER_SRC));
  assert.strictEqual((SERVER_SRC.match(/readLiveSession\(/g) || []).length, 3, 'definition + sessionAuthStatus + sessionPrincipalFromRequest');
});

/* ===== 6. the switch-user controls ===== */

test('«החלפת משתמש»: in the CRM header and the classic header; 44px tap target; POST /api/logout then `/`; the name is escaped / a text node; client state + offline pages cleared', () => {
  // CRM
  assert.ok(/<button type="button" id="crm-switch-user" class="btn crm-switch-user">החלפת משתמש<\/button>/.test(CRM_HTML));
  assert.ok(/<span id="crm-who" class="crm-who">__USER__<\/span>/.test(CRM_HTML), 'the header shows the current user');
  assert.ok(/\.crm-switch-user \{ min-height: 44px; min-width: 44px;/.test(CRM_CSS));
  assert.ok(/win\.fetch\('\/api\/logout', \{ method: 'POST', credentials: 'same-origin' \}\)\.then\(done, done\)/.test(CRM_SRC));
  assert.ok(/win\.location\.replace\('\/'\)/.test(CRM_SRC) && /main\.innerHTML = '';/.test(CRM_SRC) && /removeItem\('ezone\.lastLoginUser'\)/.test(CRM_SRC));
  assert.ok(/\$\('#crm-who'\)\.textContent = me\.user/.test(CRM_SRC), 'the name is set as text');
  assert.ok(/const name = String\(principal\.user \|\| principal\.id \|\| ''\)\.replace\(\/\[&<>"'\]\/g/.test(SERVER_SRC), 'the server escapes __USER__');
  // classic
  assert.ok(/sw\.textContent = 'החלפת משתמש';/.test(APP_SRC) && /sw\.onclick = \(\) => busyButton\(sw, 'load', switchUser\);/.test(APP_SRC));
  assert.ok(/b\.textContent = name;/.test(APP_SRC), 'the classic name is a text node');
  assert.ok(/\.whoami \.switch-user \{ min-height: 44px; min-width: 44px;/.test(CSS_SRC));
  assert.ok(/await fetch\('\/api\/logout', \{ method: 'POST', credentials: 'same-origin' \}\);/.test(APP_SRC));
  assert.ok(/location\.replace\('\/'\);/.test(APP_SRC), 'back to `/`, never ?view=classic');
  assert.ok(!/fetch\('\/api\/logout', \{ method: 'POST' \}\);\s*\} catch \(_\) \{ \/\* reload anyway \*\/ \}\s*location\.reload\(\);/.test(APP_SRC), 'the old reload-in-place logout is gone');
});

test('clearCachedPages: deletes `/` and `/index.html` from the app caches only; never throws', async () => {
  const deleted = [];
  const mk = (name, urls) => ({ name, keys: () => Promise.resolve(urls.map((url) => ({ url }))), delete: (r) => { deleted.push(name + ' ' + r.url); return Promise.resolve(true); } });
  const caches = { ezoneA: mk('ezone-dashboard-v106', ['https://x/', 'https://x/?view=crm', 'https://x/index.html', 'https://x/style.css']), other: mk('other', ['https://x/']) };
  const store = { keys: () => Promise.resolve(['ezone-dashboard-v106', 'other']), open: (k) => Promise.resolve(k === 'other' ? caches.other : caches.ezoneA) };
  await core.clearCachedPages(store);
  assert.deepStrictEqual(deleted.sort(), ['ezone-dashboard-v106 https://x/', 'ezone-dashboard-v106 https://x/?view=crm', 'ezone-dashboard-v106 https://x/index.html']);
  await core.clearCachedPages(undefined);
  await core.clearCachedPages({ keys: () => Promise.reject(new Error('x')) });
});

test('login landing: after a PIN login the classic page reloads into the CRM only for a CRM-landing session (or ?view=crm); ?view=classic stays', () => {
  const m = /function loginShouldReload\(info, search\) \{[\s\S]*?\n\}/.exec(APP_SRC);
  assert.ok(m, 'loginShouldReload is in app.js');
  const ctx = { URLSearchParams };
  vm.runInNewContext(m[0] + '; this.f = loginShouldReload;', ctx);
  assert.strictEqual(ctx.f({ landing: 'crm' }, ''), true);
  assert.strictEqual(ctx.f({ landing: 'crm' }, '?view=classic'), false);
  assert.strictEqual(ctx.f({ landing: 'classic' }, ''), false, 'a classic-landing session stays on the classic page, no reload');
  assert.strictEqual(ctx.f({ landing: 'classic' }, '?view=crm'), true);
  assert.strictEqual(ctx.f(null, ''), false);
  assert.ok(/if \(info && info\.user && loginShouldReload\(info, location\.search\)\) \{ location\.reload\(\); return; \}/.test(APP_SRC));
});
