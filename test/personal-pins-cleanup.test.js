'use strict';
/*
 * Personal PINs — PR C (2026-10-04): the shared code is removed, roles are
 * enforced, and the weekly healthcheck has its own token.
 * See CHANGELOG-personal-pins-cleanup.md and docs/billing-control-plan.md §11.
 *
 * server.js (real Express app on an ephemeral port, https.request stubbed):
 *   - a shared (auth:'shared', no personal id) cookie → 401; { pin } → 400
 *   - the server starts with APP_PIN unset; set → ONE warning, value never logged
 *   - deleter: every DELETE_ACTIONS operation → 403 forbidden_role for Shiran
 *     and Yael, NOTHING proxied, logged with id + operation only; served for
 *     Vered and Sandra
 *   - approver: APPROVER_ACTIONS → Sandra's personal session only
 *   - GET /api/healthcheck: Bearer HEALTHCHECK_TOKEN (constant-time), read-only
 *     getData (restricted keys), no cookie minted, rate-limited, never logged
 * Code.gs (vm sandbox): the same deleter / approver rules, nothing written on
 *   a refusal; the lists equal lib/role-scope.js; getData keys unchanged
 * public/ (vm + source): the controls per role, SW v29.
 */
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
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

const roleScope = require('../lib/role-scope');
const scope = require('../lib/finance-scope');
const { createSessionToken } = require('../lib/session');
const ps = require('./helpers/personal-session');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');

const SESSION_SECRET = 'session-secret-TEST-cleanup-pr-c-0123456789abcd';
const PROXY_SECRET = 'proxy-secret-TEST-cleanup-pr-c-7f3a9c1e5b2d4f6a8c';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const HC_TOKEN = 'hc-TEST-token-0123456789abcdef0123456789abcdef';
const APP_PIN = '4711';
const ROLE_FORBIDDEN = { ok: false, error: 'forbidden_role', message: 'אין הרשאה לפעולה זו' };
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'APP_PIN_UNTIL', 'USER_PIN_HASHES',
  'PIN_PEPPER', 'HEALTHCHECK_TOKEN', 'BOOTSTRAP_TOKEN'];

/* The full getData key list (Code.gs getData_, pinned since PR A). */
const GETDATA_KEYS = ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
  'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource'];

/* ============================== harness =============================== */

function baseEnv(over) {
  return Object.assign({
    PROXY_SECRET, SESSION_SECRET, SHEETS_URL, HEALTHCHECK_TOKEN: HC_TOKEN,
    USER_PIN_HASHES: ps.userPinHashes(), PIN_PEPPER: ps.TEST_PEPPER,
  }, over || {});
}

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => lines.push(a.map(String).join(' '));
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = (...a) => lines.push(a.map(String).join(' '));
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { mod, startup: lines };
}

/* Every Apps Script call is answered by `respond(body)` (default: getData). */
function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      const b = JSON.parse(body || '{}');
      calls.push(b);
      const out = respond ? respond(b) : (b.action === 'getData'
        ? Object.fromEntries(GETDATA_KEYS.map((k) => [k, k === 'ok' ? true : []]))
        : { ok: true });
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(out)); res.emit('end'); });
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

/* Run `fn(port, mod, startup, logs)` against a fresh server; every console
 * line written while it runs is captured in `logs`. */
async function withServer(env, fn) {
  const { mod, startup } = freshServer(env);
  const srv = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  const logs = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => logs.push(a.map(String).join(' '));
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.log = (...a) => logs.push(a.map(String).join(' '));
  try { return await fn(srv.address().port, mod, startup, logs); } finally { Object.assign(console, orig); srv.close(); }
}

const me = (id) => ps.personalCookie(SESSION_SECRET, id);

