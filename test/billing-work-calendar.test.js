'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const calendar = require('../lib/billing-work-calendar');
const fixtures = require('./fixtures/israel-work-holidays.json');
const DAY = 86400000;
const iso = n => new Date(n).toISOString().slice(0, 10);

test('every supported civil day matches independent Hebcal Israel holidays and their eves', () => {
  assert.equal(fixtures.holidays.length, 144);
  const closed = new Set();
  for (const h of fixtures.holidays) {
    closed.add(h.date);
    closed.add(iso(Date.parse(h.date) - DAY));
  }
  const totals = { vered: 0, ortal: 0 };
  for (let n = Date.parse('2020-01-01'); n < Date.parse('2036-01-01'); n += DAY) {
    const day = iso(n), weekday = new Date(n).getUTCDay();
    for (const [owner, last] of [['vered', 3], ['ortal', 4]]) {
      const expected = weekday <= last && !closed.has(day);
      assert.equal(calendar.isBusinessDay(day, owner), expected, owner + ' ' + day);
      if (day > '2020-01-01' && expected) totals[owner]++;
    }
  }
  for (const owner of Object.keys(totals)) {
    assert.equal(calendar.businessDaysBetween('2020-01-01', '2035-12-31', owner), totals[owner]);
  }
});

test('Thursday is optional remote work for Vered, regular work for Ortal', () => {
  assert.equal(calendar.businessDaysBetween('2026-10-14', '2026-10-15', 'vered'), 0);
  assert.equal(calendar.businessDaysBetween('2026-10-14', '2026-10-15', 'ortal'), 1);
  assert.equal(calendar.businessDaysBetween('2026-10-14', '2026-10-18', 'vered'), 1);
  assert.equal(calendar.businessDaysBetween('2026-10-14', '2026-10-18', 'ortal'), 2);
});

test('holiday eves are full closed dates; Israel Chol HaMoed stays an ordinary weekday', () => {
  for (const day of ['2026-04-01', '2026-04-07', '2026-05-21', '2026-09-20']) {
    assert.equal(calendar.isBusinessDay(day, 'ortal'), false, day);
  }
  assert.equal(calendar.isBusinessDay('2026-04-05', 'ortal'), true);
  assert.equal(calendar.isBusinessDay('2026-09-27', 'vered'), true);
  // Observed Independence Day shifts to Thursday in 2021 and Tuesday in 2024/2028.
  for (const day of ['2021-04-14', '2021-04-15', '2024-05-13', '2024-05-14', '2028-05-01', '2028-05-02']) {
    assert.equal(calendar.isBusinessDay(day, 'ortal'), false, day);
  }
});

test('date arithmetic crosses leap days, year boundaries and Israel DST without hours', () => {
  assert.equal(calendar.businessDaysBetween('2024-02-28', '2024-03-03', 'ortal'), 2);
  assert.equal(calendar.businessDaysBetween('2025-12-31', '2026-01-04', 'ortal'), 2);
  assert.equal(calendar.businessDaysBetween('2026-03-26', '2026-03-29', 'vered'), 1);
  assert.equal(calendar.businessDaysBetween('2026-10-22', '2026-10-25', 'ortal'), 1);
  assert.equal(calendar.businessDaysBetween('2026-10-18', '2026-10-15', 'vered'), 0);
  assert.equal(calendar.businessDaysBetween('2026-10-15', '2026-10-15', 'ortal'), 0);
});

test('invalid/missing/out-of-range dates and unknown owners stay unknown, not zero', () => {
  for (const day of ['', null, undefined, '2026-02-30', '2026-13-01', '2026-10-15T00:00:00Z', '2019-12-31', '2036-01-01']) {
    assert.equal(calendar.isBusinessDay(day, 'ortal'), null);
    assert.equal(calendar.businessDaysBetween(day, '2026-10-15', 'ortal'), null);
    assert.equal(calendar.businessDaysBetween('2026-10-14', day, 'ortal'), null);
  }
  for (const owner of ['', 'sandra', 'constructor', '__proto__']) {
    assert.equal(calendar.isBusinessDay('2026-10-15', owner), null);
    assert.equal(calendar.businessDaysBetween('2026-10-14', '2026-10-15', owner), null);
  }
});

test('missing Hebrew Intl, Gregorian fallback or malformed parts fail visibly closed', () => {
  const source = fs.readFileSync(require.resolve('../lib/billing-work-calendar'), 'utf8');
  for (const Intl of [undefined,
    { DateTimeFormat: function () { return { resolvedOptions: () => ({ calendar: 'gregory' }) }; } },
    { DateTimeFormat: function () { return { resolvedOptions: () => ({ calendar: 'hebrew' }), formatToParts: () => [] }; } }]) {
    const s = { Intl };
    vm.runInNewContext(source, s);
    assert.equal(s.BillingWorkCalendar.isBusinessDay('2026-10-15', 'ortal'), null);
    assert.equal(s.BillingWorkCalendar.businessDaysBetween('2026-10-14', '2026-10-15', 'ortal'), null);
  }
});
