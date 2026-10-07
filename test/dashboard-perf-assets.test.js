'use strict';
/* Dashboard perf — static delivery (CHANGELOG-dashboard-perf.md).
 *
 *   A. lib/static-assets.js: content hash, encoding negotiation, the asset
 *      store (memo + hot-redeploy rebuild), index.html reference rewriting.
 *   B. server.js over HTTP: index.html links every JS/CSS file at its own
 *      hash; `?v=<current hash>` is immutable + compressed; anything else is
 *      no-store as before; sw.js is untouched; bytes round-trip exactly.
 *   C. sendCompressedText (index.html + every Apps Script JSON answer).
 *   D. sw.js v39: 'cache-first-hashed' — exact-URL hits, a new hash is a
 *      miss (a deploy is never pinned), older hashes pruned, offline fallback.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const vm = require('node:vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const SA = require('../lib/static-assets');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const FILES = {
  '/app.js': path.join(ROOT, 'public', 'app.js'),
  '/style.css': path.join(ROOT, 'public', 'style.css'),
  '/funder.js': path.join(ROOT, 'public', 'funder.js'),
  '/payment-report-rules.js': path.join(ROOT, 'lib', 'payment-report-rules.js'),
  '/billing-control-rules.js': path.join(ROOT, 'lib', 'billing-control-rules.js'),
};

/* ===================================================================== */
/* A. lib/static-assets.js                                                */
/* ===================================================================== */

test('A: contentHash is 12 hex chars of sha256 and changes with the bytes', () => {
  assert.equal(SA.contentHash(Buffer.from('a')), sha12(Buffer.from('a')));
  assert.match(SA.contentHash(Buffer.from('a')), /^[0-9a-f]{12}$/);
  assert.notEqual(SA.contentHash(Buffer.from('a')), SA.contentHash(Buffer.from('b')));
});

