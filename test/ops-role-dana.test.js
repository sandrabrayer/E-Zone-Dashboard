'use strict';

/* CRM Stage 1b — Dana's OPERATIONAL view (CHANGELOG-crm-tasks-contact-log.md;
 * CRM spec §2; docs/crm/PERMISSIONS-MATRIX.md D5 / D16 superseded).
 *
 *   1. the model: `dana`, staff only, ops BY ID, no capability
 *   2. lib/ops-scope.js: the getData projection (every money field, every list)
 *   3. the REAL server: Dana's operational writes pass and reach the proxy;
 *      the money actions 403 (finance gate); getData projected; /api/me ops;
 *      the page served as the restricted EDIT view; Vered untouched
 *   4. the REAL Code.gs: no read-only lock any more; her saveAll never
 *      changes a money field (preserveMoneyFields_) — a lead / patient she
 *      edits keeps the stored advance / pay / adv, a new one gets none;
 *      Vered's saveAll is untouched; Activity scope stays no_money
 *   5. the pages: the classic page edits for her; the CRM shell gives her the
 *      six operational areas and no «גבייה» */

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
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const ops = require('../lib/ops-scope');
const { FINANCE_ACTIONS } = require('../lib/finance-scope');
const core = require('../public/crm/crm.js');
const { createSessionToken } = require('../lib/session');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const SESSION_SECRET = 'session-secret-TEST-ops-0123456789abcdef0123';
const PROXY_SECRET = 'proxy-secret-TEST-ops-7f3a9c1e5b2d4f6a8c0e11';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-ops-a1b2c3d4e5f60718293a4b5c6d7e';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN', 'CRM_ENABLED', 'CRM_DEFAULT'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', dana: 'דנה', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

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
  return ['vered', 'sandra', 'dana', 'ortal'].map((id) => JSON.parse(users.recordLine(id, _hash, 1)));
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

test('model: dana is staff only, ops BY ID, no capability; principalView says ops; nothing read-only is left in the model', () => {
  const m = users.modelById('dana');
  assert.ok(m && m.status === 'active'); assert.deepStrictEqual([...m.roles], ['staff']);
  assert.deepStrictEqual([...users.OPS_USER_IDS], ['dana']);
  const p = { auth: 'personal', id: 'dana', user: 'דנה', roles: ['staff'] };
  assert.strictEqual(users.isOpsView(p), true);
  assert.strictEqual(users.principalView(p), 'ops');
  assert.deepStrictEqual(users.principalCapabilities(p), []);
  assert.strictEqual(users.hasFinance(p), false); assert.strictEqual(users.hasBillingControl(p), false); assert.strictEqual(users.isControllerView(p), false);
  for (const id of ['vered', 'sandra', 'shiran', 'yael', 'ortal']) assert.strictEqual(users.isOpsView({ auth: 'personal', id }), false, id);
  assert.strictEqual(users.isOpsView({ auth: 'shared', id: 'dana' }), false, 'a shared cookie is never her');
  assert.strictEqual(users.principalView({ auth: 'personal', id: 'shiran' }), 'restricted');
  assert.strictEqual('READONLY_USER_IDS' in users, false); assert.strictEqual('isReadonlyView' in users, false);
  assert.throws(() => users.validateUserPinHashes(JSON.stringify([Object.assign(JSON.parse(users.recordLine('dana', 'a'.repeat(64), 1)), { roles: ['staff', 'deleter'] })])), /not allowed/);
});

/* ===== 2. the scope lib ===== */

