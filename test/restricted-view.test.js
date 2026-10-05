/* Restricted view — Shiran and Yael (decided by Sandra, 2026-10-03).
 * See CHANGELOG-restricted-view.md for the tab → action map.
 *
 * server.js (real Express app, https.request stubbed):
 *   - every FINANCE_ACTIONS action (GET + POST /api/sheets) and every
 *     FINANCE_ROUTES route → 403 «אין הרשאה לצפות בנתוני גבייה» for Shiran and
 *     Yael, with NOTHING proxied; served for Vered and Sandra (PR C: the
 *     shared session is gone — its cookie is 401)
 *   - the refusal is logged with the user id and the action only
 *   - getData: billing-only keys dropped for a restricted session, every key
 *     kept for a full-view one
 *   - records shaped exactly like the live Sandra / Vered lines keep finance
 *   - proxyCaps comes from the session only
 *   - index.html is served with body.view-restricted to a restricted session
 * Code.gs (vm): the same refusal for a verified restricted actor, re-derived
 *   from proxyAuth + proxyUserId (a forged proxyCaps cannot widen it), getData
 *   keys, the action lists pinned equal.
 * public/app.js (vm): allowed screens, the deep-link fallback, the billing
 *   renders are no-ops. */

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
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const scope = require('../lib/finance-scope');
const { createSessionToken } = require('../lib/session');

const SESSION_SECRET = 'session-secret-TEST-restricted-0123456789abcdef';
const PROXY_SECRET = 'proxy-secret-TEST-restricted-7f3a9c1e5b2d4f6a8c0e';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const APP_PIN = '4711';
const PEPPER = 'pepper-TEST-restricted-a1b2c3d4e5f60718293a4b5c6d7e';
const FORBIDDEN = { ok: false, error: 'forbidden', message: 'אין הרשאה לצפות בנתוני גבייה' };

/* The full getData key list (Code.gs getData_, pinned in the PR A suite). */
const GETDATA_KEYS = ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
  'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource'];

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

/* Records shaped EXACTLY like the live lines: what /api/bootstrap-pin and
 * «קוד אישי חדש» emit (lib/users.js recordLine), parsed back. */
let _hash;
async function liveRecords(over) {
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  const o = over || {};
  return ['vered', 'sandra', 'shiran', 'yael'].map((id) => Object.assign(JSON.parse(users.recordLine(id, _hash, 1)), o[id] || {}));
}

async function envWith(over, recs) {
  return Object.assign({
    PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER,
    USER_PIN_HASHES: JSON.stringify(recs || await liveRecords()),
  }, over || {});
}

const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל' };
const personal = (id, v) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: v || 1 });
// The retired shared APP_PIN cookie (no personal id) — 401 since PR C.
const shared = () => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד');

/* An Apps Script stub that answers getData with every key and anything else
 * with { ok:true }. */
function stubAll() {
  return stubHttps(({ body }) => {
    const b = JSON.parse(body || '{}');
    if (b.action === 'getData') {
      const out = {};
      GETDATA_KEYS.forEach((k) => { out[k] = k === 'ok' ? true : (k === 'currentManagersSource' ? 'x' : []); });
      return { body: out };
    }
    return { body: { ok: true, payments: [], credits: [] } };
  });
}

/* ====================================================================== */
/* =============================== model ================================ */
/* ====================================================================== */

test('model: finance by stable id — Vered and Sandra yes, Shiran / Yael / Ortal no, a shared principal no (PR C)', () => {
  assert.deepStrictEqual([...users.FINANCE_USER_IDS], ['vered', 'sandra']);
  const cap = (auth, id) => users.principalCapabilities({ auth, id, user: '', roles: [] });
  // Phase 4: the finance users also hold billingControl; Ortal holds ONLY it.
  assert.deepStrictEqual(cap('personal', 'vered'), ['finance', 'billingControl']);
  assert.deepStrictEqual(cap('personal', 'sandra'), ['finance', 'billingControl']);
  assert.deepStrictEqual(cap('personal', 'shiran'), []);
  assert.deepStrictEqual(cap('personal', 'yael'), []);
  assert.deepStrictEqual(cap('personal', 'ortal'), ['billingControl'], 'never finance');
  assert.deepStrictEqual(cap('shared', ''), [], 'PR C: no shared session any more');
  assert.deepStrictEqual(users.principalCapabilities(null), []);
  assert.deepStrictEqual(users.principalCapabilities({ auth: 'none', id: '', roles: [] }), [], 'meeting-report proxy');
  // USER_PIN_HASHES has no field for it: a record cannot grant it.
  assert.throws(() => users.validateUserPinHashes(JSON.stringify([Object.assign(JSON.parse(users.recordLine('shiran', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1)), { capabilities: ['finance'] })])));
});

