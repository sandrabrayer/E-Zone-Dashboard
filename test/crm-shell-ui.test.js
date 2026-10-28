'use strict';

/* C2 — CRM shell pure core (CHANGELOG-crm-shell-areas.md, docs/crm/ROLLOUT.md §C2).
 * public/crm/crm.js exports CrmCore in node. Synthetic names. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const TODAY = '2026-10-27';
const DATA = {
  ok: true,
  leads: [
    { id: 'L-new-today', name: 'אבי', house: 'רמות השבים', stage: 'new', created: TODAY, assignedTo: 'ורד', source: 'פייסבוק', phone: '0501111111' },
    { id: 'L-waiting', name: 'בני', house: 'רעננה אשר', stage: 'new', created: '2026-10-20', assignedTo: 'ורד' },
    { id: 'L-visit-today', name: 'גלי', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '13:30', meetingWith: 'אורן', created: '2026-10-25' },
    { id: 'L-visit-past', name: 'דנה', house: 'רעננה הפרדס', stage: 'visit', visitDate: '2026-10-24', meetingWith: 'חן', created: '2026-10-20' },
    { id: 'L-visit-done', name: 'הדס', house: 'רעננה הפרדס', stage: 'visit', visitDate: '2026-10-24', meetingWith: 'חן', meetingOutcome: 'entering', created: '2026-10-20' },
    { id: 'L-visit-future', name: 'ורד2', house: 'ramot', stage: 'visit', visitDate: '2026-11-02', created: '2026-10-26' },
    { id: 'L-unsched', name: 'זיו', house: 'ramot', stage: 'visit', created: '2026-10-26' },
    { id: 'L-wait', name: 'חן2', house: 'רמות השבים', stage: 'waitlist', created: '2026-10-01' },
    { id: 'L-paid', name: 'טל', house: 'רמות השבים', stage: 'paid', created: '2026-10-01' },
    { id: 'L-admitted', name: 'ישן', house: 'ramot', stage: 'admitted', created: '2026-09-01' },
  ],
  patients: {
    ramot: [{ id: 'p1', name: 'דנה כהן', date: '2026-09-01', status: 'active', fromLead: 'L-x' }, { id: 'p2', name: 'יצא', date: '2026-08-01', status: 'released', exitDate: '2026-10-01' }],
    rehab: [{ id: 'p3', name: 'אבי', date: '2026-10-20', status: 'wait' }],
  },
};

test('areasFor mirrors the server gates: finance → all 6; controller → today/billing/control; no finance → no גבייה', () => {
  assert.deepEqual(core.areasFor({ view: 'full', finance: true }), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'billing', 'control']);
  assert.deepEqual(core.areasFor({ view: 'controller', finance: false }), ['today', 'billing', 'control']);
  assert.deepEqual(core.areasFor({ view: 'restricted', finance: false }), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control']);
  assert.deepEqual(core.areasFor(null), ['today', 'leads', 'occupancy', 'clients', 'calendar', 'control']);
});

test('HOUSES / STAGES mirror app.js (ids, labels, capacities)', () => {
  for (const h of core.HOUSES) assert.ok(APP_SRC.includes(`id: '${h.id}'`) && APP_SRC.includes(h.name) && APP_SRC.includes(`capacity: ${h.capacity}`), h.id);
  assert.equal(core.houseId('hapardes'), 'pardes'); assert.equal(core.houseId('רעננה אשר'), 'asher'); assert.equal(core.houseId('nowhere'), '');
  assert.equal(core.AREAS.filter((a) => a.id === 'clients')[0].label, 'מטופלים');
  for (const st of core.STAGES) assert.ok(APP_SRC.includes(`id: '${st.id}'`) && APP_SRC.includes(st.label), st.id);
  assert.equal(core.houseName('ramot'), 'רמות השבים');
  assert.equal(core.houseName('רמות השבים'), 'רמות השבים');
});

test('normalise: patients keyed by house are flattened with houseId; leads get trimmed stable fields', () => {
  const n = core.normalise(DATA);
  assert.equal(n.patients.length, 3);
  assert.deepEqual(n.patients.map((p) => p.houseId).sort(), ['ramot', 'ramot', 'rehab']);
  assert.equal(n.leads[0].stage, 'new');
  assert.deepEqual(core.normalise(null), { leads: [], patients: [] });
});

test('compute: the work queue — late first, then today, then waiting; KPIs; admitted leads excluded; rows are derived', () => {
  const c = core.compute(DATA, TODAY);
  assert.deepEqual(c.kpi, { late: 2, today: 1, newLeads: 1, meetingsToday: 1 });
  const byId = Object.fromEntries(c.rows.map((r) => [r.leadId, r]));
  assert.equal(byId['L-visit-past'].kind, 'meeting_no_outcome'); assert.equal(byId['L-visit-past'].state, 'late'); assert.equal(byId['L-visit-past'].owner, 'חן');
  assert.equal(byId['L-waiting'].kind, 'lead_waiting'); assert.equal(byId['L-waiting'].state, 'late'); assert.equal(byId['L-waiting'].due, '2026-10-23');
  assert.equal(byId['L-visit-today'].state, 'today'); assert.match(byId['L-visit-today'].action, /13:30/);
  assert.equal(byId['L-visit-done'], undefined, 'a meeting with an outcome is not a task');
  assert.equal(byId['L-admitted'], undefined, 'admitted leads are not on the queue');
  assert.equal(byId['L-unsched'].kind, 'meeting_unscheduled');
  assert.equal(byId['L-wait'].kind, 'waitlist'); assert.match(byId['L-wait'].reason, /רמות השבים/);
  assert.equal(byId['L-paid'].kind, 'admit');
  assert.deepEqual(c.rows.slice(0, 3).map((r) => r.state), ['late', 'late', 'today']);
  assert.ok(c.rows.every((r) => r.derived === true), 'spec §14: computed, not a task record');
  assert.ok(c.rows.every((r) => !('phone' in r)), 'the queue carries no phone');
});

test('board + table share one filter; the table honours house aliases and owner; admitted leads never appear', () => {
  const c = core.compute(DATA, TODAY);
  const all = core.board(c.leads, {});
  assert.deepEqual(all.map((col) => [col.stage.id, col.leads.length]), [['new', 2], ['visit', 5], ['waitlist', 1], ['paid', 1]]);
  const ramot = core.filterLeads(c.leads, { house: 'רמות השבים' });
  assert.equal(ramot.length, 6, 'id and Hebrew name both match the same house');
  assert.equal(core.filterLeads(c.leads, { owner: 'ורד' }).length, 2);
  assert.deepEqual(core.filterLeads(c.leads, { q: 'אבי' }).map((l) => l.id), ['L-new-today']);
  assert.ok(core.filterLeads(c.leads, {}).every((l) => l.stage !== 'admitted'));
});

test('nextActionFor: stage, next action and alert are three different things', () => {
  const c = core.compute(DATA, TODAY);
  const by = Object.fromEntries(c.leads.map((l) => [l.id, l]));
  assert.deepEqual(core.nextActionFor(by['L-visit-past'], TODAY), { text: 'דיווח מהמנהל/ת', state: 'late' });
  assert.deepEqual(core.nextActionFor(by['L-visit-today'], TODAY), { text: 'פגישה היום', state: 'today' });
  assert.deepEqual(core.nextActionFor(by['L-waiting'], TODAY), { text: 'ליצור קשר', state: 'late' });
  assert.deepEqual(core.nextActionFor(by['L-new-today'], TODAY), { text: 'ליצור קשר', state: 'wait' });
  assert.deepEqual(core.nextActionFor(by['L-unsched'], TODAY), { text: 'לתאם פגישה', state: 'wait' });
});

test('clients: in-house only, days in house, house filter; calendar: 14 days ahead incl. today, sorted', () => {
  const c = core.compute(DATA, TODAY);
  const cl = core.clients(c.patients, TODAY, {});
  assert.deepEqual(cl.map((p) => [p.name, p.houseName, p.days]), [['אבי', 'קיסריה ריהאב', 7], ['דנה כהן', 'רמות השבים', 56]]);
  assert.equal(core.clients(c.patients, TODAY, { house: 'rehab' }).length, 1);
  const cal = core.calendar(c.leads, TODAY, 14);
  assert.deepEqual(cal.map((l) => l.id), ['L-visit-today', 'L-visit-future']);
});

test('occupancy: in-house by the dashboard rule (status only), per-house free beds, closed house hidden when empty, unknown house counted apart', () => {
  const c = core.compute(DATA, TODAY);
  const o = core.occupancy(c.patients.concat([{ id: 'x', houseId: 'hapardes', name: 'א', status: 'active' }, { id: 'y', houseId: 'מריח', name: 'ב', status: 'wait' }]));
  const by = Object.fromEntries(o.houses.map((h) => [h.id, h]));
  assert.deepEqual([by.ramot.inHouse, by.ramot.capacity, by.ramot.free, by.ramot.pct], [1, 20, 19, 5]);
  assert.deepEqual([by.rehab.inHouse, by.rehab.free], [1, 12], 'status wait occupies a bed');
  assert.equal(by.pardes.inHouse, 1, 'alias hapardes → pardes');
  assert.equal(by.sde, undefined, 'closed and empty → hidden');
  assert.equal(o.unknown, 1);
  assert.deepEqual([o.totalIn, o.totalCap, o.totalFree], [3, 73, 70]);
  assert.equal(core.inHouse({ status: 'released', exitDate: '' }), false);
  assert.equal(core.inHouse({ status: 'active', exitDate: '2026-01-01' }), true, 'exitDate alone does not free the bed (app.js rule)');
});

test('control metrics and the controller day counts', () => {
  const c = core.compute(DATA, TODAY);
  assert.deepEqual(core.control(c, TODAY).map((m) => [m.id, m.value]), [['untouched', 1], ['late', 2], ['noOutcome', 1], ['unscheduled', 1], ['admitting', 1]]);
  assert.deepEqual(core.controllerDay({ receipts: [{ status: 'reported' }, { status: 'reported' }, { status: 'flagged' }, { status: 'confirmed' }] }), { toVerify: 2, flagged: 1, confirmed: 1, total: 4 });
  assert.deepEqual(core.controllerDay(null), { toVerify: 0, flagged: 0, confirmed: 0, total: 0 });
});

test('fmtDate: ISO → DD/MM/YYYY (the dashboard format); blanks and non-dates pass through', () => {
  assert.equal(core.fmtDate('2026-10-28'), '28/10/2026');
  assert.equal(core.fmtDate('2026-10-28T09:00:00.000Z'), '28/10/2026');
  assert.equal(core.fmtDate(''), '');
  assert.equal(core.fmtDate('28/10/2026'), '28/10/2026');
  const c = core.compute(DATA, TODAY);
  const by = Object.fromEntries(c.leads.map((l) => [l.id, l]));
  assert.deepEqual(core.nextActionFor(by['L-visit-future'], TODAY), { text: 'פגישה 02/11/2026', state: 'wait' });
});

/* ===== C4 lead writes ===== */

