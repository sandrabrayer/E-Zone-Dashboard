'use strict';

/* Phase 2 — Dana's read-only view (CHANGELOG-readonly-role-dana.md;
 * docs/crm/PERMISSIONS-MATRIX.md D5 / D16).
 *
 *   1. the model: `dana`, staff only, read-only BY ID
 *   2. lib/readonly-scope.js: the request rule and the getData projection
 *   3. the REAL server: Dana's session — every write 403 before the proxy,
 *      every non-read action 403, getData without money fields, /api/me,
 *      the page served in view-readonly; Vered / Shiran untouched
 *   4. the REAL Code.gs: the second lock (viewRefused_) — list parity
 *   5. the classic page and the CRM shell honour the view */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = require.resolve('../server');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const ro = require('../lib/readonly-scope');
const roleScope = require('../lib/role-scope');
const core = require('../public/crm/crm.js');
const { createSessionToken } = require('../lib/session');
const { loadGs } = require('./helpers/gs-sandbox');

const SESSION_SECRET = 'session-secret-TEST-readonly-0123456789abcdef';
const PROXY_SECRET = 'proxy-secret-TEST-readonly-7f3a9c1e5b2d4f6a8c0e';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-readonly-a1b2c3d4e5f60718293a4b5c6d7e';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN', 'CRM_ENABLED', 'CRM_DEFAULT'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', dana: 'דנה' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });
const FORBIDDEN = { ok: false, error: 'forbidden_readonly', message: 'הרשאת צפייה בלבד — אין אפשרות לשנות' };

const GETDATA = {
  ok: true,
  leads: [{ id: 'L1', name: 'ליד', phone: '0501', house: 'ramot', stage: 'new', advance: 500, note: 'n' }],
  irrelevantLeads: [{ id: 'L2', name: 'x', advance: 1 }], removedLeads: [{ id: 'L3', name: 'y', advance: 2 }],
  patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', pay: 6000, adv: 1000, status: 'active', notes: 'k' }], rehab: [] },
  dischargedPatients: [{ id: 'd1', name: 'z', pay: 7000, adv: 0, exitDate: '2026-09-01' }],
  billingOverrides: [{ id: 'o1' }], houseManagers: {}, currentManagers: [],
};

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
function request(port, method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {};
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
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  return ['vered', 'sandra', 'shiran', 'dana'].map((id) => JSON.parse(users.recordLine(id, _hash, 1)));
}
async function withServer(fn, extra) {
  const env = Object.assign({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records()) }, extra || {});
  const { mod, lines } = freshServer(env);
  const stub = stubHttps();
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = (...a) => lines.push(a.join(' ')); console.error = () => {};
  try { return await fn(srv.address().port, mod, stub, lines); } finally { srv.close(); stub.restore(); Object.assign(console, quiet); }
}

/* ===== 1. the model ===== */

test('model: dana exists (staff only, active), is read-only BY ID, has no capability; principalView says readonly; a record cannot widen her', () => {
  const m = users.modelById('dana');
  assert.ok(m && m.status === 'active'); assert.deepStrictEqual([...m.roles], ['staff']);
  assert.deepStrictEqual([...users.READONLY_USER_IDS], ['dana']);
  const p = { auth: 'personal', id: 'dana', user: 'דנה', roles: ['staff'] };
  assert.strictEqual(users.isReadonlyView(p), true);
  assert.strictEqual(users.principalView(p), 'readonly');
  assert.deepStrictEqual(users.principalCapabilities(p), []);
  assert.strictEqual(users.hasFinance(p), false); assert.strictEqual(users.hasBillingControl(p), false); assert.strictEqual(users.isControllerView(p), false);
  for (const id of ['vered', 'sandra', 'shiran', 'yael', 'ortal']) assert.strictEqual(users.isReadonlyView({ auth: 'personal', id }), false, id);
  assert.strictEqual(users.isReadonlyView({ auth: 'shared', id: 'dana' }), false, 'a shared cookie is never her');
  assert.strictEqual(users.principalView({ auth: 'personal', id: 'shiran' }), 'restricted', 'the restricted view is unchanged');
  // a live record with a role outside her model is a startup failure (cannot widen)
  assert.throws(() => users.validateUserPinHashes(JSON.stringify([Object.assign(JSON.parse(users.recordLine('dana', 'a'.repeat(64), 1)), { roles: ['staff', 'deleter'] })])), /not allowed/);
});

/* ===== 2. the scope lib ===== */

