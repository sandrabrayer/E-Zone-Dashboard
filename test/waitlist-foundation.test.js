/* Tests for the waitlist stage foundation (PR 1 of 2 — schema only, no UI).
 *
 * Context: a new kanban stage רשימת המתנה (waitlist) is coming to the leads
 * pipeline. A lead in that stage is a potential patient waiting for a spot;
 * the lead's existing `house` field is the house they are waiting for. This
 * PR ships the foundation only:
 *   - `waitlistedAt` appended LAST to LEAD_COLUMNS (ISO timestamp string,
 *     text-forced at sheet-ensure time so Sheets never date-coerces it);
 *   - STAGE_WAITLIST constant + STAGE_ALIASES round-trip, deliberately kept
 *     OUT of STAGES / ALL_STAGES_FOR_PIPELINE so nothing renders;
 *   - normalizeLead passes waitlistedAt through (no silent drop).
 *
 * Two source files are exercised, each loaded in its own vm sandbox the same
 * way the existing suite does it (see lead-contact-fields-foundation.test.js
 * and visittime-text-columns-and-quarter-select.test.js):
 *   - apps-script/Code.gs — LEAD_COLUMNS order contract, derived
 *     IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS inheritance, and the
 *     getOrCreateSheet_ text-format of the waitlistedAt column.
 *   - public/app.js — normalizeLead / normalizeStage pass-through, and the
 *     zero-UI-change guard: the ACTUAL rendered kanban has no waitlist column.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x); // copy a sandbox-realm array into this realm

/* ---------- a minimal fake Sheet that records ops in order ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  const sheet = {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', r, c, nr, nc, fmt }); },
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
          ops.push({ op: 'set', r, c, nr, nc, vals: vals.map((x) => x.slice()) });
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

/* ---------- load apps-script/Code.gs ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __leadsSheet: null,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: () => sandbox.__leadsSheet,
      insertSheet: () => sandbox.__leadsSheet,
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    IRRELEVANT_LEAD_COLUMNS: IRRELEVANT_LEAD_COLUMNS,
    REMOVED_LEAD_COLUMNS: REMOVED_LEAD_COLUMNS,
    ensure: () => getOrCreateSheet_(LEADS_SHEET, LEAD_COLUMNS),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

/* ---------- load public/app.js (with a DOM stub) ---------- */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(child) { this.children.push(child); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const byId = {}; // id → the fake element renderKanban etc. mutate
  const doc = {
    getElementById: (id) => (byId[id] || (byId[id] = fakeEl())),
    createElement: () => fakeEl(),
    querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
  };
  const epilogue = `globalThis.__test = {
    STAGES: STAGES,
    ALL_STAGES_FOR_PIPELINE: ALL_STAGES_FOR_PIPELINE,
    STAGE_WAITLIST: STAGE_WAITLIST,
    normalizeLead: (l) => normalizeLead(l),
    normalizeIrrelevantLead: (l) => normalizeIrrelevantLead(l),
    normalizeRemovedLead: (l) => normalizeRemovedLead(l),
    normalizeStage: (s) => normalizeStage(s),
    renderKanban: () => renderKanban(),
    state: state,
  };`;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, byId };
}

const { code } = loadCode();
const { app } = loadApp();

/* ===== Backend schema ===== */

test('LEAD_COLUMNS appends waitlistedAt immediately after billingPhone', () => {
  const cols = arr(code.LEAD_COLUMNS);
  // waitlistedAt sits immediately after billingPhone. Later append-only
  // additions (the meeting-report fields) extend the array further, so this
  // asserts waitlistedAt's position RELATIVE to billingPhone — not that it is
  // the terminal column (mirrors the meetingWith-after-assignedTo fix).
  const wlIdx = cols.indexOf('waitlistedAt');
  assert.ok(wlIdx > 0, 'waitlistedAt must be present');
  assert.strictEqual(cols[wlIdx - 1], 'billingPhone',
    'waitlistedAt must sit immediately after billingPhone (no mid-array insert)');
  assert.strictEqual(cols.filter((c) => c === 'waitlistedAt').length, 1,
    'waitlistedAt must appear exactly once');
  // The pre-existing prefix is untouched, in its exact historical order.
  assert.deepStrictEqual(cols.slice(0, wlIdx), [
    'id', 'name', 'phone', 'house', 'source', 'note',
    'stage', 'visitDate', 'visitTime', 'entryDate', 'advance', 'created',
    'assignedTo', 'meetingWith', 'meetingOutcome',
    'contactName', 'contactPhone', 'contactRelation', 'billingPhone',
  ], 'existing LEAD_COLUMNS order must be unchanged');
});

