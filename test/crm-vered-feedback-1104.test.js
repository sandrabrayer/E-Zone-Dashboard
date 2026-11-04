'use strict';

/* Vered's CRM feedback, 04/11/2026 (CHANGELOG-crm-vered-feedback-1104.md).
 *
 * A. pure (public/crm/crm.js): the 3-day grace on a missing manager report; the
 *    May cutoff; «מה דחוף בבתים» out of «היום שלי»; «פניות» → «לידים»; the
 *    waitlist reason; the patient-side meeting cancel / change, its card text and
 *    the manager's WhatsApp text / link.
 * B. source guards: the app icon (tab + menu), no urgent band.
 * C. the REAL Code.gs: logLeadFlag (validation, idempotency, gate) and the flags
 *    contactIndex serves (latest wins). No Leads column is added.
 * Names / phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');
const TODAY = '2026-11-04';
const VERED = { view: 'full', finance: true, user: 'ורד' };
const DANA = { view: 'ops', finance: false, user: 'דנה' };
const INDEX = (flags) => ({ ok: true, leads: {}, patients: {}, flags: flags || {} });
const lead = (o) => Object.assign({ id: 'L1', name: 'אריאל בדיקה', house: 'pardes', stage: 'visit', visitDate: '2026-11-03', visitTime: '09:00', meetingWith: 'חן', created: '2026-10-30' }, o);
const day = (leads, index, me) => core.myDay(core.compute({ ok: true, leads, patients: {}, dischargedPatients: [], irrelevantLeads: [], removedLeads: [] }, TODAY), [], index || INDEX(), null, TODAY, me || DANA, {});

/* ================= A. pure ================= */

test('A: a missing manager report is «ממתין» for 3 days after the meeting, an exception from day 3', () => {
  assert.equal(core.MANAGER_REPORT_GRACE_DAYS, 3);
  const fresh = lead({ visitDate: '2026-11-03' });           // 1 day
  const two = lead({ id: 'L2', visitDate: '2026-11-02' });   // 2 days
  const three = lead({ id: 'L3', visitDate: '2026-11-01' }); // 3 days
  assert.equal(core.reportOverdue(fresh, TODAY), false); assert.equal(core.reportOverdue(two, TODAY), false); assert.equal(core.reportOverdue(three, TODAY), true);
  assert.deepEqual(core.nextActionFor(fresh, TODAY), { text: 'ממתין לדיווח מנהל/ת', state: 'wait' });
  assert.deepEqual(core.nextActionFor(three, TODAY), { text: 'דיווח המנהל/ת באיחור', state: 'late' });
  const m = day([fresh, two, three]);
  const rows = m.byDomain.followup.filter((r) => r.kind === 'awaiting_report');
  assert.deepEqual(rows.map((r) => [r.subjectId, r.priority, r.state]), [['L3', 'exception', 'late'], ['L2', 'wait', 'wait'], ['L1', 'wait', 'wait']]);
  assert.match(rows[1].why, /הדיווח צפוי עד 05\/11\/2026/);
  assert.match(rows[0].why, /3 ימים ללא דיווח המנהל\/ת/);
  assert.deepEqual(m.exceptions.map((r) => r.subjectId), ['L3'], 'only the late one is an exception');
  // the derived queue (compute) agrees
  const q = core.compute({ ok: true, leads: [fresh, three], patients: {} }, TODAY).rows;
  assert.deepEqual(q.map((r) => [r.leadId, r.state]).sort(), [['L1', 'wait'], ['L3', 'late']]);
});

test('A: follow-up rows dated May 2026 and earlier are not listed; June on is', () => {
  assert.equal(core.EXCEPTION_CUTOFF, '2026-06-01');
  const may = lead({ id: 'L-may', visitDate: '2026-05-27' });
  const june = lead({ id: 'L-jun', visitDate: '2026-06-05' });
  const m = day([may, june]);
  assert.deepEqual(m.byDomain.followup.map((r) => r.subjectId), ['L-jun']);
});

