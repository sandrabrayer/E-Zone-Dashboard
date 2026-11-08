'use strict';

/* THE EXIT DAY OPENS NO CYCLE (CHANGELOG-billing-exit-day-not-due.md).
 *
 * A patient who leaves ON their billing day (entry day-of-month) used to be
 * listed in גבייה → «לגבייה בתאריך הנבחר» for a whole new month: entered
 * 27/07, left 27/10, asked for 30,000 ₪ for 27/10–26/11. The exit day stays a
 * stay day (patientStayCoversDate is unchanged); only a NEW cycle starting on
 * or after it is not due — the same bound Code.gs recCycleDueDates_ /
 * debtAging_ and app.js projectedCycleDueDates already use.
 *
 * vm-sandbox on the REAL shipped app.js; TZ pinned to Asia/Jerusalem.
 * Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      state, patientDueOnDate, patientsDueOn, patientStayCoversDate,
      projectedCycleDueDates, revenueMonthBounds, isoDate,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();

const pt = (over) => Object.assign({
  id: 'pt-x', houseId: 'arfoni', name: 'מטופל לדוגמה',
  date: '2026-07-27', pay: 30000, status: 'released', exitDate: '2026-10-27',
}, over || {});

function dueOn(patients, dateISO) {
  const prev = app.state.patients;
  app.state.patients = patients;
  try { return app.patientsDueOn(dateISO).map((p) => p.name); }
  finally { app.state.patients = prev; }
}

test('exit ON the billing day: that day opens no new cycle (the reported case)', () => {
  const p = pt();
  assert.equal(app.patientDueOnDate(p, '2026-10-27'), false, 'no 27/10–26/11 charge');
  assert.deepEqual(Array.from(dueOn([p], '2026-10-27')), []);
  // The exit day is still a stay day — only the new cycle is refused.
  assert.equal(app.patientStayCoversDate(p, '2026-10-27'), true);
});

test('the cycles inside the stay are still due', () => {
  const p = pt();
  for (const d of ['2026-07-27', '2026-08-27', '2026-09-27']) {
    assert.equal(app.patientDueOnDate(p, d), true, d);
  }
});

test('exit the day AFTER the billing day: that cycle is due (one day of it was used)', () => {
  const p = pt({ exitDate: '2026-10-28' });
  assert.equal(app.patientDueOnDate(p, '2026-10-27'), true);
  assert.equal(app.patientDueOnDate(p, '2026-11-27'), false);
});

test('exit the day BEFORE the billing day: not due, as before', () => {
  assert.equal(app.patientDueOnDate(pt({ exitDate: '2026-10-26' }), '2026-10-27'), false);
});

test('an exit stored as a UTC timestamp keeps the same boundary', () => {
  const p = pt({ exitDate: '2026-10-26T22:00:00.000Z' }); // 27/10 in Israel
  assert.equal(app.patientDueOnDate(p, '2026-10-27'), false);
  assert.equal(app.patientDueOnDate(p, '2026-09-27'), true);
});

test('an ACTIVE patient with an exit date set ahead of time is not billed from that day', () => {
  const p = pt({ status: 'active', exitDate: '2026-12-27' });
  assert.equal(app.patientDueOnDate(p, '2026-11-27'), true);
  assert.equal(app.patientDueOnDate(p, '2026-12-27'), false);
});

test('an active patient with no exit date is unaffected', () => {
  const p = pt({ status: 'active', exitDate: '' });
  assert.equal(app.patientDueOnDate(p, '2026-10-27'), true);
  assert.equal(app.patientDueOnDate(p, '2027-03-27'), true);
});

test('parity: the daily list agrees with projectedCycleDueDates and the Code.gs bound', () => {
  const p = pt();
  const projected = [];
  for (const m of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
    for (const d of app.projectedCycleDueDates(p, app.revenueMonthBounds(m))) if (!projected.includes(d)) projected.push(d);
  }
  assert.deepEqual(projected.sort(), ['2026-07-27', '2026-08-27', '2026-09-27']);
  assert.ok(!projected.includes('2026-10-27'), 'projection excludes the exit day');
  for (const d of projected) assert.equal(app.patientDueOnDate(p, d), true, d);
  // Code.gs: none on/after exit — the rule this aligns with.
  assert.match(GS, /!\(exit && occISO >= exit\)/);
});