test('live-shaped Sandra / Vered records (exactly as pasted, and Vered narrowed) keep FULL access — no USER_PIN_HASHES change', async () => {
  for (const recs of [await liveRecords(), await liveRecords({ vered: { roles: ['staff'] } })]) {
    // The records parse exactly as the live lines do.
    assert.deepStrictEqual(Object.keys(recs[0]), ['id', 'name', 'roles', 'hash', 'pinVersion', 'status']);
    const stub = stubAll();
    try {
      await withServer(await envWith({}, recs), async (port) => {
        for (const id of ['vered', 'sandra']) {
          const me = await request(port, 'GET', '/api/me', { cookie: personal(id) });
          assert.strictEqual(me.json.finance, true, id);
          const r = await request(port, 'GET', '/api/sheets?action=getPayments', { cookie: personal(id) });
          assert.strictEqual(r.status, 200, id);
        }
        for (const id of ['shiran', 'yael']) {
          assert.strictEqual((await request(port, 'GET', '/api/me', { cookie: personal(id) })).json.finance, false, id);
        }
      });
    } finally { stub.restore(); }
  }
});

/* ====================================================================== */
/* ======================= server: the real lock ======================== */
/* ====================================================================== */

test('every mapped ACTION → 403 for Shiran and Yael (GET and POST, nothing proxied, logged with id + action only)', async () => {
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      for (const id of ['shiran', 'yael']) {
        for (const action of scope.FINANCE_ACTIONS) {
          const before = stub.calls.length;
          let g, p;
          const lines = await captureConsole(async () => {
            g = await request(port, 'GET', '/api/sheets?action=' + action, { cookie: personal(id) });
            p = await request(port, 'POST', '/api/sheets', {
              cookie: personal(id), body: { action, payment: { id: 'P1', amount: 9999, patientName: 'סוד' } },
            });
          });
          assert.deepStrictEqual([g.status, g.json], [403, FORBIDDEN], `GET ${action} ${id}`);
          assert.deepStrictEqual([p.status, p.json], [403, FORBIDDEN], `POST ${action} ${id}`);
          assert.strictEqual(stub.calls.length, before, 'nothing reached Apps Script: ' + action);
          const log = lines.filter((l) => l.startsWith('[finance]'));
          assert.deepStrictEqual(log, [`[finance] 403 user=${id} action=${action}`, `[finance] 403 user=${id} action=${action}`]);
          assert.ok(!lines.join('\n').includes('9999') && !lines.join('\n').includes('סוד'), 'no data in the log');
        }
      }
    });
  } finally { stub.restore(); }
});

test('every mapped ACTION is served for Vered and Sandra (unchanged); a shared cookie is 401 (PR C)', async () => {
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getPayments', { cookie: shared() })).status, 401);
      for (const cookie of [personal('vered'), personal('sandra')]) {
        for (const action of scope.FINANCE_ACTIONS) {
          const before = stub.calls.length;
          assert.strictEqual((await request(port, 'GET', '/api/sheets?action=' + action, { cookie })).status, 200, action);
          assert.strictEqual((await request(port, 'POST', '/api/sheets', { cookie, body: { action } })).status, 200, action);
          assert.strictEqual(stub.calls.length, before + 2, 'proxied: ' + action);
        }
      }
    });
  } finally { stub.restore(); }
});