/* One request body per DELETE_ACTIONS operation (what the page would send). */
const DELETE_BODIES = {
  removeLead: { action: 'removeLead', lead: { id: 'L1', name: 'דנה' } },
  deletePatientRow: { action: 'deletePatientRow', patient: { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' } },
  deleteBillingOverride: { action: 'deleteBillingOverride', override: { patientId: 'P1', month: '2026-09' } },
  deleteMeetingReport: { action: 'deleteMeetingReport', leadId: 'L1' },
  voidPayment: { action: 'savePayment', payment: { id: 'pay1', status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' } },
  cancelCredit: { action: 'saveCredit', credit: { id: 'c1', status: 'cancelled' } },
};

/* ================== 1. the shared code is gone (server) ================== */

test('a shared cookie (auth:\'shared\', no personal id) → 401 on every session route, nothing proxied', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv({ APP_PIN, APP_PIN_UNTIL: '2026-10-09' }), async (port, mod) => {
      for (const name of ['ורד', 'סנדרה', '']) {
        const cookie = ps.sharedCookie(SESSION_SECRET, name);
        assert.strictEqual(mod.sessionAuthStatus(cookie, SESSION_SECRET), 'unauthorized');
        for (const [m, p, body] of [['GET', '/api/me'], ['GET', '/api/sheets?action=getData'], ['POST', '/api/sheets', { action: 'saveAll' }],
          ['GET', '/api/export/cleanup.xlsx'], ['GET', '/api/pin-admin/users']]) {
          const r = await request(port, m, p, { cookie, body });
          assert.strictEqual(r.status, 401, `${m} ${p} (${name || 'no name'})`);
        }
      }
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0);
});

test('the APP_PIN login path is gone: { pin } → 400 user_required, no cookie, even with APP_PIN set', async () => {
  await withServer(baseEnv({ APP_PIN }), async (port) => {
    for (const body of [{ pin: APP_PIN }, { pin: APP_PIN, user: 'ורד' }, { pin: '' }]) {
      const r = await request(port, 'POST', '/api/verify-pin', { body });
      assert.deepStrictEqual([r.status, r.json], [400, { ok: false, error: 'user_required' }]);
      assert.strictEqual(r.headers['set-cookie'], undefined);
    }
    // With a userId it is the personal login (401 for a wrong code).
    assert.strictEqual((await request(port, 'POST', '/api/verify-pin', { body: { userId: 'vered', pin: APP_PIN } })).status, 401);
  });
});

test('startup: fine with APP_PIN unset (no mention); APP_PIN or APP_PIN_UNTIL set → ONE "ignored" warning, never the value', () => {
  const quiet = freshServer(baseEnv());
  assert.ok(!quiet.startup.some((l) => /APP_PIN/.test(l)), quiet.startup.join('\n'));
  for (const extra of [{ APP_PIN }, { APP_PIN_UNTIL: '2026-10-09' }, { APP_PIN, APP_PIN_UNTIL: '2026-10-09' }]) {
    const { startup } = freshServer(baseEnv(extra));
    const warn = startup.filter((l) => /APP_PIN/.test(l));
    assert.strictEqual(warn.length, 1, JSON.stringify(extra));
    assert.match(warn[0], /set but ignored/);
    assert.ok(!startup.join('\n').includes(APP_PIN) && !startup.join('\n').includes('2026-10-09'), 'no value in the log');
  }
  delete require.cache[SERVER_PATH];
});

test('lib: resolvePrincipal returns null for a shared session; no shared role / capability constant survives', () => {
  const users = require('../lib/users');
  const reg = users.validateUserPinHashes(ps.userPinHashes());
  assert.strictEqual(users.resolvePrincipal({ user: 'ורד', id: '', pinVersion: 0, auth: 'shared' }, reg), null);
  assert.strictEqual(users.resolvePrincipal({ user: 'x', id: 'constructor', pinVersion: 1, auth: 'personal' }, reg), null,
    'an id that names a prototype key is no record');
  for (const k of ['SESSION_USERS', 'SHARED_SESSION_ROLES', 'SHARED_SESSION_CAPABILITIES']) assert.strictEqual(users[k], undefined, k);
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'shared-pin-window.js')));
});

/* ================== 2. deleter + approver (server mirror) ================== */

