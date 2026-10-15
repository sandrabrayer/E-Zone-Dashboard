'use strict';

/* Expected discharge: clear + «אין צפי לשחרור» (CHANGELOG-managers-discharge-clear.md).
 *   A. Code.gs `managersWork` dischargeSet mode 'clear' / 'none' (real Code.gs, vm sandbox):
 *      append-only rows, re-set, optimistic concurrency, validation, authorization,
 *      legacy rows written before the `state` column, bonus figures unchanged.
 *   B. The Dashboard read feed + card model: «אין צפי» is neither an alert nor
 *      counted as «ללא תאריך»; the shared fixture's `states` cases. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const DA = require('../lib/discharge-alerts.js');

const SECRET = 'mw-secret-123';
const PROXY_SECRET = 'proxy-secret-for-tests-0123456789';
const arr = (x) => JSON.parse(JSON.stringify(x));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'discharge-alert-cases.json'), 'utf8'));

function boot({ today = '2026-10-15' } = {}) {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET, PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  g.run(`expectedDischargesToday_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [
    { houseId: 'ramot', name: 'דנה  לוי', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'בלי תאריך', date: '2026-10-01', status: 'active', id: 'p2' },
    { houseId: 'arfoni', name: 'בבית אחר', date: '2026-09-01', status: 'active', id: 'p4' },
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const dis = (call, who, extra) => call({ op: 'dischargeSet', patientName: 'דנה לוי', entryDate: '2026-09-01', previousDate: '', ...who, ...extra });
const current = (call, who = ORAN) => call({ op: 'houseData', ...who }).patients.find((p) => p.name === 'דנה  לוי').expectedDischarge;
const grid = (g) => g.sandbox.__sheets.ManagersExpectedDischarge.grid;
const cell = (g, row, c) => grid(g)[row][grid(g)[0].indexOf(c)];

/* ===================================================================== */
/* A. Code.gs                                                             */
/* ===================================================================== */

test('A: houseData advertises the supported modes (set / clear / none)', () => {
  const { call } = boot();
  assert.deepStrictEqual(call({ op: 'houseData', ...ORAN }).expectedDischargeModes, ['set', 'clear', 'none']);
});

test('A: clear appends a row with an empty date (state cleared); history is never deleted', () => {
  const { g, call } = boot();
  assert.strictEqual(dis(call, ORAN, { expectedDate: '2026-11-20' }).ok, true);
  const r = dis(call, ORAN, { mode: 'clear', expectedDate: '', previousDate: '2026-11-20' });
  assert.deepStrictEqual([r.ok, r.expectedDischarge], [true, null]);
  assert.strictEqual(current(call), null, 'no current value after a clear');
  assert.strictEqual(grid(g).length, 3, 'header + set row + clear row — the set row is kept');
  assert.deepStrictEqual([cell(g, 1, 'expectedDate'), cell(g, 1, 'state')], ['2026-11-20', 'set']);
  assert.deepStrictEqual([cell(g, 2, 'expectedDate'), cell(g, 2, 'previousDate'), cell(g, 2, 'state'), cell(g, 2, 'editedById')],
    ['', '2026-11-20', 'cleared', 'person-oran']);
});

test('A: mark «אין צפי לשחרור» (none) → { date: "", none: true } with who/when; re-set to a date later', () => {
  const { g, call } = boot();
  const r = dis(call, ORAN, { mode: 'none' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.expectedDischarge.date, r.expectedDischarge.none, r.expectedDischarge.editedBy], ['', true, 'אורן']);
  let cur = current(call);
  assert.deepStrictEqual([cur.date, cur.none, cur.editedBy], ['', true, 'אורן']);
  assert.deepStrictEqual([cell(g, 1, 'expectedDate'), cell(g, 1, 'state')], ['', 'none']);
  // Re-set: the screen sends the token it showed, 'none'.
  const back = dis(call, SANDRA, { expectedDate: '2026-12-01', previousDate: 'none' });
  assert.strictEqual(back.ok, true);
  cur = current(call);
  assert.deepStrictEqual([cur.date, cur.none, cur.editedBy], ['2026-12-01', undefined, 'סנדרה']);
  assert.deepStrictEqual([cell(g, 2, 'previousDate'), cell(g, 2, 'state')], ['none', 'set']);
  // And clear from «אין צפי».
  dis(call, ORAN, { mode: 'none', previousDate: '2026-12-01' });
  assert.strictEqual(dis(call, ORAN, { mode: 'clear', previousDate: 'none' }).ok, true);
  assert.strictEqual(current(call), null);
  assert.strictEqual(grid(g).length, 5, 'every step is its own row');
});