test('every mapped ROUTE (/api/export/*.xlsx, /api/debug/*) → 403 for Shiran and Yael; passes the gate for full-view sessions', async () => {
  assert.deepStrictEqual([...scope.FINANCE_ROUTES],
    ['/api/export/refund-forecast.xlsx', '/api/export/debt-aging.xlsx', '/api/export/cleanup.xlsx', '/api/debug/last-save', '/api/debug/last-load']);
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      const url = (r) => (r.includes('debt-aging') ? r + '?asOf=2026-09-30&house=all&status=all' : r);
      for (const id of ['shiran', 'yael']) {
        for (const route of scope.FINANCE_ROUTES) {
          const before = stub.calls.length;
          const r = await request(port, 'GET', url(route), { cookie: personal(id) });
          assert.deepStrictEqual([r.status, r.json], [403, FORBIDDEN], route + ' ' + id);
          assert.strictEqual(stub.calls.length, before);
        }
      }
      for (const cookie of [personal('vered'), personal('sandra')]) {
        for (const route of scope.FINANCE_ROUTES) {
          const r = await request(port, 'GET', url(route), { cookie });
          assert.notStrictEqual(r.status, 403, route);
          if (route.startsWith('/api/debug/')) assert.strictEqual(r.status, 200, route);
        }
      }
    });
  } finally { stub.restore(); }
});

test('non-billing work is unchanged for Shiran and Yael: getData, saveAll, discharge, lead moves, restores are served', async () => {
  // PR C: deleteMeetingReport (and every other delete) now needs `deleter`,
  // which Shiran and Yael do not hold — see test/personal-pins-cleanup.test.js.
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      for (const action of ['getData', 'saveAll', 'dischargePatient', 'moveLeadIrrelevant', 'restoreLead', 'restorePatient', 'restorePatientToActive']) {
        const r = await request(port, 'POST', '/api/sheets', { cookie: personal('shiran'), body: { action } });
        assert.strictEqual(r.status, 200, action);
      }
      assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getData', { cookie: personal('yael') })).status, 200);
    });
  } finally { stub.restore(); }
});

test('getData: a restricted session gets every key EXCEPT billingOverrides; full-view sessions get every key, unchanged', async () => {
  assert.deepStrictEqual([...scope.GETDATA_FINANCE_KEYS], ['billingOverrides']);
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      for (const id of ['shiran', 'yael']) {
        for (const method of ['GET', 'POST']) {
          const r = method === 'GET'
            ? await request(port, 'GET', '/api/sheets?action=getData', { cookie: personal(id) })
            : await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: { action: 'getData' } });
          assert.deepStrictEqual(Object.keys(r.json), GETDATA_KEYS.filter((k) => k !== 'billingOverrides'), id + ' ' + method);
        }
      }
      for (const cookie of [personal('vered'), personal('sandra')]) {
        const r = await request(port, 'GET', '/api/sheets?action=getData', { cookie });
        assert.deepStrictEqual(Object.keys(r.json), GETDATA_KEYS, 'append-only contract');
      }
    });
  } finally { stub.restore(); }
});

test('proxyCaps reaches Apps Script from the session only — a body copy is dropped', async () => {
  const stub = stubAll();
  try {
    await withServer(await envWith(), async (port) => {
      await request(port, 'POST', '/api/sheets', { cookie: personal('shiran'), body: { action: 'saveAll', proxyCaps: ['finance'] } });
      await request(port, 'POST', '/api/sheets', { cookie: personal('vered'), body: { action: 'saveAll', proxyCaps: [] } });
      assert.strictEqual((await request(port, 'POST', '/api/sheets', { cookie: shared(), body: { action: 'saveAll' } })).status, 401);
    });
  } finally { stub.restore(); }
  const caps = stub.calls.map((c) => JSON.parse(c.body).proxyCaps);
  assert.deepStrictEqual(caps, [[], ['finance', 'billingControl']]);
});

