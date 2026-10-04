/* Phase 0b-1 (docs/billing-control-plan.md §11.1): PROXY_SECRET in TRANSITION
 * mode. See CHANGELOG-proxy-secret-transition.md.
 *
 * Code.gs (vm sandbox, the repo convention — see meeting-report-backend.test.js):
 *   - valid secret → served; the acting user is the proxy's proxyUser
 *   - missing / wrong secret in 'log' mode → served AND recorded in SecurityLog,
 *     at most one row per action per hour
 *   - 'enforce' mode → {ok:false,error:'unauthorized'}, nothing written
 *   - a spoofed body user is ignored (and recorded, without names)
 *   - the secret never reaches a handler, a sheet, a log or a response
 *   - constant-time compare; every tryLock result is checked
 *   - securityCallersReportNow is read-only
 * server.js (real Express app on an ephemeral port, https.request stubbed):
 *   - the secret rides the POST body of EVERY Apps Script call, never the URL
 *   - it never appears in a log line, a response, an error or the debug store
 *   - fail-closed when PROXY_SECRET is unset */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const GS_SRC = fs.readFileSync(GS_PATH, 'utf8');
const SECRET = 'proxy-secret-TEST-7f3a9c1e5b2d4f6a8c0e2b4d6f8a0c2e';

/* ====================================================================== */
/* ============================== Code.gs =============================== */
/* ====================================================================== */

function fakeSheet(headerRow) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()] : [];
  const ops = [];
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() { ops.push({ op: 'freeze' }); },
    appendRow(row) { ops.push({ op: 'append' }); grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', r, c, nr, nc, fmt }); },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push({ op: 'set', r, c });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

/* Load Code.gs with the GAS globals stubbed. `opts.props` seeds Script
 * Properties; `opts.lockOk` controls tryLock; `opts.now` pins Date. handle_
 * is replaced by a spy unless `opts.realHandle` — the gate is what's tested. */
function loadGs(opts) {
  const o = opts || {};
  const logs = [];
  const capture = (...a) => logs.push(a.map(String).join(' '));
  const sandbox = {
    console: { log: capture, warn: capture, error: capture, info: capture },
    JSON, Math, Number, String, Array, Object, RegExp, isNaN, isFinite,
    Logger: { log: capture },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
    __lockCalls: 0,
    __inserted: [],
  };
  const RealDate = Date;
  let nowMs = o.now != null ? o.now : RealDate.UTC(2026, 9, 1, 9, 15, 0);
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(nowMs).toString();
    return args.length ? new RealDate(...args) : new RealDate(nowMs);
  }
  FakeDate.now = () => nowMs;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  sandbox.Date = FakeDate;
  sandbox.__setNow = (ms) => { nowMs = ms; };

  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => { sandbox.__inserted.push(name); return (sandbox.__sheets[name] = fakeSheet([])); },
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
    }),
  };
  sandbox.CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in sandbox.__cache ? sandbox.__cache[k] : null),
      put: (k, v) => { sandbox.__cache[k] = v; },
    }),
  };
  sandbox.LockService = {
    getScriptLock: () => ({
      tryLock: () => { sandbox.__lockCalls++; return o.lockOk === undefined ? true : o.lockOk; },
      releaseLock: () => {},
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s), raw: s }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);

  const calls = [];
  if (!o.realHandle) {
    sandbox.handle_ = (params) => {
      calls.push(JSON.parse(JSON.stringify(params)));
      return sandbox.jsonOut_({ ok: true, served: params.action });
    };
  }
  /* A request exactly as Apps Script hands it to doPost / doGet. */
  const post = (body, query) => sandbox.doPost({
    parameter: Object.assign({}, query || {}),
    postData: { contents: JSON.stringify(body || {}) },
  });
  const get = (query) => sandbox.doGet({ parameter: Object.assign({}, query || {}) });
  const securityRows = () => {
    const sh = sandbox.__sheets.SecurityLog;
    return sh ? sh.grid.slice(1) : [];
  };
  return { sandbox, calls, logs, post, get, securityRows };
}

/* Top-level `const`s are not sandbox properties — read them in-context. */
const gsConst = (g, name) => vm.runInContext(name, g.sandbox);

