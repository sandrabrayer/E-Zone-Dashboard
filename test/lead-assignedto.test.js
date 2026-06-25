/* Tests for the assignedTo (משוייך ל) lead field — public/app.js normalizeLead.
 *
 * assignedTo was appended to LEAD_COLUMNS (apps-script/Code.gs) and read in
 * normalizeLead via the same defensive pickField pass-through the other
 * carried-through fields use. The contract these tests lock:
 *   - a payload WITH assignedTo round-trips the chosen value through
 *     normalizeLead unchanged (so the kanban card can render it and saveAll
 *     can persist it);
 *   - a payload WITHOUT assignedTo (every pre-existing lead, since there is no
 *     backfill) normalizes to '' rather than undefined — keeping the field
 *     present-but-blank so objectToRow_ writes an empty cell and the card
 *     renders nothing.
 *
 * Loaded like the other app.js tests (see remove-entry-column.test.js): read
 * the source, append an epilogue exposing normalizeLead, evaluate in a vm
 * sandbox with browser globals stubbed. No DOM / network needed. */

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

const app = loadApp();

test('normalizeLead carries assignedTo through when present', () => {
  const out = app.normalizeLead({ id: 'L1', name: 'דנה', stage: 'new', assignedTo: 'ורד' });
  assert.strictEqual(out.assignedTo, 'ורד');
});

test('normalizeLead accepts each of the three fixed assignees', () => {
  for (const who of ['ורד', 'שירן', 'יעל']) {
    const out = app.normalizeLead({ id: 'L', name: 'x', stage: 'new', assignedTo: who });
    assert.strictEqual(out.assignedTo, who);
  }
});

test('normalizeLead reads the Hebrew column alias', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'x', stage: 'new', 'משוייך ל': 'שירן' });
  assert.strictEqual(out.assignedTo, 'שירן');
});

test('normalizeLead defaults assignedTo to empty string when absent (no backfill)', () => {
  const out = app.normalizeLead({ id: 'L3', name: 'ליד ישן', stage: 'new' });
  // Present-but-blank: the key exists (so objectToRow_ writes a cell) but is ''
  // (so the card renders nothing). Existing leads stay blank, per spec.
  assert.ok('assignedTo' in out, 'assignedTo key must be present');
  assert.strictEqual(out.assignedTo, '');
});
