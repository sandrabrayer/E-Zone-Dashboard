/* Tests for the meeting-report lead fields (foundation only — no UI).
 *
 * House managers will report what happened in a lead meeting (PR 2 form,
 * PR 3 Vered's view); this locks the schema plumbing added in PR 1. NOTE the
 * outcome column is meetingReportOutcome, NOT meetingOutcome — that name is
 * already taken by the live meetings-board feature with a different key set
 * (see meeting-outcome-foundation.test.js).
 *
 * Two source files are exercised, each loaded in its own vm sandbox the same
 * way the existing suite does it (see meeting-outcome-foundation.test.js):
 *   - apps-script/Code.gs — for LEAD_COLUMNS and the derived
 *     IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS (append-only contract:
 *     new lead fields land LAST, before nothing — and the derived arrays keep
 *     their sheet-specific extras at their own ends).
 *   - public/app.js — for normalizeLead, MEETING_REPORT_OUTCOME_LABELS and
 *     MEETING_COMPANION_LABELS, loaded by appending an epilogue that exposes
 *     them and evaluating with the browser globals stubbed.
 *
 * The contract locked here:
 *   - LEAD_COLUMNS ends with the six meeting-report columns in this exact
 *     order: meetingReportOutcome, meetingCompanion, meetingNote,
 *     meetingReporter, meetingReportedAt, meetingSeen (readSheet_ maps cells
 *     to keys by position, so any reorder or mid-array insert would silently
 *     corrupt reads);
 *   - IRRELEVANT_LEAD_COLUMNS / REMOVED_LEAD_COLUMNS inherit the new columns
 *     via .concat() with their extras still terminal;
 *   - normalizeLead round-trips all six fields (never silently dropped via
 *     upsertRowById_ writes) and defaults each to present-but-blank '' on
 *     legacy rows (no such columns, no backfill);
 *   - the label maps contain exactly the expected stable keys;
 *   - meetingReportedAt + meetingSeen are in the sheet-ensure plain-text ('@')
 *     force list, so ISO timestamps and the '1' flag survive Sheets coercion. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'apps-script', 'Code.gs'),
  'utf8'
);

function loadCode() {
  const epilogue = `
    globalThis.__test = {
      LEAD_COLUMNS: LEAD_COLUMNS,
      IRRELEVANT_LEAD_COLUMNS: IRRELEVANT_LEAD_COLUMNS,
      REMOVED_LEAD_COLUMNS: REMOVED_LEAD_COLUMNS,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(codeSrc + epilogue, sandbox);
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
      MEETING_REPORT_OUTCOME_LABELS: MEETING_REPORT_OUTCOME_LABELS,
      MEETING_COMPANION_LABELS: MEETING_COMPANION_LABELS,
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

const MEETING_REPORT_FIELDS = [
  'meetingReportOutcome',
  'meetingCompanion',
  'meetingNote',
  'meetingReporter',
  'meetingReportedAt',
  'meetingSeen',
];

test('LEAD_COLUMNS ends with the six meeting-report columns in exact order', () => {
  const cols = Array.from(code.LEAD_COLUMNS);
  assert.deepStrictEqual(
    cols.slice(-6),
    MEETING_REPORT_FIELDS,
    'the six meeting-report columns must be the terminal columns, in order'
  );
  // Append-only: each appears exactly once, and the pre-existing meetings-board
  // meetingOutcome column is untouched (still present, still exactly once).
  for (const f of MEETING_REPORT_FIELDS.concat(['meetingOutcome'])) {
    assert.strictEqual(
      cols.filter((c) => c === f).length, 1,
      f + ' must appear exactly once'
    );
  }
});

test('IRRELEVANT_LEAD_COLUMNS inherits the new columns with its extras still terminal', () => {
  const cols = Array.from(code.IRRELEVANT_LEAD_COLUMNS);
  assert.deepStrictEqual(
    cols.slice(0, code.LEAD_COLUMNS.length),
    Array.from(code.LEAD_COLUMNS),
    'must start with all of LEAD_COLUMNS (new lead fields before the extras)'
  );
  assert.deepStrictEqual(
    cols.slice(code.LEAD_COLUMNS.length),
    ['originSheet', 'movedAt', 'not_relevant_reason', 'not_relevant_note', 'disposition'],
    'sheet-specific extras must stay at the end'
  );
});

test('REMOVED_LEAD_COLUMNS inherits the new columns with its extras still terminal', () => {
  const cols = Array.from(code.REMOVED_LEAD_COLUMNS);
  assert.deepStrictEqual(
    cols.slice(0, code.LEAD_COLUMNS.length),
    Array.from(code.LEAD_COLUMNS),
    'must start with all of LEAD_COLUMNS (new lead fields before the extras)'
  );
  assert.deepStrictEqual(
    cols.slice(code.LEAD_COLUMNS.length),
    ['removedAt', 'originSheet'],
    'sheet-specific extras must stay at the end'
  );
});

test('normalizeLead round-trips all six meeting-report fields without dropping any', () => {
  const input = {
    id: 'L1', name: 'x', stage: 'visit',
    meetingReportOutcome: 'advancing',
    meetingCompanion:     'סבתא רבתא',   // free text from אחר — stored raw
    meetingNote:          'שיחה טובה, מתקדמים',
    meetingReporter:      'יעל',
    meetingReportedAt:    '2026-08-29T10:15:00.000Z',
    meetingSeen:          '1',
  };
  const first  = app.normalizeLead(input);
  const second = app.normalizeLead(first);   // simulate a save/load round-trip
  for (const f of MEETING_REPORT_FIELDS) {
    assert.strictEqual(second[f], input[f], f + ' must survive the round-trip');
  }
});

test('normalizeLead defaults missing meeting-report fields to present-but-blank', () => {
  const out = app.normalizeLead({ id: 'L2', name: 'ליד ישן', stage: 'new' });
  for (const f of MEETING_REPORT_FIELDS) {
    assert.ok(f in out, f + ' key must be present');
    assert.strictEqual(out[f], '', f + ' must default to \'\'');
  }
});

test('MEETING_REPORT_OUTCOME_LABELS contains exactly the four stable keys', () => {
  const labels = app.MEETING_REPORT_OUTCOME_LABELS;
  assert.deepStrictEqual(
    Object.keys(labels).sort(),
    ['advancing', 'no_show', 'not_fit', 'undecided']
  );
  assert.strictEqual(labels.advancing, 'התקיימה — מתקדם לכניסה');
  assert.strictEqual(labels.undecided, 'התקיימה — מתלבט');
  assert.strictEqual(labels.not_fit,   'התקיימה — לא מתאים');
  assert.strictEqual(labels.no_show,   'לא הגיע / בוטל');
});

test('MEETING_COMPANION_LABELS contains exactly the eight stable keys', () => {
  const labels = app.MEETING_COMPANION_LABELS;
  assert.deepStrictEqual(
    Object.keys(labels).sort(),
    ['alone', 'father', 'friend', 'mother', 'other', 'parents', 'partner', 'sibling']
  );
  assert.strictEqual(labels.mother,  'אמא');
  assert.strictEqual(labels.father,  'אבא');
  assert.strictEqual(labels.parents, 'הורים');
  assert.strictEqual(labels.partner, 'בן/בת זוג');
  assert.strictEqual(labels.sibling, 'אח/אחות');
  assert.strictEqual(labels.friend,  'חבר');
  assert.strictEqual(labels.alone,   'לבד');
  assert.strictEqual(labels.other,   'אחר');
});

test('meetingReportedAt + meetingSeen are in the leads sheet plain-text force list', () => {
  // The ensure path runs against SpreadsheetApp so it can't execute in the
  // sandbox; assert on the source instead — the LEADS_SHEET forceColumnsText_
  // call must name both columns so Sheets never coerces the ISO timestamp into
  // a Date cell or '1' into the number 1.
  const m = codeSrc.match(
    /if \(name === LEADS_SHEET\) \{[\s\S]*?forceColumnsText_\(sh, LEAD_COLUMNS,\s*(\[[\s\S]*?\])\)/
  );
  assert.ok(m, 'the LEADS_SHEET forceColumnsText_ call must exist');
  const names = m[1];
  for (const col of ['visitDate', 'visitTime', 'waitlistedAt', 'meetingReportedAt', 'meetingSeen']) {
    assert.ok(names.includes(`'${col}'`), col + ' must be text-forced at sheet-ensure time');
  }
});
