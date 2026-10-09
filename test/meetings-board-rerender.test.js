/* Regression tests for CHANGELOG-meetings-board-rerender.md — the «לוח פגישות»
 * board must reflect a lead's visit the moment it changes, and on every entry
 * into the tab.
 *
 * Stale paths covered (one test group each):
 *   A. inline lead-card fields (date / time / «נפגש עם») → updateLead never
 *      re-rendered the board on the optimistic write or on the confirmed save;
 *   B. tab entry rendered the board only as the 5th step of renderAll — a throw
 *      in any renderer before it left the board showing old data;
 *   C. the visible week was fixed at first render — a page left open across
 *      Saturday night kept showing last week on entry;
 *   D. a change arriving while the same field's save was in flight was DROPPED
 *      (withFieldSaving busy guard): typing a date left the lead, the sheet and
 *      the board on an intermediate value;
 *   E. the tab badge is refreshed with the board.
 *
 * The real public/app.js runs in a vm with a DOM-less document; the network
 * (saveAllProvingLead) and every renderer except the board are stubbed. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
  };
}

function loadPage(opts) {
  const o = opts || {};
  const noop = () => {};
  const handlers = {};
  const board = {
    _html: '', renders: 0,
    set innerHTML(v) { this._html = v; this.renders++; }, get innerHTML() { return this._html; },
    querySelector(sel) {
      const m = /data-mtg="(\w+)"/.exec(sel);
      return { set onclick(fn) { if (m) handlers[m[1]] = fn; } };
    },
    querySelectorAll() { return []; },
    classList: fakeClassList(),
  };
  const badge = { textContent: '', classList: fakeClassList() };
  const tabs = ['dashboard', 'leads', 'meetings'].map(screen => ({ dataset: { screen }, classList: fakeClassList(), onclick: null }));
  const screens = {};
  ['dashboard', 'leads', 'meetings'].forEach(s => { screens['screen-' + s] = { classList: fakeClassList() }; });
  const byId = Object.assign({
    'meetings-board': board,
    'meetings-unseen-badge': badge,
    'lead-search': { addEventListener: noop },
  }, screens);
  const sandbox = {
    console: { log: noop, warn: noop, info: noop, error: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '' },
    document: {
      addEventListener: noop,
      // initTabs wires a few more controls (search boxes …): any other id gets
      // an inert element.
      getElementById: (id) => byId[id] || (byId[id] = { addEventListener: noop, classList: fakeClassList(), style: {} }),
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.tabs .tab' ? tabs : []),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* Stub the network and every renderer renderAll calls except the board, so
   * the real updateLead / renderAll / initTabs / renderMeetings run. */
  const others = ['renderDashboard', 'renderCoordinatorDischarges', 'renderKanban', 'renderPatientsTab',
    'renderIrrelevantLeads', 'renderRemovedLeads', 'renderHouseTabs', 'renderPatients',
    'renderDischargedPatients', 'renderBilling', 'renderCreditsPayouts', 'renderMonthlyRevenue',
    'renderReconnect', 'renderBreakeven', 'renderGrowthGraph', 'renderBillingControl'];
  vm.runInContext(APP_SRC + `
    ${others.map(f => `${f} = () => { if (globalThis.__throwIn === '${f}') throw new Error('boom in ${f}'); };`).join('\n')}
    autosaveMeetingWithDefaults = () => Promise.resolve();
    showError = (m) => { globalThis.__errors.push(m); };
    saveAllProvingLead = (id) => globalThis.__save(id);
    globalThis.__test = { state, updateLead, saveInlineLeadField, renderMeetings, renderAll, initTabs,
      normalizeLead, touchesMeetingsBoard, enterMeetingsTab, weekStartSunday, todayISO };`, sandbox);
  sandbox.__errors = [];
  sandbox.__save = o.save || (() => Promise.resolve({ ok: true }));
  const app = sandbox.__test;
  app.state.mode = 'edit';
  app.state.houseManagers = {};
  app.state.managerPhones = {};
  return { sandbox, app, board, badge, tabs, handlers };
}

function visitLead(over) {
  return Object.assign({ id: 'tomer', name: 'תומר', house: 'רעננה הפרדס', stage: 'visit',
    visitDate: '', visitTime: '', meetingWith: '' }, over || {});
}
const onBoard = (board, name) => board.innerHTML.includes(name);

/* ===== A. inline card fields → the board, optimistic and confirmed ===== */

