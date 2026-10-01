/* Phase 0b-2a: per-consumer scoped caller secrets, LOG mode.
 * See CHANGELOG-scoped-caller-secrets.md.
 *
 *   - every request is classified: proxy | managers | therapists | none |
 *     wrong | out_of_scope, and the class lands in SecurityLog.callerClass
 *   - a scoped secret on another scope's action → out_of_scope
 *   - an unset (or blank) property matches nothing
 *   - log mode never rejects; nothing about serving changes for any class
 *   - no secret value in any log line, SecurityLog row, cache key or response
 *   - generateCallerSecretsNow never overwrites and never logs a value
 *   - CALLER_SCOPES equals what the consumers' deployed code calls
 *   - getData keeps every existing key
 *
 * vm sandbox on the real Code.gs, per the repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const arr = (x) => JSON.parse(JSON.stringify(x));

const PROXY = 'proxy-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MGR   = 'managers-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const THR   = 'therapists-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ALL_PROPS = { PROXY_SECRET: PROXY, MANAGERS_CALLER_SECRET: MGR, THERAPISTS_CALLER_SECRET: THR };

/* What the consumers' DEPLOYED code calls on this backend (investigation of
 * 2026-10-01, see the CHANGELOG):
 *   ezone-managers @ main (b779e22): public/app.js fetchJson('/api/sheets?action=…')
 *     → server.js GET /api/sheets proxy. No apps-script/ in that repo.
 *   ezone-therapists @ claude/inspiring-tesla-jipobw (95195e3): server.js:1438
 *     proxyGet(DASHBOARD_SHEETS_URL, 'getAdmittedRoster', …). Its
 *     apps-script/Code.gs UrlFetchApp calls (10) go to OUTPATIENT_SHEETS_URL (9)
 *     and STAFFING_SHEETS_URL (1) only. */
const FOUND = {
  managers:   ['managersOverview', 'managersHouse', 'occupancySnapshots'],
  therapists: ['getAdmittedRoster'],
};

function fakeSheet(headerRow) {
  const grid = headerRow && headerRow.length ? [headerRow.slice()] : [];
  return {
    grid,
    getName: () => 'x',
    getLastRow() { return grid.length; },
    getLastColumn() { return grid.reduce((n, r) => Math.max(n, r.length), 0); },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
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
  const alerts = [];
  const sandbox = {
    console: { log: capture, warn: capture, error: capture, info: capture },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isNaN, isFinite,
    Logger: { log: capture },
    __sheets: {},
    __props: Object.assign({}, o.props || {}),
    __cache: {},
    __setProps: [],
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      getSheets: () => Object.values(sandbox.__sheets),
      insertSheet: (n) => (sandbox.__sheets[n] = fakeSheet([])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    getUi: () => {
      if (o.noUi) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      return { alert: (title, msg) => { alerts.push({ title, msg }); }, ButtonSet: { OK: 'OK' } };
    },
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty: (k, v) => { sandbox.__setProps.push(k); sandbox.__props[k] = v; },
    }),
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
    getUuid: () => crypto.randomUUID(),
    formatDate: (d) => d.toISOString().slice(0, 10),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest())
      .map((b) => (b > 127 ? b - 256 : b)),   // Apps Script returns signed bytes
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_'),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  const served = [];
  if (!o.realHandle) {
    sandbox.handle_ = (params) => { served.push(params.action); return sandbox.jsonOut_({ ok: true, served: params.action }); };
  }
  const post = (body) => sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } });
  const rows = () => (sandbox.__sheets.SecurityLog ? sandbox.__sheets.SecurityLog.grid.slice(1) : []);
  return { sandbox, post, rows, served, logs, alerts, gsConst: (n) => vm.runInContext(n, sandbox) };
}

/* [class, body] for every class, all props set. */
const CASES = [
  ['proxy',        { action: 'getData', proxySecret: PROXY }],
  ['managers',     { action: 'managersOverview', proxySecret: MGR }],
  ['therapists',   { action: 'getAdmittedRoster', proxySecret: THR, secret: 'own' }],
  ['none',         { action: 'managersHouse' }],
  ['wrong',        { action: 'getPayments', proxySecret: 'not-a-secret' }],
  ['out_of_scope', { action: 'getData', proxySecret: MGR }],
];

/* ===== classification ===== */

test('callerClass_: every class is detected', () => {
  const g = loadGs({ props: ALL_PROPS });
  const props = g.sandbox.PropertiesService.getScriptProperties();
  for (const [cls, body] of CASES) {
    assert.strictEqual(g.sandbox.callerClass_(body.action, body.proxySecret, props), cls, cls);
  }
  assert.deepStrictEqual(Array.from(g.gsConst('CALLER_CLASSES')), ['proxy', 'managers', 'therapists', 'none', 'wrong', 'out_of_scope']);
});

