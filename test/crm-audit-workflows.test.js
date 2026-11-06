'use strict';

// Synthetic acceptance regressions for R3 / R4 / R7, 06 Nov 2026.
// No source writes, network or patient data. The UI test runs the real boot,
// render and delegated click handlers against a minimal in-memory DOM adapter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/crm/crm.js');
const TODAY = '2026-11-06';
const ME = { view: 'full', finance: true, user: 'ורד' };
const INDEX = { ok: true, leads: {}, patients: {}, flags: {} };
const PAYMENTS = { ok: true, receipts: [] };
const lead = (id, extra) => Object.assign({ id, name: 'Synthetic ' + id, house: 'ramot', stage: 'visit', visitDate: '2026-11-01', assignedTo: 'ורד' }, extra);
const data = (leads = []) => ({ ok: true, leads, patients: {}, dischargedPatients: [], irrelevantLeads: [], removedLeads: [] });
const task = (kind, extra) => Object.assign({ id: 'task-' + kind, kind, status: 'open', source: 'manual', leadId: 'L1', title: 'Synthetic task', assignee: 'ורד', dueDate: '2026-11-05' }, extra);
function day(leads, tasks = [], filters = {}, debt = { ok: true, byPatient: [] }, me = ME, index = INDEX) {
  return core.myDay(core.compute(data(leads), TODAY), tasks, index, debt, TODAY, me, filters, PAYMENTS);
}

test('R3: debt cycles remain visible for Vered; house and finance scopes still apply without mutating source', () => {
  const debt = { ok: true, byPatient: Array.from({ length: 77 }, (_, i) => ({ patientId: 'P' + i, name: 'Synthetic P' + i, houseId: i === 0 ? 'pardes' : 'ramot', cycles: [{ start: '2026-10-01', end: '2026-10-31', balance: 100, expected: 100, received: 0, kind: 'recorded' }] })) };
  const before = JSON.stringify(debt);
  const all = day([], [], {}, debt).byDomain.collection;
  const mine = day([], [], { owner: 'ורד' }, debt).byDomain.collection;
  assert.equal(mine.length, 77);
  assert.deepEqual(mine.map(r => r.id), all.map(r => r.id));
  assert.ok(mine.every(r => r.owner === 'ורד'));
  assert.equal(day([], [], { owner: 'ורד', house: 'pardes' }, debt).byDomain.collection.length, 1);
  assert.equal(day([], [], { owner: 'דנה' }, debt).byDomain.collection.length, 0);
  assert.equal(day([], [], {}, debt, { view: 'ops', finance: false, user: 'דנה' }).byDomain.collection.length, 0);
  assert.equal(JSON.stringify(debt), before);
});

test('R3: manually assigned collection tasks retain their actual owner', () => {
  const tasks = [task('collection', { assignee: 'דנה' })];
  assert.equal(day([lead('L1')], tasks, { owner: 'ורד' }).byDomain.collection.length, 0);
  assert.equal(day([lead('L1')], tasks, { owner: 'דנה' }).byDomain.collection[0].owner, 'דנה');
});

test('R4: cancellation from either entry path yields one follow-up without a stored task', () => {
  const l = lead('L1', { meetingOutcome: 'cancelled' });
  const index = { ...INDEX, flags: { L1: { meetingChange: { change: 'cancelled', prevDate: l.visitDate } } } };
  for (const idx of [INDEX, index]) {
    const tasks = [];
    const m = day([l], tasks, {}, undefined, ME, idx);
    assert.deepEqual(m.byDomain.followup.map(r => r.kind), ['meeting_cancelled']);
    assert.equal(m.byDomain.meetings.length, 0);
    assert.deepEqual(tasks, []);
  }
});

test('R4: an open or deferred callback / meeting is the single next action; completed tasks do not hide unresolved cancellation', () => {
  const l = lead('L1', { meetingOutcome: 'cancelled' });
  for (const kind of ['call', 'meeting']) {
    for (const dueDate of ['2026-11-05', '2026-11-12']) {
      const m = day([l], [task(kind, { dueDate })]);
      assert.equal(m.byDomain.followup.filter(r => r.kind === 'meeting_cancelled').length, 0);
      assert.equal(Object.values(m.byDomain).flat().filter(r => r.kind === 'task').length, 1);
    }
    assert.equal(day([l], [task(kind, { status: 'done' })]).byDomain.followup.length, 1);
    assert.equal(day([l], [task(kind, { status: 'cancelled' })]).byDomain.followup.length, 1);
  }
  assert.equal(day([l], [task('review')]).byDomain.followup.length, 1, 'unrelated document review does not arrange contact');
  assert.equal(day([lead('L1', { visitDate: '2026-11-12', meetingOutcome: '' })]).byDomain.followup.length, 0);
  assert.equal(day([lead('L1', { stage: 'irrelevant', meetingOutcome: 'cancelled' })]).byDomain.followup.length, 0);
});

