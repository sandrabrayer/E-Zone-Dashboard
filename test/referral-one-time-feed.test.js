'use strict';

/* One-time referral facts (CHANGELOG-referral-one-time-feed.md): each
 * patient's FIRST day-package start counts once, in its month. Real
 * apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const arr = (x) => JSON.parse(JSON.stringify(x));

function boot(rows) {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d) => {
    const x = new Date(d); const m = x.getMonth() + 1, day = x.getDate();
    return `${x.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
  };
  const cols = Array.from(g.run('OUTPATIENT_COLUMNS'));
  const sh = richSheet('Outpatients', cols);
  rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Outpatients = sh;
  return g;
}
const starts = (g, ym, key) => arr(g.sandbox.managersOverview_(ym)).houses.find((h) => h.key === key).referralStarts;

test('a day-package start counts once, in the month it started — not in later months', () => {
  const g = boot([{ patient_name: 'דנה', house_of_origin: 'ramot', therapy_type: 'day_2x', start_date: '2026-10-07' }]);
  assert.deepStrictEqual(starts(g, '2026-10', 'ramot'), { count: 1, items: [{ date: '2026-10-07', name: 'דנה' }] });
  assert.strictEqual(starts(g, '2026-11', 'ramot').count, 0, 'still in the package in November — no second payment');
  assert.strictEqual(starts(g, '2026-09', 'ramot').count, 0);
});

test('maintenance never counts; day_daily does', () => {
  const g = boot([
    { patient_name: 'א', house_of_origin: 'efroni', therapy_type: 'maintenance', start_date: '2026-10-02' },
    { patient_name: 'ב', house_of_origin: 'efroni', therapy_type: 'day_daily', start_date: '2026-10-03' }
  ]);
  assert.deepStrictEqual(starts(g, '2026-10', 'efroni').items.map((i) => i.name), ['ב']);
});

test('a renewal row or a switch between day packages never pays again', () => {
  const g = boot([
    { patient_name: 'ג', house_of_origin: 'rehab', therapy_type: 'day_2x', start_date: '2026-10-01', end_date: '2026-10-31' },
    { patient_name: 'ג', house_of_origin: 'rehab', therapy_type: 'day_daily', start_date: '2026-11-01' },
    { patient_name: ' ג ', house_of_origin: 'rehab', therapy_type: 'day_2x', start_date: '2026-12-01' }
  ]);
  assert.strictEqual(starts(g, '2026-10', 'rehab').count, 1);
  assert.strictEqual(starts(g, '2026-11', 'rehab').count, 0);
  assert.strictEqual(starts(g, '2026-12', 'rehab').count, 0);
});

test('a patient who started before October is never counted from October on', () => {
  const g = boot([{ patient_name: 'ד', house_of_origin: 'pardes', therapy_type: 'day_2x', start_date: '2026-09-20' }]);
  assert.strictEqual(starts(g, '2026-10', 'pardes').count, 0);
  assert.strictEqual(starts(g, '2026-09', 'pardes').count, 1, 'its own start month only');
});

test('external / unknown house, blank name or no start date are skipped', () => {
  const g = boot([
    { patient_name: 'ה', house_of_origin: 'external', therapy_type: 'day_2x', start_date: '2026-10-02' },
    { patient_name: '', house_of_origin: 'ramot', therapy_type: 'day_2x', start_date: '2026-10-02' },
    { patient_name: 'ו', house_of_origin: 'ramot', therapy_type: 'day_2x', start_date: '' }
  ]);
  const o = arr(g.sandbox.managersOverview_('2026-10'));
  for (const h of o.houses) assert.strictEqual(h.referralStarts.count, 0, h.key);
});

test('managersHouse carries the same referralStarts; the monthly continuity counts are unchanged', () => {
  const rows = [{ patient_name: 'ז', house_of_origin: 'ramot', therapy_type: 'day_2x', start_date: '2026-10-05' }];
  const g = boot(rows);
  const h = arr(g.sandbox.managersHouse_('ramot', '2026-10'));
  assert.deepStrictEqual(h.referralStarts, starts(g, '2026-10', 'ramot'));
  assert.strictEqual(h.bonus.continuity.day_2x, 1, 'the old per-month counts still flow, untouched');
  assert.strictEqual(arr(g.sandbox.managersHouse_('ramot', '2026-11')).bonus.continuity.day_2x, 1);
});