test('SecurityLog gets the class in an APPENDED callerClass column (header order unchanged) — proxy traffic stays unlogged', () => {
  const g = loadGs({ props: ALL_PROPS });
  for (const [, body] of CASES) g.post(body);
  const header = g.sandbox.__sheets.SecurityLog.grid[0];
  assert.deepStrictEqual(Array.from(header), ['timestamp', 'action', 'method', 'secretPresent', 'callerType', 'hourKey', 'callerClass']);
  const got = g.rows().map((r) => [r[1], r[4], r[6]]);
  assert.deepStrictEqual(got, [
    ['managersOverview', 'scoped_secret', 'managers'],
    ['getAdmittedRoster', 'scoped_secret', 'therapists'],
    ['managersHouse', 'no_secret', 'none'],
    ['getPayments', 'bad_secret', 'wrong'],
    ['getData', 'scoped_secret', 'out_of_scope'],
  ]);
});

test('a scoped secret on ANOTHER scope\'s action → out_of_scope (both directions, and on a Dashboard-only action)', () => {
  const g = loadGs({ props: ALL_PROPS });
  const props = g.sandbox.PropertiesService.getScriptProperties();
  const c = (a, s) => g.sandbox.callerClass_(a, s, props);
  for (const a of FOUND.therapists) assert.strictEqual(c(a, MGR), 'out_of_scope', 'managers secret on ' + a);
  for (const a of FOUND.managers) assert.strictEqual(c(a, THR), 'out_of_scope', 'therapists secret on ' + a);
  for (const a of ['getData', 'saveAll', 'savePayment', 'accountingPayments', '', 'noSuchAction']) {
    assert.strictEqual(c(a, MGR), 'out_of_scope', 'managers secret on ' + a);
    assert.strictEqual(c(a, THR), 'out_of_scope', 'therapists secret on ' + a);
  }
  for (const a of FOUND.managers) assert.strictEqual(c(a, MGR), 'managers');
  for (const a of FOUND.therapists) assert.strictEqual(c(a, THR), 'therapists');
  // PROXY_SECRET is full access: proxy on every action, scoped ones included.
  for (const a of FOUND.managers.concat(FOUND.therapists, ['getData', 'saveAll'])) assert.strictEqual(c(a, PROXY), 'proxy');
});

test('an UNSET or blank scope property matches nothing (fail closed)', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY, THERAPISTS_CALLER_SECRET: '' } });
  const props = g.sandbox.PropertiesService.getScriptProperties();
  const c = (a, s) => g.sandbox.callerClass_(a, s, props);
  assert.strictEqual(c('managersOverview', MGR), 'wrong', 'MANAGERS_CALLER_SECRET unset → no match');
  assert.strictEqual(c('getAdmittedRoster', THR), 'wrong', 'blank property → no match');
  assert.strictEqual(c('getAdmittedRoster', ''), 'none', 'an empty value never "matches" a blank property');
  assert.strictEqual(c('managersOverview', 'null'), 'wrong');
  const none = loadGs({ props: {} });
  const p2 = none.sandbox.PropertiesService.getScriptProperties();
  for (const s of [PROXY, MGR, THR]) assert.strictEqual(none.sandbox.callerClass_('getData', s, p2), 'wrong');
});

test('the compare is constant-time across classes: every configured secret is compared, whichever matches', () => {
  const g = loadGs({ props: ALL_PROPS });
  const props = g.sandbox.PropertiesService.getScriptProperties();
  const real = g.sandbox.constantTimeEquals_;
  let calls = 0;
  g.sandbox.constantTimeEquals_ = (a, b) => { calls++; return real(a, b); };
  const counts = CASES.filter(([cls]) => cls !== 'none').map(([, b]) => { calls = 0; g.sandbox.callerClass_(b.action, b.proxySecret, props); return calls; });
  assert.ok(counts.every((n) => n === 3), 'always 3 compares, no early exit: ' + counts);
});

/* ===== log mode never rejects; behaviour unchanged ===== */

test('LOG mode never rejects: every class is served', () => {
  for (const mode of [undefined, 'log']) {
    const props = Object.assign({}, ALL_PROPS);
    if (mode) props.PROXY_SECRET_MODE = mode;
    const g = loadGs({ props });
    for (const [cls, body] of CASES) {
      const out = g.post(body).json;
      assert.strictEqual(out.ok, true, cls);
      assert.strictEqual(out.served, body.action, cls);
    }
    assert.strictEqual(g.served.length, CASES.length);
  }
});