const VALID = (extra) => Object.assign({ action: 'getData', proxySecret: SECRET, proxyUser: 'ורד', user: 'ורד' }, extra || {});

/* ---------- valid secret ---------- */

test('Code.gs: a valid secret → served; the handler never sees proxySecret / proxyUser', () => {
  for (const mode of [undefined, 'log', 'enforce']) {
    const props = { PROXY_SECRET: SECRET };
    if (mode) props.PROXY_SECRET_MODE = mode;
    const g = loadGs({ props });
    const out = g.post(VALID()).json;
    assert.deepStrictEqual(out, { ok: true, served: 'getData' }, 'mode ' + mode);
    assert.strictEqual(g.calls.length, 1);
    assert.ok(!('proxySecret' in g.calls[0]) && !('proxyUser' in g.calls[0]));
    assert.strictEqual(g.calls[0].user, 'ורד');
    assert.deepStrictEqual(g.securityRows(), [], 'a valid request writes no SecurityLog row');
  }
});

test('Code.gs: a valid secret through the REAL handle_ reaches dispatch (unknown action → unknown_action, not unauthorized)', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' }, realHandle: true });
  const out = g.post(VALID({ action: 'noSuchAction' })).json;
  assert.strictEqual(out.error, 'unknown_action');
});

/* ---------- log mode ---------- */

test('Code.gs log mode (the default): missing secret → served AND logged once per action per hour', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });   // PROXY_SECRET_MODE unset → log
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(g.post({ action: 'managersOverview', month: '2026-09' }).json, { ok: true, served: 'managersOverview' });
  }
  assert.strictEqual(g.calls.length, 5, 'every request is still served in log mode');
  const rows = g.securityRows();
  assert.strictEqual(rows.length, 1, 'five calls in one hour → one row');
  const [ts, action, method, present, type, hourKey] = rows[0];
  assert.strictEqual(action, 'managersOverview');
  assert.strictEqual(method, 'POST');
  assert.strictEqual(present, 'no');
  assert.strictEqual(type, 'no_secret');
  assert.strictEqual(hourKey, '2026-10-01T09');
  assert.strictEqual(ts, '2026-10-01T09:15:00.000Z');
  assert.deepStrictEqual(g.sandbox.__sheets.SecurityLog.grid[0],
    ['timestamp', 'action', 'method', 'secretPresent', 'callerType', 'hourKey', 'callerClass']);
  // Phase 0b-2: the appended callerClass column; managersOverview is an
  // OPEN_ACTIONS action.
  assert.strictEqual(rows[0][6], 'open');
});

test('Code.gs log mode: a wrong secret → served, logged as bad_secret with secretPresent=yes', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'log' } });
  const out = g.post({ action: 'getPayments', proxySecret: SECRET.slice(0, -1) + 'X' }).json;
  assert.strictEqual(out.ok, true);
  assert.strictEqual(g.calls.length, 1);
  assert.ok(!('proxySecret' in g.calls[0]), 'a wrong secret is stripped too');
  const rows = g.securityRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][3], 'yes');
  assert.strictEqual(rows[0][4], 'bad_secret');
});

test('Code.gs log mode: one row per action per hour — other actions and the next hour get their own row', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.get({ action: 'managersHouse', house: 'ramot' });
  g.post({ action: 'managersHouse', proxySecret: 'wrong' });     // same action, same hour → no row
  g.get({ action: 'occupancySnapshots' });                        // another action → a row
  assert.strictEqual(g.securityRows().length, 2);
  assert.strictEqual(g.securityRows()[0][2], 'GET');
  g.sandbox.__setNow(Date.UTC(2026, 9, 1, 10, 1, 0));             // next hour
  g.get({ action: 'managersHouse' });
  const rows = g.securityRows();
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2][5], '2026-10-01T10');
});

test('Code.gs log mode: the hourly dedupe holds even when the cache is evicted (sheet re-check under the lock)', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.post({ action: 'getData' });
  g.sandbox.__cache = {};                                          // CacheService evicted
  g.post({ action: 'getData' });
  assert.strictEqual(g.securityRows().length, 1);
});

