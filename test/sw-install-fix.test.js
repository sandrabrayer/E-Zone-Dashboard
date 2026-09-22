/* The service worker never finished installing.
 *
 * THE BUG. Every response server.js served carried `Vary: *`. The Cache API
 * refuses to STORE such a response — Cache.add/addAll/put reject with
 *   TypeError: Failed to execute 'add' on 'Cache': Vary header contains *
 * — so not one precache write could ever succeed. The old install handler ran
 * six concurrent `cache.add()` calls on one Cache and swallowed each rejection
 * with `.catch(){}`; the concurrent failures left the last adds permanently
 * unsettled, so `Promise.all` never settled, `event.waitUntil()` stayed
 * pending, and the worker sat in `installing` forever. `activate` therefore
 * never ran, and every old cache (v5…v14) survived on every device.
 *
 * Reproduced and fixed against real Chromium — see
 * test/sw-install-browser.test.js and CHANGELOG-sw-install-fix.md.
 *
 * Locked contracts:
 *   A. every precache path exists under public/;
 *   B. no precache entry is an /api/ or auth-gated route;
 *   C. install SETTLES (it is driven here and awaited under a timeout), uses
 *      cache.addAll, and calls skipWaiting — and still settles when the
 *      precache fails, because reaching activate matters more than the
 *      offline shell;
 *   D. activate deletes every cache whose name !== the current one, then
 *      claims;
 *   E. server.js serves /sw.js unauthenticated, 200, with Cache-Control
 *      no-cache — and NO response carries the `Vary: *` that caused this.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* ---------- harness: load sw.js and CAPTURE its event handlers ---------- */

function loadSw(opts) {
  opts = opts || {};
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0, addAll: [], deleted: [], opened: [] };
  const noop = () => {};
  const moduleObj = { exports: {} };

  const cacheObj = {
    add: () => Promise.resolve(),
    addAll: (urls) => {
      calls.addAll.push(Array.from(urls));
      return opts.addAllRejects
        ? Promise.reject(new TypeError('Vary header contains *'))
        : Promise.resolve();
    },
    put: () => Promise.resolve(),
  };

  const sandbox = {
    self: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
      clients: { claim: () => { calls.claim++; return Promise.resolve(); } },
    },
    caches: {
      open: (name) => { calls.opened.push(name); return Promise.resolve(cacheObj); },
      keys: () => Promise.resolve(opts.existingCaches || []),
      delete: (key) => { calls.deleted.push(key); return Promise.resolve(true); },
      match: () => Promise.resolve(undefined),
    },
    Promise, URL, TypeError, Array,
    console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, calls, exports: moduleObj.exports };
}

/* Drive one lifecycle event and return the promise it passed to waitUntil.
 * A handler that never calls waitUntil, or whose promise never settles, fails
 * the test by timeout rather than hanging the run — that IS the bug. */
function fireEvent(handler, label) {
  let captured = null;
  handler({ waitUntil: (p) => { captured = p; } });
  assert.ok(captured, label + ' must call event.waitUntil');
  return Promise.race([
    Promise.resolve(captured).then(() => 'SETTLED: resolved', (e) => 'SETTLED: rejected ' + e),
    new Promise((r) => setTimeout(() => r('PENDING'), 2000)),
  ]);
}

/* ---------- harness: boot the real server on an ephemeral port ---------- */

function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers: headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout ' + urlPath)));
  });
}

