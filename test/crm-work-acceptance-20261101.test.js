'use strict';

/**
 * Independent Work business acceptance A02/A05-A08/A14-A16/A19.
 * Vered Today on the active code baseline ae9bfd1, all fixtures synthetic.
 * Does not read/write live Sheets, invoke production endpoints or change data.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CRM = require('../public/crm/crm.js');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-01';
const VERED = { view: 'full', finance: true, user: 'ורד' };
const DANA = { view: 'ops', finance: false, user: 'דנה' };
const INDEX = { ok: true, leads: {}, patients: {} };
const DEBT = { ok: true, byPatient: [] };
const PAYMENTS = { ok: true, payments: [], receipts: [] };
const sheet = (overrides) => Object.assign({
  ok: true, leads: [], patients: {}, dischargedPatients: [],
  irrelevantLeads: [], removedLeads: []
}, overrides || {});
const model = (c, tasks = [], index = INDEX, debt = DEBT, payments = PAYMENTS, role = VERED, filters = {}) =>
  CRM.myDay(c, tasks, index, debt, TODAY, role, filters, payments);
const card = (m, id) => m.cards.find((x) => x.id === id);

test('A14/A15: blank and literal unknown continuity remain open past the 14-day lookback; a proven none or continued outcome closes the exception', () => {
  const discharged = (id, exit, continuity) => ({
    id, patientId: 'patient-' + id, name: 'משוחרר ' + id,
    houseId: 'ramot', exitDate: exit, continuity
  });
  const c = CRM.compute(sheet({ dischargedPatients: [
    discharged('day14', '2026-10-18', ''),
    discharged('day15', '2026-10-17', ''),
    discharged('unknown', '2026-10-31', 'unknown'),
    discharged('not-continued', '2026-10-15', 'none'),
    discharged('other', '2026-10-12', 'continued_other'),
    Object.assign(discharged('restored', '2026-09-01', 'unknown'), { restored: 'TRUE' })
  ] }), TODAY);
  const r = CRM.houseExceptions(c, TODAY).filter((x) => x.kind === 'continuity');
  assert.deepEqual(r.map((x) => x.id), ['ex:cont:day14', 'ex:cont:day15', 'ex:cont:unknown']);
  assert.ok(r.every((x) => x.owner === 'ורד'), 'the accountable follow-up owner must be visible');
  assert.equal(new Set(r.map((x) => x.id)).size, r.length);
  assert.ok(r.every((x) => x.subjectKind === 'patient'), 'original patient IDs preserved');
});

test('A02/A03: current selected Sunday-Saturday week includes future appointments at their actual day/time, once, and works for the next week', () => {
  const c = CRM.compute(sheet({ leads: [
    { id: 'now', name: 'היום', house: 'ramot', stage: 'visit', assignedTo: 'ורד', meetingWith: 'ורד', visitDate: '2026-11-01', visitTime: '09:15' },
    { id: 'future', name: 'שלישי', house: 'ramot', stage: 'visit', assignedTo: 'ורד', meetingWith: 'ורד', visitDate: '2026-11-03', visitTime: '14:30' },
    { id: 'next', name: 'שבוע הבא', house: 'rehab', stage: 'visit', assignedTo: 'ורד', meetingWith: 'ורד', visitDate: '2026-11-09', visitTime: '11:00' }
  ] }), TODAY);
  const m = model(c);
  assert.equal(m.meetingsToday.length, 1);
  const w = CRM.weekPlan(m, '2026-11-01', c, {}, TODAY);
  assert.equal(w.days[2].date, '2026-11-03');
  assert.equal(w.days[2].rows.filter((x) => x.subjectId === 'future' && x.kind === 'meeting_week').length, 1);
  assert.ok(w.days[2].rows.some((x) => x.action.includes('14:30')));
  assert.equal(w.days[0].rows.filter((x) => x.subjectId === 'now' && /^meeting_/.test(x.kind)).length, 1, 'today meeting is not duplicated');
  const next = CRM.weekPlan(m, '2026-11-08', c, {}, TODAY);
  assert.equal(next.days[1].rows.filter((x) => x.subjectId === 'next').length, 1);
  const scoped = CRM.weekPlan(m, '2026-11-01', c, { house: 'rehab' }, TODAY);
  assert.equal(scoped.days[2].rows.some((x) => x.subjectId === 'future'), false);
});

test('A05: missing contact history never means no contact, and last-contact text does not claim none', () => {
  const c = CRM.compute(sheet({ leads: [
    { id: 'L1', name: 'חדש', house: 'ramot', stage: 'new', created: '2026-10-31' },
    { id: 'L2', name: 'פגישה', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '10:00' }
  ] }), TODAY);
  assert.equal(model(c).byDomain.newleads.length, 1, 'healthy sources still show an untouched lead');
  const missing = model(c, [], null);
  assert.equal(card(missing, 'newleads').value, null);
  assert.equal(missing.byDomain.newleads.length, 0, 'no false uncontacted lead');
  assert.ok(missing.meetingsToday.every((x) => /אינו זמין/.test(x.lastContact)));
  assert.deepEqual(CRM.newLeadsNoContact(c.leads, [], null, TODAY), []);
  assert.deepEqual(CRM.triageQueue(c, [], null, TODAY), []);
});

test('A06-A08: collection count is unavailable/partial if any required source is missing; known individual rows can survive', () => {
  const c = CRM.compute(sheet(), TODAY);
  assert.equal(card(model(c), 'collection').value, 0, 'complete reliable sources: real zero');
  const variants = [
    model(c, [], INDEX, null, PAYMENTS),
    model(c, [], INDEX, false, PAYMENTS),
    model(c, null, INDEX, DEBT, PAYMENTS),
    CRM.myDay(c, undefined, INDEX, DEBT, TODAY, VERED, {}, PAYMENTS),
    model(c, [], INDEX, DEBT, null),
    CRM.myDay(c, [], INDEX, DEBT, TODAY, VERED, {}, undefined)
  ];
  for (const m of variants) {
    assert.equal(card(m, 'collection').value, null, 'no fake full count of zero when data missing');
    assert.match(card(m, 'collection').hint, /חלקי|טוען/);
  }
  const hasDebt = { ok: true, byPatient: [{ patientId: 'P1', name: 'שם בדיקה', houseId: 'ramot',
    cycles: [{ balance: 100, expected: 100, received: 0, kind: 'recorded', start: '2026-10-01', end: '2026-10-30' }] }] };
  const partial = model(c, [], INDEX, hasDebt, null);
  assert.equal(partial.byDomain.collection.filter((x) => x.kind === 'debt_recorded').length, 1, 'a verified individual debt remains accessible');
  assert.equal(card(partial, 'collection').value, null, 'verified debt is not the complete work count');
  assert.equal(model(c, [], INDEX, DEBT, PAYMENTS, DANA).byDomain.collection.length, 0);
  assert.equal(model(c, [], INDEX, DEBT, PAYMENTS, DANA).cards.some((x) => x.id === 'collection'), false);
});

test('A16: flagged / partial receipts need Vered family clarification, while reported awaits Ortal verification', () => {
  const receipts = { ok: true, receipts: [
    { id: 'reported', patientUid: 'P1', patientName: 'משפחת דמה', houseId: 'ramot', receivedDate: TODAY, amount: 700, confirmStatus: 'reported', status: 'receipt' },
    { id: 'flagged', patientUid: 'P1', patientName: 'משפחת דמה', houseId: 'ramot', receivedDate: TODAY, amount: 100, confirmStatus: 'flagged', status: 'receipt', flagNote: 'נדרש בירור' },
    { id: 'partial', patientUid: 'P1', patientName: 'משפחת דמה', houseId: 'ramot', receivedDate: TODAY, amount: 200, confirmStatus: 'partial', status: 'receipt' }
  ] };
  const rows = CRM.verificationRows(receipts, TODAY);
  assert.deepEqual(rows.map((x) => [x.id, x.owner, x.waitingOn || '']), [
    ['v:reported', 'אורטל', 'אורטל'], ['v:flagged', 'ורד', ''], ['v:partial', 'ורד', ''] ]);
  const c = CRM.compute(sheet({ patients: { ramot: [{ id: 'P1', name: 'משפחת דמה', status: 'active' }] } }), TODAY);
  const m = model(c, [], INDEX, DEBT, receipts, VERED, { owner: 'ורד' });
  assert.deepEqual(m.byDomain.collection.map((r) => r.id).sort(), ['v:flagged', 'v:partial']);
  const pending = model(c, [], INDEX, DEBT, receipts, VERED, { owner: 'אורטל' });
  assert.deepEqual(pending.byDomain.collection.map((r) => r.id), ['v:reported']);
  assert.equal(model(c, [], INDEX, DEBT, receipts, DANA).byDomain.collection.length, 0);
});

test('A19: side waiting link uses the authoritative subjectKind and account tab for receipts, lead/meetings for manager', () => {
  const from = SOURCE.indexOf('ממתין לגורם אחר <span');
  assert.ok(from > 0, 'waiting side block still present');
  const snippet = SOURCE.slice(from, from + 850);
  assert.ok(snippet.includes("data-open-' + esc(r.subjectKind)"), 'must not hard-code data-open-lead');
  assert.ok(snippet.includes("r.open ? ' data-open-tab="), 'the row decides account vs meetings');
  const receipt = CRM.verificationRows({ ok: true, receipts: [
    { id: 'r', patientUid: 'P1', patientName: 'דמה', houseId: 'ramot', amount: 1, receivedDate: TODAY, confirmStatus: 'reported', status: 'receipt' }
  ] }, TODAY)[0];
  assert.deepEqual([receipt.subjectKind, receipt.subjectId, receipt.open], ['patient', 'P1', 'account']);
  const c = CRM.compute(sheet({ leads: [{ id: 'L', name: 'פגישה', house: 'ramot', stage: 'visit', visitDate: '2026-10-31', meetingWith: 'אורן' }] }), TODAY);
  const row = model(c).waiting.find((r) => r.subjectId === 'L');
  assert.ok(row && row.subjectKind === 'lead' && row.open === 'meetings');
});
