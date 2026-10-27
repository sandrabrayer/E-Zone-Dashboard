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
  assert.deepEqual(core.areasFor({ view: 'full', finance: true }), ['today', 'leads', 'clients', 'calendar', 'billing', 'control']);
  assert.deepEqual(core.areasFor({ view: 'controller', finance: false }), ['today', 'billing', 'control']);
  assert.deepEqual(core.areasFor({ view: 'restricted', finance: false }), ['today', 'leads', 'clients', 'calendar', 'control']);
  assert.deepEqual(core.areasFor(null), ['today', 'leads', 'clients', 'calendar', 'control']);
});

test('HOUSES / STAGES mirror app.js (ids and labels)', () => {
  for (const h of core.HOUSES) assert.ok(APP_SRC.includes(`id: '${h.id}'`) && APP_SRC.includes(h.name), h.id);
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

test('control metrics and the controller day counts', () => {
  const c = core.compute(DATA, TODAY);
  assert.deepEqual(core.control(c, TODAY).map((m) => [m.id, m.value]), [['untouched', 1], ['late', 2], ['noOutcome', 1], ['unscheduled', 1], ['admitting', 1]]);
  assert.deepEqual(core.controllerDay({ receipts: [{ status: 'reported' }, { status: 'reported' }, { status: 'flagged' }, { status: 'confirmed' }] }), { toVerify: 2, flagged: 1, confirmed: 1, total: 4 });
  assert.deepEqual(core.controllerDay(null), { toVerify: 0, flagged: 0, confirmed: 0, total: 0 });
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
  assert.deepEqual([...new Set(actions)], ['billingControlQueue', 'getActivity', 'getData'], 'reads only');
  assert.doesNotMatch(src, /method:\s*'POST'/);
  assert.ok(!/innerHTML\s*=\s*[^;]*\b(l|lead|p|pat)\.(name|phone|note)\b(?!\))/.test(src.replace(/esc\([^)]*\)/g, 'ESC')), 'every interpolated field goes through esc()');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.html'), 'utf8');
  assert.match(html, /lang="he" dir="rtl"/);
  assert.match(html, /crm\/crm\.css\?v=__BUILD__/);
  assert.match(html, /crm\/crm\.js\?v=__BUILD__/);
});
