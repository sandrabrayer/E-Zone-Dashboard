/* Timezone-safety tests for isoDate() in public/app.js.
 *
 * Bug: a patient entry date round-tripped through a Sheets date-typed cell and
 * arrived at the client as a UTC timestamp (e.g. "2026-06-10T21:00:00.000Z" for
 * a cell at local midnight 2026-06-11 IDT). The old isoDate sliced the UTC date
 * portion → "2026-06-10", drifting the day −1 on every save→reload for UTC+2/+3.
 * Fix: isoDate now derives the day from LOCAL parts for full timestamps, while
 * leaving a bare YYYY-MM-DD string untouched.
 *
 * TZ is pinned to Asia/Jerusalem so the local-part assertions are deterministic
 * regardless of the host machine's zone — this must be set before any Date use.
 *
 * Loaded the same way as the other app.js tests: read the source, append an
 * epilogue exposing isoDate, evaluate in a vm sandbox with browser globals
 * stubbed. Exercises the REAL shipped function. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__test = { isoDate: (v) => isoDate(v) };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

test('bare YYYY-MM-DD strings pass through unchanged (no UTC parse)', () => {
  assert.strictEqual(app.isoDate('2026-06-11'), '2026-06-11');
  assert.strictEqual(app.isoDate('2026-01-01'), '2026-01-01');
  // A bare date with trailing time is trimmed to the leading date portion.
  assert.strictEqual(app.isoDate('2026-06-11T00:00:00'), '2026-06-11');
});

test('a UTC timestamp is localized to the correct day, not sliced (drift fix)', () => {
  // Summer (IDT, UTC+3): local midnight 2026-06-11 → "2026-06-10T21:00:00.000Z".
  // OLD code → "2026-06-10" (−1 day). FIX → "2026-06-11".
  assert.strictEqual(app.isoDate('2026-06-10T21:00:00.000Z'), '2026-06-11');
  // Winter (IST, UTC+2): local midnight 2026-01-15 → "2026-01-14T22:00:00.000Z".
  assert.strictEqual(app.isoDate('2026-01-14T22:00:00.000Z'), '2026-01-15');
});

test('a Date object is rendered from local parts', () => {
  // Local 2026-06-11 00:00 (constructed from local parts) → "2026-06-11",
  // whereas toISOString() on this Date would yield 2026-06-10T21:00Z.
  assert.strictEqual(app.isoDate(new Date(2026, 5, 11)), '2026-06-11');
});

test('empty and invalid inputs preserve prior behavior', () => {
  assert.strictEqual(app.isoDate(''), '');
  assert.strictEqual(app.isoDate(null), '');
  assert.strictEqual(app.isoDate(undefined), '');
  assert.strictEqual(app.isoDate('not a date'), 'not a date');
});