test('scope: getData loses every money field in every row list; the input is not mutated; nothing else changes', () => {
  const v = ops.opsGetDataView(GETDATA);
  assert.deepStrictEqual(v.patients.ramot, [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active', notes: 'k' }]);
  assert.deepStrictEqual(v.patients.rehab, []);
  assert.deepStrictEqual(v.leads, [{ id: 'L1', name: 'ליד', phone: '0501', house: 'ramot', stage: 'new', note: 'n' }]);
  assert.deepStrictEqual(v.irrelevantLeads, [{ id: 'L2', name: 'x' }]); assert.deepStrictEqual(v.removedLeads, [{ id: 'L3', name: 'y' }]);
  assert.deepStrictEqual(v.dischargedPatients, [{ id: 'd1', name: 'z', exitDate: '2026-09-01' }]);
  assert.strictEqual('billingOverrides' in v, false, 'the finance-only keys go too');
  assert.deepStrictEqual(v.houseManagers, {}); assert.strictEqual(v.ok, true);
  assert.strictEqual(GETDATA.patients.ramot[0].pay, 6000, 'the input is not mutated');
  assert.deepStrictEqual(ops.opsGetDataView({ ok: true, patients: [{ name: 'a', pay: 1 }] }).patients, [{ name: 'a' }], 'array shape too');
  assert.strictEqual(ops.opsGetDataView(null), null);
  const forbidden = JSON.stringify(ops.opsGetDataView(GETDATA));
  for (const k of ['"pay"', '"adv"', '"advance"', 'billingOverrides']) assert.ok(!forbidden.includes(k), k);
  assert.deepStrictEqual([...ops.OPS_PATIENT_MONEY_KEYS], ['pay', 'adv', 'advance', 'price']);
  assert.deepStrictEqual([...ops.OPS_LEAD_MONEY_KEYS], ['advance', 'price', 'pay']);
});

/* ===== 3. the real server ===== */

test('server: Dana — operational writes pass and reach the proxy with her identity; every FINANCE action 403; delete actions 403; getData projected; /api/me ops; classic page = restricted EDIT view; no read-only gate left', async () => {
  assert.ok(!/readonly-scope|requireReadonlyScope|isReadonlyView|view-readonly/.test(SERVER_SRC), 'the Phase 2a gate is gone');
  await withServer(async (port, mod, stub, lines) => {
    const dana = personal('dana');
    const okWrites = [
      { action: 'saveAll', leads: [{ id: 'L1', name: 'ליד', phone: '0501234567', house: 'ramot', stage: 'new' }], patients: {} },
      { action: 'createTask', submissionId: 'sub-' + '1'.repeat(32), task: { kind: 'call', leadId: 'L1', title: 'x' } },
      { action: 'logContact', submissionId: 'sub-' + '2'.repeat(32), contact: { leadId: 'L1', channel: 'phone', outcome: 'no_answer' }, next: { none: true, explanation: 'xx' } },
      { action: 'completeTask', id: 'task-' + '1'.repeat(32) },
      { action: 'rescheduleTask', id: 'task-' + '1'.repeat(32), dueDate: '2026-11-11' },
      { action: 'reassignTask', id: 'task-' + '1'.repeat(32), assignee: 'ורד' },
      { action: 'withdrawTask', id: 'task-' + '1'.repeat(32), reason: 'xx' },
      { action: 'dischargePatient', patient: { id: 'p1' } },
      { action: 'moveLeadIrrelevant', leadId: 'L1' },
      { action: 'restoreLead', leadId: 'L1' },
    ];
    for (const body of okWrites) {
      const r = await request(port, 'POST', '/api/sheets', { cookie: dana, body });
      assert.strictEqual(r.status, 200, body.action + ' ' + r.text);
      const sent = stub.calls[stub.calls.length - 1];
      assert.strictEqual(sent.action, body.action);
      assert.strictEqual(sent.proxyUserId, 'dana', 'the actor identity rides every write');
      assert.strictEqual(sent.proxyAuth, 'personal');
      assert.deepStrictEqual(sent.proxyCaps, [], 'no finance / billingControl capability');
    }
    // every money action is refused before the proxy
    const before = stub.calls.length;
    for (const action of FINANCE_ACTIONS) {
      const r = await request(port, 'POST', '/api/sheets', { cookie: dana, body: { action } });
      assert.strictEqual(r.status, 403, action);
      const g = await request(port, 'GET', '/api/sheets?action=' + action, { cookie: dana });
      assert.strictEqual(g.status, 403, 'GET ' + action);
    }
    for (const action of ['removeLead', 'deletePatientRow', 'deleteMeetingReport']) {
      const r = await request(port, 'POST', '/api/sheets', { cookie: dana, body: { action, leadId: 'L1' } });
      assert.strictEqual(r.status, 403, action + ' needs deleter');
    }
    assert.strictEqual(stub.calls.length, before, 'nothing refused reached Apps Script');
    assert.ok(!lines.some((l) => /583920/.test(l)), 'the PIN is never logged');
    // reads: getData projected; getTasks / getActivity pass
    const g = await request(port, 'GET', '/api/sheets?action=getData', { cookie: dana });
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual(g.json.patients.ramot, [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active', notes: 'k' }]);
    assert.deepStrictEqual(g.json.leads, [{ id: 'L1', name: 'ליד', phone: '0501', house: 'ramot', stage: 'new', note: 'n' }]);
    assert.strictEqual('billingOverrides' in g.json, false);
    for (const q of ['getTasks', 'getActivity&patientId=p1', 'expectedDischarges', 'upcomingCommittees']) {
      const r = await request(port, 'GET', '/api/sheets?action=' + q, { cookie: dana });
      assert.strictEqual(r.status, 200, q);
    }
    // /api/me
    const me = await request(port, 'GET', '/api/me', { cookie: dana });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.ops, true); assert.strictEqual(me.json.view, 'ops'); assert.strictEqual(me.json.finance, false); assert.strictEqual(me.json.deleter, false);
    assert.strictEqual('readonly' in me.json, false);
    assert.strictEqual(me.json.user, 'דנה');
    // the page: restricted edit view, no readonly class
    const html = await request(port, 'GET', '/', { cookie: dana });
    assert.match(html.text, /<body class="view-restricted">/);
    assert.ok(!/view-readonly/.test(html.text));
    // Vered: full view, untouched; the money action passes her
    const vs = await request(port, 'POST', '/api/sheets', { cookie: personal('vered'), body: { action: 'reportPayment', report: {} } });
    assert.strictEqual(vs.status, 200);
    assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: personal('vered') })).json.ops, false);
    // Ortal: the money tasks are hers to see and close; nothing operational
    const ot = await request(port, 'GET', '/api/sheets?action=getTasks', { cookie: personal('ortal') });
    assert.strictEqual(ot.status, 200);
    const oc = await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: { action: 'createTask', submissionId: 'sub-' + '3'.repeat(32), task: { kind: 'call', leadId: 'L1', title: 'x' } } });
    assert.strictEqual(oc.status, 403, 'Ortal gets no new power');
  });
  await withServer(async (port) => {
    const r = await request(port, 'GET', '/?view=crm', { cookie: personal('dana') });
    assert.match(r.text, /id="crm-root"/);
    const home = await request(port, 'GET', '/', { cookie: personal('dana') });
    assert.ok(!/id="crm-root"/.test(home.text), 'CRM_DEFAULT switches only the full view — Dana stays on the classic page by default');
  }, { CRM_ENABLED: 'true', CRM_DEFAULT: 'true' });
});

