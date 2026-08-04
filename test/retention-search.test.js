/* Tests for the שימור לידים (retention / closed-leads) tab search:
 *   - irrelevantLeadMatchesQuery — the thin per-tab wrapper over the shared
 *     leadMatchesQuery (adds origin-sheet id + label matching; does NOT modify
 *     leadMatchesQuery);
 *   - filterIrrelevantGroups     — groups closed leads into the three
 *     disposition sections (spec order) and filters inside each group, dropping
 *     zero-match groups while a query is active; empty query → everything.
 *
 * Same vm-sandbox approach as meetings-board.test.js: app.js is a browser-global
 * script, so we read the source, append an epilogue exposing the pure functions,
 * and evaluate it in a vm context with browser globals stubbed. No changes to
 * app.js are needed for testability. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      irrelevantLeadMatchesQuery,
      filterIrrelevantGroups,
      leadMatchesQuery,
      stageLabelById,
    };
  `;
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

const app = loadApp();
const arr = x => Array.from(x);   // copy vm-realm arrays into the test realm

// A closed (irrelevant) lead as normalizeIrrelevantLead produces it: base lead
// fields + disposition + originSheet. `disp` defaults to a valid section key.
function closed(over) {
  return Object.assign(
    { id: 'x', name: '', phone: '', house: '', contactName: '', contactPhone: '',
      billingPhone: '', disposition: 'not_relevant', originSheet: '' },
    over || {}
  );
}

/* ===== irrelevantLeadMatchesQuery (wrapper) ===== */

test('irrelevantLeadMatchesQuery: empty query matches everything', () => {
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({}), ''), true);
});

test('irrelevantLeadMatchesQuery: matches base lead fields via leadMatchesQuery', () => {
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({ name: 'דניאל' }), 'דני'), true);
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({ phone: '050-111-2222' }), '0501112222'), true);
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({ contactName: 'רותי' }), 'רותי'), true);
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({ contactPhone: '052-333-4444' }), '0523334444'), true);
  assert.strictEqual(app.irrelevantLeadMatchesQuery(closed({ name: 'דניאל' }), 'משהו'), false);
});

test('irrelevantLeadMatchesQuery: also matches on origin sheet (id and Hebrew label)', () => {
  const lead = closed({ name: 'x', originSheet: 'visit' });
  assert.strictEqual(app.irrelevantLeadMatchesQuery(lead, 'visit'), true);            // stable id
  assert.strictEqual(app.irrelevantLeadMatchesQuery(lead, app.stageLabelById('visit')), true); // label ("ביקור נקבע")
  assert.strictEqual(app.irrelevantLeadMatchesQuery(lead, 'ביקור'), true);
});

/* ===== filterIrrelevantGroups (grouping + filtering) ===== */

test('filterIrrelevantGroups: empty query returns every group in spec order with all rows', () => {
  const rows = [
    closed({ id: 'a', name: 'אבי', disposition: 'not_relevant' }),
    closed({ id: 'b', name: 'בני', disposition: 'completed' }),
    closed({ id: 'c', name: 'גדי', disposition: 'stopped_early' }),
    closed({ id: 'd', name: 'דנה', disposition: 'not_relevant' }),
  ];
  const groups = arr(app.filterIrrelevantGroups(rows, ''));
  assert.deepStrictEqual(groups.map(g => g.key), ['not_relevant', 'completed', 'stopped_early']);
  assert.deepStrictEqual(groups.map(g => g.rows.length), [2, 1, 1]);
});

test('filterIrrelevantGroups: unknown/blank disposition falls into not_relevant', () => {
  const rows = [closed({ id: 'a', name: 'x', disposition: 'bogus' }), closed({ id: 'b', name: 'y', disposition: '' })];
  const groups = arr(app.filterIrrelevantGroups(rows, ''));
  assert.deepStrictEqual(groups.map(g => g.key), ['not_relevant']);
  assert.strictEqual(groups[0].rows.length, 2);
});

test('filterIrrelevantGroups: filtering returns the right subset; per-group count reflects filter', () => {
  const rows = [
    closed({ id: 'a', name: 'אבי כהן',  disposition: 'not_relevant' }),
    closed({ id: 'b', name: 'אבי לוי',  disposition: 'not_relevant' }),
    closed({ id: 'c', name: 'דנה',      disposition: 'not_relevant' }),
    closed({ id: 'd', name: 'אבי מזרחי', disposition: 'completed' }),
  ];
  const groups = arr(app.filterIrrelevantGroups(rows, 'אבי'));
  // not_relevant keeps 2 of 3 (both אבי*), completed keeps its 1 אבי; דנה excluded.
  assert.deepStrictEqual(groups.map(g => g.key), ['not_relevant', 'completed']);
  assert.deepStrictEqual(groups.map(g => g.rows.length), [2, 1]);
  assert.deepStrictEqual(arr(groups[0].rows).map(r => r.id), ['a', 'b']);
});

test('filterIrrelevantGroups: a group with zero matches is excluded while querying', () => {
  const rows = [
    closed({ id: 'a', name: 'אבי', disposition: 'not_relevant' }),
    closed({ id: 'b', name: 'דנה', disposition: 'completed' }),
  ];
  const groups = arr(app.filterIrrelevantGroups(rows, 'אבי'));
  assert.deepStrictEqual(groups.map(g => g.key), ['not_relevant']);   // completed dropped (0 matches)
});

test('filterIrrelevantGroups: no matches anywhere → empty array', () => {
  const rows = [closed({ id: 'a', name: 'אבי', disposition: 'not_relevant' })];
  assert.deepStrictEqual(arr(app.filterIrrelevantGroups(rows, 'זזזזז')), []);
});

test('filterIrrelevantGroups: nullish rows → empty array (no throw)', () => {
  assert.deepStrictEqual(arr(app.filterIrrelevantGroups(null, '')), []);
  assert.deepStrictEqual(arr(app.filterIrrelevantGroups(undefined, 'x')), []);
});
