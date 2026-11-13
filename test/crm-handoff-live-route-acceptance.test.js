'use strict';

// Dashboard -> OUT authoritative handoff status: real Express route and signed
// synthetic sessions; BOTH remote Apps Script calls intercepted on loopback.
// No production patient, financial, task, or application state is accessed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

const SERVER = require.resolve('../server');
const SESSION_SECRET = 'synthetic-session-456789012345678901234567890';
const PROXY_SECRET = 'synthetic-proxy-456789012345678901234567890';
const HANDOFF_SECRET = 'synthetic-handoff-456789012345678901234567890';
const PEPPER = 'synthetic-pepper-456789012345678901234567890';
const ENV = [
  'SESSION_SECRET', 'PROXY_SECRET', 'HANDOFF_STATUS_SECRET',
  'OUTPATIENT_LEAD_URL', 'OUTPATIENT_LEAD_SECRET', 'SHEETS_URL',
  'USER_PIN_HASHES', 'PIN_PEPPER', 'SHEETS_READ_CACHE_MS',
  'APP_PIN', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN',
];

function get(port, route, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port, path: route,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* requireSession may answer plain text */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
  });
}

async function withServer(run) {
  const hash = await pinHash.hashPin('534278', PEPPER);
  const usersData = ['vered', 'ortal'].map(id => JSON.parse(users.recordLine(id, hash, 1)));
  const variables = {
    SESSION_SECRET, PROXY_SECRET, HANDOFF_STATUS_SECRET: HANDOFF_SECRET,
    OUTPATIENT_LEAD_URL: 'https://out-synthetic.invalid/exec',
    OUTPATIENT_LEAD_SECRET: 'synthetic-create-secret',
    SHEETS_URL: 'https://dash-synthetic.invalid/exec',
    PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(usersData),
    SHEETS_READ_CACHE_MS: '0',
  };
  const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  const priorRequest = https.request;
  const events = [];
  const fixtures = {
    link: { ok: true, linked: true, outpatientId: 'lead-syn-a' },
    status: { ok: true, sourceApp: 'ezone-outpatient', results: [
      { outpatientId: 'lead-syn-a', entity: 'lead', state: 'contacted',
        stateDate: '2026-11-13', assignedTo: 'OUT receptionist',
        nextAction: 'Call back', nextActionDate: '2026-11-14',
        amount: 99000, phone: '0500000000' },
    ] },
  };
  let server;
  https.request = (url, opts, callback) => {
    const req = new EventEmitter();
    let data = '';
    req.write = chunk => { data += chunk; };
    req.end = () => {
      const input = JSON.parse(data || '{}');
      const isDash = String(url).includes('dash-synthetic.invalid');
      const action = input.action;
      events.push({ isDash, action, payload: input });
      const output = isDash ? fixtures.link : fixtures.status;
      if (isDash) assert.equal(action, 'getOutpatientHandoffRef');
      else {
        assert.equal(action, 'getHandoffStatus');
        assert.equal(input.secret, HANDOFF_SECRET);
        assert.deepEqual(input.outpatientIds, [fixtures.link.outpatientId]);
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.setEncoding = () => {};
      res.resume = () => {};
      setImmediate(() => {
        callback(res);
        res.emit('data', JSON.stringify(output));
        res.emit('end');
      });
    };
    return req;
  };
  try {
    for (const key of ENV) {
      if (variables[key] === undefined) delete process.env[key];
      else process.env[key] = variables[key];
    }
    delete require.cache[SERVER];
    const { app } = require('../server');
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const cookie = id => 'ezone_session=' + createSessionToken(
      SESSION_SECRET, undefined, undefined,
      id === 'vered' ? 'ורד' : 'אורטל', { id, pinVersion: 1 },
    );
    await run({ port: server.address().port, cookie, fixtures, events });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    https.request = priorRequest;
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[SERVER];
  }
}

test('handoff status: signed Vered resolves an exact Dashboard source id before OUT; read only and price free', async () => {
  await withServer(async ({ port, cookie, events, fixtures }) => {
    const route = '/api/outpatient-handoff-status?dischargeId=discharge-syn-a';
    const unauthorized = await get(port, route);
    assert.equal(unauthorized.status, 401);
    assert.equal(events.length, 0, 'unauthorized requests never reach either source');

    const controller = await get(port, route, cookie('ortal'));
    assert.equal(controller.status, 403);
    assert.equal(events.length, 0, 'Ortal controller cannot inspect this operational route');

    const noSource = await get(port, '/api/outpatient-handoff-status?outpatientId=lead-syn-a', cookie('vered'));
    assert.equal(noSource.status, 400, 'browser-supplied OUT ids never bypass source identity resolution');
    const both = await get(port, route + '&leadId=lead-syn-a', cookie('vered'));
    assert.equal(both.status, 400, 'only one exact source identifier can be resolved');
    const fuzzy = await get(port, '/api/outpatient-handoff-status?leadId=shared%20phone', cookie('vered'));
    assert.equal(fuzzy.status, 400, 'phone/name-like identifiers are forbidden');

    const ok = await get(port, route, cookie('vered'));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.verified, true);
    assert.equal(ok.json.state, 'contacted');
    assert.equal(ok.json.nextAction, 'Call back');
    for (const key of ['amount', 'phone', 'secret', 'outpatientId']) {
      assert.equal(Object.hasOwn(ok.json, key), false, key + ' must not escape the projection');
    }
    assert.deepEqual(events.map(x => x.action), ['getOutpatientHandoffRef', 'getHandoffStatus']);
    assert.equal(events[0].payload.dischargeId, 'discharge-syn-a');
    assert.equal(events[0].payload.proxyUserId, 'vered');

    // A completed OUT lead may become a client with a NEW id. The exact
    // source-resolved lead query still returns one legitimate client record.
    fixtures.link = { ok: true, linked: true, outpatientId: 'lead-syn-b' };
    fixtures.status = { ok: true, sourceApp: 'ezone-outpatient', results: [
      { outpatientId: 'client-syn-b', entity: 'client', state: 'active', stateDate: '2026-11-13' },
    ] };
    const promoted = await get(port, '/api/outpatient-handoff-status?leadId=lead-syn-b', cookie('vered'));
    assert.equal(promoted.status, 200, promoted.raw);
    assert.equal(promoted.json.verified, true);
    assert.equal(promoted.json.state, 'active');
  });
});

