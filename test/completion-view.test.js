/* «השלמת תקופת טיפול» — completion view (CHANGELOG-completion-view.md).
 * The pure lib (lib/patient-retention.js computeCompletion), the REAL
 * public/app.js in a vm (helpers/app-sandbox), and the Excel file read BACK
 * with exceljs. All names, phones and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const R = require('../lib/patient-retention');
const LF = require('../lib/leads-funnel');
const X = require('../lib/report-xlsx');
const { loadPage } = require('./helpers/app-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FROM = '2026-09-01', TO = '2026-09-30', TODAY = '2026-10-20';

const P = (id, date, over) => Object.assign({ id, houseId: 'ramot', name: 'מטופל ' + id, date, status: 'active' }, over || {});
const released = (id, date, exitDate, over) => P(id, date, Object.assign({ status: 'released', exitDate }, over || {}));
const run = (patients, over) => R.computeCompletion(Object.assign({ patients, discharged: [], from: FROM, to: TO, today: TODAY }, over || {}));
const res = (rep, n) => R.completionResult(rep, n);
const ids = (rows) => rows.map((r) => r.patientId).sort();

/* ---------- the rules ---------- */

test('boundary: exactly N days is «הגיעו לסף»; N − 1 left early (not inclusive day count)', () => {
  const rep = run([
    released('a', '2026-09-01', '2026-10-01'),   // 30 days
    released('b', '2026-09-01', '2026-09-30'),   // 29 days
    released('c', '2026-09-01', '2026-10-31'),   // 60 days
    released('d', '2026-09-02', '2026-10-31'),   // 59 days
  ]);
  assert.deepEqual([...rep.thresholds], [30, 60], 'default thresholds');
  assert.deepEqual(ids(res(rep, 30).rows.reached), ['a', 'c', 'd']);
  assert.deepEqual(ids(res(rep, 30).rows.leftEarly), ['b']);
  assert.deepEqual(ids(res(rep, 60).rows.reached), ['c']);
  assert.deepEqual(ids(res(rep, 60).rows.leftEarly), ['a', 'b', 'd']);
  assert.equal(R.stayDays(released('a', '2026-09-01', '2026-10-01')), 30, 'the same stayDays rule');
});

test('active patient above N counts as reached; below N is «מוקדם לקבוע» and NOT in the rate', () => {
  const rep = run([
    P('long', '2026-09-01'),                        // 49 days to today
    P('short', '2026-09-30'),                       // 20 days to today
    released('left', '2026-09-05', '2026-09-15'),   // 10 days
  ]);
  const r30 = res(rep, 30);
  assert.deepEqual(ids(r30.rows.reached), ['long']);
  assert.deepEqual(ids(r30.rows.tooEarly), ['short']);
  assert.deepEqual(ids(r30.rows.leftEarly), ['left']);
  assert.equal(r30.evaluable, 2, 'tooEarly excluded from the base');
  assert.equal(r30.rate, 0.5);
  const r60 = res(rep, 60);
  assert.deepEqual(ids(r60.rows.tooEarly), ['long', 'short']);
  assert.equal(r60.evaluable, 1);
  assert.equal(r60.rate, 0);
  assert.equal(R.formatRate(r60.rate), '0%', 'a real 0% (someone left early) is shown as 0%');
});

test('discharged the same day: 0 days, left early, placed (not missing)', () => {
  const rep = run([released('z', '2026-09-10', '2026-09-10')]);
  assert.equal(res(rep, 30).rows.leftEarly[0].days, 0);
  assert.equal(res(rep, 30).counts.leftEarly, 1);
  assert.equal(rep.missingCount, 0);
});

test('evaluable = 0 → rate null → «אין מספיק נתונים» (never 0% or NaN)', () => {
  const onlyNew = run([P('n', '2026-09-30')]);
  const r = res(onlyNew, 30);
  assert.equal(r.evaluable, 0);
  assert.equal(r.rate, null);
  assert.equal(R.formatRate(r.rate), 'אין מספיק נתונים');
  const empty = run([]);
  assert.equal(res(empty, 30).rate, null);
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(R.formatRate(v), R.NOT_ENOUGH_DATA_LABEL);
});

test('a custom threshold; invalid ones dropped, duplicates once, order kept', () => {
  const rep = run([released('a', '2026-09-01', '2026-10-16')], { thresholds: [30, 60, '45', 45, 0, -3, 2.5, 'x', 99999] });
  assert.deepEqual([...rep.thresholds], [30, 60, 45]);
  assert.equal(res(rep, 45).counts.reached, 1, '45 days ≥ 45');
  assert.equal(res(rep, 60).counts.leftEarly, 1);
  assert.deepEqual([...R.normalizeThresholds(undefined)], [30, 60]);
  assert.deepEqual([...R.normalizeThresholds([])], []);
});

