/* Regression tests for the meeting-report LOST-UPDATE clobber + write
 * verification (CHANGELOG-meeting-report-write-fix.md):
 *
 * The bug: submitMeetingReport_ wrote the report onto the lead row correctly,
 * but the main dashboard's saveAll (mergeLeads_) rewrites EVERY lead row
 * wholesale from the client's in-memory copy — which is frozen at page-load
 * time. A dashboard tab loaded before the manager reported carried '' in all
 * six meetingReport* fields and erased the report on its next save. The form
 * showed a truthful success; the data was wiped moments later by a peer.
 *
 * The fix (preserveNewerMeetingReport_ in mergeLeads_), keyed on
 * meetingReportedAt (only the backend ever stamps it):
 *   - sheet report NEWER than the incoming lead's (or incoming empty) →
 *     the sheet's six fields win; the client's copy wins everywhere else;
 *   - SAME reportedAt → client's copy stands (Vered's mark-seen path),
 *     but meetingSeen is sticky at '1';
 *   - incoming NEWER → client wins (restores data the sheet lost).
 *
 * Plus: submitMeetingReport_ now re-reads the row after the write and refuses
 * (write_verify_failed) when the report did not land — no false success — and
 * the form maps backend error codes to specific visible messages.
 *
 * Code.gs is loaded per the repo's vm-sandbox convention (see
 * meeting-report-backend.test.js) with the GAS globals stubbed. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

/* ---------- a minimal fake Sheet (same shape as meeting-report-backend) ---------- */
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
        clearContent() {
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
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
  let uuid = 0;
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
      setProperty(k, v) { sandbox.__props[k] = v; return this; },
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    handle: (params) => handle_(params).json,
    submitMeetingReport: (r) => submitMeetingReport_(r),
    getData: () => getData_(),
    preserveNewerMeetingReport: (m, e) => preserveNewerMeetingReport_(m, e),
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

function withLeads(leadsFields) {
  const { code, sandbox } = loadCode();
  const cols = arr(code.LEAD_COLUMNS);
  sandbox.__sheets['Leads'] = fakeSheet(cols, (leadsFields || []).map((f) => leadRow(cols, f)));
  sandbox.__props.MEETING_REPORT_SECRET = 's3cret';
  return { code, sandbox, cols };
}

function cell(sandbox, cols, id, colName) {
  const grid = sandbox.__sheets['Leads'].grid;
  const idIdx = cols.indexOf('id');
  for (let i = 1; i < grid.length; i++) {
    if (String(grid[i][idIdx]) === id) return grid[i][cols.indexOf(colName)];
  }
  return undefined;
}

const BASE_LEADS = [
  { id: 'L1', name: 'דני', phone: '0501234567', house: 'ramot', stage: 'visit', visitDate: '2026-08-20' },
  { id: 'L2', name: 'רות', phone: '0527654321', house: 'arfoni', stage: 'new', visitDate: '' },
];

/* What a dashboard tab holds for these leads: every LEAD_COLUMNS field
 * present, the six report fields as loaded (default: all empty — the state
 * of a tab opened BEFORE the manager reported). */
function clientCopy(cols, fields) {
  const obj = {};
  cols.forEach((c) => { obj[c] = ''; });
  Object.keys(fields).forEach((k) => { obj[k] = fields[k]; });
  return obj;
}

const REPORT = { leadId: 'L1', outcome: 'advancing', companion: 'mother', note: 'שיחה טובה', reporter: 'יעל' };

/* ===== THE production bug, end-to-end ===== */

test('REGRESSION: a stale dashboard saveAll no longer wipes a manager report', () => {
  const { code, sandbox, cols } = withLeads(BASE_LEADS);

  // 1. Manager submits through the real dispatcher (as the proxy does).
  const out = code.handle({ action: 'submitMeetingReport', secret: 's3cret', report: REPORT });
  assert.strictEqual(out.ok, true);
  const reportedAt = out.saved.reportedAt;
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), reportedAt);

  // 2. A dashboard tab loaded BEFORE the report saves: full lead list, all six
  //    report fields '' — exactly what state.leads holds in that tab — plus a
  //    legitimate edit of its own (the note field).
  const stale = [
    clientCopy(cols, { ...BASE_LEADS[0], note: 'עודכן מהדשבורד' }),
    clientCopy(cols, BASE_LEADS[1]),
  ];
  const saved = code.handle({ action: 'saveAll', leads: stale, patients: {} });
  assert.strictEqual(saved.ok, true);

  // 3. The report SURVIVES the clobber…
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportOutcome'), 'advancing');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingCompanion'), 'mother');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingNote'), 'שיחה טובה');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReporter'), 'יעל');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), reportedAt);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '', 'still unseen for Vered');

  // …the dashboard's own edit persists (client stays authoritative elsewhere)…
  assert.strictEqual(cell(sandbox, cols, 'L1', 'note'), 'עודכן מהדשבורד');

  // …and getData returns the report to a fresh dashboard load.
  const data = code.getData();
  const l1 = arr(data.leads).find((l) => String(l.id) === 'L1');
  assert.strictEqual(l1.meetingReportedAt, reportedAt);
  assert.strictEqual(l1.meetingReportOutcome, 'advancing');
});