test('applyLeadPatch: full raw row kept, waitlistedAt stamped on entering רשימת המתנה and cleared on leaving, never mutates', () => {
  const raw = { id: 'L', name: 'א', phone: '0501111111', stage: 'visit', visitDate: '2026-10-20', waitlistedAt: '', note: 'x', meetingReportedAt: 'keep' };
  const w = core.applyLeadPatch(raw, { stage: 'waitlist' }, '2026-10-27T10:00:00.000Z');
  assert.equal(w.waitlistedAt, '2026-10-27T10:00:00.000Z');
  assert.equal(w.meetingReportedAt, 'keep', 'every other column travels unchanged');
  assert.equal(raw.stage, 'visit', 'pure');
  const back = core.applyLeadPatch(w, { stage: 'paid' }, 'T2');
  assert.equal(back.waitlistedAt, '');
  const same = core.applyLeadPatch(w, { note: 'y' }, 'T3');
  assert.equal(same.waitlistedAt, '2026-10-27T10:00:00.000Z', 'a non-stage patch leaves the stamp');
  assert.deepEqual(core.stageAfter('new'), 'visit'); assert.equal(core.stageAfter('paid'), '', 'paid → admission, not a stage move');
  assert.equal(core.stageBefore('new'), ''); assert.equal(core.stageBefore('waitlist'), 'visit');
});