test('Code.gs log mode: PROXY_SECRET unset → nothing can be valid; a presented secret is still served + logged', () => {
  const g = loadGs({ props: {} });
  assert.strictEqual(g.post(VALID()).json.ok, true);
  assert.strictEqual(g.securityRows().length, 1);
  assert.strictEqual(g.securityRows()[0][4], 'bad_secret');
});

test('Code.gs: a secret in the QUERYSTRING is ignored (body only) — counted as missing', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const out = g.get({ action: 'getData', proxySecret: SECRET, proxyUser: 'ורד' }).json;
  assert.deepStrictEqual(out, { ok: false, error: 'unauthorized' });
  assert.strictEqual(g.calls.length, 0);
});

test('Code.gs: an unknown action name is logged as "(unknown)" — the caller cannot write arbitrary text', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.post({ action: '=HYPERLINK("http://evil")' });
  g.post({ action: 'another-made-up-name' });
  g.post({});
  const rows = g.securityRows();
  assert.deepStrictEqual(rows.map((r) => r[1]), ['(unknown)', '(none)']);
});

test('Code.gs log mode: a busy lock skips the log row cleanly and still serves the request', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET }, lockOk: false });
  assert.strictEqual(g.post({ action: 'getData' }).json.ok, true);
  assert.deepStrictEqual(g.securityRows(), []);
  assert.deepStrictEqual(g.sandbox.__inserted, []);
});

/* ---------- enforce mode ---------- */

test('Code.gs enforce mode: missing or wrong secret → unauthorized, handler never runs, NOTHING written', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const reqs = [
    { action: 'savePayment', payment: { id: 'p1' }, user: 'סנדרה' },
    { action: 'savePayment', proxySecret: 'nope', user: 'סנדרה' },
    { action: 'savePayment', proxySecret: SECRET + 'x' },
    { action: 'savePayment', proxySecret: '' },
    { action: 'getData', proxySecret: 12345 },
  ];
  for (const r of reqs) {
    assert.deepStrictEqual(g.post(r).json, { ok: false, error: 'unauthorized' });
  }
  assert.deepStrictEqual(g.get({ action: 'getData' }).json, { ok: false, error: 'unauthorized' });
  assert.strictEqual(g.calls.length, 0);
  assert.deepStrictEqual(Object.keys(g.sandbox.__sheets), [], 'no sheet touched');
  assert.deepStrictEqual(g.sandbox.__inserted, []);
  assert.strictEqual(g.sandbox.__lockCalls, 0);
});

test('Code.gs enforce mode with PROXY_SECRET unset refuses everything (fail-closed)', () => {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce' } });
  assert.deepStrictEqual(g.post(VALID()).json, { ok: false, error: 'unauthorized' });
  assert.strictEqual(g.calls.length, 0);
});

test('Code.gs: an unrecognised PROXY_SECRET_MODE value fails CLOSED (treated as enforce)', () => {
  for (const mode of ['enforced', 'ENFORCE', 'off', 'true']) {
    const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: mode } });
    assert.deepStrictEqual(g.post({ action: 'getData' }).json, { ok: false, error: 'unauthorized' }, mode);
  }
  const lg = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: ' Log ' } });
  assert.strictEqual(lg.post({ action: 'getData' }).json.ok, true, "' Log ' normalises to log");
});

