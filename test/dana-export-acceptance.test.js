'use strict';

// Actual server projection -> actual classic-page export handlers -> decoded
// XLSX/CSV. All identities, rows and credentials below are synthetic. Every
// upstream HTTPS request is intercepted; only loopback HTTP is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const { loadPage } = require('./helpers/app-sandbox');
const X = require('../lib/report-xlsx');
const R = require('../lib/patient-retention');
const LF = require('../lib/leads-funnel');
const { FINANCE_ROUTES } = require('../lib/finance-scope');

const FROM = '2026-09-01', TO = '2026-09-30';
const SESSION_SECRET = 'session-secret-TEST-export-0123456789abcdef0123';
const PROXY_SECRET = 'proxy-secret-TEST-export-0123456789abcdef0123';
const PEPPER = 'pepper-TEST-export-0123456789abcdef0123456789';
const SERVER_PATH = require.resolve('../server');
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN',
  'USER_PIN_HASHES', 'PIN_PEPPER', 'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS',
  'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL',
  'HEALTHCHECK_TOKEN', 'CRM_ENABLED', 'CRM_DEFAULT', 'SHEETS_READ_CACHE_MS'];
const MONEY_KEYS = ['pay', 'adv', 'advance', 'price'];
const MONEY = Object.freeze({ pay: 913711.13, adv: 913722.22,
  advance: 913733.33, price: 913744.44 });
const LEAD_MONEY = Object.freeze({ pay: MONEY.pay, advance: MONEY.advance, price: MONEY.price });
const FINANCE_CANARIES = [...Object.values(MONEY).map(String), 'FINANCE-OVERRIDE-CANARY'];
const clone = (value) => JSON.parse(JSON.stringify(value));

function source() {
  return {
    ok: true,
    patients: {
      ramot: [Object.assign({ id: 'synthetic-p1', houseId: 'ramot',
        name: 'SYNTHETIC PATIENT ONE', date: '2026-09-01', status: 'released',
        exitDate: '2026-09-11', notes: 'SYNTHETIC OPERATIONAL NOTE' }, MONEY)],
      rehab: [Object.assign({ id: 'synthetic-p2', houseId: 'rehab',
        name: 'SYNTHETIC PATIENT TWO', date: '2026-09-02', status: 'active' }, MONEY)],
    },
    dischargedPatients: [Object.assign({ id: 'synthetic-d1', patientId: 'synthetic-p1',
      name: 'SYNTHETIC PATIENT ONE', houseId: 'ramot', date: '2026-09-01',
      exitDate: '2026-09-11', continuity: 'none', phone: '0500000001' }, MONEY)],
    leads: [Object.assign({ id: 'synthetic-l1', name: 'SYNTHETIC LEAD ONE',
      phone: '0500000002', created: '2026-09-04', house: 'ramot', stage: 'visit',
      visitDate: '2026-09-10', note: 'SYNTHETIC LEAD NOTE' }, LEAD_MONEY)],
    irrelevantLeads: [Object.assign({ id: 'synthetic-l2', name: 'SYNTHETIC CLOSED LEAD',
      created: '2026-09-05', stage: 'irrelevant', disposition: 'not_relevant' }, LEAD_MONEY)],
    removedLeads: [Object.assign({ id: 'synthetic-l3', name: 'SYNTHETIC REMOVED LEAD',
      created: '2026-09-06', stage: 'new' }, LEAD_MONEY)],
    billingOverrides: [{ id: 'FINANCE-OVERRIDE-CANARY', patientId: 'synthetic-p1', amount: MONEY.pay }],
    houseManagers: {}, currentManagers: [],
  };
}

function get(port, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname,
      headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (_) { /* exports/refusals may be text */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
  });
}

async function withSyntheticServer(fn) {
  const raw = source(), before = clone(raw), calls = [];
  const hash = await pinHash.hashPin('583920', PEPPER);
  const records = ['dana', 'vered'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, PIN_PEPPER: PEPPER,
    SHEETS_URL: 'https://script.google.com/macros/s/SYNTHETIC-EXPORT/exec',
    USER_PIN_HASHES: JSON.stringify(records), SHEETS_READ_CACHE_MS: '0' };
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const origRequest = https.request;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  let server;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  https.request = (url, opts, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => { body += chunk; };
    req.end = () => {
      const parsed = JSON.parse(body || '{}');
      calls.push(parsed);
      assert.equal(parsed.action, 'getData', 'no other upstream action is authorized by this fixture');
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { callback(res); res.emit('data', JSON.stringify(raw)); res.emit('end'); });
    };
    return req;
  };
  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    delete require.cache[SERVER_PATH];
    const mod = require('../server');
    server = await new Promise((resolve) => {
      const listening = mod.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const cookie = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET,
      undefined, undefined, id === 'dana' ? 'דנה' : 'ורד', { id, pinVersion: 1 });
    await fn({ port: server.address().port, cookie, raw, calls });
    assert.deepEqual(raw, before, 'projection and exports must not mutate source rows');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    https.request = origRequest;
    Object.assign(console, quiet);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    delete require.cache[SERVER_PATH];
  }
}

function pageFromProjection(data) {
  const pg = loadPage({});
  pg.sandbox.PatientRetention = R; pg.sandbox.LeadsFunnel = LF; pg.sandbox.ReportXlsx = X;
  const downloads = [];
  pg.sandbox.Blob = class {
    constructor(parts, options) { this.parts = parts; this.type = options && options.type; }
  };
  pg.sandbox.URL = { createObjectURL(blob) { downloads.push({ blob }); return 'blob:synthetic'; }, revokeObjectURL() {} };
  pg.sandbox.document.createElement = () => ({
    click() { downloads[downloads.length - 1].name = this.download; }, remove() {},
  });
  pg.sandbox.document.body = { appendChild() {} };
  // This is the existing getData -> page-state shape. Roles are deliberately
  // no-finance; the actual export handlers, not replacement writers, run below.
  pg.set(Object.assign({}, clone(data), { patients: Object.values(data.patients).flat(),
    mode: 'edit', finance: false, ops: true, user: 'דנה' }));
  return { pg, downloads };
}

