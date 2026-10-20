/* «ייצוא לאקסל» for every חתך (CHANGELOG-report-xlsx-export.md).
 * lib/report-xlsx.js writes the workbook in the page; every file here is read
 * BACK with exceljs (an independent reader) and compared with the report
 * objects the screen renders. All names, phones and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const X = require('../lib/report-xlsx');
const R = require('../lib/patient-retention');
const LF = require('../lib/leads-funnel');
const { loadPage } = require('./helpers/app-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FROM = '2026-09-01', TO = '2026-09-30', TODAY = '2026-10-20';
const AT = new Date('2026-10-20T10:05:00Z');   // 13:05 in Israel

async function load(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  return wb;
}
const names = (wb) => wb.worksheets.map((w) => w.name);
const cellText = (c) => (c.value && typeof c.value === 'object' && c.value.richText ? c.value.richText.map((t) => t.text).join('') : c.value);
/* The sheet as arrays (row 1 = header), trailing empties dropped. */
function grid(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = [];
    for (let i = 1; i <= ws.columnCount; i++) vals.push(cellText(row.getCell(i)));
    while (vals.length && (vals[vals.length - 1] === null || vals[vals.length - 1] === undefined)) vals.pop();
    out[n - 1] = vals;
  });
  return out;
}
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

function fixture() {
  const patients = [
    { id: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' },
    { id: 'p2', houseId: 'ramot', name: '=HYPERLINK("http://x")', date: '2026-09-02', status: 'released', exitDate: '2026-10-20' },
    { id: 'p3', houseId: 'arfoni', name: 'גימל', date: '2026-09-03', status: 'released', exitDate: '2026-12-01', personId: 'root-1' },
    { id: 'p4', houseId: 'arfoni', name: 'דלת', date: '2026-09-20', status: 'active' },
    { id: 'p5', houseId: 'ramot', name: 'בלי שחרור', date: '2026-09-05', status: 'released', exitDate: '' },
  ];
  const discharged = [
    { id: 'a1', patientId: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', exitDate: '2026-09-11', continuity: 'continued_outpatient', phone: '0501234567' },
    { id: 'a2', patientId: 'p2', houseId: 'ramot', name: '=HYPERLINK("http://x")', date: '2026-09-02', exitDate: '2026-10-20', continuity: 'none', phone: '+972501112222' },
    { id: 'a3', patientId: 'p3', houseId: 'arfoni', name: 'גימל', date: '2026-09-03', exitDate: '2026-12-01', continuity: '', phone: '031234567' },
  ];
  const leads = [
    { id: 'l1', name: '@cmd', phone: '0521234567', created: '2026-09-04', house: 'רמות', stage: 'visit', visitDate: '2026-09-10' },
    { id: 'l2', name: 'נכנס', phone: '0547654321', created: '2026-09-06', house: 'עפרוני', stage: 'admitted' },
    { id: 'l3', name: 'חדש', phone: '0531111111', created: '2026-09-07', stage: 'new' },
  ];
  const irrelevantLeads = [{ id: 'l4', name: '-minus', phone: '0509999999', created: '2026-09-08', stage: 'irrelevant', disposition: 'not_relevant' }];
  const retention = R.computeRetention({ patients, discharged, from: FROM, to: TO, today: TODAY, customThreshold: 30 });
  const funnel = LF.funnel({ leads, irrelevantLeads, patients, dischargedPatients: discharged, from: FROM, to: TO });
  return { retention, funnel, ctx: { funnel, retention, from: FROM, to: TO, exportedAt: AT, houseName: (id) => ({ ramot: 'רמות', arfoni: 'עפרוני' }[id] || id) } };
}

/* ---------- structure ---------- */

test('the full export: 8 sheets, Hebrew names, in order; every name valid', async () => {
  const { ctx } = fixture();
  const wb = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  assert.deepEqual(names(wb), ['סיכום', 'לידים – חתך', 'לידים – רשימה', 'שהות – חתך', 'המשך טיפול', 'השלמת טיפול', 'מטופלים – רשימה', 'נתונים חסרים']);
  for (const n of names(wb)) {
    assert.ok([...n].length <= 31, n);
    assert.doesNotMatch(n, /[:\\/?*[\]]/);
  }
});

test('section exports carry only their own sheets; a list export is ONE sheet', async () => {
  const { ctx, retention, funnel } = fixture();
  const sheetsOf = async (spec) => names(await load(X.writeXlsx(spec)));
  assert.deepEqual(await sheetsOf(X.sectionWorkbook('leads', ctx)), ['לידים – חתך', 'לידים – רשימה']);
  assert.deepEqual(await sheetsOf(X.sectionWorkbook('retention', ctx)), ['שהות – חתך', 'מטופלים – רשימה', 'נתונים חסרים']);
  assert.deepEqual(await sheetsOf(X.sectionWorkbook('continuity', ctx)), ['המשך טיפול', 'מטופלים – רשימה']);
  assert.equal(X.sectionWorkbook('nope', ctx), null);
  const list = await load(X.writeXlsx(X.listWorkbook('patients', R.listFor(retention, { kind: 'bucket', key: 'upTo30' }), { title: 'שוחררו · עד 30 יום' })));
  assert.deepEqual(names(list), ['שוחררו · עד 30 יום']);
  assert.equal(list.worksheets[0].rowCount, 1 + retention.counts.upTo30);
  const leadList = await load(X.writeXlsx(X.listWorkbook('leads', funnel.rows.visitedNotEntered, { title: 'לידים · הגיעו לפגישה ולא נכנסו' })));
  assert.equal(leadList.worksheets[0].rowCount, 1 + funnel.counts.visitedNotEntered);
});

test('safeSheetName: forbidden characters, 31 chars, blanks, duplicates', async () => {
  assert.equal(X.safeSheetName('a/b\\c?d*e[f]g:h'), 'a b c d e f g h');
  assert.equal([...X.safeSheetName('ש'.repeat(40))].length, 31);
  assert.equal(X.safeSheetName('   '), 'גיליון');
  assert.equal(X.safeSheetName("'quoted'"), 'quoted');
  const wb = await load(X.writeXlsx({ sheets: [{ name: 'א', columns: [], rows: [] }, { name: 'א', columns: [], rows: [] }] }));
  assert.deepEqual(names(wb), ['א', 'א (2)']);
});

test('formatting: RTL, frozen bold header on a fill, column widths', async () => {
  const { ctx } = fixture();
  const wb = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  for (const ws of wb.worksheets) {
    assert.equal(ws.views[0].rightToLeft, true, ws.name);
    assert.equal(ws.views[0].state, 'frozen', ws.name);
    assert.equal(ws.views[0].ySplit, 1, ws.name);
    assert.equal(ws.getRow(1).getCell(1).font.bold, true, ws.name);
    assert.equal(ws.getRow(1).getCell(1).fill.fgColor.argb, 'FFD9E2F3');
    assert.ok(ws.getColumn(1).width >= 10, ws.name);
  }
  assert.equal(wb.getWorksheet('סיכום').getColumn(1).width, 46);
});

/* ---------- values = the report objects ---------- */

test('«סיכום»: period as real dates, rule labels, Israel stamp, every headline number', async () => {
  const { ctx, retention: r, funnel: f } = fixture();
  const g = grid((await load(X.writeXlsx(X.fullWorkbook(ctx)))).getWorksheet('סיכום'));
  const row = (label) => g.find((x) => x && x[0] === label);
  assert.equal(iso(row('תקופה — מתאריך')[1]), FROM);
  assert.equal(iso(row('תקופה — עד תאריך')[1]), TO);
  assert.ok(g.some((x) => x && String(x[1]).includes('לפי תאריך יצירת הליד')));
  assert.ok(g.some((x) => x && String(x[1]).includes('לפי תאריך כניסה בתקופה')));
  assert.equal(row('הופק ב־')[1], '20/10/2026 13:05');
  assert.equal(row('לידים שנוצרו בתקופה')[1], f.population);
  for (const b of LF.BUCKETS) assert.equal(row(b.label)[1], f.counts[b.key], b.key);
  assert.equal(row('נכנסו בתקופה (הקבוצה)')[1], r.cohortSize);
  for (const b of R.BUCKETS) {
    assert.equal(row('שוחררו · ' + b.label)[1], r.counts[b.key]);
    assert.equal(row('שוחררו · ' + b.label)[2], r.percents[b.key]);
  }
  assert.equal(row('עדיין בטיפול')[1], r.stillInTreatment.count);
  assert.equal(row('עדיין בטיפול')[2], r.percents.stillInTreatment);
  for (const k of R.CONTINUITY_KEYS) {
    const x = row('המשך טיפול · ' + R.CONTINUITY_LABELS[k] + ' (אחוז מהמשוחררים)');
    assert.equal(x[1], r.continuity[k], k);
    assert.equal(x[2], r.percents.continuity[k], k);
  }
  assert.equal(row('נתונים חסרים (לא נספרו)')[1], r.missingCount);
});

test('«לידים – חתך» / «לידים – רשימה» = the funnel report, with «קטגוריה»', async () => {
  const { ctx, funnel: f } = fixture();
  const wb = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  const counts = grid(wb.getWorksheet('לידים – חתך'));
  assert.deepEqual(counts[0], ['קטגוריה', 'מספר לידים']);
  assert.deepEqual(counts.slice(1, 4), LF.BUCKETS.map((b) => [b.label, f.counts[b.key]]));
  const list = grid(wb.getWorksheet('לידים – רשימה'));
  assert.equal(list[0][0], 'קטגוריה');
  const total = LF.BUCKETS.reduce((n, b) => n + f.counts[b.key], 0);
  assert.equal(list.length - 1, total);
  for (const b of LF.BUCKETS) assert.equal(list.filter((x) => x[0] === b.label).length, f.counts[b.key]);
});

test('«שהות – חתך» = bucket counts, still-in-treatment, the custom split', async () => {
  const { ctx, retention: r } = fixture();
  const g = grid((await load(X.writeXlsx(X.fullWorkbook(ctx)))).getWorksheet('שהות – חתך'));
  const row = (label) => g.find((x) => x && x[0] === label);
  for (const b of R.BUCKETS) assert.deepEqual(row('שוחררו · ' + b.label).slice(1, 3), [r.counts[b.key], r.percents[b.key]]);
  assert.deepEqual(row('עדיין בטיפול').slice(1, 3), [r.stillInTreatment.count, r.percents.stillInTreatment]);
  for (const b of R.BUCKETS) assert.equal(row('עדיין בטיפול · ' + b.label)[1], r.stillInTreatment.buckets[b.key]);
  assert.equal(row('שוחררו · עד 30 ימים')[1], r.custom.atOrBelow);
  assert.equal(row('שוחררו · מעל 30 ימים')[1], r.custom.above);
  assert.equal(row('שוחררו · מעל 30 ימים')[3], 'המשוחררים');
});

test('«המשך טיפול» = continuity counts + the bucket × continuity cross table', async () => {
  const { ctx, retention: r } = fixture();
  const g = grid((await load(X.writeXlsx(X.fullWorkbook(ctx)))).getWorksheet('המשך טיפול'));
  for (const k of R.CONTINUITY_KEYS) {
    const x = g.find((y) => y && y[0] === R.CONTINUITY_LABELS[k]);
    assert.deepEqual(x.slice(1, 3), [r.continuity[k], r.percents.continuity[k]]);
  }
  const head = g.findIndex((y) => y && y[0] === 'משך שהות');
  assert.deepEqual(g[head], ['משך שהות', ...R.CONTINUITY_KEYS.map((k) => R.CONTINUITY_LABELS[k]), 'סה״כ']);
  R.BUCKETS.forEach((b, i) => {
    assert.deepEqual(g[head + 1 + i], [b.label, ...R.CONTINUITY_KEYS.map((k) => r.cross[b.key][k]), r.counts[b.key]]);
  });
});

test('«מטופלים – רשימה»: every placed stay once, «קטגוריית שהות» + «המשך טיפול»; «נתונים חסרים» = the excluded', async () => {
  const { ctx, retention: r } = fixture();
  const wb = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  const g = grid(wb.getWorksheet('מטופלים – רשימה'));
  assert.equal(g[0][0], 'קטגוריית שהות');
  assert.ok(g[0].includes('המשך טיפול'));
  assert.equal(g.length - 1, r.cohortSize);
  const byName = (n) => g.find((x) => x[1] === n);
  assert.equal(byName('אלף')[0], 'עד 30 יום');
  assert.equal(byName('אלף')[7], 'המשיך באמבולטורי (E-ZONE)');
  assert.equal(byName('אלף')[2], 'רמות', 'house name, not id');
  assert.equal(byName('גימל')[7], 'לא ידוע');
  assert.equal(byName('גימל')[8], 'כן', 'returning stay');
  assert.equal(byName('דלת')[0], 'עדיין בטיפול · עד 30 יום');
  assert.equal(byName('אלף')[6], 10);
  const m = grid(wb.getWorksheet('נתונים חסרים'));
  assert.equal(m.length - 1, r.missingCount);
  assert.deepEqual(m[1].slice(0, 2), ['חסר תאריך שחרור', 'בלי שחרור']);
});

/* ---------- cell types ---------- */

test('dates are real Excel dates (dd/mm/yyyy); an invalid date stays text', async () => {
  const { ctx } = fixture();
  const ws = (await load(X.writeXlsx(X.fullWorkbook(ctx)))).getWorksheet('מטופלים – רשימה');
  const c = ws.getRow(2).getCell(5);
  assert.ok(c.value instanceof Date);
  assert.equal(c.numFmt, 'dd/mm/yyyy');
  const wb = await load(X.writeXlsx({ sheets: [{ name: 's', columns: [{ header: 'd', type: 'date' }], rows: [['2026-02-30'], ['2026-02-28']] }] }));
  assert.equal(wb.worksheets[0].getCell('A2').value, '2026-02-30');
  assert.equal(iso(wb.worksheets[0].getCell('A3').value), '2026-02-28');
  assert.equal(X.excelSerial('1899-12-30'), 0);
  assert.equal(X.excelSerial('2026-10-20'), 46315);
});

test('phones are stored as text: leading zeros kept, "+972…" not a formula and not a number', async () => {
  const { ctx } = fixture();
  const wb = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  const g = grid(wb.getWorksheet('מטופלים – רשימה'));
  const phones = g.slice(1).map((x) => x[3]).filter(Boolean);
  assert.ok(phones.includes('0501234567'));
  assert.ok(phones.includes('031234567'));
  assert.ok(phones.includes("'+972501112222"), 'a leading + is formula-guarded like the CSV');
  const ws = wb.getWorksheet('לידים – רשימה');
  for (let r = 2; r <= ws.rowCount; r++) {
    const c = ws.getRow(r).getCell(3);
    assert.equal(typeof c.value, 'string');
    assert.equal(c.numFmt, '@');
    assert.match(c.value, /^0\d+$/);
  }
});

test('percentages are numbers with a % format', async () => {
  const { ctx, retention: r } = fixture();
  const ws = (await load(X.writeXlsx(X.fullWorkbook(ctx)))).getWorksheet('שהות – חתך');
  const c = ws.getRow(2).getCell(3);
  assert.equal(typeof c.value, 'number');
  assert.equal(c.value, r.percents.upTo30);
  assert.equal(c.numFmt, '0.0%');
});

/* ---------- security ---------- */

test('formula guard: = + - @ tab CR get a leading apostrophe — the CSV rule exactly; never a formula', async () => {
  const evil = ['=1+1', '+1', '-1', '@SUM(A1)', '\t=x', '\r=x', '=HYPERLINK("http://x")', 'רגיל', "'already"];
  const wb = await load(X.writeXlsx({ sheets: [{ name: 's', columns: [{ header: 'v', type: 'text' }], rows: evil.map((v) => [v]) }] }));
  const ws = wb.worksheets[0];
  evil.forEach((v, i) => {
    const c = ws.getCell('A' + (i + 2));
    assert.equal(c.type !== ExcelJS.ValueType.Formula, true, v);
    const csvInner = LF.csvCell(v).slice(1, -1).replace(/""/g, '"');
    assert.equal(c.value, csvInner, JSON.stringify(v));
  });
  const { ctx } = fixture();
  const full = await load(X.writeXlsx(X.fullWorkbook(ctx)));
  const names2 = grid(full.getWorksheet('מטופלים – רשימה')).map((x) => x[1]);
  assert.ok(names2.includes('\'=HYPERLINK("http://x")'));
  const leads = grid(full.getWorksheet('לידים – רשימה')).map((x) => x[1]);
  assert.ok(leads.includes("'@cmd") && leads.includes("'-minus"));
});

test('XML-hostile text is escaped and control characters are dropped (the file always opens)', async () => {
  const nasty = '<b>&"\'</b>\u0001\u0007￾ end ]]>';
  const wb = await load(X.writeXlsx({ sheets: [{ name: '<x>&', columns: [{ header: '<h>' }], rows: [[nasty]] }] }));
  assert.equal(wb.worksheets[0].name, '<x>&');
  assert.equal(wb.worksheets[0].getCell('A1').value, '<h>');
  assert.equal(wb.worksheets[0].getCell('A2').value, '<b>&"\'</b> end ]]>');
});

/* ---------- edge cases ---------- */

test('an empty period: every sheet exists with its header, no crash', async () => {
  const empty = {
    funnel: LF.funnel({ from: FROM, to: TO }), retention: R.computeRetention({ from: FROM, to: TO, today: TODAY }),
    from: FROM, to: TO, exportedAt: AT,
  };
  const wb = await load(X.writeXlsx(X.fullWorkbook(empty)));
  assert.equal(wb.worksheets.length, 8);
  for (const n of ['לידים – רשימה', 'מטופלים – רשימה', 'נתונים חסרים']) {
    assert.equal(wb.getWorksheet(n).rowCount, 1, n + ': header only');
  }
  const pct = grid(wb.getWorksheet('שהות – חתך')).find((x) => x[0] === 'שוחררו · עד 30 יום');
  assert.equal(pct[1], 0);
  assert.ok(pct[2] === undefined || pct[2] === null, 'no % of an empty cohort (never 0% or NaN)');
});

test('a bad range (reports not ok) still writes headers only, never throws', async () => {
  const bad = { funnel: { ok: false, error: 'bad_range' }, retention: { ok: false, error: 'bad_range' }, from: 'x', to: 'y', exportedAt: AT };
  const wb = await load(X.writeXlsx(X.fullWorkbook(bad)));
  assert.equal(wb.worksheets.length, 8);
  assert.equal(X.writeXlsx({}).length > 0, true, 'no sheets → one blank sheet');
});

test('a very long list (5,000 stays) writes and reads back completely', async () => {
  const patients = [];
  for (let i = 0; i < 5000; i++) {
    const d = String(1 + (i % 28)).padStart(2, '0');
    patients.push({ id: 'p' + i, houseId: 'ramot', name: 'מטופל ' + i, date: '2026-09-' + d, status: i % 3 ? 'released' : 'active', exitDate: i % 3 ? '2026-11-' + d : '' });
  }
  const r = R.computeRetention({ patients, discharged: [], from: FROM, to: TO, today: TODAY });
  const bytes = X.writeXlsx(X.fullWorkbook({ retention: r, funnel: LF.funnel({ from: FROM, to: TO }), from: FROM, to: TO, exportedAt: AT }));
  const wb = await load(bytes);
  assert.equal(wb.getWorksheet('מטופלים – רשימה').rowCount, 1 + 5000);
  assert.equal(r.cohortSize, 5000);
});

/* ---------- zip / determinism / names ---------- */

test('crc32 is the standard CRC-32; the same input gives the same bytes', () => {
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const { ctx } = fixture();
  const a = X.writeXlsx(X.fullWorkbook(ctx)), b = X.writeXlsx(X.fullWorkbook(ctx));
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.deepEqual([...a.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a ZIP');
});

test('filenames: ezone-chitukim-<from>_<to>.xlsx and ezone-<section>-<from>_<to>.xlsx, safe characters only', () => {
  assert.equal(X.fullFilename(FROM, TO), 'ezone-chitukim-2026-09-01_2026-09-30.xlsx');
  assert.equal(X.sectionFilename('leads-funnel', FROM, TO), 'ezone-leads-funnel-2026-09-01_2026-09-30.xlsx');
  assert.equal(X.sectionFilename('../evil', '<x>', 'a/b'), 'ezone-evil-x_ab.xlsx');
  assert.equal(X.XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('the module is pure and dependency-free (only the two report modules)', () => {
  const src = read('lib', 'report-xlsx.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /(?<![\w-])document\.|(?<![\w-])window\.|fetch\(|XMLHttpRequest|console\.|localStorage|Date\.now|new Date\(\)/);
  assert.deepEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./leads-funnel', './patient-retention']);
});

/* ---------- the page: the file equals the screen ---------- */

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

test('page: «ייצוא הכל לאקסל» downloads ONE file whose numbers equal the panels\' reports', async () => {
  const { pg, downloads } = page();
  const fx = fixture();
  pg.set({ patients: fx.retention && [
    { id: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' },
    { id: 'p4', houseId: 'arfoni', name: 'דלת', date: '2026-09-20', status: 'active' },
  ], dischargedPatients: [{ id: 'a1', patientId: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', exitDate: '2026-09-11', continuity: 'none' }],
  leads: [{ id: 'l1', name: 'ליד', phone: '0521234567', created: '2026-09-04', stage: 'visit' }], irrelevantLeads: [] });
  pg.run(`exportAllReportsXlsx('${FROM}', '${TO}')`);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'ezone-chitukim-2026-09-01_2026-09-30.xlsx');
  assert.equal(downloads[0].blob.type, X.XLSX_MIME);
  const wb = await load(downloads[0].blob.parts[0]);
  assert.equal(wb.worksheets.length, 8);
  const screen = pg.run(`patientRetentionReport(state, { from: '${FROM}', to: '${TO}', threshold: '' })`);
  const funnel = pg.run(`leadsFunnelReport(state, '${FROM}', '${TO}')`);
  const g = grid(wb.getWorksheet('סיכום'));
  const row = (label) => g.find((x) => x && x[0] === label);
  assert.equal(row('נכנסו בתקופה (הקבוצה)')[1], screen.cohortSize);
  assert.equal(row('שוחררו · עד 30 יום')[1], screen.counts.upTo30);
  assert.equal(row('עדיין בטיפול')[1], screen.stillInTreatment.count);
  assert.equal(row('המשך טיפול · לא המשיך (אחוז מהמשוחררים)')[1], screen.continuity.none);
  assert.equal(row('הגיעו לפגישה ולא נכנסו')[1], funnel.counts.visitedNotEntered);
});

test('page: section and list exports name their files and carry only their sheets', async () => {
  const { pg, downloads } = page();
  pg.set({ patients: [{ id: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' }], dischargedPatients: [], leads: [], irrelevantLeads: [] });
  pg.sandbox.__rep = pg.run(`patientRetentionReport(state, { from: '${FROM}', to: '${TO}', threshold: '' })`);
  pg.run(`exportReportXlsx('continuity', reportXlsxContext(null, globalThis.__rep, '${FROM}', '${TO}'))`);
  pg.run(`exportListXlsx('patients', globalThis.__rep.rows.upTo30, '${FROM}', '${TO}', 'שוחררו · עד 30 יום')`);
  assert.deepEqual(downloads.map((d) => d.name), ['ezone-continuity-2026-09-01_2026-09-30.xlsx', 'ezone-patients-list-2026-09-01_2026-09-30.xlsx']);
  assert.deepEqual(names(await load(downloads[0].blob.parts[0])), ['המשך טיפול', 'מטופלים – רשימה']);
  const list = await load(downloads[1].blob.parts[0]);
  assert.deepEqual(names(list), ['שוחררו · עד 30 יום']);
  assert.equal(list.worksheets[0].rowCount, 2);
});

test('page: a missing module shows an error, never a broken download', () => {
  const { pg, downloads } = page();
  pg.sandbox.ReportXlsx = undefined;
  pg.run(`exportAllReportsXlsx('${FROM}', '${TO}')`);
  assert.equal(downloads.length, 0);
  assert.ok(pg.errors.some((m) => m.includes('הייצוא לאקסל לא נטען')));
});

test('page: the buttons — per section, per list, and «ייצוא הכל לאקסל» on both panels; CSV kept', () => {
  const { pg } = page();
  pg.set({ patients: [{ id: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' }], dischargedPatients: [], leads: [], irrelevantLeads: [] });
  const rHtml = pg.run(`patientRetentionHtml(patientRetentionReport(state, { from: '${FROM}', to: '${TO}', threshold: '' }), { from: '${FROM}', to: '${TO}', threshold: '', sel: { kind: 'bucket', key: 'upTo30' } }, { edit: false })`);
  assert.ok(rHtml.includes('class="btn small pr-xlsx" data-section="retention">ייצוא לאקסל'));
  assert.ok(rHtml.includes('class="btn small pr-xlsx" data-section="continuity">ייצוא לאקסל'));
  assert.ok(rHtml.includes('pr-xlsx-all">ייצוא הכל לאקסל'));
  assert.ok(rHtml.includes('pr-xlsx-list">ייצוא לאקסל'));
  assert.ok(rHtml.includes('ייצוא CSV'));
  const lHtml = pg.run(`leadsFunnelHtml(leadsFunnelReport(state, '${FROM}', '${TO}'), { from: '${FROM}', to: '${TO}', bucket: 'notRelevant' })`);
  assert.ok(lHtml.includes('lf-xlsx" data-section="leads">ייצוא לאקסל'));
  assert.ok(lHtml.includes('lf-xlsx-all">ייצוא הכל לאקסל'));
  assert.ok(lHtml.includes('lf-xlsx-list">ייצוא לאקסל'));
  assert.ok(lHtml.includes('ייצוא CSV'));
});

/* ---------- wiring ---------- */

test('wiring: static asset only (no export route), loads after its two modules and before app.js; SW v79', () => {
  const html = read('public', 'index.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('leads-funnel.js?v=') < at('report-xlsx.js?v=') && at('patient-retention.js?v=') < at('report-xlsx.js?v=') && at('report-xlsx.js?v=') < at('app.js?v=__BUILD__'));
  const server = read('server.js');
  assert.match(server, /'\/report-xlsx\.js': \{ file: path\.join\(__dirname, 'lib', 'report-xlsx\.js'\)/);
  assert.match(server, /app\.get\('\/report-xlsx\.js', sendLibAsset\('\/report-xlsx\.js'\)\);/);
  assert.doesNotMatch(server, /chitukim|\/api\/export\/(retention|leads|patients)/i, 'no server-side export route');
  const sw = read('public', 'sw.js');
  assert.match(sw, /var BUNDLE_PATHS = \[[^\]]*'\/report-xlsx\.js'[^\]]*\]/);
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(sw)[1]) >= 79);
  assert.equal(read('apps-script', 'Code.gs').includes('report-xlsx'), false, 'no Code.gs change');
  const css = read('public', 'style.css');
  assert.match(css, /\.lf-xlsx, \.lf-xlsx-all, \.lf-xlsx-list, \.pr-xlsx, \.pr-xlsx-all, \.pr-xlsx-list \{ min-height: 44px; font-size: 16px; \}/);
});
