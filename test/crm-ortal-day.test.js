'use strict';

/* CRM Stage 2b — verification states on Vered's day; Ortal's day (CHANGELOG-crm-ortal-day.md; spec §5–§6). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/crm/crm.js');

const TODAY = '2026-10-28';
const PAYMENTS = { ok: true, payments: [], receipts: [
  { id: 'r1', patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', amount: 2500, receivedDate: '2026-10-27', method: 'העברה', confirmStatus: 'reported', status: 'receipt' },
  { id: 'r2', patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', amount: 900, receivedDate: '2026-10-20', confirmStatus: 'flagged', flagNote: 'לא תואם', status: 'receipt' },
  { id: 'r3', patientUid: 'p2', patientName: 'אבי', houseId: 'rehab', amount: 6000, receivedDate: '2026-10-10', confirmStatus: 'confirmed', status: 'receipt' },
  { id: 'r4', patientUid: 'p2', patientName: 'אבי', houseId: 'rehab', amount: 100, receivedDate: '2026-10-10', confirmStatus: 'reported', status: 'void' }] };
const QUEUE = { ok: true, receipts: [
  { id: 'r1', confirmStatus: 'reported', patientName: 'דנה כהן', houseId: 'ramot', amount: 2500, receivedDate: '2026-10-27', recordedBy: 'ורד', method: 'העברה' },
  { id: 'r5', confirmStatus: 'reported', patientName: 'גל', houseId: 'asher', amount: 1200, receivedDate: '2026-10-20', recordedBy: 'דנה' },
  { id: 'r2', confirmStatus: 'flagged', patientName: 'דנה כהן', houseId: 'ramot', amount: 900, receivedDate: '2026-10-20', flagNote: 'לא תואם' },
  { id: 'r6', confirmStatus: 'partial', patientName: 'נוי', houseId: 'pardes', amount: 3000, receivedDate: '2026-10-22' },
  { id: 'r3', confirmStatus: 'confirmed', patientName: 'אבי', houseId: 'rehab', amount: 6000, receivedDate: '2026-10-10', invoiceWanted: 'yes', invoiceTo: 'משרד הביטחון' },
  { id: 'r7', confirmStatus: 'confirmed', patientName: 'ישן', houseId: 'rehab', amount: 6000, receivedDate: '2026-07-10', invoiceWanted: 'yes' },
  { id: 'r8', confirmStatus: 'confirmed', patientName: 'בלי', houseId: 'rehab', amount: 6000, receivedDate: '2026-10-10', invoiceWanted: 'no' }] };
const TASKS = [{ id: 'task-' + '1'.repeat(32), kind: 'collection', patientId: 'p1', title: 'שיחת גבייה', dueDate: '2026-10-26', status: 'open', assignee: 'אורטל' }];
const CREDITS = { ok: true, credits: [{ id: 'cr-1', patientId: 'p1', patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused', allocationMonth: '2026-09', amount: 1200, status: 'pending', payoutDate: '2026-10-25' },
  { id: 'cr-2', patientId: 'p2', patientName: 'אבי', houseId: 'rehab', creditType: 'other', allocationMonth: '2026-09', amount: 300, status: 'paid' }] };

test('verificationRows (Vered): reported → waiting on Ortal (owner shown, never her task); flagged / partial → exception; confirmed and void receipts are not rows; «דווח» ≠ «אומת»', () => {
  const rows = core.verificationRows(PAYMENTS, TODAY);
  assert.deepEqual(rows.map((r) => [r.kind, r.waitingOn || '', r.priority, r.owner]), [['receipt_reported', 'אורטל', 'wait', 'אורטל'], ['receipt_flagged', '', 'exception', 'אורטל']]);
  assert.match(rows[0].action, /דווח — ממתין לאימות — ₪2,500/); assert.match(rows[1].why, /לא תואם/);
  assert.equal(rows[0].subjectId, 'p1'); assert.equal(rows[0].open, 'account');
  const c = core.compute({ ok: true, leads: [], patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: '2026-07-01', status: 'active' }] }, irrelevantLeads: [], removedLeads: [], dischargedPatients: [] }, TODAY);
  const m = core.myDay(c, [], { ok: true, leads: {}, patients: {} }, { ok: true, byPatient: [] }, TODAY, { view: 'full', finance: true }, {}, PAYMENTS);
  assert.deepEqual(m.byDomain.collection.map((r) => r.kind), ['receipt_flagged', 'receipt_reported']);
  assert.match(m.cards[0].hint, /1 ממתינים לאימות אורטל/);
  assert.deepEqual(m.waiting.map((r) => r.waitingOn), ['אורטל']);
  assert.match(core.myDay(c, [], null, { ok: true, byPatient: [] }, TODAY, { view: 'full', finance: true }, {}, undefined).cards[0].hint, /אימותים: טוען…/);
  assert.match(core.myDay(c, [], null, { ok: true, byPatient: [] }, TODAY, { view: 'full', finance: true }, {}, null).cards[0].hint, /אימותים: המידע אינו זמין/);
  assert.equal(core.myDay(c, [], null, null, TODAY, { view: 'ops', finance: false }, {}, PAYMENTS).byDomain.collection.length, 0, 'Dana: never');
});

test('ortalDay: five cards (verification / gaps / documents / control); reported older than 3 days is late; flagged + partial are exceptions; requested invoices on verified receipts of the last 60 days — issuance not claimed; her money tasks; pending credits by payout date; loading vs failed', () => {
  const o = core.ortalDay(QUEUE, TASKS, CREDITS, TODAY, {});
  assert.deepEqual(o.cards.map((k) => [k.label, k.value]), [['דיווחים לאימות', 2], ['אימותים חלקיים / לבירור', 2], ['חשבוניות מבוקשות', 1], ['משימות כספיות שלך', 1], ['זיכויים לתשלום', 1]]);
  assert.match(o.cards[0].hint, /1 מעל 3 ימים/); assert.match(o.cards[2].hint, /ההנפקה אינה נרשמת כאן/); assert.match(o.cards[4].hint, /1 אחרי מועד התשלום/);
  assert.deepEqual(o.sets.toVerify.map((r) => [r.name, r.state]), [['גל', 'late'], ['דנה כהן', 'today']]);
  assert.deepEqual(o.sets.flagged.map((r) => r.action), ['סומן לבירור — ₪900', 'אומת חלקית — ₪3,000']);
  assert.deepEqual(o.sets.documents.map((r) => r.name), ['אבי']); assert.match(o.sets.documents[0].why, /חשבונית מבוקשת למשרד הביטחון/);
  assert.equal(o.sets.tasks[0].task.id, TASKS[0].id); assert.equal(o.sets.tasks[0].state, 'late');
  assert.deepEqual(o.sets.credits.map((r) => [r.name, r.state]), [['דנה כהן', 'late']]);
  assert.deepEqual(o.urgent.map((r) => r.kind).sort(), ['credit', 'flagged', 'flagged', 'task', 'to_verify']);
  assert.ok(o.urgent.every((r) => r.priority === 'exception' || r.state === 'late'));
  assert.ok(o.sets.toVerify.every((r) => r.classic === true), 'her decisions happen in the classic בקרת גבייה');
  // filters by house
  assert.deepEqual(core.ortalDay(QUEUE, TASKS, CREDITS, TODAY, { house: 'asher' }).sets.toVerify.map((r) => r.name), ['גל']);
  // loading / failed
  const l = core.ortalDay(undefined, undefined, undefined, TODAY, {});
  assert.deepEqual(l.cards.map((k) => [k.value, k.hint]), [[null, 'טוען…'], [null, 'טוען…'], [null, 'טוען…'], [null, 'טוען…'], [null, 'טוען…']]);
  const f = core.ortalDay({ ok: false, error: 'x' }, null, null, TODAY, {});
  assert.deepEqual(f.cards.map((k) => k.hint), ['המידע אינו זמין', 'המידע אינו זמין', 'המידע אינו זמין', 'המידע אינו זמין', 'המידע אינו זמין']);
  assert.ok(!JSON.stringify(f).includes('"value":0'), 'never 0 for a failed source');
});
