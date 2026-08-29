/* Tests for the meeting-report Apps Script endpoint (apps-script/Code.gs):
 *
 *   - meetingReportAuthOk_ / handle_ dispatch: FAIL-CLOSED — no
 *     MEETING_REPORT_SECRET Script Property (or a mismatch) → unauthorized,
 *     for both the read and the write action.
 *   - meetingReportLeads_: only the four whitelisted fields
 *     { id, name, house, visitDate }; admitted-stage leads excluded.
 *   - submitMeetingReport_: rejects bad leadId / outcome / oversized
 *     companion / note / reporter; happy path writes the five report fields
 *     and RESETS meetingSeen to ''; a resubmission overwrites in place.
 *
 * Code.gs is Google Apps Script (no module.exports, touches SpreadsheetApp /
 * PropertiesService / ContentService), so — per the repo's vm-sandbox
 * convention (see waitlist-foundation.test.js) — the source is evaluated with
 * those globals stubbed: a fake in-memory Sheet, a mutable Script Properties
 * store, and a ContentService that hands back the parsed JSON payload. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

/* ---------- a minimal fake Sheet (same shape as waitlist-foundation) ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  return {
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
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
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
          ops.push({ op: 'set', r, c, nr, nc });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

/* ---------- load apps-script/Code.gs with the GAS globals stubbed ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},   // sheet name → fakeSheet
    __props: {},    // Script Properties store (mutable per test)
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
    }),
  };
  // jsonOut_ pipes through here — hand the parsed payload back to the test.
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    handle: (params) => handle_(params).json,
    meetingReportLeads: () => meetingReportLeads_(),
    submitMeetingReport: (r) => submitMeetingReport_(r),
    isOpenLeadStage: (s) => isOpenLeadStage_(s),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

/* A full-width Leads row with the named fields set. */
function leadRow(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}

/* Fresh sandbox with a Leads sheet holding the given lead field-objects. */
function withLeads(leadsFields) {
  const { code, sandbox } = loadCode();
  const cols = arr(code.LEAD_COLUMNS);
  sandbox.__sheets['Leads'] = fakeSheet(cols, (leadsFields || []).map((f) => leadRow(cols, f)));
  return { code, sandbox, cols };
}

const OPEN_LEADS = [
  { id: 'L1', name: 'דני', phone: '0501234567', house: 'ramot', stage: 'visit', visitDate: '2026-08-20', note: 'סודי' },
  { id: 'L2', name: 'רות', phone: '0527654321', house: 'arfoni', stage: 'new', visitDate: '' },
  { id: 'L3', name: 'יוסי', phone: '0501111111', house: 'sde', stage: 'admitted', visitDate: '2026-08-01' },
];

/* ===== fail-closed auth ===== */

test('meetingReportLeads via handle_: no Script Property secret → unauthorized (fail-closed)', () => {
  const { code } = withLeads(OPEN_LEADS);
  const out = code.handle({ action: 'meetingReportLeads', secret: 'anything' });
  assert.deepStrictEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'unauthorized' });
});

