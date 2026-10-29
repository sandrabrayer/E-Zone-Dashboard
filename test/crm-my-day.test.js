'use strict';

/* CRM Stage 2 — «היום שלי» model (CHANGELOG-crm-my-day.md; spec §3–§7) and
 * the Code.gs contactIndex read. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const TODAY = '2026-10-28'; // Wednesday
const ROOT = path.join(__dirname, '..');
const CRM_CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [],
  leads: [
    { id: 'L1', name: 'אבי', house: 'ramot', stage: 'new', created: '2026-08-13', assignedTo: 'ורד', phone: '0501' },            // old, no contact, no task → «ללא מגע», never «late»
    { id: 'L2', name: 'גלי', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '13:30', meetingWith: 'אורן' },         // meeting today (binding)
    { id: 'L3', name: 'דנה מ', house: 'pardes', stage: 'visit', visitDate: '2026-10-25', meetingWith: 'חן' },                   // passed, no report → waiting on the manager
    { id: 'L4', name: 'רון', house: 'rehab', stage: 'visit', visitDate: '2026-10-24', meetingWith: 'רנטה', meetingReportedAt: '2026-10-27T10:00:00.000Z', meetingReporter: 'רנטה', meetingReportOutcome: 'undecided' }, // unseen report → exception
    { id: 'L5', name: 'טל', house: 'ramot', stage: 'visit', visitDate: '2026-10-20', meetingReportedAt: '2026-10-21T10:00:00.000Z', meetingSeen: '1' }, // seen, undecided → exception
    { id: 'L6', name: 'נוי', house: 'asher', stage: 'visit' },                                                                    // to schedule (undated)
    { id: 'L7', name: 'שי', house: 'ramot', stage: 'paid', entryDate: '2026-10-26', assignedTo: 'ורד' },                          // paid, entry date passed, not admitted → exception
    { id: 'L8', name: 'עדי', house: 'ramot', stage: 'paid', entryDate: '2026-11-05' },                                           // future admission → NOT an exception
    { id: 'L9', name: 'מאיה', house: 'arfoni', stage: 'new', created: '2026-10-27', assignedTo: 'דנה' },                          // new, contacted (index) → not in «ללא מגע»
  ],
  patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active' }] },
  dischargedPatients: [{ id: 'dx1', patientId: 'px', name: 'נועה', houseId: 'ramot', exitDate: '2026-10-20', dischargedAt: '2026-10-20T09:00:00.000Z', disposition: 'completed' }],
};
const T = (o) => Object.assign({ id: 'task-' + Math.random().toString(16).slice(2).padEnd(32, '0'), kind: 'call', status: 'open', title: 't', source: 'manual' }, o);
const TASKS = [
  T({ id: 'task-' + '1'.repeat(32), leadId: 'L2', title: 'לחזור', dueDate: '2026-10-26', assignee: 'ורד', source: 'contact', reason: 'ביקשו' }),   // late call
  T({ id: 'task-' + '2'.repeat(32), patientId: 'p1', kind: 'review', title: 'לבדוק מסמכים', dueDate: TODAY, dueTime: '10:00', assignee: 'ורד' }), // timed today → binding
  T({ id: 'task-' + '3'.repeat(32), patientId: 'p1', kind: 'collection', title: 'שיחת גבייה', dueDate: TODAY, assignee: 'ורד' }),
  T({ id: 'task-' + '4'.repeat(32), leadId: 'L9', title: 'לחזור למאיה', windowStart: '2026-10-25', windowEnd: '2026-10-31', assignee: 'דנה' }),
  T({ id: 'task-' + '5'.repeat(32), leadId: 'L1', title: 'הושלם', status: 'done', doneAt: TODAY + 'T07:00:00.000Z', doneBy: 'דנה', outcome: 'לא היה מענה' }),
];
const INDEX = { ok: true, leads: { L9: { at: '2026-10-27T12:00:00.000Z', outcome: 'no_answer', actorName: 'דנה', summary: '' } }, patients: {} };
const DEBT = { ok: true, byPatient: [{ patientId: 'p1', name: 'דנה כהן', houseId: 'ramot', cycles: [
  { start: '2026-08-20', end: '2026-09-18', expected: 6000, received: 2500, balance: 3500, kind: 'recorded' },
  { start: '2026-10-26', end: '2026-11-24', expected: 5000, received: 0, balance: 5000, kind: 'unrecorded' },
  { start: '2026-07-01', end: '2026-07-30', expected: 6000, received: 6000, balance: 0, kind: 'recorded' }] }] };
const VERED = { view: 'full', finance: true, user: 'ורד' };
const DANA = { view: 'ops', finance: false, user: 'דנה' };
const c = core.compute(DATA, TODAY);

test('meetingBuckets: today / to schedule / awaiting the manager report (a passed date proves nothing) / report unseen / report seen but undecided', () => {
  const b = core.meetingBuckets(c.leads, TODAY);
  assert.deepEqual(b.today.map((l) => l.id), ['L2']); assert.deepEqual(b.toSchedule.map((l) => l.id), ['L6']);
  assert.deepEqual(b.awaitingReport.map((l) => l.id), ['L3']); assert.deepEqual(b.reportUnseen.map((l) => l.id), ['L4']); assert.deepEqual(b.awaitingDecision.map((l) => l.id), ['L5']);
});

test('newLeadsNoContact: stage new with no documented contact and no open call task; age is information; a contacted lead and a lead with an open call are out', () => {
  const n = core.newLeadsNoContact(c.leads, TASKS, INDEX, TODAY);
  assert.deepEqual(n.map((x) => [x.lead.id, x.age]), [['L1', 76]]);
  assert.deepEqual(core.newLeadsNoContact(c.leads, [T({ leadId: 'L1' })], INDEX, TODAY), [], 'an open call task means it is being handled');
  assert.equal(core.newLeadsNoContact(c.leads, [], null, TODAY).length, 2, 'without the index nobody is known to be contacted');
});

test('houseExceptions: admission due and not done (future entry is NOT an exception); a discharge of the last 14 days without continuity; report exceptions are NOT duplicated here', () => {
  const ex = core.houseExceptions(c, TODAY);
  assert.deepEqual(ex.map((r) => r.kind), ['admission_due', 'continuity']);
  assert.equal(ex[0].subjectId, 'L7'); assert.match(ex[0].why, /26\/10\/2026 עבר/);
  assert.equal(ex[1].subjectId, 'px'); assert.equal(ex[1].subjectKind, 'patient');
});

test('myDay (Vered): five cards in the spec order; counts and lists come from the same rows; ordering binding → exceptions → overdue → rest; waiting-on-manager shows the owner, not a task of Vered; money rows from debtAging; last contact per row; filters', () => {
  const m = core.myDay(c, TASKS, INDEX, DEBT, TODAY, VERED, {});
  assert.deepEqual(m.cards.map((k) => k.label), ['גבייה לטיפול', 'שיחות ומעקבים', 'פגישות היום', 'המשך טיפול לאחר פגישות', 'פניות חדשות ללא מגע']);
  const card = (id) => m.cards.filter((k) => k.id === id)[0];
  assert.equal(card('collection').value, 2, 'the collection task today + the recorded debt past its end'); assert.match(card('collection').hint, /2 מחזורים פתוחים/);
  assert.equal(card('calls').value, 3, 'the late call + the timed review today + the window task covering today'); assert.match(card('calls').hint, /1 באיחור · 3 פתוחות/);
  assert.equal(card('meetings').value, 1); assert.deepEqual(card('meetings').second, { label: 'תיאומים פתוחים', value: 1 });
  assert.equal(card('followup').value, 3); assert.match(card('followup').hint, /1 ממתינות לדיווח/);
  assert.equal(card('newleads').value, 1);
  // same rows behind the counts
  assert.equal(m.byDomain.collection.length, 3); assert.equal(m.byDomain.calls.length, 3); assert.equal(m.byDomain.newleads.length, 1);
  assert.deepEqual(m.byDomain.collection.map((r) => r.kind), ['debt_recorded', 'task', 'cycle_unreported'], 'late recorded debt, then the collection task today, then the open cycle');
  assert.ok(!m.byDomain.collection.some((r) => /2026-07-01/.test(r.id)), 'a settled cycle is not a row');
  // urgent: binding first (timed today), then the exceptions
  assert.deepEqual(m.urgent.map((r) => [r.kind, r.priority]), [['task', 'binding'], ['meeting_today', 'binding'], ['continuity', 'exception'], ['report_undecided', 'exception'], ['admission_due', 'exception'], ['report_unseen', 'exception']], 'timed commitments first (by time), then the exceptions oldest first');
  const ids = m.urgent.map((r) => r.id); assert.equal(new Set(ids).size, ids.length, 'no row twice');
  // waiting on the manager: owner shown, not Vered's task
  assert.deepEqual(m.waiting.map((r) => [r.subjectId, r.waitingOn]), [['L3', 'חן']]);
  assert.match(m.waiting[0].why, /תאריך שעבר אינו הוכחה/);
  // last contact
  const maya = m.byDomain.calls.filter((r) => r.subjectId === 'L9')[0];
  assert.match(maya.lastContact, /לא היה מענה/); assert.match(maya.lastContact, /27\/10\/2026/);
  assert.equal(m.byDomain.newleads[0].lastContact, 'אין מגע מתועד'); assert.match(m.byDomain.newleads[0].why, /13\/08\/2026 · אין מגע מתועד/);
  assert.ok(!JSON.stringify(m).includes('ממתין 76'), 'no lateness by age anywhere');
  // the old lead is «wait», never «late»
  assert.equal(m.byDomain.newleads[0].state, 'wait');
  // filters: by owner and by house (ids or names)
  const byOwner = core.myDay(c, TASKS, INDEX, DEBT, TODAY, VERED, { owner: 'דנה' });
  assert.deepEqual(byOwner.byDomain.calls.map((r) => r.subjectId), ['L9']);
  const byHouse = core.myDay(c, TASKS, INDEX, DEBT, TODAY, VERED, { house: 'rehab' });
  assert.deepEqual(byHouse.urgent.map((r) => r.subjectId), ['L4']);
});

test('myDay (Dana): no money card and no money row — «מה דחוף בבתים» takes the slot; debt is never consulted; sources that did not load are null (never 0)', () => {
  const m = core.myDay(c, TASKS, INDEX, DEBT, TODAY, DANA, {});
  assert.deepEqual(m.cards.map((k) => k.label), ['מה דחוף בבתים', 'שיחות ומעקבים', 'פגישות היום', 'המשך טיפול לאחר פגישות', 'פניות חדשות ללא מגע']);
  assert.equal(m.cards[0].value, 4, 'admission due + continuity + the two report exceptions'); assert.equal(m.exceptions.length, 4, 'the card opens exactly these rows');
  assert.equal(m.byDomain.collection.length, 0); assert.ok(!JSON.stringify(m).includes('₪'));
  const none = core.myDay(c, null, null, null, TODAY, DANA, {});
  assert.equal(none.cards.filter((k) => k.id === 'calls')[0].value, null); assert.equal(none.cards.filter((k) => k.id === 'newleads')[0].value, null);
  const vNoDebt = core.myDay(c, TASKS, INDEX, false, TODAY, VERED, {});
  assert.equal(vNoDebt.cards[0].value, null); assert.equal(vNoDebt.cards[0].hint, 'המידע אינו זמין');
  assert.equal(core.myDay(c, TASKS, INDEX, null, TODAY, VERED, {}).cards[0].hint, 'טוען…');
});

test('weekPlan: Sun–Sat days, a dated row on its day, a window task on every day it covers (one id), undated listed apart; doneInWeek: done / cancelled by doneAt with who and outcome', () => {
  const m = core.myDay(c, TASKS, INDEX, DEBT, TODAY, VERED, {});
  const w = core.weekPlan(m, core.weekStart(TODAY));
  assert.equal(w.start, '2026-10-25'); assert.equal(w.end, '2026-10-31'); assert.equal(w.days.length, 7);
  const day = (d) => w.days.filter((x) => x.date === d)[0].rows.map((r) => r.action);
  assert.ok(day(TODAY).includes('לבדוק מסמכים') && day(TODAY).includes('פגישת קבלה 13:30'));
  assert.ok(day('2026-10-26').includes('לחזור'), 'the late call sits on its due day');
  assert.ok(day('2026-10-25').includes('לחזור למאיה') && day('2026-10-31').includes('לחזור למאיה'), 'a window task on each day it covers');
  assert.equal(w.undated.length, 0);
  const done = core.doneInWeek(TASKS, core.weekStart(TODAY), c);
  assert.deepEqual(done.map((r) => [r.name, r.who, r.outcome]), [['אבי', 'דנה', 'לא היה מענה']]);
  assert.equal(core.doneInWeek(TASKS, '2026-11-01', c).length, 0);
  assert.equal(core.hebDate(TODAY), 'יום רביעי, 28/10/2026');
});

test('light theme + nav groups: the spec tokens, state never by colour alone (words / icons in every chip), nav groups in the spec order, 16px body', () => {
  assert.match(CRM_CSS, /--bg: #E6ECF2; --bg-2: #FFFFFF/); assert.match(CRM_CSS, /--text: #0E1B25/); assert.match(CRM_CSS, /--border: #B9C6D2/); assert.match(CRM_CSS, /--primary: #0B6B63/);   // contrast pass 2026-10-29
  assert.match(CRM_CSS, /font-size: 16px; line-height: 1.45/);
  assert.deepEqual(core.NAV_GROUPS.map((g) => g.label), ['', 'פניות ומטופלים', 'פגישות ויומן', 'בתים והמשך טיפול', 'כספים', 'דוחות והגדרות']);
  assert.match(CRM_SRC, /'⚠ חריג'/); assert.match(CRM_SRC, /'⏰ באיחור'/); assert.match(CRM_SRC, /'● להיום'/);
  assert.deepEqual(core.MY_DAY_VIEWS.map((v) => v.label), ['היום', 'השבוע', 'הושלמו']);
  assert.ok(!/name="next"[^>]*checked/.test(CRM_SRC));
});

test('Code.gs contactIndex: the last contact per lead / patient from the Activity contact_logged events; every verified session (Dana too) reads the same; the controller view is refused', () => {
  const PROXY_SECRET = 'proxy-secret-TEST-index-0123456789abcdef0123';
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const actor = (id, user, roles, caps) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).includes('contactIndex'));
  assert.deepEqual(plain(g.post(Object.assign({ action: 'contactIndex' }, actor('vered', 'ורד', ['staff'], ['finance', 'billingControl'])))), { ok: true, count: 0, leads: {}, patients: {} }, 'no sheet yet');
  const SID = (n) => 'sub-' + String(n).padStart(32, '0');
  const dana = actor('dana', 'דנה', ['staff'], []);
  g.post(Object.assign({ action: 'logContact', submissionId: SID(1), contact: { leadId: 'L1', channel: 'phone', outcome: 'no_answer', occurredAt: '2026-10-20T09:00:00.000Z' }, next: { none: true, explanation: 'xx' } }, dana));
  g.post(Object.assign({ action: 'logContact', submissionId: SID(2), contact: { leadId: 'L1', channel: 'whatsapp', outcome: 'call_back_later', summary: 'אחרי החג', occurredAt: '2026-10-22T09:00:00.000Z' }, next: { days: 3 } }, dana));
  g.post(Object.assign({ action: 'logContact', submissionId: SID(3), contact: { patientId: 'p1', channel: 'phone', outcome: 'spoke_follow_up', occurredAt: '2026-10-21T09:00:00.000Z' }, next: { none: true, explanation: 'xx' } }, dana));
  g.post(Object.assign({ action: 'createTask', submissionId: SID(4), task: { kind: 'call', leadId: 'L2', title: 'x' } }, dana));
  const r = plain(g.post(Object.assign({ action: 'contactIndex' }, dana)));
  assert.equal(r.ok, true); assert.equal(r.count, 3);
  assert.deepEqual(Object.keys(r.leads), ['L1']); assert.deepEqual(Object.keys(r.patients), ['p1']);
  assert.equal(r.leads.L1.at, '2026-10-22T09:00:00.000Z', 'the LAST contact'); assert.equal(r.leads.L1.outcome, 'call_back_later'); assert.equal(r.leads.L1.channel, 'whatsapp'); assert.equal(r.leads.L1.summary, 'אחרי החג'); assert.equal(r.leads.L1.actorName, 'דנה');
  assert.equal(r.leads.L1.noNext, ''); assert.equal(r.patients.p1.outcome, 'spoke_follow_up');
  assert.deepEqual(plain(g.post(Object.assign({ action: 'contactIndex' }, actor('vered', 'ורד', ['staff'], ['finance', 'billingControl'])))).leads.L1.at, '2026-10-22T09:00:00.000Z', 'Vered reads the same');
  assert.equal(plain(g.post(Object.assign({ action: 'contactIndex' }, actor('ortal', 'אורטל', ['controller'], ['billingControl'])))).error, 'forbidden');
  assert.equal(plain(g.post({ action: 'contactIndex', user: 'דנה' })).ok, false, 'no verified session → refused');
});