test('a stale client carrying an OLDER report cannot regress a newer one', () => {
  const { code, sandbox, cols } = withLeads([
    {
      ...BASE_LEADS[0],
      meetingReportOutcome: 'advancing', meetingCompanion: 'parents',
      meetingNote: 'שני', meetingReporter: 'שירן',
      meetingReportedAt: '2026-08-30T10:00:00.000Z', meetingSeen: '',
    },
    BASE_LEADS[1],
  ]);
  const stale = [
    clientCopy(cols, {
      ...BASE_LEADS[0],
      meetingReportOutcome: 'no_show', meetingCompanion: 'alone',
      meetingNote: 'ראשון', meetingReporter: 'יעל',
      meetingReportedAt: '2026-08-29T08:00:00.000Z', meetingSeen: '1',
    }),
  ];
  assert.strictEqual(code.handle({ action: 'saveAll', leads: stale, patients: {} }).ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportOutcome'), 'advancing');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingNote'), 'שני');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReporter'), 'שירן');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), '2026-08-30T10:00:00.000Z');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '', 'the newer report stays unseen');
});

test("Vered's mark-seen still persists: same reportedAt, meetingSeen='1' goes through", () => {
  const at = '2026-08-30T10:00:00.000Z';
  const reported = {
    ...BASE_LEADS[0],
    meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
    meetingNote: 'שיחה', meetingReporter: 'יעל',
    meetingReportedAt: at, meetingSeen: '',
  };
  const { code, sandbox, cols } = withLeads([reported, BASE_LEADS[1]]);
  // Vered's tab loaded AFTER the report — same reportedAt — and marks seen.
  const fresh = [clientCopy(cols, { ...reported, meetingSeen: '1' })];
  assert.strictEqual(code.handle({ action: 'saveAll', leads: fresh, patients: {} }).ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '1');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), at);
});

test("meetingSeen is sticky: a peer tab with the SAME report cannot flip '1' back to unseen", () => {
  const at = '2026-08-30T10:00:00.000Z';
  const seen = {
    ...BASE_LEADS[0],
    meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
    meetingNote: 'שיחה', meetingReporter: 'יעל',
    meetingReportedAt: at, meetingSeen: '1',
  };
  const { code, sandbox, cols } = withLeads([seen]);
  const peer = [clientCopy(cols, { ...seen, meetingSeen: '' })];
  assert.strictEqual(code.handle({ action: 'saveAll', leads: peer, patients: {} }).ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '1');
});

test('a manager RESUBMISSION (newer reportedAt) still resets meetingSeen for Vered', () => {
  const { code, sandbox, cols } = withLeads([
    {
      ...BASE_LEADS[0],
      meetingReportOutcome: 'undecided', meetingCompanion: 'father',
      meetingNote: 'ראשון', meetingReporter: 'יעל',
      meetingReportedAt: '2026-08-29T08:00:00.000Z', meetingSeen: '1',
    },
  ]);
  const out = code.handle({ action: 'submitMeetingReport', secret: 's3cret', report: { ...REPORT, note: 'שני' } });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '', 'resubmission → unseen again');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingNote'), 'שני');
});