test('submitMeetingReport via handle_: no Script Property secret → unauthorized (fail-closed)', () => {
  const { code } = withLeads(OPEN_LEADS);
  const out = code.handle({
    action: 'submitMeetingReport', secret: 'anything',
    report: { leadId: 'L1', outcome: 'advancing', companion: 'mother', note: '', reporter: 'יעל' },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'unauthorized');
});

test('both actions: WRONG secret → unauthorized; correct secret → served', () => {
  const { code, sandbox } = withLeads(OPEN_LEADS);
  sandbox.__props.MEETING_REPORT_SECRET = 's3cret';

  assert.strictEqual(code.handle({ action: 'meetingReportLeads', secret: 'nope' }).error, 'unauthorized');
  assert.strictEqual(code.handle({ action: 'meetingReportLeads', secret: 's3cret' }).ok, true);

  assert.strictEqual(code.handle({
    action: 'submitMeetingReport', secret: 'nope',
    report: { leadId: 'L1', outcome: 'advancing', companion: 'mother', note: '', reporter: 'יעל' },
  }).error, 'unauthorized');
});

/* ===== meetingReportLeads_ ===== */

test('meetingReportLeads returns ONLY the four whitelisted fields', () => {
  const { code } = withLeads(OPEN_LEADS);
  const out = code.meetingReportLeads();
  assert.strictEqual(out.ok, true);
  const leads = arr(out.leads).map((l) => ({ ...l }));
  assert.ok(leads.length > 0);
  leads.forEach((l) => {
    assert.deepStrictEqual(
      Object.keys(l).sort(),
      ['house', 'id', 'name', 'visitDate'],
      'no phones, no notes, no contact/billing fields — minimal exposure'
    );
  });
  const l1 = leads.find((l) => l.id === 'L1');
  assert.deepStrictEqual(l1, { id: 'L1', name: 'דני', house: 'ramot', visitDate: '2026-08-20' });
});

test('meetingReportLeads excludes admitted-stage leads (open leads only)', () => {
  const { code } = withLeads(OPEN_LEADS);
  const ids = arr(code.meetingReportLeads().leads).map((l) => l.id);
  assert.deepStrictEqual(ids.sort(), ['L1', 'L2'], 'L3 (admitted) must be excluded');
});

test('isOpenLeadStage_ closes admitted/irrelevant in both id and Hebrew-label form', () => {
  const { code } = withLeads([]);
  ['admitted', 'נקלט', 'אושפז', 'irrelevant', 'לא רלוונטי'].forEach((s) =>
    assert.strictEqual(code.isOpenLeadStage(s), false, s + ' is closed'));
  ['new', 'visit', 'waitlist', 'paid', 'entry', '', 'ביקור נקבע'].forEach((s) =>
    assert.strictEqual(code.isOpenLeadStage(s), true, s + ' is open'));
});

/* ===== submitMeetingReport_ validation ===== */

const VALID = { leadId: 'L1', outcome: 'advancing', companion: 'mother', note: 'שיחה', reporter: 'יעל' };

test('rejects an unknown leadId and a CLOSED (admitted) leadId', () => {
  const { code } = withLeads(OPEN_LEADS);
  assert.strictEqual(code.submitMeetingReport({ ...VALID, leadId: 'nope' }).error, 'lead_not_found');
  assert.strictEqual(code.submitMeetingReport({ ...VALID, leadId: 'L3' }).error, 'lead_not_found');
  assert.strictEqual(code.submitMeetingReport({ ...VALID, leadId: '' }).error, 'bad_lead');
});

test('rejects an outcome outside advancing|undecided|not_fit|no_show', () => {
  const { code } = withLeads(OPEN_LEADS);
  assert.strictEqual(code.submitMeetingReport({ ...VALID, outcome: 'entered' }).error, 'bad_outcome');
  assert.strictEqual(code.submitMeetingReport({ ...VALID, outcome: '' }).error, 'bad_outcome');
});

test('companion: preset keys and ≤100-char free text pass; >100 chars rejected', () => {
  const { code } = withLeads(OPEN_LEADS);
  assert.strictEqual(code.submitMeetingReport({ ...VALID, companion: 'partner' }).ok, true);
  const { code: c2 } = withLeads(OPEN_LEADS);
  assert.strictEqual(c2.submitMeetingReport({ ...VALID, companion: 'סבתא רבתא' }).ok, true, 'free text (אחר flow) allowed');
  const { code: c3 } = withLeads(OPEN_LEADS);
  assert.strictEqual(c3.submitMeetingReport({ ...VALID, companion: 'x'.repeat(101) }).error, 'bad_companion');
});

test('rejects an oversized note and a blank/oversized reporter', () => {
  const { code } = withLeads(OPEN_LEADS);
  assert.strictEqual(code.submitMeetingReport({ ...VALID, note: 'x'.repeat(2001) }).error, 'bad_note');
  assert.strictEqual(code.submitMeetingReport({ ...VALID, reporter: '' }).error, 'bad_reporter');
  assert.strictEqual(code.submitMeetingReport({ ...VALID, reporter: 'x'.repeat(101) }).error, 'bad_reporter');
  assert.strictEqual(code.submitMeetingReport(null).error, 'bad_request');
});

/* ===== submitMeetingReport_ happy path + overwrite ===== */

function cell(sandbox, cols, rowIdx, colName) {
  return sandbox.__sheets['Leads'].grid[rowIdx][cols.indexOf(colName)];
}

test('happy path writes the five report fields, resets meetingSeen, preserves the rest of the row', () => {
  const { code, sandbox, cols } = withLeads([
    { ...OPEN_LEADS[0], meetingSeen: '1' }, // pre-marked seen — must reset
    OPEN_LEADS[1], OPEN_LEADS[2],
  ]);
  const out = code.submitMeetingReport({
    leadId: 'L1', outcome: 'no_show', companion: 'סבתא', note: 'לא הגיע', reporter: 'יעל',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.saved.leadId, 'L1');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(out.saved.reportedAt), 'reportedAt is an ISO timestamp string');

  // Row 1 (grid index 1 — after the header) is L1.
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingReportOutcome'), 'no_show');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingCompanion'), 'סבתא');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingNote'), 'לא הגיע');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingReporter'), 'יעל');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingReportedAt'), out.saved.reportedAt);
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingSeen'), '', 'meetingSeen must RESET so PR 3 shows it unseen');

  // The rest of the row survived the read-merge-write untouched.
  assert.strictEqual(cell(sandbox, cols, 1, 'name'), 'דני');
  assert.strictEqual(cell(sandbox, cols, 1, 'phone'), '0501234567');
  assert.strictEqual(cell(sandbox, cols, 1, 'note'), 'סודי');
  assert.strictEqual(cell(sandbox, cols, 1, 'stage'), 'visit');
});

test('a resubmission for the same lead OVERWRITES the previous report (last write wins, no new row)', () => {
  const { code, sandbox, cols } = withLeads(OPEN_LEADS);
  assert.strictEqual(code.submitMeetingReport({
    leadId: 'L1', outcome: 'undecided', companion: 'mother', note: 'ראשון', reporter: 'יעל',
  }).ok, true);
  const rowsAfterFirst = sandbox.__sheets['Leads'].grid.length;

  assert.strictEqual(code.submitMeetingReport({
    leadId: 'L1', outcome: 'advancing', companion: 'parents', note: 'שני', reporter: 'שירן',
  }).ok, true);

  assert.strictEqual(sandbox.__sheets['Leads'].grid.length, rowsAfterFirst, 'no duplicate row appended');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingReportOutcome'), 'advancing');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingNote'), 'שני');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingReporter'), 'שירן');
  assert.strictEqual(cell(sandbox, cols, 1, 'meetingCompanion'), 'parents');
});