test('lib/role-scope.js lists equal Code.gs DELETE_ACTIONS / APPROVER_ACTIONS; operations classify like roleOperationFor_', () => {
  const g = loadGs({});
  assert.deepStrictEqual([...roleScope.DELETE_ACTIONS], Array.from(g.run('DELETE_ACTIONS')));
  assert.deepStrictEqual([...roleScope.APPROVER_ACTIONS], Array.from(g.run('APPROVER_ACTIONS')));
  assert.strictEqual(roleScope.ROLE_FORBIDDEN_MESSAGE, g.run('ROLE_FORBIDDEN_MESSAGE'));
  const cases = [
    ['savePayment', { payment: JSON.stringify({ status: 'void' }) }],
    ['updatePayment', { payment: { status: ' VOID ' } }],
    ['savePayment', { payment: { status: 'paid' } }],
    ['saveCredit', { credit: { status: 'cancelled' } }],
    ['saveCredit', { credit: '{"status":"pending"}' }],
    ['removeLead', {}], ['saveAll', {}], ['approveRefundException', {}], ['savePayment', { payment: 'not json' }],
  ];
  for (const [a, p] of cases) assert.strictEqual(roleScope.roleOperationFor(a, p), g.sandbox.roleOperationFor_(a, p), a + ' ' + JSON.stringify(p));
  const P = (id, roles) => ({ auth: 'personal', id, user: '', roles });
  assert.strictEqual(roleScope.roleAllowed(P('vered', ['staff', 'deleter']), 'removeLead'), true);
  assert.strictEqual(roleScope.roleAllowed(P('shiran', ['staff', 'reporter']), 'removeLead'), false);
  assert.strictEqual(roleScope.roleAllowed(P('vered', ['staff', 'deleter', 'approver']), 'unvoidPayment'), false, 'approver is Sandra\'s alone');
  assert.strictEqual(roleScope.roleAllowed(P('sandra', ['staff', 'deleter', 'approver']), 'unvoidPayment'), true);
  assert.strictEqual(roleScope.roleAllowed({ auth: 'shared', id: '', roles: ['deleter'] }, 'removeLead'), false);
  assert.strictEqual(roleScope.roleAllowed(null, 'removeLead'), false);
  assert.strictEqual(roleScope.roleAllowed(null, 'saveAll'), true);
});

test('server: every delete / void / cancel → 403 forbidden_role for Shiran and Yael, NOTHING proxied, logged with id + operation only', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port, mod, startup, logs) => {
      for (const id of ['shiran', 'yael']) {
        for (const [op, body] of Object.entries(DELETE_BODIES)) {
          const r = await request(port, 'POST', '/api/sheets', { cookie: me(id), body });
          assert.strictEqual(r.status, 403, `${id} ${op}`);
          // The billing ones are already refused by the finance lock (restricted
          // view, 403 forbidden); every other one by the role lock.
          const finance = scope.FINANCE_ACTIONS.includes(body.action);
          assert.strictEqual(r.json.error, finance ? 'forbidden' : 'forbidden_role', `${id} ${op}`);
          if (!finance) assert.deepStrictEqual(r.json, ROLE_FORBIDDEN);
        }
      }
      const roleLines = logs.filter((l) => /^\[role\] 403/.test(l));
      assert.ok(roleLines.includes('[role] 403 user=shiran op=removeLead needs=deleter'), roleLines.join('\n'));
      assert.ok(roleLines.includes('[role] 403 user=yael op=deleteMeetingReport needs=deleter'));
      assert.ok(!logs.join('\n').includes('דנה') && !logs.join('\n').includes('מטופל'), 'no patient / lead data in the log');
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0, 'a refused request reaches nothing');
});

test('server: a narrowed Vered (no deleter, still finance) is refused the billing deletes by the ROLE lock', async () => {
  const stub = stubHttps();
  const hash = ps.hashPinSync(ps.TEST_PIN, ps.TEST_PEPPER);
  const users = require('../lib/users');
  const narrowed = JSON.stringify([JSON.parse(users.recordLine('vered', hash, 1, ['staff', 'reporter'])), JSON.parse(users.recordLine('sandra', hash, 1))]);
  try {
    await withServer(baseEnv({ USER_PIN_HASHES: narrowed }), async (port) => {
      for (const op of ['deleteBillingOverride', 'voidPayment', 'cancelCredit', 'removeLead']) {
        const r = await request(port, 'POST', '/api/sheets', { cookie: me('vered'), body: DELETE_BODIES[op] });
        assert.deepStrictEqual([r.status, r.json], [403, ROLE_FORBIDDEN], op);
      }
      const ok = await request(port, 'GET', '/api/me', { cookie: me('vered') });
      assert.deepStrictEqual([ok.json.deleter, ok.json.finance], [false, true]);
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0);
});

test('server: Vered and Sandra are served every delete; the roles reach Apps Script from the session only', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port) => {
      for (const id of ['vered', 'sandra']) {
        for (const [op, body] of Object.entries(DELETE_BODIES)) {
          const r = await request(port, 'POST', '/api/sheets', { cookie: me(id), body: Object.assign({ proxyRoles: [] }, body) });
          assert.strictEqual(r.status, 200, `${id} ${op}`);
        }
      }
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 2 * Object.keys(DELETE_BODIES).length);
  assert.ok(stub.calls.every((b) => b.proxyRoles.includes('deleter') && b.proxyAuth === 'personal'));
});

