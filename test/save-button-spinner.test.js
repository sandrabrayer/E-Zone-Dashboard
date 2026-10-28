/* Save-button spinner audit (CHANGELOG-save-button-spinner.md).
 *
 * 1. Guard: every form submit handler in public/app.js reaches busyButton()
 *    (spinner, disabled, re-entry ignored, restored in finally). A handler that
 *    is purely synchronous goes on the allowlist WITH a reason.
 * 2. Behavior: the meeting-report PIN page shows the busy ring, ignores a second
 *    click AND a second Enter while the request is in flight, and restores. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const PIN = fs.readFileSync(path.join(ROOT, 'public/meeting-report-pin.html'), 'utf8');

/* Synchronous submit handlers (no network call): key = text inside the handler. */
const SYNC_ALLOWLIST = [
  { marker: 'returningSearch(state', why: 'returning-patient search — local state lookup, no request' },
];

test('guard: every onsubmit handler in app.js reaches busyButton (or is allowlisted)', () => {
  const lines = APP.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/\.onsubmit\s*=/.test(line)) return;
    const rest = lines.slice(i + 1, i + 60);
    const stop = rest.findIndex(l => /\.onsubmit\s*=/.test(l));
    const handler = line + '\n' + (stop >= 0 ? rest.slice(0, stop) : rest).join('\n');
    if (/busyButton\(/.test(handler)) return;
    if (SYNC_ALLOWLIST.some(a => handler.includes(a.marker))) return;
    offenders.push('app.js:' + (i + 1));
  });
  assert.deepStrictEqual(offenders, [], 'submit handlers without busyButton: ' + offenders.join(', '));
});

test('guard: the allowlist entries still exist (no stale exemptions)', () => {
  SYNC_ALLOWLIST.forEach(a => assert.ok(APP.includes(a.marker), 'stale allowlist: ' + a.why));
});

/* ---------- PIN page behavior ---------- */
function loadPin() {
  const script = PIN.match(/<script>([\s\S]*?)<\/script>/)[1];
  const mkClass = () => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; };
  const mkEl = (extra) => Object.assign({
    attrs: {}, disabled: false, textContent: '', value: '', classList: mkClass(), listeners: {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    focus() {},
  }, extra);
  const els = {
    'pin-input': mkEl({ value: '1234' }),
    'pin-submit': mkEl({ textContent: 'כניסה' }),
    'pin-error': mkEl(),
  };
  const calls = [];
  let finish;
  const sandbox = {
    document: { getElementById: id => els[id] },
    location: { reload() {} },
    JSON,
    fetch: () => { calls.push(1); return new Promise(res => { finish = res; }); },
  };
  vm.runInNewContext(script, sandbox);
  return { els, calls, finish: v => finish(v) };
}

test('PIN page: busy ring while in flight, double click and double Enter send ONE request, restored after', async () => {
  const t = loadPin();
  const btn = t.els['pin-submit'];
  btn.listeners.click();
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.ok(btn.classList.contains('is-busy'));
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'טוען…');
  btn.listeners.click();
  t.els['pin-input'].listeners.keydown({ key: 'Enter' });
  t.els['pin-input'].listeners.keydown({ key: 'Enter' });
  assert.equal(t.calls.length, 1, 'one request despite repeated click/Enter');
  t.finish({ ok: false, status: 401 });
  await new Promise(r => setImmediate(r));
  assert.equal(btn.getAttribute('aria-busy'), null);
  assert.equal(btn.classList.contains('is-busy'), false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'כניסה');
  assert.equal(t.els['pin-error'].textContent, 'קוד שגוי');
});

test('PIN page: a 429 refusal also restores the button', async () => {
  const t = loadPin();
  const btn = t.els['pin-submit'];
  btn.listeners.click();
  t.finish({ ok: false, status: 429 });
  await new Promise(r => setImmediate(r));
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'כניסה');
  assert.match(t.els['pin-error'].textContent, /יותר מדי ניסיונות/);
});

test('PIN page: styles carry the busy ring and reduced-motion fallback', () => {
  assert.match(PIN, /\.is-busy::before/);
  assert.match(PIN, /prefers-reduced-motion: reduce/);
});
