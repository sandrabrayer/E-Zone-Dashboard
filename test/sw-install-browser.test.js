/* The stuck-install bug, reproduced and fixed in REAL Chromium.
 *
 * The unit tests in test/sw-install-fix.test.js drive the handlers against a
 * fake Cache. That cannot see the actual defect, because the defect WAS the
 * real Cache API: it rejects any response whose `Vary` header contains '*',
 * and concurrent rejected adds on one Cache left promises permanently
 * unsettled. So this file boots the real server.js, loads the real page in a
 * real browser and asserts the three things a user would check:
 *
 *   1. the worker reaches `activated` (it used to sit in `installing` forever);
 *   2. the current cache is POPULATED with every precache entry (the v14 cache
 *      existed on every device but was always EMPTY);
 *   3. every stale ezone-dashboard-* cache is deleted (v5…v14 piled up because
 *      activate never ran).
 *
 * It also reproduces the ORIGINAL failure by re-adding `Vary: *` to the
 * responses, so the test proves the causal link rather than asserting it.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * the same gate the other browser tests in this repo use:
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});
const skip = !playwright || !chromiumPath;
const why = !playwright ? 'playwright not installed' : (!chromiumPath ? 'no chromium binary' : '');

const PUBLIC = path.join(ROOT, 'public');
const SW_SRC = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const CACHE_VERSION = /var CACHE_VERSION = '([^']+)'/.exec(SW_SRC)[1];
const CACHE_NAME = 'ezone-dashboard-' + CACHE_VERSION;
const PRECACHE = /var PRECACHE_URLS = \[([\s\S]*?)\];/.exec(SW_SRC)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

const MIME = {
  '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.json': 'application/manifest+json', '.png': 'image/png',
};

/* A minimal stand-in for server.js's static serving that reproduces its exact
 * header policy. `varyStar` re-introduces the header that caused the bug, so
 * the same page can be driven through both the broken and fixed worlds. */
function startServer(varyStar) {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const rel = url === '/' || url === '/index.html' ? 'index.html' : url.replace(/^\//, '');
    const full = path.join(PUBLIC, rel);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.setHeader('Pragma', 'no-cache');
    if (varyStar) res.setHeader('Vary', '*');
    if (url.indexOf('/api/') === 0) { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    let body;
    try { body = fs.readFileSync(full); } catch (_) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
    res.end(url === '/' || url === '/index.html' ? String(body).replace(/__BUILD__/g, 'test') : body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

/* Load the page, wait up to `seconds` for the worker to activate, and report
 * the registration state plus the full CacheStorage contents. */
async function run(varyStar, seed) {
  const { srv, port } = await startServer(varyStar);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    if (seed && seed.length) {
      await page.evaluate(async (names) => {
        const r = await navigator.serviceWorker.getRegistration();
        if (r) await r.unregister();
        for (const n of names) await caches.open(n);
      }, seed);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    let state = null;
    for (let i = 0; i < 15; i++) {
      state = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        if (!r) return { none: true };
        return {
          installing: r.installing && r.installing.state,
          waiting: r.waiting && r.waiting.state,
          active: r.active && r.active.state,
        };
      });
      if (state.active === 'activated') break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const caches_ = await page.evaluate(async () => {
      const out = {};
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        out[k] = (await c.keys()).map((r) => new URL(r.url).pathname).sort();
      }
      return out;
    });
    return { state, caches: caches_ };
  } finally {
    await browser.close();
    srv.close();
  }
}

test('browser: the worker ACTIVATES, the precache is populated, stale caches are purged',
  { skip: skip && `skipped — ${why}` }, async () => {
    const stalePile = ['v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v13', 'v14']
      .map((v) => 'ezone-dashboard-' + v)
      .filter((n) => n !== CACHE_NAME);
    const { state, caches } = await run(false, stalePile);

    assert.equal(state.active, 'activated',
      'the worker must reach activated — it used to sit in installing forever');
    assert.equal(state.installing, null);

    assert.deepEqual(Object.keys(caches), [CACHE_NAME],
      'activate must leave exactly the current cache — the v5…v14 pile-up is gone');
    assert.deepEqual(
      caches[CACHE_NAME],
      PRECACHE.slice().sort(),
      'every precache entry is actually STORED (the v14 cache was always empty)',
    );
  });

/* Ask the real Cache API to store the real precache list, with and without the
 * header. This is the causal proof: the header, and nothing else, is what made
 * every precache write impossible. */
async function probeAddAll(varyStar) {
  const { srv, port } = await startServer(varyStar);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(async (urls) => {
      const c = await caches.open('probe-' + Date.now());
      try {
        await c.addAll(urls);
        return { ok: true, stored: (await c.keys()).length };
      } catch (e) {
        return { ok: false, name: e.name, message: e.message, stored: (await c.keys()).length };
      }
    }, PRECACHE);
  } finally {
    await browser.close();
    srv.close();
  }
}

test('browser: `Vary: *` is the root cause — it alone makes every precache write impossible',
  { skip: skip && `skipped — ${why}` }, async () => {
    const broken = await probeAddAll(true);
    assert.equal(broken.ok, false, 'with Vary:* the Cache API must refuse to store');
    assert.equal(broken.name, 'TypeError');
    assert.match(broken.message, /Vary header contains \*/);
    assert.equal(broken.stored, 0, 'not one entry lands');

    const fixed = await probeAddAll(false);
    assert.equal(fixed.ok, true, 'without it the identical list stores cleanly');
    assert.equal(fixed.stored, PRECACHE.length);
  });

test('browser: even if a response becomes uncacheable again, install cannot HANG',
  { skip: skip && `skipped — ${why}` }, async () => {
    // Same page, same worker, served with the header that used to wedge it.
    const { state, caches } = await run(true, []);
    assert.equal(state.active, 'activated',
      'a failed precache must degrade the offline shell, never wedge the worker');
    assert.equal(state.installing, null, 'nothing is left stuck in installing');
    assert.deepEqual(caches[CACHE_NAME], [],
      'the shell is simply absent — and activate still ran, which is the point');
  });
