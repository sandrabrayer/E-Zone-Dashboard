'use strict';

/* Temporary exit and return (CHANGELOG-temporary-exit-return.md): a patient
 * re-admitted to the same house within READMIT_WINDOW_DAYS keeps one stay —
 * no double counting, no day-count reset; gap days are not counted (bed-held
 * is not recorded); settled months (< STAY_CONTINUITY_FROM_MONTH) keep their
 * original computation byte-for-byte. Real apps-script/Code.gs in the vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const arr = (x) => JSON.parse(JSON.stringify(x));
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };

function boot(rows, { today = '2026-10-20' } = {}) {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }; defaultMonth_ = function () { return '${today.slice(0, 7)}'; };`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  const stats = (ym, fn = 'computeMonthStats_') => arr(g.sandbox[fn](g.sandbox.readPatientsForBonus_(), 'ramot', ym));
  return { g, call, stats };
}
const R = (name, date, exitDate, status) => ({ houseId: 'ramot', name, date, exitDate: exitDate || '', status: status || (exitDate ? 'released' : 'active') });

test('the window is ONE named constant (7 days) and the rule starts Oct 2026', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.strictEqual((src.match(/const READMIT_WINDOW_DAYS = 7;/g) || []).length, 1);
  assert.strictEqual((src.match(/const STAY_CONTINUITY_FROM_MONTH = '2026-10';/g) || []).length, 1);
  const { g } = boot([]);
  assert.strictEqual(g.run('READMIT_WINDOW_DAYS'), 7);
});

test('stay with a gap: exit 5 Oct, return 8 Oct → one stay; present days counted, gap days not, no new entry/exit', () => {
  const { stats } = boot([R('דנה לוי', '2026-09-20', '2026-10-05'), R('דנה לוי', '2026-10-08')]);
  const s = stats('2026-10');
  assert.strictEqual(s.treatmentDays, 5 + 24, '1–5 Oct + 8–31 Oct');
  assert.deepStrictEqual([s.dailyCounts[4], s.dailyCounts[5], s.dailyCounts[6], s.dailyCounts[7]], [1, 0, 0, 1], 'gap 6–7 Oct not counted (bed-held unknown)');
  assert.deepStrictEqual([s.entriesMonth, s.exitsMonth], [0, 0], 'a temporary exit is not a discharge + admission');
});

test('stay with a gap: «יום N» and the admission date continue from the FIRST admission; not listed as admitted this month', () => {
  const { call } = boot([R('דנה לוי', '2026-09-20', '2026-10-05'), R('דנה לוי', '2026-10-08')]);
  const d = call({ op: 'houseData', month: '2026-10', ...ORAN });
  assert.deepStrictEqual(d.patients.map((p) => [p.name, p.entryDate, p.days]), [['דנה לוי', '2026-09-20', 31]]);
  assert.deepStrictEqual(d.admissions, []);
});

test('return AFTER the window (9 days) → a new stay: day count restarts, it is an admission', () => {
  const { stats, call } = boot([R('יוסי', '2026-09-01', '2026-10-01'), R('יוסי', '2026-10-10')]);
  const s = stats('2026-10');
  assert.strictEqual(s.treatmentDays, 1 + 22);
  assert.deepStrictEqual([s.entriesMonth, s.exitsMonth], [1, 1]);
  const d = call({ op: 'houseData', month: '2026-10', ...ORAN });
  assert.deepStrictEqual(d.patients.map((p) => [p.entryDate, p.days]), [['2026-10-10', 11]]);
  assert.deepStrictEqual(d.admissions.map((a) => a.date), ['2026-10-10']);
});

test('window boundary: 7 days after the exit continues the stay, 8 days does not', () => {
  const seven = boot([R('א', '2026-09-01', '2026-10-01'), R('א', '2026-10-08')]).call({ op: 'houseData', ...ORAN });
  assert.strictEqual(seven.patients[0].entryDate, '2026-09-01');
  const eight = boot([R('א', '2026-09-01', '2026-10-01'), R('א', '2026-10-09')]).call({ op: 'houseData', ...ORAN });
  assert.strictEqual(eight.patients[0].entryDate, '2026-10-09');
});

test('same-day return: the day counts ONCE (no double counting)', () => {
  const { stats } = boot([R('רון', '2026-10-01', '2026-10-12'), R('רון', '2026-10-12')]);
  const after = stats('2026-10');
  const before = stats('2026-10', 'computeMonthStatsLegacy_');
  assert.strictEqual(before.dailyCounts[11], 2, 'the original computation counted 12 Oct twice');
  assert.strictEqual(after.dailyCounts[11], 1);
  assert.strictEqual(after.treatmentDays, 31);
  assert.strictEqual(before.treatmentDays, 32);
});

test('overlapping duplicate open rows: counted once per day, listed once', () => {
  const { stats, call } = boot([R('שרה', '2026-10-01'), R('שרה  ', '2026-10-03')]);
  assert.strictEqual(stats('2026-10').treatmentDays, 31);
  assert.strictEqual(call({ op: 'houseData', ...ORAN }).patients.length, 1);
});

test('different patients are never merged: another name, or the same name in another house', () => {
  const { stats } = boot([R('דנה', '2026-10-01', '2026-10-05'), R('דנה כהן', '2026-10-05'),
    { houseId: 'arfoni', name: 'דנה', date: '2026-10-05', status: 'active' }]);
  assert.strictEqual(stats('2026-10').dailyCounts[4], 2, 'two different people on 5 Oct');
});

test('SETTLED months are unchanged: Sep 2026 keeps the original computation byte-for-byte', () => {
  const rows = [R('רון', '2026-09-01', '2026-09-12'), R('רון', '2026-09-12', '2026-09-20'), R('רון', '2026-09-23'),
    R('דנה', '2026-08-20', '2026-09-03'), R('דנה', '2026-09-05')];
  const { g, stats } = boot(rows);
  for (const ym of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
    assert.deepStrictEqual(stats(ym), stats(ym, 'computeMonthStatsLegacy_'), ym);
  }
  const sep = stats('2026-09');
  assert.strictEqual(sep.dailyCounts[11], 3, 'Sep keeps its original count — 12 Sep still double-counted (no retroactive change)');
  const h = arr(g.sandbox.managersHouse_('ramot', '2026-09'));
  assert.strictEqual(h.treatmentDays, stats('2026-09', 'computeMonthStatsLegacy_').treatmentDays);
});

test('audit: read-only, initials only, before/after per house and each case classified', () => {
  const { g } = boot([R('רון לוי', '2026-10-01', '2026-10-12'), R('רון לוי', '2026-10-12'),
    R('דנה כהן', '2026-09-20', '2026-10-05'), R('דנה כהן', '2026-10-08'),
    R('שי', '2026-09-01', '2026-09-10'), R('שי', '2026-09-10')]);
  const before = JSON.stringify(g.sandbox.__sheets.Patients.grid);
  const out = arr(g.sandbox.auditTemporaryExitsNow());
  assert.deepStrictEqual(out.months.map((m) => [m.month, m.rule]), [['2026-09', 'original (settled)'], ['2026-10', 'continuity']]);
  const oct = out.months[1];
  const ramot = oct.houses.find((h) => h.house === 'ramot');
  assert.deepStrictEqual([ramot.before.treatmentDays, ramot.after.treatmentDays, ramot.changed], [32 + 29 + 31, 31 + 29 + 31, true]);
  const cases = Object.fromEntries(oct.cases.map((c) => [c.patient, c]));
  assert.match(cases['ר.ל.'].status, /^double counted \(1 day/);
  assert.match(cases['ד.כ.'].status, /^gap of 2 day/);
  assert.strictEqual(cases['ד.כ.'].exitDate, '2026-10-05');
  const sep = out.months[0];
  assert.ok(sep.cases.some((c) => c.patient === 'ש.' && /double counted/.test(c.status)), 'a settled-month error is REPORTED, not changed');
  const logged = JSON.stringify(g.logs || '') + JSON.stringify(out);
  for (const full of ['רון לוי', 'דנה כהן']) assert.ok(!logged.includes(full), 'no full name: ' + full);
  assert.strictEqual(JSON.stringify(g.sandbox.__sheets.Patients.grid), before, 'nothing written');
  assert.deepStrictEqual(Object.keys(g.sandbox.__sheets), ['Patients'], 'no sheet created');
});
