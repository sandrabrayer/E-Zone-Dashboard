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

test('esc escapes every HTML-significant character', () => {
  assert.equal(core.esc('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('wiring: assets hashed via ASSETS, NOT in sw.js; the shell never calls a write action; links only to the classic dashboard', () => {
  assert.match(SERVER_SRC, /'\/crm\/crm\.js': \{ file:/);
  assert.match(SERVER_SRC, /'\/crm\/crm\.css': \{ file:/);
  assert.doesNotMatch(SW_SRC, /crm\//);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
  const actions = [...src.matchAll(/api\('([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(actions)], ['billingControlQueue', 'getActivity', 'getData'], 'GET reads');
  const writes = [...src.matchAll(/\{ action: '([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(writes)], ['appendFunder', 'moveLeadIrrelevant', 'removeLead', 'restoreLead', 'saveAll'], 'the write actions: one-lead saveAll (C4), the lead lifecycle (C5), admission + funder (C6)');
  assert.ok(!/serializePatients|patients: state\.data\.patients\b/.test(src), 'patients travel only through houseSaveBody (one house as read)');
  assert.ok(!/innerHTML\s*=\s*[^;]*\b(l|lead|p|pat)\.(name|phone|note)\b(?!\))/.test(src.replace(/esc\([^)]*\)/g, 'ESC')), 'every interpolated field goes through esc()');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');
  assert.match(html, /lang="he" dir="rtl"/);
  assert.match(html, /crm\/crm\.css\?v=__BUILD__/);
  assert.match(html, /crm\/crm\.js\?v=__BUILD__/);
});