test('Code.gs enforce mode (Phase 0b-2): only OPEN_ACTIONS bypass PROXY_SECRET; the other own-secret actions are now gated too', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  // getAdmittedRoster is open: served without PROXY_SECRET (its own secret
  // is still checked in handle_).
  assert.strictEqual(g.post({ action: 'getAdmittedRoster', secret: 'own-secret' }).json.served, 'getAdmittedRoster');
  // meeting-report + accounting are no longer exempt: without PROXY_SECRET
  // they are refused in enforce mode and nothing is written …
  for (const action of ['meetingReportLeads', 'submitMeetingReport', 'accountingPayments', 'accountingCredits']) {
    assert.deepStrictEqual(g.post({ action, secret: 'own-secret' }).json, { ok: false, error: 'unauthorized' }, action);
  }
  assert.deepStrictEqual(g.securityRows().map((r) => [r[1], r[6]]), [['getAdmittedRoster', 'open']],
    'only the served open request is logged; refused ones write nothing');
  // … and WITH PROXY_SECRET (what Dashboard server.js sends on every call,
  // meeting-report included) they are served.
  for (const action of ['meetingReportLeads', 'submitMeetingReport', 'accountingPayments', 'accountingCredits']) {
    assert.strictEqual(g.post({ action, secret: 'own-secret', proxySecret: SECRET }).json.served, action);
  }
  // Their own fail-closed check still runs in the REAL handle_.
  const real = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' }, realHandle: true });
  assert.deepStrictEqual(real.post({ action: 'accountingPayments', secret: 'x', proxySecret: SECRET }).json, { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(real.post({ action: 'getAdmittedRoster', secret: 'x' }).json, { ok: false, error: 'unauthorized' });
});

/* ---------- acting user ---------- */

test('Code.gs: with a valid secret a spoofed body user is IGNORED — the proxy user wins — and logged without names', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.post({ action: 'savePayment', proxySecret: SECRET, proxyUser: 'ורד', user: 'סנדרה' });
  assert.strictEqual(g.calls[0].user, 'ורד');
  const rows = g.securityRows();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(Array.from(rows[0].slice(1, 5)), ['savePayment', 'POST', 'yes', 'user_mismatch']);
  const flat = JSON.stringify(g.sandbox.__sheets.SecurityLog.grid);
  assert.ok(!flat.includes('סנדרה') && !flat.includes('ורד'), 'no user name is written to SecurityLog');
});

test('Code.gs: with a valid secret and NO proxyUser the user is blank — never the body value', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.post({ action: 'saveAll', proxySecret: SECRET, user: 'סנדרה' });
  assert.strictEqual(g.calls[0].user, '');
});

test('Code.gs: a matching body user is not a mismatch (no row)', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET } });
  g.post(VALID());
  g.post(VALID({ user: '' }));
  assert.deepStrictEqual(g.securityRows(), []);
});

test('Code.gs: the stamped user flows into a REAL write (saveCredit stamps the proxy user, not the body user)', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET }, realHandle: true });
  let seen = null;
  g.sandbox.upsertCredit_ = (_c, user) => { seen = user; return { ok: true }; };
  g.post({ action: 'saveCredit', credit: {}, proxySecret: SECRET, proxyUser: 'יעל', user: 'סנדרה' });
  assert.strictEqual(seen, 'יעל');
});

/* ---------- the secret never leaks ---------- */

test('Code.gs: the secret never appears in a handler param, sheet, log line or response', () => {
  const g = loadGs({ props: { PROXY_SECRET: SECRET }, realHandle: true });
  const outputs = [];
  outputs.push(g.post(VALID({ action: 'noSuchAction' })).raw);
  outputs.push(g.post({ action: 'getData', proxySecret: SECRET + 'tail', proxyUser: 'x' }).raw);
  outputs.push(g.post({ action: 'saveCredit', credit: '{bad json', proxySecret: SECRET }).raw);
  // A handler that throws: its message is echoed by handle_'s catch — the
  // params it saw no longer carry the secret, so neither can the message.
  g.sandbox.upsertCredit_ = (c, u) => { throw new Error('boom ' + JSON.stringify(c) + ' ' + u); };
  outputs.push(g.post({ action: 'saveCredit', credit: { a: 1 }, proxySecret: SECRET, proxyUser: 'ורד' }).raw);
  const sp = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  outputs.push(sp.post({ action: 'getData', proxySecret: SECRET.slice(0, 10) }).raw);
  sp.post(VALID());
  const everything = outputs.join('\n') + JSON.stringify(g.sandbox.__sheets.SecurityLog || {}) +
    JSON.stringify(sp.calls) + g.logs.join('\n') + sp.logs.join('\n') + JSON.stringify(g.sandbox.__cache);
  assert.ok(!everything.includes(SECRET), 'secret leaked');
  assert.ok(!everything.includes(SECRET.slice(0, 10)), 'secret prefix leaked');
});

/* ---------- constant-time compare ---------- */

