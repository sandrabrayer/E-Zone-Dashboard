/* Regression tests for removing the כניסה לבית (entry) kanban column and
 * re-anchoring the admit action to the paid stage (public/app.js).
 *
 * The entry column was the LAST element of STAGES, and advanceLead used
 * positional math (STAGES.length - 1 / - 2) to decide when to open the entry
 * modal. Deleting the column without decoupling that math would have shifted
 * the admit trigger onto the visit stage and dead-ended paid. These tests lock
 * the post-change contract:
 *   - paid  → openEntryModal (admit)
 *   - visit → moveLead to paid, NEVER admit   ← the exact regression guarded
 *   - new   → moveLead to visit
 *   - entry / entered / admitted → no-op
 *
 * Loaded like the other app.js tests: read the source, append an epilogue that
 * REPLACES the openEntryModal / moveLead bindings (they are function
 * declarations, so reassignable in the shared script scope) with spies, then
 * evaluate in a vm sandbox with browser globals stubbed. advanceLead closes
 * over those bindings by name, so it calls the spies — no DOM / network needed. */

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
    let __calls = [];
    // Replace the real implementations (function declarations → mutable
    // bindings) so advanceLead's calls are captured instead of touching the
    // DOM (openEntryModal → showModal) or the network (moveLead → saveAll).
    openEntryModal = function (lead) { __calls.push(['admit', lead.id]); };
    moveLead = function (lead, newStage) { __calls.push(['move', lead.id, newStage]); return Promise.resolve(); };
    // Return JSON strings, not live sandbox arrays: assert.deepStrictEqual
    // checks prototype identity, and a cross-realm Array would fail that even
    // when the structure matches.
    globalThis.__test = {
      advance: (lead) => advanceLead(lead),
      callsJSON: () => JSON.stringify(__calls),
      reset: () => { __calls = []; },
      stageIdsJSON: () => JSON.stringify(STAGES.map(s => s.id)),
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

test('the entry column is removed from STAGES', () => {
  assert.strictEqual(app.stageIdsJSON(), JSON.stringify(['new', 'visit', 'paid']));
  assert.ok(!app.stageIdsJSON().includes('entry'), 'entry must no longer be a board stage');
});

test('advanceLead on a paid lead triggers admit (openEntryModal)', async () => {
  app.reset();
  await app.advance({ id: 'L1', stage: 'paid' });
  assert.strictEqual(app.callsJSON(), JSON.stringify([['admit', 'L1']]));
});

test('advanceLead on a visit lead moves it to paid, NEVER to admit', async () => {
  app.reset();
  await app.advance({ id: 'L2', stage: 'visit' });
  // The exact regression the trace warned about: visit must advance to paid,
  // not open the admit modal.
  assert.strictEqual(app.callsJSON(), JSON.stringify([['move', 'L2', 'paid']]));
  assert.ok(!app.callsJSON().includes('admit'), 'visit must not trigger admit');
});

test('advanceLead on a new lead moves it to visit', async () => {
  app.reset();
  await app.advance({ id: 'L3', stage: 'new' });
  assert.strictEqual(app.callsJSON(), JSON.stringify([['move', 'L3', 'visit']]));
});

test('advanceLead on entry / entered / admitted is a no-op', async () => {
  app.reset();
  await app.advance({ id: 'L4', stage: 'entry' });
  await app.advance({ id: 'L5', stage: 'entered' });
  await app.advance({ id: 'L6', stage: 'admitted' });
  assert.strictEqual(app.callsJSON(), JSON.stringify([]), 'stray legacy/admitted leads must not move or admit');
});
