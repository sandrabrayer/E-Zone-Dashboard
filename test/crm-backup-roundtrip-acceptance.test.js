'use strict';

// Real Code.gs task/contact writers and snapshot helper; in-memory Sheets only.
// Restore below is the documented MANUAL row-copy operation into a fresh VM,
// not a native Google restore or proof of coherent/atomic nightly capture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const PROXY_SECRET = 'proxy-secret-TEST-recovery-0123456789abcdef0123';
const DAY = '2026-10-29';
const DATASETS = [
  ['Tasks', 'TASK_COLUMNS', 'dashboard-tasks-' + DAY],
  ['Activity', 'ACTIVITY_COLUMNS', 'dashboard-activity-' + DAY],
];
const plain = value => JSON.parse(JSON.stringify(value));
const sid = n => 'sub-' + String(n).padStart(32, '0');
const actor = {
  proxySecret: PROXY_SECRET, proxyAuth: 'personal', proxyUserId: 'vered',
  proxyUser: 'ורד', user: 'ורד', proxyRoles: ['staff', 'reporter', 'deleter'],
  proxyCaps: ['finance', 'billingControl'],
};

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const call = body => {
    const result = plain(g.post(Object.assign({}, body, actor)));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  return { g, call,
    tasks: () => plain(g.sheetRows('Tasks', 'TASK_COLUMNS')),
    activity: () => plain(g.sheetRows('Activity', 'ACTIVITY_COLUMNS')),
  };
}

function backupWorkbook() {
  const sheets = Object.create(null);
  return {
    sheets,
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      assert.ok(!sheets[name], 'the helper must reuse, not duplicate, a dated snapshot');
      const sh = richSheet(name, []);
      sh.clear = () => { sh.grid.length = 0; return sh; };
      sheets[name] = sh;
      return sh;
    },
  };
}

function grids(w) {
  return Object.fromEntries(DATASETS.map(([name]) => [name, plain(w.g.sandbox.__sheets[name].grid)]));
}

function capture(w, backup) {
  const original = grids(w);
  for (const [name, , snapshot] of DATASETS) {
    w.g.sandbox.integrityWriteSnapshot_(backup, snapshot, original[name]);
    assert.deepEqual(plain(backup.getSheetByName(snapshot).grid), original[name], name + ' cell values');
  }
  assert.deepEqual(grids(w), original, 'snapshot helper must not change source rows');
  return original;
}

function restoreManualCopy(backup) {
  const w = world();
  for (const [name, columns, snapshot] of DATASETS) {
    const sh = backup.getSheetByName(snapshot);
    assert.ok(sh, 'both datasets are required for this acceptance scenario');
    const grid = plain(sh.grid);
    assert.deepEqual(grid[0], Array.from(w.g.run(columns)), name + ' header order');
    const target = richSheet(name, []);
    target.getRange(1, 1, grid.length, grid[0].length).setValues(grid);
    w.g.sandbox.__sheets[name] = target;
  }
  return w;
}

function seeded() {
  const w = world();
  const create = { action: 'createTask', submissionId: sid(101), task: {
    kind: 'call', leadId: 'SYNTHETIC-L1', houseId: 'ramot', title: 'SYNTHETIC CALL',
    reason: 'SYNTHETIC REASON', assignee: 'ורד', dueDate: '2026-11-04', dueTime: '10:30',
  } };
  const first = w.call(create).task;
  w.call({ action: 'rescheduleTask', id: first.id, dueDate: '2026-11-10', dueTime: '09:00' });
  w.call({ action: 'reassignTask', id: first.id, assignee: 'דנה' });
  const window = w.call({ action: 'createTask', submissionId: sid(102), task: {
    kind: 'review', patientId: 'SYNTHETIC-P1', title: 'SYNTHETIC WINDOW',
    windowStart: '2026-11-02', windowEnd: '2026-11-06', assignee: 'דנה',
  } }).task;
  const done = w.call({ action: 'createTask', submissionId: sid(103), task: {
    kind: 'call', leadId: 'SYNTHETIC-L2', title: 'SYNTHETIC COMPLETED',
  } }).task;
  w.call({ action: 'completeTask', id: done.id, outcome: 'SYNTHETIC COMPLETE' });
  const cancelled = w.call({ action: 'createTask', submissionId: sid(104), task: {
    kind: 'call', leadId: 'SYNTHETIC-L3', title: 'SYNTHETIC CANCELLED',
  } }).task;
  w.call({ action: 'withdrawTask', id: cancelled.id, reason: 'SYNTHETIC CANCELLATION' });
  const contact = { action: 'logContact', submissionId: sid(105), contact: {
    leadId: 'SYNTHETIC-L1', channel: 'phone', outcome: 'call_back_later',
    summary: 'SYNTHETIC CONTACT ONLY',
  }, next: { kind: 'call', dueDate: '2026-11-12', dueTime: '11:00', assignee: 'דנה' } };
  const follow = w.call(contact).created;
  assert.ok(follow && follow.id);
  return { w, create, contact, first, window, done, cancelled, follow };
}

