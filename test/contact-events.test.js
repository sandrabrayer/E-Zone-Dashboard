'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDesk, PROXY, TOKEN, PHONE, REF, AT } = require('./helpers/contact-fixture');
const other = (n) => n.toString(16).padStart(32, '0');
const after = (n) => new Date(new Date(AT).getTime() + n * 1000).toISOString();

test('only a dedicated JSON POST can ingest; queries, proxy credentials and direct desk calls write nothing', () => {
  const { g, receive, staff } = makeDesk();
  const action = 'ingestCommunicationEvent';
  assert.equal(g.sandbox.doGet({ parameter: { action, ingestToken: TOKEN } }).json.error, 'unauthorized');
  assert.equal(g.postQ({ action }, { ingestToken: TOKEN }).error, 'unauthorized');
  assert.equal(g.post({ action, proxySecret: PROXY }).error, 'unauthorized');
  assert.equal(g.postQ({}, { action, ingestToken: TOKEN }).error, 'unauthorized');
  assert.equal(g.post({ action: 'getCommunicationReview', __actor: { verified: true } }).error, 'unauthorized');
  assert.equal(g.postQ({ action: 'getCommunicationReview' }, { proxySecret: PROXY }).error, 'unauthorized');
  for (const id of ['shiran', 'ortal', 'unknown']) assert.equal(staff('getCommunicationReview', {}, id).ok, false);
  assert.equal(staff('getCommunicationReview', { proxyAuth: 'shared' }).ok, false);
  assert.equal(receive({ businessNumber: '0500000088' }).error, 'wrong_line');
  assert.equal(receive({ channel: 'whatsapp', connection: 'web' }).error, 'wrong_connection');
  assert.equal(receive({ channel: 'phone', connection: 'mobile' }).error, 'wrong_connection');
  g.sandbox.__props.CONTACT_EVENT_BUSINESS_NUMBER = ''; assert.equal(receive().error, 'wrong_line');
  g.sandbox.__props.CONTACT_EVENT_INGEST_TOKEN = ''; assert.equal(receive().error, 'unauthorized');
  assert.deepEqual(Object.keys(g.sandbox.__sheets), []);
});

test('whole call only; first missed call waits for review, one callback and one timeline entry on replay', () => {
  const d = makeDesk(); d.addLead({ assignedTo: 'שירן', phone: 500000001 });
  assert.equal(d.receive({ scope: 'leg' }).ignored, true);
  assert.equal(d.receive({ final: false }).ignored, true);
  assert.equal(d.receive({ status: 'ringing' }).ok, true);
  assert.equal(d.receive().ok, true); assert.equal(d.receive().ok, true);
  const q = d.staff('getCommunicationReview'); assert.equal(q.total, 1); assert.deepEqual(q.events[0].suggestions, ['test-card-a']);
  assert.equal(d.tasks().length, 0);
  assert.equal(d.link({ verifiedContact: false }).error, 'bad_review');
  assert.equal(d.link({ remember: true }).ok, true); assert.equal(d.receive().ok, true);
  assert.equal(d.link().ok, true); assert.equal(d.tasks().length, 1); assert.equal(d.tasks()[0].assignee, 'ורד');
  assert.equal(d.tasks()[0].id, 'task-' + REF + '-pbx'); assert.equal(d.staff('getCommunicationReview').total, 0);
  const activity = d.staff('getActivity', { leadId: 'test-card-a' });
  assert.equal(activity.events.length, 1); assert.match(activity.events[0].summary, /מרכזייה.*לא נענתה/);
  assert.ok(!JSON.stringify(activity).includes('500000001'));
  assert.equal(d.staff('getActivity', { leadId: 'test-card-a' }, 'ortal').events?.length || 0, 0);
});