test('missing dates go to «נתונים חסרים» (same rows as computeRetention) and are never counted', () => {
  const patients = [
    P('noEntry', ''),
    released('noExit', '2026-09-05', ''),
    released('reverse', '2026-09-10', '2026-09-01'),
    P('future', '2026-09-25'),
    released('ok', '2026-09-01', '2026-10-01'),
  ];
  const rep = run(patients, { today: '2026-09-20' });
  const ret = R.computeRetention({ patients, discharged: [], from: FROM, to: TO, today: '2026-09-20' });
  assert.equal(rep.missingCount, 4);
  assert.equal(rep.missingCount, ret.missingCount);
  assert.deepEqual(rep.rows.missing.map((m) => m.reason).sort(), ['discharge_before_entry', 'entry_in_future', 'no_discharge_date', 'no_entry_date']);
  const r = res(rep, 30);
  assert.equal(r.counts.reached + r.counts.leftEarly + r.counts.tooEarly, 1, 'only the placed stay');
  assert.equal(rep.cohortSize, ret.cohortSize);
});

test('every count is the length of the list behind it; selections, titles', () => {
  const rep = run([P('a', '2026-09-01'), P('b', '2026-09-29'), released('c', '2026-09-01', '2026-09-05')], { thresholds: [30, 60, 21] });
  rep.results.forEach((r) => {
    R.COMPLETION_KEYS.forEach((k) => {
      const sel = { kind: 'completion', threshold: r.threshold, key: k };
      assert.equal(R.validSelection(sel), true);
      assert.equal(R.completionListFor(rep, sel), r.rows[k], 'the SAME array');
      assert.equal(r.counts[k], r.rows[k].length);
    });
    assert.equal(r.evaluable, r.counts.reached + r.counts.leftEarly);
    assert.equal(r.counts.reached + r.counts.leftEarly + r.counts.tooEarly, rep.cohortSize);
  });
  for (const bad of [{ kind: 'completion', threshold: 0, key: 'reached' }, { kind: 'completion', threshold: 30, key: 'x' }, { kind: 'completion', threshold: 30, key: '__proto__' }]) {
    assert.equal(R.validSelection(bad), false);
    assert.deepEqual(R.completionListFor(rep, bad), []);
  }
  assert.deepEqual(R.completionListFor(rep, { kind: 'completion', threshold: 90, key: 'reached' }), [], 'a threshold not computed');
  assert.deepEqual(R.listFor(R.computeRetention({ from: FROM, to: TO }), { kind: 'completion', threshold: 30, key: 'reached' }), []);
  assert.equal(R.listTitle({ kind: 'completion', threshold: 30, key: 'leftEarly' }), 'השלמת טיפול · 30 ימים · עזבו לפני הסף');
  assert.deepEqual({ ...run([], { from: TO, to: FROM }) }, { ok: false, error: 'bad_range' });
});

/* ---------- CSV ---------- */

test('CSV section: the screen numbers, «אין מספיק נתונים», the note, every row, formula-guarded', () => {
  const rep = run([released('a', '2026-09-01', '2026-10-01', { name: '=HYPERLINK("x")' }), P('n', '2026-09-30'), P('m', '')], { thresholds: [30, 60] });
  const csv = R.completionToCsv(rep, { houseName: () => 'רמות' });
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '"השלמת טיפול"');
  assert.equal(lines[1], R.COMPLETION_HEAD.map(R.csvCell).join(','));
  assert.equal(lines[2], ['30', '1', '0', '1', '1', '100%'].map(R.csvCell).join(','));
  assert.equal(lines[3], ['60', '0', '1', '1', '1', '0%'].map(R.csvCell).join(','));
  assert.ok(csv.includes(R.csvCell(R.COMPLETION_NOTE)));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula neutralized');
  assert.ok(!/(^|,)"=/m.test(csv), 'no cell starts with =');
  assert.ok(csv.includes('"' + R.MISSING_LABEL + '"'), 'missing rows listed');
  const none = R.completionToCsv(run([P('n', '2026-09-30')]));
  assert.ok(none.includes('"אין מספיק נתונים"'));
  assert.ok(!/NaN/.test(none));
  assert.equal(R.completionCsvFilename(FROM, TO), 'השלמת-טיפול-2026-09-01-2026-09-30.csv');
  assert.equal(R.completionCsvFilename('../x', '<y>'), 'השלמת-טיפול-x-y.csv', 'filename sanitized');
});