test('A: an inline visit date shows on the board BEFORE the save answers, and stays after it', async () => {
  const d = deferred();
  const { app, board } = loadPage({ save: () => d.promise });
  app.state.leads = [app.normalizeLead(visitLead({ visitTime: '14:00', meetingWith: 'חן' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.ok(!onBoard(board, 'תומר'), 'no visit yet');

  const p = app.updateLead('tomer', { visitDate: '2026-10-11' });
  assert.ok(onBoard(board, 'תומר'), 'optimistic: on the board while the save is in flight');
  d.resolve({ ok: true });
  assert.strictEqual(await p, true);
  assert.ok(onBoard(board, 'תומר'), 'confirmed: still on the board');
});

test('A: changing the visit time / «נפגש עם» inline re-renders the board row', async () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: '2026-10-11', visitTime: '14:00', meetingWith: 'חן' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  await app.updateLead('tomer', { visitTime: '16:30' });
  assert.ok(board.innerHTML.includes('16:30') && !board.innerHTML.includes('14:00'));
  await app.updateLead('tomer', { meetingWith: 'עידו' });
  assert.ok(board.innerHTML.includes('עידו'));
});

test('A: moving the visit to another week moves it on the board at once', async () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: '2026-10-07', visitTime: '10:00' }))];
  app.state.meetingsWeekStart = '2026-10-04';
  app.renderMeetings();
  assert.ok(onBoard(board, 'תומר'));
  await app.updateLead('tomer', { visitDate: '2026-10-11' });
  assert.ok(!onBoard(board, 'תומר'), 'gone from 04/10–10/10');
});

test('A: a failed save rolls the board back (no phantom visit)', async () => {
  const { sandbox, app, board } = loadPage({ save: () => Promise.reject(new Error('network')) });
  app.state.leads = [app.normalizeLead(visitLead())];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.strictEqual(await app.updateLead('tomer', { visitDate: '2026-10-11' }), false);
  assert.strictEqual(app.state.leads[0].visitDate, '');
  assert.ok(!onBoard(board, 'תומר'), 'rolled back off the board');
  assert.strictEqual(sandbox.__errors.length, 1);
});

test('A: a non-board field (note) does not re-render the board', async () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: '2026-10-11' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  const before = board.renders;
  await app.updateLead('tomer', { note: 'הערה' });
  assert.strictEqual(board.renders, before);
  assert.strictEqual(app.touchesMeetingsBoard({ visitDate: 'x' }), true);
  assert.strictEqual(app.touchesMeetingsBoard({ meetingOutcome: 'x' }), false);
  assert.strictEqual(app.touchesMeetingsBoard(null), false);
});

test('A: a board render error never turns a saved lead into a failed one', async () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead())];
  app.state.meetingsWeekStart = '2026-10-11';
  Object.defineProperty(board, 'innerHTML', { set() { throw new Error('render boom'); }, get() { return ''; } });
  assert.strictEqual(await app.updateLead('tomer', { visitDate: '2026-10-11' }), true);
  assert.strictEqual(app.state.leads[0].visitDate, '2026-10-11', 'kept — no rollback');
});

/* ===== B. tab entry always renders the board ===== */

test('B: entering «לוח פגישות» renders the board even when an earlier renderer throws', () => {
  const { sandbox, app, board, tabs } = loadPage();
  app.initTabs();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: app.todayISO(), visitTime: '09:00' }))];
  sandbox.__throwIn = 'renderKanban';   // renderAll dies before it reaches renderMeetings
  const meetingsTab = tabs.find(t => t.dataset.screen === 'meetings');
  assert.throws(() => meetingsTab.onclick(), /boom in renderKanban/);
  assert.strictEqual(app.state.currentScreen, 'meetings');
  assert.ok(onBoard(board, 'תומר'), 'the board shows the current leads anyway');
});

test('B: entering «לוח פגישות» re-renders from the CURRENT state.leads', () => {
  const { app, board, tabs } = loadPage();
  app.initTabs();
  app.state.leads = [];
  app.state.meetingsWeekStart = app.weekStartSunday(app.todayISO());
  app.renderMeetings();
  assert.ok(!onBoard(board, 'תומר'));
  // A visit lands in state while the user is elsewhere (no board render).
  app.state.leads.push(app.normalizeLead(visitLead({ visitDate: app.todayISO(), visitTime: '09:00' })));
  tabs.find(t => t.dataset.screen === 'meetings').onclick();
  assert.ok(onBoard(board, 'תומר'));
});

/* ===== C. the week follows today unless the user navigated ===== */

test('C: tab entry re-anchors a stale auto-chosen week on the current week', () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: app.todayISO(), visitTime: '09:00' }))];
  app.state.meetingsWeekStart = '2026-01-04';   // the week the page was opened in, long ago
  app.state.meetingsWeekPinned = false;
  app.enterMeetingsTab();
  assert.strictEqual(app.state.meetingsWeekStart, app.weekStartSunday(app.todayISO()));
  assert.ok(onBoard(board, 'תומר'));
});