async function withServer(fn) {
  const port = 4200 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      SESSION_SECRET: 'z'.repeat(32),
      APP_PIN: '1234',
      SHEETS_URL: 'http://127.0.0.1:1/unused',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Wait for the port to accept a connection.
    for (let i = 0; i < 60; i++) {
      try { await get(port, '/healthz'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
    }
    return await fn(port);
  } finally {
    child.kill();
  }
}

const PRECACHE = (() => {
  const m = /var PRECACHE_URLS = \[([\s\S]*?)\];/.exec(SW_SRC);
  assert.ok(m, 'PRECACHE_URLS not found in sw.js');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();

/* ================= A. the precache list is real ================= */

test('A: every precache path exists under public/', () => {
  assert.ok(PRECACHE.length > 0);
  for (const url of PRECACHE) {
    // '/' is the shell, served from public/index.html.
    const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
    const full = path.join(ROOT, 'public', rel);
    assert.ok(fs.existsSync(full), `precache entry ${url} has no file at public/${rel}`);
  }
});

test('A: every precache path has an explicit server.js route (none hits the 404 fallback)', () => {
  for (const url of PRECACHE) {
    const route = url === '/' ? "app.get('/'," : `app.get('${url}'`;
    assert.ok(SERVER_SRC.includes(route), `no server.js route serves ${url}`);
  }
});

/* ================= B. nothing auth-gated is precached ================= */

test('B: no precache entry is an /api/ or otherwise auth-gated route', () => {
  for (const url of PRECACHE) {
    assert.ok(url.indexOf('/api/') !== 0, `${url} is an API route and must never be precached`);
    assert.ok(url.indexOf('sheets') === -1, `${url} looks like a data endpoint`);
    // Nothing precached may be behind requireSession / the meeting-report PIN.
    const gated = new RegExp(`app\\.(get|post)\\('${url.replace(/[/.]/g, '\\$&')}',\\s*require(Session|MeetingReportSession)`);
    assert.ok(!gated.test(SERVER_SRC), `${url} is served behind an auth middleware`);
  }
  // And the routing table still treats data endpoints as network-only.
  const sw = loadSw().exports;
  assert.equal(sw.cacheStrategy('/api/sheets?action=getData'), 'network-only');
  assert.equal(sw.cacheStrategy('https://x/api/me'), 'network-only');
  assert.equal(sw.cacheStrategy('https://script.google.com/sheets/exec'), 'network-only');
});

/* ================= C. install always settles ================= */

test('C: install SETTLES, precaches with addAll, and calls skipWaiting', async () => {
  const { handlers, calls } = loadSw();
  assert.ok(handlers.install, 'sw.js registers an install handler');
  const outcome = await fireEvent(handlers.install, 'install');
  assert.equal(outcome, 'SETTLED: resolved',
    'install must never leave waitUntil pending — that is the whole bug');
  assert.deepEqual(calls.addAll, [PRECACHE], 'precache goes through ONE cache.addAll');
  assert.equal(calls.skipWaiting, 1, 'install calls skipWaiting exactly once');
  assert.deepEqual(calls.opened, ['ezone-dashboard-' + loadSw().exports.CACHE_VERSION]);
});

test('C: install still SETTLES when the precache fails, so activate is still reached', async () => {
  const { handlers, calls } = loadSw({ addAllRejects: true });
  const outcome = await fireEvent(handlers.install, 'install');
  assert.equal(outcome, 'SETTLED: resolved',
    'a failed precache must degrade the offline shell, never wedge the worker');
  assert.equal(calls.skipWaiting, 1, 'and the worker still proceeds to activate');
});

test('C: install no longer swallows per-entry failures with an empty catch', () => {
  const install = SW_SRC.slice(SW_SRC.indexOf("addEventListener('install'"));
  const body = install.slice(0, install.indexOf("addEventListener('activate'"));
  assert.ok(!/cache\.add\(/.test(body), 'the per-entry cache.add loop is gone');
  assert.ok(/cache\.addAll\(PRECACHE_URLS\)/.test(body));
  assert.ok(!/catch\(function \(\) \{ \/\* non-fatal \*\/ \}\)/.test(body),
    'the empty catch that hid the Vary TypeError is gone');
});

/* ================= D. activate purges every stale cache ================= */

test('D: activate deletes every cache whose name is not the current one, then claims', async () => {
  const current = 'ezone-dashboard-' + loadSw().exports.CACHE_VERSION;
  /* The exact pile-up the live site reported, minus whatever the current name
   * is — derived, so this stays a real guard whatever the version becomes. */
  const stale = ['v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v13', 'v14']
    .map((v) => 'ezone-dashboard-' + v)
    .filter((n) => n !== current)
    .concat(['some-unrelated-cache']);
  const { handlers, calls } = loadSw({ existingCaches: stale.concat([current]) });
  assert.ok(handlers.activate, 'sw.js registers an activate handler');
  const outcome = await fireEvent(handlers.activate, 'activate');
  assert.equal(outcome, 'SETTLED: resolved');
  assert.deepEqual(calls.deleted.sort(), stale.slice().sort(),
    'every non-current cache is deleted');
  assert.ok(calls.deleted.indexOf(current) < 0, 'the current cache is never deleted');
  assert.equal(calls.claim, 1, 'clients.claim() is called once');
});

test('D: the cache version was bumped off the stuck value', () => {
  const { exports: sw } = loadSw();
  assert.notEqual(sw.CACHE_VERSION, 'v14', 'v14 is the version that could never install');
  assert.equal(sw.CACHE_VERSION, 'v15');
  assert.equal(sw.CACHE_NAME, 'ezone-dashboard-v15');
});

/* ================= E. how the server serves it ================= */

test('E: /sw.js is served unauthenticated, 200, JS, with Cache-Control no-cache', async () => {
  await withServer(async (port) => {
    // No cookie at all — the PIN gate must not apply to the worker script.
    const res = await get(port, '/sw.js');
    assert.equal(res.status, 200, '/sw.js must not be behind the PIN gate');
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.match(String(res.headers['cache-control']), /no-cache/,
      'the worker script must never be HTTP-cached across deploys');
    assert.match(res.body, /CACHE_VERSION = 'v15'/, 'it serves the real file');
    // The route is registered plainly, with no auth middleware.
    assert.ok(SERVER_SRC.includes("app.get('/sw.js', sendStatic('sw.js', 'application/javascript'));"));
    assert.ok(!/app\.get\('\/sw\.js',\s*require/.test(SERVER_SRC));
  });
});

test('E: NO response carries `Vary: *` — the header that broke every precache write', async () => {
  await withServer(async (port) => {
    for (const p of ['/sw.js', '/', '/style.css', '/manifest.json', '/icons/icon-192.png']) {
      const res = await get(port, p);
      assert.equal(res.status, 200, p);
      assert.notEqual(res.headers.vary, '*',
        `${p} still sends Vary: * — the Cache API cannot store it`);
    }
  });
  assert.ok(!/res\.set\('Vary'/.test(SERVER_SRC), 'noCache() must not set Vary at all');
});

test('E: the precache URLs are all reachable unauthenticated and cacheable', async () => {
  await withServer(async (port) => {
    for (const url of PRECACHE) {
      const res = await get(port, url);
      assert.equal(res.status, 200, `${url} must be served without a session`);
      assert.notEqual(res.headers.vary, '*', `${url} must be storable by the Cache API`);
    }
  });
});

test('E: /api/ routes are still session-gated (the fix weakened nothing)', async () => {
  await withServer(async (port) => {
    for (const p of ['/api/sheets?action=getData', '/api/me']) {
      const res = await get(port, p);
      assert.equal(res.status, 401, `${p} must still refuse an unauthenticated caller`);
    }
  });
});