test('behaviour is unchanged per class: a scoped secret is NOT a proxy secret (user not trusted; enforce mode treats it exactly as before)', () => {
  // log mode: a managers request keeps its body user (legacy path) — only the
  // proxy class gets the proxyUser identity.
  const g = loadGs({ props: ALL_PROPS, realHandle: false });
  let seen = null;
  g.sandbox.handle_ = (p) => { seen = p; return g.sandbox.jsonOut_({ ok: true }); };
  g.post({ action: 'managersOverview', proxySecret: MGR, proxyUser: 'סנדרה', user: 'x' });
  assert.strictEqual(seen.user, 'x');
  assert.ok(!('proxySecret' in seen) && !('proxyUser' in seen), 'stripped for every class');
  // enforce mode (0b-1 contract, unchanged): anything but proxy on a gated
  // action is refused and writes nothing; own-secret actions are never refused.
  const e = loadGs({ props: Object.assign({ PROXY_SECRET_MODE: 'enforce' }, ALL_PROPS) });
  for (const [cls, body] of CASES) {
    const out = e.post(body).json;
    const exempt = body.action === 'getAdmittedRoster';
    if (cls === 'proxy' || exempt) assert.strictEqual(out.ok, true, cls);
    else assert.deepStrictEqual(out, { ok: false, error: 'unauthorized' }, cls);
  }
  assert.deepStrictEqual(e.rows().map((r) => r[6]), ['therapists'], 'only the served exempt request is logged');
});

/* ===== secrets never leak ===== */

test('no secret value appears in any log line, SecurityLog row, cache key or response', () => {
  const g = loadGs({ props: ALL_PROPS, realHandle: true });
  const outs = [];
  for (const [, body] of CASES) outs.push(g.post(body).raw);
  outs.push(g.post({ action: 'getData', proxySecret: MGR + 'x' }).raw);
  outs.push(g.post({ action: 'noSuchAction', proxySecret: THR }).raw);
  const report = g.sandbox.securityCallersReportNow();
  const everything = [outs.join('\n'), JSON.stringify(g.sandbox.__sheets.SecurityLog.grid), JSON.stringify(g.sandbox.__cache),
    g.logs.join('\n'), JSON.stringify(report)].join('\n');
  for (const s of [PROXY, MGR, THR]) {
    assert.ok(!everything.includes(s), 'secret leaked');
    assert.ok(!everything.includes(s.slice(0, 16)), 'secret prefix leaked');
  }
});

/* ===== report ===== */

test('securityCallersReportNow groups by action × class (legacy rows derive their class from callerType)', () => {
  const g = loadGs({ props: ALL_PROPS });
  const now = new Date().toISOString();
  const hk = now.slice(0, 13);
  const sh = fakeSheet(['timestamp', 'action', 'method', 'secretPresent', 'callerType', 'hourKey', 'callerClass']);
  sh.grid.push([now, 'managersOverview', 'GET', 'no', 'no_secret', hk]);                    // legacy → none
  sh.grid.push([now, 'managersOverview', 'POST', 'yes', 'scoped_secret', hk, 'managers']);
  sh.grid.push([now, 'managersOverview', 'POST', 'yes', 'scoped_secret', hk, 'managers']);
  sh.grid.push([now, 'getData', 'POST', 'yes', 'scoped_secret', hk, 'out_of_scope']);
  sh.grid.push([now, 'getAdmittedRoster', 'GET', 'yes', 'scoped_secret', hk, 'therapists']);
  g.sandbox.__sheets.SecurityLog = sh;
  const s = arr(g.sandbox.securityCallersReportNow().summary).map((x) => [x.action, x.callerClass, x.hours, x.methods]);
  assert.deepStrictEqual(s, [
    ['managersOverview', 'managers', 2, 'POST'],
    ['getAdmittedRoster', 'therapists', 1, 'GET'],
    ['getData', 'out_of_scope', 1, 'POST'],
    ['managersOverview', 'none', 1, 'GET'],
  ]);
});

/* ===== generateCallerSecretsNow ===== */