test('Code.gs constantTimeEquals_: correct results', () => {
  const g = loadGs({});
  const eq = g.sandbox.constantTimeEquals_;
  assert.strictEqual(eq(SECRET, SECRET), true);
  assert.strictEqual(eq('', ''), true);
  assert.strictEqual(eq(SECRET, SECRET + 'a'), false);
  assert.strictEqual(eq(SECRET + 'a', SECRET), false);
  assert.strictEqual(eq(SECRET, SECRET.slice(0, -1)), false);
  assert.strictEqual(eq('abc', 'abd'), false);
  assert.strictEqual(eq('a\u0000', 'a'), false, 'a NUL pad is not equality');
  assert.strictEqual(eq('אבג', 'אבג'), true);
});

test('Code.gs constantTimeEquals_: the work done is independent of where the strings differ', () => {
  const g = loadGs({});
  const proto = vm.runInContext("''.constructor.prototype", g.sandbox);
  const original = proto.charCodeAt;
  let count = 0;
  proto.charCodeAt = function (i) { count++; return original.call(this, i); };
  const work = (a, b) => { count = 0; g.sandbox.constantTimeEquals_(a, b); return count; };
  try {
    const n = SECRET.length;
    const first = 'X' + SECRET.slice(1);
    const last = SECRET.slice(0, -1) + 'X';
    const counts = [work(SECRET, first), work(SECRET, last), work(SECRET, SECRET), work(SECRET, 'Y'.repeat(n))];
    assert.ok(counts.every((c) => c === 2 * n), 'always 2 × length char reads: ' + counts);
    assert.strictEqual(work(SECRET, 'a'), n + 1, 'a short guess still walks the full length');
  } finally {
    proto.charCodeAt = original;
  }
  const src = gsFunction('constantTimeEquals_');
  const loop = src.slice(src.indexOf('for ('), src.lastIndexOf('return'));
  assert.ok(!/return|break/.test(loop), 'no early exit inside the loop');
  // Phase 0b-2: the gate compares through callerClass_, and EVERY secret
  // check in Code.gs (proxy, roster, meeting report, accounting) is
  // constant-time — no plain === / !== between a presented and an expected
  // secret anywhere in the file.
  assert.ok(/proxyGate_[\s\S]*callerClass_\(action, presented, expected\)/.test(GS_SRC));
  assert.ok(/function callerClass_[\s\S]*constantTimeEquals_\(got, want\)/.test(GS_SRC));
  assert.ok(!/\b(presented|got|want|expected)\s*[!=]==\s*(presented|got|want|expected)\b/.test(GS_SRC),
    'no plain === compare of a secret anywhere in Code.gs');
  for (const fn of ['admittedRosterAuthOk_', 'meetingReportAuthOk_', 'accountingAuthOk_']) {
    assert.ok(/return constantTimeEquals_\(got, expected\);/.test(gsFunction(fn)), fn + ' compares in constant time');
    assert.ok(/if \(!expected\) return false;/.test(gsFunction(fn)), fn + ' still fails closed when unset');
  }
});

/* ---------- tryLock is always checked ---------- */

function gsFunction(name) {
  const start = GS_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  const next = GS_SRC.indexOf('\nfunction ', start + 1);
  return GS_SRC.slice(start, next < 0 ? GS_SRC.length : next);
}

test('Code.gs: EVERY tryLock result is checked (strict !== true), none is a bare statement', () => {
  const lines = GS_SRC.split('\n').filter((l) => l.includes('tryLock('));
  assert.ok(lines.length >= 22);
  for (const l of lines) {
    assert.match(l, /if \(lock\.tryLock\(\d+\) !== true\) (return|throw)/, 'unchecked: ' + l.trim());
  }
});

test('Code.gs: a busy lock fails cleanly — writers return lock_busy and write nothing', () => {
  const g = loadGs({ lockOk: false, realHandle: true });
  const out = g.sandbox.deleteBillingOverride_({ id: 'x' });
  assert.deepStrictEqual({ ...out }, { ok: false, error: 'lock_busy', message: gsConst(g, 'LOCK_BUSY_MESSAGE') });
  const viaHandle = g.sandbox.handle_({ action: 'upsertBillingOverride', override: { patientId: 'p', month: '2026-09', amount: 1, reason: 'r' } }).json;
  assert.strictEqual(viaHandle.ok, false);
  assert.deepStrictEqual(g.sandbox.__inserted.filter((n) => n !== 'BillingOverrides'), []);
  assert.throws(() => g.sandbox.writeDigestRows_('id', []), /could not acquire the script lock/);
});