test('A: «מה דחוף בבתים» is out of «היום שלי» — no domain, no card, no admission / continuity rows; «תפוסה» keeps houseExceptions', () => {
  assert.ok(!core.DOMAINS.some((d) => d.id === 'houses'));
  const c = core.compute({ ok: true, leads: [lead({ id: 'L-paid', stage: 'paid', entryDate: '2026-10-01', visitDate: '' })], patients: {},
    dischargedPatients: [{ id: 'dx1', patientId: 'px', name: 'מאי', houseId: 'ramot', exitDate: '2026-05-27', dischargedAt: '2026-05-27T09:00:00.000Z', disposition: 'completed' }] }, TODAY);
  for (const me of [VERED, DANA]) {
    const m = core.myDay(c, [], INDEX(), null, TODAY, me, {});
    assert.ok(!m.cards.some((k) => k.id === 'houses' || k.label === 'מה דחוף בבתים'), me.user + ': no «מה דחוף בבתים» card');
    assert.ok(!JSON.stringify(m.byDomain).includes('admission_due') && !JSON.stringify(m.byDomain).includes('"continuity"'), me.user + ': no house rows');
  }
  assert.deepEqual(core.houseExceptions(c, TODAY).map((r) => r.kind), ['admission_due', 'continuity'], 'the helper itself is unchanged');
});

