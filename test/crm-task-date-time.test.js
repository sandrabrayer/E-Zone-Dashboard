'use strict';

/* «משימה חדשה»: only date + time, a reminder before it is due, on «היום שלי»
 * (CHANGELOG-crm-task-date-time.md). Pure core of public/crm/crm.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-05';

test('newTaskErrors: what + kind + a date (today or later) + a time; nothing else is asked', () => {
  const ok = { kind: 'call', title: 'להתקשר לבעלה', dueDate: '2026-11-08', dueTime: '10:30' };
  assert.deepEqual(core.newTaskErrors(ok, TODAY), {});
  assert.deepEqual(core.newTaskErrors(Object.assign({}, ok, { dueDate: TODAY }), TODAY), {}, 'today is fine');
  assert.deepEqual(Object.keys(core.newTaskErrors(Object.assign({}, ok, { dueDate: '' }), TODAY)), ['dueDate']);
  assert.deepEqual(Object.keys(core.newTaskErrors(Object.assign({}, ok, { dueDate: '2026-11-04' }), TODAY)), ['dueDate'], 'not in the past');
  assert.deepEqual(Object.keys(core.newTaskErrors(Object.assign({}, ok, { dueTime: '' }), TODAY)), ['dueTime']);
  assert.deepEqual(Object.keys(core.newTaskErrors(Object.assign({}, ok, { title: '' }), TODAY)), ['title']);
});

test('the create form has no «למה עכשיו», no «מועד», no week; date + time are required; the reminder is announced', () => {
  const i = SRC.indexOf('function renderTasksPane'); const form = SRC.slice(i, SRC.indexOf('function taskById', i));
  assert.doesNotMatch(form, /למה עכשיו/);
  assert.doesNotMatch(form, /name="mode"/);
  assert.doesNotMatch(form, /name="weekStart"/);
  assert.doesNotMatch(form, /name="reason"/);
  assert.match(form, /תאריך \*<input type="date" name="dueDate"/);
  assert.match(form, /שעה \*<input type="time" name="dueTime"/);
  assert.match(form, /התרעה תוצג/);
  assert.match(SRC, /postTask\(f, taskCreateBody\(subj, tv, newSubmissionId\(\)\), newTaskErrors\(tv, state\.today\)/);
  const j = SRC.indexOf("kind === 'resched'"); const resched = SRC.slice(j, SRC.indexOf("kind === 'done'", j));
  assert.doesNotMatch(resched, /name="weekStart"|name="mode"/, 'reschedule: date + time only too');
});

test('dueSoonTasks: my open tasks due today within the window, once each; others / past / later / done are ignored', () => {
  const T = (o) => Object.assign({ id: 'x', status: 'open', dueDate: TODAY, dueTime: '16:00', assignee: 'ורד', title: 't' }, o);
  const tasks = [T({ id: 'a', dueTime: '16:00' }), T({ id: 'b', dueTime: '15:50' }), T({ id: 'c', dueTime: '17:00' }), T({ id: 'd', dueTime: '15:30' }),
    T({ id: 'e', assignee: 'דנה' }), T({ id: 'f', assignee: '' }), T({ id: 'g', status: 'done' }), T({ id: 'h', dueDate: '2026-11-06' }), T({ id: 'i', dueTime: '' })];
  const r = core.dueSoonTasks(tasks, 'ורד', TODAY, '15:40', 30, {});
  assert.deepEqual(r.map((x) => x.task.id + ':' + x.minutes), ['b:10', 'a:20', 'f:20'], 'unassigned counts as mine; sorted by time');
  assert.equal(core.dueSoonTasks(tasks, 'ורד', TODAY, '15:40', 30, { 'a@2026-11-05 16:00': true, 'b@2026-11-05 15:50': true }).length, 1, 'announced once');
  assert.deepEqual(core.dueSoonTasks(tasks, 'ורד', TODAY, 'bad', 30, {}), []);
  assert.equal(core.TASK_REMIND_MINUTES, 30);
});

test('a dated task appears on «היום שלי» on its day', () => {
  const c = core.compute({ ok: true, leads: [{ id: 'L1', name: 'ילנה אבילב', house: 'רמות השבים', stage: 'new', created: TODAY, assignedTo: 'דנה' }], patients: {} }, TODAY);
  const tasks = [{ id: 'task-' + 'a'.repeat(32), kind: 'call', leadId: 'L1', title: 'להתקשר לבעלה', assignee: 'דנה', dueDate: TODAY, dueTime: '16:00', status: 'open' }];
  const m = core.myDay(c, tasks, { ok: true, leads: {}, patients: {} }, null, TODAY, { user: 'דנה', view: 'ops', ops: true }, {}, null);
  const all = JSON.stringify(m);
  assert.match(all, /להתקשר לבעלה/);
});