test('leadSaveBody: ONE lead, patients {}, prove for its id', () => {
  assert.deepEqual(core.leadSaveBody({ id: 'L1', name: 'א' }), { action: 'saveAll', leads: [{ id: 'L1', name: 'א' }], patients: {}, prove: { leads: ['L1'] } });
});

test('saveRefusal: proven → ok; unproven, refused, suppressed, lock busy → Hebrew reasons', () => {
  assert.equal(core.saveRefusal({ ok: true, proven: { leads: ['L1'] } }, 'L1'), '');
  assert.match(core.saveRefusal({ ok: true, proven: { leads: [] } }, 'L1'), /לא אומתה/);
  assert.match(core.saveRefusal({ ok: true, proven: { leads: ['L1'] }, closedSuppressed: ['L1'] }, 'L1'), /נסגר/);
  assert.match(core.saveRefusal({ ok: false, invalidLeads: ['L1'] }, 'L1'), /שם וטלפון/);
  assert.match(core.saveRefusal({ ok: false, badLeadDates: ['L1'] }, 'L1'), /תאריך/);
  assert.match(core.saveRefusal({ ok: false, error: 'lock_busy', message: 'עסוק' }, 'L1'), /עסוק/);
  assert.match(core.saveRefusal(null, 'L1'), /נכשלה/);
});

/* ===== C5 lead lifecycle ===== */

test('localPhone / leadFormErrors / newLeadRow mirror the classic add-lead rules', () => {
  assert.equal(core.localPhone('052-765-4321'), '0527654321');
  assert.equal(core.localPhone('+972 52 765 4321'), '0527654321');
  assert.equal(core.localPhone('12345'), '');
  assert.deepEqual(Object.keys(core.leadFormErrors({ name: 'דנה', phone: '0527654321', assignedTo: 'ורד' })), ['name'], 'two words');
  assert.deepEqual(Object.keys(core.leadFormErrors({ name: 'דנה כהן', phone: '052', assignedTo: 'ורד' })), ['phone']);
  assert.deepEqual(Object.keys(core.leadFormErrors({ name: 'דנה כהן', phone: '0527654321', assignedTo: '', contactPhone: 'x' })), ['assignedTo', 'contactPhone']);
  const row = core.newLeadRow({ name: ' דנה  כהן ', phone: '052-7654321', assignedTo: 'ורד', house: 'רמות השבים', contactName: 'אמא', contactPhone: '0501112222',
    contactRelation: 'אחר', contactRelationOther: 'שכנה', billingMode: 'contact', source: 'גוגל', note: 'x' }, 'id-1', '2026-10-27');
  assert.deepEqual([row.id, row.name, row.phone, row.stage, row.created, row.contactRelation, row.billingPhone, row.meetingOutcome, row.visitDate],
    ['id-1', 'דנה כהן', '0527654321', 'new', '2026-10-27', 'שכנה', '0501112222', '', '']);
  assert.equal(core.newLeadRow({ name: 'א ב', phone: '0527654321', assignedTo: 'ורד', billingMode: 'other', billingOther: '03-1234567' }, 'i', 't').billingPhone, '', 'a 9-digit landline is not a valid lead phone (classic rule)');
  assert.equal(core.newLeadRow({ name: 'א ב', phone: '0527654321', assignedTo: 'ורד', billingMode: 'other', billingOther: '050-999-8888' }, 'i', 't').billingPhone, '0509998888');
  assert.match(core.randomId(), /^id-[0-9a-f]{16}$/);
});