test('A: «פניות» → «לידים» in the menu, the nav group and the new-leads card', () => {
  assert.deepEqual(core.NAV_GROUPS[1], { label: 'לידים ומטופלים', items: ['leads', 'clients'] });
  assert.equal(core.DOMAIN_LABELS.newleads, 'לידים חדשים ללא מגע');
  assert.match(CRM_SRC, /\{ id: 'leads', label: 'לידים' \}/);
  assert.ok(!/label: 'פניות/.test(CRM_SRC), 'no «פניות» label left');
  assert.match(CRM_HTML, /placeholder="חיפוש לקוח \/ ליד"/);
  assert.match(CRM_SRC, /'פנייה ישירה \(נוסף בתפוסה\)'/, 'the «פנייה ישירה» source key text is untouched');
});

test('A: the waitlist reason — «ממתין למקום» by default, «ממתין לאישור הקופה» from the flag', () => {
  assert.deepEqual(core.WAIT_REASONS.map((r) => r.label), ['ממתין למקום', 'ממתין לאישור הקופה']);
  const w = lead({ stage: 'waitlist', visitDate: '' });
  assert.deepEqual(core.nextActionFor(w, TODAY), { text: 'ממתין למקום', state: 'wait' });
  const fl = core.flagsOf(INDEX({ L1: { waitReason: { reason: 'funder', at: '2026-11-04T08:00:00.000Z' } } }), 'L1');
  assert.deepEqual(core.nextActionFor(w, TODAY, fl), { text: 'ממתין לאישור הקופה', state: 'wait' });
  assert.equal(core.waitReasonLabel('bogus'), 'ממתין למקום');
  assert.equal(core.flagsOf(null, 'L1'), null); assert.equal(core.flagsOf({ ok: true }, 'L1'), null);
});

test('A: patientChangePlan — validation; cancel → meetingOutcome cancelled; reschedule → new date / time, outcome cleared; the flag carries the previous slot', () => {
  const l = lead({ visitDate: '2026-11-05', visitTime: '10:00' });
  assert.deepEqual(Object.keys(core.patientChangePlan(l, {}, TODAY).errors), ['change']);
  assert.deepEqual(Object.keys(core.patientChangePlan(l, { change: 'rescheduled', newDate: '2026-11-01' }, TODAY).errors), ['newDate'], 'no past date');
  assert.deepEqual(Object.keys(core.patientChangePlan(l, { change: 'rescheduled', newDate: '2026-11-09', newTime: '9am' }, TODAY).errors), ['newTime']);
  assert.deepEqual(Object.keys(core.patientChangePlan(l, { change: 'cancelled', note: 'x'.repeat(201) }, TODAY).errors), ['note']);
  const c = core.patientChangePlan(l, { change: 'cancelled', note: 'המשפחה חולה' }, TODAY);
  assert.deepEqual(c.patch, { meetingOutcome: 'cancelled' });
  assert.deepEqual(c.flag, { leadId: 'L1', kind: 'meeting_patient_change', change: 'cancelled', prevDate: '2026-11-05', prevTime: '10:00', withWhom: 'חן', note: 'המשפחה חולה' });
  const r = core.patientChangePlan(l, { change: 'rescheduled', newDate: '2026-11-09', newTime: '11:30' }, TODAY);
  assert.deepEqual(r.patch, { visitDate: '2026-11-09', visitTime: '11:30', meetingOutcome: '' });
  assert.equal(r.flag.newDate, '2026-11-09'); assert.equal(r.flag.prevDate, '2026-11-05');
  assert.deepEqual(core.leadFlagBody('sub-' + '1'.repeat(32), c.flag), { action: 'logLeadFlag', submissionId: 'sub-' + '1'.repeat(32), flag: c.flag });
});

test('A: a patient cancellation shows on the card and opens ONE «לתאם מועד חדש» row; a cancellation Vered documented herself stays settled; a stale change is history only', () => {
  const cancelled = lead({ meetingOutcome: 'cancelled', visitDate: '2026-11-05' });
  const ch = { change: 'cancelled', prevDate: '2026-11-05', prevTime: '09:00', withWhom: 'חן', at: '2026-11-04T08:00:00.000Z', actorName: 'ורד' };
  const idx = INDEX({ L1: { meetingChange: ch } });
  assert.deepEqual(core.nextActionFor(cancelled, TODAY, core.flagsOf(idx, 'L1')), { text: 'בוטלה ע״י המטופל/ת — לתאם מחדש', state: 'late' });
  assert.deepEqual(core.nextActionFor(cancelled, TODAY), { text: 'הפגישה בוטלה — לתאם מחדש', state: 'late' });
  const m = day([cancelled], idx);
  assert.deepEqual(m.byDomain.followup.map((r) => [r.kind, r.priority]), [['meeting_cancelled', 'today']]);
  assert.match(m.byDomain.followup[0].why, /בוטלה ע״י המטופל\/ת \(נקבעה ל-05\/11\/2026\)/);
  assert.equal(m.byDomain.meetings.length, 0, 'a cancelled meeting is not a meeting');
  assert.equal(day([cancelled]).byDomain.followup.length, 0, 'documented by Vered, no patient flag → no fresh row');
  // a cancelled meeting dated today is not «פגישה היום»
  assert.equal(day([lead({ visitDate: TODAY, meetingOutcome: 'cancelled' })], idx).meetingsToday.length, 0);
  // reschedule: the marker shows while the lead still has that date
  const moved = lead({ visitDate: '2026-11-09', visitTime: '11:30', meetingOutcome: '' });
  const mv = { meetingChange: { change: 'rescheduled', prevDate: '2026-11-05', prevTime: '09:00', newDate: '2026-11-09', newTime: '11:30', at: '2026-11-04T08:00:00.000Z' } };
  assert.deepEqual(core.nextActionFor(moved, TODAY, mv), { text: 'פגישה 09/11/2026 · שונתה ע״י המטופל/ת', state: 'wait' });
  assert.equal(core.patientMeetingChange(lead({ visitDate: '2026-11-12' }), mv), null, 'Vered moved it again since → no longer the patient’s change');
  assert.equal(core.patientMeetingChange(lead({ meetingOutcome: '' }), { meetingChange: ch }), null, 'cancelled flag but the meeting was re-opened');
});

test('A: the manager message — Hebrew, names the house and both slots; the wa.me link takes digits only and encodes the text', () => {
  const l = lead({ name: 'נדב שמשי', house: 'ramot' });
  const c = core.managerChangeMessage(l, { change: 'cancelled', prevDate: '2026-11-04', prevTime: '11:00', note: 'יחזרו אלינו' });
  assert.equal(c, 'עדכון פגישה — נדב שמשי (רמות השבים): הפגישה שנקבעה ל-04/11/2026 בשעה 11:00 בוטלה ע״י המטופל/ת.\nהערה: יחזרו אלינו');
  const r = core.managerChangeMessage(l, { change: 'rescheduled', prevDate: '2026-11-04', prevTime: '11:00', newDate: '2026-11-08', newTime: '' });
  assert.equal(r, 'עדכון פגישה — נדב שמשי (רמות השבים): המטופל/ת שינה/תה את מועד הפגישה מ-04/11/2026 בשעה 11:00 ל-08/11/2026.');
  assert.equal(core.managerWaUrl('972-50-123-4567', 'שלום & ok'), 'https://wa.me/972501234567?text=' + encodeURIComponent('שלום & ok'));
  assert.equal(core.managerWaUrl('', 'x'), 'https://wa.me/?text=x', 'unknown phone → the sender picks the chat');
  assert.equal(core.managerWaUrl('javascript:alert(1)', 'x'), 'https://wa.me/?text=x', 'never anything but digits in the path');
});

test('A: the calendar says «בוטלה» and the outcome in Hebrew, never the stable key', () => {
  const rows = core.calendarRows([lead({ visitDate: '2026-11-02', meetingOutcome: 'cancelled' }), lead({ id: 'L2', visitDate: '2026-11-03', meetingOutcome: 'thinking' })], { mode: 'week', from: '2026-11-01', to: '2026-11-07' }, TODAY);
  assert.deepEqual(rows.map((r) => r.status.text), ['בוטלה', 'חושבים על זה']);
  assert.equal(core.meetingOutcomeLabel('cancelled'), 'התבטל');
  assert.ok(!/esc\(m\.visit\.outcome \|\| 'ללא תוצאה'\)/.test(CRM_SRC), 'the drawer no longer prints the raw key');
});

/* ================= B. source guards ================= */

test('B: the app icon is in the browser tab and in the menu header; the urgent band is gone from «היום שלי»', () => {
  assert.match(CRM_HTML, /<link rel="icon" type="image\/png" href="\/icons\/icon-192\.png">/);
  assert.match(CRM_HTML, /<img class="logo" src="\/icons\/icon-192\.png" alt=""/);
  assert.ok(!CRM_SRC.includes('חריגים דחופים ומחויבויות להיום'));
  assert.ok(!CRM_SRC.includes('<div class="group-title">חריגים בבתים'), 'no side «חריגים בבתים» box');
  assert.match(CRM_SRC, /data-wa-manager/); assert.match(CRM_SRC, /esc\(waUrl\)/); assert.match(CRM_SRC, /esc\(managerChangeLink\(m\.lead\)\)/);
});

/* ================= C. Code.gs ================= */

const PROXY_SECRET = 'proxy-secret-TEST-flags-0123456789abcdef01234';
const actor = (id, user, roles, caps) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
const VERED_A = actor('vered', 'ורד', ['staff'], ['finance', 'billingControl']);
const DANA_A = actor('dana', 'דנה', ['staff'], []);
const plain = (x) => JSON.parse(JSON.stringify(x));
const SID = (n) => 'sub-' + String(n).padStart(32, '0');

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const ls = richSheet('Leads', lc);
  ls.grid.push(lc.map((c) => ({ id: 'L1', name: 'נדב שמשי', house: 'רמות השבים', stage: 'visit', visitDate: '2026-11-04', visitTime: '11:00', meetingWith: 'אורן' })[c] ?? ''));
  g.sandbox.__sheets.Leads = ls;
  return { g, lc, post: (body, who) => plain(g.post(Object.assign(body, who || VERED_A))) };
}