test('server: APPROVER_ACTIONS pass only for Sandra\'s personal session (GET and POST)', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port) => {
      for (const action of roleScope.APPROVER_ACTIONS) {
        for (const id of ['vered', 'shiran', 'yael']) {
          const p = await request(port, 'POST', '/api/sheets', { cookie: me(id), body: { action } });
          assert.deepStrictEqual([p.status, p.json], [403, ROLE_FORBIDDEN], `${id} POST ${action}`);
          const g = await request(port, 'GET', '/api/sheets?action=' + action, { cookie: me(id) });
          assert.strictEqual(g.status, 403, `${id} GET ${action}`);
        }
        assert.strictEqual((await request(port, 'POST', '/api/sheets', { cookie: me('sandra'), body: { action } })).status, 200, 'Sandra: ' + action);
      }
    });
  } finally { stub.restore(); }
  assert.deepStrictEqual(stub.calls.map((b) => b.proxyUserId), roleScope.APPROVER_ACTIONS.map(() => 'sandra'));
});

test('/api/me: deleter + approver per user', async () => {
  await withServer(baseEnv(), async (port) => {
    const got = {};
    for (const id of ['vered', 'sandra', 'shiran', 'yael']) {
      const j = (await request(port, 'GET', '/api/me', { cookie: me(id) })).json;
      got[id] = [j.auth, j.deleter, j.approver, j.finance];
    }
    assert.deepStrictEqual(got, {
      vered: ['personal', true, false, true],
      sandra: ['personal', true, true, true],
      shiran: ['personal', false, false, false],
      yael: ['personal', false, false, false],
    });
  });
});

/* ================== 3. Code.gs: the authority ================== */