test('index.html: a restricted session is served <body class="view-restricted">; no session and full-view sessions get the page unchanged', async () => {
  await withServer(await envWith(), async (port) => {
    const bodyTag = (t) => (t.match(/^<body[^>]*>$/m) || /\n\s*(<body[^>]*>)/.exec(t) || [])[0].trim();
    for (const id of ['shiran', 'yael']) {
      assert.strictEqual(bodyTag((await request(port, 'GET', '/', { cookie: personal(id) })).text), '<body class="view-restricted">', id);
    }
    for (const cookie of [undefined, personal('vered'), personal('sandra'), shared()]) {
      assert.strictEqual(bodyTag((await request(port, 'GET', '/', { cookie })).text), '<body>', String(cookie));
    }
  });
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'), /body\.view-restricted \[data-finance\] \{ display: none !important; \}/);
});

test('a shared cookie is refused outright (401) — PR C removed the shared session', async () => {
  await withServer(await envWith({ APP_PIN }), async (port) => {
    assert.strictEqual((await request(port, 'GET', '/api/sheets?action=getPayments', { cookie: shared() })).status, 401);
  });
});

/* ====================================================================== */
/* ======================= Code.gs: the second lock ===================== */
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

const actor = (auth, id, user, extra) => Object.assign({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: auth, proxyUserId: id,
  proxyRoles: ['staff', 'reporter'],
}, extra || {});

test('Code.gs: FINANCE_ACTIONS / FINANCE_USER_IDS / GETDATA_FINANCE_KEYS equal lib/finance-scope.js and lib/users.js', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  assert.deepStrictEqual(Array.from(g.run('FINANCE_ACTIONS')), [...scope.FINANCE_ACTIONS]);
  assert.deepStrictEqual(Array.from(g.run('FINANCE_USER_IDS')), [...users.FINANCE_USER_IDS]);
  assert.deepStrictEqual(Array.from(g.run('GETDATA_FINANCE_KEYS')), [...scope.GETDATA_FINANCE_KEYS]);
  assert.strictEqual(g.run('FINANCE_FORBIDDEN_MESSAGE'), scope.FINANCE_FORBIDDEN_MESSAGE);
  // Every finance action is one handle_ really dispatches.
  for (const a of scope.FINANCE_ACTIONS) assert.ok(new RegExp(`action === '${a}'`).test(GS_SRC), a);
});

test('Code.gs refuses every mapped action for a verified restricted actor — even with a forged proxyCaps — in log and enforce mode', () => {
  for (const mode of ['log', 'enforce']) {
    const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: mode } });
    for (const [id, name] of [['shiran', 'שירן'], ['yael', 'יעל']]) {
      for (const action of scope.FINANCE_ACTIONS) {
        for (const extra of [{ proxyCaps: [] }, { proxyCaps: ['finance'] }, {}]) {
          const out = g.post(Object.assign({ action, payment: { id: 'P9', amount: 1 }, credit: { id: 'C9' } }, actor('personal', id, name, extra)));
          assert.deepStrictEqual(out, FORBIDDEN, `${mode} ${id} ${action} ${JSON.stringify(extra)}`);
        }
      }
    }
    assert.ok(!g.sandbox.__sheets.Payments && !g.sandbox.__sheets.Credits, 'nothing was written: ' + mode);
  }
});

