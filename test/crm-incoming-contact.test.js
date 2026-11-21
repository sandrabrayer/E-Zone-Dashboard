'use strict';

/* The contact log's three kinds, a voided record, «מה הלאה» and the lead card layout
 * (CHANGELOG-crm-incoming-contact.md, CHANGELOG-crm-contact-three-states.md).
 *   - server: the REAL Code.gs in a vm with in-memory sheets (PROXY_SECRET enforced);
 *   - client: the pure core of public/crm/crm.js, plus source pins for the markup. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs } = require('./helpers/gs-sandbox');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');
const PROXY_SECRET = 'proxy-secret-TEST-incoming-0123456789abcdef01';
const TODAY = '2026-11-21';   // a Saturday
const plain = (x) => JSON.parse(JSON.stringify(x));
const actor = (id, user, roles, caps) => ({ proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps });
const VERED = () => actor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const DANA = () => actor('dana', 'דנה', ['staff'], []);
const ORTAL = () => actor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SID = (n) => 'sub-' + String(n).padStart(32, '0');

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const activity = () => g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
  const tasks = () => g.sheetRows('Tasks', 'TASK_COLUMNS');
  return { g, call, activity, tasks };
}
const detailsOf = (row) => JSON.parse(row.detailsJson);
const contacts = (w) => w.activity().filter((x) => x.kind === 'contact_logged');

/* ---------------- server: the three kinds ---------------- */

