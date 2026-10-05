/* Phase 0b-2: the open-actions allowlist + caller classes (LOG mode).
 * See CHANGELOG-open-actions-gate.md.
 *
 *   - OPEN_ACTIONS is pinned to exactly the four actions Managers and
 *     Therapists call, plus (2026-10-04) the two coordinators-roster actions
 *     that carry their own fail-closed secret; they are served WITHOUT
 *     PROXY_SECRET in log AND enforce mode, so no consumer needs any change
 *   - every other action — getData, every write, GET or POST — is gated by
 *     PROXY_SECRET: logged in log mode, refused (nothing written) in enforce
 *   - classes proxy | open | none | wrong land in SecurityLog.callerClass
 *   - securityCallersReportNow prints "non-open actions without a valid
 *     secret: N" (must be 0 before Phase 0b-3)
 *   - no secret value in any log line, SecurityLog row, cache key or response
 *   - getData keeps every key
 *
 * vm sandbox on the real Code.gs, per the repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const arr = (x) => JSON.parse(JSON.stringify(x));

const PROXY = 'proxy-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ROSTER = 'roster-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/* What the consumers' deployed code calls on this backend (2026-10-01):
 *   ezone-managers @ main (b779e22): public/app.js → server.js GET /api/sheets
 *   ezone-therapists @ claude/inspiring-tesla-jipobw (95195e3): server.js:1438
 *   ezone-coordinators (2026-10-04): getPatientsForCoordinators,
 *     recordDischargeFromCoordinators — own COORDINATORS_PATIENTS_SECRET */
const EXPECTED_OPEN = ['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster',
  'getPatientsForCoordinators', 'recordDischargeFromCoordinators'];
/* A sample of gated actions: the bulk read and representative writes. */
const GATED_SAMPLE = ['getData', 'saveAll', 'savePayment'];

function fakeSheet(headerRow) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()] : [];
  const ops = [];
  return {
    grid, ops,
    getName: () => 'x',
    getLastRow() { return grid.length; },
    getLastColumn() { return grid.reduce((n, r) => Math.max(n, r.length), 0); },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { ops.push('append'); grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { ops.push('setValue'); if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push('setValues');
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

function loadGs(opts) {
  const o = opts || {};
  const logs = [];
  const capture = (...a) => logs.push(a.map(String).join(' '));
  const sandbox = {
    console: { log: capture, warn: capture, error: capture, info: capture },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isNaN, isFinite,
    Logger: { log: capture },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
    __inserted: [],
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      getSheets: () => Object.values(sandbox.__sheets),
      insertSheet: (n) => { sandbox.__inserted.push(n); return (sandbox.__sheets[n] = fakeSheet([])); },
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null) }),
  };
  sandbox.CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in sandbox.__cache ? sandbox.__cache[k] : null),
      put: (k, v) => { sandbox.__cache[k] = v; },
    }),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
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
  const served = [];
  if (!o.realHandle) {
    sandbox.handle_ = (params) => { served.push(params.action); return sandbox.jsonOut_({ ok: true, served: params.action }); };
  }
  const post = (body, query) => sandbox.doPost({ parameter: Object.assign({}, query || {}), postData: { contents: JSON.stringify(body) } });
  const get = (query) => sandbox.doGet({ parameter: Object.assign({}, query || {}) });
  const rows = () => (sandbox.__sheets.SecurityLog ? sandbox.__sheets.SecurityLog.grid.slice(1) : []);
  return { sandbox, post, get, rows, served, logs, gsConst: (n) => vm.runInContext(n, sandbox) };
}