/* ---------- registry + report ---------- */

test('Code.gs: PROXY_KNOWN_ACTIONS lists every action handle_ dispatches; OPEN_ACTIONS are a subset', () => {
  const h = gsFunction('handle_');
  const dispatched = new Set([...h.matchAll(/action === '([A-Za-z]+)'/g)].map((m) => m[1]));
  const g = loadGs({});
  const known = new Set(Array.from(gsConst(g, 'PROXY_KNOWN_ACTIONS')));
  assert.deepStrictEqual([...dispatched].sort(), [...known].sort());
  for (const a of Array.from(gsConst(g, 'OPEN_ACTIONS'))) assert.ok(known.has(a), a);
});

test('Code.gs securityCallersReportNow: last-7-days summary by action × callerClass, READ-ONLY', () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const g = loadGs({ now });
  const sh = fakeSheet(['timestamp', 'action', 'method', 'secretPresent', 'callerType', 'hourKey']);
  sh.grid.push(['2026-09-20T10:00:00.000Z', 'managersOverview', 'GET', 'no', 'no_secret', '2026-09-20T10']); // too old
  sh.grid.push(['2026-10-02T08:00:00.000Z', 'managersOverview', 'GET', 'no', 'no_secret', '2026-10-02T08']);
  sh.grid.push(['2026-10-03T09:00:00.000Z', 'managersOverview', 'POST', 'no', 'no_secret', '2026-10-03T09']);
  sh.grid.push([new Date('2026-10-07T07:00:00.000Z'), 'managersHouse', 'GET', 'no', 'no_secret', '2026-10-07T07']);
  sh.grid.push(['2026-10-07T07:30:00.000Z', 'savePayment', 'POST', 'yes', 'user_mismatch', '2026-10-07T07']);
  g.sandbox.__sheets.SecurityLog = sh;
  const before = JSON.stringify(sh.grid);
  const r = g.sandbox.securityCallersReportNow();
  assert.strictEqual(r.rows, 4);
  // Phase 0b-2: grouped by action × callerClass. These pre-0b-2 rows have no
  // callerClass; it is derived (managers* are OPEN_ACTIONS → open,
  // user_mismatch → proxy).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.summary)), [
    { action: 'managersOverview', callerClass: 'open', hours: 2, userMismatchHours: 0, methods: 'GET+POST', firstSeen: '2026-10-02T08:00:00.000Z', lastSeen: '2026-10-03T09:00:00.000Z' },
    { action: 'managersHouse', callerClass: 'open', hours: 1, userMismatchHours: 0, methods: 'GET', firstSeen: '2026-10-07T07:00:00.000Z', lastSeen: '2026-10-07T07:00:00.000Z' },
    { action: 'savePayment', callerClass: 'proxy', hours: 1, userMismatchHours: 1, methods: 'POST', firstSeen: '2026-10-07T07:30:00.000Z', lastSeen: '2026-10-07T07:30:00.000Z' },
  ]);
  assert.strictEqual(r.nonOpenWithoutSecret, 0, 'open + proxy traffic only → safe to enforce');
  assert.strictEqual(JSON.stringify(sh.grid), before, 'no cell changed');
  assert.deepStrictEqual(sh.ops, [], 'no write / format op');
  assert.strictEqual(g.sandbox.__lockCalls, 0, 'no lock');
  assert.deepStrictEqual(g.sandbox.__inserted, [], 'no tab created');
  const src = gsFunction('securityCallersReportNow');
  for (const w of ['appendRow', 'setValue', 'insertSheet', 'getOrCreateSheet_', 'setProperty', 'tryLock', 'deleteRow', 'clear']) {
    assert.ok(!src.includes(w), 'report must not use ' + w);
  }
});

test('Code.gs securityCallersReportNow: no SecurityLog tab → empty report, and the tab is NOT created', () => {
  const g = loadGs({});
  const r = g.sandbox.securityCallersReportNow();
  assert.strictEqual(r.rows, 0);
  assert.deepStrictEqual(g.sandbox.__inserted, []);
});

/* ====================================================================== */
/* ============================== server.js ============================= */
/* ====================================================================== */