test('C: a week the user navigated to is kept on tab entry; «השבוע» unpins it', () => {
  const { app, handlers } = loadPage();
  app.state.leads = [];
  app.state.meetingsWeekStart = '';
  app.renderMeetings();
  const thisWeek = app.state.meetingsWeekStart;
  handlers.next();
  assert.strictEqual(app.state.meetingsWeekPinned, true);
  const navigated = app.state.meetingsWeekStart;
  assert.notStrictEqual(navigated, thisWeek);
  app.enterMeetingsTab();
  assert.strictEqual(app.state.meetingsWeekStart, navigated, 'kept');
  handlers.today();
  assert.strictEqual(app.state.meetingsWeekPinned, false);
  assert.strictEqual(app.state.meetingsWeekStart, thisWeek);
  handlers.prev();
  assert.strictEqual(app.state.meetingsWeekPinned, true);
});

/* ===== D. a change during an in-flight save is not dropped ===== */

function fakeInput(field, value) {
  const attrs = {};
  return {
    dataset: { field }, value, parentNode: null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
  };
}

test('D: typing a date (several changes during one save) ends on the LAST value — lead, sheet and board', async () => {
  const saves = [];
  const pending = [];
  const { app, board } = loadPage({ save: () => { const d = deferred(); pending.push(d); return d.promise; } });
  app.state.leads = [app.normalizeLead(visitLead({ visitTime: '14:00' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  const lead = app.state.leads[0];
  /* In-range values: since CHANGELOG-visit-date-guard.md an out-of-range year
   * (0002 / 0020) is never sent at all — see test/visit-date-guard.test.js. */
  const inp = fakeInput('visitDate', '2026-10-01');            // first value, save in flight
  const first = app.saveInlineLeadField(inp, lead);
  await tick();
  assert.strictEqual(pending.length, 1);
  saves.push(lead.visitDate);
  inp.value = '2026-10-10'; app.saveInlineLeadField(inp, lead);  // busy → was dropped
  inp.value = '2026-10-11'; app.saveInlineLeadField(inp, lead);
  await tick();
  assert.strictEqual(pending.length, 1, 'one save at a time');
  pending[0].resolve({ ok: true });
  await tick();
  assert.strictEqual(pending.length, 2, 'the newer value is saved after the first save');
  saves.push(lead.visitDate);
  pending[1].resolve({ ok: true });
  assert.strictEqual(await first, true);
  assert.deepStrictEqual(saves, ['2026-10-01', '2026-10-11']);
  assert.strictEqual(lead.visitDate, '2026-10-11');
  assert.ok(onBoard(board, 'תומר'), 'on the board in week 11/10–17/10');
});

test('D: one change saves once (no follow-up save when the value did not move)', async () => {
  let n = 0;
  const { app } = loadPage({ save: () => { n++; return Promise.resolve({ ok: true }); } });
  app.state.leads = [app.normalizeLead(visitLead())];
  const inp = fakeInput('visitTime', '10:15');
  assert.strictEqual(await app.saveInlineLeadField(inp, app.state.leads[0]), true);
  assert.strictEqual(n, 1);
  assert.strictEqual(app.state.leads[0].visitTime, '10:15');
});

test('D: a failed save is not retried by the follow-up check', async () => {
  let n = 0;
  const { app } = loadPage({ save: () => { n++; return Promise.reject(new Error('down')); } });
  app.state.leads = [app.normalizeLead(visitLead())];
  const inp = fakeInput('visitDate', '2026-10-11');
  assert.strictEqual(await app.saveInlineLeadField(inp, app.state.leads[0]), false);
  assert.strictEqual(n, 1);
});

/* ===== E. the tab badge moves with the board ===== */

test('E: an unseen manager report on a lead updates the tab badge when the board refreshes', async () => {
  const { app, badge } = loadPage();
  app.state.leads = [app.normalizeLead(visitLead({ visitDate: '2026-10-11', meetingReportedAt: '2026-10-11T12:00:00Z', meetingReportOutcome: 'thinking' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.strictEqual(badge.textContent, '1');
  assert.strictEqual(badge.classList.contains('hidden'), false);
  app.state.leads[0].meetingSeen = '1';
  await app.updateLead('tomer', { visitTime: '10:00' });   // a board write → board + badge refresh
  assert.strictEqual(badge.textContent, '0');
  assert.strictEqual(badge.classList.contains('hidden'), true);
});