test('an answer beats a final miss, even out of order; a staff-touched task survives correction', () => {
  const d = makeDesk(); d.addLead(); d.receive(); d.link({ remember: true });
  d.receive({ status: 'answered', observedAt: after(4), agentKey: 'vered' });
  d.receive({ observedAt: after(9) }); assert.equal(d.rows()[0].status, 'answered');
  assert.equal(d.tasks()[0].status, 'cancelled'); assert.equal(d.tasks().length, 1);
  d.receive({ objectRef: other(2) }); const t = d.tasks().find((r) => r.status === 'open');
  assert.ok(t);
  d.staff('rescheduleTask', { id: t.id, dueDate: '2030-06-01' });
  assert.notEqual(d.tasks()[1].updatedBy, 'מרכזייה');
  d.receive({ objectRef: other(2), status: 'answered' }); assert.equal(d.tasks()[1].status, 'open');
  d.receive({ objectRef: other(3), status: 'answered' }); d.receive({ objectRef: other(3) });
  assert.equal(d.tasks().length, 2);
  d.receive({ objectRef: other(4), direction: 'out' }); assert.equal(d.tasks().length, 2);
});

test('known verified number can link future private messages; deliveries, files and drafts are distinct', () => {
  const d = makeDesk(); d.addLead(); d.receive(); d.link({ remember: true });
  const wa = { objectRef: other(7), channel: 'whatsapp', scope: 'direct', direction: 'out', status: 'sent' };
  assert.equal(d.receive({ ...wa, scope: 'group' }).ignored, true);
  assert.equal(d.receive({ ...wa, status: 'draft' }).ignored, true);
  assert.equal(d.receive({ ...wa, status: 'received' }).error, 'bad_event');
  assert.equal(d.receive({ ...wa, status: 'read', attachment: true, observedAt: after(12), text: 'PRIVATE_TEST', url: 'PRIVATE_TEST' }).ok, true);
  d.receive({ ...wa, status: 'delivered', observedAt: after(3) }); d.receive(wa);
  assert.equal(d.receive({ ...wa, direction: 'in', status: 'received' }).error, 'identity_conflict');
  assert.equal(d.receive({ ...wa, phone: '0500000006' }).error, 'identity_conflict');
  d.receive({ ...wa, direction: 'in', status: 'received', objectRef: other(8) });
  assert.equal(d.rows().length, 3);
  const events = d.staff('getActivity', { leadId: 'test-card-a' }).events;
  assert.equal(events.length, 3); assert.ok(events.some((r) => /נקראה.*קובץ מצורף/.test(r.summary)));
  assert.ok(!JSON.stringify(d.rows()).includes('PRIVATE_TEST')); assert.ok(!JSON.stringify(d.g.logs).includes(PHONE));
});

test('shared, hidden, historical, billing-only, reassigned and earlier numbers require a person', () => {
  const d = makeDesk(); d.addLead(); d.receive(); d.link({ remember: true });
  d.receive({ objectRef: other(10), phone: '' }); d.receive({ objectRef: other(11), occurredAt: '2020-01-01T00:00:00Z' });
  d.addLead({ id: 'b', phone: '0500000002', billingPhone: PHONE });
  d.receive({ objectRef: other(12) }); assert.equal(d.link({ id: 'phone-' + other(12), remember: true }).error, 'phone_not_unique');
  d.addLead({ id: 'closed', phone: '0500000002' }, 'לידים לא רלוונטיים');
  d.receive({ objectRef: other(13), phone: '0500000002' });
  assert.equal(d.link({ id: 'phone-' + other(13), leadId: 'b', remember: true }).error, 'phone_not_unique');
  assert.equal(d.link({ id: 'phone-' + other(13), leadId: 'b' }).ok, true);
  d.addLead({ id: 'c', phone: '', billingPhone: '0500000003' }); d.receive({ objectRef: other(14), phone: '0500000003' });
  assert.equal(d.link({ id: 'phone-' + other(14), leadId: 'c', remember: true }).error, 'phone_not_unique');
  assert.equal(d.staff('getCommunicationReview').total, 4);
  const d2 = makeDesk(); d2.addLead(); d2.receive(); d2.link({ remember: true });
  d2.g.sandbox.__sheets.Leads.grid[1][2] = '0500000006'; d2.addLead({ id: 'replacement', phone: PHONE });
  d2.receive({ objectRef: other(15) }); assert.equal(d2.staff('getCommunicationReview').total, 1);
});

