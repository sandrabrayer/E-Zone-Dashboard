'use strict';

/* C16 (CHANGELOG-crm-pwa.md): the CRM shell as a PWA — same worker, same
 * manifest, the CRM bundle cached at its content hash; "/" stays network-first. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const CRM_HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const vm = require('node:vm');
function loadSw() {
  const noop = () => {};
  const moduleObj = { exports: {} };
  const sandbox = { self: { addEventListener: noop, skipWaiting: noop, clients: { claim: noop } },
    caches: { open: () => Promise.resolve({ add: noop, put: noop }), keys: () => Promise.resolve([]), match: () => Promise.resolve(undefined), delete: () => Promise.resolve(true) },
    Promise, URL, console: { log: noop, warn: noop, error: noop }, module: moduleObj };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return moduleObj.exports;
}
const sw = loadSw();

test('sw.js: v104 (monotonic from the live v93 via v94…v97, with their comments); CRM bundle cache-first at its hash, network-first otherwise; "/" network-first; data never cached', () => {
  assert.equal(/var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1], 'v104');
  assert.ok(SW_SRC.includes('v103 → v104:') && SW_SRC.includes('CHANGELOG-crm-clickable-kpis.md'));
  assert.ok(SW_SRC.includes('v102 → v103:') && SW_SRC.includes('CHANGELOG-crm-read-cache.md'));
  assert.ok(SW_SRC.includes('v101 → v102:') && SW_SRC.includes('CHANGELOG-crm-monday-look.md'));
  assert.ok(SW_SRC.includes('v100 → v101:') && SW_SRC.includes('CHANGELOG-crm-ortal-day.md'));
  assert.ok(SW_SRC.includes('v99 → v100:') && SW_SRC.includes('CHANGELOG-crm-contrast.md'));
  assert.ok(SW_SRC.includes('v98 → v99:') && SW_SRC.includes('CHANGELOG-crm-triage.md'));
  assert.ok(SW_SRC.includes('v96 → v97:') && SW_SRC.includes('CHANGELOG-crm-contact-panel.md'));
  assert.ok(SW_SRC.includes('v97 → v98:') && SW_SRC.includes('CHANGELOG-crm-my-day.md'));
  assert.ok(SW_SRC.includes('v95 → v96:') && SW_SRC.includes('CHANGELOG-undated-visit-leads.md'));
  assert.ok(SW_SRC.includes('v94 → v95:') && SW_SRC.includes('CHANGELOG-billing-search-any-patient.md'));
  assert.ok(SW_SRC.includes('v93 → v94:') && SW_SRC.includes('CHANGELOG-crm-pwa.md'));
  assert.equal(sw.cacheStrategy('https://x/crm/crm.js?v=0123456789ab'), 'cache-first-hashed');
  assert.equal(sw.cacheStrategy('https://x/crm/crm.css?v=0123456789ab'), 'cache-first-hashed');
  assert.equal(sw.cacheStrategy('https://x/crm/crm.js'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/?view=crm'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/?view=classic'), 'network-first');
  assert.equal(sw.cacheStrategy('https://x/api/sheets?action=getData'), 'network-only');
  assert.equal(sw.cacheStrategy('https://x/api/me'), 'network-only');
  assert.doesNotMatch(SW_SRC, /PRECACHE_URLS = \[[^\]]*crm/, 'the shell is not precached');
});

test('crm.html: manifest, theme colour, iOS tags, and the same guarded registration as index.html', () => {
  assert.match(CRM_HTML, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(CRM_HTML, /<meta name="theme-color" content="#E6ECF2">/, "light theme since Stage 2; contrast pass (CHANGELOG-crm-contrast.md)");
  assert.match(CRM_HTML, /apple-mobile-web-app-capable/);
  assert.match(CRM_HTML, /navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch/);
  assert.match(INDEX, /navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch/);
  assert.match(CRM_HTML, /window\.addEventListener\('load'/, 'registered after load, never blocking first paint');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
  assert.equal(manifest.start_url, '/', 'an installed app opens "/": the CRM after the switch, classic before');
  assert.equal(manifest.scope, '/');
});
