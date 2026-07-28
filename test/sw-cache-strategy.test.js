/* Tests for two fixes:
 *   1. public/sw.js — the fetch-routing change: app.js/style.css move from
 *      cache-first to network-first (so the ?v= cache-bust is honored and a new
 *      deploy is never pinned to a stale bundle), API/Sheets stay network-only,
 *      and versioned-by-filename assets (icons, manifest) stay cache-first.
 *      CACHE_VERSION is bumped so existing caches are evicted.
 *   2. public/app.js — openWhatsAppLink: window.open first, location.href
 *      fallback when window.open returns null (installed standalone PWA).
 *
 * Both files are browser scripts (SW globals / DOM), so — per the repo's
 * vm-sandbox convention — we read the source and evaluate it with the globals
 * stubbed, then read the exported/exposed pure functions. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ---------- load public/sw.js (module.exports) ---------- */
function loadSw() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const noop = () => {};
  const moduleObj = { exports: {} };
  const sandbox = {
    self: { addEventListener: noop, skipWaiting: noop, clients: { claim: noop } },
    caches: {
      open: () => Promise.resolve({ add: noop, put: noop }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    Promise, URL, console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return moduleObj.exports;
}

/* ---------- load public/app.js (openWhatsAppLink) ---------- */
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `globalThis.__test = { openWhatsAppLink: (u, o, s) => openWhatsAppLink(u, o, s) };`;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const sw = loadSw();
const app = loadApp();

/* ===== 1. SW fetch-strategy routing ===== */

test('app.js and style.css route to NETWORK-FIRST (honor the ?v= cache-bust)', () => {
  assert.strictEqual(sw.cacheStrategy('https://app.test/app.js'), 'network-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/app.js?v=1751900000-abc123'), 'network-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/style.css'), 'network-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/style.css?v=deadbeef'), 'network-first');
});

test('the app shell routes to NETWORK-FIRST', () => {
  assert.strictEqual(sw.cacheStrategy('https://app.test/'), 'network-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/index.html'), 'network-first');
});

test('API / Sheets requests route to NETWORK-ONLY (never cached)', () => {
  assert.strictEqual(sw.cacheStrategy('https://app.test/api/sheets?action=getData'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://app.test/sheets'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://app.test/api/verify-pin'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://app.test/api/outpatient-lead'), 'network-only');
});

test('versioned-by-filename assets (icons, manifest) route to CACHE-FIRST', () => {
  assert.strictEqual(sw.cacheStrategy('https://app.test/manifest.json'), 'cache-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/icons/icon-192.png'), 'cache-first');
  assert.strictEqual(sw.cacheStrategy('https://app.test/icons/icon-maskable-512.png'), 'cache-first');
});

test('unknown paths route to the plain NETWORK default', () => {
  assert.strictEqual(sw.cacheStrategy('https://app.test/some/other/thing'), 'network');
  assert.strictEqual(sw.cacheStrategy('https://app.test/favicon.ico'), 'network');
});

test('shouldCache is the derived cache-first boolean', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/icons/icon-192.png'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/manifest.json'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/app.js'), false);   // network-first
  assert.strictEqual(sw.shouldCache('https://app.test/style.css'), false); // network-first
  assert.strictEqual(sw.shouldCache('https://app.test/api/sheets'), false); // network-only
});

/* ===== 2. CACHE_VERSION was bumped ===== */

test('CACHE_VERSION differs from the previous value (v4) so old caches evict', () => {
  const PREVIOUS = 'v4';
  assert.notStrictEqual(sw.CACHE_VERSION, PREVIOUS, 'CACHE_VERSION must change to evict old caches');
  assert.match(sw.CACHE_VERSION, /^v\d+$/);
  // And it moved forward, not backward.
  const n = Number(String(sw.CACHE_VERSION).replace(/^v/, ''));
  assert.ok(n > 4, 'CACHE_VERSION (' + sw.CACHE_VERSION + ') must be > v4');
  assert.strictEqual(sw.CACHE_NAME, 'ezone-dashboard-' + sw.CACHE_VERSION);
});

/* ===== 3. WhatsApp click fallback ===== */

const URL_ = 'https://wa.me/972527046671?text=hi';

test('falls back to location.href when window.open returns null', () => {
  let hrefSet = null;
  const opener = () => null;                     // standalone / blocked
  const setHref = (u) => { hrefSet = u; };
  const result = app.openWhatsAppLink(URL_, opener, setHref);
  assert.strictEqual(hrefSet, URL_, 'location.href fallback fires with the url');
  assert.strictEqual(result, 'href');
});

test('does NOT touch location.href when window.open returns a window', () => {
  let hrefSet = null;
  const opener = () => ({});                      // a real window handle
  const setHref = (u) => { hrefSet = u; };
  const result = app.openWhatsAppLink(URL_, opener, setHref);
  assert.strictEqual(hrefSet, null, 'no same-window navigation when a tab opened');
  assert.strictEqual(result, 'window');
});

test('passes the wa.me url and _blank/noopener to the opener', () => {
  const seen = [];
  const opener = (u, target, features) => { seen.push([u, target, features]); return {}; };
  app.openWhatsAppLink(URL_, opener, () => {});
  assert.deepStrictEqual(Array.from(seen[0]), [URL_, '_blank', 'noopener']);
});
