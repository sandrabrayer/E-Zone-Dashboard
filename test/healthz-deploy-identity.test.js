/* Tests for the deploy identity reported on /healthz (server.js deployIdentity /
 * healthzBody) and the weekly healthcheck's stale-Railway-build check
 * (scripts/healthcheck.js checkDeployIdentity + run()).
 *
 * Contract locked here:
 *   - /healthz keeps `ok: true` (Railway healthcheck + helpdesk monitor key on it)
 *     and adds `commit` / `branch` straight from RAILWAY_GIT_COMMIT_SHA /
 *     RAILWAY_GIT_BRANCH — validated (hex sha, capped branch), blank elsewhere;
 *   - the helper reads ONLY those two env keys: nothing else in the environment
 *     (SESSION_SECRET, APP_PIN, …) can ever surface on the unauthenticated route;
 *   - the healthcheck compares /healthz `commit` with GITHUB_SHA: a mismatch is a
 *     WARNING (never fails the run), a match or any unknown side is a note;
 *   - run() still exits 0 on a mismatch and the warning lands in the report.
 *
 * server.js only calls app.listen when run as the main module (same approach as
 * api-auth.test.js). Nothing here touches the network. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789abcdef0123456789';
const server = require('../server');
const hc = require('../scripts/healthcheck');

const FULL_SHA = 'e5a9afa88d35c90892e756d2ee83e415e0d2072d';
const BRANCH = 'claude/build-ezone-dashboard-QOg5s';

/* ===== server.js deployIdentity ===== */

test('deployIdentity passes a valid Railway sha + branch through, lower-cased and trimmed', () => {
  const id = server.deployIdentity({ RAILWAY_GIT_COMMIT_SHA: ' ' + FULL_SHA.toUpperCase() + ' ', RAILWAY_GIT_BRANCH: ' ' + BRANCH + ' ' });
  assert.deepStrictEqual(id, { commit: FULL_SHA, branch: BRANCH });
});

test('deployIdentity is blank outside Railway (no env, empty env, non-object env)', () => {
  assert.deepStrictEqual(server.deployIdentity({}), { commit: '', branch: '' });
  assert.deepStrictEqual(server.deployIdentity(undefined), { commit: '', branch: '' });
  assert.deepStrictEqual(server.deployIdentity(null), { commit: '', branch: '' });
  assert.deepStrictEqual(server.deployIdentity('str'), { commit: '', branch: '' });
});

test('deployIdentity rejects a non-sha commit value rather than echoing it', () => {
  for (const bad of ['not-a-sha', 'abc', '<script>', 'e5a9afa88d35c90892e756d2ee83e415e0d2072d00', 'zzzzzzz']) {
    assert.strictEqual(server.deployIdentity({ RAILWAY_GIT_COMMIT_SHA: bad }).commit, '', `rejected: ${bad}`);
  }
  // 7-char short sha is the minimum accepted shape.
  assert.strictEqual(server.deployIdentity({ RAILWAY_GIT_COMMIT_SHA: 'e5a9afa' }).commit, 'e5a9afa');
});

test('deployIdentity caps an oversized branch name', () => {
  const long = 'b'.repeat(500);
  assert.strictEqual(server.deployIdentity({ RAILWAY_GIT_BRANCH: long }).branch.length, 200);
});

test('deployIdentity reads only the two RAILWAY_GIT_* keys — secrets never ride along', () => {
  const env = {
    RAILWAY_GIT_COMMIT_SHA: FULL_SHA,
    RAILWAY_GIT_BRANCH: BRANCH,
    SESSION_SECRET: 'super-secret-session',
    APP_PIN: '123456',
    MEETING_REPORT_SECRET: 'mr-secret',
    RAILWAY_DEPLOYMENT_ID: 'dep-123',
    SHEETS_URL: 'https://script.google.com/macros/s/AKfyc/exec',
  };
  const body = server.healthzBody(env);
  assert.deepStrictEqual(Object.keys(body).sort(), ['branch', 'build', 'commit', 'ok']);
  const json = JSON.stringify(body);
  for (const leak of ['super-secret-session', '123456', 'mr-secret', 'dep-123', 'AKfyc']) {
    assert.ok(!json.includes(leak), `leaked: ${leak}`);
  }
});

