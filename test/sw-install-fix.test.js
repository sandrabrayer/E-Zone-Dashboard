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
  const calls = { skipWaiting: 0, claim: 0, addAll: [], deleted: [], opened: [], put: [], fetched: [] };
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
    put: (key, res) => {
      calls.put.push(String(key && key.url ? key.url : key));
      return opts.putRejects ? Promise.reject(new TypeError('Response is a redirect')) : Promise.resolve();
    },
  };

  /* A stand-in Response. `Response.error()` is what a service worker hands to
   * respondWith() when it has nothing to serve — the graceful failure, as
   * opposed to undefined or a rejected promise. */
  function FakeResponse(tag) { this.tag = tag; this.status = tag === 'error' ? 0 : 200; this.type = tag; }
  FakeResponse.prototype.clone = function () { return new FakeResponse(this.tag); };
  FakeResponse.error = () => new FakeResponse('error');

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
      // A cache HIT only when the test asks for one.
      match: () => Promise.resolve(opts.cacheHit ? new FakeResponse('cached') : undefined),
    },
    // `offline: true` makes every network attempt reject, as it does with no
    // connection. Otherwise the network answers 200.
    fetch: (req) => {
      calls.fetched.push(String(req && req.url ? req.url : req));
      return opts.offline ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new FakeResponse('network'));
    },
    Response: FakeResponse,
    Promise, URL, TypeError, Array, String,
    console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, calls, exports: moduleObj.exports };
}

/* Drive the fetch handler for one GET url and return what it served:
 * a FakeResponse, the string 'NOT INTERCEPTED' (no respondWith — the browser
 * goes straight to the network), or 'REJECTED: …' / 'UNDEFINED', both of which
 * are bugs. */