const gsActor = (id, user, roles, extra) => Object.assign({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
}, extra || {});
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter']);
const YAEL = () => gsActor('yael', 'יעל', ['staff', 'reporter']);
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const VERED_NARROWED = () => gsActor('vered', 'ורד', ['staff', 'reporter']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer']);

/* A Code.gs with one lead (L1, with a meeting report), one patient (p1), one
 * billing override and one paid payment. Returns the loader and a snapshot fn. */
function seededGs(mode) {
  const g = loadGs({ props: Object.assign({ PROXY_SECRET }, mode ? { PROXY_SECRET_MODE: mode } : {}) });
  const S = g.sandbox.__sheets;
  const lcols = Array.from(g.run('LEAD_COLUMNS'));
  S.Leads = richSheet('Leads', lcols);
  S.Leads.appendRow(lcols.map((c) => ({ id: 'L1', name: 'דנה', meetingReportedAt: '2026-10-01T10:00:00Z', meetingReportOutcome: 'advancing' }[c] || '')));
  const pcols = Array.from(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' }[c] || '')));
  assert.strictEqual(g.post(Object.assign({ action: 'upsertBillingOverride', override: { patientId: 'P1', month: '2026-09', amount: 1000 } }, VERED())).ok, true);
  const pay = { id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0, status: 'paid' };
  assert.strictEqual(g.post(Object.assign({ action: 'savePayment', payment: pay }, VERED())).ok, true);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, pay, snapshot };
}

test('Code.gs: every DELETE_ACTIONS operation → forbidden_role for Shiran / Yael (and a narrowed Vered) — NOTHING written, logged with id + op only', () => {
  for (const mode of ['log', 'enforce']) {
    const { g, pay, snapshot } = seededGs(mode);
    const before = snapshot();
    const bodies = {
      removeLead: { action: 'removeLead', lead: { id: 'L1', name: 'דנה' } },
      deletePatientRow: { action: 'deletePatientRow', patient: { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' } },
      deleteMeetingReport: { action: 'deleteMeetingReport', leadId: 'L1' },
      deleteBillingOverride: { action: 'deleteBillingOverride', override: { patientId: 'P1', month: '2026-09' } },
      voidPayment: { action: 'savePayment', payment: Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'x' }) },
      cancelCredit: { action: 'saveCredit', credit: { id: 'c1', status: 'cancelled' } },
    };
    for (const who of [SHIRAN, YAEL, VERED_NARROWED]) {
      for (const [op, body] of Object.entries(bodies)) {
        const r = g.post(Object.assign({}, body, who()));
        const finance = Array.from(g.run('FINANCE_ACTIONS')).includes(body.action);
        const restricted = who !== VERED_NARROWED;
        // Shiran / Yael hit the finance lock first on billing actions.
        assert.strictEqual(r.error, finance && restricted ? 'forbidden' : 'forbidden_role', `${mode} ${who().proxyUserId} ${op}`);
        if (r.error === 'forbidden_role') assert.deepStrictEqual(r, ROLE_FORBIDDEN);
      }
    }
    assert.strictEqual(snapshot(), before, mode + ': not one cell moved');
    const roleLogs = g.logs.filter((l) => /^\[role\]/.test(l));
    assert.ok(roleLogs.includes('[role] forbidden_role user=shiran op=removeLead'), roleLogs.join('\n'));
    assert.ok(roleLogs.includes('[role] forbidden_role user=vered op=voidPayment'));
    assert.ok(!g.logs.join('\n').includes('דנה') && !g.logs.join('\n').includes('מטופל'), 'no names in the log');
  }
});

test('Code.gs: Vered and Sandra may delete, void and cancel', () => {
  for (const who of [VERED, SANDRA]) {
    const { g, pay } = seededGs('enforce');
    assert.strictEqual(g.post(Object.assign({ action: 'deleteMeetingReport', leadId: 'L1' }, who())).ok, true);
    assert.strictEqual(g.post(Object.assign({ action: 'removeLead', lead: { id: 'L1', name: 'דנה' } }, who())).ok, true);
    assert.strictEqual(g.post(Object.assign({ action: 'deletePatientRow', patient: { id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01' } }, who())).ok, true);
    assert.strictEqual(g.post(Object.assign({ action: 'deleteBillingOverride', override: { patientId: 'P1', month: '2026-09' } }, who())).ok, true);
    const v = g.post(Object.assign({ action: 'savePayment', payment: Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'x' }) }, who()));
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    assert.strictEqual(g.sheetRows('Leads', 'LEAD_COLUMNS').length, 0, 'the lead is gone');
  }
});

test('Code.gs: approver operations — Sandra\'s personal session only (un-void and the APPROVER_ACTIONS names)', () => {
  const { g, pay } = seededGs('enforce');
  assert.strictEqual(g.post(Object.assign({ action: 'savePayment', payment: Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'x' }) }, VERED())).ok, true);
  const unvoid = { action: 'savePayment', payment: Object.assign({}, pay, { status: 'paid' }) };
  // Vered claiming approver, and a personal session for another id carrying Sandra's name: refused.
  for (const body of [VERED(), gsActor('vered', 'ורד', ['staff', 'deleter', 'approver']), gsActor('vered', 'סנדרה', ['staff', 'deleter', 'approver'])]) {
    assert.deepStrictEqual(g.post(Object.assign({}, unvoid, body)), ROLE_FORBIDDEN);
  }
  assert.ok(g.logs.includes('[role] forbidden_role user=vered op=unvoidPayment'));
  const ok = g.post(Object.assign({}, unvoid, SANDRA()));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  // The not-yet-built approver operations: refused for everyone but Sandra
  // BEFORE dispatch; Sandra passes the role lock (and meets "unknown action").
  for (const action of ['approveRefundException', 'writeOffOpeningBalance', 'acceptOpeningBalance']) {
    assert.deepStrictEqual(g.post(Object.assign({ action }, VERED())), ROLE_FORBIDDEN, action);
    assert.notStrictEqual(g.post(Object.assign({ action }, SANDRA())).error, 'forbidden_role', action);
  }
});

test('Code.gs: a stale proxyAuth \'shared\' is treated as \'none\' — no role, no capability', () => {
  const { g, snapshot } = seededGs('log');
  const before = snapshot();
  const shared = { proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'shared', proxyUserId: '', proxyRoles: ['staff', 'deleter'], proxyCaps: ['finance'] };
  assert.deepStrictEqual(g.post(Object.assign({ action: 'removeLead', lead: { id: 'L1' } }, shared)), ROLE_FORBIDDEN);
  assert.strictEqual(g.post(Object.assign({ action: 'getPayments' }, shared)).error, 'forbidden');
  assert.strictEqual(snapshot(), before);
  const a = g.sandbox.proxyActor_('ורד', '', 'shared', ['staff', 'deleter'], ['finance']);
  assert.deepStrictEqual([a.auth, Array.from(a.roles), Array.from(a.caps)], ['none', [], []]);
});

test('Code.gs: getData keys unchanged for a full-view personal session', () => {
  const { g } = seededGs('enforce');
  for (const who of [VERED, SANDRA]) assert.deepStrictEqual(Object.keys(g.post(Object.assign({ action: 'getData' }, who()))), GETDATA_KEYS);
  assert.ok(/roleOperationFor_\(action, params\)/.test(GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('))));
});

/* ================== 4. the healthcheck token ================== */

test('healthcheck: the right Bearer token → 200 read-only getData (restricted keys), NO cookie, no-store; proxied with no principal', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port, mod, startup, logs) => {
      const r = await request(port, 'GET', '/api/healthcheck?action=getData', { headers: { Authorization: 'Bearer ' + HC_TOKEN } });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.headers['set-cookie'], undefined, 'no session is minted');
      assert.match(String(r.headers['cache-control']), /no-store/);
      assert.deepStrictEqual(Object.keys(r.json), GETDATA_KEYS.filter((k) => k !== 'billingOverrides'));
      // Without ?action it is getData too.
      assert.strictEqual((await request(port, 'GET', '/api/healthcheck', { headers: { Authorization: 'Bearer ' + HC_TOKEN } })).status, 200);
      assert.ok(!logs.join('\n').includes(HC_TOKEN) && !startup.join('\n').includes(HC_TOKEN), 'the token is never logged');
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 2);
  for (const b of stub.calls) {
    assert.strictEqual(b.action, 'getData');
    assert.deepStrictEqual([b.user, b.proxyAuth, b.proxyUserId, b.proxyRoles, b.proxyCaps], ['', 'none', '', [], []]);
    assert.ok(!JSON.stringify(b).includes(HC_TOKEN), 'the token never reaches Apps Script');
  }
});

test('healthcheck: a wrong, missing or malformed token → 401 (nothing proxied); a write action → 400; the token opens no other route', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port, mod) => {
      const bad = [undefined, 'Bearer wrong-token-0123456789abcdef0123456789abcdef', 'Bearer ' + HC_TOKEN + 'x',
        'Bearer ' + HC_TOKEN.slice(0, -1), 'Basic ' + HC_TOKEN, HC_TOKEN, 'Bearer  ', 'bearer ' + HC_TOKEN];
      for (const auth of bad) {
        const r = await request(port, 'GET', '/api/healthcheck?action=getData', { headers: auth === undefined ? {} : { Authorization: auth } });
        assert.deepStrictEqual([r.status, r.json], [401, { ok: false, error: 'unauthorized' }], String(auth));
        assert.strictEqual(r.headers['www-authenticate'], 'Bearer');
        assert.strictEqual(r.headers['set-cookie'], undefined);
      }
      // The 15-minute window elapses (the limiter is tested on its own below).
      for (const c of [mod.healthcheckAttempts, mod.healthcheckGlobal]) for (const r of c.map.values()) r.resetAt = Date.now() - 1;
      for (const action of ['saveAll', 'removeLead', 'getPayments']) {
        const r = await request(port, 'GET', '/api/healthcheck?action=' + action, { headers: { Authorization: 'Bearer ' + HC_TOKEN } });
        assert.deepStrictEqual([r.status, r.json], [400, { ok: false, error: 'bad_action' }], action);
      }
      // POST is not a route; the token is no session anywhere else.
      assert.strictEqual((await request(port, 'POST', '/api/healthcheck', { body: { action: 'saveAll' }, headers: { Authorization: 'Bearer ' + HC_TOKEN } })).status, 404);
      for (const p of ['/api/sheets?action=getData', '/api/me', '/api/export/cleanup.xlsx']) {
        assert.strictEqual((await request(port, 'GET', p, { headers: { Authorization: 'Bearer ' + HC_TOKEN } })).status, 401, p);
      }
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0);
});