/* ===== server.js healthzBody ===== */

test('healthzBody keeps ok:true and adds commit/branch/build', () => {
  const body = server.healthzBody({ RAILWAY_GIT_COMMIT_SHA: FULL_SHA, RAILWAY_GIT_BRANCH: BRANCH });
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.commit, FULL_SHA);
  assert.strictEqual(body.branch, BRANCH);
  assert.ok(typeof body.build === 'string' && body.build.length > 0, 'build id present');
});

test('healthzBody outside Railway still answers ok:true with blank identity', () => {
  const body = server.healthzBody({});
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.commit, '');
  assert.strictEqual(body.branch, '');
});

test('healthzBody is stable across calls (same process → same build id)', () => {
  assert.strictEqual(server.healthzBody({}).build, server.healthzBody({}).build);
});

/* ===== scripts/healthcheck.js checkDeployIdentity ===== */

function healthzJson(commit, branch) {
  return JSON.stringify({ ok: true, commit, branch: branch == null ? BRANCH : branch, build: 'b1' });
}

test('checkDeployIdentity: live commit differs from GITHUB_SHA → WARNING naming both, no critical', () => {
  const r = hc.checkDeployIdentity(200, healthzJson(FULL_SHA), '93b72ef181' + 'f'.repeat(30));
  assert.strictEqual(r.warnings.length, 1);
  assert.deepStrictEqual(r.notes, []);
  assert.match(r.warnings[0], /STALE build/);
  assert.match(r.warnings[0], /e5a9afa88d35/);
  assert.match(r.warnings[0], /93b72ef181ff/);
  assert.match(r.warnings[0], new RegExp(BRANCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!('criticals' in r), 'never a critical');
});

test('checkDeployIdentity: matching commit → note only', () => {
  const r = hc.checkDeployIdentity(200, healthzJson(FULL_SHA), FULL_SHA);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0], /matches this run's checkout/);
});

test('checkDeployIdentity: short sha on either side compares as a prefix, case-insensitively', () => {
  assert.deepStrictEqual(hc.checkDeployIdentity(200, healthzJson('e5a9afa'), FULL_SHA.toUpperCase()).warnings, []);
  assert.deepStrictEqual(hc.checkDeployIdentity(200, healthzJson(FULL_SHA), 'E5A9AFA').warnings, []);
  assert.strictEqual(hc.checkDeployIdentity(200, healthzJson('e5a9afb'), FULL_SHA).warnings.length, 1);
});

test('checkDeployIdentity: no live commit (older server / RAILWAY_* unset) → note, no warning', () => {
  const r = hc.checkDeployIdentity(200, healthzJson(''), FULL_SHA);
  assert.deepStrictEqual(r.warnings, []);
  assert.match(r.notes[0], /reports no commit/);
  // An /healthz body that pre-dates the field entirely.
  const r2 = hc.checkDeployIdentity(200, '{"ok":true}', FULL_SHA);
  assert.deepStrictEqual(r2.warnings, []);
  assert.match(r2.notes[0], /reports no commit/);
});

test('checkDeployIdentity: no GITHUB_SHA (local run) → note with the live commit, no warning', () => {
  const r = hc.checkDeployIdentity(200, healthzJson(FULL_SHA), undefined);
  assert.deepStrictEqual(r.warnings, []);
  assert.match(r.notes[0], /no GITHUB_SHA/);
  assert.match(r.notes[0], /e5a9afa88d35/);
});