const MODES = [['log', { PROXY_SECRET: PROXY }], ['enforce', { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' }]];

/* ===== OPEN_ACTIONS ===== */

test('OPEN_ACTIONS is pinned to exactly the Managers + Therapists actions and the two own-secret coordinators actions', () => {
  const g = loadGs({});
  assert.deepStrictEqual(Array.from(g.gsConst('OPEN_ACTIONS')), EXPECTED_OPEN);
  assert.deepStrictEqual(Array.from(g.gsConst('CALLER_CLASSES')), ['proxy', 'open', 'none', 'wrong']);
  const known = Array.from(g.gsConst('PROXY_KNOWN_ACTIONS'));
  for (const a of EXPECTED_OPEN) assert.ok(known.includes(a), a + ' is a real action');
  for (const a of ['getData', 'saveAll', 'savePayment', 'saveCredit', 'getPayments', 'accountingPayments', 'meetingReportLeads']) {
    assert.ok(!EXPECTED_OPEN.includes(a), a + ' must never be open');
  }
  // The scoped-caller-secret design was dropped (decision on PR #155).
  for (const gone of ['CALLER_SCOPES', 'MANAGERS_CALLER_SECRET', 'THERAPISTS_CALLER_SECRET', 'generateCallerSecretsNow', 'PROXY_SECRET_EXEMPT_ACTIONS']) {
    assert.ok(!GS_SRC.includes(gone), gone + ' must be gone');
  }
});

test('the open actions are served WITHOUT a secret in log AND enforce mode, GET and POST, logged as class "open"', () => {
  for (const [mode, props] of MODES) {
    const g = loadGs({ props });
    for (const a of EXPECTED_OPEN) {
      assert.strictEqual(g.post({ action: a }).json.served, a, mode + ' POST ' + a);
      assert.strictEqual(g.get({ action: a }).json.served, a, mode + ' GET ' + a);
      assert.strictEqual(g.post({ action: a, proxySecret: 'not-it' }).json.served, a, mode + ' wrong secret ' + a);
    }
    assert.strictEqual(g.served.length, EXPECTED_OPEN.length * 3, mode);
    // one row per open action per hour, whatever the method or secret
    assert.deepStrictEqual(g.rows().map((r) => [r[1], r[6]]), EXPECTED_OPEN.map((a) => [a, 'open']), mode);
  }
});

test('getAdmittedRoster stays open but still requires its OWN secret (real handle_, enforce mode, no PROXY_SECRET)', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce', ADMITTED_ROSTER_SECRET: ROSTER }, realHandle: true });
  g.sandbox.getAdmittedRoster_ = () => ({ ok: true, patients: [] });
  assert.deepStrictEqual(g.post({ action: 'getAdmittedRoster', secret: ROSTER }).json, { ok: true, patients: [] });
  assert.deepStrictEqual(g.get({ action: 'getAdmittedRoster', secret: ROSTER }).json, { ok: true, patients: [] },
    'Therapists\' unchanged GET with ?secret= keeps working');
  for (const bad of ['', 'x', ROSTER + 'x', ROSTER.slice(0, -1)]) {
    assert.deepStrictEqual(g.post({ action: 'getAdmittedRoster', secret: bad }).json, { ok: false, error: 'unauthorized' }, JSON.stringify(bad));
  }
});

/* ===== everything else is gated ===== */

test('getData, saveAll and a write WITHOUT a secret → served + logged in log mode, refused in enforce mode with NOTHING written', () => {
  const lg = loadGs({ props: { PROXY_SECRET: PROXY } });
  for (const a of GATED_SAMPLE) assert.strictEqual(lg.post({ action: a }).json.served, a, 'log ' + a);
  assert.deepStrictEqual(lg.rows().map((r) => [r[1], r[3], r[4], r[6]]),
    GATED_SAMPLE.map((a) => [a, 'no', 'no_secret', 'none']));
  for (const a of GATED_SAMPLE) assert.strictEqual(lg.post({ action: a, proxySecret: 'nope' }).json.served, a);
  assert.strictEqual(lg.rows().length, GATED_SAMPLE.length, 'none + wrong share the per-action-hour bucket');

  const en = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  for (const a of GATED_SAMPLE) {
    assert.deepStrictEqual(en.post({ action: a }).json, { ok: false, error: 'unauthorized' }, 'enforce none ' + a);
    assert.deepStrictEqual(en.post({ action: a, proxySecret: 'nope' }).json, { ok: false, error: 'unauthorized' }, 'enforce wrong ' + a);
  }
  assert.deepStrictEqual(en.served, [], 'no handler ran');
  assert.deepStrictEqual(en.sandbox.__inserted, [], 'no tab created, nothing written');
  // and with PROXY_SECRET they are served (class proxy, not logged)
  for (const a of GATED_SAMPLE) assert.strictEqual(en.post({ action: a, proxySecret: PROXY, proxyUser: '' }).json.served, a);
  assert.deepStrictEqual(en.sandbox.__inserted, []);
});

test('EVERY non-open action is gated — every action handle_ knows today, and any future one', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const known = Array.from(g.gsConst('PROXY_KNOWN_ACTIONS'));
  for (const a of known.filter((x) => !EXPECTED_OPEN.includes(x)).concat(['futureBillingAction', ''])) {
    assert.deepStrictEqual(g.post({ action: a }).json, { ok: false, error: 'unauthorized' }, a || '(no action)');
  }
});

test('getData via the GET path is gated too (and a secret in the URL does not count)', () => {
  const lg = loadGs({ props: { PROXY_SECRET: PROXY } });
  assert.strictEqual(lg.get({ action: 'getData' }).json.served, 'getData');
  assert.deepStrictEqual(lg.rows().map((r) => [r[1], r[2], r[6]]), [['getData', 'GET', 'none']]);

  const en = loadGs({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  assert.deepStrictEqual(en.get({ action: 'getData' }).json, { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(en.get({ action: 'getData', proxySecret: PROXY }).json, { ok: false, error: 'unauthorized' },
    'PROXY_SECRET in a querystring is dropped — body only');
  assert.deepStrictEqual(en.served, []);
});

/* ===== classes ===== */

test('callerClass_: proxy | open | none | wrong', () => {
  const g = loadGs({});
  const c = (a, s, exp) => g.sandbox.callerClass_(a, s, exp === undefined ? PROXY : exp);
  assert.strictEqual(c('getData', PROXY), 'proxy');
  assert.strictEqual(c('managersOverview', PROXY), 'proxy', 'a valid secret wins even on an open action');
  assert.strictEqual(c('managersOverview', ''), 'open');
  assert.strictEqual(c('getAdmittedRoster', 'anything'), 'open');
  assert.strictEqual(c('getData', ''), 'none');
  assert.strictEqual(c('getData', 'nope'), 'wrong');
  assert.strictEqual(c('getData', PROXY + 'x'), 'wrong');
  // PROXY_SECRET unset → nothing is proxy, not even an empty value
  assert.strictEqual(c('getData', '', ''), 'none');
  assert.strictEqual(c('getData', PROXY, ''), 'wrong');
  assert.strictEqual(c('managersHouse', PROXY, ''), 'open');
});

/* ===== report ===== */

test('securityCallersReportNow: action × class, and "non-open actions without a valid secret: N"', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  g.post({ action: 'managersOverview' });           // open
  g.post({ action: 'getAdmittedRoster' });          // open
  g.post({ action: 'getData' });                    // none  → counts
  g.post({ action: 'savePayment', proxySecret: 'x' }); // wrong → counts
  g.post({ action: 'getPayments', proxySecret: PROXY, proxyUser: 'ורד', user: 'סנדרה' }); // proxy (user_mismatch) → does not count
  // a pre-0b-2 row with no callerClass, on a gated action → derived none → counts
  g.sandbox.__sheets.SecurityLog.grid.push([new Date().toISOString(), 'saveAll', 'POST', 'no', 'no_secret', new Date().toISOString().slice(0, 13)]);
  const r = g.sandbox.securityCallersReportNow();
  const s = arr(r.summary).map((x) => [x.action, x.callerClass]).sort();
  assert.deepStrictEqual(s, [
    ['getAdmittedRoster', 'open'], ['getData', 'none'], ['getPayments', 'proxy'],
    ['managersOverview', 'open'], ['saveAll', 'none'], ['savePayment', 'wrong'],
  ]);
  assert.strictEqual(r.nonOpenWithoutSecret, 3);
  assert.ok(g.logs.includes('non-open actions without a valid secret: 3'), 'the summary line, exactly');
});

test('report: only open + proxy traffic → N = 0 (safe to enforce); empty log → N = 0', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  assert.strictEqual(g.sandbox.securityCallersReportNow().nonOpenWithoutSecret, 0);
  assert.ok(g.logs.includes('non-open actions without a valid secret: 0'));
  for (const a of EXPECTED_OPEN) g.post({ action: a });
  g.post({ action: 'getData', proxySecret: PROXY, proxyUser: '' });
  assert.strictEqual(g.sandbox.securityCallersReportNow().nonOpenWithoutSecret, 0);
});

/* ===== secrets never leak ===== */

test('no secret value appears in any log line, SecurityLog row, cache key, response or report', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, ADMITTED_ROSTER_SECRET: ROSTER }, realHandle: true });
  g.sandbox.getAdmittedRoster_ = () => ({ ok: true, patients: [] });
  const outs = [];
  outs.push(g.post({ action: 'getData', proxySecret: PROXY, proxyUser: '' }).raw);
  outs.push(g.post({ action: 'getData', proxySecret: PROXY + 'x' }).raw);
  outs.push(g.post({ action: 'noSuchAction', proxySecret: PROXY.slice(0, 20) }).raw);
  outs.push(g.post({ action: 'getAdmittedRoster', secret: ROSTER }).raw);
  outs.push(g.get({ action: 'getAdmittedRoster', secret: ROSTER + 'x' }).raw);
  outs.push(g.post({ action: 'managersOverview', proxySecret: PROXY }).raw);
  const report = g.sandbox.securityCallersReportNow();
  const everything = [outs.join('\n'), JSON.stringify(g.sandbox.__sheets.SecurityLog.grid),
    JSON.stringify(g.sandbox.__cache), g.logs.join('\n'), JSON.stringify(report)].join('\n');
  for (const s of [PROXY, ROSTER]) {
    assert.ok(!everything.includes(s.slice(0, 16)), 'secret leaked');
  }
});

/* ===== getData shape ===== */

test('getData keeps every key (append-only contract)', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY }, realHandle: true });
  const out = g.post({ action: 'getData', proxySecret: PROXY, proxyUser: '' }).json;
  assert.strictEqual(out.ok, true);
  for (const k of ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']) {
    assert.ok(k in out, 'getData lost ' + k);
  }
});