test('C: logLeadFlag writes ONE Activity event per submission; contactIndex serves the latest flag per kind; Dana reads the same', () => {
  const w = world();
  const before = Array.from(w.g.run('LEAD_COLUMNS'));
  assert.ok(Array.from(w.g.run('PROXY_KNOWN_ACTIONS')).includes('logLeadFlag'));
  const r1 = w.post({ action: 'logLeadFlag', submissionId: SID(1), flag: { leadId: 'L1', kind: 'waitlist_reason', reason: 'place' } });
  assert.equal(r1.ok, true); assert.equal(r1.flag.reason, 'place'); assert.equal(r1.flag.actorName, 'ורד');
  const again = w.post({ action: 'logLeadFlag', submissionId: SID(1), flag: { leadId: 'L1', kind: 'waitlist_reason', reason: 'place' } });
  assert.equal(again.ok, true); assert.equal(again.replayed, true, 'a retry of the same submission adds nothing');
  assert.equal(w.post({ action: 'logLeadFlag', submissionId: SID(2), flag: { leadId: 'L1', kind: 'waitlist_reason', reason: 'funder' } }, DANA_A).ok, true, 'Dana (ops) may set it');
  const ch = w.post({ action: 'logLeadFlag', submissionId: SID(3), flag: JSON.stringify({ leadId: 'L1', kind: 'meeting_patient_change', change: 'rescheduled', prevDate: '2026-11-04', prevTime: '11:00', newDate: '2026-11-08', newTime: '12:15', withWhom: 'אורן', note: '<b>x</b>' }) });
  assert.equal(ch.ok, true, 'a JSON-string flag is accepted too');
  const idx = w.post({ action: 'contactIndex' }, DANA_A);
  assert.equal(idx.ok, true); assert.equal(idx.count, 0, 'flags are not contacts');
  assert.equal(idx.flags.L1.waitReason.reason, 'funder', 'the latest reason wins');
  assert.equal(idx.flags.L1.waitReason.actorName, 'דנה');
  assert.deepEqual([idx.flags.L1.meetingChange.change, idx.flags.L1.meetingChange.newDate, idx.flags.L1.meetingChange.newTime], ['rescheduled', '2026-11-08', '12:15']);
  assert.equal(idx.flags.L1.meetingChange.note, '<b>x</b>', 'stored as text; the page escapes it');
  const acts = w.g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
  assert.equal(acts.length, 3); assert.ok(acts.every((a) => a.source === 'manual' && a.leadId === 'L1' && a.houseId === 'רמות השבים'));
  assert.deepEqual(Array.from(w.g.run('LEAD_COLUMNS')), before, 'no Leads column added');
});