/* ---------- the page ---------- */

function page() {
  const pg = loadPage({});
  pg.sandbox.PatientRetention = R;
  pg.sandbox.LeadsFunnel = LF;
  pg.sandbox.ReportXlsx = X;
  const downloads = [];
  pg.sandbox.Blob = class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } };
  pg.sandbox.URL = { createObjectURL: (b) => { downloads.push({ blob: b }); return 'blob:x'; }, revokeObjectURL() {} };
  pg.sandbox.document.createElement = () => ({ click() { downloads[downloads.length - 1].name = this.download; }, remove() {} });
  pg.sandbox.document.body = { appendChild() {} };
  return { pg, downloads };
}
const STATE = {
  patients: [
    released('p1', '2026-09-01', '2026-10-01', { name: '<img src=x onerror=alert(1)>' }),
    released('p2', '2026-09-03', '2026-09-10'),
    P('p3', '2026-09-02'),
    P('p4', '2026-09-30'),
    P('p5', ''),
  ],
  dischargedPatients: [],
  leads: [], irrelevantLeads: [],
};
const UI = (over) => Object.assign({ from: FROM, to: TO, threshold: '', completionThreshold: '', sel: { kind: 'bucket', key: 'upTo30' } }, over || {});

test('page: one card per threshold (rate + counts), custom-days input, the note; existing bucket cards unchanged', () => {
  const { pg } = page();
  pg.set(STATE);
  pg.sandbox.__ui = UI({ completionThreshold: '45' });
  const comp = pg.run(`patientCompletionReport(state, globalThis.__ui, '${TODAY}')`);
  assert.deepEqual([...comp.thresholds], [30, 60, 45]);
  pg.sandbox.__comp = comp;
  pg.sandbox.__rep = pg.run(`patientRetentionReport(state, globalThis.__ui, '${TODAY}')`);
  const html = pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui, { edit: false, completion: globalThis.__comp })');
  const plain = pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui, { edit: false })');
  assert.equal((html.match(/class="pr-comp-card"/g) || []).length, 3);
  assert.ok(html.includes('השלמת תקופת טיפול'));
  assert.ok(html.includes('class="pr-comp-threshold"') && html.includes('value="45"'));
  assert.ok(html.includes('מטופלים שטרם הגיעו לסף אינם נספרים באחוז'));
  comp.results.forEach((r) => {
    assert.ok(html.includes(`<div class="pr-comp-rate">${R.formatRate(r.rate)}</div>`), 'rate ' + r.threshold);
    R.COMPLETION_KEYS.forEach((k) => assert.ok(html.includes(`${R.COMPLETION_LABELS[k]}: ${r.counts[k]}`), k + ' ' + r.threshold));
  });
  // The bucket cards section is byte-identical with and without the completion view.
  const cards = (h) => h.slice(h.indexOf('<div class="pr-stats">'), h.indexOf('המשך טיפול (מתוך'));
  assert.equal(cards(html), cards(plain));
  assert.ok(!html.includes('NaN'));
});

test('page: «אין מספיק נתונים» when nobody can be evaluated', () => {
  const { pg } = page();
  pg.set({ patients: [P('n', '2026-09-30')], dischargedPatients: [] });
  pg.sandbox.__ui = UI();
  pg.sandbox.__comp = pg.run(`patientCompletionReport(state, globalThis.__ui, '${TODAY}')`);
  pg.sandbox.__rep = pg.run(`patientRetentionReport(state, globalThis.__ui, '${TODAY}')`);
  const html = pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui, { completion: globalThis.__comp })');
  assert.equal((html.match(/<div class="pr-comp-rate">אין מספיק נתונים<\/div>/g) || []).length, 2);
  assert.ok(!/pr-comp-rate">0%/.test(html));
});