function controlLeads() {
  return [
    ...Array.from({ length: 3 }, (_, i) => lead('UNREAD' + i, { meetingReportedAt: '2026-11-02T10:00:00Z' })),
    ...Array.from({ length: 14 }, (_, i) => lead('DECIDE' + i, { meetingReportedAt: '2026-11-02T10:00:00Z', meetingSeen: '1' })),
    ...Array.from({ length: 8 }, (_, i) => lead('MISSING' + i)),
    lead('HISTORIC', { visitDate: '2026-05-01' }),
    lead('UNSCHEDULED', { visitDate: '' })
  ];
}

test('R7: three unread reports drill into precisely three, distinct from fourteen decisions and eight absent reports', () => {
  const m = day(controlLeads());
  assert.equal(m.byDomain.followup.length, 25);
  const q = core.workControlQueues(m);
  assert.equal(q.unseen.length, 3);
  assert.ok(q.unseen.every(r => r.subjectId.startsWith('UNREAD')));
  assert.equal(q.undecided.length, 14);
  assert.equal(q.awaitingReport.length, 8);
  assert.equal(q.unscheduled.length, 1);
  assert.ok(!Object.values(q).flat().some(r => r.subjectId === 'HISTORIC'));
  assert.equal(core.workControlQueues(day(controlLeads(), [], { owner: 'דנה' })).unseen.length, 0);
  assert.equal(core.workControlQueues(day(controlLeads(), [], { house: 'pardes' })).unseen.length, 0);
});

test('R7: late tasks include call, review and collection exactly once, exclude future/done and respect finance permission', () => {
  const tasks = ['call', 'review', 'collection'].map(k => task(k));
  tasks.push(task('call', { id: 'future', dueDate: '2026-11-12' }), task('review', { id: 'done', status: 'done' }));
  assert.deepEqual(core.workControlQueues(day([lead('L1')], tasks)).late.map(r => r.task.kind).sort(), ['call', 'collection', 'review']);
  assert.equal(core.workControlQueues(day([lead('L1')], tasks, {}, undefined, { view: 'ops', finance: false, user: 'דנה' })).late.length, 2);
});

test('R7 UI: actual card target, click handler, exact list and return navigation agree without a write', async () => {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { innerHTML: '', textContent: '', value: '', handlers: {}, dataset: {},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; } });
    return nodes.get(key);
  };
  const doc = { querySelector: node, querySelectorAll: () => [], addEventListener() {} };
  const requests = [];
  const win = { fetch: async (url, options) => {
    requests.push({ url, options });
    assert.notEqual(options && options.method, 'POST', 'view navigation must not write');
    const action = new URL(url, 'https://synthetic.invalid').searchParams.get('action');
    const value = url === '/api/me' ? ME : ({ getData: data(controlLeads()), getTasks: { ok: true, tasks: [] }, contactIndex: INDEX, debtAging: { ok: true, byPatient: [] }, getPayments: PAYMENTS })[action];
    assert.ok(value, 'unexpected read ' + url);
    return { ok: true, json: async () => value };
  }, localStorage: { getItem: () => null } };
  const app = core.boot(win, doc);
  // Settle the actual boot's chained read/render promises.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.error, '');
  app.state.today = TODAY;
  app.setArea('control');
  const html = node('#crm-main').innerHTML;
  const target = [...html.matchAll(/data-go="([^"]+)"/g)].map(m => JSON.parse(m[1].replace(/&quot;/g, '"'))).find(g => g.workControl === 'unseen');
  assert.ok(target, 'the displayed card must carry its exact queue target');
  function click(dataset) {
    const el = { dataset, closest: selector => selector.includes('[data-go]') ? el : null };
    for (const fn of node('#crm-root').handlers.click || []) fn({ target: el, preventDefault() {} });
  }
  click({ go: JSON.stringify(target) });
  assert.equal(app.state.area, 'today');
  assert.match(node('#crm-main').innerHTML, /data-control-section="unseen"/);
  for (let i = 0; i < 3; i++) assert.ok(node('#crm-main').innerHTML.includes('Synthetic UNREAD' + i));
  assert.ok(!node('#crm-main').innerHTML.includes('Synthetic DECIDE'));
  assert.ok(!node('#crm-main').innerHTML.includes('Synthetic MISSING'));
  click({ domain: '' });
  assert.equal(app.state.workControl, '');
  assert.ok(!node('#crm-main').innerHTML.includes('data-control-section="unseen"'));
  click({ domain: 'followup' });
  assert.ok(node('#crm-main').innerHTML.includes('Synthetic DECIDE'));
  assert.ok(requests.length > 0);
});
