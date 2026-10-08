/* Tests for GET /api/version — the post-merge deploy probe (CLAUDE.md rule 4b).
 *
 * Contract locked here:
 *   - public: answers 200 with no session cookie, and proxies nothing;
 *   - Cache-Control is exactly no-store (a cached answer would fake a deploy);
 *   - the body is EXACTLY { commit, builtAt } — no branch, no build id, and no
 *     other env key (secrets included) can ever ride along;
 *   - commit is the validated RAILWAY_GIT_COMMIT_SHA (lower-cased hex, '' when
 *     unset or malformed); builtAt is an ISO-8601 timestamp.
 *
 * server.js only calls app.listen when run as the main module, so the app is
 * started here on an ephemeral 127.0.0.1 port. Nothing touches the network. */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789abcdef0123456789';
const orig = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};
let server;
try { server = require('../server'); } finally { Object.assign(console, orig); }

const FULL_SHA = 'e5a9afa88d35c90892e756d2ee83e415e0d2072d';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(env, fn) {
  const saved = { sha: process.env.RAILWAY_GIT_COMMIT_SHA, secret: process.env.SUPER_SECRET_TEST_KEY };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const quiet = console.log; console.log = () => {};
  const srv = await new Promise((resolve) => { const s = server.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port); } finally {
    srv.close();
    console.log = quiet;
    if (saved.sha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA; else process.env.RAILWAY_GIT_COMMIT_SHA = saved.sha;
    if (saved.secret === undefined) delete process.env.SUPER_SECRET_TEST_KEY; else process.env.SUPER_SECRET_TEST_KEY = saved.secret;
  }
}

test('versionBody returns exactly { commit, builtAt } from the validated Railway sha', () => {
  const b = server.versionBody({ RAILWAY_GIT_COMMIT_SHA: FULL_SHA.toUpperCase(), RAILWAY_GIT_BRANCH: 'x', SESSION_SECRET: 's' }, '2026-10-08T00:00:00.000Z');
  assert.deepStrictEqual(b, { commit: FULL_SHA, builtAt: '2026-10-08T00:00:00.000Z' });
});

test('versionBody: commit is blank when the sha is unset or malformed', () => {
  assert.strictEqual(server.versionBody({}).commit, '');
  assert.strictEqual(server.versionBody({ RAILWAY_GIT_COMMIT_SHA: '<script>' }).commit, '');
  assert.match(server.versionBody({}).builtAt, ISO_RE);
});

test('GET /api/version is public, no-store, and returns only { commit, builtAt }', async () => {
  await withServer({ RAILWAY_GIT_COMMIT_SHA: FULL_SHA, SUPER_SECRET_TEST_KEY: 'do-not-leak' }, async (port) => {
    const r = await get(port, '/api/version');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['builtAt', 'commit']);
    assert.strictEqual(r.json.commit, FULL_SHA);
    assert.match(r.json.builtAt, ISO_RE);
    assert.ok(!JSON.stringify(r.json).includes('do-not-leak'));
    assert.strictEqual(r.headers['set-cookie'], undefined, 'no session is minted');
  });
});

test('GET /api/version answers commit "" outside Railway and is stable across calls', async () => {
  await withServer({}, async (port) => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    const a = await get(port, '/api/version');
    const b = await get(port, '/api/version');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.json.commit, '');
    assert.strictEqual(a.json.builtAt, b.json.builtAt, 'builtAt is the process start, not request time');
  });
});
