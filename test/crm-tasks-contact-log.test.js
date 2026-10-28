'use strict';

/* CRM Stage 1a — the task record and the contact log (CHANGELOG-crm-tasks-contact-log.md).
 * The REAL Code.gs in a vm with in-memory sheets, PROXY_SECRET enforced. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const PROXY_SECRET = 'proxy-secret-TEST-tasks-0123456789abcdef0123';
const plain = (x) => JSON.parse(JSON.stringify(x));
const actor = (id, user, roles, caps, auth) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: auth || 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
const VERED = () => actor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const DANA = () => actor('dana', 'דנה', ['staff'], []);
const ORTAL = () => actor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SID = (n) => 'sub-' + String(n).padStart(32, '0');

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const tasks = () => g.sheetRows('Tasks', 'TASK_COLUMNS');
  const activity = () => g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
  return { g, call, tasks, activity };
}

test('lists: the seven actions are proxy-known; kinds / statuses / outcomes / channels pinned; column contract append-only', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const known = Array.from(g.run('PROXY_KNOWN_ACTIONS'));
  for (const a of ['getTasks', 'createTask', 'completeTask', 'rescheduleTask', 'reassignTask', 'withdrawTask', 'logContact']) assert.ok(known.includes(a), a);
  assert.deepEqual(Array.from(g.run('TASK_KINDS')), ['call', 'meeting', 'collection', 'admission', 'discharge', 'continuity', 'review', 'other']);
  assert.deepEqual(Array.from(g.run('TASK_STATUSES')), ['open', 'done', 'cancelled']);
  assert.deepEqual(Array.from(g.run('CONTACT_OUTCOMES')), ['spoke_follow_up', 'no_answer', 'call_back_later', 'awaiting_decision', 'meeting_set', 'no_interest_now', 'bad_contact_details', 'stop_contact']);
  assert.deepEqual(Array.from(g.run('CONTACT_CHANNELS')), ['phone', 'whatsapp', 'sms', 'email', 'in_person', 'other']);
  const cols = Array.from(g.run('TASK_COLUMNS'));
  assert.deepEqual(cols.slice(0, 15), ['id', 'kind', 'leadId', 'patientId', 'personId', 'houseId', 'title', 'reason', 'assignee', 'dueDate', 'dueTime', 'windowStart', 'windowEnd', 'status', 'source']);
  assert.ok(cols.includes('submissionId') && cols.includes('money') && cols.includes('contactEventId'));
  assert.match(GS_SRC, /if \(name === TASKS_SHEET\) \{\s*forceColumnsText_\(sh, TASK_COLUMNS, TASK_TEXT_COLUMNS\);/);
});

test('createTask: validation, idempotency by submissionId, Activity event + audit; a window task; refused without a subject / title / kind', () => {
  const w = world();
  const r = w.call({ action: 'createTask', submissionId: SID(1), task: { kind: 'call', leadId: 'L1', title: ' לחזור למשפחה ', reason: 'ביקשו לחזור', assignee: 'ורד', dueDate: '2026-11-04', dueTime: '10:30', houseId: 'ramot' } });
  assert.equal(r.ok, true); assert.equal(r.created, true);
  assert.equal(r.task.id, 'task-' + SID(1).slice(4)); assert.equal(r.task.title, 'לחזור למשפחה'); assert.equal(r.task.status, 'open'); assert.equal(r.task.dueTime, '10:30'); assert.equal(r.task.createdBy, 'ורד'); assert.equal(r.task.money, '');
  const again = w.call({ action: 'createTask', submissionId: SID(1), task: { kind: 'call', leadId: 'L1', title: 'other' } });
  assert.equal(again.ok, true); assert.equal(again.created, false); assert.equal(again.replayed, true); assert.equal(again.task.title, 'לחזור למשפחה', 'the stored task answers a retry');
  assert.equal(w.tasks().length, 1);
  const ev = w.activity();
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'task_created'); assert.equal(ev[0].leadId, 'L1'); assert.match(ev[0].summary, /לחזור למשפחה/);
  // a window ("during the week")
  const wk = w.call({ action: 'createTask', submissionId: SID(2), task: { kind: 'call', patientId: 'p1', title: 'x', windowStart: '2026-11-02', windowEnd: '2026-11-06' } });
  assert.equal(wk.ok, true); assert.equal(wk.task.dueDate, ''); assert.equal(wk.task.windowEnd, '2026-11-06');
  for (const [body, code] of [
    [{ submissionId: 'nope', task: { kind: 'call', leadId: 'L1', title: 'x' } }, 'bad_submission_id'],
    [{ submissionId: SID(3), task: { kind: 'zzz', leadId: 'L1', title: 'x' } }, 'bad_kind'],
    [{ submissionId: SID(3), task: { kind: 'call', title: 'x' } }, 'missing_subject'],
    [{ submissionId: SID(3), task: { kind: 'call', leadId: 'L1', title: '   ' } }, 'missing_title'],
    [{ submissionId: SID(3), task: { kind: 'call', leadId: 'L1', title: 'x', dueDate: '31/12/2026' } }, 'bad_due'],
    [{ submissionId: SID(3), task: { kind: 'call', leadId: 'L1', title: 'x', windowStart: '2026-11-06', windowEnd: '2026-11-02' } }, 'bad_window'],
  ]) {
    const no = w.call(Object.assign({ action: 'createTask' }, body));
    assert.equal(no.ok, false, code); assert.equal(no.error, code); assert.ok(no.message);
  }
  assert.equal(w.tasks().length, 2, 'refusals write nothing');
});

test('money scope: a collection task is money; Dana never receives it and cannot create one; Ortal receives money tasks only; Vered everything', () => {
  const w = world();
  w.call({ action: 'createTask', submissionId: SID(10), task: { kind: 'collection', patientId: 'p1', title: 'שיחת גבייה', dueDate: '2026-11-01' } });
  w.call({ action: 'createTask', submissionId: SID(11), task: { kind: 'call', leadId: 'L1', title: 'שיחה', dueDate: '2026-11-01' } });
  assert.deepEqual(w.call({ action: 'getTasks' }).tasks.map((t) => t.kind), ['collection', 'call']);
  assert.deepEqual(w.call({ action: 'getTasks' }, DANA).tasks.map((t) => t.kind), ['call']);
  assert.deepEqual(w.call({ action: 'getTasks' }, ORTAL).tasks.map((t) => t.kind), ['collection']);
  const no = w.call({ action: 'createTask', submissionId: SID(12), task: { kind: 'collection', patientId: 'p1', title: 'x' } }, DANA);
  assert.equal(no.ok, false); assert.equal(no.error, 'forbidden');
  const noMoney = w.call({ action: 'completeTask', id: 'task-' + SID(10).slice(4) }, DANA);
  assert.equal(noMoney.error, 'not_found', 'a money task does not exist for her');
  const ok = w.call({ action: 'createTask', submissionId: SID(13), task: { kind: 'call', leadId: 'L2', title: 'שיחה', dueDate: '2026-11-01' } }, DANA);
  assert.equal(ok.ok, true); assert.equal(ok.task.createdBy, 'דנה', 'every action carries the actor');
});

test('getTasks filters: status, assignee, subject, date range (dated and window tasks; undated listed only without a range)', () => {
  const w = world();
  w.call({ action: 'createTask', submissionId: SID(20), task: { kind: 'call', leadId: 'L1', title: 'a', assignee: 'ורד', dueDate: '2026-11-03' } });
  w.call({ action: 'createTask', submissionId: SID(21), task: { kind: 'call', leadId: 'L2', title: 'b', assignee: 'דנה', windowStart: '2026-11-02', windowEnd: '2026-11-06' } });
  w.call({ action: 'createTask', submissionId: SID(22), task: { kind: 'review', patientId: 'p1', title: 'c', assignee: 'ורד' } });
  w.call({ action: 'createTask', submissionId: SID(23), task: { kind: 'call', leadId: 'L1', title: 'd', assignee: 'ורד', dueDate: '2026-12-01' } });
  const ids = (r) => r.tasks.map((t) => t.title);
  assert.deepEqual(ids(w.call({ action: 'getTasks' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(w.call({ action: 'getTasks', assignee: 'ורד' })), ['a', 'c', 'd']);
  assert.deepEqual(ids(w.call({ action: 'getTasks', leadId: 'L1' })), ['a', 'd']);
  assert.deepEqual(ids(w.call({ action: 'getTasks', from: '2026-11-01', to: '2026-11-07' })), ['a', 'b'], 'window overlaps; undated out; December out');
  assert.deepEqual(ids(w.call({ action: 'getTasks', from: '2026-11-05', to: '2026-11-05' })), ['b'], 'a window covering the day');
  w.call({ action: 'completeTask', id: 'task-' + SID(20).slice(4), outcome: 'דיברנו' });
  assert.deepEqual(ids(w.call({ action: 'getTasks', status: 'open' })), ['b', 'c', 'd']);
  assert.deepEqual(ids(w.call({ action: 'getTasks', status: 'done' })), ['a']);
});

test('mutations: complete / reschedule (history event with prev + next; reason required when a promised date moves) / reassign / cancel (reason required); a closed task refuses; unknown id refuses', () => {
  const w = world();
  const id = w.call({ action: 'createTask', submissionId: SID(30), task: { kind: 'call', leadId: 'L1', title: 't', assignee: 'ורד', dueDate: '2026-11-03' } }).task.id;
  const rs = w.call({ action: 'rescheduleTask', id, dueDate: '2026-11-10', dueTime: '09:00' });
  assert.equal(rs.ok, true); assert.equal(rs.task.dueDate, '2026-11-10'); assert.equal(rs.task.dueTime, '09:00'); assert.equal(rs.task.status, 'open');
  const ev = w.activity().filter((e) => e.kind === 'task_rescheduled');
  assert.equal(ev.length, 1); const d = JSON.parse(ev[0].detailsJson); assert.equal(d.prev.dueDate, '2026-11-03'); assert.equal(d.next.dueDate, '2026-11-10'); assert.match(ev[0].summary, /2026-11-03 ← 2026-11-10/);
  assert.equal(w.call({ action: 'rescheduleTask', id, dueDate: 'junk' }).error, 'bad_due');
  assert.equal(w.call({ action: 'rescheduleTask', id }).error, 'bad_due');
  const ra = w.call({ action: 'reassignTask', id, assignee: 'דנה' });
  assert.equal(ra.ok, true); assert.equal(ra.task.assignee, 'דנה'); assert.equal(ra.task.updatedBy, 'ורד');
  assert.equal(w.call({ action: 'reassignTask', id, assignee: '' }).error, 'bad_assignee');
  assert.equal(w.call({ action: 'withdrawTask', id, reason: 'x' }).error, 'missing_reason');
  const cx = w.call({ action: 'withdrawTask', id, reason: 'נסגר בטעות' });
  assert.equal(cx.ok, true); assert.equal(cx.task.status, 'cancelled'); assert.equal(cx.task.cancelReason, 'נסגר בטעות'); assert.equal(cx.task.doneBy, 'ורד');
  const again = w.call({ action: 'completeTask', id });
  assert.equal(again.error, 'not_open'); assert.equal(again.task.status, 'cancelled');
  assert.equal(w.call({ action: 'completeTask', id: 'task-' + 'f'.repeat(32) }).error, 'not_found');
  assert.equal(w.call({ action: 'completeTask', id: 'nope' }).error, 'not_found');
  // a promised date (a task born from a contact) needs a reason to move
  const lc = w.call({ action: 'logContact', submissionId: SID(31), contact: { leadId: 'L1', outcome: 'call_back_later', summary: 'ביקשו יום שני' }, next: { days: 5 } });
  assert.equal(lc.ok, true);
  assert.equal(w.call({ action: 'rescheduleTask', id: lc.created.id, dueDate: '2026-12-01' }).error, 'missing_reason');
  const moved = w.call({ action: 'rescheduleTask', id: lc.created.id, dueDate: '2026-12-01', reason: 'המשפחה ביקשה' });
  assert.equal(moved.ok, true); assert.equal(JSON.parse(w.activity().filter((e) => e.kind === 'task_rescheduled').pop().detailsJson).reason, 'המשפחה ביקשה');
  const audits = w.g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').map((a) => a.action);
  for (const a of ['task_created', 'task_rescheduled', 'task_reassigned', 'task_cancelled', 'contact_logged']) assert.ok(audits.includes(a), a);
});

test('logContact: ONE transaction — the contact event, the fulfilled task done with the contact outcome, the follow-up created (days / date / window / none + explanation); three attempts = three events; a replay writes nothing twice; validation', () => {
  const w = world();
  const open = w.call({ action: 'createTask', submissionId: SID(40), task: { kind: 'call', leadId: 'L1', title: 'שיחה ראשונה', assignee: 'ורד', dueDate: '2026-10-28' } }).task;
  // attempt 1: no answer, back in 3 days (the fulfilled task closes, a new one opens)
  const a1 = w.call({ action: 'logContact', submissionId: SID(41), contact: { leadId: 'L1', houseId: 'ramot', channel: 'phone', withWhom: 'אמא', reason: 'מעקב', outcome: 'no_answer', summary: 'אין מענה', taskId: open.id }, next: { days: 3, title: 'ניסיון שני' } });
  assert.equal(a1.ok, true); assert.equal(a1.event.eventId, 'contact:' + SID(41)); assert.equal(a1.event.kind, 'contact_logged');
  assert.equal(a1.completed.id, open.id); assert.equal(a1.completed.status, 'done'); assert.equal(a1.completed.outcome, 'לא היה מענה'); assert.equal(a1.completed.contactEventId, 'contact:' + SID(41));
  assert.equal(a1.created.id, 'task-' + SID(41).slice(4) + '-next'); assert.equal(a1.created.status, 'open'); assert.equal(a1.created.source, 'contact'); assert.equal(a1.created.title, 'ניסיון שני'); assert.equal(a1.created.assignee, 'ורד');
  assert.match(a1.created.dueDate, /^\d{4}-\d{2}-\d{2}$/); assert.equal(a1.created.reason, 'לא היה מענה');
  // replay (double click / timeout retry): same answer, nothing written twice
  const again = w.call({ action: 'logContact', submissionId: SID(41), contact: { leadId: 'L1', outcome: 'no_answer', taskId: open.id }, next: { days: 3 } });
  assert.equal(again.ok, true); assert.equal(again.replayed, true); assert.equal(again.created.id, a1.created.id);
  assert.equal(w.activity().filter((e) => e.kind === 'contact_logged').length, 1); assert.equal(w.tasks().length, 2);
  // attempt 2: spoke, meeting set, follow-up on a date with time
  const a2 = w.call({ action: 'logContact', submissionId: SID(42), contact: { leadId: 'L1', channel: 'whatsapp', withWhom: 'אבא', outcome: 'meeting_set', summary: 'נקבע ל-4/11', taskId: a1.created.id }, next: { kind: 'meeting', dueDate: '2026-11-04', dueTime: '13:00', title: 'פגישת קבלה', assignee: 'דנה' } });
  assert.equal(a2.ok, true); assert.equal(a2.completed.id, a1.created.id); assert.equal(a2.created.kind, 'meeting'); assert.equal(a2.created.dueTime, '13:00'); assert.equal(a2.created.assignee, 'דנה');
  // attempt 3: no interest now, no follow-up with an explanation — the lead is NOT closed by this
  const a3 = w.call({ action: 'logContact', submissionId: SID(43), contact: { leadId: 'L1', outcome: 'no_interest_now', summary: 'יחזרו בעצמם' }, next: { none: true, explanation: 'המשפחה תחזור אלינו; הליד נשאר פתוח' } });
  assert.equal(a3.ok, true); assert.equal(a3.created, null); assert.equal(a3.completed, null);
  const events = w.activity().filter((e) => e.kind === 'contact_logged');
  assert.equal(events.length, 3, 'three attempts = three events');
  assert.deepEqual(events.map((e) => JSON.parse(e.detailsJson).outcome), ['no_answer', 'meeting_set', 'no_interest_now']);
  assert.equal(JSON.parse(events[2].detailsJson).noNext, 'המשפחה תחזור אלינו; הליד נשאר פתוח');
  assert.ok(!w.g.sheetRows('לידים לא רלוונטיים', 'IRRELEVANT_LEAD_COLUMNS').length, 'no lead was closed');
  // a window follow-up
  const a4 = w.call({ action: 'logContact', submissionId: SID(44), contact: { patientId: 'p1', outcome: 'call_back_later' }, next: { windowStart: '2026-11-09', windowEnd: '2026-11-13' } });
  assert.equal(a4.ok, true); assert.equal(a4.created.dueDate, ''); assert.equal(a4.created.windowStart, '2026-11-09'); assert.equal(a4.created.patientId, 'p1');
  // validation
  for (const [body, code] of [
    [{ submissionId: 'x', contact: { leadId: 'L1', outcome: 'no_answer' }, next: { days: 1 } }, 'bad_submission_id'],
    [{ submissionId: SID(45), next: { days: 1 } }, 'missing_contact'],
    [{ submissionId: SID(45), contact: { outcome: 'no_answer' }, next: { days: 1 } }, 'missing_subject'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'zzz' }, next: { days: 1 } }, 'bad_outcome'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'no_answer', channel: 'fax' }, next: { days: 1 } }, 'bad_channel'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { none: true } }, 'missing_next_explanation'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { days: 0 } }, 'bad_due'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'no_answer' }, next: {} }, 'bad_due'],
    [{ submissionId: SID(45), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { dueDate: '2026-11-01', kind: 'nope' } }, 'bad_kind'],
  ]) {
    const no = w.call(Object.assign({ action: 'logContact' }, body));
    assert.equal(no.ok, false, code); assert.equal(no.error, code, code);
  }
  assert.equal(w.activity().filter((e) => e.kind === 'contact_logged').length, 4, 'refusals write nothing');
  // Dana logs calls too; a money follow-up is refused for her
  const dn = w.call({ action: 'logContact', submissionId: SID(46), contact: { leadId: 'L9', outcome: 'spoke_follow_up', summary: 'x' }, next: { days: 7 } }, DANA);
  assert.equal(dn.ok, true); assert.equal(dn.created.createdBy, 'דנה'); assert.equal(w.activity().filter((e) => e.eventId === 'contact:' + SID(46))[0].actorName, 'דנה');
  assert.equal(w.call({ action: 'logContact', submissionId: SID(47), contact: { patientId: 'p1', outcome: 'spoke_follow_up' }, next: { kind: 'collection', days: 2 } }, DANA).error, 'forbidden');
  // no verified session → the same gate as getActivity
  const anon = plain(w.g.post({ action: 'getTasks' }));
  assert.equal(anon.ok, false);
});

test('getActivity shows the contact events on the subject (Dana: no money kinds, but contact events are hers to see)', () => {
  const w = world();
  w.call({ action: 'logContact', submissionId: SID(50), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { days: 1 } });
  const v = w.call({ action: 'getActivity', leadId: 'L1' });
  assert.ok(v.events.some((e) => e.kind === 'contact_logged'));
  const d = w.call({ action: 'getActivity', leadId: 'L1' }, DANA);
  assert.ok(d.events.some((e) => e.kind === 'contact_logged')); assert.equal(d.scope, 'no_money');
});
