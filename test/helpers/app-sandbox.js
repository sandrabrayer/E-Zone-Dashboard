'use strict';

/* Test helper (not a test): the REAL public/app.js in a vm with a DOM-less
 * document, every render function stubbed, and fetch scripted. Shared by the
 * write-path-hardening suites (CHANGELOG-write-path-hardening.md). node --test
 * also loads this file; it defines no test.
 *
 * loadPage({ answerPost, src }) →
 *   run(expr)        evaluate an expression inside the page (state, functions)
 *   posts            every POST body sent, in order
 *   gets             every apiGet call: { action, params, d } with d a deferred
 *   errors / toasts  what showError / showToast were given
 *   renders          { billing, all } call counts
 *   visible()        fire the visibilitychange listener (tab visible again)
 *   deferGets(bool)  true (default): apiGet calls wait for d.resolve / d.reject;
 *                    false: apiGet answers answerGet(params) immediately
 * answerPost(body) → the JSON the POST answers (or a Promise of it). */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '', value: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function loadPage(opts) {
  const o = opts || {};
  const noop = () => {};
  const listeners = {};
  const posts = [];
  const gets = [];
  let deferGets = true;
  let answerGet = o.answerGet || (() => ({ ok: true }));
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      visibilityState: 'visible',
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => fakeEl(),
      createElement: () => fakeEl(),
      body: fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Funder: require(path.join(ROOT, 'public', 'funder.js')),
    crypto: require('node:crypto').webcrypto,
    fetch: (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push(body);
        return Promise.resolve(o.answerPost ? o.answerPost(body) : { ok: true })
          .then((data) => ({ ok: true, status: 200, json: () => Promise.resolve(data) }));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp,
    Promise, Set, Map, Error, TypeError, isFinite, parseFloat, parseInt, Uint8Array,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext((typeof o.src === 'string' ? o.src : APP_SRC) + `
    globalThis.__errors = []; globalThis.__toasts = []; globalThis.__renders = { billing: 0, all: 0, summary: 0, control: 0 };
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    renderAll = () => { globalThis.__renders.all++; };
    renderBilling = () => { globalThis.__renders.billing++; };
    renderBillingMonthlySummary = () => { globalThis.__renders.summary++; };
    renderBillingControl = () => { globalThis.__renders.control++; };
    renderDashboard = () => {}; renderPatientsTab = () => {}; renderCreditsPayouts = () => {};
    renderMeetings = () => {}; renderMeetingsUnseenBadge = () => {}; renderPatients = () => {};
    setSaving = () => {}; setLoading = () => {}; lockBusyDelay = () => Promise.resolve();
    markPayoutForecastStale = () => {};
  `, sandbox);
  const run = (expr) => vm.runInContext(expr, sandbox);
  // apiGet: deferred per call (default) or answered by answerGet.
  sandbox.__apiGet = (params) => {
    if (!deferGets) return Promise.resolve(answerGet(params));
    const d = deferred();
    gets.push({ action: params.action, params, d, taken: false });
    return d.promise;
  };
  run('apiGet = (p) => globalThis.__apiGet(p);');
  run("Object.assign(state, { mode: 'edit', finance: true })");
  return {
    sandbox, run, posts, gets, listeners,
    errors: sandbox.__errors, toasts: sandbox.__toasts, renders: sandbox.__renders,
    state: () => run('state'),
    set: (obj) => { sandbox.__set = obj; run('Object.assign(state, globalThis.__set)'); },
    visible: () => listeners.visibilitychange && listeners.visibilitychange(),
    deferGets: (on, fn) => { deferGets = on !== false; if (fn) answerGet = fn; },
    nextGet: (action) => gets.find((g) => g.action === action && !g.taken && (g.taken = true)),
  };
}

module.exports = { loadPage, deferred, tick, APP_SRC };