test('handoff status: missing source acknowledgment, unavailable OUT and forged states stay UNKNOWN', async () => {
  await withServer(async ({ port, cookie, fixtures, events }) => {
    const route = '/api/outpatient-handoff-status?leadId=lead-syn-c';
    fixtures.link = { ok: true, linked: false, reason: 'not_sent' };
    const unknown = await get(port, route, cookie('vered'));
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.verified, false);
    assert.equal(events.filter(x => !x.isDash).length, 0, 'unverified sends cannot query OUT');

    fixtures.link = { ok: true, linked: true, outpatientId: 'lead-syn-c' };
    fixtures.status = { ok: false, error: 'unavailable' };
    const unavailable = await get(port, route, cookie('vered'));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.verified, false);

    fixtures.status = { ok: true, sourceApp: 'ezone-outpatient', results: [
      { outpatientId: 'lead-syn-c', entity: 'lead', state: 'not_a_real_state' },
    ] };
    const forged = await get(port, route, cookie('vered'));
    assert.equal(forged.status, 503);
    assert.equal(forged.json.verified, false);

    fixtures.status = { ok: true, sourceApp: 'ezone-outpatient', results: [
      { outpatientId: 'lead-syn-c', entity: 'lead', state: 'contacted', stateDate: '2026-11-13' },
    ] };
    const recovered = await get(port, route, cookie('vered'));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.verified, true);
    assert.equal(recovered.json.state, 'contacted', 'failures must not be cached as no contact');
    const crm = fs.readFileSync(path.join(__dirname, '..', 'public/crm/crm.js'), 'utf8');
    assert.match(crm, /הסטטוס לא אומת — בדקי ישירות באמבולטורי/);
    assert.match(crm, /המעקב נשאר פתוח/);
  });
});