function serve(handlers, url) {
  let promise = 'NOT INTERCEPTED';
  handlers.fetch({
    request: { method: 'GET', url: url },
    respondWith: (p) => { promise = p; },
  });
  if (promise === 'NOT INTERCEPTED') return Promise.resolve(promise);
  return Promise.resolve(promise).then(
    (r) => (r === undefined ? 'UNDEFINED' : r),
    (e) => 'REJECTED: ' + e,
  );
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

test('D: the cache version is off the stuck value and still climbing', () => {
  const { exports: sw } = loadSw();
  /* Version-agnostic on purpose: routine bumps ship with ordinary changes
   * (v15 → v16 came with the DD/MM/YYYY date display). What must never come
   * back is v14 or lower — v14 is the version that could not install, and the
   * cleanup that clears v4…v14 depends on the current name being past it. */
  const n = Number(/^v(\d+)$/.exec(sw.CACHE_VERSION)[1]);
  assert.ok(n >= 15, 'CACHE_VERSION must be v15 or later, got ' + sw.CACHE_VERSION);
  assert.equal(sw.CACHE_NAME, 'ezone-dashboard-' + sw.CACHE_VERSION);
});

/* ================= F. the fetch handler, now that it actually runs =========
 * The worker has not controlled a page in ten versions. Everything below was
 * unreachable in practice and is reachable from the next deploy on. */

test('F(a): the shell and navigations are NETWORK-FIRST — a deploy is never masked', async () => {
  const sw = loadSw().exports;
  assert.equal(sw.cacheStrategy('https://x/'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/index.html'), 'network-first');
  // Online: the network answer is served and the cache is refreshed under the
  // precached '/' key, whichever of the two paths was requested.
  for (const url of ['https://x/', 'https://x/index.html']) {
    const { handlers, calls } = loadSw();
    const res = await serve(handlers, url);
    assert.equal(res.tag, 'network', url + ' must be served from the network while online');
    assert.deepEqual(calls.put, ['/'], 'the shell is refreshed under its precached key');
  }
  // Any other navigation is passed straight through — no shell is substituted.
  assert.equal(sw.cacheStrategy('https://x/meeting-report'), 'network');
  const { handlers } = loadSw();
  assert.equal(await serve(handlers, 'https://x/meeting-report'), 'NOT INTERCEPTED');
});

test('F(b): /style.css and /app.js are NETWORK-FIRST, not cache-first', async () => {
  const sw = loadSw().exports;
  assert.equal(sw.cacheStrategy('https://x/style.css'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/app.js'), 'network-first');
  // Even with a cached copy present, the network answer wins while online —
  // which is why no test needs to pin "bump sw.js when style.css changes":
  // the cached copy is an OFFLINE fallback, never the served bundle.
  for (const url of ['https://x/style.css', 'https://x/app.js?v=build-123']) {
    const { handlers } = loadSw({ cacheHit: true });
    const res = await serve(handlers, url);
    assert.equal(res.tag, 'network', url + ' must not be served from cache while online');
  }
  assert.ok(!/path === '\/app\.js'[\s\S]{0,60}'cache-first'/.test(SW_SRC));
});

test('F(c): /api/ and Sheets are NETWORK-ONLY — never intercepted, never cached', async () => {
  const sw = loadSw().exports;
  /* The browser only ever reaches Apps Script through the /api/sheets proxy —
   * server.js holds the /exec URL; nothing in the page calls script.google.com
   * directly. Both rules are exercised: the '/api/' path test and the literal
   * 'sheets' substring test. */
  const dataUrls = [
    'https://x/api/sheets?action=getData',
    'https://x/api/me',
    'https://x/api/verify-pin',
    'https://x/api/debug/last-save',
    'https://x/some/proxy/sheets?action=saveAll',
  ];
  for (const url of dataUrls) {
    assert.equal(sw.cacheStrategy(url), 'network-only', url);
    const { handlers, calls } = loadSw({ cacheHit: true });
    assert.equal(await serve(handlers, url), 'NOT INTERCEPTED',
      url + ' must never be handled by the worker');
    assert.deepEqual(calls.put, [], 'and nothing is ever written to the cache for it');
  }
  // Belt and braces: no cache-writing helper can ever be reached for them.
  assert.ok(!PRECACHE.some((u) => u.indexOf('/api/') === 0));
  /* An unrecognized URL routes to 'network' — also pass-through, also never
   * cached. Only 'network-first' and 'cache-first' ever call respondWith. */
  assert.equal(sw.cacheStrategy('https://script.google.com/macros/s/AK/exec'), 'network');
  const { handlers, calls } = loadSw({ cacheHit: true });
  assert.equal(await serve(handlers, 'https://script.google.com/macros/s/AK/exec'), 'NOT INTERCEPTED');
  assert.deepEqual(calls.put, []);
});

test('F(d): a cache miss with the network down degrades gracefully — never undefined, never a rejection', async () => {
  // network-first, offline, nothing cached → Response.error()
  {
    const { handlers } = loadSw({ offline: true, cacheHit: false });
    const res = await serve(handlers, 'https://x/style.css');
    assert.notEqual(res, 'UNDEFINED');
    assert.ok(typeof res !== 'string', 'must not reject: ' + res);
    assert.equal(res.tag, 'error');
  }
  // network-first, offline, cached → the cached copy
  {
    const { handlers } = loadSw({ offline: true, cacheHit: true });
    const res = await serve(handlers, 'https://x/style.css');
    assert.equal(res.tag, 'cached', 'the offline fallback is the point of precaching');
  }
  // cache-first, offline, nothing cached → Response.error() (this is the path
  // that used to reject with no catch at all)
  for (const url of ['https://x/icons/icon-512.png', 'https://x/manifest.json']) {
    const { handlers } = loadSw({ offline: true, cacheHit: false });
    const res = await serve(handlers, url);
    assert.notEqual(res, 'UNDEFINED', url);
    assert.ok(typeof res !== 'string', url + ' must not reject: ' + res);
    assert.equal(res.tag, 'error', url);
  }
  // cache-first, offline, cached → the cached copy
  {
    const { handlers } = loadSw({ offline: true, cacheHit: true });
    assert.equal((await serve(handlers, 'https://x/icons/icon-512.png')).tag, 'cached');
  }
});

test('F(d): a failing cache.put never disturbs the response or leaks a rejection', async () => {
  for (const url of ['https://x/style.css', 'https://x/icons/icon-512.png']) {
    const { handlers } = loadSw({ putRejects: true });
    const res = await serve(handlers, url);
    assert.ok(typeof res !== 'string', url + ' must still be served: ' + res);
    assert.equal(res.tag, 'network');
  }
  // Both put sites are guarded in the source.
  const puts = SW_SRC.match(/cache\.put\([^)]*\)/g) || [];
  assert.equal(puts.length, 2, 'exactly the two cache.put call sites');
  assert.equal((SW_SRC.match(/cache refresh is best-effort|cache write is best-effort/g) || []).length, 2,
    'each one carries its own catch');
});

test('F: non-GET requests are never intercepted', () => {
  const { handlers } = loadSw();
  let responded = false;
  handlers.fetch({ request: { method: 'POST', url: 'https://x/api/sheets' }, respondWith: () => { responded = true; } });
  assert.equal(responded, false);
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
    assert.match(res.body, /CACHE_VERSION = 'v\d+'/, 'it serves the real file');
    assert.ok(res.body.includes(fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8').trim().slice(-60)),
      'byte-for-byte the file on disk');
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

test('E: noCache() still sets no-store, no-cache AND private on every response', async () => {
  /* Removing `Vary: *` must not have weakened the no-caching posture. This is
   * asserted on what the server actually EMITS, across every kind of route:
   * the precached statics, the worker script, a data endpoint's 401 and the
   * unauthenticated health check. */
  await withServer(async (port) => {
    const paths = [
      '/', '/index.html', '/sw.js', '/app.js', '/style.css', '/manifest.json',
      '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
      '/api/sheets?action=getData', '/api/me', '/healthz', '/definitely-not-a-route',
    ];
    for (const p of paths) {
      const res = await get(port, p);
      const cc = String(res.headers['cache-control'] || '');
      assert.match(cc, /\bno-store\b/, `${p} lost no-store`);
      assert.match(cc, /\bno-cache\b/, `${p} lost no-cache`);
      assert.match(cc, /\bprivate\b/, `${p} lost private`);
      assert.match(cc, /\bmust-revalidate\b/, `${p} lost must-revalidate`);
      assert.match(cc, /\bmax-age=0\b/, `${p} lost max-age=0`);
      assert.equal(res.headers.pragma, 'no-cache', `${p} lost Pragma`);
      assert.equal(res.headers.expires, '0', `${p} lost Expires`);
      // The CDN directives are the ones that actually replaced Vary: *'s job.
      assert.equal(res.headers['surrogate-control'], 'no-store', `${p} lost Surrogate-Control`);
      assert.equal(res.headers['cdn-cache-control'], 'no-store', `${p} lost CDN-Cache-Control`);
      assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store', `${p} lost Cloudflare-CDN-Cache-Control`);
      assert.notEqual(res.headers.vary, '*', `${p} still sends Vary: *`);
    }
  });
  // …and noCache is still applied to EVERY response, before any route runs.
  assert.match(SERVER_SRC, /app\.use\(\(_req, res, next\) => \{ noCache\(res\); next\(\); \}\);/);
  assert.match(SERVER_SRC, /res\.set\('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private'\);/);
});

test('E: /api/ routes are still session-gated (the fix weakened nothing)', async () => {
  await withServer(async (port) => {
    for (const p of ['/api/sheets?action=getData', '/api/me']) {
      const res = await get(port, p);
      assert.equal(res.status, 401, `${p} must still refuse an unauthenticated caller`);
    }
  });
});