test('CRM backup round trip: actual snapshots preserve Tasks/Activity fields, history and replay identities in a fresh runtime', () => {
  const s = seeded(), backup = backupWorkbook();
  const before = capture(s.w, backup);
  const restored = restoreManualCopy(backup);
  assert.deepEqual(grids(restored), before, 'all headers and every cell survive the manual copy');
  const tasks = restored.tasks(), events = restored.activity();
  assert.equal(tasks.length, 5);
  const byId = Object.fromEntries(tasks.map(row => [row.id, row]));
  assert.equal(byId[s.first.id].assignee, 'דנה');
  assert.equal(byId[s.first.id].dueDate, '2026-11-10');
  assert.equal(byId[s.first.id].dueTime, '09:00');
  assert.equal(byId[s.first.id].submissionId, sid(101));
  assert.equal(byId[s.window.id].windowStart, '2026-11-02');
  assert.equal(byId[s.window.id].windowEnd, '2026-11-06');
  assert.equal(byId[s.done.id].status, 'done');
  assert.equal(byId[s.cancelled.id].status, 'cancelled');
  assert.equal(byId[s.follow.id].contactEventId, 'contact:' + sid(105));
  assert.ok(events.some(e => e.eventId === byId[s.follow.id].contactEventId && e.kind === 'contact_logged'));
  const history = events.filter(e => e.kind === 'task_rescheduled').map(e => JSON.parse(e.detailsJson));
  assert.equal(history.length, 1);
  assert.equal(history[0].prev.dueDate, '2026-11-04');
  assert.equal(history[0].next.dueDate, '2026-11-10');
  assert.ok(events.some(e => e.kind === 'task_reassigned'));
  assert.ok(events.every(e => e.actorName === 'ורד'));
  // Retry original requests against a new runtime, not remembered process state.
  assert.equal(restored.call(s.create).replayed, true);
  assert.equal(restored.call(s.contact).replayed, true);
  assert.deepEqual(grids(restored), before, 'replays do not duplicate or reset tasks/history');
  assert.deepEqual(grids(s.w), before, 'original source remains unchanged');
});

test('CRM snapshot helper: same-day replacement keeps one tab per dataset; header-only and missing sources remain distinct', () => {
  const s = seeded(), backup = backupWorkbook();
  const populated = capture(s.w, backup);
  capture(s.w, backup);
  assert.equal(Object.keys(backup.sheets).length, 2);
  const empty = world();
  for (const [name, columns] of DATASETS) {
    empty.g.sandbox.__sheets[name] = richSheet(name, Array.from(empty.g.run(columns)));
  }
  const headerOnly = capture(empty, backup);
  assert.equal(Object.keys(backup.sheets).length, 2, 'no duplicate or residual dated tabs');
  for (const [name, , snapshot] of DATASETS) {
    assert.equal(backup.sheets[snapshot].grid.length, 1, 'old data rows are cleared');
    assert.deepEqual(plain(backup.sheets[snapshot].grid), headerOnly[name]);
  }
  const restored = restoreManualCopy(backup);
  assert.deepEqual(restored.tasks(), []);
  assert.deepEqual(restored.activity(), []);
  const absent = world();
  assert.equal(Object.hasOwn(absent.g.sandbox.__sheets, 'Tasks'), false);
  assert.equal(Object.hasOwn(absent.g.sandbox.__sheets, 'Activity'), false);
  assert.equal(Object.hasOwn(restored.g.sandbox.__sheets, 'Tasks'), true);
  assert.equal(Object.hasOwn(restored.g.sandbox.__sheets, 'Activity'), true);
  assert.deepEqual(grids(s.w), populated, 'separate source is untouched by replacement');
});
