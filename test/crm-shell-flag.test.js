'use strict';

/* C1 — CRM shell behind a flag (CHANGELOG-crm-shell-flag.md, docs/crm/ROLLOUT.md §C1).
 *
 * Invariant: with CRM_ENABLED unset / not exactly 'true', every existing
 * response is byte-for-byte unchanged, and `/?view=crm` is the normal page.
 * The REAL server.js is started on a random port per case. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const flag = require('../lib/crm-shell-flag');
const { createSessionToken } = require('../lib/session');

const SERVER_PATH = require.resolve('../server');
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const PROXY_SECRET = 'proxy-secret-TEST-crm-shell-0123456789abcdef0123';
const SESSION_SECRET = 'session-secret-TEST-crm-shell-0123456789abcd';
const PEPPER = 'pepper-TEST-crm-shell-a1b2c3d4e5f60718293a4b5c';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN', 'CRM_ENABLED'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });
const shared = () => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'משותף');

let _hash;
async function records() {
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  return ['vered', 'sandra', 'ortal'].map((id) => JSON.parse(users.recordLine(id, _hash, 1)));
}
function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return mod;
}
function request(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const h = cookie ? { Cookie: cookie } : {};
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function withServer(crm, fn) {
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records()) };
  if (crm !== undefined) env.CRM_ENABLED = crm;
  const mod = freshServer(env);
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port, mod); } finally { srv.close(); }
}
/* index.html carries a per-process BUILD_ID; compare bodies with it removed. */
const stable = (t) => t.replace(/\d{13}-[a-z0-9]{6}/g, 'BUILD');
const isShell = (t) => /E-ZONE · CRM/.test(t) && /id="crm-root"/.test(t);

/* ===== pure ===== */

test('flag lib: strict "true", view=crm, verified personal session', () => {
  assert.equal(flag.crmShellEnabled({ CRM_ENABLED: 'true' }), true);
  for (const v of ['TRUE', 'True', '1', 'yes', ' true', '', undefined]) assert.equal(flag.crmShellEnabled({ CRM_ENABLED: v }), false, JSON.stringify(v));
  assert.equal(flag.crmShellEnabled(undefined), false);
  assert.equal(flag.wantsCrmShell({ view: 'crm' }), true);
  assert.equal(flag.wantsCrmShell({ view: ['crm', 'x'] }), true);
  for (const q of [{}, { view: 'CRM' }, { view: 'crm-work' }, undefined]) assert.equal(flag.wantsCrmShell(q), false, JSON.stringify(q));
  assert.equal(flag.crmShellAllowed({ auth: 'personal', id: 'vered' }), true);
  for (const p of [null, {}, { auth: 'shared' }, { auth: 'personal', id: '' }, { auth: 'personal' }]) assert.equal(flag.crmShellAllowed(p), false, JSON.stringify(p));
  assert.equal(flag.serveCrmShell({ CRM_ENABLED: 'true' }, { view: 'crm' }, { auth: 'personal', id: 'v' }), true);
  assert.equal(flag.serveCrmShell({}, { view: 'crm' }, { auth: 'personal', id: 'v' }), false);
  assert.equal(flag.CRM_ENABLED_VAR, 'CRM_ENABLED');
});

/* ===== flag off: byte-for-byte ===== */

test('FLAG OFF (unset): "/" and "/?view=crm" are the same page, with or without a session; /healthz and /api/version unchanged', async () => {
  await withServer(undefined, async (port) => {
    for (const cookie of [undefined, personal('vered'), personal('ortal'), shared()]) {
      const a = await request(port, '/', cookie);
      const b = await request(port, '/?view=crm', cookie);
      assert.equal(a.status, 200);
      assert.equal(stable(a.text), stable(b.text), 'identical body');
      assert.ok(!isShell(b.text));
      assert.equal(b.headers['cache-control'], a.headers['cache-control']);
    }
    const h = await request(port, '/healthz');
    assert.equal(h.status, 200);
    const v = await request(port, '/api/version');
    assert.equal(v.status, 200);
    assert.ok(/"commit"/.test(v.text));
  });
});

test('FLAG not exactly "true" ("TRUE", "1", "yes"): still the normal page', async () => {
  for (const val of ['TRUE', '1', 'yes']) {
    await withServer(val, async (port) => {
      const b = await request(port, '/?view=crm', personal('vered'));
      assert.ok(!isShell(b.text), val);
    });
  }
});

/* ===== flag on ===== */

test('FLAG ON: no session → the normal (PIN) page; shared session → the normal page; personal session → the shell, no-store, user name escaped', async () => {
  await withServer('true', async (port) => {
    const plain = await request(port, '/');
    const noSession = await request(port, '/?view=crm');
    assert.equal(stable(noSession.text), stable(plain.text), 'no session: exactly the PIN page');
    const sharedS = await request(port, '/?view=crm', shared());
    assert.ok(!isShell(sharedS.text), 'a shared session never gets the shell');
    const v = await request(port, '/?view=crm', personal('vered'));
    assert.equal(v.status, 200);
    assert.ok(isShell(v.text));
    assert.match(v.text, /lang="he" dir="rtl"/);
    assert.match(v.text, /מחובר\/ת: <span id="crm-user">ורד<\/span>/);
    assert.match(v.headers['cache-control'], /no-store/);
    assert.ok(!/__USER__/.test(v.text));
    // the normal routes are untouched while the flag is on
    const home = await request(port, '/', personal('vered'));
    assert.ok(!isShell(home.text), '"/" without view=crm is the dashboard');
    const idx = await request(port, '/index.html?view=crm', personal('vered'));
    assert.ok(!isShell(idx.text), '/index.html never serves the shell');
    const h = await request(port, '/healthz');
    assert.equal(h.status, 200);
  });
});

test('FLAG ON: Ortal (controller) gets the shell too, and her /api lock still holds', async () => {
  await withServer('true', async (port) => {
    const o = await request(port, '/?view=crm', personal('ortal'));
    assert.ok(isShell(o.text));
    const locked = await request(port, '/api/sheets?action=saveAll', personal('ortal'));
    assert.equal(locked.status, 403);
  });
});

test('the shell escapes the session name (no HTML injection through a user record)', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const fn = src.slice(src.indexOf('function sendCrmShell('), src.indexOf('app.get(\'/\', (req, res)'));
  assert.match(fn, /replace\(\/\[&<>"'\]\/g/);
  assert.match(fn, /noCache\(res\)/);
});

/* ===== sw.js untouched ===== */

test('sw.js is untouched by C1: no crm reference, CACHE_VERSION still v93, the shell is not a precached asset', () => {
  assert.doesNotMatch(SW_SRC, /view=crm|\/crm\//);
  assert.equal(/var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1], 'v93');
  const srv = fs.readFileSync(SERVER_PATH, 'utf8');
  assert.doesNotMatch(srv, /'\/crm\/crm\.html':/, 'the shell is not in ASSETS');
});
