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
  assert.deepEqual(core.normalise(null), { leads: [], patients: [], discharges: [], outpatientSent: {} });
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
  assert.deepEqual(core.control(c, TODAY).map((m) => [m.id, m.value]), [['unseenReports', 0], ['untouched', 1], ['late', 2], ['noOutcome', 1], ['unscheduled', 1], ['admitting', 1]]);
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

test('C11 credits + discount / amount / settle core: ledger rows per patient (uid or key), pending list, money parsing, errors, bodies (classic contracts), refusals', () => {
  const pat = { id: 'id-abc', houseId: 'ramot', name: 'דנה כהן', date: '2026-07-29' };
  const credits = { ok: true, credits: [
    { id: 'cr-1', patientId: 'id-abc', patientKey: 'ramot::דנה כהן::2026-07-29', patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused', allocationMonth: '2026-09', amount: 1200, status: 'pending', payoutDate: '2026-10-15' },
    { id: 'cr-2', patientId: '', patientKey: 'ramot::דנה כהן::2026-07-29', patientName: 'דנה כהן', houseId: 'ramot', creditType: 'other', allocationMonth: '2026-10', amount: 300, status: 'paid', paidDate: '2026-10-20', method: 'ביט' },
    { id: 'cr-3', patientId: 'id-zzz', patientKey: 'rehab::אבי::2026-01-01', patientName: 'אבי', houseId: 'rehab', creditType: 'prepaid_return', allocationMonth: '2026-08', amount: 900, status: 'pending', payoutDate: '2026-09-15' },
    { id: 'cr-4', patientId: 'id-zzz', patientKey: 'rehab::אבי::2026-01-01', creditType: 'other', allocationMonth: '2026-08', amount: 0, status: 'pending' },
    { id: 'cr-5', patientId: 'id-zzz', patientKey: 'rehab::אבי::2026-01-01', creditType: 'other', allocationMonth: '2026-08', amount: 50, status: 'cancelled' }] };
  assert.deepEqual(core.patientCredits(pat, credits).map((c) => c.id), ['cr-2', 'cr-1'], 'uid or legacy key, newest month first');
  assert.deepEqual(core.patientCredits('id-zzz', credits).map((c) => c.id), ['cr-3', 'cr-4', 'cr-5']);
  assert.deepEqual(core.pendingCredits(credits).map((c) => c.id), ['cr-3', 'cr-1'], 'pending with money, oldest payout first');
  assert.deepEqual(core.pendingCredits({ ok: false }), []);
  assert.equal(core.creditsOf(credits)[0].houseName, 'רמות השבים');
  // money parsing: the server's rule (0..1,000,000, ≤ 2 decimals)
  assert.equal(core.moneyParse('1,200.50'), 1200.5); assert.equal(core.moneyParse(' 0 '), 0); assert.equal(core.moneyParse('₪300'), 300);
  for (const bad of ['', '-1', '1.234', 'abc', '1000001']) assert.equal(core.moneyParse(bad), null, bad);
  // discount
  assert.deepEqual(core.discountErrors({ month: '2026-09', discountAmount: '500', discountReason: 'הסכמה עם המשפחה' }), {});
  assert.deepEqual(Object.keys(core.discountErrors({ month: '2026-13', discountAmount: 'x', discountReason: 'a' })), ['month', 'discountAmount', 'discountReason']);
  assert.deepEqual(core.discountBody(pat, '2026-09', '500', ' הסכמה '), { action: 'setBillingDiscount', discount: { patientId: 'ramot::דנה כהן::2026-07-29', month: '2026-09', discountAmount: 500, discountReason: 'הסכמה' } });
  // amount override
  assert.deepEqual(core.overrideErrors({ month: '2026-09', amount: '5500' }), {});
  assert.deepEqual(Object.keys(core.overrideErrors({ month: '', amount: '-3' })), ['month', 'amount']);
  assert.deepEqual(core.overrideBody(pat, '2026-09', '5,500', '2026-10-28'), { action: 'upsertBillingOverride', override: { id: 'ovr::ramot::דנה כהן::2026-07-29::2026-09', patientId: 'ramot::דנה כהן::2026-07-29', month: '2026-09', amount: 5500, created: '2026-10-28' } });
  // settle
  assert.deepEqual(core.settleErrors({ paidDate: '2026-10-28', method: 'ביט' }, '2026-10-28'), {});
  assert.deepEqual(core.settleErrors({ paidDate: '2026-10-29', method: '' }, '2026-10-28'), { paidDate: 'התאריך לא יכול להיות בעתיד', method: 'חסר: אמצעי תשלום' });
  assert.deepEqual(core.settleBody('cr-1', '2026-10-28T00:00:00.000Z', 'ביט'), { action: 'settleRefund', creditId: 'cr-1', paidDate: '2026-10-28', method: 'ביט' });
  assert.ok(core.SETTLE_METHODS.indexOf('העברה בנקאית') >= 0);
  // refusals
  assert.equal(core.writeRefusal({ ok: true }, ''), ''); assert.equal(core.writeRefusal({ ok: true, override: { id: 'o' } }, 'override'), '');
  assert.match(core.writeRefusal({ ok: true }, 'override'), /לא אושר/);
  assert.equal(core.writeRefusal({ ok: false, error: 'bad_discount_reason', message: 'בהנחה חובה לפרט סיבה (2 עד 120 תווים)' }), 'בהנחה חובה לפרט סיבה (2 עד 120 תווים)');
  assert.match(core.writeRefusal({ ok: false, error: 'not_pending' }), /רענני/); assert.match(core.writeRefusal({ ok: false, error: 'forbidden' }), /הרשאה/); assert.match(core.writeRefusal({ ok: false, error: 'lock_busy' }), /עסוקה/);
  assert.equal(core.writeRefusal({ ok: false, error: 'x' }), 'השינוי לא נשמר (x)');
  assert.deepEqual(Object.keys(core.CREDIT_TYPE_LABELS), ['days_unused', 'prepaid_return', 'other']);
});

test('C13 report any cycle: entry-anchored stay cycles (month-end clamp, exit cut), reportable = not already offered, default = first future cycle, window → cycle body', () => {
  assert.equal(core.addMonthsIso('2026-01-31', 1), '2026-02-28'); assert.equal(core.addMonthsIso('2026-11-30', 3), '2027-02-28'); assert.equal(core.addMonthsIso('2026-10-27', -1), '2026-09-27');
  const pat = { id: 'p1', houseId: 'arfoni', name: 'תמיר', date: '2026-07-27', pay: 7000 };
  assert.deepEqual(core.stayCycles(pat, '2026-10-28', 0).map((w) => w.start + '..' + w.end), ['2026-07-27..2026-08-26', '2026-08-27..2026-09-26', '2026-09-27..2026-10-26', '2026-10-27..2026-11-26']);
  assert.deepEqual(core.stayCycles(Object.assign({}, pat, { exitDate: '2026-09-27' }), '2026-10-28').map((w) => w.start), ['2026-07-27', '2026-08-27'], 'a cycle starting on / after the exit is not a stay cycle');
  assert.deepEqual(core.stayCycles({ date: '' }, '2026-10-28'), []);
  assert.deepEqual(core.stayCycles({ date: '2026-01-31' }, '2026-03-01', 0).map((w) => w.start), ['2026-01-31', '2026-02-28'], 'clamped to the month end');
  const acc = { openCycles: [{ start: '2026-09-27' }], cycles: [{ id: 'x', dueDate: '2026-07-27', status: 'paid', amount: 7000, amountPaid: 7000 }, { id: 'y', dueDate: '2026-08-27', status: 'unpaid', amount: 7000, amountPaid: 0 }] };
  const list = core.reportableCycles(pat, acc, '2026-10-28');
  assert.deepEqual(list.map((w) => [w.start, w.expected, w.status, w.paymentId]), [['2026-07-27', 7000, 'paid', 'x'], ['2026-10-27', 7000, '', ''], ['2026-11-27', 7000, '', ''], ['2026-12-27', 7000, '', ''], ['2027-01-27', 7000, '', '']], 'open (09-27) and unpaid (08-27) rows are offered by their own buttons');
  assert.equal(core.defaultReportable(list, '2026-10-28'), 2, 'the first cycle after today');
  assert.equal(core.defaultReportable(list.slice(0, 1), '2026-10-28'), 0); assert.equal(core.defaultReportable([], '2026-10-28'), -1);
  assert.deepEqual(core.reportCycleForWindow(pat, list[1], acc), { id: 'pay::arfoni::תמיר::2026-07-27::2026-10-27', patientId: 'arfoni::תמיר::2026-07-27', patientName: 'תמיר', houseId: 'arfoni', dueDate: '2026-10-27', amount: 7000, coverageStart: '2026-10-27', coverageEnd: '2026-11-26' });
  assert.equal(core.reportCycleForWindow(pat, list[0], { cycles: [{ id: 'x', patientId: 'k', dueDate: '2026-07-27', amount: 7000, coverageStart: '2026-07-27', coverageEnd: '2026-08-26' }] }).patientId, 'k', 'a stamped row is re-sent as itself');
  assert.equal(core.normalise({ patients: { ramot: [{ id: 'a', name: 'x', date: '2026-01-01', pay: '6,000' }] } }).patients[0].pay, 0, 'pay is numeric only');
  assert.equal(core.normalise({ patients: { ramot: [{ id: 'a', name: 'x', date: '2026-01-01', pay: 6000 }] } }).patients[0].pay, 6000);
});

test('C13 receipt fix: edit = only the changed non-money fields, validated by the shared rules; void = the classic savePayment void row with a reason; acceptance needs the server echo', () => {
  const r = { id: 'rcpt-1', patientId: 'ramot::דנה::2026-07-29', patientName: 'דנה', houseId: 'ramot', dueDate: '2026-08-29', receivedDate: '2026-09-01', amount: 1000, method: 'ביט', payer: 'אמא', reference: '', funder: 'פרטי', coverageStart: '2026-08-29', coverageEnd: '2026-09-28', invoiceWanted: 'no', invoiceTo: '' };
  const same = { method: 'ביט', payer: 'אמא', reference: '', coverageStart: '2026-08-29', coverageEnd: '2026-09-28', invoiceWanted: 'no', invoiceTo: '' };
  assert.deepEqual(core.receiptEditFields(r, same), {});
  assert.deepEqual(core.receiptEditFields(r, Object.assign({}, same, { payer: 'אבא', reference: ' 77 ' })), { payer: 'אבא', reference: '77' });
  assert.deepEqual(core.receiptEditIssues(r, same, '2026-10-28').map((i) => i.code), ['nothing_changed']);
  assert.deepEqual(core.receiptEditIssues(r, Object.assign({}, same, { payer: 'אבא' }), '2026-10-28'), []);
  assert.deepEqual(core.receiptEditIssues(r, Object.assign({}, same, { method: 'העברה בנקאית' }), '2026-10-28').map((i) => i.field), ['reference'], 'a method change re-checks the reference');
  assert.deepEqual(core.receiptEditIssues(r, Object.assign({}, same, { invoiceWanted: 'yes' }), '2026-10-28').map((i) => i.field), ['invoiceTo']);
  assert.deepEqual(core.receiptEditIssues(r, Object.assign({}, same, { payer: 'x' }), '2026-10-28').map((i) => i.field), ['payer']);
  assert.deepEqual(core.receiptEditIssues(r, Object.assign({}, same, { payer: 'אבא', reason: 'x'.repeat(301) }), '2026-10-28').map((i) => i.field), ['reason']);
  assert.deepEqual(core.receiptEditBody(r, Object.assign({}, same, { payer: 'אבא', reason: ' תיקון ' })), { action: 'editReceipt', edit: { id: 'rcpt-1', fields: { payer: 'אבא' }, reason: 'תיקון' } });
  assert.deepEqual(core.receiptEditBody(r, Object.assign({}, same, { payer: 'אבא' })).edit.reason, undefined);
  assert.deepEqual(core.receiptVoidErrors({ note: 'x' }), { note: 'יש לציין סיבה (2 עד 120 תווים)' }); assert.deepEqual(core.receiptVoidErrors({ note: 'כפול' }), {});
  assert.deepEqual(core.receiptVoidBody(r, 'נרשם פעמיים', '2026-10-28T05:00:00.000Z'), { action: 'savePayment', payment: { id: 'rcpt-1', patientId: 'ramot::דנה::2026-07-29', patientName: 'דנה', houseId: 'ramot', dueDate: '2026-08-29', status: 'void', linkPatientUid: '', linkStatus: 'duplicate', linkNote: 'נרשם פעמיים', timestamp: '2026-10-28T05:00:00.000Z' } });
  assert.equal(core.receiptVoidAccepted({ ok: true, payment: { id: 'rcpt-1', status: 'void' } }, 'rcpt-1'), true);
  assert.equal(core.receiptVoidAccepted({ ok: true, payment: { id: 'rcpt-1', status: 'מבוטל' } }, 'rcpt-1'), true);
  assert.equal(core.receiptVoidAccepted({ ok: true, payment: { id: 'rcpt-1', status: 'paid' } }, 'rcpt-1'), false); assert.equal(core.receiptVoidAccepted({ ok: true }, 'rcpt-1'), false);
  const rs = core.billingOverview({ ok: false }, { ok: true, receipts: [{ id: 'a', status: 'מבוטל', receivedDate: '2026-10-01', amount: 5 }, { id: 'b', status: '', receivedDate: '2026-10-02', amount: 6, reference: 'R', coverageStart: '2026-10-01T00:00:00.000Z', invoiceWanted: 'yes' }] }, '2026-10-28').receipts;
  assert.deepEqual(rs.map((x) => [x.id, x.isVoid, x.reference, x.coverageStart, x.invoiceWanted]), [['b', false, 'R', '2026-10-01', 'yes'], ['a', true, '', '', '']]);
  assert.deepEqual(core.RECEIPT_EDIT_FIELDS, ['reference', 'method', 'payer', 'invoiceWanted', 'invoiceTo', 'coverageStart', 'coverageEnd']);
});

test('C14 meetings: the manager report (labels, local time, unseen), the work-queue row / next action / control metric for an unseen report, the discharge record by patientId or the legacy triple (restored / deleted rows skipped)', () => {
  const data = { leads: [
    { id: 'L1', name: 'a', stage: 'visit', visitDate: '2026-10-20', visitTime: '10:00', meetingWith: 'אורן', meetingReportOutcome: 'advancing', meetingCompanion: 'mother', meetingNote: 'טוב', meetingReporter: 'אורן', meetingReportedAt: '2026-10-21T08:30:00.000Z', meetingSeen: '' },
    { id: 'L2', name: 'b', stage: 'visit', visitDate: '2026-10-20', meetingReportOutcome: 'no_show', meetingCompanion: 'דוד', meetingReportedAt: '2026-10-21T08:30:00.000Z', meetingSeen: '1' },
    { id: 'L3', name: 'c', stage: 'new', created: '2026-10-27' }],
    patients: { ramot: [{ id: 'p1', name: 'b', date: '2026-07-01', fromLead: 'L2', status: 'released' }, { id: 'p2', name: 'z', date: '2026-01-01', status: 'active' }] },
    dischargedPatients: [
      { id: 'd1', patientId: 'p1', name: 'b', houseId: 'ramot', date: '2026-07-01', exitDate: '2026-10-01', dischargedAt: '2026-10-01T09:00:00.000Z', disposition: 'stopped_early', discharge_note: 'x', continuity: 'שחר' },
      { id: 'd0', patientId: 'p1', dischargedAt: '2026-09-01', restored: '1' },
      { id: 'd3', patientId: 'p1', dischargedAt: '2026-11-01', deletedAt: '2026-11-02' },
      { id: 'd2', name: 'z', houseId: 'רמות השבים', date: '2026-01-01', dischargedAt: '2026-03-01T00:00:00.000Z', disposition: 'completed' }] };
  const c = core.compute(data, '2026-10-28');
  const r = core.managerReport(c.leads[0]);
  assert.deepEqual(r, { outcome: 'התקיימה — מתקדם לכניסה', companion: 'אמא', note: 'טוב', reporter: 'אורן', at: '2026-10-21T08:30:00.000Z', when: '21/10/2026 11:30', unseen: true });
  assert.equal(core.managerReport(c.leads[1]).unseen, false); assert.equal(core.managerReport(c.leads[1]).companion, 'דוד', 'free text passes through'); assert.equal(core.managerReport(c.leads[2]), null);
  assert.equal(core.unseenReports(c.leads), 1);
  assert.deepEqual(c.rows.filter((x) => x.kind === 'report_unseen').map((x) => [x.leadId, x.state, x.due]), [['L1', 'today', '2026-10-21']]);
  assert.deepEqual(core.nextActionFor(c.leads[0], '2026-10-28'), { text: 'דיווח מנהל/ת חדש', state: 'today' });
  assert.equal(core.control(c, '2026-10-28')[0].id, 'unseenReports'); assert.equal(core.control(c, '2026-10-28')[0].value, 1);
  const m1 = core.meetingsFor(c.patients[0], 'patient', c);
  assert.equal(m1.lead.id, 'L2'); assert.deepEqual(m1.visit, { date: '2026-10-20', time: '', withWhom: '', outcome: '' });
  assert.equal(m1.discharge.id, 'd1'); assert.equal(m1.discharge.dispositionLabel, 'הפסיק לפני הזמן'); assert.equal(m1.discharge.continuity, 'שחר');
  const m2 = core.meetingsFor(c.patients[1], 'patient', c);
  assert.equal(m2.lead, null); assert.equal(m2.visit, null); assert.equal(m2.report, null);
  assert.equal(m2.discharge.id, 'd2', 'a legacy row without patientId matches the triple (house by name)'); assert.equal(m2.discharge.dispositionLabel, 'סיים טיפול');
  assert.equal(core.meetingsFor(c.leads[2], 'lead', c).visit, null);
  assert.equal(core.whenLocal('2026-10-21'), '21/10/2026'); assert.equal(core.whenLocal(''), '');
  assert.deepEqual(Object.keys(core.DISPOSITION_LABELS), ['completed', 'stopped_early', 'released_outpatient', 'not_relevant']);
});

test('C15 calendar picker: day / week ranges (week starts Sunday), rows for any date incl. past and non-visit stages, status per row, titles', () => {
  assert.equal(core.weekStart('2026-10-28'), '2026-10-25'); assert.equal(core.weekStart('2026-10-25'), '2026-10-25'); assert.equal(core.weekStart('2026-10-31'), '2026-10-25');
  assert.deepEqual(core.calendarRange('week', '2026-10-28'), { mode: 'week', from: '2026-10-25', to: '2026-10-31' });
  assert.deepEqual(core.calendarRange('day', '2026-10-28'), { mode: 'day', from: '2026-10-28', to: '2026-10-28' });
  assert.equal(core.calendarRange('day', 'junk'), null); assert.deepEqual(core.calendarRange('x', '2026-10-28').mode, 'day');
  const leads = [
    { id: 'a', name: 'x', house: 'ramot', stage: 'paid', visitDate: '2026-10-20', visitTime: '10:00', meetingOutcome: 'מתקדם' },
    { id: 'b', name: 'y', house: 'ramot', stage: 'visit', visitDate: '2026-10-27', meetingReportedAt: '2026-10-27T10:00:00Z', meetingSeen: '' },
    { id: 'c', name: 'z', stage: 'visit', visitDate: '2026-10-28', visitTime: '09:00', meetingWith: 'אורן' },
    { id: 'd', name: 'w', stage: 'visit', visitDate: '2026-10-21' },
    { id: 'e', name: 'v', stage: 'visit', visitDate: '2026-11-02' },
    { id: 'f', name: 'u', stage: 'visit', visitDate: '' }];
  const today = '2026-10-28';
  assert.deepEqual(core.calendarRows(leads, core.calendarRange('week', '2026-10-21'), today).map((r) => [r.id, r.status.state, r.status.text]), [['a', 'ok', 'מתקדם'], ['d', 'late', 'ללא תוצאה']], 'past week: an admitted lead still shows its meeting');
  assert.deepEqual(core.calendarRows(leads, core.calendarRange('day', '2026-10-27'), today).map((r) => [r.status.state, r.status.text, r.reported]), [['today', 'יש דיווח מנהל/ת · חדש', true]]);
  assert.deepEqual(core.calendarRows(leads, core.calendarRange('day', today), today).map((r) => [r.id, r.status.text, r.withWhom, r.time]), [['c', 'היום', 'אורן', '09:00']]);
  assert.deepEqual(core.calendarRows(leads, core.calendarRange('week', '2026-11-04'), today).map((r) => [r.id, r.status.text]), [['e', 'מתוכנן']]);
  assert.deepEqual(core.calendarRows(leads, null, today), []);
  assert.equal(core.calendarTitle(core.calendarRange('day', today), today), 'היום · 28/10/2026');
  assert.equal(core.calendarTitle(core.calendarRange('day', '2026-10-27'), today), 'יום שלישי · 27/10/2026');
  assert.equal(core.calendarTitle(core.calendarRange('week', today), today), 'שבוע 25/10/2026 – 31/10/2026');
  assert.deepEqual(core.DAY_NAMES.length, 7);
});

test('C17 discharged: open audit rows only, window + filters, sent flag; restore target by patientId / triple / fromLead; restored row; sibling audits; the classic bodies', () => {
  const data = { outpatientSentLeadIds: ['discharge:d1'],
    patients: { ramot: [{ id: 'p1', name: 'דנה', date: '2026-07-01', status: 'released', exitDate: '2026-10-01', fromLead: 'L1' }, { id: 'p9', name: 'זיו', date: '2026-01-01', status: 'released', fromLead: 'L9' }], rehab: [{ id: 'p2', name: 'אבי', date: '2026-02-01', status: 'active' }] },
    dischargedPatients: [
      { id: 'd1', patientId: 'p1', name: 'דנה', houseId: 'ramot', date: '2026-07-01', exitDate: '2026-10-01', dischargedAt: '2026-10-01T09:00:00Z', disposition: 'released_outpatient', continuity: 'שחר', prior_status: 'trial' },
      { id: 'd1b', patientId: 'p1', name: 'דנה', houseId: 'ramot', date: '2026-07-01', exitDate: '2026-09-20', dischargedAt: '2026-09-20T09:00:00Z', disposition: 'completed' },
      { id: 'd2', name: 'זיו', houseId: 'רמות השבים', date: '2026-01-01', exitDate: '2026-03-01', dischargedAt: '2026-03-01T00:00:00Z', disposition: 'completed' },
      { id: 'd3', patientId: 'p1', exitDate: '2026-08-01', restored: 'TRUE' }, { id: 'd4', patientId: 'p1', exitDate: '2026-08-02', deletedAt: '2026-08-03' },
      { id: 'd5', name: 'גל', houseId: 'rehab', date: '2026-03-01', exitDate: '2026-10-20', dischargedAt: '2026-10-20T00:00:00Z', disposition: 'stopped_early', fromLead: 'L5' }] };
  const c = core.compute(data, '2026-10-28');
  assert.deepEqual(core.dischargedList(c, '2026-10-28', 90, {}).map((r) => [r.id, r.sentToOutpatient, r.dispositionLabel]), [['d5', false, 'הפסיק לפני הזמן'], ['d1', true, 'משוחרר לטיפול חוץ'], ['d1b', false, 'סיים טיפול']]);
  assert.deepEqual(core.dischargedList(c, '2026-10-28', 0, {}).map((r) => r.id), ['d5', 'd1', 'd1b', 'd2'], 'no window = everything open');
  assert.deepEqual(core.dischargedList(c, '2026-10-28', 0, { house: 'rehab' }).map((r) => r.id), ['d5']);
  assert.deepEqual(core.dischargedList(c, '2026-10-28', 0, { q: 'זיו' }).map((r) => r.id), ['d2']);
  const d1 = core.dischargedList(c, '2026-10-28', 0, {}).filter((r) => r.id === 'd1')[0];
  assert.equal(core.priorStatusOf(d1), 'trial'); assert.equal(core.priorStatusOf({ priorStatus: 'x' }), 'active');
  const t1 = core.restoreTarget(d1, data.patients);
  assert.deepEqual([t1.hid, t1.idx, t1.row.id], ['ramot', 0, 'p1'], 'by patientId');
  assert.deepEqual(core.restoredRow(t1.row, d1), Object.assign({}, t1.row, { status: 'trial', exitDate: '' }));
  const d2 = core.dischargedList(c, '2026-10-28', 0, {}).filter((r) => r.id === 'd2')[0];
  assert.equal(core.restoreTarget(d2, data.patients).row.id, 'p9', 'legacy row: the triple, house given by name');
  const d5 = core.dischargedList(c, '2026-10-28', 0, {}).filter((r) => r.id === 'd5')[0];
  assert.equal(core.restoreTarget(d5, data.patients), null, 'no row left → only as a new lead');
  assert.equal(core.restoreTarget(Object.assign({}, d5, { name: 'other' }), { rehab: [{ id: 'q', name: 'x', date: '2026-01-01', status: 'released', fromLead: 'L5' }] }).row.id, 'q', 'one released row with the same source lead');
  assert.deepEqual(core.openAuditsOf(d1, c.discharges).map((d) => d.id), ['d1', 'd1b'], 'both open rows of the stay');
  assert.deepEqual(core.restoreFlagBody({ id: 'd1', x: 1 }), { action: 'restorePatientToActive', patient: { id: 'd1', x: 1, restored: 'TRUE' } });
  assert.deepEqual(core.restoreAsLeadBody({ id: 'd1' }, 'lead-abc'), { action: 'restorePatient', patient: { id: 'd1', newLeadId: 'lead-abc' } });
  assert.deepEqual(core.outpatientBody('d1'), { dischargeId: 'd1', manual: true });
  assert.match(core.randomId().replace(/^id-/, 'lead-'), /^lead-[0-9a-f]{16}$/);
});

test('C18 payment linking: detached rows from debtAging (decided ones out), candidates ranked by house / name / entry, the two classic savePayment bodies, errors, acceptance', () => {
  const debt = { ok: true, detachedPayments: { count: 3, rows: [
    { paymentId: 'pay::arfoni::שחר חיון ::2026-09-07::2026-09-07', patientName: 'שחר חיון ', houseId: 'arfoni', dueDate: '2026-09-07', amount: 35000, receivedByAsOf: 35000, reason: 'unmatched' },
    { paymentId: 'pay::rehab::עדי::2026-09-14::2026-09-14', patientName: 'עדי', houseId: 'rehab', dueDate: '2026-09-14T00:00:00.000Z', amount: 35000, receivedByAsOf: 0, reason: 'unmatched' },
    { paymentId: 'x', patientName: 'ספק', houseId: 'ramot', dueDate: '2026-09-01', amount: 1, reason: 'not_a_patient' }] } };
  const rows = core.detachedRows(debt);
  assert.deepEqual(rows.map((r) => [r.patientName, r.houseName, r.dueDate, r.received]), [['עדי', 'קיסריה ריהאב', '2026-09-14', 0], ['שחר חיון', 'קיסריה עפרוני', '2026-09-07', 35000]]);
  assert.deepEqual(core.detachedRows({ ok: false }), []);
  assert.equal(core.namesLookAlike('שחר חיון ', 'שחר חיון'), true); assert.equal(core.namesLookAlike('עדי', 'עדי לוי'), true); assert.equal(core.namesLookAlike('ערן כהן', 'דנה כהן'), true); assert.equal(core.namesLookAlike('א', 'ב'), false); assert.equal(core.namesLookAlike('', 'x'), false);
  const patients = [{ id: 'p1', name: 'דנה', houseId: 'ramot', date: '2026-01-01', status: 'active' }, { id: 'p2', name: 'עדי לוי', houseId: 'rehab', date: '2026-09-10', status: 'active' }, { id: 'p3', name: 'יוסי', houseId: 'rehab', date: '2026-10-01', status: 'released' }];
  const c = core.linkCandidates(rows[0], patients);
  assert.deepEqual(c.map((x) => [x.id, x.score, x.reasons]), [['p2', 7, ['אותו בית', 'שם דומה', 'נכנס/ה לפני התשלום']], ['p3', 2, ['אותו בית']], ['p1', 1, ['נכנס/ה לפני התשלום']]]);
  const raw = { id: rows[0].paymentId, patientId: 'rehab::עדי::2026-09-14', amount: 35000, dueDate: '2026-09-14', status: 'unpaid' };
  assert.deepEqual(core.linkBody(raw, 'p2'), { action: 'savePayment', payment: Object.assign({}, raw, { linkPatientUid: 'p2', linkStatus: 'linked', linkNote: '' }) });
  assert.deepEqual(core.notPatientBody(raw, ' החזר לספק '), { action: 'savePayment', payment: Object.assign({}, raw, { linkPatientUid: '', linkStatus: 'not_a_patient', linkNote: 'החזר לספק' }) });
  assert.deepEqual(core.linkErrors('link', { patientId: '' }), { patientId: 'יש לבחור מטופל/ת' }); assert.deepEqual(core.linkErrors('link', { patientId: 'p2' }), {});
  assert.deepEqual(core.linkErrors('not', { note: 'x' }), { note: 'יש לציין סיבה (2 עד 120 תווים)' }); assert.deepEqual(core.linkErrors('not', { note: 'ספק' }), {});
  assert.equal(core.linkAccepted({ ok: true, payment: { id: raw.id, linkStatus: 'linked' } }, raw.id, 'linked'), true);
  assert.equal(core.linkAccepted({ ok: true, payment: { id: raw.id, linkStatus: '' } }, raw.id, 'linked'), false); assert.equal(core.linkAccepted({ ok: true }, raw.id, 'linked'), false);
});

test('esc escapes every HTML-significant character', () => {
  assert.equal(core.esc('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('wiring: assets hashed via ASSETS, NOT in sw.js; the shell never calls a write action; links only to the classic dashboard', () => {
  assert.match(SERVER_SRC, /'\/crm\/crm\.js': \{ file:/);
  assert.match(SERVER_SRC, /'\/crm\/crm\.css': \{ file:/);
  assert.ok(/'\/crm\/crm\.js', '\/crm\/crm\.css'/.test(SW_SRC), 'the CRM bundle is in BUNDLE_PATHS (C16)');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
  const actions = [...src.matchAll(/api\('([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(actions)], ['billingControlQueue', 'contactIndex', 'debtAging', 'getActivity', 'getCredits', 'getData', 'getPayments', 'getTasks'], 'GET reads (debtAging + getPayments: C8; getCredits: C11; getTasks: Stage 1c; contactIndex: Stage 2)');
  const writes = [...src.matchAll(/\{ action: '([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(writes)], ['appendFunder', 'completeTask', 'createTask', 'dischargePatient', 'editReceipt', 'logContact', 'moveLeadIrrelevant', 'reassignTask', 'removeLead', 'reportPayment', 'rescheduleTask', 'restoreLead', 'restorePatient', 'restorePatientToActive', 'saveAll', 'savePayment', 'setBillingDiscount', 'settleRefund', 'upsertBillingOverride', 'withdrawTask'], 'the write actions (C17: restore to active / as a lead): one-lead saveAll (C4), the lead lifecycle (C5), admission + funder (C6), discharge (C7), the strict payment report (C10), discount / amount / settle (C11), the task + contact actions (Stage 1c)');
  assert.equal((src.match(/\/api\/outpatient-lead/g) || []).length, 2, 'the outpatient handoff: after a released_outpatient discharge (manual:false) and «העבר לאמבולטורי» (manual:true)');
  assert.ok(!/serializePatients|patients: state\.data\.patients\b/.test(src), 'patients travel only through houseSaveBody (one house as read)');
  assert.ok(!/innerHTML\s*=\s*[^;]*\b(l|lead|p|pat)\.(name|phone|note)\b(?!\))/.test(src.replace(/esc\([^)]*\)/g, 'ESC')), 'every interpolated field goes through esc()');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');
  assert.match(html, /lang="he" dir="rtl"/);
  assert.match(html, /crm\/crm\.css\?v=__BUILD__/);
  assert.match(html, /crm\/crm\.js\?v=__BUILD__/);
});