function assertNoMoney(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of FINANCE_CANARIES) assert.ok(!text.includes(canary), 'financial canary must be absent: ' + canary);
}

async function decodedWorkbook(download) {
  assert.equal(download.blob.type, X.XLSX_MIME);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(download.blob.parts[0]));
  const values = [];
  for (const ws of wb.worksheets) {
    ws.eachRow((row) => row.eachCell((cell) => {
      assert.notEqual(cell.type, ExcelJS.ValueType.Formula, 'exports never introduce formulas');
      values.push(cell.value);
    }));
  }
  assertNoMoney(values);
  return { wb, values };
}

test('Dana export acceptance: real server strips money before real full/section/list XLSX handlers run', async () => {
  await withSyntheticServer(async ({ port, cookie, raw, calls }) => {
    const reply = await get(port, '/api/sheets?action=getData', cookie('dana'));
    assert.equal(reply.status, 200);
    const data = reply.json;
    assert.equal(data.ok, true);
    assert.equal(Object.hasOwn(data, 'billingOverrides'), false);
    const patients = [...Object.values(data.patients).flat(), ...data.dischargedPatients];
    for (const row of patients) for (const key of MONEY_KEYS) assert.equal(Object.hasOwn(row, key), false, key);
    for (const key of ['leads', 'irrelevantLeads', 'removedLeads']) {
      for (const row of data[key]) for (const field of ['pay', 'advance', 'price']) assert.equal(Object.hasOwn(row, field), false, field);
    }
    assertNoMoney(data);
    assert.equal(data.patients.ramot[0].notes, 'SYNTHETIC OPERATIONAL NOTE');
    assert.equal(data.patients.rehab[0].id, 'synthetic-p2', 'Dana keeps the decided all-house operational scope');
    assert.equal(calls[0].proxyUserId, 'dana');
    const { pg, downloads } = pageFromProjection(data);
    pg.run(`exportAllReportsXlsx('${FROM}', '${TO}')`);
    pg.sandbox.__retention = pg.run(`patientRetentionReport(state, { from: '${FROM}', to: '${TO}', threshold: '' })`);
    pg.sandbox.__funnel = pg.run(`leadsFunnelReport(state, '${FROM}', '${TO}')`);
    pg.run(`exportReportXlsx('continuity', reportXlsxContext(globalThis.__funnel, globalThis.__retention, '${FROM}', '${TO}'))`);
    pg.run(`exportListXlsx('patients', globalThis.__retention.rows.upTo30, '${FROM}', '${TO}', 'SYNTHETIC PATIENT LIST')`);
    pg.run(`exportListXlsx('leads', globalThis.__funnel.rows.visitedNotEntered, '${FROM}', '${TO}', 'SYNTHETIC LEAD LIST')`);
    assert.equal(pg.errors.length, 0);
    assert.equal(downloads.length, 4);
    const results = [];
    for (const download of downloads) results.push(await decodedWorkbook(download));
    assert.equal(results[0].wb.worksheets.length, 8);
    assert.ok(results[0].values.includes('SYNTHETIC PATIENT ONE'));
    assert.ok(results[0].values.includes('SYNTHETIC PATIENT TWO'));
    assert.ok(results[0].values.includes('SYNTHETIC LEAD ONE'));
    assert.ok(results[2].values.includes('SYNTHETIC PATIENT ONE'));
    assert.ok(results[3].values.includes('SYNTHETIC LEAD ONE'));
    // Positive control: the same upstream fixture contains real canary values;
    // a full-authority reader still gets them. Empty fixtures cannot pass this.
    const full = await get(port, '/api/sheets?action=getData', cookie('vered'));
    assert.equal(full.status, 200);
    assert.equal(full.json.patients.ramot[0].pay, raw.patients.ramot[0].pay);
    assert.equal(raw.billingOverrides[0].id, 'FINANCE-OVERRIDE-CANARY');
  });
});

test('Dana export acceptance: actual retention CSV handler is operational; direct finance exports are refused before upstream', async () => {
  await withSyntheticServer(async ({ port, cookie, calls }) => {
    const reply = await get(port, '/api/sheets?action=getData', cookie('dana'));
    assert.equal(reply.status, 200);
    const { pg, downloads } = pageFromProjection(reply.json);
    pg.sandbox.__retention = pg.run(`patientRetentionReport(state, { from: '${FROM}', to: '${TO}', threshold: '' })`);
    pg.run('exportRetentionSummaryCsv(globalThis.__retention)');
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].blob.type, R.CSV_MIME);
    const csv = downloads[0].blob.parts.join('');
    assert.ok(csv.length > 30, 'the test inspects a populated export, not an empty download');
    assertNoMoney(csv);
    const before = calls.length;
    for (const path of FINANCE_ROUTES.filter((route) => route.startsWith('/api/export/'))) {
      const refused = await get(port, path, cookie('dana'));
      assert.equal(refused.status, 403, path);
    }
    assert.equal((await get(port, '/api/export/billing-control.xlsx', cookie('dana'))).status, 403);
    assert.equal(calls.length, before, 'finance export refusal occurs before upstream data access');
    assert.equal(pg.posts.length, 0, 'exporting never submits a write');
  });
});