test('derived irrelevant/removed schemas inherit waitlistedAt', () => {
  assert.ok(arr(code.IRRELEVANT_LEAD_COLUMNS).includes('waitlistedAt'),
    'IRRELEVANT_LEAD_COLUMNS must carry waitlistedAt');
  assert.ok(arr(code.REMOVED_LEAD_COLUMNS).includes('waitlistedAt'),
    'REMOVED_LEAD_COLUMNS must carry waitlistedAt');
});

test('getOrCreateSheet_ appends the missing waitlistedAt header and text-forces the column', () => {
  const { code, sandbox } = loadCode();
  const LC = arr(code.LEAD_COLUMNS);
  const wlIdx = LC.indexOf('waitlistedAt');
  // Simulate a pre-existing sheet created BEFORE this PR: header row lacks
  // waitlistedAt and everything appended after it (the meeting-report fields).
  const legacyHeader = LC.slice(0, wlIdx);
  const row = legacyHeader.map(() => ''); row[0] = 'L1';
  sandbox.__leadsSheet = fakeSheet(legacyHeader, [row]);

  const sh = code.ensure();

  // Non-destructive header extension: waitlistedAt appended in its slot.
  assert.strictEqual(sh.grid[0][wlIdx], 'waitlistedAt',
    'missing header must be appended non-destructively');
  assert.strictEqual(sh.grid[1][0], 'L1', 'existing data rows untouched');
  // The whole waitlistedAt column is forced to plain text ('@') so Sheets can
  // never coerce the ISO timestamp string into a Date cell.
  const wlCol = LC.indexOf('waitlistedAt') + 1;
  assert.ok(sh.ops.some((o) => o.op === 'fmt' && o.fmt === '@' && o.c === wlCol && o.nc === 1),
    'waitlistedAt column must be setNumberFormat("@")');
});

/* ===== Frontend normalization ===== */

test('normalizeLead preserves waitlistedAt verbatim (no silent drop, no date munging)', () => {
  const ts = '2026-08-12T09:30:00.000Z';
  const out = app.normalizeLead({ id: 'L1', name: 'מטופל', stage: 'new', waitlistedAt: ts });
  assert.strictEqual(out.waitlistedAt, ts, 'full ISO timestamp must survive untouched');
});

test('normalizeLead defaults waitlistedAt to present-but-blank on legacy rows', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'ליד ישן', stage: 'new' });
  assert.ok('waitlistedAt' in out, 'waitlistedAt key must be present');
  assert.strictEqual(out.waitlistedAt, '', 'waitlistedAt must default to \'\'');
});

test('normalizeLead does not drop waitlistedAt on a round-trip', () => {
  const first = app.normalizeLead({ id: 'L3', name: 'x', waitlistedAt: '2026-08-01T10:00:00.000Z' });
  const second = app.normalizeLead(first);
  assert.strictEqual(second.waitlistedAt, first.waitlistedAt);
});

test('normalizeIrrelevantLead / normalizeRemovedLead carry waitlistedAt', () => {
  const ts = '2026-08-05T08:00:00.000Z';
  assert.strictEqual(app.normalizeIrrelevantLead({
    id: 'L4', name: 'x', waitlistedAt: ts, originSheet: 'new', movedAt: '2026-08-06T00:00:00Z',
  }).waitlistedAt, ts);
  assert.strictEqual(app.normalizeRemovedLead({
    id: 'L5', name: 'x', waitlistedAt: ts, removedAt: '2026-08-06T00:00:00Z', originSheet: 'Leads',
  }).waitlistedAt, ts);
});

/* ===== Stage constant + round-trip ===== */

test('STAGE_WAITLIST ships with the stable id and Hebrew label', () => {
  assert.strictEqual(app.STAGE_WAITLIST.id, 'waitlist');
  assert.strictEqual(app.STAGE_WAITLIST.label, 'רשימת המתנה');
});

test('normalizeStage round-trips waitlist instead of resetting it to "new"', () => {
  assert.strictEqual(app.normalizeStage('waitlist'), 'waitlist');
  assert.strictEqual(app.normalizeStage('רשימת המתנה'), 'waitlist');
  // Guard the guard: an actually-unknown stage still defaults to 'new'.
  assert.strictEqual(app.normalizeStage('definitely-not-a-stage'), 'new');
});

/* The PR-1 "zero-UI-change gate" tests that lived here (waitlist absent from
 * STAGES / ALL_STAGES_FOR_PIPELINE and from the rendered board) were removed
 * by the UI PR, which deliberately un-gates the stage. The rendered-board
 * contract now lives in test/waitlist-ui.test.js. */