test('checkDeployIdentity: non-JSON /healthz → note; non-200 → warning; neither is critical', () => {
  const html = hc.checkDeployIdentity(200, '<title>E-ZONE Dashboard</title>', FULL_SHA);
  assert.deepStrictEqual(html.warnings, []);
  assert.match(html.notes[0], /did not return JSON/);
  const down = hc.checkDeployIdentity(503, '', FULL_SHA);
  assert.strictEqual(down.warnings.length, 1);
  assert.match(down.warnings[0], /HTTP 503/);
});

/* ===== run() end-to-end with an injected fetch (network never touched) ===== */

function healthyData() {
  const lead = {};
  for (const c of hc.LEAD_COLUMNS) lead[c] = '';
  lead.id = 'L1';
  const patient = {};
  for (const c of hc.PATIENT_COLUMNS) patient[c] = '';
  patient.houseId = 'ramot';
  patient.id = 'P1';
  return {
    ok: true, leads: [lead], patients: { ramot: [patient] }, irrelevantLeads: [], removedLeads: [],
    dischargedPatients: [], billingOverrides: [], houseManagers: {}, managerPhones: {},
  };
}

function fakeFetchFor(routes) {
  return async (url) => {
    for (const [suffix, resp] of Object.entries(routes)) {
      if (String(url).includes(suffix)) {
        return {
          status: resp.status,
          headers: {
            getSetCookie: () => resp.setCookie || [],
            get: (h) => (h.toLowerCase() === 'set-cookie' ? (resp.setCookie || [])[0] || null : null),
          },
          text: async () => resp.body,
        };
      }
    }
    const shell = routes['/'];
    return { status: shell.status, headers: { getSetCookie: () => [], get: () => null }, text: async () => shell.body };
  };
}

function routesWithHealthz(commit) {
  return {
    '/healthz': { status: 200, body: healthzJson(commit) },
    '/api/verify-pin': { status: 200, body: '{"ok":true}', setCookie: ['ezone_session=tok123; HttpOnly; Path=/'] },
    '/api/sheets?action=getData': { status: 200, body: JSON.stringify(healthyData()) },
    '/': { status: 200, body: '<title>E-ZONE Dashboard</title>' },
  };
}

test('run(): a stale Railway build is a WARNING in the report and still exits 0', async () => {
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')), 'summary.md');
  const env = { APP_PIN: '0000', APP_URL: 'https://healthcheck.invalid', GITHUB_SHA: '93b72ef181' + 'f'.repeat(30), GITHUB_STEP_SUMMARY: summary };
  const code = await hc.run(env, fakeFetchFor(routesWithHealthz(FULL_SHA)));
  assert.strictEqual(code, 0);
  const report = fs.readFileSync(summary, 'utf8');
  assert.match(report, /All critical checks passed/);
  assert.match(report, /Warnings — 1/);
  assert.match(report, /STALE build/);
});

test('run(): a matching build reports the match as a note and no warning', async () => {
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')), 'summary.md');
  const env = { APP_PIN: '0000', APP_URL: 'https://healthcheck.invalid', GITHUB_SHA: FULL_SHA, GITHUB_STEP_SUMMARY: summary };
  assert.strictEqual(await hc.run(env, fakeFetchFor(routesWithHealthz(FULL_SHA))), 0);
  const report = fs.readFileSync(summary, 'utf8');
  assert.match(report, /Warnings: none/);
  assert.match(report, /matches this run's checkout/);
});

test('run(): /healthz probe failure is a warning, never a critical', async () => {
  const routes = routesWithHealthz(FULL_SHA);
  const inner = fakeFetchFor(routes);
  const fetchFn = async (url, opts) => {
    if (String(url).includes('/healthz')) throw new Error('boom');
    return inner(url, opts);
  };
  assert.strictEqual(await hc.run({ APP_PIN: '0000', APP_URL: 'https://healthcheck.invalid', GITHUB_SHA: FULL_SHA }, fetchFn), 0);
});