test('healthcheck: disabled (404) when HEALTHCHECK_TOKEN is unset or shorter than 32 characters; the startup log says why', async () => {
  for (const [token, why] of [[undefined, /not set/], ['short-token-0123456789', /shorter than 32/]]) {
    await withServer(baseEnv({ HEALTHCHECK_TOKEN: token }), async (port, mod, startup) => {
      for (const auth of [undefined, 'Bearer ' + (token || HC_TOKEN)]) {
        const r = await request(port, 'GET', '/api/healthcheck?action=getData', { headers: auth ? { Authorization: auth } : {} });
        assert.deepStrictEqual([r.status, r.json], [404, { ok: false, error: 'healthcheck_disabled' }]);
      }
      assert.ok(startup.some((l) => /HEALTHCHECK_TOKEN/.test(l) && why.test(l)), startup.join('\n'));
      if (token) assert.ok(!startup.join('\n').includes(token), 'never the value');
      assert.strictEqual(mod.healthcheckAuthorized('Bearer ' + token, token), false);
    });
  }
});

test('healthcheck: rate-limited — 10 calls per IP per 15 min (429 with Retry-After), counted before the token is checked', async () => {
  const stub = stubHttps();
  try {
    await withServer(baseEnv(), async (port) => {
      for (let i = 0; i < 10; i++) {
        const r = await request(port, 'GET', '/api/healthcheck', { headers: { Authorization: 'Bearer wrong-' + i } });
        assert.strictEqual(r.status, 401, 'attempt ' + i);
      }
      const r = await request(port, 'GET', '/api/healthcheck', { headers: { Authorization: 'Bearer ' + HC_TOKEN } });
      assert.deepStrictEqual([r.status, r.json.error], [429, 'rate_limited'], 'even the right token waits');
      assert.ok(Number(r.headers['retry-after']) >= 1);
    });
  } finally { stub.restore(); }
  assert.strictEqual(stub.calls.length, 0);
});