test('duplicateByPhone + closeRecord', () => {
  const leads = [{ id: 'A', name: 'אבי', phone: '0527654321' }];
  assert.equal(core.duplicateByPhone(leads, '052-765-4321').id, 'A');
  assert.equal(core.duplicateByPhone(leads, '0500000000'), null);
  const rec = core.closeRecord({ id: 'A', stage: 'visit', name: 'אבי', phone: '0527654321', meetingReportedAt: 'keep' }, 'completed', 'סיים', '2026-10-27T10:00:00.000Z');
  assert.deepEqual([rec.stage, rec.originSheet, rec.movedAt, rec.disposition, rec.not_relevant_note, rec.meetingReportedAt], ['irrelevant', 'visit', '2026-10-27T10:00:00.000Z', 'completed', 'סיים', 'keep']);
  assert.equal(core.closeRecord({ id: 'A' }, '', '', 't').disposition, 'not_relevant');
  assert.deepEqual(core.DISPOSITIONS.map((d) => d.id), ['not_relevant', 'completed', 'stopped_early', 'released_outpatient'], 'mirrors Code.gs LEAD_CLOSE_DISPOSITIONS');
});

/* ===== C6 admission + direct add ===== */

test('admissionRow / admissionErrors mirror the classic entry modal; funder required only for finance', () => {
  const lead = { id: 'L1', name: 'דנה כהן', phone: '0527654321', visitDate: '2026-10-20' };
  const row = core.admissionRow(lead, { houseId: 'ramot', date: '2026-10-27', pay: '28000', adv: '5000', status: 'trial' }, 'id-p');
  assert.deepEqual(row, { id: 'id-p', houseId: 'ramot', name: 'דנה כהן', date: '2026-10-27', pay: 28000, adv: 5000, status: 'trial', fromLead: 'L1', exitDate: '', source: 'lead', notes: '', updatedAt: '', updatedBy: '', personId: '' });
  assert.deepEqual(Object.keys(core.admissionErrors({ houseId: 'ramot', date: '2026-10-27', pay: '1' }, false)), []);
  assert.deepEqual(Object.keys(core.admissionErrors({ houseId: 'ramot', date: '2026-10-27', pay: '1' }, true)), ['funder']);
  assert.deepEqual(Object.keys(core.admissionErrors({ houseId: '', date: '2019-01-01', pay: '0' }, false)), ['houseId', 'date', 'pay']);
  assert.ok(core.isoDateOk('2026-10-27') && !core.isoDateOk('2019-01-01') && !core.isoDateOk('27/10/2026'));
});

test('directAddRows: patient (direct_admin) + its admitted «פנייה ישירה» lead dl-<id>, as app.js buildDirectApproachLead', () => {
  const r = core.directAddRows({ name: ' אבי  לוי ', phone: '052-111-2222', houseId: 'rehab', date: '2026-10-27', pay: '20000', status: 'active', notes: 'x' }, 'id-9', '2026-10-27', core.houseName);
  assert.deepEqual([r.lead.id, r.lead.stage, r.lead.source, r.lead.house, r.lead.phone, r.lead.entryDate, r.lead.created], ['dl-id-9', 'admitted', 'direct_approach', 'קיסריה ריהאב', '0521112222', '2026-10-27', '2026-10-27']);
  assert.deepEqual([r.patient.id, r.patient.fromLead, r.patient.source, r.patient.name, r.patient.pay, r.patient.adv, r.patient.notes], ['id-9', 'dl-id-9', 'direct_admin', 'אבי לוי', 20000, 0, 'x']);
  assert.deepEqual(Object.keys(core.directAddErrors({ name: 'אבי', phone: '12', houseId: 'rehab', date: '2026-10-27', pay: '1' }, false)), ['name', 'phone']);
  assert.equal(core.directAddRows({ name: 'א ב', houseId: 'rehab', date: 't', pay: '1' }, 'i', 't', core.houseName).lead.phone, '', 'a phone-less direct add still gets its lead');
});