/* ===== 4. Code.gs ===== */

function gsWorld() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const lc = Array.from(g.run('LEAD_COLUMNS')), pc = Array.from(g.run('PATIENT_COLUMNS'));
  const ls = richSheet('Leads', lc), ps = richSheet('Patients', pc);
  const lead = { id: 'L1', name: 'ליד אחד', phone: '0501234567', house: 'ramot', stage: 'new', advance: 500, created: '2026-10-01', assignedTo: 'ורד' };
  const pat = { houseId: 'ramot', name: 'דנה כהן', date: '2026-07-01', pay: 6000, adv: 1000, status: 'active', id: 'p1' };
  ls.grid.push(lc.map((c) => lead[c] ?? ''));
  ps.grid.push(pc.map((c) => pat[c] ?? ''));
  g.sandbox.__sheets.Leads = ls; g.sandbox.__sheets.Patients = ps;
  const actor = (id, user, roles, caps) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
  const DANA = actor('dana', 'דנה', ['staff'], []);
  const VERED = actor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const post = (body, who) => plain(g.post(Object.assign({}, body, who)));
  const rows = (name, cols) => g.sheetRows(name, cols);
  const full = (cols, obj) => Object.fromEntries(cols.map((c) => [c, obj[c] ?? '']));
  return { g, lc, pc, lead, pat, DANA, VERED, post, rows, full };
}

