'use strict';

/* CRM Stage 1c — the contact panel, «שיחות לביצוע» and the tasks tab
 * (CHANGELOG-crm-contact-panel.md). The pure core over the Stage 1a actions. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs } = require('./helpers/gs-sandbox');

const TODAY = '2026-10-28'; // a Wednesday
const CRM_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

test('lists mirror Code.gs: outcomes, channels, kinds (ids and order); the next-contact choices are the spec list with NO default', () => {
  const g = loadGs({ props: {} });
  assert.deepEqual(core.CONTACT_OUTCOMES.map((o) => o.id), Array.from(g.run('CONTACT_OUTCOMES')));
  assert.deepEqual(core.CONTACT_CHANNELS.map((o) => o.id), Array.from(g.run('CONTACT_CHANNELS')));
  assert.deepEqual(core.TASK_KINDS.map((o) => o.id), Array.from(g.run('TASK_KINDS')));
  assert.deepEqual(core.NEXT_CHOICES.map((n) => n.label), ['מחר', 'בעוד 3 ימים', 'בעוד שבוע', 'בעוד שבועיים', 'בעוד חודש', 'בעוד X ימים', 'תאריך ושעה', 'במהלך שבוע נבחר', 'ללא משימת המשך']);
  assert.ok(!/name="next"[^>]*checked/.test(CRM_SRC), 'no radio is pre-checked — the user chooses (spec §8)');
  assert.ok(!/>בוצע</.test(CRM_SRC), 'no «בוצע» button on a call task — a call closes through the contact log only (data-task-done is drawn for non-call kinds only)');
  assert.match(CRM_SRC, /isCall \? '<button[^']*data-contact-open/, 'a call row offers «תיעוד שיחה», not a completion');
  assert.equal(core.contactOutcomeLabel('no_answer'), 'לא היה מענה');
});

test('nextPlan: relative choices show the ACTUAL date; X days 1–365; date ≥ today with optional time; a week is a Sun–Sat window; «none» needs an explanation', () => {
  assert.deepEqual(core.nextPlan('d1', {}, TODAY), { dueDate: '2026-10-29', dueTime: '', text: 'מחר — 29/10/2026 (חמישי)' });
  assert.equal(core.nextPlan('d14', {}, TODAY).dueDate, '2026-11-11');
  assert.equal(core.nextPlan('days', { days: '10' }, TODAY).dueDate, '2026-11-07');
  assert.equal(core.nextPlan('days', { days: '0' }, TODAY), null); assert.equal(core.nextPlan('days', { days: '366' }, TODAY), null); assert.equal(core.nextPlan('days', { days: '2.5' }, TODAY), null);
  assert.deepEqual(core.nextPlan('date', { date: '2026-11-03', time: '10:30' }, TODAY), { dueDate: '2026-11-03', dueTime: '10:30', text: '03/11/2026 10:30 (שלישי)' });
  assert.equal(core.nextPlan('date', { date: '2026-10-27' }, TODAY), null, 'yesterday is not a follow-up');
  assert.equal(core.nextPlan('date', { date: '2026-11-03', time: '25:00' }, TODAY), null);
  assert.deepEqual(core.nextPlan('week', { weekStart: '2026-11-04' }, TODAY), { windowStart: '2026-11-01', windowEnd: '2026-11-07', text: 'במהלך השבוע 01/11/2026 – 07/11/2026' });
  assert.equal(core.nextPlan('week', { weekStart: '2026-10-18' }, TODAY), null, 'a week that ended');
  assert.deepEqual(core.nextPlan('none', { explanation: 'המשפחה ביקשה להפסיק' }, TODAY), { none: true, explanation: 'המשפחה ביקשה להפסיק', text: 'ללא משימת המשך — המשפחה ביקשה להפסיק' });
  assert.equal(core.nextPlan('none', { explanation: 'x' }, TODAY), null);
  assert.equal(core.nextPlan('zzz', {}, TODAY), null);
});

test('contactErrors: when (today or earlier), channel, outcome, next required; next validated per choice; lengths', () => {
  const ok = { when: TODAY, channel: 'phone', outcome: 'no_answer', next: 'd3' };
  assert.deepEqual(core.contactErrors(ok, TODAY), {});
  assert.ok(core.contactErrors({}, TODAY).when); assert.ok(core.contactErrors({}, TODAY).channel); assert.ok(core.contactErrors({}, TODAY).outcome);
  assert.match(core.contactErrors({}, TODAY).next, /אין ברירת מחדל/);
  assert.ok(core.contactErrors(Object.assign({}, ok, { when: '2026-10-29' }), TODAY).when, 'a future call is not a record');
  assert.ok(core.contactErrors(Object.assign({}, ok, { time: '9:5' }), TODAY).time);
  assert.match(core.contactErrors(Object.assign({}, ok, { next: 'none' }), TODAY).next, /חובה להסביר/);
  assert.match(core.contactErrors(Object.assign({}, ok, { next: 'days', nextDays: '400' }), TODAY).next, /1 ל-365/);
  assert.match(core.contactErrors(Object.assign({}, ok, { next: 'date', nextDate: '2026-01-01' }), TODAY).next, /מהיום והלאה/);
  assert.ok(core.contactErrors(Object.assign({}, ok, { summary: 'x'.repeat(1001) }), TODAY).summary);
  assert.ok(core.contactErrors(Object.assign({}, ok, { withWhom: 'x'.repeat(81) }), TODAY).withWhom);
});

test('contactBody: the Stage 1a logContact contract — subject, occurredAt (UTC instant from the local wall-clock, noon when no time), channel / outcome / summary, taskId when fulfilling, next as date / window / none; the follow-up carries a title, the assignee and the summary as its reason', () => {
  const sid = core.newSubmissionId();
  assert.match(sid, /^sub-[0-9a-f]{32}$/);
  const v = { when: TODAY, time: '10:30', withWhom: 'אמא', channel: 'whatsapp', reason: 'תיאום', outcome: 'call_back_later', summary: 'ביקשה שנחזור אחרי החג', next: 'd7', nextTitle: '', nextAssignee: 'דנה' };
  const b = core.contactBody({ leadId: 'L1' }, v, sid, 'task-' + '1'.repeat(32), TODAY, 'דנה');
  assert.equal(b.action, 'logContact'); assert.equal(b.submissionId, sid);
  assert.equal(b.contact.leadId, 'L1'); assert.equal(b.contact.taskId, 'task-' + '1'.repeat(32));
  assert.equal(b.contact.occurredAt, new Date(TODAY + 'T10:30:00').toISOString(), 'local 10:30 → the UTC instant');
  assert.deepEqual([b.contact.channel, b.contact.outcome, b.contact.withWhom, b.contact.reason, b.contact.summary], ['whatsapp', 'call_back_later', 'אמא', 'תיאום', 'ביקשה שנחזור אחרי החג']);
  assert.deepEqual(b.next, { dueDate: '2026-11-04', dueTime: '', title: 'לחזור — התבקשנו לחזור במועד', assignee: 'דנה', reason: 'ביקשה שנחזור אחרי החג' });
  const noTime = core.contactBody({ patientId: 'p1' }, Object.assign({}, v, { time: '', next: 'none', nextExplanation: 'אין צורך' }), sid, '', TODAY, '');
  assert.equal(noTime.contact.occurredAt, new Date(TODAY + 'T12:00:00').toISOString());
  assert.equal('taskId' in noTime.contact, false); assert.equal('leadId' in noTime.contact, false); assert.equal(noTime.contact.patientId, 'p1');
  assert.deepEqual(noTime.next, { none: true, explanation: 'אין צורך' });
  const wk = core.contactBody({ leadId: 'L1' }, Object.assign({}, v, { next: 'week', nextWeek: '2026-11-04', nextTitle: 'לבדוק מקום' }), sid, '', TODAY, 'ורד');
  assert.deepEqual(wk.next, { windowStart: '2026-11-01', windowEnd: '2026-11-07', title: 'לבדוק מקום', assignee: 'ורד', reason: 'ביקשה שנחזור אחרי החג' });
  // the real Code.gs accepts the body as is
  const g = loadGs({ props: { PROXY_SECRET: 'proxy-secret-TEST-panel-0123456789abcdef0123', PROXY_SECRET_MODE: 'enforce' } });
  const who = { proxySecret: 'proxy-secret-TEST-panel-0123456789abcdef0123', proxyUser: 'דנה', user: 'דנה', proxyAuth: 'personal', proxyUserId: 'dana', proxyRoles: ['staff'], proxyCaps: [] };
  const r = JSON.parse(JSON.stringify(g.post(Object.assign({}, b, who))));
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.event.eventId, 'contact:' + sid); assert.equal(r.created.dueDate, '2026-11-04'); assert.equal(r.created.assignee, 'דנה'); assert.equal(r.created.source, 'contact');
  assert.equal(core.contactAccepted(r), ''); assert.equal(core.contactAccepted({ ok: true }), 'השינוי לא אושר על ידי השרת — רענני'); assert.match(core.contactAccepted({ ok: false, error: 'lock_busy' }), /עסוקה/);
  assert.match(core.contactAccepted({ ok: false, error: 'missing_next_explanation', message: 'x' }), /x/);
});

test('the task list: state (late / today / wait / undated, windows included), when-text, subject from the data, queue order overdue → today → upcoming → undated, filters by kind / house / assignee, counts, per-subject list', () => {
  const data = { ok: true, leads: [{ id: 'L1', name: 'אבי', house: 'ramot', stage: 'new', phone: '0501', contactName: 'אמא', contactRelation: 'אם' }], patients: { rehab: [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active' }] }, irrelevantLeads: [], removedLeads: [], dischargedPatients: [] };
  const c = core.compute(core.normalise ? data : data, TODAY);
  const T = (o) => Object.assign({ id: 'task-' + Math.random().toString(16).slice(2).padEnd(32, '0'), kind: 'call', status: 'open', title: 't', source: 'manual' }, o);
  const late = T({ leadId: 'L1', dueDate: '2026-10-20', title: 'late' }), today = T({ patientId: 'p1', dueDate: TODAY, dueTime: '09:00', title: 'today' }), up = T({ leadId: 'L1', dueDate: '2026-11-02', title: 'up' });
  const win = T({ leadId: 'L1', windowStart: '2026-10-25', windowEnd: '2026-10-31', title: 'window' }), undated = T({ patientId: 'p1', title: 'undated' }), done = T({ leadId: 'L1', status: 'done' });
  const money = T({ patientId: 'p1', kind: 'collection', dueDate: TODAY, title: 'money' }), other = T({ leadId: 'L1', kind: 'review', dueDate: TODAY, title: 'review', assignee: 'ורד' });
  assert.equal(core.taskState(late, TODAY), 'late'); assert.equal(core.taskState(today, TODAY), 'today'); assert.equal(core.taskState(up, TODAY), 'wait'); assert.equal(core.taskState(win, TODAY), 'today'); assert.equal(core.taskState(undated, TODAY), 'undated');
  assert.equal(core.taskState(T({ windowStart: '2026-10-11', windowEnd: '2026-10-17' }), TODAY), 'late'); assert.equal(core.taskState(T({ windowStart: '2026-11-01', windowEnd: '2026-11-07' }), TODAY), 'wait');
  assert.equal(core.taskWhen(today), '28/10/2026 09:00'); assert.equal(core.taskWhen(win), 'במהלך 25/10/2026 – 31/10/2026'); assert.equal(core.taskWhen(undated), 'ללא תאריך — קבעי תאריך');
  assert.deepEqual(core.taskSubject(late, c), { kind: 'lead', id: 'L1', name: 'אבי', house: 'רמות השבים', phone: '0501', contact: 'אמא (אם)' });
  assert.equal(core.taskSubject(today, c).name, 'דנה כהן'); assert.equal(core.taskSubject(T({ leadId: 'LX' }), c).name, 'ליד LX');
  const all = [up, undated, today, done, win, late, money, other];
  assert.deepEqual(core.taskQueue(all, c, TODAY).map((r) => r.task.title), ['late', 'today', 'money', 'review', 'window', 'up', 'undated'], 'done excluded; a timed task first on its day, then input order; a window sorts by its end');
  assert.deepEqual(core.taskQueue(all, c, TODAY, { kinds: ['call', 'collection'] }).map((r) => r.task.title), ['late', 'today', 'money', 'window', 'up', 'undated']);
  assert.deepEqual(core.taskQueue(all, c, TODAY, { house: 'קיסריה ריהאב' }).map((r) => r.task.title), ['today', 'money', 'undated']);
  assert.deepEqual(core.taskQueue(all, c, TODAY, { assignee: 'ורד' }).map((r) => r.task.title), ['review']);
  assert.deepEqual(core.taskCounts(core.taskQueue(all, c, TODAY)), { late: 1, today: 4, wait: 1, undated: 1 });
  assert.deepEqual(core.tasksFor({ leadId: 'L1' }, all).map((t) => t.title), ['up', 'window', 'late', 'review']);
  assert.deepEqual(core.tasksFor({ patientId: 'p1' }, all).map((t) => t.title), ['undated', 'today', 'money']);
  assert.deepEqual(core.taskQueue(null, c, TODAY), []);
});

test('task forms: create (kind, title, date or week), reschedule (date or week; a reason is REQUIRED for a date promised in a contact), the bodies; the task echo is the proof', () => {
  assert.deepEqual(core.taskFormErrors({ kind: 'call', title: 'x' }, TODAY), {}, 'undated is allowed');
  assert.ok(core.taskFormErrors({ kind: 'zz', title: '' }, TODAY).kind); assert.ok(core.taskFormErrors({ kind: 'call' }, TODAY).title);
  assert.ok(core.taskFormErrors({ kind: 'call', title: 'x', dueDate: '31/12/2026' }, TODAY).dueDate); assert.ok(core.taskFormErrors({ kind: 'call', title: 'x', mode: 'week' }, TODAY).weekStart);
  const sid = 'sub-' + 'a'.repeat(32);
  assert.deepEqual(core.taskCreateBody({ leadId: 'L1' }, { kind: 'call', title: ' לחזור ', reason: 'r', assignee: 'דנה', dueDate: '2026-11-02', dueTime: '10:00' }, sid),
    { action: 'createTask', submissionId: sid, task: { leadId: 'L1', kind: 'call', title: 'לחזור', reason: 'r', assignee: 'דנה', source: 'manual', dueDate: '2026-11-02', dueTime: '10:00' } });
  assert.deepEqual(core.taskCreateBody({ patientId: 'p1' }, { kind: 'review', title: 'x', mode: 'week', weekStart: '2026-11-04' }, sid).task, { patientId: 'p1', kind: 'review', title: 'x', reason: '', assignee: '', source: 'manual', windowStart: '2026-11-01', windowEnd: '2026-11-07' });
  const fromContact = { id: 'task-' + 'b'.repeat(32), source: 'contact' };
  assert.deepEqual(core.rescheduleErrors({ dueDate: '2026-11-05', reason: 'ביקשו' }, fromContact), {});
  assert.match(core.rescheduleErrors({ dueDate: '2026-11-05' }, fromContact).reason, /הובטח למשפחה/);
  assert.deepEqual(core.rescheduleErrors({ dueDate: '2026-11-05' }, { source: 'manual' }), {});
  assert.ok(core.rescheduleErrors({}, null).dueDate); assert.ok(core.rescheduleErrors({ mode: 'week' }, null).weekStart);
  assert.deepEqual(core.rescheduleBody('t1', { dueDate: '2026-11-05', dueTime: '', reason: 'ביקשו' }), { action: 'rescheduleTask', id: 't1', reason: 'ביקשו', dueDate: '2026-11-05', dueTime: '' });
  assert.deepEqual(core.rescheduleBody('t1', { mode: 'week', weekStart: '2026-11-04' }), { action: 'rescheduleTask', id: 't1', reason: '', windowStart: '2026-11-01', windowEnd: '2026-11-07' });
  assert.equal(core.taskAccepted({ ok: true, task: { id: 't1' } }, 't1'), ''); assert.equal(core.taskAccepted({ ok: true, task: { id: 't2' } }, 't1'), 'השינוי לא אושר על ידי השרת — רענני');
  assert.equal(core.taskAccepted({ ok: true, task: { id: 'new' } }, ''), '', 'a create has no id to match');
  assert.match(core.taskAccepted({ ok: false, error: 'task_closed', message: 'המשימה כבר סגורה' }), /סגורה/);
});
