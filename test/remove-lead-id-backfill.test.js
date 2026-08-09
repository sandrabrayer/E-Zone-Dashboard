/* Tests for the removeLead blank-id fix (PR B).
 *
 *   Code.gs — backfillMissingIds_ writes a generated id into any content row
 *             whose id cell is blank (single-cell writes, idempotent);
 *             countRowsById_ is the read-only peek; deleteRowsById_ now returns
 *             the number of rows removed; and removeLead_ runs the safe
 *             peek → append → delete sequence, refusing to touch anything when
 *             the id matched nothing.
 *
 * Non-Node Apps Script script → read the source, stub the Google globals, and
 * exercise the REAL shipped functions in a vm sandbox. The fakeSheet + registry
 * harness mirrors billing-override-foundation.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

/* ---------- a minimal fake Sheet that records ops in order ---------- */
/* Global monotonic op sequence, shared across ALL fakeSheets, so a test can
 * assert cross-sheet ordering (e.g. removeLead_'s append to the removed sheet
 * happens BEFORE its delete from the Leads sheet). */
let opSeq = 0;

function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  const sheet = {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { ops.push({ op: 'append', seq: ++opSeq }); grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() { ops.push({ op: 'fmt', r, c, seq: ++opSeq }); },
        setValue(v) {
          ops.push({ op: 'setValue', r, c, v, seq: ++opSeq });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
        },
        clearContent() {
          ops.push({ op: 'clear', r, c, nr, nc, seq: ++opSeq });
          for (let i = 0; i < nr; i++) {
            for (let j = 0; j < nc; j++) {
              if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = '';
            }
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push({ op: 'set', r, c, nr, nc, seq: ++opSeq });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
  return sheet;
}

function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const registry = {};
  let uuid = 0;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    Utilities: { formatDate: () => '2026-08-09', getUuid: () => 'uuid' + (++uuid) },
    LockService: { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) },
    __registry: registry,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => registry[name] || null,
      insertSheet: (name) => (registry[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    REMOVED_LEAD_COLUMNS: REMOVED_LEAD_COLUMNS,
    LEADS_SHEET: LEADS_SHEET,
    REMOVED_LEADS_SHEET: REMOVED_LEADS_SHEET,
    backfill: (sh, cols) => backfillMissingIds_(sh, cols),
    count: (sh, cols, id) => countRowsById_(sh, cols, id),
    del: (sh, cols, id) => deleteRowsById_(sh, cols, id),
    removeLead: (l) => removeLead_(l),
    readSheet: (sh, cols) => readSheet_(sh, cols),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, registry };
}

const { code, registry } = loadCode();
const LC = arr(code.LEAD_COLUMNS);
const idIdx = LC.indexOf('id');

/* Build a Leads data row from a sparse {col: val} map. */
function leadRow(map) {
  return LC.map((c) => (map[c] === undefined ? '' : map[c]));
}
function seedLeads(rows) {
  const sh = fakeSheet(LC, rows);
  registry[code.LEADS_SHEET] = sh;
  return sh;
}
function seedRemoved() {
  const sh = fakeSheet(arr(code.REMOVED_LEAD_COLUMNS), []);
  registry[code.REMOVED_LEADS_SHEET] = sh;
  return sh;
}

/* ===== backfillMissingIds_ ===== */

test('backfillMissingIds_ writes an id into a content row whose id cell is blank', () => {
  const sh = seedLeads([
    leadRow({ id: 'L1', name: 'has id' }),
    leadRow({ id: '',   name: 'no id' }),
  ]);
  const filled = code.backfill(sh, LC);
  assert.strictEqual(filled, 1);
  const rows = code.readSheet(sh, LC);
  const blank = rows.find((r) => r.name === 'no id');
  assert.ok(blank.id && String(blank.id).length > 0, 'blank-id row now has an id');
  assert.strictEqual(rows.find((r) => r.name === 'has id').id, 'L1', 'existing id untouched');
});

test('backfillMissingIds_ is stable — a second pass fills 0 and keeps the same id', () => {
  const sh = seedLeads([leadRow({ id: '', name: 'no id' })]);
  code.backfill(sh, LC);
  const firstId = code.readSheet(sh, LC)[0].id;
  const filledAgain = code.backfill(sh, LC);
  assert.strictEqual(filledAgain, 0, 'second pass performs no writes');
  assert.strictEqual(code.readSheet(sh, LC)[0].id, firstId, 'id is stable across reads');
});

test('backfillMissingIds_ skips a fully-empty trailing row', () => {
  const sh = seedLeads([
    leadRow({ id: 'L1', name: 'real' }),
    LC.map(() => ''), // fully empty
  ]);
  const filled = code.backfill(sh, LC);
  assert.strictEqual(filled, 0, 'empty row is not given an id');
});

test('backfillMissingIds_ no-ops when every row already has an id', () => {
  const sh = seedLeads([leadRow({ id: 'L1', name: 'a' }), leadRow({ id: 'L2', name: 'b' })]);
  assert.strictEqual(code.backfill(sh, LC), 0);
});

/* ===== countRowsById_ (read-only match-check) ===== */

test('countRowsById_ counts matches without modifying the sheet', () => {
  const sh = seedLeads([leadRow({ id: 'L1', name: 'a' }), leadRow({ id: 'L2', name: 'b' })]);
  assert.strictEqual(code.count(sh, LC, 'L1'), 1);
  assert.strictEqual(code.count(sh, LC, 'nope'), 0);
  // read-only: both rows still present
  assert.strictEqual(code.readSheet(sh, LC).length, 2);
});

/* ===== deleteRowsById_ return value ===== */

test('deleteRowsById_ returns the number of rows removed (1 on match, 0 on miss)', () => {
  const sh = seedLeads([leadRow({ id: 'L1', name: 'a' }), leadRow({ id: 'L2', name: 'b' })]);
  assert.strictEqual(code.del(sh, LC, 'L1'), 1);
  assert.strictEqual(code.del(sh, LC, 'nope'), 0);
  const remaining = arr(code.readSheet(sh, LC).map((r) => r.id));
  assert.deepStrictEqual(remaining, ['L2']);
});

/* ===== removeLead_ ===== */

test('removeLead_ on a matched id deletes the lead AND appends to the removed sheet', () => {
  const leadsSh   = seedLeads([leadRow({ id: 'L1', name: 'goodbye' }), leadRow({ id: 'L2', name: 'stay' })]);
  const removedSh = seedRemoved();
  const res = code.removeLead({ id: 'L1', name: 'goodbye' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removed, true);
  // deleted from Leads
  assert.deepStrictEqual(arr(code.readSheet(leadsSh, LC).map((r) => r.id)), ['L2']);
  // appended to removed sheet
  const removed = code.readSheet(removedSh, arr(code.REMOVED_LEAD_COLUMNS));
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(String(removed[0].id), 'L1');
});

test('removeLead_ on an UNMATCHED id returns lead_id_not_found, deletes nothing, appends nothing', () => {
  const leadsSh   = seedLeads([leadRow({ id: 'L1', name: 'stay' })]);
  const removedSh = seedRemoved();
  const res = code.removeLead({ id: 'ghost-random-cryptoid', name: 'stay' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'lead_id_not_found');
  // Leads untouched
  assert.deepStrictEqual(arr(code.readSheet(leadsSh, LC).map((r) => r.id)), ['L1']);
  // NO phantom removed row — this is the core of the fix
  assert.strictEqual(code.readSheet(removedSh, arr(code.REMOVED_LEAD_COLUMNS)).length, 0);
});

test('removeLead_ appends to the removed sheet BEFORE deleting from Leads (ops-log order)', () => {
  const leadsSh   = seedLeads([leadRow({ id: 'L1', name: 'goodbye' })]);
  const removedSh = seedRemoved();
  leadsSh.ops.length = 0;
  removedSh.ops.length = 0;

  const res = code.removeLead({ id: 'L1', name: 'goodbye' });
  assert.strictEqual(res.ok, true);

  // The append lands on the removed sheet as a setValues ('set'); the delete on
  // the Leads sheet starts with clearBody_'s clearContent ('clear'). The shared
  // opSeq counter orders ops across the two sheets.
  const appendOp = removedSh.ops.find((o) => o.op === 'set');
  const deleteOp = leadsSh.ops.find((o) => o.op === 'clear' || o.op === 'set');
  assert.ok(appendOp, 'removed-sheet append happened');
  assert.ok(deleteOp, 'Leads delete happened');
  assert.ok(
    appendOp.seq < deleteOp.seq,
    `append (seq ${appendOp.seq}) must precede delete (seq ${deleteOp.seq})`
  );
});

test('removeLead_ requires an id (missing_lead guard unchanged)', () => {
  seedLeads([]); seedRemoved();
  assert.strictEqual(code.removeLead({ name: 'no id' }).error, 'missing_lead');
});

/* ===== end-to-end: blank-id lead heals, then removes cleanly ===== */

test('a blank-id lead is unremovable until backfilled, then removes on retry', () => {
  const leadsSh   = seedLeads([leadRow({ id: '', name: 'orphan' })]);
  const removedSh = seedRemoved();

  // Simulate the client having invented a random id for the blank-id row.
  const clientRandomId = 'crypto-9f3a';
  const before = code.removeLead({ id: clientRandomId, name: 'orphan' });
  assert.strictEqual(before.ok, false, 'random client id matches nothing → refused');
  assert.strictEqual(code.readSheet(removedSh, arr(code.REMOVED_LEAD_COLUMNS)).length, 0);
  // lead still present
  assert.strictEqual(code.readSheet(leadsSh, LC).length, 1);

  // getData_ backfill assigns the real id; the client now sees it and retries.
  code.backfill(leadsSh, LC);
  const realId = code.readSheet(leadsSh, LC)[0].id;
  const after = code.removeLead({ id: realId, name: 'orphan' });
  assert.strictEqual(after.ok, true);
  assert.strictEqual(code.readSheet(leadsSh, LC).length, 0, 'lead gone for good');
  assert.strictEqual(code.readSheet(removedSh, arr(code.REMOVED_LEAD_COLUMNS)).length, 1);
});