test('Code.gs lists: the kinds are out / in / note; «לא נדרש המשך» sits in CONTACT_OUTCOMES; the client mirrors both (ids and order) with the three Hebrew names', () => {
  const g = loadGs({ props: {} });
  assert.deepEqual(Array.from(g.run('CONTACT_DIRECTIONS')), ['out', 'in', 'note']);
  assert.ok(Array.from(g.run('CONTACT_OUTCOMES')).includes('spoke_no_follow_up'));
  assert.deepEqual(core.CONTACT_DIRECTIONS.map((d) => d.id), Array.from(g.run('CONTACT_DIRECTIONS')));
  assert.deepEqual(core.CONTACT_DIRECTIONS.map((d) => d.label), ['שיחה יוצאת', 'שיחה נכנסת', 'תיעוד שיחה']);
  assert.deepEqual(core.CONTACT_OUTCOMES.map((o) => o.id), Array.from(g.run('CONTACT_OUTCOMES')));
  assert.equal(core.contactOutcomeLabel('spoke_no_follow_up'), 'התקיימה שיחה — לא נדרש המשך');
  assert.equal(core.NO_FOLLOW_UP_TEXT, g.run('CONTACT_NO_FOLLOW_UP_TEXT'), 'one default explanation on both sides');
  assert.ok(!/פנו אלינו|פנייה נכנסת/.test(SRC), 'the confusing «פנו אלינו» wording is gone from the client');
  assert.ok(!/פנייה נכנסת/.test(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')), '…and from Code.gs');
});

test('logContact stores the kind in the event details and names it in the summary: «שיחה נכנסת» / «שיחה יוצאת»; «תיעוד שיחה» adds nothing', () => {
  const w = world();
  const inn = w.call({ action: 'logContact', submissionId: SID(1), contact: { leadId: 'L1', direction: 'in', channel: 'phone', withWhom: 'המטופל', outcome: 'spoke_follow_up', summary: 'שאל על עלויות' }, next: { days: 3 } });
  assert.equal(inn.ok, true);
  assert.equal(inn.event.summary, 'שיחה נכנסת · התקיימה שיחה ונדרש המשך · שאל על עלויות');
  assert.equal(inn.created.kind, 'call', 'the follow-up is created exactly as before');
  const out = w.call({ action: 'logContact', submissionId: SID(2), contact: { leadId: 'L1', direction: 'out', outcome: 'no_answer' }, next: { days: 1 } });
  assert.equal(out.event.summary, 'שיחה יוצאת · לא היה מענה');
  const note = w.call({ action: 'logContact', submissionId: SID(3), contact: { leadId: 'L1', direction: 'note', outcome: 'awaiting_decision' }, next: { days: 1 } });
  assert.equal(note.event.summary, 'ממתינים להחלטה או למידע');
  assert.deepEqual(contacts(w).map((r) => detailsOf(r).direction), ['in', 'out', 'note']);
  const read = w.call({ action: 'getActivity', leadId: 'L1' });
  assert.deepEqual(read.events.filter((e) => e.kind === 'contact_logged').map((e) => e.details.direction).sort(), ['in', 'note', 'out'], 'the card reads the kind back');
});

test('logContact without a direction (a caller that does not send one) is «תיעוד שיחה» — never guessed as outgoing; an unknown direction is refused and nothing is written', () => {
  const w = world();
  const r = w.call({ action: 'logContact', submissionId: SID(4), contact: { leadId: 'L1', outcome: 'no_answer' }, next: { days: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.event.summary, 'לא היה מענה');
  assert.equal(detailsOf(contacts(w)[0]).direction, 'note');
  for (const bad of ['both', 'IN', '<script>', 7]) {
    const no = w.call({ action: 'logContact', submissionId: SID(5), contact: { leadId: 'L1', direction: bad, outcome: 'no_answer' }, next: { days: 1 } });
    assert.equal(no.ok, false, String(bad));
    assert.equal(no.error, 'bad_direction');
    assert.equal(no.message, 'סוג התיעוד לא מוכר');
  }
  assert.equal(contacts(w).length, 1);
  assert.equal(w.tasks().length, 1, 'only the first, accepted record created a follow-up');
});

test('«לא נדרש המשך»: with next.none the explanation may be empty (the default text is stored); every OTHER outcome still must explain why there is no follow-up', () => {
  const w = world();
  const ok = w.call({ action: 'logContact', submissionId: SID(6), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_no_follow_up', summary: 'שאל שאלה כללית' }, next: { none: true, explanation: '' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.created, null, 'no follow-up task');
  assert.equal(detailsOf(contacts(w)[0]).noNext, 'לא נדרש המשך');
  w.call({ action: 'logContact', submissionId: SID(7), contact: { leadId: 'L1', direction: 'out', outcome: 'spoke_no_follow_up' }, next: { none: true, explanation: 'המשפחה תחזור אלינו' } });
  assert.equal(detailsOf(w.activity().filter((x) => x.eventId === 'contact:' + SID(7))[0]).noNext, 'המשפחה תחזור אלינו', 'a typed explanation wins');
  const refused = w.call({ action: 'logContact', submissionId: SID(8), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_follow_up' }, next: { none: true, explanation: '' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'missing_next_explanation');
});

/* ---------------- server: voiding a record entered by mistake ---------------- */

test('voidContact: the same call entered twice — the duplicate is VOIDED by a new event (its row is untouched), its open follow-up is cancelled, the other record and its follow-up stay', () => {
  const w = world();
  const a = w.call({ action: 'logContact', submissionId: SID(11), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_follow_up', summary: 'מבקש תמונות' }, next: { days: 1, title: 'לשלוח תמונות' } });
  const b = w.call({ action: 'logContact', submissionId: SID(12), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_follow_up', summary: 'לשלוח תמונות' }, next: { days: 1, title: 'לשלוח לו תמונות' } });
  assert.equal(w.tasks().filter((t) => t.status === 'open').length, 2);
  const before = plain(contacts(w));
  const v = w.call({ action: 'voidContact', eventId: b.event.eventId, reason: 'הוזן פעמיים' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.voided, { eventId: b.event.eventId });
  assert.equal(v.cancelledTask.id, b.created.id);
  assert.equal(v.replayed, false);
  assert.deepEqual(plain(contacts(w)), before, 'APPEND-ONLY: both contact rows are exactly as they were');
  const voids = w.activity().filter((x) => x.kind === 'contact_voided');
  assert.equal(voids.length, 1);
  assert.equal(voids[0].eventId, 'void:' + b.event.eventId);
  assert.equal(voids[0].supersedesEventId, b.event.eventId);
  assert.equal(voids[0].leadId, 'L1'); assert.equal(voids[0].actorName, 'ורד'); assert.equal(voids[0].source, 'manual');
  assert.equal(voids[0].summary, 'תיעוד שיחה בוטל · הוזן פעמיים');
  assert.deepEqual(detailsOf(voids[0]), { reason: 'הוזן פעמיים', voidedEventId: b.event.eventId });
  const tasks = w.tasks();
  const tb = tasks.filter((t) => t.id === b.created.id)[0], ta = tasks.filter((t) => t.id === a.created.id)[0];
  assert.equal(tb.status, 'cancelled'); assert.match(tb.cancelReason, /התיעוד שיצר אותה בוטל · הוזן פעמיים/); assert.equal(tb.doneBy, 'ורד');
  assert.equal(ta.status, 'open', 'the real record keeps its follow-up');
  // idempotent: a second void writes nothing
  const again = w.call({ action: 'voidContact', eventId: b.event.eventId, reason: 'שוב' });
  assert.equal(again.ok, true); assert.equal(again.replayed, true); assert.equal(again.cancelledTask, null);
  assert.equal(w.activity().filter((x) => x.kind === 'contact_voided').length, 1);
});

test('voidContact: a voided record is no longer «last contact» nor counted (contactIndex); a follow-up that is already done is left alone', () => {
  const w = world();
  const a = w.call({ action: 'logContact', submissionId: SID(21), contact: { leadId: 'L1', direction: 'out', outcome: 'no_answer', occurredAt: '2026-11-18T08:00:00.000Z' }, next: { days: 2 } });
  const b = w.call({ action: 'logContact', submissionId: SID(22), contact: { leadId: 'L1', direction: 'in', outcome: 'meeting_set', occurredAt: '2026-11-20T08:00:00.000Z' }, next: { days: 2 } });
  assert.equal(w.call({ action: 'contactIndex' }).leads.L1.outcome, 'meeting_set');
  assert.equal(w.call({ action: 'contactIndex' }).count, 2);
  // the follow-up of b was already completed by hand → the void must not touch it
  assert.equal(w.call({ action: 'completeTask', id: b.created.id, outcome: 'בוצע' }).ok, true);
  const v = w.call({ action: 'voidContact', eventId: b.event.eventId, reason: 'טעות בליד' });
  assert.equal(v.ok, true); assert.equal(v.cancelledTask, null);
  assert.equal(w.tasks().filter((t) => t.id === b.created.id)[0].status, 'done');
  const idx = w.call({ action: 'contactIndex' });
  assert.equal(idx.leads.L1.outcome, 'no_answer', 'the last contact is the one that still stands');
  assert.equal(idx.count, 1);
  assert.equal(w.tasks().filter((t) => t.id === a.created.id)[0].status, 'open');
  // every contact voided → the lead has no documented contact again
  assert.equal(w.call({ action: 'voidContact', eventId: a.event.eventId, reason: 'בדיקה' }).cancelledTask.id, a.created.id);
  assert.equal(w.call({ action: 'contactIndex' }).leads.L1, undefined);
});

test('voidContact fails closed: a reason is required, the id must be a contact record that exists; it is a DELETE_ACTIONS operation — only a `deleter` (Vered, Sandra) may void, Dana and the controller are refused, an unverified call is refused; nothing is written', () => {
  const w = world();
  const a = w.call({ action: 'logContact', submissionId: SID(31), contact: { leadId: 'L1', direction: 'in', outcome: 'spoke_follow_up' }, next: { days: 1 } });
  const id = a.event.eventId;
  assert.equal(w.call({ action: 'voidContact', eventId: id, reason: ' ' }).error, 'missing_void_reason');
  assert.equal(w.call({ action: 'voidContact', eventId: id }).error, 'missing_void_reason');
  for (const bad of ['', 'x', 'lead_created:1', 'contact:sub-123', 'void:' + id, '=HYPERLINK("x")']) assert.equal(w.call({ action: 'voidContact', eventId: bad, reason: 'סיבה' }).error, 'bad_event', JSON.stringify(bad));
  assert.equal(w.call({ action: 'voidContact', eventId: 'contact:' + SID(99), reason: 'סיבה' }).error, 'event_not_found');
  const dana = w.call({ action: 'voidContact', eventId: id, reason: 'סיבה' }, DANA);
  assert.equal(dana.ok, false); assert.equal(dana.error, 'forbidden_role', 'Dana documents contacts but has no `deleter` role');
  const ortal = w.call({ action: 'voidContact', eventId: id, reason: 'סיבה' }, ORTAL);
  assert.equal(ortal.ok, false); assert.match(ortal.error, /^forbidden/, 'the controller is refused');
  assert.ok(Array.from(w.g.run('DELETE_ACTIONS')).includes('voidContact'));
  assert.ok(require('../lib/role-scope').DELETE_ACTIONS.includes('voidContact'), 'server.js refuses it first, from the session cookie');
  const anon = plain(w.g.post({ action: 'voidContact', eventId: id, reason: 'סיבה', proxySecret: PROXY_SECRET }));
  assert.equal(anon.ok, false, 'no verified personal session');
  assert.equal(w.activity().filter((x) => x.kind === 'contact_voided').length, 0);
  assert.equal(w.tasks().filter((t) => t.status === 'open').length, 1);
  assert.equal(w.call({ action: 'voidContact', eventId: id, reason: 'הוזן בטעות' }).ok, true, 'Vered (deleter) may');
  assert.ok(Array.from(w.g.run('PROXY_KNOWN_ACTIONS')).includes('voidContact'));
});

/* ---------------- client: the pure core ---------------- */

test('contactDirection reads a STORED record: out / in, anything else (missing included) is «תיעוד שיחה»; an incoming call does not offer the outgoing-only outcomes', () => {
  assert.equal(core.contactDirection({ direction: 'in' }), 'in'); assert.equal(core.contactDirection({ direction: 'out' }), 'out');
  for (const v of [{}, null, { direction: 'note' }, { direction: 'zzz' }]) assert.equal(core.contactDirection(v), 'note');
  assert.equal(core.contactDirectionLabel('in'), 'שיחה נכנסת'); assert.equal(core.contactDirectionLabel('out'), 'שיחה יוצאת');
  assert.equal(core.contactDirectionLabel('note'), 'תיעוד שיחה'); assert.equal(core.contactDirectionLabel('???'), 'תיעוד שיחה');
  const inIds = core.contactOutcomesFor('in').map((o) => o.id);
  assert.ok(!inIds.includes('no_answer')); assert.ok(!inIds.includes('bad_contact_details'));
  assert.ok(inIds.includes('spoke_no_follow_up') && inIds.includes('meeting_set'));
  for (const d of ['out', 'note', '']) assert.deepEqual(core.contactOutcomesFor(d).map((o) => o.id), core.CONTACT_OUTCOMES.map((o) => o.id), d);
});

test('contactErrors: the kind MUST be chosen (no silent default); an outgoing-only outcome is refused for an incoming call; «לא נדרש המשך» + «ללא משימת המשך» needs no explanation, any other outcome does', () => {
  const base = { direction: 'in', when: TODAY, channel: 'phone', outcome: 'spoke_follow_up', next: 'd3' };
  assert.deepEqual(core.contactErrors(base, TODAY), {});
  assert.match(core.contactErrors(Object.assign({}, base, { direction: '' }), TODAY).direction, /שיחה יוצאת, שיחה נכנסת או תיעוד שיחה/);
  assert.ok(core.contactErrors(Object.assign({}, base, { direction: 'sideways' }), TODAY).direction);
  assert.ok(core.contactErrors({ when: TODAY, channel: 'phone', outcome: 'no_answer', next: 'd1' }, TODAY).direction, 'a missing kind is an error');
  assert.ok(core.contactErrors(Object.assign({}, base, { outcome: 'no_answer' }), TODAY).outcome, 'not an incoming outcome');
  for (const d of ['out', 'note']) assert.deepEqual(core.contactErrors(Object.assign({}, base, { direction: d, outcome: 'no_answer' }), TODAY), {}, d);
  assert.deepEqual(core.contactErrors(Object.assign({}, base, { outcome: 'spoke_no_follow_up', next: 'none' }), TODAY), {});
  assert.match(core.contactErrors(Object.assign({}, base, { next: 'none' }), TODAY).next, /חובה להסביר/);
});

test('contactBody: the chosen kind is sent; «לא נדרש המשך» sends none with the default explanation, a typed one wins', () => {
  const sid = core.newSubmissionId();
  const none = core.contactBody({ leadId: 'L1' }, { direction: 'in', when: TODAY, channel: 'phone', outcome: 'spoke_no_follow_up', summary: 'בירור', next: 'none' }, sid, '', TODAY, 'ורד');
  assert.equal(none.action, 'logContact');
  assert.equal(none.contact.direction, 'in');
  assert.deepEqual(none.next, { none: true, explanation: 'לא נדרש המשך' });
  const typed = core.contactBody({ leadId: 'L1' }, { direction: 'note', when: TODAY, channel: 'phone', outcome: 'spoke_no_follow_up', next: 'none', nextExplanation: 'יחזור אלינו' }, sid, '', TODAY, 'ורד');
  assert.equal(typed.contact.direction, 'note'); assert.equal(typed.next.explanation, 'יחזור אלינו');
  const follow = core.contactBody({ leadId: 'L1' }, { direction: 'out', when: TODAY, channel: 'whatsapp', outcome: 'call_back_later', next: 'd1' }, sid, '', TODAY, 'דנה');
  assert.equal(follow.contact.direction, 'out'); assert.equal(follow.next.dueDate, '2026-11-22'); assert.equal(follow.next.assignee, 'דנה');
});

test('recentContacts: only contact records, newest first, capped, a VOIDED record left out; the text is built from the details (not the stored summary line); hostile text stays text', () => {
  const id = (n) => 'contact:' + SID(n);
  const events = [
    { eventId: 'lc', kind: 'lead_stage_changed', occurredAt: '2026-11-21T10:00:00.000Z', summary: 'שלב' },
    { eventId: id(1), kind: 'contact_logged', occurredAt: '2026-11-18T08:00:00.000Z', actorName: 'ורד', summary: 'לא היה מענה', details: { direction: 'out', outcome: 'no_answer' } },
    { eventId: id(2), kind: 'contact_logged', occurredAt: '2026-11-21T09:00:00.000Z', actorName: 'סנדרה', summary: 'ניסוח ישן · לא מוצג', details: { direction: 'in', outcome: 'spoke_follow_up', summary: '<img src=x onerror=1>', nextTaskId: 'task-9' } },
    { eventId: id(3), kind: 'contact_logged', occurredAt: '2026-11-21T09:05:00.000Z', actorName: 'סנדרה', summary: 'x', details: { direction: 'in', outcome: 'spoke_follow_up', summary: 'כפול' } },
    { eventId: 'void:' + id(3), kind: 'contact_voided', occurredAt: '2026-11-21T09:10:00.000Z', actorName: 'סנדרה', summary: 'תיעוד שיחה בוטל · הוזן פעמיים', supersedesEventId: id(3), details: { reason: 'הוזן פעמיים' } },
    { eventId: id(4), kind: 'contact_logged', occurredAt: '2026-11-19T09:00:00.000Z', actorName: 'ורד', summary: 'ישן · ללא פרטים' },
    null,
  ];
  assert.deepEqual(core.contactVoidedIds(events), { [id(3)]: true });
  const r = core.recentContacts(events, 2);
  assert.equal(r.total, 3, 'the voided record is not counted');
  assert.deepEqual(r.items.map((x) => x.eventId), [id(2), id(4)]);
  assert.deepEqual(r.items[0], { eventId: id(2), at: '2026-11-21T09:00:00.000Z', actorName: 'סנדרה', direction: 'in', outcome: 'spoke_follow_up', text: 'התקיימה שיחה ונדרש המשך · <img src=x onerror=1>', nextTaskId: 'task-9' });
  assert.equal(r.items[1].direction, 'note', 'a record with no direction is «תיעוד שיחה», never guessed'); assert.equal(r.items[1].text, 'ישן · ללא פרטים');
  assert.equal(core.recentContacts(events).items.length, 3, 'default cap is 3');
  assert.deepEqual(core.recentContacts(null, 3), { total: 0, items: [] });
  assert.match(SRC, /'<div>' \+ esc\(x\.text\) \+ '<\/div>'/, 'the recent-contact text is escaped on render');
});

test('voidContact on the client: a reason and a real contact id are required before anything is posted; the answer must echo the voided id', () => {
  const id = 'contact:' + SID(5);
  assert.equal(core.voidContactError(id, 'הוזן פעמיים'), '');
  assert.match(core.voidContactError(id, ''), /סיבה/); assert.match(core.voidContactError(id, 'x'), /סיבה/); assert.match(core.voidContactError(id, 'x'.repeat(301)), /300/);
  for (const bad of ['', 'task-1', 'contact:1', 'void:' + id]) assert.match(core.voidContactError(bad, 'סיבה טובה'), /אינו תקין/, bad);
  assert.deepEqual(core.voidContactBody(id, ' הוזן פעמיים '), { action: 'voidContact', eventId: id, reason: 'הוזן פעמיים' });
  assert.equal(core.voidContactAccepted({ ok: true, voided: { eventId: id }, cancelledTask: null }, id), '');
  assert.notEqual(core.voidContactAccepted({ ok: true }, id), '', 'ok without the echoed id is not proof');
  assert.notEqual(core.voidContactAccepted({ ok: true, voided: { eventId: 'contact:' + SID(6) } }, id), '');
  assert.notEqual(core.voidContactAccepted({ ok: false, error: 'forbidden' }, id), '');
  assert.notEqual(core.voidContactAccepted(null, id), '');
});

test('nextSteps («מה הלאה»): every open follow-up of the subject as WHAT · WHEN (relative + the real date + the weekday) · WHO, most urgent first; done / other subjects are out', () => {
  const tasks = [
    { id: 't-wait', kind: 'call', leadId: 'L1', title: 'לשלוח לו תמונות', reason: 'מבקש תמונות מחדר הכושר', assignee: 'סנדרה', dueDate: '2026-11-22', status: 'open' },
    { id: 't-late', kind: 'call', leadId: 'L1', title: 'לחזור למשפחה', assignee: 'דנה', dueDate: '2026-11-19', status: 'open' },
    { id: 't-today', kind: 'review', leadId: 'L1', title: 'לבדוק מסמכים', assignee: 'ורד', dueDate: TODAY, dueTime: '14:30', status: 'open' },
    { id: 't-far', kind: 'call', leadId: 'L1', title: 'מעקב', dueDate: '2026-11-28', status: 'open' },
    { id: 't-week', kind: 'call', leadId: 'L1', title: 'במהלך השבוע', windowStart: '2026-11-29', windowEnd: '2026-12-05', status: 'open' },
    { id: 't-none', kind: 'other', leadId: 'L1', title: 'ללא מועד', status: 'open' },
    { id: 't-done', kind: 'call', leadId: 'L1', title: 'בוצע', dueDate: '2026-11-20', status: 'done' },
    { id: 't-other', kind: 'call', leadId: 'L2', title: 'ליד אחר', dueDate: TODAY, status: 'open' },
    { id: 't-pat', kind: 'collection', patientId: 'p1', title: 'גבייה', dueDate: TODAY, status: 'open' },
  ];
  const steps = core.nextSteps({ leadId: 'L1' }, tasks, TODAY);
  assert.deepEqual(steps.map((x) => x.id), ['t-late', 't-today', 't-wait', 't-far', 't-week', 't-none']);
  const by = Object.fromEntries(steps.map((x) => [x.id, x]));
  assert.equal(by['t-late'].rel, 'באיחור של 2 ימים'); assert.equal(by['t-late'].when, '19/11/2026 (חמישי)'); assert.equal(by['t-late'].state, 'late');
  assert.equal(by['t-today'].rel, 'היום'); assert.equal(by['t-today'].when, '21/11/2026 (שבת) 14:30');
  assert.deepEqual([by['t-wait'].title, by['t-wait'].rel, by['t-wait'].when, by['t-wait'].assignee, by['t-wait'].reason], ['לשלוח לו תמונות', 'מחר', '22/11/2026 (ראשון)', 'סנדרה', 'מבקש תמונות מחדר הכושר']);
  assert.equal(by['t-far'].rel, 'בעוד 7 ימים');
  assert.equal(by['t-week'].rel, 'בהמשך'); assert.match(by['t-week'].when, /במהלך 29\/11\/2026 – 05\/12\/2026/);
  assert.equal(by['t-none'].rel, 'ללא תאריך'); assert.equal(by['t-none'].when, '');
  assert.equal(core.nextSteps({ leadId: 'L1' }, [{ id: 'y', leadId: 'L1', title: 'אתמול', dueDate: '2026-11-20', status: 'open' }], TODAY)[0].rel, 'באיחור של יום');
  assert.deepEqual(core.nextSteps({ patientId: 'p1' }, tasks, TODAY).map((x) => x.id), ['t-pat']);
  assert.deepEqual(core.nextSteps({ leadId: 'L1' }, null, TODAY), [], 'tasks not loaded → no alert, never an error');
  assert.deepEqual(core.nextSteps(null, tasks, TODAY), []);
});

test('meetingWithLabel: «נפגש/ת עם» only after an outcome of a meeting that was HELD; a manager picked at lead creation reads «פגישה מיועדת עם»', () => {
  assert.equal(core.meetingWithLabel({ meetingWith: 'רנטה' }), 'פגישה מיועדת עם');
  assert.equal(core.meetingWithLabel({ meetingWith: 'רנטה', visitDate: '2026-11-25' }), 'פגישה מיועדת עם', 'a date alone is not a held meeting');
  for (const o of ['postponed', 'cancelled', 'not_relevant']) assert.equal(core.meetingWithLabel({ meetingOutcome: o }), 'פגישה מיועדת עם', o);
  for (const o of ['entered', 'thinking']) assert.equal(core.meetingWithLabel({ meetingOutcome: o }), 'נפגש/ת עם', o);
  assert.equal(core.meetingWithLabel(null), 'פגישה מיועדת עם');
});

test('leadOverviewGroups: contact → status → meeting → notes; empty values and empty groups are dropped; no visit date and no outcome = «לא נקבעה»', () => {
  const lead = { id: 'L1', name: 'פלוני', phone: '0501234567', house: 'rehab', source: 'גוגל', assignedTo: 'ורד', stage: 'new', created: '2026-11-18', meetingWith: 'רנטה', contactName: 'פלוני', contactRelation: 'מטופל', note: 'הערה' };
  const g = core.leadOverviewGroups(lead);
  assert.deepEqual(g.map((x) => x.title), ['פרטי קשר', 'סטטוס', 'פגישה', 'הערות']);
  assert.deepEqual(g[0].rows, [['טלפון', '0501234567'], ['איש קשר', 'פלוני (מטופל)']]);
  assert.deepEqual(g[1].rows.map((r) => r[0]), ['שלב', 'בית', 'אחראי', 'מקור', 'נוצר']);
  assert.deepEqual(g[1].rows[4], ['נוצר', '18/11/2026']);
  assert.deepEqual(g[2].rows, [['פגישה', 'לא נקבעה'], ['פגישה מיועדת עם', 'רנטה']], 'a chosen manager no longer reads as a meeting that took place');
  assert.deepEqual(g[3].rows, [['הערות', 'הערה']]);
  const set = core.leadOverviewGroups(Object.assign({}, lead, { visitDate: '2026-11-25', visitTime: '10:30' }));
  assert.deepEqual(set[2].rows[0], ['פגישה', '25/11/2026 10:30']);
  const held = core.leadOverviewGroups(Object.assign({}, lead, { visitDate: '2026-11-25', meetingOutcome: 'entered' }));
  assert.deepEqual(held[2].rows.map((r) => r[0]), ['פגישה', 'נפגש/ת עם', 'תוצאת פגישה']);
  assert.deepEqual(core.leadOverviewGroups({ id: 'L2', phone: '050', stage: 'new' }).map((x) => x.title), ['פרטי קשר', 'סטטוס', 'פגישה'], 'no notes group without a note');
  assert.deepEqual(core.leadOverviewGroups(null), [{ title: 'פגישה', rows: [['פגישה', 'לא נקבעה']] }], 'a missing lead never throws');
});

/* ---------------- client: the markup ---------------- */

test('the card: «מה הלאה» first, then the details, the documented calls, the actions — every value escaped; ONE «תיעוד שיחה» button, hidden from the controller view', () => {
  const overview = SRC.slice(SRC.indexOf("'<section data-pane=\"overview\">"), SRC.indexOf("'<section data-pane=\"tasks\""));
  const order = ['renderNextSteps(subject)', 'leadOverviewGroups(lead)', 'id="crm-recent"', 'renderLeadActions(lead)'].map((k) => overview.indexOf(k));
  assert.ok(order.every((i) => i > 0) && order.join() === order.slice().sort((a, b) => a - b).join(), 'next steps → details → calls → actions');
  assert.match(overview, /state\.me\.view === 'controller' \? '' : renderNextSteps\(subject\)/);
  assert.match(overview, /'<dt class="kv-h">' \+ esc\(g\.title\)/);
  assert.match(overview, /'<dt>' \+ esc\(x\[0\]\) \+ '<\/dt><dd>' \+ esc\(x\[1\]\) \+ '<\/dd>'/);
  assert.match(overview, /state\.me\.view === 'controller' \? '' : '<div class="group-title">שיחות אחרונות/, 'the controller view (money-only activity) gets no contact block');
  assert.match(SRC, /state\.me\.view === 'controller' \? '' : '<button type="button" class="btn small primary" data-contact-open="' \+ esc\(kind \+ ':' \+ id\) \+ '">📞 תיעוד שיחה<\/button>'\) \+ '<button type="button" class="btn small" id="crm-drawer-close"/, 'one button; the kind is chosen inside');
  const steps = SRC.slice(SRC.indexOf('function renderNextSteps(subject)'), SRC.indexOf('/* «שיחות אחרונות» on the overview'));
  for (const f of ['x.title', 'x.when', 'x.assignee', 'x.reason', 'x.id']) assert.ok(steps.includes('esc(' + f + ')'), f + ' is escaped');
  assert.match(SRC, /function boardNextStep\(l\) \{[\s\S]{0,260}esc\(x\.title\)[\s\S]{0,80}esc\(x\.rel\)/, 'the board card shows its most urgent follow-up, escaped');
});

test('the panel: three kinds to choose from, none pre-chosen unless it closes a call TASK (then «שיחה יוצאת»); the outcome list follows the kind; «קשר הבא» still has no pre-checked radio', () => {
  assert.match(SRC, /<legend>סוג התיעוד \*<\/legend>/);
  assert.match(SRC, /name="direction" value="' \+ d\.id \+ '"' \+ \(d\.id === dir \? ' checked' : ''\)/);
  assert.match(SRC, /const dir = CONTACT_DIRECTIONS\.some\(function \(d\) \{ return d\.id === direction; \}\) \? direction : \(task \? 'out' : ''\);/);
  assert.deepEqual(core.CONTACT_DIR_TEXT.withWhom, { out: 'עם מי', in: 'מי התקשר/ה', note: 'עם מי' });
  assert.deepEqual(core.CONTACT_DIR_TEXT.who, { out: 'מי ביצע', in: 'מי קיבל/ה את השיחה', note: 'מי תיעד/ה' });
  assert.match(SRC, /if \(f && ev\.target\.name === 'direction'\) applyContactDirection\(f\);/);
  assert.match(SRC, /sel\.innerHTML = contactOutcomeOptions\(dir, sel\.value\)/);
  assert.match(SRC, /contactOutcomesFor\(dir\)\.map\(function \(o\) \{ return '<option value="' \+ o\.id \+ '"'[^;]*esc\(o\.label\)/, 'option labels escaped');
  assert.ok(!/name="next"[^>]*checked/.test(SRC), 'no «קשר הבא» radio is pre-checked in the markup (spec §8)');
  assert.match(SRC, /ev\.target\.value === NO_FOLLOW_UP_OUTCOME && f\.elements\.next\) f\.elements\.next\.value = 'none'/, 'choosing «לא נדרש המשך» answers «קשר הבא»');
  assert.match(SRC, /state\.drawer = \{ kind: back\.kind, id: back\.id, tab: 'overview' \}/, 'after a save the card returns to the overview: the record and «מה הלאה» are both there');
  assert.match(SRC, /toast\('השיחה נשמרה ✓' \+ \(res\.created \? ' · המשך: ' \+ s\(res\.created\.title\) \+ ' — ' \+ taskWhen\(res\.created\) : ''\)\)/, 'the confirmation says WHAT is next and WHEN');
});

test('«ביטול תיעוד»: offered only on a real contact id, asks for a reason, says when a follow-up will be cancelled with it; the timelines keep a voided record, marked «בוטל»', () => {
  const recent = SRC.slice(SRC.indexOf('function renderRecentContacts(r)'), SRC.indexOf('function submitVoidContact(f)'));
  assert.match(recent, /const canVoid = CONTACT_EVENT_ID_RE\.test\(x\.eventId\) && !!\(state\.me && state\.me\.deleter === true\);/, 'the button only for a deleter — and only on a real contact id');
  assert.match(recent, /data-contact-void="' \+ esc\(x\.eventId\) \+ '">ביטול תיעוד<\/button>/);
  assert.match(recent, /data-form="contact-void" data-event="' \+ esc\(x\.eventId\)/);
  assert.match(recent, /תבוטל יחד איתו/);
  assert.match(recent, /esc\(next\.title\)/);
  assert.match(SRC, /\} else if \(f\.dataset\.form === 'contact-void'\) \{\s*submitVoidContact\(f\);/);
  assert.match(SRC, /state\.voiding = t\.dataset\.contactVoid && CONTACT_EVENT_ID_RE\.test\(t\.dataset\.contactVoid\) \? t\.dataset\.contactVoid : '';/);
  const line = SRC.slice(SRC.indexOf('function timelineItem(e, voided, withSource)'), SRC.indexOf('function contactChip(dir)'));
  assert.match(line, /chip\('late', 'בוטל'\)/);
  assert.match(line, /esc\(isContact \? contactEventText\(e\) : \(e\.summary \|\| e\.kind\)\)/);
  assert.equal((SRC.match(/timelineItem\(e, voided, (true|false)\)/g) || []).length, 2, 'both timelines (the «פעילות» tab and the panel history) use it');
  assert.match(CSS, /\.tl li\.voided > div:last-child \{ text-decoration: line-through;/);
});

test('«היום» is the team\'s page, not one person\'s: the area, the page title and the mail section say «היום»; the page head says «כל הצוות», never the signed-in name', () => {
  assert.match(SRC, /\{ id: 'today', label: 'היום' \}/);
  assert.match(HTML, /<h1 id="crm-title">היום<\/h1>/);
  assert.match(SRC, /let html = '<div class="day-head"><div class="day-date">כל הצוות<\/div>'/);
  const day = SRC.slice(SRC.indexOf('function renderMyDay(c)'), SRC.indexOf('// summary strip'));
  assert.ok(!/state\.me\.user/.test(day.slice(0, day.indexOf('<div class="toolbar filters">'))), 'the head does not print who is signed in');
  assert.match(day, /<option value="">כל האחראים<\/option>/, 'every owner by default; the «אחראי» filter narrows it');
  const strings = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/היום שלי/.test(strings(SRC)) && !/היום שלי/.test(HTML), 'no «היום שלי» left in what the user sees');
  for (const f of ['lib/billing-reminder-mail.js', 'apps-script/BillingReminderCore.gs']) {
    const src = strings(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    assert.ok(!/היום שלי/.test(src), f);
    assert.match(src, /heading: 'היום — שיחות, מעקבים ופגישות'/, f);
  }
});

test('in-card jumps: only known tabs can be opened by data-tab-go; the meetings pane offers «תיאום פגישה» on a lead card only and labels the manager by the held-meeting rule', () => {
  assert.match(SRC, /const TAB_GO_ALLOWED = \['overview', 'tasks', 'activity', 'meetings'\];/);
  assert.match(SRC, /TAB_GO_ALLOWED\.indexOf\(want\) >= 0 \? doc\.querySelector/);
  assert.match(SRC, /if \(canSchedule\) html \+= '<p><button type="button" class="btn small primary" data-meeting-go>'/);
  assert.match(SRC, /renderMeetings\(meetingsFor\([^;]*\), !!lead && !\(state\.me && state\.me\.view === 'controller'\)\)/);
  assert.match(SRC, /esc\(meetingWithLabel\(\{ meetingOutcome: m\.visit\.outcome \}\)\)/);
  assert.match(CSS, /\.kv dt\.kv-h \{[^}]*grid-column: 1 \/ -1/);
  assert.match(CSS, /\.next-steps\.late \{ border-inline-start-color: var\(--bad\); \}/);
});