test('healthcheck: bearerToken / healthcheckAuthorized are pure and fail closed', () => {
  const { mod } = freshServer(baseEnv());
  assert.strictEqual(mod.bearerToken('Bearer abc'), 'abc');
  assert.strictEqual(mod.bearerToken('  Bearer   abc  '), 'abc');
  for (const h of [undefined, '', 'Bearer', 'Bearer a b', 'Basic abc', 'abc', 'Bearer é']) assert.strictEqual(mod.bearerToken(h), '', String(h));
  assert.strictEqual(mod.healthcheckAuthorized('Bearer ' + HC_TOKEN), true);
  assert.strictEqual(mod.healthcheckAuthorized('Bearer ' + HC_TOKEN, ''), false, 'no token configured → never');
  assert.strictEqual(mod.healthcheckAuthorized('Bearer ', ''), false);
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  assert.match(src, /return checkPin\(bearerToken\(header\), want\);/, 'constant-time compare (lib/pin.js checkPin)');
  delete require.cache[SERVER_PATH];
});

test('the weekly workflow uses the HEALTHCHECK_TOKEN secret; the script calls the token route', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'weekly-healthcheck.yml'), 'utf8');
  assert.match(yml, /HEALTHCHECK_TOKEN: \$\{\{ secrets\.HEALTHCHECK_TOKEN \}\}/);
  assert.ok(!/APP_PIN:/.test(yml));
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'healthcheck.js'), 'utf8');
  assert.match(script, /authorization: 'Bearer ' \+ config\.token/);
});

/* ================== 5. the page: controls per role ================== */

