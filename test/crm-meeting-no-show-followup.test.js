'use strict';
/* CRM-PRODUCT-FLOW-01: source-backed "not held" manager reports in Vered's
 * work queue. No new sheet, task engine, stage value, save action or payment. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../public/crm/crm.js');

const TODAY = '2026-11-02';
const baseLead = (changes) => Object.assign({
  id: 'lead-synthetic-ns', name: 'בדיקת פגישה', house: 'ramot',
  stage: 'visit', created: '2026-10-15',
  visitDate: '2026-10-30', visitTime: '12:00',
  meetingWith: 'מנהל בדיקה', meetingReportedAt: '2026-10-30T14:00:00.000Z',
  meetingReporter: 'מנהל בדיקה', meetingReportOutcome: 'no_show',
  meetingSeen: '1', meetingOutcome: '', assignedTo: 'ורד'
}, changes || {});
const data = (leads) => ({
  ok: true, leads: leads || [], patients: {}, dischargedPatients: [],
  irrelevantLeads: [], removedLeads: [], outpatientSentLeadIds: []
});
const me = { view: 'ops', finance: false, user: 'ורד' };
const index = { ok: true, leads: {}, patients: {} };
const day = (...leads) => core.myDay(core.compute(data(leads), TODAY), [], index, null, TODAY, me, {});

test('P1: manager-reported no-show / cancellation is an actionable callback, never a held meeting', () => {
  const m = day(baseLead());
  const rows = m.byDomain.followup;
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, 'f:decide:lead-synthetic-ns', 'retain the source-derived row ID');
  assert.equal(r.kind, 'meeting_no_show_followup');
  assert.match(r.action, /לברר.*לתאם/);
  assert.match(r.why, /לא הגיע\s*\/\s*בוטל/);
  assert.match(r.why, /לא התקיים/);
  assert.equal(r.owner, 'ורד');
  assert.equal(r.subjectId, 'lead-synthetic-ns');
  assert.equal(r.subjectKind, 'lead');
  assert.equal(r.open, 'meetings');
  assert.equal(r.contactable, true, 'open the real existing contact form');
  assert.equal(r.priority, 'exception');
  assert.equal(r.when, '2026-10-30');
  assert.equal(m.urgent.filter(x => x.id === r.id).length, 1, 'no duplicate derived work');
  assert.equal(m.byDomain.meetings.filter(x => x.subjectId === r.subjectId).length, 0);
});

test('P1: unread manager no-show report first remains unread and shows the source outcome', () => {
  const m = day(baseLead({ meetingSeen: '' }));
  const rows = m.byDomain.followup;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'report_unseen');
  assert.match(rows[0].why, /לא הגיע\s*\/\s*בוטל/);
  assert.notEqual(rows[0].contactable, true);
  assert.equal(rows[0].open, 'meetings');
});

test('P1: a different manager outcome keeps the original family-decision workflow', () => {
  const m = day(baseLead({ meetingReportOutcome: 'undecided' }));
  assert.equal(m.byDomain.followup.length, 1);
  assert.equal(m.byDomain.followup[0].kind, 'report_undecided');
  assert.match(m.byDomain.followup[0].action, /להחליט אחרי דיווח/);
  assert.notEqual(m.byDomain.followup[0].contactable, true);
});

test('P1: a documented family cancellation does not generate a fresh no-show callback', () => {
  const m = day(baseLead({ meetingOutcome: 'cancelled' }));
  assert.equal(m.byDomain.followup.length, 0);
});

test('P1: a past planned date alone never proves that a meeting actually took place', () => {
  const rows = core.compute(data([baseLead({ meetingReportedAt: '', meetingSeen: '', meetingReportOutcome: '' })]), TODAY).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'meeting_no_outcome');
  assert.match(rows[0].reason, /תאריך.*חלף.*לא.*אישור/);
  assert.doesNotMatch(rows[0].reason, /הפגישה התקיימה/);
});

test('P1: source manager report and existing contact navigation remain role-scoped and HTML-escaped', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.match(src, /data-contact-open/);
  assert.match(src, /esc\(r\.why\)/);
  assert.match(src, /meetingReportOutcome === 'no_show'/);
  assert.doesNotMatch(src, /action:\s*'setMeetingNoShow'/, 'no second writable manager report action');
});