test('Code.gs serves the mapped actions for Vered, Sandra, a legacy proxy body — and refuses a stale shared auth (PR C) or when the server withheld finance', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const pay = { id: 'P1', patientId: 'arfoni::x::2026-09-01', patientName: 'x', houseId: 'arfoni', dueDate: '2026-09-07', amount: 100, amountPaid: 0, balance: 100 };
  const ok = (body) => g.post(Object.assign({ action: 'getPayments' }, body));
  assert.strictEqual(ok(actor('personal', 'vered', 'ורד')).ok, true);
  assert.strictEqual(ok(actor('personal', 'sandra', 'סנדרה', { proxyCaps: ['finance'] })).ok, true);
  assert.deepStrictEqual(ok(actor('shared', '', 'ורד', { proxyCaps: ['finance'] })), FORBIDDEN, 'PR C: a stale shared auth is none');
  assert.strictEqual(ok({ proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד' }).ok, true, 'legacy proxy body (no proxyAuth)');
  assert.deepStrictEqual(ok(actor('personal', 'vered', 'ורד', { proxyCaps: [] })), FORBIDDEN, 'the server says no → no (intersection)');
  assert.deepStrictEqual(ok(actor('none', '', '', { proxyCaps: ['finance'] })), FORBIDDEN, 'the meeting-report principal has none');
  const w = g.post(Object.assign({ action: 'savePayment', payment: pay }, actor('personal', 'vered', 'ורד')));
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  // A caller without a valid secret has no actor: not refused HERE (log mode
  // is legacy; enforce mode refuses it at the gate, as before).
  assert.strictEqual(g.post({ action: 'getPayments' }).ok, true);
  const e = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  assert.deepStrictEqual(e.post({ action: 'getPayments' }), { ok: false, error: 'unauthorized' });
});

test('Code.gs getData: every key for full view (unchanged); no billingOverrides for a restricted actor; actingUser_ caps', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  for (const body of [actor('personal', 'vered', 'ורד'), actor('personal', 'sandra', 'סנדרה'),
    { proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד' }]) {
    assert.deepStrictEqual(Object.keys(g.post(Object.assign({ action: 'getData' }, body))), GETDATA_KEYS);
  }
  // PR C: a stale 'shared' auth is 'none' → the restricted keys.
  assert.deepStrictEqual(Object.keys(g.post(Object.assign({ action: 'getData' }, actor('shared', '', 'ורד')))),
    GETDATA_KEYS.filter((k) => k !== 'billingOverrides'));
  for (const [id, name] of [['shiran', 'שירן'], ['yael', 'יעל']]) {
    const out = g.post(Object.assign({ action: 'getData' }, actor('personal', id, name)));
    assert.deepStrictEqual(Object.keys(out), GETDATA_KEYS.filter((k) => k !== 'billingOverrides'));
  }
  const a = g.sandbox.proxyActor_('שירן', 'shiran', 'personal', ['staff'], ['finance']);
  assert.deepStrictEqual(Array.from(a.caps), [], 'a forged cap cannot widen the derivation');
  assert.deepStrictEqual(Array.from(g.sandbox.proxyActor_('ורד', 'vered', 'personal', ['staff'], '["finance"]').caps), ['finance']);
  assert.deepStrictEqual(Array.from(g.sandbox.actingUser_({}).caps), []);
});

/* ====================================================================== */
/* ============================ public/app.js =========================== */
/* ====================================================================== */

function loadApp() {
  const noop = () => {};
  const removed = [];
  const nodes = ['billing', 'revenue', 'reconnect', 'growth'].map((s) => ({ id: 'tab-' + s, remove() { removed.push(this.id); } }));
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: { classList: { _c: new Set(), toggle(c, on) { if (on) this._c.add(c); else this._c.delete(c); }, contains(c) { return this._c.has(c); } } },
      getElementById: () => null, // a billing render that touches the DOM would throw
      createElement: () => ({ classList: { add: noop, toggle: noop }, appendChild: noop }),
      querySelectorAll: (sel) => (sel === '[data-finance]' ? nodes : []),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      SCREENS, FINANCE_SCREENS, allowedScreens, resolveScreen, screenFromHash, financeView, applyView,
      renderBilling, renderMonthlyRevenue, renderReconnect, renderGrowthGraph, renderCreditsPayouts,
      renderRenewalAlert, renderOverdueAlert,
      stubRenderAll(fn) { renderAll = fn; },
      stubShowScreen(fn) { showScreen = fn; },
      get state() { return state; },
    };`, sandbox);
  return { app: sandbox.__test, sandbox, removed };
}

test('client: exactly the allowed tabs per session — 7 for Shiran / Yael, all 11 for Sandra / Vered', () => {
  const { app } = loadApp();
  assert.deepStrictEqual([...app.FINANCE_SCREENS], ['billing', 'revenue', 'reconnect', 'growth']);
  assert.deepStrictEqual([...app.allowedScreens(false)],
    ['dashboard', 'leads', 'meetings', 'occupancy', 'discharged-patients', 'breakeven', 'retention']);
  assert.deepStrictEqual([...app.allowedScreens(true)], [...app.SCREENS]);
  assert.deepStrictEqual([...app.allowedScreens(null)], [...app.SCREENS], 'unknown = as before');
});

test('client: a deep link or current tab pointing at a money tab falls back to the first allowed tab', () => {
  const { app } = loadApp();
  for (const s of ['billing', 'revenue', 'reconnect', 'growth']) {
    assert.strictEqual(app.resolveScreen(s, false), 'dashboard', s);
    assert.strictEqual(app.resolveScreen(s, true), s, s);
  }
  assert.strictEqual(app.resolveScreen('discharged-patients', false), 'discharged-patients');
  assert.strictEqual(app.resolveScreen('nope', true), 'dashboard');
  assert.strictEqual(app.screenFromHash('#billing'), 'billing');
  assert.strictEqual(app.screenFromHash('#screen-growth'), 'growth');
  assert.strictEqual(app.screenFromHash('#nope'), '');

  // applyView(false): removes every [data-finance] node, clears billing state,
  // and moves off a money tab — the deep link (#billing) included.
  const v = loadApp();
  v.sandbox.location.hash = '#billing';
  let shown = '';
  v.app.stubShowScreen((s) => { shown = s; v.app.state.currentScreen = s; });
  v.app.stubRenderAll(() => {});
  v.app.state.currentScreen = 'revenue';
  v.app.state.payments = [{ id: 'x' }];
  v.app.applyView(false);
  assert.deepStrictEqual(v.removed, ['tab-billing', 'tab-revenue', 'tab-reconnect', 'tab-growth']);
  assert.strictEqual(shown, 'dashboard');
  assert.strictEqual(v.app.state.finance, false);
  assert.deepStrictEqual(Array.from(v.app.state.payments), []);
  assert.strictEqual(v.sandbox.document.body.classList.contains('view-restricted'), true);
});

test('client: every billing render is a no-op for a restricted session (they would throw on the removed DOM otherwise)', () => {
  const { app } = loadApp();
  app.state.finance = false;
  for (const fn of ['renderBilling', 'renderMonthlyRevenue', 'renderReconnect', 'renderGrowthGraph', 'renderCreditsPayouts', 'renderRenewalAlert', 'renderOverdueAlert']) {
    assert.doesNotThrow(() => app[fn](), fn);
  }
  app.state.finance = true;
  assert.throws(() => app.renderBilling(), 'and they do run for a full-view session');
});

test('client: no billing leaks — loadAll skips getPayments / getCredits, the «זיכויים» button and the discharge refund step are guarded', () => {
  const loadAll = APP_SRC.slice(APP_SRC.indexOf('async function loadAll()'), APP_SRC.indexOf('// ===== Patient-load diagnosis ====='));
  // Phase 3 PR 2 also empties the receipts and the funders there.
  assert.match(loadAll, /if \(!financeView\(\)\) \{\s*state\.payments = \[\];\s*state\.credits = \[\];\s*state\.receipts = \[\];\s*state\.funders = \[\];\s*\} else try \{\s*const pr = await apiGet\(\{ action: 'getPayments' \}\);/);
  assert.match(loadAll, /if \(financeView\(\)\) try \{\s*const cr = await apiGet\(\{ action: 'getCredits' \}\);/);
  assert.match(APP_SRC, /if \(financeView\(\)\) \{\s*const nCredits = creditsForPatient/);
  assert.match(APP_SRC, /if \(financeView\(\)\) try \{\s*await showCreditsModal\(\{\s*patient: p,/);
  for (const id of ['renewal-alert', 'overdue-alert']) assert.match(HTML_SRC, new RegExp(`id="${id}"[^>]*data-finance`), id);
  for (const s of ['billing', 'revenue', 'reconnect', 'growth']) {
    assert.match(HTML_SRC, new RegExp(`data-screen="${s}" data-finance`), s);
    assert.match(HTML_SRC, new RegExp(`id="screen-${s}" class="screen hidden" data-finance`), s);
  }
  assert.strictEqual((HTML_SRC.match(/ data-finance[ >]/g) || []).length, 10, 'exactly the 4 tabs, 4 screens and 2 widgets');
});

test('service worker: v27 or later', () => {
  // v27 shipped the restricted view; later PRs bump it again (v28: cleanup workbook).
  const m = /var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC);
  assert.ok(m && Number(m[1]) >= 27, m && m[1]);
});
