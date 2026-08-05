/* Frontend unit test: apiGet/apiPost flip to the PIN screen on a 401.
 *
 * Same vm-sandbox approach as the other public/app.js tests: read the source,
 * append an epilogue exposing the functions, evaluate with browser globals
 * stubbed. Here the stubs are richer — a tiny fake DOM (so showPinScreen can
 * toggle #pin-screen / #app classes) and a swappable fetch — so we can drive the
 * 401 path and assert the PIN overlay is revealed and the app hidden. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeEl(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    has: (c) => classes.has(c),
    focus() {},
    addEventListener() {},
  };
}

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      apiGet: (p) => apiGet(p),
      apiPost: (b) => apiPost(b),
      showPinScreen: () => showPinScreen(),
    };
  `;
  const registry = {};
  // Seed the elements the PIN flow touches. #pin-screen starts hidden (as in
  // index.html); #app starts visible so we can observe it being hidden.
  registry['pin-screen'] = fakeEl('pin-screen'); registry['pin-screen'].classList.add('hidden');
  registry['app'] = fakeEl('app');
  registry['pin-input'] = fakeEl('pin-input');

  let fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) });
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop,
      getElementById: (id) => registry[id] || (registry[id] = fakeEl(id)),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
    fetch: (...a) => fetchImpl(...a),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, registry, setFetch: (f) => { fetchImpl = f; } };
}

test('apiGet on a 401 reveals the PIN screen and hides the app, then throws', async () => {
  const { app, registry, setFetch } = load();
  setFetch(async () => ({ status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) }));

  await assert.rejects(() => app.apiGet({ action: 'getData' }), /unauthorized/);
  assert.strictEqual(registry['pin-screen'].has('hidden'), false, 'pin-screen must be revealed');
  assert.strictEqual(registry['app'].has('hidden'), true, 'app must be hidden');
});

test('apiPost on a 401 reveals the PIN screen and throws', async () => {
  const { app, registry, setFetch } = load();
  setFetch(async () => ({ status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) }));

  await assert.rejects(() => app.apiPost({ action: 'saveAll' }), /unauthorized/);
  assert.strictEqual(registry['pin-screen'].has('hidden'), false);
  assert.strictEqual(registry['app'].has('hidden'), true);
});

test('apiGet on a 200 does NOT reveal the PIN screen', async () => {
  const { app, registry, setFetch } = load();
  setFetch(async () => ({ status: 200, ok: true, json: async () => ({ ok: true, leads: [] }) }));

  const data = await app.apiGet({ action: 'getData' });
  assert.deepStrictEqual(data, { ok: true, leads: [] });
  assert.strictEqual(registry['pin-screen'].has('hidden'), true, 'pin-screen stays hidden on success');
});