test('houseSaveBody sends the house AS READ plus the new row, never another house; houseSaveRefusal reads proofs, conflicts and duplicates', () => {
  const rows = [{ id: 'p1', houseId: 'ramot', name: 'x', updatedAt: 'T1', updatedBy: 'ורד' }, { id: 'p2', houseId: 'ramot', name: 'y' }];
  const b = core.houseSaveBody('ramot', rows, { id: 'p3', houseId: 'ramot', name: 'z' }, { id: 'L1' });
  assert.deepEqual(Object.keys(b.patients), ['ramot']);
  assert.deepEqual(b.patients.ramot.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.equal(b.patients.ramot[0].updatedAt, 'T1', 'stamps travel unchanged (conflict detection)');
  assert.deepEqual(b.prove, { patients: ['p3'], leads: ['L1'] });
  assert.deepEqual(core.houseSaveBody('ramot', rows, { id: 'p1', houseId: 'ramot', name: 'x2' }, null).patients.ramot.map((p) => p.name), ['y', 'x2'], 'a re-sent id replaces, never duplicates');
  assert.equal(core.houseSaveRefusal({ ok: true, proven: { patients: ['p3'], leads: ['L1'] } }, 'p3', 'L1'), '');
  assert.match(core.houseSaveRefusal({ ok: true, proven: { patients: [], leads: ['L1'] } }, 'p3', 'L1'), /לא אומתה/);
  assert.match(core.houseSaveRefusal({ ok: true, proven: { patients: ['p3'], leads: [] } }, 'p3', 'L1'), /הליד לא אומת/);
  assert.match(core.houseSaveRefusal({ ok: true, skippedPromotes: [{ fromLead: 'L1' }], proven: { patients: ['p3'], leads: ['L1'] } }, 'p3', 'L1'), /כפילות/);
  assert.match(core.houseSaveRefusal({ ok: true, conflicts: [{ id: 'p1' }], proven: { patients: ['p3'], leads: ['L1'] } }, 'p3', 'L1'), /השתנו/);
  assert.match(core.houseSaveRefusal({ ok: false, error: 'x' }, 'p3', ''), /נדחתה/);
});

/* ===== C7 patient actions ===== */

test('dischargeAuditRow mirrors app.js dischargeAuditRow; errors; movedRow carries the ✏ intent; patientEditErrors', () => {
  const p = { id: 'p1', houseId: 'ramot', name: 'דנה כהן', date: '2026-09-01', pay: 28000, adv: 0, status: 'trial', fromLead: 'L1', updatedAt: 'T', updatedBy: 'ורד' };
  const a = core.dischargeAuditRow(p, { disposition: 'completed', dischargeDate: '2026-10-27', note: 'x', continuity: 'none' }, 'aud-1', '2026-10-27T10:00:00.000Z');
  assert.deepEqual([a.id, a.patientId, a.status, a.prior_status, a.exitDate, a.dischargedAt, a.disposition, a.discharge_note, a.continuity, a.fromLead, a.updatedAt], ['aud-1', 'p1', 'released', 'trial', '2026-10-27', '2026-10-27T10:00:00.000Z', 'completed', 'x', 'none', 'L1', 'T']);
  assert.equal(core.dischargeAuditRow(p, { disposition: 'completed' }, 'a', '2026-10-27T10:00:00.000Z').exitDate, '2026-10-27', 'no date → today');
  assert.equal(core.dischargeAuditRow(p, { disposition: 'completed', continuity: 'bogus' }, 'a', '2026-10-27T10:00:00.000Z').continuity, 'unknown');
  assert.deepEqual(Object.keys(core.dischargeErrors({})), ['disposition']);
  assert.deepEqual(Object.keys(core.dischargeErrors({ disposition: 'completed', dischargeDate: '2019-01-01' })), ['dischargeDate']);
  assert.deepEqual(core.DISCHARGE_DISPOSITIONS.map((d) => d.id), ['completed', 'stopped_early', 'released_outpatient'], 'mirrors app.js DISCHARGE_DISPOSITIONS');
  assert.deepEqual(core.CONTINUITY_CHOICES.map((c) => c.id), ['continued_outpatient', 'continued_other', 'none']);
  assert.deepEqual(core.movedRow(p, 'asher'), Object.assign({}, p, { houseId: 'asher', movedFrom: 'ramot' }));
  assert.deepEqual(Object.keys(core.patientEditErrors({ date: 'x', pay: '-1', status: 'released' })), ['date', 'pay', 'status']);
  assert.deepEqual(Object.keys(core.patientEditErrors({ date: '2026-10-27', pay: '0', status: 'active' })), []);
});

test('C8 billingOverview: debtAging + getPayments → KPIs, buckets, debtors (sorted by balance), houses, receipts (newest first); refused answers → zeros + errors', () => {
  const debt = { ok: true, asOf: '2026-10-27',
    totals: { recorded_debt: { count: 2, total: 7000, d0_7: 0, d8_30: 3000, d31_60: 0, d61_plus: 4000 }, unrecorded_cycles: { count: 1, total: 5000, d0_7: 5000, d8_30: 0, d31_60: 0, d61_plus: 0 } },
    byHouse: [{ houseId: 'rehab', recorded_debt: { count: 1, total: 1000 }, unrecorded_cycles: { count: 0, total: 0 } }, { houseId: 'ramot', recorded_debt: { count: 1, total: 6000 }, unrecorded_cycles: { count: 1, total: 5000 } }],
    byPatient: [
      { patientId: 'p2', name: 'אבי', houseId: 'rehab', status: 'released', inHouseAtAsOf: false, cycles: [{ balance: 1000, days: 20, kind: 'recorded' }] },
      { patientId: 'p1', name: 'דנה', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [{ balance: 6000, days: 70, kind: 'recorded', funderGrace: true }, { balance: 5000, days: 3, kind: 'unrecorded' }] },
    ],
    detachedPayments: { count: 2 }, pendingCredits: { count: 1, total: 500 }, funderGrace: { count: 1, amount: 6000 } };
  const pay = { ok: true, payments: [], receipts: [
    { id: 'rcpt-1', patientName: 'אבי', houseId: 'rehab', receivedDate: '2026-08-01', amount: 1000, method: 'מזומן', confirmStatus: 'confirmed' },
    { id: 'rcpt-2', patientName: 'דנה', houseId: 'hapardes', receivedDate: '2026-10-20T00:00:00.000Z', amount: 3000, method: 'ביט', confirmStatus: 'reported' },
    { id: 'rcpt-3', patientName: 'דנה', houseId: 'ramot', receivedDate: '2026-10-25', amount: '250.5', method: 'אשראי', confirmStatus: 'flagged' },
  ] };
  const b = core.billingOverview(debt, pay, '2026-10-27');
  assert.equal(b.openDebt, 12000); assert.equal(b.openCycles, 3); assert.equal(b.over60, 4000); assert.equal(b.debtors, 2);
  assert.deepEqual(b.buckets.map((x) => [x.key, x.amount]), [['d0_7', 5000], ['d8_30', 3000], ['d31_60', 0], ['d61_plus', 4000]]);
  assert.deepEqual(b.patients.map((p) => [p.name, p.balance, p.cycles, p.unrecorded, p.oldestDays, p.bucket, p.grace, p.inHouse, p.houseName]),
    [['דנה', 11000, 2, 1, 70, 'd61_plus', true, true, 'רמות השבים'], ['אבי', 1000, 1, 0, 20, 'd8_30', false, false, 'קיסריה ריהאב']]);
  assert.deepEqual(b.houses.map((h) => [h.name, h.total, h.count]), [['רמות השבים', 11000, 2], ['קיסריה ריהאב', 1000, 1]]);
  assert.deepEqual(b.receipts.map((r) => [r.id, r.receivedDate, r.amount, r.houseName]), [['rcpt-3', '2026-10-25', 250.5, 'רמות השבים'], ['rcpt-2', '2026-10-20', 3000, 'רעננה הפרדס'], ['rcpt-1', '2026-08-01', 1000, 'קיסריה ריהאב']]);
  assert.equal(b.received30, 3250.5); assert.equal(b.received30Count, 2); assert.equal(b.toVerify, 1);
  assert.equal(b.detached, 2); assert.deepEqual(b.pendingCredits, { count: 1, total: 500 }); assert.deepEqual(b.funderGrace, { count: 1, amount: 6000 });
  assert.deepEqual(b.errors, []);
  // refused / missing answers never throw
  const z = core.billingOverview({ ok: false, error: 'forbidden' }, undefined, '2026-10-27');
  assert.equal(z.openDebt, 0); assert.deepEqual(z.patients, []); assert.deepEqual(z.receipts, []); assert.equal(z.asOf, '2026-10-27');
  assert.deepEqual(z.errors, ['חובות: forbidden', 'תשלומים: לא נטען']);
  assert.equal(core.fmtMoney(1234567.49), '₪1,234,567'); assert.equal(core.fmtMoney('x'), '₪0'); assert.equal(core.fmtMoney(-12.5), '₪-12');
  assert.deepEqual(Object.keys(core.DEBT_BUCKET_LABELS), ['d0_7', 'd8_30', 'd31_60', 'd61_plus']);
});

test('C9 patientAccount: one patient out of debtAging + getPayments — open cycles, stamped cycles (newest first), own receipts only, funder history; refused → zeros + errors', () => {
  const debt = { ok: true, byPatient: [{ patientId: 'p1', settledCycles: 2, cycles: [
    { start: '2026-08-01', end: '2026-08-31', expected: 6000, received: 1000, balance: 5000, days: 87, kind: 'recorded', funderGrace: true },
    { start: '2026-10-01', end: '2026-10-31', expected: 6000, received: 0, balance: 6000, days: 26, kind: 'unrecorded' }] }] };
  const pay = { ok: true,
    payments: [{ id: 'c1', patientId: 'p1', dueDate: '2026-08-01', amount: 6000, amountPaid: 1000, balance: 5000, status: 'partial' }, { id: 'c0', patientId: 'p1', dueDate: '2026-07-01T00:00:00.000Z', amount: 6000, amountPaid: 6000, balance: 0, status: 'paid' }, { id: 'cx', patientId: 'p9', dueDate: '2026-07-01', amount: 1, status: 'paid' }],
    receipts: [{ id: 'r1', patientId: 'p1', receivedDate: '2026-08-05', amount: 1000, method: 'ביט', payer: 'אמא', confirmStatus: 'confirmed' }, { id: 'r2', patientId: 'p9', receivedDate: '2026-08-06', amount: 9, method: 'x' }],
    funders: [{ patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-07-01' }, { patientId: 'p1', funder: 'משרד הבריאות', effectiveFrom: '2026-09-01', setBy: 'ורד' }, { patientId: 'p9', funder: 'x', effectiveFrom: '2026-01-01' }] };
  const a = core.patientAccount('p1', debt, pay);
  assert.equal(a.openTotal, 11000); assert.equal(a.settledCycles, 2);
  assert.deepEqual(a.openCycles.map((c) => [c.start, c.balance, c.days, c.kind, c.grace]), [['2026-08-01', 5000, 87, 'recorded', true], ['2026-10-01', 6000, 26, 'unrecorded', false]]);
  assert.deepEqual(a.cycles.map((c) => [c.id, c.dueDate, c.status]), [['c1', '2026-08-01', 'partial'], ['c0', '2026-07-01', 'paid']]);
  assert.deepEqual(a.receipts.map((r) => r.id), ['r1']); assert.equal(a.receivedTotal, 1000);
  assert.equal(a.currentFunder, 'משרד הבריאות'); assert.deepEqual(a.funders.map((f) => f.funder), ['משרד הבריאות', 'פרטי']);
  assert.deepEqual(a.errors, []);
  const z = core.patientAccount('p1', { ok: false, error: 'forbidden' }, undefined);
  assert.equal(z.openTotal, 0); assert.deepEqual(z.cycles, []); assert.deepEqual(z.receipts, []); assert.equal(z.currentFunder, '');
  assert.deepEqual(z.errors, ['חובות: forbidden', 'תשלומים: לא נטען']);
  assert.deepEqual(core.patientAccount('nobody', debt, pay).openCycles, []);
  assert.deepEqual(Object.keys(core.CYCLE_STATUS_LABELS), ['paid', 'partial', 'unpaid', 'void']);
});

test('C10 payment report core: legacy key, uid-or-key row matching, cycle bodies, defaults, the shared rules, body, outcomes', () => {
  const rules = require('../lib/payment-report-rules');
  const pat = { id: 'id-abc', houseId: 'ramot', name: 'דנה כהן', date: '2026-07-29' };
  assert.equal(core.patientKeyOf(pat), 'ramot::דנה כהן::2026-07-29');
  assert.equal(core.patientKeyOf({ houseId: 'רעננה הפרדס', name: ' דנה ', date: '2026-07-29T00:00:00.000Z' }), 'pardes::דנה::2026-07-29');
  // rows keyed on the legacy triple (classic app) AND rows carrying the uid both belong to the patient
  const pay = { ok: true,
    payments: [{ id: 'pay::ramot::דנה כהן::2026-07-29::2026-08-29', patientId: 'ramot::דנה כהן::2026-07-29', patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-08-29', amount: 6000, amountPaid: 1000, status: 'partial', coverageStart: '2026-08-29', coverageEnd: '2026-09-28' },
      { id: 'pay::x', patientId: 'other', patientUid: 'id-abc', dueDate: '2026-09-29', amount: 6000, amountPaid: 0, status: 'unpaid' },
      { id: 'pay::y', patientId: 'rehab::אבי::2026-01-01', dueDate: '2026-09-29', amount: 1, status: 'unpaid' }],
    receipts: [{ id: 'rcpt-1', patientId: 'ramot::דנה כהן::2026-07-29', receivedDate: '2026-09-01', amount: 1000 }, { id: 'rcpt-2', patientUid: 'id-abc', patientId: 'zzz', receivedDate: '2026-09-02', amount: 5 }, { id: 'rcpt-9', patientId: 'nope', amount: 9 }],
    funders: [{ patientId: 'id-abc', funder: 'משרד הביטחון', effectiveFrom: '2026-08-01' }] };
  const debt = { ok: true, byPatient: [{ patientId: 'id-abc', patientKey: 'ramot::דנה כהן::2026-07-29', cycles: [
    { start: '2026-08-29', end: '2026-09-28', expected: 6000, received: 1000, balance: 5000, days: 59, kind: 'recorded', paymentId: 'pay::ramot::דנה כהן::2026-07-29::2026-08-29' },
    { start: '2026-10-29', end: '2026-11-28', expected: 5500, received: 0, balance: 5500, days: 0, kind: 'unrecorded' }] }] };
  const a = core.patientAccount(pat, debt, pay);
  assert.deepEqual(a.cycles.map((c) => c.id), ['pay::x', 'pay::ramot::דנה כהן::2026-07-29::2026-08-29']);
  assert.deepEqual(a.receipts.map((r) => r.id), ['rcpt-2', 'rcpt-1']); assert.equal(a.receivedTotal, 1005);
  assert.equal(a.currentFunder, 'משרד הביטחון');
  assert.equal(core.patientAccount('id-abc', debt, pay).openCycles.length, 2, 'a bare id still works');
  // cycle bodies: recorded → the Payments row; unrecorded → minted like the classic app
  assert.deepEqual(core.reportCycleFor(pat, a.openCycles[0], a), { id: 'pay::ramot::דנה כהן::2026-07-29::2026-08-29', patientId: 'ramot::דנה כהן::2026-07-29', patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-08-29', amount: 6000, coverageStart: '2026-08-29', coverageEnd: '2026-09-28' });
  assert.deepEqual(core.reportCycleFor(pat, a.openCycles[1], a), { id: 'pay::ramot::דנה כהן::2026-07-29::2026-10-29', patientId: 'ramot::דנה כהן::2026-07-29', patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-10-29', amount: 5500, coverageStart: '2026-10-29', coverageEnd: '2026-11-28' });
  assert.equal(core.reportCycleForRow(pat, a.cycles[0]).patientId, 'other', 'a stamped row keeps its own key');
  // defaults: remaining prefilled, funder only when a real reportable one, invoice choice empty
  const d = core.reportDefaults(core.reportCycleFor(pat, a.openCycles[0], a), 5000, '2026-10-28', 'משרד הביטחון');
  assert.deepEqual(d, { receivedDate: '2026-10-28', amount: '5000', method: '', payer: '', reference: '', funder: 'משרד הביטחון', coverageStart: '2026-08-29', coverageEnd: '2026-09-28', invoiceWanted: '', invoiceTo: '' });
  assert.equal(core.reportDefaults({}, 0, '2026-10-28', 'פרו-בונו').funder, ''); assert.equal(core.reportDefaults({}, 0, '2026-10-28', 'unset').funder, ''); assert.equal(core.reportDefaults({}, 0, '2026-10-28', 'x').funder, '');
  // issues: the shared rules, the 90-day staff limit unless approver
  assert.ok(core.reportRules() === rules);
  const good = Object.assign({}, d, { method: 'ביט', payer: 'אמא של דנה', invoiceWanted: 'no' });
  assert.deepEqual(core.reportIssues(good, '2026-10-28', false), []);
  assert.deepEqual(core.reportIssues(Object.assign({}, good, { method: 'העברה בנקאית' }), '2026-10-28', false).map((i) => i.field), ['reference']);
  assert.deepEqual(core.reportIssues(Object.assign({}, good, { receivedDate: '2026-01-01' }), '2026-10-28', false).map((i) => i.code), ['received_date_too_old']);
  assert.deepEqual(core.reportIssues(Object.assign({}, good, { receivedDate: '2026-01-01' }), '2026-10-28', true), [], 'approver: no age limit');
  assert.ok(core.reportIssues(Object.assign({}, good, { invoiceWanted: 'yes', invoiceTo: '' }), '2026-10-28', false).some((i) => i.field === 'invoiceTo'));
  assert.deepEqual(core.reportIssues({}, '2026-10-28', false, {}).map((i) => i.code), ['rules_missing'], 'a page whose rules script failed to load');
  // body + submission id + outcomes
  const b = core.reportBody({ id: 'c' }, good, 'sub-1');
  assert.deepEqual(Object.keys(b.report), ['cycle', 'report', 'submissionId']); assert.equal(b.action, 'reportPayment');
  assert.equal(core.reportBody({ id: 'c' }, good, 'sub-1', true).report.confirmDuplicate, true);
  assert.match(core.newSubmissionId(), /^sub-[0-9a-f]{32}$/); assert.notEqual(core.newSubmissionId(), core.newSubmissionId());
  assert.deepEqual(core.reportOutcome({ ok: true, receipt: { id: 'rcpt-7' }, cycle: { id: 'c' } }), { ok: true, receiptId: 'rcpt-7', cycle: { id: 'c' } });
  assert.equal(core.reportOutcome({ ok: true }).ok, false, 'no receipt id = not saved');
  assert.deepEqual(core.reportOutcome({ ok: false, error: 'possible_duplicate', existing: { id: 'r' } }), { ok: false, duplicate: { id: 'r' } });
  assert.deepEqual(core.reportOutcome({ ok: false, error: 'invalid_report', message: 'm', issues: [{ field: 'amount' }] }), { ok: false, message: 'm', issues: [{ field: 'amount' }] });
  assert.match(core.reportOutcome({ ok: false, error: 'lock_busy' }).message, /עסוקה/); assert.match(core.reportOutcome({ ok: false, error: 'forbidden' }).message, /הרשאה/);
  assert.equal(core.duplicateText({ receivedDate: '2026-10-20', reference: '123' }), 'קיימת כבר קבלה דומה (20/10, אסמכתא 123). האם זו קבלה נוספת?');
  assert.equal(core.duplicateText({}), 'קיימת כבר קבלה דומה (—, ללא אסמכתא). האם זו קבלה נוספת?');
});

test('esc escapes every HTML-significant character', () => {
  assert.equal(core.esc('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('wiring: assets hashed via ASSETS, NOT in sw.js; the shell never calls a write action; links only to the classic dashboard', () => {
  assert.match(SERVER_SRC, /'\/crm\/crm\.js': \{ file:/);
  assert.match(SERVER_SRC, /'\/crm\/crm\.css': \{ file:/);
  assert.doesNotMatch(SW_SRC, /crm\//);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
  const actions = [...src.matchAll(/api\('([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(actions)], ['billingControlQueue', 'debtAging', 'getActivity', 'getData', 'getPayments'], 'GET reads (debtAging + getPayments: C8, גבייה read-only)');
  const writes = [...src.matchAll(/\{ action: '([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(writes)], ['appendFunder', 'dischargePatient', 'moveLeadIrrelevant', 'removeLead', 'reportPayment', 'restoreLead', 'saveAll'], 'the write actions: one-lead saveAll (C4), the lead lifecycle (C5), admission + funder (C6), discharge (C7), the strict payment report (C10)');
  assert.equal((src.match(/\/api\/outpatient-lead/g) || []).length, 1, 'the outpatient handoff: one call site, after a released_outpatient discharge');
  assert.ok(!/serializePatients|patients: state\.data\.patients\b/.test(src), 'patients travel only through houseSaveBody (one house as read)');
  assert.ok(!/innerHTML\s*=\s*[^;]*\b(l|lead|p|pat)\.(name|phone|note)\b(?!\))/.test(src.replace(/esc\([^)]*\)/g, 'ESC')), 'every interpolated field goes through esc()');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');
  assert.match(html, /lang="he" dir="rtl"/);
  assert.match(html, /crm\/crm\.css\?v=__BUILD__/);
  assert.match(html, /crm\/crm\.js\?v=__BUILD__/);
});