function fakeEl(id) {
  const classes = new Set();
  const el = {
    id, children: [], innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    appendChild(c) { el.children.push(c); }, addEventListener() {}, removeEventListener() {}, focus() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  el.__classes = classes;
  return el;
}

function loadApp() {
  const noop = () => {};
  const els = {};
  const body = fakeEl('body');
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      body, addEventListener: noop,
      getElementById: (id) => (els[id] || (els[id] = fakeEl(id))),
      createElement: (t) => fakeEl('<' + t + '>'), createTextNode: (t) => ({ textContent: String(t) }),
      querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop, URLSearchParams, Intl,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      roleBodyClasses, canDelete, canReverseVoid, creditStatusOptionKeys, applySessionInfo, meetingReportBlockHTML,
      get state() { return state; },
    };`, sandbox);
  return { app: sandbox.__test, body, els };
}

test('UI: /api/me roles become <body> classes; the CSS hides data-role controls without them; nothing is offered before /api/me', () => {
  const { app, body } = loadApp();
  assert.strictEqual(app.state.deleter, false, 'no role before /api/me');
  assert.strictEqual(app.canDelete(), false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.roleBodyClasses(true, false))), { 'role-deleter': true, 'role-approver': false });
  app.applySessionInfo({ user: 'שירן', auth: 'personal', approver: false, deleter: false, finance: false });
  assert.deepStrictEqual([body.classList.contains('role-deleter'), body.classList.contains('role-approver'), app.canDelete()], [false, false, false]);
  app.applySessionInfo({ user: 'ורד', auth: 'personal', approver: false, deleter: true, finance: true });
  assert.deepStrictEqual([body.classList.contains('role-deleter'), body.classList.contains('role-approver'), app.canDelete(), app.canReverseVoid()], [true, false, true, false]);
  app.applySessionInfo({ user: 'סנדרה', auth: 'personal', approver: true, deleter: true, finance: true });
  assert.deepStrictEqual([body.classList.contains('role-deleter'), body.classList.contains('role-approver'), app.canReverseVoid()], [true, true, true]);
  assert.match(CSS_SRC, /body:not\(\.role-deleter\) \[data-role="deleter"\],\s*body:not\(\.role-approver\) \[data-role="approver"\] \{ display: none !important; \}/);
});

test('UI: the meeting-report «מחיקת דיווח» renders for a deleter only', () => {
  const { app } = loadApp();
  const lead = { id: 'L1', name: 'דנה', meetingReportedAt: '2026-10-01T10:00:00Z', meetingReportOutcome: 'advancing' };
  app.state.mode = 'edit';
  app.state.deleter = false;
  const shiran = app.meetingReportBlockHTML(lead);
  assert.ok(shiran.includes('data-mrv-edit'), 'edit stays (it is not a delete)');
  assert.ok(!shiran.includes('data-mrv-delete'), 'no delete for Shiran / Yael');
  app.state.deleter = true;
  assert.ok(app.meetingReportBlockHTML(lead).includes('data-role="deleter" data-mrv-delete="L1"'));
});

test('UI: every delete / void / cancel control is gated on canDelete() and tagged data-role; un-void on the approver', () => {
  const fn = (name) => {
    const i = APP_SRC.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name);
    return APP_SRC.slice(i, APP_SRC.indexOf('\nfunction ', i + 10));
  };
  assert.match(fn('buildLeadCard'), /\$\{canDelete\(\) \? '<button class="lc-irrelevant lc-remove" data-role="deleter"/);
  assert.match(fn('renderPatients'), /\$\{canDelete\(\) \? '<button class="btn small danger" data-action="delete" data-role="deleter"/);
  assert.match(fn('buildBillingRow'), /amountEditable && hasOverride && canDelete\(\) \? '<button class="bill-amount-clear-btn" data-role="deleter"/);
  assert.match(fn('buildReconnectRow'), /dup\.length && canDelete\(\) \? `<button class="btn small primary cand-dup" data-role="deleter"/);
  assert.match(fn('renderReconnect'), /setAttribute\('data-role', 'approver'\)/);
  // …and every handler re-checks (a control is never the authority).
  for (const h of ['removeLead', 'deletePatient', 'clearBillingOverride', 'markPaymentDuplicate']) {
    assert.match(fn(h), /if \(!canDelete\(\)\) \{ showError\(ROLE_FORBIDDEN_TEXT\); return; \}/, h);
  }
  assert.match(fn('reversePaymentVoid'), /if \(!canReverseVoid\(\)\) \{ showError\(ROLE_FORBIDDEN_TEXT\); return; \}/);
  assert.match(fn('canReverseVoid'), /state\.approver === true/);
});

test('UI: the «בוטל» credit status (cancelCredit) is offered to a deleter only — a cancelled line still shows its state', () => {
  const { app } = loadApp();
  assert.deepStrictEqual(Array.from(app.creditStatusOptionKeys('pending', false)), ['pending', 'paid']);
  assert.deepStrictEqual(Array.from(app.creditStatusOptionKeys('pending', true)), ['pending', 'paid', 'cancelled']);
  assert.deepStrictEqual(Array.from(app.creditStatusOptionKeys('cancelled', false)), ['pending', 'paid', 'cancelled']);
});

test('service worker: v29 (from v28), with the PR C note; /api/healthcheck is network-only', () => {
  assert.match(SW_SRC, /var CACHE_VERSION = 'v29';/);
  assert.ok(SW_SRC.includes('v28 → v29:'));
  const sandbox = { self: { addEventListener() {} }, module: { exports: {} }, URL, caches: {}, fetch() {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  assert.strictEqual(sandbox.module.exports.cacheStrategy('/api/healthcheck?action=getData'), 'network-only');
});

test('createSessionToken still mints the no-id format (meeting-report scope needs it) — the dashboard simply refuses it', () => {
  const t = createSessionToken(SESSION_SECRET, undefined, 'meeting-report');
  assert.strictEqual(t.split('.').length, 2);
});
