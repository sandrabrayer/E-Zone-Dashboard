/* Backend tests for PR 4's guard-compatible edit/delete (apps-script/Code.gs),
 * against the #94 merge guard in mergeLeads_:
 *
 *   - EDIT round-trips: a saveAll carrying the SAME meetingReportedAt as the
 *     sheet (Vered's content edit — she never touches the timestamp) persists
 *     its content through the guard;
 *   - deleteMeetingReport (dedicated action): clears exactly the six report
 *     fields on the sheet row, preserves the rest, is idempotent, verifies
 *     the write, rejects a missing/unknown leadId;
 *   - delete SURVIVES a stale tab: a saveAll from a tab still holding the
 *     old report cannot resurrect it onto the cleared row (differing
 *     timestamp → the sheet's empty report wins) — the reason delete had to
 *     become a dedicated action in the first place;
 *   - the deleting tab's own next saveAll (fields cleared locally too) is
 *     inert — equal empty timestamps;
 *   - the raced edit: a saveAll carrying an OLDER timestamp than the sheet
 *     (manager resubmitted mid-edit) keeps the sheet's newer report AND is
 *     flagged in the response's reportConflicts, so the dashboard can tell
 *     Vered instead of pretending success.
 *
 * Same vm-sandbox conventions as meeting-report-write-fix.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);

/* ---------- a minimal fake Sheet (same shape as meeting-report-write-fix) ---------- */
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
    __sheets: {},
    __props: {},
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
    getData: () => getData_(),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

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

/* What a dashboard tab's saveAll sends for a lead: every column present. */
function clientCopy(cols, fields) {
  const obj = {};
  cols.forEach((c) => { obj[c] = ''; });
  Object.keys(fields).forEach((k) => { obj[k] = fields[k]; });
  return obj;
}

const AT = '2026-08-29T10:15:00.000Z';

const REPORTED = {
  id: 'L1', name: 'דני', phone: '0501234567', house: 'ramot', stage: 'visit',
  visitDate: '2026-08-25', note: 'הערה פנימית', created: '2026-08-01',
  meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
  meetingNote: 'שיחה טובה', meetingReporter: 'חנן',
  meetingReportedAt: AT, meetingSeen: '1',
};

const REPORT_FIELDS = [
  'meetingReportOutcome', 'meetingCompanion', 'meetingNote',
  'meetingReporter', 'meetingReportedAt', 'meetingSeen',
];

/* ===== edit round-trips through the merge guard ===== */

test("Vered's edit (same reportedAt) round-trips through mergeLeads_ post-guard", () => {
  const { code, sandbox, cols } = withLeads([REPORTED]);
  const edited = clientCopy(cols, {
    ...REPORTED,
    meetingReportOutcome: 'no_show',
    meetingCompanion: 'father',
    meetingNote: 'תוקן ע"י ורד',
    // meetingReporter / meetingReportedAt / meetingSeen unchanged — the edit
    // never touches them, which is exactly what lets it through the guard.
  });
  const res = code.handle({ action: 'saveAll', leads: [edited], patients: {} });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(arr(res.reportConflicts || []), [], 'no conflict — the edit saved');

  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportOutcome'), 'no_show');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingCompanion'), 'father');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingNote'), 'תוקן ע"י ורד');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReporter'), 'חנן', 'attribution kept');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), AT, 'timestamp kept');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '1');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'note'), 'הערה פנימית', 'row intact');
});

/* ===== deleteMeetingReport — the dedicated action ===== */

test('deleteMeetingReport clears exactly the six fields on the sheet row', () => {
  const { code, sandbox, cols } = withLeads([REPORTED]);
  const res = code.handle({ action: 'deleteMeetingReport', leadId: 'L1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.deleted.leadId, 'L1');

  REPORT_FIELDS.forEach((f) => assert.strictEqual(cell(sandbox, cols, 'L1', f), '', `${f} cleared`));
  assert.strictEqual(cell(sandbox, cols, 'L1', 'name'), 'דני', 'row otherwise intact');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'phone'), '0501234567');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'note'), 'הערה פנימית');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'visitDate'), '2026-08-25');
});

