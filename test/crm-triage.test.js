'use strict';

/* CRM Stage 3 — «רשומות שדורשות בירור» (CHANGELOG-crm-triage.md; spec §12): the pure core. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const TODAY = '2026-10-28';
const CRM_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const DATA = { ok: true, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], patients: {},
  leads: [
    { id: 'A', name: 'ישן', house: 'ramot', stage: 'new', created: '2026-08-01', note: 'מעוניין' },
    { id: 'B', name: 'חדש', house: 'rehab', stage: 'new', created: '2026-10-27' },
    { id: 'C', name: 'ביקור ללא תאריך', house: 'asher', stage: 'visit', created: '2026-09-01' },
    { id: 'D', name: 'ביקור עם תאריך', house: 'asher', stage: 'visit', visitDate: '2026-11-02', created: '2026-09-01' },
    { id: 'E', name: 'דובר', house: 'ramot', stage: 'new', created: '2026-07-01' },
    { id: 'F', name: 'עם משימה', house: 'ramot', stage: 'new', created: '2026-07-02' },
    { id: 'G', name: 'בהמתנה', house: 'ramot', stage: 'waitlist', created: '2026-06-01' },
  ] };
const c = core.compute(DATA, TODAY);
const INDEX = { ok: true, leads: { E: { at: '2026-10-01T09:00:00.000Z', outcome: 'no_answer' } }, patients: {} };
const TASKS = [{ id: 'task-' + '1'.repeat(32), kind: 'review', leadId: 'F', status: 'open', title: 'x' }, { id: 'task-' + '2'.repeat(32), kind: 'call', leadId: 'A', status: 'done', title: 'y' }];

test('triageQueue: new leads and undated visits with NO documented contact and NO open task, oldest first; a contacted lead, a lead with an open task, a dated visit and a waitlisted lead are out; the count is computed', () => {
  const q = core.triageQueue(c, TASKS, INDEX, TODAY);
  assert.deepEqual(q.map((x) => [x.lead.id, x.age, x.reason]), [['A', 88, 'אין מגע מתועד'], ['C', 57, 'ביקור ללא תאריך ואין מגע מתועד'], ['B', 1, 'אין מגע מתועד']]);
  assert.equal(core.triageQueue(c, TASKS, INDEX, TODAY).length, 3, 'never a hard-coded number');
  assert.ok(!/\b75\b/.test(CRM_SRC.replace(/\/\*[\s\S]*?\*\//g, '')), 'no 75 in the code');
  // a decision removes the record from the queue only through the data: a contact event…
  assert.deepEqual(core.triageQueue(c, TASKS, { ok: true, leads: Object.assign({ A: { at: '2026-10-28T10:00:00.000Z', outcome: 'no_answer' } }, INDEX.leads) }, TODAY).map((x) => x.lead.id), ['C', 'B']);
  // …or a task («לחזור בתאריך», «לבדיקה נוספת», the waitlist's check date)
  assert.deepEqual(core.triageQueue(c, TASKS.concat([{ id: 'task-' + '3'.repeat(32), kind: 'call', leadId: 'C', status: 'open', title: 'z' }]), INDEX, TODAY).map((x) => x.lead.id), ['A', 'B']);
});

test('the six options in the spec order; each with a visible result', () => {
  assert.deepEqual(core.TRIAGE_OPTIONS.map((o) => o.id), ['call', 'later', 'waitlist', 'update', 'close', 'check']);
  assert.deepEqual(core.TRIAGE_OPTIONS.map((o) => o.label), ['שיחה עכשיו', 'לחזור בתאריך', 'רשימת המתנה', 'עדכון לפי מידע מאומת', 'סגירה — לא רלוונטי', 'לסמן לבדיקה נוספת']);
  core.TRIAGE_OPTIONS.forEach((o) => assert.ok(o.hint.length > 5, o.id));
  assert.ok(!/data-triage-defer-all|דחיית הכל|דחה הכל/.test(CRM_SRC), 'no bulk defer');
});

test('waitlist: house, assignee, reason and a check date are required; the patch moves the stage, keeps the note and appends the dated reason; later: date ≥ today, optional time', () => {
  const ok = { house: 'ramot', assignee: 'ורד', reason: 'אין מקום כרגע', checkDate: '2026-11-10' };
  assert.deepEqual(core.waitlistErrors(ok, TODAY), {});
  assert.deepEqual(Object.keys(core.waitlistErrors({}, TODAY)).sort(), ['assignee', 'checkDate', 'house', 'reason']);
  assert.ok(core.waitlistErrors(Object.assign({}, ok, { checkDate: '2026-10-01' }), TODAY).checkDate);
  assert.ok(core.waitlistErrors(Object.assign({}, ok, { assignee: 'שירן' }), TODAY).assignee, 'only the current owners');
  assert.deepEqual(core.waitlistPatch(c.leads[0], ok, TODAY), { stage: 'waitlist', house: 'רמות השבים', assignedTo: 'ורד', note: 'מעוניין\n[28/10/2026] רשימת המתנה: אין מקום כרגע' });
  assert.equal(core.waitlistPatch(c.leads[1], ok, TODAY).note, '[28/10/2026] רשימת המתנה: אין מקום כרגע');
  assert.deepEqual(core.laterErrors({ dueDate: '2026-11-01', dueTime: '09:30' }, TODAY), {});
  assert.ok(core.laterErrors({ dueDate: '2026-10-01' }, TODAY).dueDate); assert.ok(core.laterErrors({ dueDate: '2026-11-01', dueTime: '9' }, TODAY).dueTime);
});

test('boot is progressive: /api/me and getData are requested together, the page renders on getData, tasks / contact index / debt fill in later (undefined = loading, null = failed)', () => {
  assert.match(CRM_SRC, /const meP = win\.fetch\('\/api\/me'[\s\S]*const dataP = api\('getData'\);\s*return Promise\.all\(\[meP, dataP\]\)/);
  assert.match(CRM_SRC, /state\.data = data; state\.loading = false;\s*renderNav\(\); renderMain\(\);\s*const later/);
  assert.match(CRM_SRC, /state\.tasks = undefined; state\.index = undefined/);
  const m = core.myDay(c, undefined, undefined, null, TODAY, { view: 'ops', finance: false }, {});
  assert.equal(m.cards.filter((k) => k.id === 'calls')[0].hint, 'טוען…'); assert.equal(m.cards.filter((k) => k.id === 'newleads')[0].hint, 'טוען…');
  const f = core.myDay(c, null, null, null, TODAY, { view: 'ops', finance: false }, {});
  assert.equal(f.cards.filter((k) => k.id === 'calls')[0].hint, 'המידע אינו זמין'); assert.equal(f.cards.filter((k) => k.id === 'calls')[0].value, null);
});
