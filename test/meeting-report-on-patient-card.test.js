/* The manager report follows the patient on admission (public/app.js):
 *
 *   - patientMeetingReportLead resolves a patient's originating lead through
 *     the fromLead link (set by BOTH admit paths: openEntryModal and
 *     promoteEnteredLeads) and returns it only when a report exists —
 *     hand-entered patients (fromLead '') and dangling links yield null;
 *   - patientReportBlockHTML renders the shared דיווח מנהל block on the
 *     patient row, READ-ONLY: no unseen dot/tint, no edit/delete controls
 *     even in edit mode, an empty data-mrv-toggle id (so the shared toggle
 *     wiring can never mark-seen from the patient surface), wrapped in the
 *     full-width .pt-report grid cell; '' for a patient without a report;
 *   - the lead-surface rendering is unchanged (regression guard).
 *
 * Drives the real shipped functions in the repo's vm-sandbox (same load as
 * meeting-report-vered-view.test.js). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      patientMeetingReportLead: (p, ls) => patientMeetingReportLead(p, ls),
      patientReportBlockHTML: (p, ls) => patientReportBlockHTML(p, ls),
      meetingReportBlockHTML: (l, o) => meetingReportBlockHTML(l, o),
      setMode(m) { state.mode = m; },
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

/* An admitted lead: retired to stage 'admitted' by retireAdmittedLeads /
 * openEntryModal, report fields intact — exactly what stays in state.leads. */
function admittedLead(over) {
  return Object.assign({
    id: 'L1', name: 'דני', house: 'ramot', stage: 'admitted',
    visitDate: '2026-08-25', meetingWith: 'אורן',
    meetingReportOutcome: 'advancing', meetingCompanion: 'mother',
    meetingNote: 'שיחה טובה', meetingReporter: 'חנן',
    meetingReportedAt: '2026-08-29T10:15:00.000Z', meetingSeen: '',
  }, over || {});
}

function patient(over) {
  return Object.assign({
    id: 'P1', houseId: 'ramot', name: 'דני', date: '2026-08-30',
    pay: 10000, adv: 0, status: 'trial', fromLead: 'L1',
  }, over || {});
}

/* ===== the fromLead → report lookup ===== */

test('patientMeetingReportLead: fromLead resolves to the admitted lead with a report', () => {
  const lead = admittedLead();
  assert.strictEqual(app.patientMeetingReportLead(patient(), [lead]), lead);
});

test('patientMeetingReportLead: null without a report, a link, or a resolvable lead', () => {
  assert.strictEqual(app.patientMeetingReportLead(patient(), [admittedLead({ meetingReportedAt: '' })]),
    null, 'linked lead but no report');
  assert.strictEqual(app.patientMeetingReportLead(patient({ fromLead: '' }), [admittedLead()]),
    null, 'hand-entered patient (no fromLead)');
  assert.strictEqual(app.patientMeetingReportLead(patient({ fromLead: 'GONE' }), [admittedLead()]),
    null, 'dangling fromLead');
  assert.strictEqual(app.patientMeetingReportLead(patient(), []), null);
  assert.strictEqual(app.patientMeetingReportLead(patient(), null), null);
  assert.strictEqual(app.patientMeetingReportLead(null, [admittedLead()]), null);
});

/* ===== the patient-row block: renders, and is READ-ONLY ===== */

test('the report renders on the patient card for an admitted lead with a report', () => {
  const html = app.patientReportBlockHTML(patient(), [admittedLead()]);
  assert.ok(html.startsWith('<div class="pt-report">'), 'full-width grid-cell wrapper');
  assert.ok(html.includes('mrv-report'), 'the shared block markup');
  assert.ok(html.includes('דיווח מנהל'));
  assert.ok(html.includes('mrv-badge-advancing'), 'outcome badge carried over');
  assert.ok(html.includes('שיחה טובה'), 'the note text');
  assert.ok(html.includes('חנן'), 'the reporter');
});

test('no block for a patient without a report (or without a lead link)', () => {
  assert.strictEqual(app.patientReportBlockHTML(patient({ fromLead: '' }), [admittedLead()]), '');
  assert.strictEqual(app.patientReportBlockHTML(patient(), [admittedLead({ meetingReportedAt: '' })]), '');
  assert.strictEqual(app.patientReportBlockHTML(patient({ fromLead: 'GONE' }), [admittedLead()]), '');
});

test('edit/delete controls are absent on the patient card, even in edit mode', () => {
  app.setMode('edit');
  const html = app.patientReportBlockHTML(patient(), [admittedLead()]);
  assert.ok(!html.includes('mrv-actions'), 'no actions container');
  assert.ok(!html.includes('data-mrv-edit'), 'no edit button');
  assert.ok(!html.includes('data-mrv-delete'), 'no delete button');
});

test('no unseen cue and no mark-seen hook on the patient card', () => {
  app.setMode('edit');
  const html = app.patientReportBlockHTML(patient(), [admittedLead({ meetingSeen: '' })]);
  assert.ok(!html.includes('mrv-unseen'), 'no amber unseen tint');
  assert.ok(!html.includes('mrv-dot'), 'no glowing dot');
  assert.ok(html.includes('data-mrv-toggle=""'),
    'empty toggle id — wireMeetingReportToggle expands but never marks seen');
});

/* ===== regression: the lead surface is unchanged ===== */

test('the lead-surface block still shows unseen cue and edit-mode actions', () => {
  app.setMode('edit');
  const html = app.meetingReportBlockHTML(admittedLead({ meetingSeen: '' }));
  assert.ok(html.includes('mrv-unseen') && html.includes('mrv-dot'), 'unseen cue intact');
  assert.ok(html.includes('data-mrv-edit') && html.includes('data-mrv-delete'), 'actions intact');
  assert.ok(html.includes('data-mrv-toggle="L1"'), 'toggle id intact');
});
