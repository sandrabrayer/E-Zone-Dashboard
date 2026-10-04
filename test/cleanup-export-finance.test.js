'use strict';
/*
 * Regression: «ייצוא רשימת תיקונים» answered 403 to Sandra's PERSONAL
 * session (CHANGELOG-cleanup-export-finance.md).
 *
 * server.js requireFinance passed her, but the export handlers called
 * sheetsPost WITHOUT the session principal, so the Apps Script body said
 * proxyAuth 'none' / proxyCaps [] and Code.gs financeRefused_ answered
 * {ok:false, error:'forbidden'} → the route's 403. The stubbed Apps Script
 * here runs the REAL Code.gs gate (proxyGate_ + financeRefused_) on every
 * body the server sends, so a missing principal fails exactly as it did live.
 *
 *   - Sandra (personal, id 'sandra') → 200 on all three export routes;
 *     the body carries proxyAuth 'personal', proxyUserId 'sandra', proxyCaps ['finance'].
 *   - Vered (personal) → 200.
 *   - Shiran (personal) → 403 from server.js, nothing proxied.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const SERVER_PATH = require.resolve('../server');
const scope = require('../lib/finance-scope');
const report = require('../lib/xlsx-report');
const cleanup = require('../lib/cleanup-xlsx');
const { createSessionToken } = require('../lib/session');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');

const PROXY = 'proxy-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SESSION_SECRET = 'session-secret-TEST-cleanup-finance-0123456789ab';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-cleanup-finance-a1b2c3d4e5f60718293a4b5c6d7e8f';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER', 'APP_PIN_UNTIL'];
const TODAY = '2026-10-03';

/* ---------- the real Code.gs gate ---------- */
function loadGate() {
  const props = { PROXY_SECRET: PROXY };
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    Logger: { log: noop },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: noop, deleteProperty: noop }) },
    // securityLogOnce_ is fail-soft; a missing sheet only skips the log row.
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null, insertSheet: () => { throw new Error('no sheets'); } }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: noop, remove: noop }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: noop, releaseLock: noop }) },
    Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 10) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox);
  return sandbox;
}
const GS = loadGate();
/* What Code.gs answers before any read: 'forbidden' when handle_ would refuse. */
function gateRefuses(body) {
  const g = GS.proxyGate_(JSON.parse(JSON.stringify(body)), 'POST');
  assert.equal(g.ok, true, 'the proxy secret verifies');
  return GS.financeRefused_(g.params, body.action);
}

/* ---------- minimal valid Apps Script answers per action ---------- */
const emptySections = () => cleanup.SECTION_KEYS.reduce((o, k) => { o[k] = []; return o; }, {});
const ANSWERS = {
  cleanupReport: () => ({ ok: true, today: TODAY, recordsCutoff: '2026-07-01', sections: emptySections(),
    counts: cleanup.SECTION_KEYS.reduce((o, k) => { o[k] = 0; return o; }, {}) }),
  refundPayoutForecast: () => ({ ok: true,
    decided: { byPayoutDate: [], byHouse: [] }, awaiting_decision: { byPayoutDate: [], byHouse: [] },
    missing_payment_data: { count: 0, rows: [] } }),
  debtAging: (b) => ({ ok: true, asOf: b.asOf,
    totals: { recorded_debt: { amount: 0, count: 0 }, unrecorded_cycles: { amount: 0, count: 0 } }, byPatient: [] }),
};

function stubAppsScript() {
  const sent = [];
  const original = https.request;
  https.request = (_url, _opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      const b = JSON.parse(body || '{}');
      sent.push(b);
      const out = gateRefuses(b)
        ? { ok: false, error: 'forbidden', message: scope.FINANCE_FORBIDDEN_MESSAGE }
        : ANSWERS[b.action](b);
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(out)); res.emit('end'); });
    };
    return req;
  };
  return { sent, restore: () => { https.request = original; } };
}

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  try { return require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function get(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
async function withServer(fn) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const env = { PROXY_SECRET: PROXY, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER,
    USER_PIN_HASHES: JSON.stringify(['vered', 'sandra', 'shiran', 'yael'].map((id) => JSON.parse(users.recordLine(id, hash, 1)))) };
  const mod = freshServer(env);
  const srv = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  const quiet = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { return await fn(srv.address().port); } finally { Object.assign(console, quiet); srv.close(); }
}
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל' };
/* A personal-PIN session cookie — the exact shape the login issues. */
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

const ROUTES = [
  ['/api/export/cleanup.xlsx', 'cleanupReport'],
  ['/api/export/refund-forecast.xlsx', 'refundPayoutForecast'],
  ['/api/export/debt-aging.xlsx?asOf=' + TODAY, 'debtAging'],
];

test('the gate itself: a body without the principal is refused for a billing action (the live bug)', () => {
  assert.equal(gateRefuses({ action: 'cleanupReport', user: 'סנדרה', proxyUser: 'סנדרה', proxySecret: PROXY,
    proxyAuth: 'none', proxyUserId: '', proxyRoles: [], proxyCaps: [] }), true);
  assert.equal(gateRefuses({ action: 'cleanupReport', user: 'סנדרה', proxyUser: 'סנדרה', proxySecret: PROXY,
    proxyAuth: 'personal', proxyUserId: 'sandra', proxyRoles: ['staff', 'approver'], proxyCaps: ['finance'] }), false);
});

test("Sandra's personal session (id 'sandra') → 200 on cleanup.xlsx and both sibling exports; the principal reaches Apps Script", async () => {
  const stub = stubAppsScript();
  try {
    await withServer(async (port) => {
      for (const [route, action] of ROUTES) {
        const r = await get(port, route, personal('sandra'));
        assert.equal(r.status, 200, route + ' → ' + JSON.stringify(r.json));
        assert.equal(r.headers['content-type'], report.XLSX_MIME, route);
        assert.equal(r.headers['cache-control'], 'no-store', route);
        const b = stub.sent[stub.sent.length - 1];
        assert.equal(b.action, action);
        assert.equal(b.proxyAuth, 'personal', route);
        assert.equal(b.proxyUserId, 'sandra', route);
        assert.deepEqual(b.proxyCaps, ['finance'], route);
        assert.equal(b.user, 'סנדרה', route);
      }
    });
  } finally { stub.restore(); }
  assert.equal(stub.sent.length, ROUTES.length);
});

test('Vered (personal) → 200 on cleanup.xlsx', async () => {
  const stub = stubAppsScript();
  try {
    await withServer(async (port) => {
      const r = await get(port, '/api/export/cleanup.xlsx', personal('vered'));
      assert.equal(r.status, 200, JSON.stringify(r.json));
    });
  } finally { stub.restore(); }
  assert.equal(stub.sent[0].proxyUserId, 'vered');
});

test('Shiran (personal) → 403 on every export route; nothing reaches Apps Script', async () => {
  const stub = stubAppsScript();
  try {
    await withServer(async (port) => {
      for (const [route] of ROUTES) {
        const r = await get(port, route, personal('shiran'));
        assert.deepEqual([r.status, r.json], [403, { ok: false, error: 'forbidden', message: scope.FINANCE_FORBIDDEN_MESSAGE }], route);
      }
    });
  } finally { stub.restore(); }
  assert.equal(stub.sent.length, 0);
});