test('C: logLeadFlag refuses bad input, an unknown / closed lead, the controller view and an unverified caller — and writes nothing', () => {
  const w = world();
  const no = (flag, sid, who) => w.post({ action: 'logLeadFlag', submissionId: sid || SID(9), flag }, who);
  assert.equal(no({ leadId: 'L1', kind: 'waitlist_reason', reason: 'place' }, 'bad').error, 'bad_submission_id');
  assert.equal(no({ leadId: 'L1', kind: 'stage', reason: 'place' }).error, 'bad_kind');
  assert.equal(no({ leadId: 'L1', kind: 'waitlist_reason', reason: 'money' }).error, 'bad_reason');
  assert.equal(no({ leadId: 'L1', kind: 'meeting_patient_change', change: 'moved' }).error, 'bad_change');
  assert.equal(no({ leadId: 'L1', kind: 'meeting_patient_change', change: 'rescheduled', newDate: '8/11/2026' }).error, 'bad_new_date');
  assert.equal(no({ leadId: 'L1', kind: 'meeting_patient_change', change: 'rescheduled', newDate: '2026-11-08', newTime: '25:00' }).error, 'bad_new_time');
  assert.equal(no({ leadId: '../x', kind: 'waitlist_reason', reason: 'place' }).error, 'bad_lead');
  assert.equal(no({ leadId: 'L-gone', kind: 'waitlist_reason', reason: 'place' }).error, 'unknown_lead');
  assert.equal(no({ leadId: 'L1', kind: 'waitlist_reason', reason: 'place' }, SID(8), actor('ortal', 'אורטל', ['controller'], ['billingControl'])).error, 'forbidden');
  assert.equal(plain(w.g.post({ action: 'logLeadFlag', user: 'ורד', submissionId: SID(7), flag: { leadId: 'L1', kind: 'waitlist_reason', reason: 'place' } })).ok, false, 'no verified session');
  assert.equal(w.g.sheetRows('Activity', 'ACTIVITY_COLUMNS').length, 0);
});

test('C: PURE leadFlagClean_ drops an invalid stored row instead of serving it', () => {
  const w = world();
  const flags = {};
  w.g.sandbox.leadFlagIndexPut_(flags, { leadId: 'L1', occurredAt: '2026-11-04T08:00:00.000Z', detailsJson: '{"reason":"evil"}' }, 'waitlist_reason');
  w.g.sandbox.leadFlagIndexPut_(flags, { leadId: 'L1', occurredAt: '2026-11-04T08:00:00.000Z', detailsJson: 'not json' }, 'meeting_patient_change');
  assert.deepEqual(plain(flags), {});
});