test('page: click-a-count opens that list (escaped); a stale threshold falls back', () => {
  const { pg } = page();
  pg.set(STATE);
  const sel = { kind: 'completion', threshold: 30, key: 'reached' };
  pg.sandbox.__ui = UI({ sel });
  pg.sandbox.__comp = pg.run(`patientCompletionReport(state, globalThis.__ui, '${TODAY}')`);
  pg.sandbox.__rep = pg.run(`patientRetentionReport(state, globalThis.__ui, '${TODAY}')`);
  const html = pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui, { completion: globalThis.__comp })');
  const n = R.completionResult(pg.sandbox.__comp, 30).counts.reached;
  assert.ok(html.includes(`השלמת טיפול · 30 ימים · הגיעו לסף (${n})`));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'), 'no raw markup');
  assert.ok(html.includes(`data-sel="${JSON.stringify(sel).replace(/"/g, '&quot;')}"`), 'selection JSON escaped');
  pg.sandbox.__ui2 = UI({ sel: { kind: 'completion', threshold: 77, key: 'reached' } });
  const stale = pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui2, { completion: globalThis.__comp })');
  // CHANGELOG-chitukim-fixes.md: a stale selection closes the list (no list until a number is clicked).
  assert.ok(!stale.includes('class="pr-list"'), 'a stale threshold closes its list');
  const list = pg.run('retentionSelectionList(globalThis.__rep, globalThis.__comp, globalThis.__ui.sel)');
  assert.equal(list.rows, R.completionResult(pg.sandbox.__comp, 30).rows.reached);
});

test('Excel: «השלמת טיפול» values equal the screen values (section + full export)', async () => {
  const { pg, downloads } = page();
  pg.set(STATE);
  const ui = pg.run('patientRetentionUi()');
  Object.assign(ui, { from: FROM, to: TO, completionThreshold: '45' });
  const screen = pg.run(`patientCompletionReport(state, patientRetentionUi())`);
  pg.sandbox.__comp = screen;
  pg.run(`exportReportXlsx('completion', reportXlsxContext(null, null, '${FROM}', '${TO}', globalThis.__comp))`);
  pg.run(`exportAllReportsXlsx('${FROM}', '${TO}')`);
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].name, 'ezone-completion-2026-09-01_2026-09-30.xlsx');
  for (const d of downloads) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(d.blob.parts[0]));
    const ws = wb.getWorksheet('השלמת טיפול');
    assert.ok(ws, d.name);
    assert.equal(ws.views[0].rightToLeft, true);
    screen.results.forEach((r, i) => {
      const row = ws.getRow(i + 2).values.slice(1);
      assert.deepEqual(row.slice(0, 5), [r.threshold, r.counts.reached, r.counts.leftEarly, r.counts.tooEarly, r.evaluable], 'counts ' + r.threshold);
      if (r.rate === null) assert.equal(row[5], 'אין מספיק נתונים');
      else {
        assert.equal(row[5], r.rate);
        assert.equal(ws.getRow(i + 2).getCell(6).numFmt, '0.0%');
      }
    });
    assert.equal(ws.getRow(screen.results.length + 2).getCell(1).value, R.COMPLETION_NOTE);
    let listRows = 0;
    ws.eachRow((row, n) => { if (n > 1 && R.COMPLETION_KEYS.some((k) => row.getCell(2).value === R.COMPLETION_LABELS[k])) listRows++; });
    assert.equal(listRows, screen.results.reduce((a, r) => a + r.counts.reached + r.counts.leftEarly + r.counts.tooEarly, 0), 'every row behind every number');
    let guarded = false;
    ws.eachRow((row) => { if (row.getCell(3).value === '<img src=x onerror=alert(1)>') guarded = true; });
    assert.ok(guarded, 'name stored as plain text');
  }
  const full = new ExcelJS.Workbook();
  await full.xlsx.load(Buffer.from(downloads[1].blob.parts[0]));
  assert.ok(full.worksheets.map((w) => w.name).includes('השלמת טיפול'), 'in the full export');
});

test('Excel: a formula-looking name is text, never a formula', async () => {
  const rep = run([released('a', '2026-09-01', '2026-10-05', { name: '=SUM(1)' })]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(X.writeXlsx(X.sectionWorkbook('completion', { completion: rep, from: FROM, to: TO }))));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['השלמת טיפול', 'נתונים חסרים']);
  let seen = false;
  wb.getWorksheet('השלמת טיפול').eachRow((row) => row.eachCell((c) => {
    assert.ok(!(c.value && typeof c.value === 'object' && 'formula' in c.value), 'no formula cell');
    if (c.value === "'=SUM(1)") seen = true;
  }));
  assert.ok(seen);
});

/* ---------- wiring ---------- */

test('wiring: no Code.gs change, SW bumped to v80 or later, 44px targets', () => {
  assert.equal(read('apps-script', 'Code.gs').includes('computeCompletion'), false);
  // v81: CHANGELOG-chitukim-fixes.md (monotonic).
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(read('public', 'sw.js'))[1]) >= 80);
  assert.match(read('public', 'style.css'), /\.pr-comp-count, \.patient-retention \.pr-comp-csv, \.patient-retention \.pr-comp-threshold \{ min-height: 44px; font-size: 16px; \}/);
});
