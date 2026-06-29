/* Tests for the growth-graph bucketing logic in public/app.js.
 *
 * Same vm-sandbox approach as breakeven-revenue.test.js: app.js is a browser
 * global script (no module.exports, touches document/location at top level), so
 * we read the source, append an epilogue exposing the pure functions under
 * test, and evaluate it in a vm context with the browser globals stubbed. No
 * changes to app.js are required.
 *
 * The graph reuses isoDate/parseLocalISO, so the real timezone-safe parsing is
 * exercised. Date math depends on the host local timezone; to make the raw-ISO
 * off-by-one assertion deterministic we set TZ=Asia/Jerusalem for this file. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      growthRecord,
      isoDate,
      weekStartSunday,
      addDaysISO,
      weeklyActiveCounts,
      monthlyRevenue,
      earliestEntryISO,
      lastDayOfMonth,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

function patient(over) {
  return Object.assign({ houseId: 'ramot', name: 'x', date: '', exitDate: '', pay: 0, status: 'active' }, over || {});
}

/* ===== date/exitDate parsing — BOTH formats, no off-by-one ===== */

test('bare YYYY-MM-DD entry/exit pass through isoDate unchanged', () => {
  const r = app.growthRecord(patient({ date: '2026-01-05', exitDate: '2026-03-10', pay: 9000 }));
  assert.strictEqual(r.entry, '2026-01-05');
  assert.strictEqual(r.exit, '2026-03-10');
  assert.strictEqual(r.pay, 9000);
});

test('raw ISO-timestamp exitDate normalizes to the correct LOCAL day (no UTC off-by-one)', () => {
  // 21:00Z is 00:00 the NEXT day in Israel (UTC+3 in June) -> local day is the 23rd.
  assert.strictEqual(app.isoDate('2026-06-22T21:00:00.000Z'), '2026-06-23');
  const r = app.growthRecord(patient({ date: '2026-01-05', exitDate: '2026-06-22T21:00:00.000Z' }));
  assert.strictEqual(r.exit, '2026-06-23');
  assert.notStrictEqual(r.exit, '2026-06-22'); // explicit: NOT the UTC-sliced day
});

test('empty exitDate stays empty (still-active patient)', () => {
  const r = app.growthRecord(patient({ date: '2026-01-05', exitDate: '' }));
  assert.strictEqual(r.exit, '');
});

/* ===== weekly active-count bucketing (Sunday-start) ===== */

test('still-active patient (empty exitDate) is counted in every week from entry onward', () => {
  // entry Mon 2026-01-05; today 2026-01-25 (Sun). Weeks start Sundays:
  // 2026-01-04, 01-11, 01-18, 01-25.
  const weeks = app.weeklyActiveCounts([patient({ date: '2026-01-05' })], '2026-01-25');
  // join-compare instead of deepStrictEqual: arrays returned from the vm sandbox
  // have a different Array.prototype, which deepStrictEqual rejects cross-realm.
  assert.strictEqual(weeks.map(w => w.weekStart).join(','), '2026-01-04,2026-01-11,2026-01-18,2026-01-25');
  assert.ok(weeks.every(w => w.count === 1));
});

test('enter+exit within range: counted only in the active weeks, zero before/after', () => {
  // entry 2026-01-12 (Mon, week of 01-11); exit 2026-01-20 (Tue, week of 01-18).
  // Range earliest entry .. today. Use a second still-active patient to anchor the
  // range earlier and later so we can see leading/trailing zero weeks.
  const today = '2026-02-08'; // Sunday
  const weeks = app.weeklyActiveCounts([
    patient({ date: '2026-01-04', exitDate: '2026-01-04' }), // anchors range start, week 01-04 only
    patient({ date: '2026-01-12', exitDate: '2026-01-20' }), // active weeks 01-11 and 01-18
  ], today);
  const byWeek = Object.fromEntries(weeks.map(w => [w.weekStart, w.count]));
  // patient B active in week 01-11 (entry<=01-17 && exit 01-20>=01-11) and 01-18 (entry<=01-24 && exit>=01-18)
  assert.strictEqual(byWeek['2026-01-11'], 1);
  assert.strictEqual(byWeek['2026-01-18'], 1);
  // not before entry's week, not after exit's week
  assert.strictEqual(byWeek['2026-01-25'], 0);
  assert.strictEqual(byWeek['2026-02-01'], 0);
});

test('boundary week: exit on the week-start Sunday still counts that week (exit >= startOfWeek)', () => {
  // week of 2026-01-18 starts Sun 01-18. A patient who exits exactly 01-18 is
  // active for that week by the >= rule.
  const weeks = app.weeklyActiveCounts([patient({ date: '2026-01-05', exitDate: '2026-01-18' })], '2026-01-25');
  const byWeek = Object.fromEntries(weeks.map(w => [w.weekStart, w.count]));
  assert.strictEqual(byWeek['2026-01-18'], 1); // exit == week start -> counted
  assert.strictEqual(byWeek['2026-01-25'], 0); // following week -> not counted
});