test('deleteMeetingReport: unknown/missing leadId refused; report-less lead is idempotent ok', () => {
  const { code } = withLeads([REPORTED, { ...REPORTED, id: 'L2', meetingReportedAt: '', meetingReportOutcome: '', meetingCompanion: '', meetingNote: '', meetingReporter: '', meetingSeen: '' }]);
  assert.strictEqual(code.handle({ action: 'deleteMeetingReport', leadId: 'nope' }).error, 'lead_not_found');
  assert.strictEqual(code.handle({ action: 'deleteMeetingReport' }).error, 'bad_lead');
  assert.strictEqual(code.handle({ action: 'deleteMeetingReport', leadId: 'L2' }).ok, true, 'idempotent');
});

/* ===== delete survives stale tabs ===== */

test('REGRESSION: a stale tab cannot resurrect a deleted report via saveAll', () => {
  const { code, sandbox, cols } = withLeads([REPORTED]);
  assert.strictEqual(code.handle({ action: 'deleteMeetingReport', leadId: 'L1' }).ok, true);

  // A tab that loaded BEFORE the delete still holds the full report and
  // saves (any inline edit fires saveAll with the whole list).
  const stale = clientCopy(cols, { ...REPORTED, note: 'עריכה מטאב ישן' });
  const res = code.handle({ action: 'saveAll', leads: [stale], patients: {} });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(arr(res.reportConflicts || []), ['L1'], 'the echo is flagged');

  REPORT_FIELDS.forEach((f) =>
    assert.strictEqual(cell(sandbox, cols, 'L1', f), '', `${f} stays deleted`));
  assert.strictEqual(cell(sandbox, cols, 'L1', 'note'), 'עריכה מטאב ישן',
    "the stale tab's own edit still lands");
});

test("the deleting tab's own next saveAll (locally cleared) is inert — no conflict", () => {
  const { code, sandbox, cols } = withLeads([REPORTED]);
  assert.strictEqual(code.handle({ action: 'deleteMeetingReport', leadId: 'L1' }).ok, true);

  // The frontend cleared its local copy on success, so the echo matches the
  // sheet: empty timestamp on both sides.
  const echo = clientCopy(cols, {
    ...REPORTED,
    meetingReportOutcome: '', meetingCompanion: '', meetingNote: '',
    meetingReporter: '', meetingReportedAt: '', meetingSeen: '',
  });
  const res = code.handle({ action: 'saveAll', leads: [echo], patients: {} });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(arr(res.reportConflicts || []), [], 'no conflict flagged');
  REPORT_FIELDS.forEach((f) =>
    assert.strictEqual(cell(sandbox, cols, 'L1', f), '', `${f} still empty`));
});

/* ===== the raced edit: manager resubmits mid-edit ===== */

test('an edit carrying an OLDER reportedAt loses to the newer report AND is flagged', () => {
  // The manager resubmitted AFTER Vered opened her edit modal: the sheet now
  // holds a NEWER report than the one her save carries.
  const NEWER = '2026-08-30T09:00:00.000Z';
  const { code, sandbox, cols } = withLeads([{
    ...REPORTED,
    meetingReportOutcome: 'undecided', meetingCompanion: 'alone',
    meetingNote: 'דיווח חדש מהמנהל', meetingReporter: 'חנן',
    meetingReportedAt: NEWER, meetingSeen: '',
  }]);

  const veredsEdit = clientCopy(cols, {
    ...REPORTED, // still carries the OLD timestamp (AT)
    meetingReportOutcome: 'no_show', meetingNote: 'העריכה של ורד',
  });
  const res = code.handle({ action: 'saveAll', leads: [veredsEdit], patients: {} });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(arr(res.reportConflicts || []), ['L1'],
    'the discarded edit is REPORTED, never silent');

  // The manager's newer report survives untouched.
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportOutcome'), 'undecided');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingNote'), 'דיווח חדש מהמנהל');
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingReportedAt'), NEWER);
  assert.strictEqual(cell(sandbox, cols, 'L1', 'meetingSeen'), '', 'still unseen for Vered');
});

test('a report submitted through the manager form still lands and reads back (end-to-end sanity)', () => {
  const { code, sandbox, cols } = withLeads([
    { id: 'L9', name: 'רות', house: 'arfoni', stage: 'visit', visitDate: '2026-08-28' },
  ]);
  const out = code.handle({
    action: 'submitMeetingReport', secret: 's3cret',
    report: { leadId: 'L9', outcome: 'advancing', companion: 'parents', note: '', reporter: 'יעל' },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(cell(sandbox, cols, 'L9', 'meetingReportOutcome'), 'advancing');
  const data = code.getData();
  const l9 = arr(data.leads).find((l) => String(l.id) === 'L9');
  assert.strictEqual(l9.meetingReportedAt, out.saved.reportedAt);
});