const SESSION_SECRET = 'test-session-secret-proxy-0123456789abcdef';
const SHEETS_URL = 'https://script.example.test/macros/s/AKfyTEST/exec';
const SERVER_PATH = require.resolve('../server');

function freshServer(env) {
  const saved = {};
  // PR C: every session is personal, so every fresh server here gets real
  // USER_PIN_HASHES records (test/helpers/personal-session.js).
  const e = Object.assign(require('./helpers/personal-session').applyPersonalEnv({}), env);
  for (const k of ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER']) {
    saved[k] = process.env[k];
    if (e[k] === undefined) delete process.env[k]; else process.env[k] = e[k];
  }
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    console.error = origErr;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { mod, startupErrors: errors };
}

/* Stub https.request: record every outbound call, answer with `respond`. */
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

/* Capture every console line while fn runs. */
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

function request(port, method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sessionCookie(user) {
  const ids = { 'ורד': 'vered', 'סנדרה': 'sandra', 'שירן': 'shiran', 'יעל': 'yael' };
  return require('./helpers/personal-session').personalCookie(SESSION_SECRET, ids[user]);
}

test('server.js buildAppsScriptBody: proxy fields go LAST, so a client can never override them', () => {
  const { mod } = freshServer({ PROXY_SECRET: SECRET, SESSION_SECRET, SHEETS_URL });
  const b = mod.buildAppsScriptBody({ action: 'x', proxySecret: 'evil', proxyUser: 'סנדרה', user: 'סנדרה' }, 'ורד', SECRET);
  assert.deepStrictEqual(b, { action: 'x', proxySecret: SECRET, proxyUser: 'ורד', user: 'ורד' });
  assert.deepStrictEqual(mod.readParamsToBody({ a: '1', b: ['x', 'y'], c: null, d: { e: 1 } }),
    { a: '1', b: '["x","y"]', d: '{"e":1}' });
});

test('server.js: EVERY Apps Script call carries the secret in the POST body — never in the URL', async () => {
  const { mod } = freshServer({ PROXY_SECRET: SECRET, SESSION_SECRET, SHEETS_URL });
  const stub = stubHttps(() => ({ body: { ok: true, leads: [], patients: {} } }));
  const srv = await listen(mod.app);
  const port = srv.address().port;
  let lines;
  try {
    lines = await captureConsole(async () => {
      const cookie = sessionCookie('ורד');
      const g = await request(port, 'GET', '/api/sheets?action=getData&proxySecret=evil&proxyUser=%D7%A1&user=%D7%A1', { cookie });
      assert.strictEqual(g.status, 200);
      const p = await request(port, 'POST', '/api/sheets', {
        cookie, body: { action: 'savePayment', payment: { id: 'p1' }, user: 'סנדרה', proxySecret: 'evil', proxyUser: 'סנדרה' },
      });
      assert.strictEqual(p.status, 200);
      await request(port, 'GET', '/api/debug/last-save', { cookie });
    });
  } finally {
    srv.close();
    stub.restore();
  }
  assert.strictEqual(stub.calls.length, 2);
  for (const c of stub.calls) {
    assert.strictEqual(c.method, 'POST', 'reads go as POST so the secret can ride the body');
    assert.strictEqual(c.url, SHEETS_URL, 'URL carries no querystring at all');
    assert.ok(!c.url.includes(SECRET));
    const body = JSON.parse(c.body);
    assert.strictEqual(body.proxySecret, SECRET);
    assert.strictEqual(body.proxyUser, 'ורד', 'the acting user comes from the session cookie');
    assert.strictEqual(body.user, 'ורד', 'a client body/query user is overwritten');
  }
  assert.strictEqual(JSON.parse(stub.calls[0].body).action, 'getData');
  assert.strictEqual(JSON.parse(stub.calls[1].body).action, 'savePayment');
  assert.ok(!lines.join('\n').includes(SECRET), 'secret in a log line');
});

test('server.js: the secret never reaches a log line, a response, an error or the debug store — even when Apps Script echoes it', async () => {
  const { mod } = freshServer({ PROXY_SECRET: SECRET, SESSION_SECRET, SHEETS_URL });
  let mode = 'http500';
  const stub = stubHttps(() => {
    if (mode === 'http500') return { status: 500, body: 'Server error near ' + SECRET };
    if (mode === 'nonjson') return { status: 200, body: '<html>' + SECRET + '</html>' };
    return { body: { ok: false, error: 'exception', message: 'echo ' + SECRET } };
  });
  const srv = await listen(mod.app);
  const port = srv.address().port;
  const responses = [];
  let lines;
  try {
    lines = await captureConsole(async () => {
      const cookie = sessionCookie('ורד');
      for (const m of ['http500', 'nonjson', 'echo']) {
        mode = m;
        responses.push((await request(port, 'GET', '/api/sheets?action=getData', { cookie })).text);
        responses.push((await request(port, 'POST', '/api/sheets', { cookie, body: { action: 'saveAll', leads: [] } })).text);
      }
      responses.push((await request(port, 'GET', '/api/debug/last-save', { cookie })).text);
      responses.push((await request(port, 'GET', '/api/debug/last-load', { cookie })).text);
    });
  } finally {
    srv.close();
    stub.restore();
  }
  const all = responses.join('\n') + '\n' + lines.join('\n');
  assert.ok(!all.includes(SECRET), 'secret leaked:\n' + all.split('\n').filter((l) => l.includes(SECRET)).join('\n'));
  assert.ok(all.includes('[REDACTED]'), 'the echoed secret was redacted, not just absent');
  assert.strictEqual(mod.safeErrorMessage(new Error('x ' + SECRET + ' y')), 'x [REDACTED] y');
});

test('server.js: request bodies and responses are not dumped to the log', async () => {
  const { mod } = freshServer({ PROXY_SECRET: SECRET, SESSION_SECRET, SHEETS_URL });
  const stub = stubHttps(() => ({ body: { ok: true, payments: [{ payerName: 'RESPONSE-PII' }] } }));
  const srv = await listen(mod.app);
  const port = srv.address().port;
  let lines;
  try {
    lines = await captureConsole(async () => {
      const cookie = sessionCookie('ורד');
      await request(port, 'POST', '/api/sheets', { cookie, body: { action: 'savePayment', payment: { receipt: 'BODY-RECEIPT-DATA' } } });
      await request(port, 'GET', '/api/sheets?action=getPayments&q=QUERY-VALUE', { cookie });
    });
  } finally {
    srv.close();
    stub.restore();
  }
  const log = lines.join('\n');
  for (const needle of ['BODY-RECEIPT-DATA', 'RESPONSE-PII', 'QUERY-VALUE']) {
    assert.ok(!log.includes(needle), needle + ' was logged');
  }
});

test('server.js FAILS CLOSED without PROXY_SECRET: clear startup error, 503, and no outbound request', async () => {
  const { mod, startupErrors } = freshServer({ PROXY_SECRET: undefined, SESSION_SECRET, SHEETS_URL });
  assert.ok(startupErrors.some((l) => /PROXY_SECRET is not set/.test(l) && /REFUSES to proxy/.test(l)), startupErrors.join('\n'));
  const stub = stubHttps(() => ({ body: { ok: true } }));
  const srv = await listen(mod.app);
  const port = srv.address().port;
  try {
    const cookie = sessionCookie('ורד');
    const g = await request(port, 'GET', '/api/sheets?action=getData', { cookie });
    const p = await request(port, 'POST', '/api/sheets', { cookie, body: { action: 'saveAll' } });
    for (const r of [g, p]) {
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.error, 'proxy_not_configured');
    }
    await assert.rejects(mod.sheetsPost({ action: 'getData' }), /proxy_not_configured/);
    await assert.rejects(mod.sheetsGet({ action: 'getData' }, ''), /proxy_not_configured/);
    assert.strictEqual(stub.calls.length, 0, 'nothing left the server');
  } finally {
    srv.close();
    stub.restore();
    delete require.cache[SERVER_PATH];
  }
});

test('server.js: the secret is NOT sent to the Outpatient backend (a different app)', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const fn = src.slice(src.indexOf('function outpatientPost('), src.indexOf('function followingRequest('));
  assert.ok(!fn.includes('PROXY_SECRET') && !fn.includes('buildAppsScriptBody'));
  // and sheetsPost is the only builder call site
  assert.strictEqual((src.match(/buildAppsScriptBody\(b, /g) || []).length, 1);
});