test('scope: only GET on the read list passes; every non-GET /api request is refused except POST /api/logout; getData loses every money field in every row list', () => {
  assert.deepStrictEqual([...ro.READONLY_GET_ACTIONS], ['getData', ...roleScope.ALL_USERS_READ_ACTIONS]);
  for (const a of ro.READONLY_GET_ACTIONS) assert.strictEqual(ro.readonlyRequestAllowed('GET', '/api/sheets', a), true, a);
  for (const a of ['saveAll', 'getPayments', 'debtAging', 'getCredits', 'reportPayment', 'dischargePatient', '', undefined]) assert.strictEqual(ro.readonlyRequestAllowed('GET', '/api/sheets', a), false, String(a));
  for (const [m, p] of [['POST', '/api/sheets'], ['POST', '/api/outpatient-lead'], ['PUT', '/api/sheets'], ['DELETE', '/api/x'], ['POST', '/api/pin-admin/record']]) assert.strictEqual(ro.readonlyRequestAllowed(m, p, 'getData'), false, m + ' ' + p);
  assert.strictEqual(ro.readonlyRequestAllowed('POST', '/api/logout'), true);
  assert.strictEqual(ro.readonlyRequestAllowed('GET', '/api/me'), true);
  assert.strictEqual(ro.readonlyRequestAllowed('GET', '/api/version'), true);
  const v = ro.readonlyGetDataView(GETDATA);
  assert.deepStrictEqual(v.patients.ramot, [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active', notes: 'k' }]);
  assert.deepStrictEqual(v.patients.rehab, []);
  assert.deepStrictEqual(v.leads, [{ id: 'L1', name: 'ליד', phone: '0501', house: 'ramot', stage: 'new', note: 'n' }]);
  assert.deepStrictEqual(v.irrelevantLeads, [{ id: 'L2', name: 'x' }]); assert.deepStrictEqual(v.removedLeads, [{ id: 'L3', name: 'y' }]);
  assert.deepStrictEqual(v.dischargedPatients, [{ id: 'd1', name: 'z', exitDate: '2026-09-01' }]);
  assert.strictEqual('billingOverrides' in v, false, 'the finance-only keys go too');
  assert.deepStrictEqual(v.houseManagers, {}); assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(GETDATA.patients.ramot[0].pay, 6000, 'the input is not mutated');
  assert.deepStrictEqual(ro.readonlyGetDataView({ ok: true, patients: [{ name: 'a', pay: 1 }] }).patients, [{ name: 'a' }], 'array shape too');
  assert.strictEqual(ro.readonlyGetDataView(null), null);
  const forbidden = JSON.stringify(ro.readonlyGetDataView(GETDATA));
  for (const k of ['"pay"', '"adv"', '"advance"', 'billingOverrides']) assert.ok(!forbidden.includes(k), k);
});

/* ===== 3. the real server ===== */

test('server: Dana — writes 403 before the proxy (saveAll, reportPayment, outpatient-lead, pin-admin), non-read GET actions 403, getData projected, /api/me readonly, page view-readonly; Vered and Shiran unchanged', async () => {
  await withServer(async (port, mod, stub, lines) => {
    const dana = personal('dana');
    // every write is refused before anything reaches Apps Script
    for (const [m, p, body] of [
      ['POST', '/api/sheets', { action: 'saveAll', leads: [], patients: {} }],
      ['POST', '/api/sheets', { action: 'reportPayment', report: {} }],
      ['POST', '/api/sheets', { action: 'dischargePatient', patient: {} }],
      ['POST', '/api/sheets', { action: 'getData' }],
      ['POST', '/api/outpatient-lead', { dischargeId: 'x' }],
      ['POST', '/api/pin-admin/record', { userId: 'dana', pin: '111111', pin2: '111111' }],
    ]) {
      const r = await request(port, m, p, { cookie: dana, body });
      assert.strictEqual(r.status, 403, m + ' ' + p + ' ' + (body && body.action));
      assert.deepStrictEqual(r.json, FORBIDDEN, m + ' ' + p);
    }
    for (const a of ['saveAll', 'getPayments', 'debtAging', 'getCredits', 'billingControlQueue', 'moveLeadIrrelevant']) {
      const r = await request(port, 'GET', '/api/sheets?action=' + a, { cookie: dana });
      assert.strictEqual(r.status, 403, 'GET ' + a);
      assert.deepStrictEqual(r.json, FORBIDDEN, 'GET ' + a);
    }
    assert.strictEqual(stub.calls.length, 0, 'nothing refused reached Apps Script');
    assert.ok(lines.some((l) => /\[readonly\] 403 user=dana/.test(l)), 'logged with the id only');
    assert.ok(!lines.some((l) => /583920/.test(l)));
    // the one read, projected
    const g = await request(port, 'GET', '/api/sheets?action=getData', { cookie: dana });
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual(g.json.patients.ramot, [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active', notes: 'k' }]);
    assert.deepStrictEqual(g.json.leads, [{ id: 'L1', name: 'ליד', phone: '0501', house: 'ramot', stage: 'new', note: 'n' }]);
    assert.strictEqual('billingOverrides' in g.json, false);
    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0].proxyUserId, 'dana');
    // the feeds every user may read still pass the readonly gate (the other gates decide after)
    const act = await request(port, 'GET', '/api/sheets?action=getActivity&patientId=p1', { cookie: dana });
    assert.notStrictEqual(act.json && act.json.error, 'forbidden_readonly');
    // /api/me and logout
    const me = await request(port, 'GET', '/api/me', { cookie: dana });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.readonly, true); assert.strictEqual(me.json.view, 'readonly'); assert.strictEqual(me.json.finance, false); assert.strictEqual(me.json.deleter, false);
    assert.strictEqual(me.json.user, 'דנה');
    assert.strictEqual((await request(port, 'POST', '/api/logout', { cookie: dana })).status, 200, 'logout stays open');
    // the page
    const html = await request(port, 'GET', '/', { cookie: dana });
    assert.match(html.text, /<body class="view-restricted view-readonly">/);
    // Vered: full view, writes pass the readonly gate (and reach the stub); Shiran: restricted, no readonly class
    const vw = await request(port, 'GET', '/', { cookie: personal('vered') });
    assert.match(vw.text, /<body>/); assert.ok(!/<body class="[^"]*view-readonly/.test(vw.text));
    const vs = await request(port, 'POST', '/api/sheets', { cookie: personal('vered'), body: { action: 'saveAll', leads: [], patients: {} } });
    assert.strictEqual(vs.status, 200);
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: personal('vered') })).json.readonly, false);
    const sh = await request(port, 'GET', '/', { cookie: personal('shiran') });
    assert.match(sh.text, /<body class="view-restricted">/);
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: personal('shiran') })).json.view, 'restricted');
    // the CRM shell for Dana (flag on): served; her areas come from /api/me in the browser
  });
  await withServer(async (port) => {
    const r = await request(port, 'GET', '/?view=crm', { cookie: personal('dana') });
    assert.match(r.text, /id="crm-root"/);
    const home = await request(port, 'GET', '/', { cookie: personal('dana') });
    assert.ok(!/id="crm-root"/.test(home.text), 'CRM_DEFAULT switches only the full view — Dana stays on the classic page by default');
  }, { CRM_ENABLED: 'true', CRM_DEFAULT: 'true' });
});

