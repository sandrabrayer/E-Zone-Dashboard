'use strict';

/* Managers expected discharge date (CHANGELOG-managers-expected-discharge.md):
 * `managersWork` op `dischargeSet` + the per-patient `expectedDischarge` in
 * houseData. Real apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ secret = SECRET, today = '2026-10-15' } = {}) {
  const g = loadGs({ props: secret ? { MANAGERS_WORK_SECRET: secret } : {} });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [
    { houseId: 'ramot', name: 'דנה  לוי', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'עזב', date: '2026-08-01', exitDate: '2026-10-01', status: 'released', id: 'p3' },
    { houseId: 'arfoni', name: 'בבית אחר', date: '2026-09-01', status: 'active', id: 'p4' }
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const set = (call, who, extra) => call({ op: 'dischargeSet', patientName: 'דנה לוי', entryDate: '2026-09-01', previousDate: '', ...who, ...extra });

test('APPEND-ONLY header: the ManagersExpectedDischarge columns are pinned in order', () => {
  const { g } = boot();
  assert.deepStrictEqual(Array.from(g.run('MW_DISCHARGE_COLUMNS')),
    ['id', 'house', 'patientName', 'entryDate', 'expectedDate', 'previousDate', 'editedAt', 'editedBy', 'editedById', 'state']);
  assert.strictEqual(g.run('MW_DISCHARGE_SHEET'), 'ManagersExpectedDischarge');
});

test('fail-closed: no secret configured, or a wrong secret → refused, nothing written', () => {
  const unset = boot({ secret: '' });
  assert.deepStrictEqual(arr(unset.g.post({ action: 'managersWork', secret: SECRET, op: 'dischargeSet', ...ORAN })), { ok: false, error: 'unauthorized' });
  const { g } = boot();
  assert.deepStrictEqual(arr(g.post({ action: 'managersWork', secret: 'wrong', op: 'dischargeSet', ...ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-11-01' })), { ok: false, error: 'unauthorized' });
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge, 'no sheet created');
});

test('houseData: expectedDischarge null until set; support flag on; a read never creates the sheet', () => {
  const { g, call } = boot();
  const d = call({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.expectedDischargeSupported, true);
  assert.deepStrictEqual(d.patients.map((p) => [p.name, p.expectedDischarge]), [['דנה  לוי', null]]);
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge);
});

test('set, then change: the value comes back in houseData; every edit is a NEW row with who/when/previous', () => {
  const { g, call } = boot();
  const r1 = set(call, ORAN, { expectedDate: '2026-11-20' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.expectedDischarge.date, '2026-11-20');
  let p = call({ op: 'houseData', ...ORAN }).patients[0];
  assert.deepStrictEqual([p.expectedDischarge.date, p.expectedDischarge.editedBy], ['2026-11-20', 'אורן']);
  const r2 = set(call, SANDRA, { expectedDate: '2026-12-01', previousDate: '2026-11-20' });
  assert.strictEqual(r2.ok, true);
  p = call({ op: 'houseData', ...ORAN }).patients[0];
  assert.deepStrictEqual([p.expectedDischarge.date, p.expectedDischarge.editedBy], ['2026-12-01', 'סנדרה']);
  const grid = g.sandbox.__sheets.ManagersExpectedDischarge.grid;
  assert.strictEqual(grid.length, 3, 'header + two rows — the first is never overwritten');
  const cols = grid[0];
  const at = (row, c) => grid[row][cols.indexOf(c)];
  assert.deepStrictEqual([at(1, 'expectedDate'), at(1, 'previousDate'), at(1, 'editedById')], ['2026-11-20', '', 'person-oran']);
  assert.deepStrictEqual([at(2, 'expectedDate'), at(2, 'previousDate'), at(2, 'editedById')], ['2026-12-01', '2026-11-20', 'person-sandra']);
  assert.strictEqual(at(2, 'patientName'), 'דנה לוי', 'name stored in key form');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(at(2, 'editedAt')));
});

test('no silent overwrite: a stale previousDate → conflict with the current value, nothing written', () => {
  const { g, call } = boot();
  set(call, ORAN, { expectedDate: '2026-11-20' });
  const stale = set(call, SANDRA, { expectedDate: '2026-12-24', previousDate: '' });
  assert.strictEqual(stale.error, 'conflict');
  assert.strictEqual(stale.current.date, '2026-11-20');
  assert.strictEqual(g.sandbox.__sheets.ManagersExpectedDischarge.grid.length, 2);
  const same = set(call, ORAN, { expectedDate: '2026-11-20', previousDate: '2026-11-20' });
  assert.deepStrictEqual([same.ok, same.unchanged], [true, true]);
  assert.strictEqual(g.sandbox.__sheets.ManagersExpectedDischarge.grid.length, 2, 'no-op is not a new row');
});

test('validation: date format, real calendar dates, expected ≥ admission, ≤ 2 years ahead', () => {
  const { g, call } = boot();
  assert.strictEqual(set(call, ORAN, { expectedDate: '20/11/26' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-02-30' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', entryDate: 'x' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', previousDate: 'yesterday' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-08-31' }).error, 'before_admission');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-09-01' }).ok, true, 'same day as admission is allowed');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2029-01-01', previousDate: '2026-09-01' }).error, 'too_far');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', patientName: '' }).error, 'missing_fields');
  assert.strictEqual(g.sandbox.__sheets.ManagersExpectedDischarge.grid.length, 2);
});

test('authorization: only a patient in the caller\'s house today, with that admission date', () => {
  const { g, call } = boot();
  assert.strictEqual(set(call, HANAN, { expectedDate: '2026-11-20' }).error, 'not_found', 'another house');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', patientName: 'בבית אחר' }).error, 'not_found', 'patient of another house');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', patientName: 'עזב', entryDate: '2026-08-01' }).error, 'not_found', 'already released');
  assert.strictEqual(set(call, ORAN, { expectedDate: '2026-11-20', entryDate: '2026-09-02' }).error, 'not_found', 'wrong admission date');
  assert.strictEqual(set(call, { ...ORAN, house: 'arfoni' }, { expectedDate: '2026-11-20' }).error, 'bad_request', 'backend id is not a house');
  assert.strictEqual(set(call, { ...ORAN, role: 'owner' }, { expectedDate: '2026-11-20' }).error, 'bad_request');
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge);
  // An admin edits any house (the Managers server names it).
  assert.strictEqual(set(call, { ...SANDRA, house: 'efroni' }, { patientName: 'בבית אחר', expectedDate: '2026-10-30' }).ok, true);
  assert.strictEqual(call({ op: 'houseData', ...ORAN }).patients[0].expectedDischarge, null, 'scoped per house');
});

test('display-only: setting a date changes no bonus / occupancy figure', () => {
  const { g, call } = boot();
  const before = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  set(call, ORAN, { expectedDate: '2026-10-20' });
  const after = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  assert.strictEqual(after, before);
});