test('boundary week: entry on the week-end Saturday still counts that week (entry <= endOfWeek)', () => {
  // week of 2026-01-04 ends Sat 01-10. Entry 01-10 -> active that week.
  const weeks = app.weeklyActiveCounts([patient({ date: '2026-01-10' })], '2026-01-11');
  const byWeek = Object.fromEntries(weeks.map(w => [w.weekStart, w.count]));
  assert.strictEqual(byWeek['2026-01-04'], 1);
});

test('weekStartSunday + addDaysISO local math', () => {
  assert.strictEqual(app.weekStartSunday('2026-01-07'), '2026-01-04'); // Wed -> prior Sun
  assert.strictEqual(app.weekStartSunday('2026-01-04'), '2026-01-04'); // Sun -> itself
  assert.strictEqual(app.addDaysISO('2026-01-04', 6), '2026-01-10');
  assert.strictEqual(app.addDaysISO('2026-01-31', 1), '2026-02-01'); // month rollover
});

/* ===== monthly revenue summation ===== */

test('monthly revenue sums active patients pay for a known month', () => {
  const patients = [
    patient({ date: '2026-01-05', pay: 9000 }),                       // active Jan onward
    patient({ date: '2026-02-10', pay: 5000 }),                       // active Feb onward
    patient({ date: '2026-01-20', exitDate: '2026-01-31', pay: 7000 }), // active Jan only
  ];
  const months = app.monthlyRevenue(patients, '2026-03-15');
  const byMonth = Object.fromEntries(months.map(m => [m.month, m.revenue]));
  // Jan: 9000 + 7000 = 16000 ; Feb: 9000 + 5000 = 14000 ; Mar: 9000 + 5000 = 14000
  assert.strictEqual(byMonth['2026-01'], 16000);
  assert.strictEqual(byMonth['2026-02'], 14000);
  assert.strictEqual(byMonth['2026-03'], 14000);
  assert.strictEqual(months.map(m => m.month).join(','), '2026-01,2026-02,2026-03');
});

test('monthly membership: exit on first-of-month still counts that month (exit >= firstDay)', () => {
  // exit 2026-02-01 -> active for Feb by the >= rule.
  const months = app.monthlyRevenue([patient({ date: '2026-01-05', exitDate: '2026-02-01', pay: 8000 })], '2026-02-15');
  const byMonth = Object.fromEntries(months.map(m => [m.month, m.revenue]));
  assert.strictEqual(byMonth['2026-01'], 8000);
  assert.strictEqual(byMonth['2026-02'], 8000);
});

test('monthly revenue uses local exit day for raw ISO timestamp (no off-by-one across month end)', () => {
  // Israel is UTC+2 in January (winter), so a 22:30Z timestamp is 00:30 the NEXT
  // local day -> exit local day 2026-02-01, pushing the patient into February.
  assert.strictEqual(app.isoDate('2026-01-31T22:30:00.000Z'), '2026-02-01');
  const months = app.monthlyRevenue([patient({ date: '2026-01-05', exitDate: '2026-01-31T22:30:00.000Z', pay: 8000 })], '2026-02-15');
  const byMonth = Object.fromEntries(months.map(m => [m.month, m.revenue]));
  assert.strictEqual(byMonth['2026-02'], 8000); // local day pushed it into Feb
});

test('matches dashboard card logic for the current month (sum of active pay)', () => {
  // Dashboard card = sum (pay||0) over status!='released'. For the current
  // month with no mid-month releases, the monthly bucket equals that sum.
  const patients = [
    patient({ date: '2026-05-01', pay: 9000, status: 'active' }),
    patient({ date: '2026-05-01', pay: 6000, status: 'active' }),
  ];
  const cardSum = patients.filter(p => p.status !== 'released').reduce((s, p) => s + (p.pay || 0), 0);
  const months = app.monthlyRevenue(patients, '2026-05-20');
  const current = months[months.length - 1];
  assert.strictEqual(current.month, '2026-05');
  assert.strictEqual(current.revenue, cardSum); // 15000
});

/* ===== empty / edge ===== */

test('empty patient list yields empty series', () => {
  // .length (primitive) instead of deepStrictEqual — cross-realm array.
  assert.strictEqual(app.weeklyActiveCounts([], '2026-01-25').length, 0);
  assert.strictEqual(app.monthlyRevenue([], '2026-01-25').length, 0);
});

test('patients with no parseable entry date are ignored', () => {
  assert.strictEqual(app.weeklyActiveCounts([patient({ date: '' })], '2026-01-25').length, 0);
});

test('lastDayOfMonth handles short months and leap-ish Feb', () => {
  assert.strictEqual(app.lastDayOfMonth('2026-02'), '2026-02-28');
  assert.strictEqual(app.lastDayOfMonth('2026-04'), '2026-04-30');
  assert.strictEqual(app.lastDayOfMonth('2026-12'), '2026-12-31');
});