test('A: negotiateEncoding prefers br, honours q=0, falls back to identity', () => {
  assert.equal(SA.negotiateEncoding('gzip, deflate, br'), 'br');
  assert.equal(SA.negotiateEncoding('gzip, deflate'), 'gzip');
  assert.equal(SA.negotiateEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(SA.negotiateEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(SA.negotiateEncoding(''), null);
  assert.equal(SA.negotiateEncoding(undefined), null);
  assert.equal(SA.negotiateEncoding('identity'), null);
  assert.equal(SA.negotiateEncoding('GZIP'), 'gzip');
});

test('A: the store memoizes per content version and rebuilds on a hot redeploy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezone-assets-'));
  try {
    const file = path.join(dir, 'x.js');
    fs.writeFileSync(file, 'var a = 1;\n'.repeat(400));
    const store = SA.createAssetStore({ '/x.js': { file, mime: 'application/javascript' } });
    const e1 = store.get('/x.js');
    assert.strictEqual(store.get('/x.js'), e1, 'same entry while the file is unchanged');
    assert.equal(e1.hash, sha12(fs.readFileSync(file)));
    assert.deepEqual(zlib.gunzipSync(e1.gzip), e1.body);
    assert.deepEqual(zlib.brotliDecompressSync(e1.br), e1.body);
    fs.writeFileSync(file, 'var b = 2;\n'.repeat(500));
    const e2 = store.get('/x.js');
    assert.notEqual(e2.hash, e1.hash, 'new bytes → new hash');
    assert.deepEqual(e2.body, fs.readFileSync(file));
    assert.equal(store.get('/nope.js'), null);
    fs.rmSync(file);
    assert.equal(store.get('/x.js'), null, 'a missing file is null, never a throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A: a tiny file is not compressed (it would only grow)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezone-assets-'));
  try {
    const file = path.join(dir, 't.js');
    fs.writeFileSync(file, 'x');
    const e = SA.createAssetStore({ '/t.js': { file, mime: 'application/javascript' } }).get('/t.js');
    assert.equal(e.gzip, null);
    assert.equal(e.br, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A: versionAssetRefs pins all five files in the real index.html — and only them', () => {
  const store = SA.createAssetStore(Object.fromEntries(Object.entries(FILES)
    .map(([u, f]) => [u, { file: f, mime: 'text/plain' }])));
  const out = SA.versionAssetRefs(INDEX_SRC, store);
  for (const [u, f] of Object.entries(FILES)) {
    const name = u.slice(1);
    const h = sha12(fs.readFileSync(f));
    assert.ok(out.includes(name + '?v=' + h + '"'), name + ' carries its own hash');
  }
  assert.ok(!/(app|funder|payment-report-rules|billing-control-rules)\.js\?v=__BUILD__/.test(out));
  assert.ok(!out.includes('href="style.css"'), 'style.css is no longer unversioned');
  // The build markers still carry __BUILD__ for the BUILD_ID substitution.
  assert.match(out, /<meta name="build" content="__BUILD__"/);
  assert.match(out, /data-build="__BUILD__"/);
  // Nothing else in the page changed.
  const strip = (h) => h.replace(/\?v=[0-9a-f]{12}/g, '').replace(/\?v=__BUILD__/g, '');
  assert.equal(strip(out), strip(INDEX_SRC));
});

test('A: isCurrentVersion — only the exact current hash', () => {
  const e = { hash: 'abcdef012345' };
  assert.equal(SA.isCurrentVersion('abcdef012345', e), true);
  assert.equal(SA.isCurrentVersion('abcdef012346', e), false);
  assert.equal(SA.isCurrentVersion('1791268601666-buu90z', e), false, 'the old BUILD_ID');
  assert.equal(SA.isCurrentVersion(undefined, e), false);
  assert.equal(SA.isCurrentVersion(['abcdef012345'], e), false, 'a repeated ?v= arrives as an array');
  assert.equal(SA.isCurrentVersion('abcdef012345', null), false);
});

/* ===================================================================== */
/* B. server.js over HTTP                                                 */
/* ===================================================================== */

let server;
let base;
before(async () => {
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise((r) => server.close(r)));

/* Raw GET (no automatic decompression). */
function get(urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function decode(r) {
  const enc = r.headers['content-encoding'];
  if (enc === 'br') return zlib.brotliDecompressSync(r.body);
  if (enc === 'gzip') return zlib.gunzipSync(r.body);
  return r.body;
}
const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0, private';

test('B: GET / links every JS/CSS file at its current content hash, compressed, still no-store', async () => {
  const r = await get('/', { 'accept-encoding': 'gzip, br' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], NO_STORE, 'the page itself is never cached');
  assert.ok(['br', 'gzip'].includes(r.headers['content-encoding']));
  assert.match(r.headers.vary || '', /Accept-Encoding/);
  const html = decode(r).toString('utf8');
  for (const [u, f] of Object.entries(FILES)) {
    assert.ok(html.includes(u.slice(1) + '?v=' + sha12(fs.readFileSync(f)) + '"'), u);
  }
  assert.ok(!html.includes('__BUILD__'));
});

test('B: GET / without Accept-Encoding is plain HTML, byte-identical in content', async () => {
  const r = await get('/');
  assert.equal(r.headers['content-encoding'], undefined);
  assert.match(r.body.toString('utf8'), /<script src="app\.js\?v=[0-9a-f]{12}"><\/script>/);
});

for (const [u, f] of Object.entries(FILES)) {
  test('B: ' + u + '?v=<current hash> → immutable, compressed, exact bytes', async () => {
    const bytes = fs.readFileSync(f);
    const r = await get(u + '?v=' + sha12(bytes), { 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const h of ['pragma', 'expires', 'surrogate-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) {
      assert.equal(r.headers[h], undefined, h + ' (no-store) is removed, not contradicted');
    }
    assert.equal(r.headers['content-encoding'], 'br');
    assert.deepEqual(decode(r), bytes);
    assert.ok(r.body.length < bytes.length * 0.5, 'br at least halves it');
  });
}

test('B: no ?v=, an old hash, or the old BUILD_ID → no-store as before (never pins old bytes)', async () => {
  const bytes = fs.readFileSync(FILES['/app.js']);
  for (const q of ['', '?v=000000000000', '?v=1791268601666-buu90z']) {
    const r = await get('/app.js' + q, { 'accept-encoding': 'gzip' });
    assert.equal(r.status, 200, q);
    assert.equal(r.headers['cache-control'], NO_STORE, q);
    assert.equal(r.headers.pragma, 'no-cache', q);
    assert.equal(r.headers['content-encoding'], 'gzip', q);
    assert.deepEqual(decode(r), bytes, q + ': always the CURRENT file');
  }
});

test('B: no Accept-Encoding → identity bytes, application/javascript / text/css', async () => {
  const r = await get('/app.js');
  assert.equal(r.headers['content-encoding'], undefined);
  assert.match(r.headers['content-type'], /^application\/javascript/);
  assert.deepEqual(r.body, fs.readFileSync(FILES['/app.js']));
  const c = await get('/style.css');
  assert.match(c.headers['content-type'], /^text\/css/);
});

test('B: /sw.js is served exactly as before — never cacheable, never compressed', async () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'));
  const r = await get('/sw.js?v=' + sha12(sw), { 'accept-encoding': 'br, gzip' });
  assert.equal(r.headers['cache-control'], NO_STORE);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.deepEqual(r.body, sw);
});

test('B: the page-load payload — raw vs what a browser downloads', async () => {
  let raw = 0;
  let wire = 0;
  for (const [u, f] of Object.entries(FILES)) {
    const bytes = fs.readFileSync(f);
    const r = await get(u + '?v=' + sha12(bytes), { 'accept-encoding': 'gzip, deflate, br' });
    raw += bytes.length;
    wire += r.body.length;
  }
  // CHANGELOG-dashboard-perf.md quotes these; the bound keeps it honest.
  assert.ok(wire < raw / 3.5, `wire ${wire} vs raw ${raw}`);
});

/* ===================================================================== */
/* C. sendCompressedText                                                  */
/* ===================================================================== */

test('C: the Apps Script JSON answer is redacted THEN compressed', () => {
  const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function sendAppsScriptJson('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /sendCompressedText\(res\.req, res, redactSecrets\(text, \[PROXY_SECRET\]\)\)/);
  assert.match(body, /res\.type\('application\/json'\);/);
});

test('C: sendCompressedText — gzip/br above 1 KB, plain below, exact text either way', async () => {
  const mini = express();
  const big = JSON.stringify({ ok: true, leads: Array.from({ length: 300 }, (_, i) => ({ id: 'l' + i, name: 'ליד ' + i })) });
  mini.get('/big', (req, res) => { res.type('application/json'); SA.sendCompressedText(req, res, big); });
  mini.get('/small', (req, res) => { res.type('application/json'); SA.sendCompressedText(req, res, '{"ok":true}'); });
  const s = http.createServer(mini);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = 'http://127.0.0.1:' + s.address().port;
  const fetchRaw = (p, h) => new Promise((resolve, reject) => {
    http.get(b + p, { headers: h || {} }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(c) }));
    }).on('error', reject);
  });
  try {
    const g = await fetchRaw('/big', { 'accept-encoding': 'gzip' });
    assert.equal(g.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(g.body).toString('utf8'), big);
    const br = await fetchRaw('/big', { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(br.body).toString('utf8'), big);
    const plain = await fetchRaw('/big');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString('utf8'), big);
    const small = await fetchRaw('/small', { 'accept-encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
    assert.equal(small.body.toString('utf8'), '{"ok":true}');
    assert.match(g.headers['content-type'], /^application\/json/);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

/* ===================================================================== */
/* D. sw.js — cache-first-hashed                                          */
/* ===================================================================== */

/* A Cache API stand-in with real exact / ignoreSearch matching and keys(). */
function loadSw(opts) {
  opts = opts || {};
  const store = new Map();   // url → tag
  const fetched = [];
  function FakeResponse(tag) { this.tag = tag; this.status = tag === 'error' ? 0 : 200; }
  FakeResponse.prototype.clone = function () { return new FakeResponse(this.tag); };
  FakeResponse.error = () => new FakeResponse('error');
  const urlOf = (k) => String(k && k.url ? k.url : k);
  const cache = {
    match: (req, o) => {
      const want = new URL(urlOf(req));
      for (const [u, tag] of store) {
        const have = new URL(u);
        const same = (o && o.ignoreSearch) ? have.pathname === want.pathname : u === want.href;
        if (same) return Promise.resolve(new FakeResponse(tag));
      }
      return Promise.resolve(undefined);
    },
    put: (req, res) => { store.set(new URL(urlOf(req)).href, res.tag); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(store.keys()).map((url) => ({ url }))),
    delete: (k) => Promise.resolve(store.delete(urlOf(k))),
  };
  const handlers = {};
  const moduleObj = { exports: {} };
  const sandbox = {
    self: { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: { open: () => Promise.resolve(cache), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true), match: (r, o) => cache.match(r, o) },
    fetch: (req) => {
      fetched.push(urlOf(req));
      return opts.offline ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new FakeResponse('network:' + urlOf(req)));
    },
    Response: FakeResponse,
    Promise, URL, TypeError, Array, String,
    console: { log() {}, warn() {}, error() {} },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, store, fetched, exports: moduleObj.exports, setOffline: (v) => { opts.offline = v; } };
}
function serve(handlers, url) {
  let p = 'NOT INTERCEPTED';
  handlers.fetch({ request: { method: 'GET', url }, respondWith: (x) => { p = x; } });
  return Promise.resolve(p);
}
const settle = () => new Promise((r) => setImmediate(r));

test('D: CACHE_VERSION is v44 (v43 deployed by this PR\'s base; v17 burned, never reused)', () => {
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  // v40: CHANGELOG-ortal-verification-status.md.
  // v41: CHANGELOG-reactivation-fix.md (PR #145's fix, re-landed).
  // v42: CHANGELOG-unadmitted-lead-warning.md.
  // v43: CHANGELOG-duplicate-discharges.md.
  // v44: CHANGELOG-receipt-duplicates-and-edit.md.
  assert.equal(v, 'v44');
  assert.notEqual(v, 'v17');
});

test('D: cacheStrategy — hashed bundle URLs cache-first-hashed, everything else unchanged', () => {
  const { exports: sw } = loadSw();
  for (const p of Object.keys(FILES)) {
    assert.equal(sw.cacheStrategy('https://x' + p + '?v=0123456789ab'), 'cache-first-hashed', p);
    assert.equal(sw.cacheStrategy('https://x' + p), 'network-first', p + ' unversioned');
    assert.equal(sw.cacheStrategy('https://x' + p + '?v=1791268601666-buu90z'), 'network-first', p + ' BUILD_ID');
    assert.equal(sw.cacheStrategy('https://x' + p + '?v=0123456789AB'), 'network-first', p + ' uppercase is not a hash');
  }
  assert.equal(sw.cacheStrategy('https://x/'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/api/sheets?action=getData&v=0123456789ab'), 'network-only', 'data never cached');
  assert.equal(sw.cacheStrategy('https://x/sw.js?v=0123456789ab'), 'network');
  assert.equal(sw.cacheStrategy('https://x/manifest.json'), 'cache-first');
  assert.equal(sw.cacheStrategy('https://x/meeting-report.js?v=0123456789ab'), 'network');
});

test('D: first load fetches and stores; the next load is served with NO network', async () => {
  const sw = loadSw();
  const url = 'https://x/app.js?v=0123456789ab';
  const r1 = await serve(sw.handlers, url);
  assert.equal(r1.tag, 'network:' + url);
  await settle();
  assert.ok(sw.store.has(url));
  const r2 = await serve(sw.handlers, url);
  assert.equal(sw.fetched.length, 1, 'the second load never touched the network');
  assert.equal(r2.tag, 'network:' + url);
});

test('D: a deploy (new hash) is a MISS — fetched, stored, and the old hash pruned', async () => {
  const sw = loadSw();
  sw.store.set('https://x/app.js?v=aaaaaaaaaaaa', 'old');
  sw.store.set('https://x/style.css?v=aaaaaaaaaaaa', 'css');
  const r = await serve(sw.handlers, 'https://x/app.js?v=bbbbbbbbbbbb');
  assert.equal(r.tag, 'network:https://x/app.js?v=bbbbbbbbbbbb', 'never the old bundle');
  await settle(); await settle();
  assert.ok(sw.store.has('https://x/app.js?v=bbbbbbbbbbbb'));
  assert.ok(!sw.store.has('https://x/app.js?v=aaaaaaaaaaaa'), 'old app.js pruned');
  assert.ok(sw.store.has('https://x/style.css?v=aaaaaaaaaaaa'), 'other files untouched');
});

test('D: offline + miss → the last cached copy of that file; nothing cached → Response.error()', async () => {
  const sw = loadSw({ offline: true });
  sw.store.set('https://x/app.js?v=aaaaaaaaaaaa', 'old');
  const r = await serve(sw.handlers, 'https://x/app.js?v=bbbbbbbbbbbb');
  assert.equal(r.tag, 'old');
  const e = await serve(sw.handlers, 'https://x/funder.js?v=bbbbbbbbbbbb');
  assert.equal(e.tag, 'error', 'a Response, never undefined or a rejection');
});