test('generateCallerSecretsNow: creates BOTH when unset — 32 random bytes each, shown once in the dialog, never logged', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  const res = g.sandbox.generateCallerSecretsNow();
  const m = g.sandbox.__props.MANAGERS_CALLER_SECRET;
  const t = g.sandbox.__props.THERAPISTS_CALLER_SECRET;
  for (const v of [m, t]) {
    assert.match(v, /^[A-Za-z0-9_-]{43}$/, '32 bytes, URL-safe base64, no padding');
    assert.strictEqual(Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 32);
  }
  assert.notStrictEqual(m, t);
  assert.deepStrictEqual(Array.from(res.created), ['MANAGERS_CALLER_SECRET', 'THERAPISTS_CALLER_SECRET']);
  assert.strictEqual(g.alerts.length, 1, 'one dialog');
  assert.ok(g.alerts[0].msg.includes(m) && g.alerts[0].msg.includes(t), 'both values are in the dialog');
  const logged = g.logs.join('\n');
  assert.ok(!logged.includes(m) && !logged.includes(t), 'no value in Logger / console');
  assert.ok(logged.includes('MANAGERS_CALLER_SECRET'), 'names are fine');
  assert.strictEqual(g.sandbox.__props.PROXY_SECRET, PROXY, 'PROXY_SECRET untouched');
});

test('generateCallerSecretsNow: NEVER overwrites — an existing value is kept and never shown', () => {
  const g = loadGs({ props: { MANAGERS_CALLER_SECRET: MGR } });
  const res = g.sandbox.generateCallerSecretsNow();
  assert.strictEqual(g.sandbox.__props.MANAGERS_CALLER_SECRET, MGR);
  assert.deepStrictEqual(Array.from(g.sandbox.__setProps), ['THERAPISTS_CALLER_SECRET'], 'only the unset one is written');
  assert.deepStrictEqual(Array.from(res.kept), ['MANAGERS_CALLER_SECRET']);
  assert.ok(!g.alerts[0].msg.includes(MGR), 'an existing value is never displayed');
  // second run: nothing to do, nothing written
  const before = g.sandbox.__props.THERAPISTS_CALLER_SECRET;
  const again = g.sandbox.generateCallerSecretsNow();
  assert.deepStrictEqual(Array.from(again.created), []);
  assert.strictEqual(g.sandbox.__props.THERAPISTS_CALLER_SECRET, before);
  assert.strictEqual(g.sandbox.__setProps.length, 1);
  assert.match(g.alerts[1].msg, /Nothing generated/);
  assert.ok(!g.logs.join('\n').includes(MGR) && !g.logs.join('\n').includes(before));
});

test('generateCallerSecretsNow: no dialog available → values still stored, pointer to Script Properties logged, still no value logged', () => {
  const g = loadGs({ props: {}, noUi: true });
  const res = g.sandbox.generateCallerSecretsNow();
  assert.strictEqual(res.dialogShown, false);
  const vals = [g.sandbox.__props.MANAGERS_CALLER_SECRET, g.sandbox.__props.THERAPISTS_CALLER_SECRET];
  assert.ok(vals.every(Boolean));
  const logged = g.logs.join('\n');
  assert.match(logged, /Project Settings → Script Properties/);
  for (const v of vals) assert.ok(!logged.includes(v));
});

test('generateCallerSecretsNow source: no Logger/console call touches a value', () => {
  const start = GS_SRC.indexOf('function generateCallerSecretsNow(');
  const src = GS_SRC.slice(start, GS_SRC.indexOf('\nfunction ', start + 1));
  const calls = src.match(/(Logger\.log|console\.\w+)\([\s\S]*?\);/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(!/\bvalue\b|shown|newCallerSecret_/.test(c), 'a log call references a value: ' + c);
});

/* ===== scopes ===== */

test('CALLER_SCOPES equals what the consumers\' deployed code calls (investigation of 2026-10-01)', () => {
  const g = loadGs({});
  assert.deepStrictEqual(arr(g.gsConst('CALLER_SCOPES')), FOUND);
  assert.deepStrictEqual(arr(g.gsConst('CALLER_SECRET_PROPS')), { managers: 'MANAGERS_CALLER_SECRET', therapists: 'THERAPISTS_CALLER_SECRET' });
  const known = Array.from(g.gsConst('PROXY_KNOWN_ACTIONS'));
  for (const a of FOUND.managers.concat(FOUND.therapists)) assert.ok(known.includes(a), a + ' is a real action');
  assert.ok(!FOUND.managers.some((a) => FOUND.therapists.includes(a)), 'scopes are disjoint');
  for (const w of ['saveAll', 'savePayment', 'saveCredit', 'getData', 'getPayments', 'deletePatientRow']) {
    assert.ok(!FOUND.managers.includes(w) && !FOUND.therapists.includes(w), 'no scope includes ' + w);
  }
});

/* ===== getData shape ===== */

test('getData keeps every existing key (append-only contract)', () => {
  const g = loadGs({ props: ALL_PROPS, realHandle: true });
  const out = g.post({ action: 'getData', proxySecret: PROXY, proxyUser: '' }).json;
  for (const k of ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']) {
    assert.ok(k in out, 'getData lost ' + k);
  }
  assert.strictEqual(out.ok, true);
});