test('two simultaneous desk decisions cannot overwrite each other; retries repair partial writes', () => {
  const d = makeDesk(); d.addLead(); d.receive();
  const original = d.g.sandbox.taskWriteRow_; let first = true;
  d.g.sandbox.taskWriteRow_ = (...args) => { if (first) { first = false; throw Error('simulated write interruption'); } return original(...args); };
  assert.equal(d.link().ok, false); assert.equal(d.rows()[0].resolution, 'linked');
  assert.equal(d.receive().ok, true); assert.equal(d.tasks().length, 1);
  assert.equal(d.link({ decision: 'dismiss' }).error, 'already_resolved'); assert.equal(d.link().ok, true);
  d.receive({ objectRef: other(3), phone: '' }); assert.equal(d.link({ id: 'phone-' + other(3), decision: 'dismiss' }).ok, true);
  assert.equal(d.link({ id: 'phone-' + other(3) }).error, 'already_resolved');
  assert.equal(d.tasks().length, 1);
  d.g.sandbox.LockService.getScriptLock = () => ({ tryLock: () => false });
  assert.equal(d.receive({ objectRef: other(4) }).error, 'busy');
  assert.equal(d.rows().length, 2);
});

test('local callback date is Israel time and provider facts cannot choose a card, assignee or free text', () => {
  const d = makeDesk(); d.addLead({ assignedTo: 'דנה' });
  assert.equal(d.receive({ phone: '12 ext 3' }).error, 'bad_event');
  assert.equal(d.receive({ occurredAt: '2026-02-30T00:00:00Z' }).error, 'bad_event');
  d.receive({ occurredAt: '2026-11-20T22:05:00Z', observedAt: '2026-11-20T22:06:00Z', agentKey: '=PRIVATE_TEST', leadId: 'x', assignee: 'x', body: 'PRIVATE_TEST' });
  assert.equal(d.tasks().length, 0); d.link(); assert.equal(d.tasks()[0].dueDate, '2026-11-21');
  assert.equal(d.tasks()[0].assignee, 'דנה'); assert.ok(!JSON.stringify(d.rows()).includes('PRIVATE_TEST'));
});

test('a verified person can revoke future matching, keeping history and refusing the wrong card', () => {
  const d = makeDesk(); d.addLead(); d.receive(); d.link({ remember: true });
  d.receive({ objectRef: other(40), status: 'answered' });
  assert.equal(d.rows()[1].grantId, 'phone-' + REF);
  const endpoint = 'resolveCommunicationEvent', request = { decision: 'forget', id: 'phone-' + REF, leadId: 'test-card-a' };
  assert.equal(d.staff(endpoint, { ...request, leadId: 'wrong-card' }).ok, false);
  assert.equal(d.staff(endpoint, request, 'ortal').ok, false);
  assert.equal(d.staff(endpoint, request, 'dana').ok, true); assert.equal(d.staff(endpoint, request, 'dana').ok, true);
  assert.equal(d.rows()[0].forgottenBy, 'dana'); assert.equal(d.staff('getActivity', { leadId: 'test-card-a' }).total, 2);
  d.receive({ objectRef: other(41) }); assert.equal(d.staff('getCommunicationReview').total, 1);
  assert.equal(d.tasks().length, 1);
});

test('a number also stored for a resident, or a legacy closed stage, cannot become a reusable grant', () => {
  const d = makeDesk(); d.addLead(); d.receive();
  d.g.run("getOrCreateSheet_(PATIENT_PHONES_SHEET,PATIENT_PHONES_COLUMNS).appendRow(['בדיקה','','0500000001','','patient-test'])");
  assert.equal(d.staff('getCommunicationReview').events[0].rememberLead, '');
  assert.equal(d.link({ remember: true }).error, 'phone_not_unique');
  d.g.sandbox.__sheets.Leads.grid[1][6] = 'נקלט'; assert.equal(d.link().error, 'closed_or_unknown_lead');
});