test('A: optimistic concurrency covers clear and none (stale token → conflict, nothing written)', () => {
  const { g, call } = boot();
  dis(call, ORAN, { mode: 'none' });
  const stale = dis(call, SANDRA, { mode: 'clear', previousDate: '' });
  assert.strictEqual(stale.error, 'conflict');
  assert.deepStrictEqual([stale.current.none, stale.current.date], [true, '']);
  const stale2 = dis(call, SANDRA, { expectedDate: '2026-11-01', previousDate: '2026-10-30' });
  assert.strictEqual(stale2.error, 'conflict');
  assert.strictEqual(grid(g).length, 2);
  // Same target as the current value → unchanged, no row.
  const again = dis(call, ORAN, { mode: 'none', previousDate: 'none' });
  assert.deepStrictEqual([again.ok, again.unchanged], [true, true]);
  dis(call, ORAN, { mode: 'clear', previousDate: 'none' });
  const clearAgain = dis(call, ORAN, { mode: 'clear', previousDate: '' });
  assert.deepStrictEqual([clearAgain.ok, clearAgain.unchanged], [true, true]);
  assert.strictEqual(grid(g).length, 3, 'no-ops are not new rows');
});

test('A: validation — unknown mode, a date sent with clear/none, a bad previous token', () => {
  const { g, call } = boot();
  assert.strictEqual(dis(call, ORAN, { mode: 'delete' }).error, 'bad_request');
  assert.strictEqual(dis(call, ORAN, { mode: 'clear', expectedDate: '2026-11-01' }).error, 'bad_date');
  assert.strictEqual(dis(call, ORAN, { mode: 'none', expectedDate: '2026-11-01' }).error, 'bad_date');
  assert.strictEqual(dis(call, ORAN, { mode: 'none', previousDate: 'NONE' }).error, 'bad_date');
  assert.strictEqual(dis(call, ORAN, { mode: 'set', expectedDate: '' }).error, 'bad_date', 'set still needs a date');
  assert.strictEqual(dis(call, ORAN, { mode: 'clear', entryDate: 'x' }).error, 'bad_date');
  assert.strictEqual(dis(call, ORAN, { mode: 'none', patientName: '' }).error, 'missing_fields');
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge, 'nothing written');
});

test('A: authorization — own house only (another house, a patient elsewhere, a bad role) → refused; admin any house', () => {
  const { g, call } = boot();
  assert.strictEqual(dis(call, HANAN, { mode: 'none' }).error, 'not_found', 'manager of another house');
  assert.strictEqual(dis(call, ORAN, { mode: 'clear', patientName: 'בבית אחר' }).error, 'not_found', 'patient of another house');
  assert.strictEqual(dis(call, { ...ORAN, role: 'owner' }, { mode: 'none' }).error, 'bad_request');
  assert.strictEqual(dis(call, { ...ORAN, actorId: '' }, { mode: 'none' }).error, 'bad_request', 'no stable actor id');
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge);
  assert.deepStrictEqual(arr(g.post({ action: 'managersWork', secret: 'wrong', op: 'dischargeSet', ...ORAN, mode: 'none', patientName: 'דנה לוי', entryDate: '2026-09-01' })),
    { ok: false, error: 'unauthorized' });
  assert.strictEqual(dis(call, { ...SANDRA, house: 'efroni' }, { mode: 'none', patientName: 'בבית אחר' }).ok, true);
  assert.strictEqual(current(call), null, 'scoped per house');
});

