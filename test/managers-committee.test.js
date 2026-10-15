'use strict';

/* Committee date per patient — «ועדה» (CHANGELOG-managers-committee.md):
 * `managersWork` op `committeeSet` + the per-patient `committee` in houseData.
 * Real apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ secret = SECRET, today = '2026-10-15' } = {}) {
  const g = loadGs({ props: secret ? { MANAGERS_WORK_SECRET: secret } : {} });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const tzSeen = [];
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    tzSeen.push(tz);
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  g.run(`committeeToday_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [
    { houseId: 'ramot', name: 'דנה  לוי', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'עזב', date: '2026-08-01', exitDate: '2026-10-01', status: 'released', id: 'p3' },
    { houseId: 'arfoni', name: 'בבית אחר', date: '2026-09-01', status: 'active', id: 'p4' }
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call, tzSeen };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const set = (call, who, extra) => call({ op: 'committeeSet', patientName: 'דנה לוי', entryDate: '2026-09-01', previousDate: '', previousLabel: '', ...who, ...extra });
const cur = (call, who = ORAN) => call({ op: 'houseData', ...who }).patients[0].committee;
const grid = (g) => g.sandbox.__sheets.ManagersCommittee.grid;
const cell = (g, row, c) => grid(g)[row][grid(g)[0].indexOf(c)];

test('APPEND-ONLY header: the ManagersCommittee columns are pinned in order', () => {
  const { g } = boot();
  assert.deepStrictEqual(Array.from(g.run('MW_COMMITTEE_COLUMNS')),
    ['id', 'house', 'patientName', 'entryDate', 'committeeDate', 'label', 'previousDate', 'previousLabel',
      'editedAt', 'editedBy', 'editedById', 'state', 'pastCorrection']);
  assert.strictEqual(g.run('MW_COMMITTEE_SHEET'), 'ManagersCommittee');
  assert.strictEqual(g.run('MW_COMMITTEE_LABEL_MAX'), 60);
});

test('fail-closed: no secret configured, or a wrong secret → refused, nothing written', () => {
  const unset = boot({ secret: '' });
  assert.deepStrictEqual(arr(unset.g.post({ action: 'managersWork', secret: SECRET, op: 'committeeSet', ...ORAN })), { ok: false, error: 'unauthorized' });
  const { g } = boot();
  assert.deepStrictEqual(arr(g.post({ action: 'managersWork', secret: 'wrong', op: 'committeeSet', ...ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', committeeDate: '2026-11-01' })),
    { ok: false, error: 'unauthorized' });
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
});

test('houseData: committee null until set, support flag + Israel today; a read never creates the sheet', () => {
  const { g, call } = boot();
  const d = call({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.committeeSupported, true);
  assert.strictEqual(d.committeeToday, '2026-10-15');
  assert.strictEqual(d.patients[0].committee, null);
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
});

test('set, change, clear: one current value; every step a NEW row with who/when/previous; history kept', () => {
  const { g, call } = boot();
  const r1 = set(call, ORAN, { committeeDate: '2026-10-15', label: 'ועדת השמה' });
  assert.deepStrictEqual([r1.ok, r1.committee.date, r1.committee.label, r1.warning], [true, '2026-10-15', 'ועדת השמה', undefined], 'today is allowed');
  let c = cur(call);
  assert.deepStrictEqual([c.date, c.label, c.editedBy], ['2026-10-15', 'ועדת השמה', 'אורן']);
  assert.strictEqual(set(call, SANDRA, { committeeDate: '2026-10-22', label: '', previousDate: '2026-10-15', previousLabel: 'ועדת השמה' }).ok, true);
  c = cur(call);
  assert.deepStrictEqual([c.date, c.label, c.editedBy], ['2026-10-22', '', 'סנדרה']);
  const cl = set(call, ORAN, { mode: 'clear', previousDate: '2026-10-22', previousLabel: '' });
  assert.deepStrictEqual([cl.ok, cl.committee], [true, null]);
  assert.strictEqual(cur(call), null);
  assert.strictEqual(grid(g).length, 4, 'header + 3 rows, none overwritten');
  assert.deepStrictEqual([cell(g, 1, 'committeeDate'), cell(g, 1, 'label'), cell(g, 1, 'state'), cell(g, 1, 'editedById')], ['2026-10-15', 'ועדת השמה', 'set', 'person-oran']);
  assert.deepStrictEqual([cell(g, 2, 'previousDate'), cell(g, 2, 'previousLabel')], ['2026-10-15', 'ועדת השמה']);
  assert.deepStrictEqual([cell(g, 3, 'committeeDate'), cell(g, 3, 'state'), cell(g, 3, 'previousDate')], ['', 'cleared', '2026-10-22']);
  // Re-set after a clear.
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-11-02' }).ok, true);
  assert.strictEqual(cur(call).date, '2026-11-02');
});

test('optimistic concurrency: a stale date OR label → conflict + current value; same value → unchanged, no row', () => {
  const { g, call } = boot();
  set(call, ORAN, { committeeDate: '2026-10-20', label: 'א' });
  const s1 = set(call, SANDRA, { committeeDate: '2026-10-21', previousDate: '' });
  assert.strictEqual(s1.error, 'conflict');
  assert.deepStrictEqual([s1.current.date, s1.current.label], ['2026-10-20', 'א']);
  assert.strictEqual(set(call, SANDRA, { committeeDate: '2026-10-21', previousDate: '2026-10-20', previousLabel: 'ב' }).error, 'conflict', 'label differs');
  assert.strictEqual(set(call, SANDRA, { mode: 'clear', previousDate: '' }).error, 'conflict');
  const same = set(call, ORAN, { committeeDate: '2026-10-20', label: 'א', previousDate: '2026-10-20', previousLabel: 'א' });
  assert.deepStrictEqual([same.ok, same.unchanged], [true, true]);
  assert.strictEqual(grid(g).length, 2);
});

test('dates: today and the future are fine; past refused unless correcting an existing date (with a warning)', () => {
  const { g, call } = boot();
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-14' }).error, 'past_date', 'yesterday, nothing to correct');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-14', correction: true }).error, 'past_date', 'correction needs an existing date');
  set(call, ORAN, { committeeDate: '2026-10-16' });
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-14', previousDate: '2026-10-16' }).error, 'past_date', 'no correction flag');
  const fix = set(call, ORAN, { committeeDate: '2026-10-14', previousDate: '2026-10-16', correction: true });
  assert.deepStrictEqual([fix.ok, fix.warning], [true, 'past_date']);
  assert.strictEqual(cell(g, 2, 'pastCorrection'), '1');
  assert.strictEqual(cell(g, 1, 'pastCorrection'), '');
});

test('validation: formats, before admission, ≤ 2 years, label ≤ 60, a date with clear, unknown mode, label cleaned', () => {
  const { g, call } = boot();
  assert.strictEqual(set(call, ORAN, { committeeDate: '20/10/26' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-02-30' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { committeeDate: '' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', previousDate: 'x' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { mode: 'clear', committeeDate: '2026-10-20' }).error, 'bad_date');
  assert.strictEqual(set(call, ORAN, { mode: 'remove' }).error, 'bad_request');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2028-10-15' }).error, 'too_far');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', label: 'א'.repeat(61) }).error, 'label_too_long');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', patientName: '' }).error, 'missing_fields');
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
  const ok = set(call, ORAN, { committeeDate: '2026-10-20', label: '=HYPERLINK("x") <b>ועדה</b>' });
  assert.strictEqual(ok.ok, true);
  assert.doesNotMatch(cell(g, 1, 'label'), /^[=+@-]|[<>]/, 'formula lead-in and angle brackets stripped');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', label: 'א'.repeat(60), previousDate: '2026-10-20', previousLabel: cell(g, 1, 'label') }).ok, true, '60 is fine');
});

test('authorization: only a patient in the caller\'s house today; admin any house; scoped per house', () => {
  const { g, call } = boot();
  assert.strictEqual(set(call, HANAN, { committeeDate: '2026-10-20' }).error, 'not_found', 'another house');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', patientName: 'בבית אחר' }).error, 'not_found');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', patientName: 'עזב', entryDate: '2026-08-01' }).error, 'not_found', 'released');
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20', entryDate: '2026-09-02' }).error, 'not_found');
  assert.strictEqual(set(call, { ...ORAN, house: 'arfoni' }, { committeeDate: '2026-10-20' }).error, 'bad_request');
  assert.strictEqual(set(call, { ...ORAN, actorId: '' }, { committeeDate: '2026-10-20' }).error, 'bad_request');
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
  assert.strictEqual(set(call, { ...SANDRA, house: 'efroni' }, { patientName: 'בבית אחר', committeeDate: '2026-10-30' }).ok, true);
  assert.strictEqual(cur(call), null, 'ramot does not see efroni');
});

test('"today" is the calendar day in Asia/Jerusalem', () => {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET } });
  const seen = [];
  g.sandbox.Utilities.formatDate = (_d, tz) => { seen.push(tz); return '2026-10-15'; };
  assert.strictEqual(g.run('committeeToday_()'), '2026-10-15');
  assert.deepStrictEqual(seen, ['Asia/Jerusalem']);
});

test('busy lock → lock_busy JSON, nothing written', () => {
  const { g, call } = boot();
  g.sandbox.LockService.getScriptLock = () => ({ tryLock: () => false, releaseLock() {}, waitLock() { throw new Error('no'); } });
  assert.strictEqual(set(call, ORAN, { committeeDate: '2026-10-20' }).error, 'lock_busy');
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
});

test('display-only: committee writes change no bonus / occupancy figure; the source never deletes a row', () => {
  const { g, call } = boot();
  const before = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  set(call, ORAN, { committeeDate: '2026-10-20' });
  set(call, ORAN, { mode: 'clear', previousDate: '2026-10-20' });
  const after = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  assert.strictEqual(after, before);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const block = src.slice(src.indexOf('const MW_COMMITTEE_SHEET'), src.indexOf('/* ===== authorizeSheetsWriteNow'));
  assert.doesNotMatch(block, /deleteRow|clearContent|console\.|Logger\./);
});
