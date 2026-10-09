/* Regression tests for CHANGELOG-meetings-board-fixes.md.
 *
 *   1. «לוח פגישות» week arrows follow the lead-card RTL convention
 *      («שלב קודם →» / «← שלב הבא»): previous week points RIGHT, next week
 *      points LEFT, in the same source order (back first). Behavior unchanged.
 *   2. A lead with a scheduled visit appears in its week — on the week-boundary
 *      days (Sunday / Saturday) and when the Sheets cell arrives as a Date
 *      object, a UTC timestamp, a date serial or a hand-typed DD/MM/YYYY.
 *
 * TZ is pinned to UTC on purpose: a device outside Israel time is exactly the
 * case where a date-typed visitDate (2026-10-10T21:00:00.000Z = Sunday 11/10 in
 * Israel) used to land on Saturday 10/10 and drop out of its week. The board
 * must read the visit day in Asia/Jerusalem whatever the device says.
 * (test/meetings-board.test.js covers the same bucketing under Asia/Jerusalem.) */

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* app.js in a vm with a DOM-less document. The meetings board element records
 * its innerHTML and the nav buttons' click handlers so the arrows can be
 * checked for both label and behavior. */
function loadApp() {
  const noop = () => {};
  const handlers = {};
  const board = {
    _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelector(sel) {
      const m = /data-mtg="(\w+)"/.exec(sel);
      return { set onclick(fn) { if (m) handlers[m[1]] = fn; } };
    },
    querySelectorAll() { return []; },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '' },
    document: {
      addEventListener: noop,
      getElementById: (id) => (id === 'meetings-board' ? board : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = { meetingsForWeek, normalizeLead, leadVisitDateISO, renderMeetings,
      normalizeCurrentManagers, rosterFromCurrentManagers, state };`, sandbox);
  return { app: sandbox.__test, board, handlers };
}

const { app, board, handlers } = loadApp();

function lead(over) {
  return app.normalizeLead(Object.assign(
    { id: 'x', name: 'ליד', house: 'pardes', stage: 'visit', visitDate: '', visitTime: '', meetingWith: '' },
    over || {}));
}
const idsOf = wk => Array.from(wk.days).flatMap(d => Array.from(d.timed).concat(Array.from(d.noTime))).map(m => m.id).sort();

/* ===== BUG 1 — RTL week arrows ===== */

function navButtons() {
  app.state.leads = [];
  app.state.meetingsWeekStart = '2026-10-04';
  app.renderMeetings();
  const html = board.innerHTML;
  const btn = name => {
    const m = new RegExp(`<button[^>]*data-mtg="${name}"[^>]*>([^<]*)</button>`).exec(html);
    return m ? { label: m[1], at: m.index } : null;
  };
  return { prev: btn('prev'), today: btn('today'), next: btn('next') };
}

test('arrows: previous week points RIGHT, next week points LEFT (lead-card convention)', () => {
  const b = navButtons();
  assert.strictEqual(b.prev.label, 'שבוע קודם →');
  assert.strictEqual(b.next.label, '← שבוע הבא');
  assert.strictEqual(b.today.label, 'השבוע');
});

test('arrows: the same markup shape as the lead-card «שלב קודם →» / «← שלב הבא»', () => {
  // The lead card's buttons, read from the same source — the board must mirror them.
  assert.ok(APP_SRC.includes('>שלב קודם →</button>'), 'lead-card back label');
  assert.ok(APP_SRC.includes("'← שלב הבא'"), 'lead-card next label');
  const b = navButtons();
  assert.ok(b.prev.label.endsWith(' →'), 'back: text first, arrow last');
  assert.ok(b.next.label.startsWith('← '), 'forward: arrow first, text last');
  // Same source order as the lead card: back before forward.
  assert.ok(b.prev.at < b.today.at && b.today.at < b.next.at);
  // The old, reversed labels are gone.
  assert.ok(!board.innerHTML.includes('← שבוע קודם'));
  assert.ok(!board.innerHTML.includes('שבוע הבא →'));
});

test('arrows: behavior unchanged — prev goes back 7 days, next forward 7, השבוע resets', () => {
  navButtons();
  handlers.prev();
  assert.strictEqual(app.state.meetingsWeekStart, '2026-09-27');
  handlers.next();
  handlers.next();
  assert.strictEqual(app.state.meetingsWeekStart, '2026-10-11');
});

/* ===== BUG 2 — a lead with a scheduled visit appears in its week ===== */

test('leadVisitDateISO: every Sheets shape of Sunday 11/10/2026 reads as 2026-10-11', () => {
  const sunday = '2026-10-11';
  assert.strictEqual(app.leadVisitDateISO('2026-10-11'), sunday);                  // canonical text
  assert.strictEqual(app.leadVisitDateISO(new Date('2026-10-10T21:00:00.000Z')), sunday); // Date object (IL midnight)
  assert.strictEqual(app.leadVisitDateISO('2026-10-10T21:00:00.000Z'), sunday);    // serialized Date cell
  assert.strictEqual(app.leadVisitDateISO('2026-10-11T00:00:00+03:00'), sunday);
  assert.strictEqual(app.leadVisitDateISO(46306), sunday);                         // date serial
  assert.strictEqual(app.leadVisitDateISO('46306'), sunday);
  assert.strictEqual(app.leadVisitDateISO('11/10/2026'), sunday);                  // day-first, not Nov 10
  assert.strictEqual(app.leadVisitDateISO('11.10.2026'), sunday);
  assert.strictEqual(app.leadVisitDateISO('2026-10-11T14:00'), sunday);            // tz-less wall clock
});

test('leadVisitDateISO: blanks and non-dates never become a visit', () => {
  assert.strictEqual(app.leadVisitDateISO(''), '');
  assert.strictEqual(app.leadVisitDateISO(null), '');
  assert.strictEqual(app.leadVisitDateISO(undefined), '');
  assert.strictEqual(app.leadVisitDateISO(new Date('nope')), '');
  assert.strictEqual(app.leadVisitDateISO(5), '');            // not a plausible serial
  assert.strictEqual(app.leadVisitDateISO('31/02/2026'), ''); // impossible day
});

test('תומר: visit 11/10/2026 14:00 (Sunday, week start) with חן appears in week 11/10–17/10 only', () => {
  const shapes = ['2026-10-11', new Date('2026-10-10T21:00:00.000Z'), '2026-10-10T21:00:00.000Z', 46306, '11/10/2026'];
  shapes.forEach(visitDate => {
    const tomer = lead({ id: 'tomer', name: 'תומר', house: 'רעננה הפרדס', visitDate, visitTime: '14:00', meetingWith: 'חן' });
    const wk = app.meetingsForWeek([tomer], '2026-10-11');
    assert.strictEqual(wk.weekStart, '2026-10-11');
    assert.strictEqual(wk.weekEnd, '2026-10-17');
    assert.deepStrictEqual(idsOf(wk), ['tomer'], `shape ${JSON.stringify(visitDate)}`);
    const m = wk.days[0].timed[0];
    assert.strictEqual(m.date, '2026-10-11');
    assert.strictEqual(m.time, '14:00');
    assert.strictEqual(m.meetingWith, 'חן');
    assert.strictEqual(m.houseLabel, 'רעננה הפרדס');
    // ...and NOT in the week before (it used to land on Saturday 10/10).
    assert.strictEqual(app.meetingsForWeek([tomer], '2026-10-04').total, 0, `shape ${JSON.stringify(visitDate)}`);
  });
});

test('week 04/10–10/10: Sunday, mid-week and Saturday visits appear; the days around do not', () => {
  const leads = [
    lead({ id: 'sun', visitDate: new Date('2026-10-03T21:00:00.000Z'), visitTime: '09:00' }), // Sun 04/10
    lead({ id: 'mid', visitDate: '2026-10-07', visitTime: '11:00' }),                       // Wed 07/10
    lead({ id: 'sat', visitDate: new Date('2026-10-09T21:00:00.000Z') }),                    // Sat 10/10, no time
    lead({ id: 'before', visitDate: '2026-10-03', visitTime: '10:00' }),                    // Sat 03/10
    lead({ id: 'after', visitDate: new Date('2026-10-10T21:00:00.000Z'), visitTime: '10:00' }), // Sun 11/10
  ];
  const wk = app.meetingsForWeek(leads, '2026-10-09');
  assert.strictEqual(wk.weekStart, '2026-10-04');
  assert.strictEqual(wk.weekEnd, '2026-10-10');
  assert.deepStrictEqual(idsOf(wk), ['mid', 'sat', 'sun']);
  assert.strictEqual(wk.days[wk.days.length - 1].iso, '2026-10-10');
  assert.strictEqual(wk.days[wk.days.length - 1].noTime[0].id, 'sat');
});

test('the rendered board shows the scheduled visit in its week (state.leads → #meetings-board)', () => {
  app.state.mode = 'view';
  app.state.currentManagers = app.normalizeCurrentManagers([{ house: 'pardes', name: 'חן' }]);
  app.state.houseManagers = app.rosterFromCurrentManagers(app.state.currentManagers);
  app.state.managerPhones = {};
  app.state.leads = [
    lead({ id: 'tomer', name: 'תומר', house: 'רעננה הפרדס', visitDate: '2026-10-10T21:00:00.000Z', visitTime: '14:00', meetingWith: 'חן' }),
    lead({ id: 'dana', name: 'דנה', house: 'ramot', visitDate: '2026-10-06', visitTime: '10:00' }),
  ];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.ok(board.innerHTML.includes('תומר'));
  assert.ok(board.innerHTML.includes('חן'));
  assert.ok(!board.innerHTML.includes('דנה'));
  app.state.meetingsWeekStart = '2026-10-04';
  app.renderMeetings();
  assert.ok(board.innerHTML.includes('דנה'));
  assert.ok(!board.innerHTML.includes('תומר'));
});

/* ===== Code.gs getData_: visitDate leaves as 'YYYY-MM-DD' ===== */

test('Code.gs getData_: a serial / Date visitDate is sent as YYYY-MM-DD; clean text unchanged', () => {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const cols = Array.from(g.run('LEAD_COLUMNS'));
  const sh = richSheet('Leads', cols);
  const row = (id, visitDate) => cols.map(c => ({ id, name: id, stage: 'visit', visitDate, visitTime: '14:00' }[c] ?? ''));
  sh.grid.push(row('serial', 46306));
  sh.grid.push(row('date', new Date('2026-10-11T12:00:00.000Z')));
  sh.grid.push(row('text', '2026-10-11'));
  sh.grid.push(row('blank', ''));
  g.sandbox.__sheets[g.run('LEADS_SHEET')] = sh;
  const d = JSON.parse(JSON.stringify(g.sandbox.getData_()));
  const by = Object.fromEntries(d.leads.map(l => [l.id, l.visitDate]));
  assert.deepStrictEqual(by, { serial: '2026-10-11', date: '2026-10-11', text: '2026-10-11', blank: '' });
  // Read path only: the Leads sheet was not written.
  assert.strictEqual(sh.grid[1][cols.indexOf('visitDate')], 46306);
});