/* ===== 4. Code.gs: the second lock ===== */

test('Code.gs: Dana\'s verified session is refused for every action outside READONLY_ACTIONS (forbidden_readonly) before any read or write; the lists mirror the server\'s', () => {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  assert.deepStrictEqual(Array.from(g.run('READONLY_USER_IDS')), [...users.READONLY_USER_IDS]);
  assert.deepStrictEqual(Array.from(g.run('READONLY_ACTIONS')), [...ro.READONLY_GET_ACTIONS]);
  const dana = { proxySecret: PROXY_SECRET, proxyUser: 'דנה', user: 'דנה', proxyAuth: 'personal', proxyUserId: 'dana', proxyRoles: ['staff'], proxyCaps: [] };
  const plain = (x) => JSON.parse(JSON.stringify(x));
  for (const action of ['saveAll', 'reportPayment', 'dischargePatient', 'moveLeadIrrelevant', 'getPayments', 'debtAging', 'appendFunder']) {
    const r = plain(g.post(Object.assign({ action, leads: [], patients: {} }, dana)));
    assert.deepStrictEqual(r, { ok: false, error: 'forbidden_readonly', message: 'הרשאת צפייה בלבד — אין אפשרות לשנות' }, action);
  }
  const ok = plain(g.post(Object.assign({ action: 'getData' }, dana)));
  assert.notStrictEqual(ok.error, 'forbidden_readonly', 'getData passes the lock');
  const vered = Object.assign({}, dana, { proxyUserId: 'vered', proxyUser: 'ורד', user: 'ורד', proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'] });
  assert.notStrictEqual(plain(g.post(Object.assign({ action: 'saveAll', leads: [], patients: {} }, vered))).error, 'forbidden_readonly');
  const unverified = { action: 'saveAll', leads: [], patients: {}, user: 'דנה', proxyUserId: 'dana', proxyAuth: 'personal' };
  assert.notStrictEqual(plain(g.post(unverified)).error, 'forbidden_readonly', 'without the secret there is no verified actor — the proxy gate decides');
});

/* ===== 5. the pages ===== */

test('pages: the classic page keeps view mode and hides .edit-only for the read-only view; the CRM shell gives Dana the five read areas and hides every action', () => {
  assert.match(APP_SRC, /function readonlyView\(\)/);
  assert.match(APP_SRC, /state\.mode = \(controllerView\(\) \|\| readonlyView\(\)\) \? 'view' : 'edit'/);
  assert.match(APP_SRC, /i\.readonly === true \|\| i\.view === 'readonly'/);
  assert.match(CSS_SRC, /body\.view-readonly \.edit-only \{ display: none !important; \}/);
  assert.deepStrictEqual(core.areasFor({ view: 'readonly', readonly: true, finance: false }), ['today', 'leads', 'occupancy', 'clients', 'calendar']);
  assert.deepStrictEqual(core.areasFor({ view: 'restricted', finance: false }), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control'], 'the restricted view is unchanged');
  assert.match(CRM_SRC, /root\.classList\.toggle\('readonly', me\.view === 'readonly' \|\| me\.readonly === true\)/);
  assert.match(CRM_CSS, /\.crm\.readonly \.actions, \.crm\.readonly form, \.crm\.readonly #crm-new-lead, \.crm\.readonly #crm-direct-add/);
});