test('A: append-only guard — a sheet written before `state` existed keeps its rows; the header is extended, never rewritten', () => {
  const { g, call } = boot();
  const legacyCols = ['id', 'house', 'patientName', 'entryDate', 'expectedDate', 'previousDate', 'editedAt', 'editedBy', 'editedById'];
  const sh = richSheet('ManagersExpectedDischarge', legacyCols);
  sh.grid.push(['r1', 'ramot', 'דנה לוי', '2026-09-01', '2026-11-05', '', '2026-10-14T08:00:00.000Z', 'אורן', 'person-oran']);
  g.sandbox.__sheets.ManagersExpectedDischarge = sh;
  assert.strictEqual(current(call).date, '2026-11-05', 'a legacy row (no state) is a date');
  assert.strictEqual(dis(call, ORAN, { mode: 'clear', previousDate: '2026-11-05' }).ok, true);
  assert.deepStrictEqual(sh.grid[0], legacyCols.concat(['state']), 'header extended at the end only');
  assert.deepStrictEqual(sh.grid[1].slice(0, 9), ['r1', 'ramot', 'דנה לוי', '2026-09-01', '2026-11-05', '', '2026-10-14T08:00:00.000Z', 'אורן', 'person-oran'], 'old row untouched');
  assert.strictEqual(current(call), null);
  // The source never deletes a row of this sheet.
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const block = src.slice(src.indexOf('function mwDischargeSet_'), src.indexOf('function authorizeSheetsWriteNow'));
  assert.doesNotMatch(block, /deleteRow|clearContent|deleteRows/);
});

test('A: bonus / occupancy figures are unchanged by clear and none', () => {
  const { g, call } = boot();
  const before = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  dis(call, ORAN, { expectedDate: '2026-10-20' });
  dis(call, ORAN, { mode: 'none', previousDate: '2026-10-20' });
  dis(call, ORAN, { mode: 'clear', previousDate: 'none' });
  const after = JSON.stringify([g.sandbox.managersHouse_('ramot', '2026-10'), g.sandbox.managersOverview_('2026-10')]);
  assert.strictEqual(after, before);
});

/* ===================================================================== */
/* B. Dashboard feed + card model                                         */
/* ===================================================================== */

test('B: the expectedDischarges feed carries «אין צפי» as { date: "", none: true }', () => {
  const { g, call } = boot();
  dis(call, ORAN, { mode: 'none' });
  const feed = arr(g.run('expectedDischargesForDashboard_()'));
  assert.deepStrictEqual(feed.expectedDischargeModes, ['set', 'clear', 'none']);
  const ramot = feed.houses.find((h) => h.house === 'ramot');
  const p = ramot.patients.find((x) => x.entryDate === '2026-09-01');
  assert.deepStrictEqual([p.expectedDischarge.date, p.expectedDischarge.none], ['', true]);
});

test('B: card model — «אין צפי» is not an alert and not in the «ללא תאריך» count; cleared is', () => {
  const feed = {
    expectedDischargeSupported: true,
    houses: [{ house: 'ramot', label: 'רמות השבים', patients: [
      { name: 'א', expectedDischarge: { date: '', none: true, editedBy: 'אורן' } },
      { name: 'ב', expectedDischarge: null },
      { name: 'ג', expectedDischarge: { date: '2026-10-16' } },
    ] }],
  };
  const m = DA.dashboardModel(feed, '2026-10-15');
  assert.deepStrictEqual(m.soon.map((a) => a.name), ['ג']);
  assert.deepStrictEqual(m.noDate, [{ house: 'ramot', label: 'רמות השבים', count: 1 }]);
  assert.strictEqual(m.noExpected, 1);
  assert.strictEqual(m.count, 1);
});

test('B: shared fixture — dischargeState cases', () => {
  assert.ok(FIXTURE.states.length >= 5);
  for (const c of FIXTURE.states) assert.strictEqual(DA.dischargeState(c.expectedDischarge), c.expect, JSON.stringify(c.expectedDischarge));
});
