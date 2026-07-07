/* Tests for the PWA foundation (PR 1): the manifest is a valid, complete
 * web-app manifest, and the service worker's cache policy is correct —
 * specifically that patient-data requests ("sheets" / the /api path) are
 * NEVER cached and that the cache name is versioned.
 *
 * public/sw.js is a browser Service Worker: its top level calls
 * self.addEventListener(...) and touches `caches`, so it can't be `require`d
 * in Node. Following the repo's vm-sandbox convention (see
 * breakeven-revenue.test.js), we read the source and evaluate it in a vm
 * context with the SW globals stubbed, then read the shouldCache() decision
 * function and the cache-name constants off the module.exports the file
 * assigns for exactly this purpose. This exercises the REAL shipped code. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSw() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'sw.js'),
    'utf8'
  );

  const noop = () => {};
  const moduleObj = { exports: {} };
  const sandbox = {
    // Service Worker global surface — stubbed so the top-level listener
    // registrations and skipWaiting/clients.claim don't throw.
    self: {
      addEventListener: noop,
      skipWaiting: noop,
      clients: { claim: noop },
    },
    caches: {
      open: () => Promise.resolve({ add: noop, put: noop }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    Promise,
    URL,
    console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return moduleObj.exports;
}

const sw = loadSw();

/* ---------- manifest.json ---------- */

function loadManifest() {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'manifest.json'),
    'utf8'
  );
  return JSON.parse(raw); // throws (fails the test) if not valid JSON
}

test('manifest.json is valid JSON with the required PWA fields', () => {
  const m = loadManifest();
  assert.strictEqual(m.name, 'E-Zone Dashboard');
  assert.strictEqual(m.short_name, 'E-Zone');
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.dir, 'rtl');
  assert.strictEqual(m.lang, 'he');
  assert.strictEqual(m.start_url, '/');
  // theme + background colors must be present (palette match asserted loosely)
  assert.match(m.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.match(m.background_color, /^#[0-9a-fA-F]{6}$/);
});

test('manifest declares 192, 512 and a maskable icon', () => {
  const m = loadManifest();
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 3);
  const bySize = {};
  m.icons.forEach((ic) => { bySize[ic.sizes] = (bySize[ic.sizes] || []).concat(ic); });
  assert.ok(bySize['192x192'], 'has a 192x192 icon');
  assert.ok(bySize['512x512'], 'has a 512x512 icon');
  const maskable = m.icons.filter((ic) => (ic.purpose || '').indexOf('maskable') !== -1);
  assert.ok(maskable.length >= 1, 'has at least one maskable icon');
  m.icons.forEach((ic) => assert.strictEqual(ic.type, 'image/png'));
});

test('every manifest icon file exists on disk', () => {
  const m = loadManifest();
  m.icons.forEach((ic) => {
    const p = path.join(__dirname, '..', 'public', ic.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), 'missing icon file: ' + ic.src);
  });
});

/* ---------- service worker: cache name versioning ---------- */

test('cache name is versioned and carries the version string', () => {
  assert.ok(sw.CACHE_VERSION, 'CACHE_VERSION is exported');
  assert.match(sw.CACHE_VERSION, /^v\d+$/, 'version looks like v<N>');
  assert.ok(
    sw.CACHE_NAME.indexOf(sw.CACHE_VERSION) !== -1,
    'CACHE_NAME embeds CACHE_VERSION so bumping the version invalidates old caches'
  );
  assert.match(sw.CACHE_NAME, /^ezone-dashboard-v\d+$/);
});

/* ---------- service worker: sheets / data exclusion ---------- */

test('shouldCache is NETWORK-ONLY (false) for any URL containing "sheets"', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/api/sheets'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/sheets?action=getData'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/sheets'), false);
  // even a would-be static path is refused if "sheets" appears anywhere
  assert.strictEqual(sw.shouldCache('https://app.test/icons/sheets.png'), false);
});

test('shouldCache is NETWORK-ONLY (false) for any /api/ request', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/api/verify-pin'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/outpatient-lead'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/debug/env'), false);
});

test('shouldCache is CACHE-FIRST (true) for versioned static assets', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/app.js'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/app.js?v=1751900000-abc123'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/style.css'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/manifest.json'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/icons/icon-192.png'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/icons/icon-maskable-512.png'), true);
});

test('shouldCache is NOT cache-first for the shell (network-first handled separately)', () => {
  // "/" and "/index.html" are served network-first in the fetch handler, so
  // shouldCache must return false for them — otherwise they'd be cache-first
  // and could be served stale after a deploy.
  assert.strictEqual(sw.shouldCache('https://app.test/'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/index.html'), false);
});
