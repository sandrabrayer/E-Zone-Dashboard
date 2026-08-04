/* Tests for the meetingWith lead field + HOUSE_MANAGERS roster.
 *
 * Two source files are exercised, each loaded in its own vm sandbox the same
 * way the existing suite does it:
 *   - apps-script/Code.gs — for LEAD_COLUMNS (append-only order contract) and
 *     HOUSE_MANAGERS (exactly the four houses). Code.gs is Google Apps Script
 *     with no module.exports and its helpers touch SpreadsheetApp, so we read
 *     the source and evaluate it in a sandbox (see admitted-roster.test.js);
 *     the constants we assert on are plain top-level `const`s with no side
 *     effects, so no GAS stubs are needed to read them.
 *   - public/app.js — for normalizeLead, loaded exactly like
 *     lead-assignedto.test.js (read source, append an epilogue exposing the
 *     function, evaluate with browser globals stubbed).
 *
 * The contract locked here:
 *   - LEAD_COLUMNS keeps its existing columns in the same order and appends
 *     meetingWith immediately after the assignedTo block (readSheet_ maps cells
 *     to keys by position, so any reorder or mid-array insert would silently
 *     corrupt reads). Later append-only additions (e.g. meetingOutcome) extend
 *     the array further, so meetingWith's position is asserted relative to
 *     assignedTo, not as the terminal column;
 *   - normalizeLead defaults meetingWith to present-but-blank '' on legacy rows
 *     (no such column, no backfill);
 *   - HOUSE_MANAGERS covers exactly the four house keys and no others. */

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
      HOUSE_MANAGERS: HOUSE_MANAGERS,
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

test('LEAD_COLUMNS keeps existing column order and appends meetingWith after assignedTo', () => {
  // LEAD_COLUMNS is created in the Code.gs vm realm; copy into a plain
  // test-realm array so deepStrictEqual compares contents, not cross-realm
  // Array prototypes.
  const cols = Array.from(code.LEAD_COLUMNS);
  // The exact pre-append column list (through assignedTo). readSheet_ maps by
  // position, so this order is a hard contract — any reorder/insert breaks reads.
  const expectedThroughAssignedTo = [
    'id', 'name', 'phone', 'house', 'source', 'note',
    'stage', 'visitDate', 'visitTime', 'entryDate', 'advance', 'created',
    'assignedTo',
  ];
  assert.deepStrictEqual(
    cols.slice(0, expectedThroughAssignedTo.length),
    expectedThroughAssignedTo,
    'existing LEAD_COLUMNS order must be unchanged'
  );
  // meetingWith is appended immediately after the assignedTo block. Later
  // append-only additions (e.g. meetingOutcome) extend the array further, so
  // this asserts meetingWith's position relative to assignedTo — not that it is
  // the terminal column.
  assert.strictEqual(
    cols[expectedThroughAssignedTo.length],
    'meetingWith',
    'meetingWith must be appended immediately after assignedTo'
  );
  // Append-only: meetingWith appears exactly once.
  assert.strictEqual(
    cols.filter((c) => c === 'meetingWith').length,
    1,
    'meetingWith must appear exactly once'
  );
});

test('normalizeLead defaults meetingWith to present-but-blank on legacy rows', () => {
  const out = app.normalizeLead({ id: 'L1', name: 'ליד ישן', stage: 'new' });
  assert.ok('meetingWith' in out, 'meetingWith key must be present');
  assert.strictEqual(out.meetingWith, '');
});

test('normalizeLead carries meetingWith through when present', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'x', stage: 'new', meetingWith: 'חנן' });
  assert.strictEqual(out.meetingWith, 'חנן');
});

test('HOUSE_MANAGERS covers exactly the four house keys and no others', () => {
  assert.deepStrictEqual(
    Object.keys(code.HOUSE_MANAGERS).sort(),
    ['arfoni', 'asher', 'ramot', 'rehab']
  );
  assert.strictEqual(code.HOUSE_MANAGERS.arfoni, 'חנן');
  assert.strictEqual(code.HOUSE_MANAGERS.rehab, 'רנטה');
  assert.strictEqual(code.HOUSE_MANAGERS.asher, 'עידו');
  assert.strictEqual(code.HOUSE_MANAGERS.ramot, 'אורן');
});