test('leads without a sheet report are untouched: saveAll writes the client copy verbatim (incl. new leads)', () => {
  const { code, sandbox, cols } = withLeads(BASE_LEADS);
  const payload = [
    clientCopy(cols, { ...BASE_LEADS[0], stage: 'waitlist' }),
    clientCopy(cols, { id: 'L9', name: 'חדש', house: 'sde', stage: 'new' }),
  ];
  assert.strictEqual(code.handle({ action: 'saveAll', leads: payload, patients: {} }).ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'stage'), 'waitlist');
  assert.strictEqual(cell(sandbox, cols, 'L9', 'name'), 'חדש');
  assert.strictEqual(cell(sandbox, cols, 'L9', 'meetingReportedAt'), '');
});

/* ===== preserveNewerMeetingReport_ unit edges ===== */

test('preserveNewerMeetingReport_: no existing row / no sheet report → no-op', () => {
  const { code } = withLeads([]);
  const cols = arr(code.LEAD_COLUMNS);
  const merged = { id: 'X', meetingReportedAt: '' };
  assert.deepStrictEqual(code.preserveNewerMeetingReport({ ...merged }, undefined), merged);
  const blankRow = cols.map(() => '');
  assert.strictEqual(code.preserveNewerMeetingReport({ ...merged }, blankRow).meetingReportedAt, '');
});

test('preserveNewerMeetingReport_: a Date-typed reportedAt cell on the sheet still protects the report', () => {
  const { code } = withLeads([]);
  const cols = arr(code.LEAD_COLUMNS);
  const row = cols.map(() => '');
  row[cols.indexOf('meetingReportedAt')] = new Date('2026-08-30T10:00:00.000Z');
  row[cols.indexOf('meetingReportOutcome')] = 'advancing';
  const merged = code.preserveNewerMeetingReport({ meetingReportedAt: '' }, row);
  assert.strictEqual(merged.meetingReportOutcome, 'advancing');
});

/* ===== write verification (no false success) ===== */

test('submitMeetingReport verifies the write landed: a silently-dropped write → ok:false write_verify_failed', () => {
  const { code, sandbox } = withLeads(BASE_LEADS);
  // Sabotage: the Leads sheet accepts reads/format calls but drops setValues —
  // the silent-write-failure class the confirmation screen used to hide.
  const sh = sandbox.__sheets['Leads'];
  const realGetRange = sh.getRange.bind(sh);
  sh.getRange = (r, c, nr, nc) => {
    const range = realGetRange(r, c, nr, nc);
    return { ...range, setValues: () => {}, setValue: () => {} };
  };
  const out = code.submitMeetingReport(REPORT);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'write_verify_failed');
});

test('happy path still succeeds through the verification read-back', () => {
  const { code } = withLeads(BASE_LEADS);
  const out = code.submitMeetingReport(REPORT);
  assert.strictEqual(out.ok, true);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(out.saved.reportedAt));
});

/* ===== form-side error visibility ===== */

test('mrSubmitErrorText: every backend error code maps to a specific visible message carrying the code', () => {
  const mr = require('../public/meeting-report.js');
  ['bad_lead', 'bad_outcome', 'bad_companion', 'bad_note', 'bad_reporter',
   'lead_not_found', 'unauthorized', 'meeting_report_not_configured',
   'sheets_unreachable', 'write_verify_failed', 'exception'].forEach((codeName) => {
    const text = mr.mrSubmitErrorText(codeName);
    assert.ok(text.indexOf('(' + codeName + ')') !== -1, codeName + ' appears in its message');
    assert.notStrictEqual(text, 'השליחה נכשלה — נסו שוב', codeName + ' is not the old generic');
  });
  // Unknown codes still surface verbatim; the bare default stays generic.
  assert.ok(mr.mrSubmitErrorText('weird_new_code').indexOf('(weird_new_code)') !== -1);
  assert.ok(mr.mrSubmitErrorText('submit_failed').indexOf('(') === -1);
  assert.ok(mr.mrSubmitErrorText('').length > 0);
});