test('Code.gs: no read-only lock — Dana\'s operational actions are served; the money actions are refused by the finance gate (forbidden, not forbidden_readonly)', () => {
  const { g, post, DANA } = gsWorld();
  assert.strictEqual(/READONLY_USER_IDS|isReadonlyActor_|forbidden_readonly/.test(fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8')), false);
  assert.deepStrictEqual(Array.from(g.run('OPS_USER_IDS')), [...users.OPS_USER_IDS]);
  assert.deepStrictEqual(Array.from(g.run('OPS_PATIENT_MONEY_KEYS')), [...ops.OPS_PATIENT_MONEY_KEYS]);
  assert.deepStrictEqual(Array.from(g.run('OPS_LEAD_MONEY_KEYS')), [...ops.OPS_LEAD_MONEY_KEYS]);
  const t = post({ action: 'createTask', submissionId: 'sub-' + 'a'.repeat(32), task: { kind: 'call', leadId: 'L1', title: 'לחזור' } }, DANA);
  assert.strictEqual(t.ok, true); assert.strictEqual(t.task.createdBy, 'דנה');
  assert.strictEqual(post({ action: 'getData' }, DANA).ok, true);
  for (const action of ['getPayments', 'debtAging', 'reportPayment', 'appendFunder', 'setBillingDiscount']) {
    const r = post({ action }, DANA);
    assert.strictEqual(r.ok, false, action); assert.strictEqual(r.error, 'forbidden', action);
  }
  assert.strictEqual(post({ action: 'createTask', submissionId: 'sub-' + 'b'.repeat(32), task: { kind: 'collection', patientId: 'p1', title: 'x' } }, DANA).error, 'forbidden', 'no money task either');
});

test('Code.gs: Dana\'s saveAll never changes a money field — the stored advance / pay / adv win over her payload (blank or forged), a NEW row of hers gets none, and the rest of her edit lands; Vered\'s saveAll is untouched', () => {
  const { lc, pc, lead, pat, DANA, VERED, post, rows, full } = gsWorld();
  // her copy has no money (projected out) and a forged value on the other row
  const editedLead = full(lc, Object.assign({}, lead, { note: 'דיברנו', advance: '' }));
  const newLead = full(lc, { id: 'L9', name: 'ליד חדש', phone: '0529876543', house: 'ramot', stage: 'new', advance: 9999, created: '2026-10-28', assignedTo: 'דנה' });
  const editedPat = full(pc, Object.assign({}, pat, { notes: 'עודכן', pay: 1, adv: '' }));
  const r = post({ action: 'saveAll', leads: JSON.stringify([editedLead, newLead]), patients: JSON.stringify({ ramot: [editedPat] }) }, DANA);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.moneyPreserved, 3);
  const leads = rows('Leads', 'LEAD_COLUMNS'), pats = rows('Patients', 'PATIENT_COLUMNS');
  const l1 = leads.find((x) => x.id === 'L1'), l9 = leads.find((x) => x.id === 'L9');
  assert.strictEqual(String(l1.advance), '500', 'stored advance kept'); assert.strictEqual(l1.note, 'דיברנו', 'her edit landed');
  assert.strictEqual(String(l9.advance), '', 'a new lead of hers carries no money'); assert.strictEqual(l9.name, 'ליד חדש');
  const p1 = pats.find((x) => x.id === 'p1');
  assert.strictEqual(String(p1.pay), '6000'); assert.strictEqual(String(p1.adv), '1000'); assert.strictEqual(p1.notes, 'עודכן');
  // Vered: her payload is the truth, as before
  const v = post({ action: 'saveAll', leads: JSON.stringify([full(lc, Object.assign({}, lead, { advance: 700 }))]), patients: JSON.stringify({ ramot: [full(pc, Object.assign({}, pat, { pay: 6500 }))] }) }, VERED);
  assert.strictEqual(v.ok, true); assert.strictEqual('moneyPreserved' in v, false);
  assert.strictEqual(String(rows('Leads', 'LEAD_COLUMNS').find((x) => x.id === 'L1').advance), '700');
  assert.strictEqual(String(rows('Patients', 'PATIENT_COLUMNS').find((x) => x.id === 'p1').pay), '6500');
  // and Dana's next save still cannot undo Vered's price
  const again = post({ action: 'saveAll', leads: JSON.stringify([full(lc, Object.assign({}, lead, { advance: '' }))]), patients: JSON.stringify({ ramot: [full(pc, Object.assign({}, pat, { pay: '' }))] }) }, DANA);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(String(rows('Leads', 'LEAD_COLUMNS').find((x) => x.id === 'L1').advance), '700');
  assert.strictEqual(String(rows('Patients', 'PATIENT_COLUMNS').find((x) => x.id === 'p1').pay), '6500');
});

/* ===== 5. the pages ===== */

test('pages: the classic page edits for Dana (restricted view, no read-only mode); the CRM shell gives her the six operational areas, never «גבייה»; no read-only code is left', () => {
  assert.ok(!/readonlyView|view-readonly|i\.readonly/.test(APP_SRC));
  assert.match(APP_SRC, /state\.mode = controllerView\(\) \? 'view' : 'edit'/);
  assert.ok(!/view-readonly/.test(CSS_SRC));
  assert.deepStrictEqual(core.areasFor({ view: 'ops', ops: true, finance: false }), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control', 'triage']);
  assert.deepStrictEqual(core.areasFor({ view: 'restricted', finance: false }), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control', 'triage']);
  assert.ok(core.areasFor({ view: 'full', finance: true }).indexOf('billing') >= 0, 'Vered keeps «גבייה»');
  assert.ok(!/\.crm\.readonly/.test(CRM_CSS)); assert.ok(!/me\.readonly|'readonly'/.test(CRM_SRC));
});
