/* Tests for the meetingOutcome lead field (foundation only — no UI).
 *
 * Two source files are exercised, each loaded in its own vm sandbox the same
 * way the existing suite does it (see lead-meetingwith-schema.test.js):
 *   - apps-script/Code.gs — for LEAD_COLUMNS (append-only order contract).
 *     Code.gs is Google Apps Script with no module.exports and its helpers
 *     touch SpreadsheetApp, so we read the source and evaluate it in a sandbox;
 *     LEAD_COLUMNS is a plain top-level `const` with no side effects.
 *   - public/app.js — for normalizeLead and MEETING_OUTCOME_LABELS, loaded by
 *     appending an epilogue that exposes them and evaluating with the browser
 *     globals stubbed.
 *
 * The contract locked here:
 *   - LEAD_COLUMNS appends meetingOutcome LAST, after meetingWith (readSheet_
 *     maps cells to keys by position, so any reorder or mid-array insert would
 *     silently corrupt reads);
 *   - normalizeLead preserves meetingOutcome when present and defaults it to
 *     present-but-blank '' on legacy rows (no such column, no backfill) — the
 *     field is never silently dropped on a round-trip;
 *   - MEETING_OUTCOME_LABELS contains exactly the five stable keys. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCode() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    'utf8'
  );
  const epilogue = `
    globalThis.__test = {
      LEAD_COLUMNS: LEAD_COLUMNS,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );
  const epilogue = `
    globalThis.__test = {
      normalizeLead: (l) => normalizeLead(l),
      MEETING_OUTCOME_LABELS: MEETING_OUTCOME_LABELS,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const code = loadCode();
const app = loadApp();

test('LEAD_COLUMNS appends meetingOutcome last, after meetingWith', () => {
  // Copy into a plain test-realm array so deepStrictEqual compares contents,
  // not cross-realm Array prototypes.
  const cols = Array.from(code.LEAD_COLUMNS);
  assert.strictEqual(
    cols[cols.length - 1],
    'meetingOutcome',
    'meetingOutcome must be the last column'
  );
  assert.strictEqual(
    cols[cols.length - 2],
    'meetingWith',
    'meetingOutcome must be appended immediately after meetingWith'
  );
  // Append-only: meetingOutcome appears exactly once.
  assert.strictEqual(
    cols.filter((c) => c === 'meetingOutcome').length,
    1,
    'meetingOutcome must appear exactly once'
  );
});

test('normalizeLead preserves meetingOutcome when present', () => {
  const out = app.normalizeLead({
    id: 'L1', name: 'x', stage: 'new', meetingOutcome: 'entered',
  });
  assert.strictEqual(out.meetingOutcome, 'entered');
});

test('normalizeLead defaults meetingOutcome to present-but-blank on legacy rows', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'ליד ישן', stage: 'new' });
  assert.ok('meetingOutcome' in out, 'meetingOutcome key must be present');
  assert.strictEqual(out.meetingOutcome, '');
});

test('normalizeLead does not silently drop meetingOutcome on round-trip', () => {
  // Feed a normalized lead back through normalizeLead — the value must survive.
  const first  = app.normalizeLead({ id: 'L3', name: 'x', meetingOutcome: 'postponed' });
  const second = app.normalizeLead(first);
  assert.strictEqual(second.meetingOutcome, 'postponed');
});

test('MEETING_OUTCOME_LABELS contains exactly the five stable keys', () => {
  const labels = app.MEETING_OUTCOME_LABELS;
  assert.deepStrictEqual(
    Object.keys(labels).sort(),
    ['cancelled', 'entered', 'not_relevant', 'postponed', 'thinking']
  );
  assert.strictEqual(labels.not_relevant, 'לא רלוונטי');
  assert.strictEqual(labels.thinking,     'חושבים על זה');
  assert.strictEqual(labels.entered,      'נכנסים לטיפול');
  assert.strictEqual(labels.postponed,    'נדחה');
  assert.strictEqual(labels.cancelled,    'התבטל');
});
