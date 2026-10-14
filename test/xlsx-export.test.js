/* Tests for the «ייצוא זיכויים לאקסל» .xlsx export (CHANGELOG-xlsx-export.md):
 *   A. lib/xlsx-report.js — the generated buffer, re-opened with exceljs: RTL,
 *      frozen header, autoFilter, number formats, real date cells, bold totals,
 *      column widths, sheet names and the formula guard.
 *   B. lib/refund-forecast-xlsx.js — three sheets; no section total is ever
 *      summed with another; missing rows carry no amount; labels mirror app.js.
 *   C. GET /api/export/refund-forecast.xlsx — 401 without a session; headers,
 *      RFC 5987 filename, no-store; failures are JSON; no patient data in logs.
 *   D. The service worker never caches /api/export/*; CACHE_VERSION is v23.
 *   E. app.js — the CSV path is gone; the button downloads the .xlsx and
 *      reports a Hebrew error on failure.
 *
 * SESSION_SECRET is set before server.js is required; PROXY_SECRET is left
 * unset so the real app never reaches the network (its route answers 503). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const ExcelJS = require('exceljs');

const SECRET = 'test-session-secret-xlsx-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET;
// PR C: every session is personal — a real USER_PIN_HASHES record per user.
const { applyPersonalEnv, personalToken } = require('./helpers/personal-session');
applyPersonalEnv();
const ID_BY_NAME = { 'ורד': 'vered', 'סנדרה': 'sandra', 'שירן': 'shiran', 'יעל': 'yael' };
delete process.env.PROXY_SECRET;

const report = require('../lib/xlsx-report');
const forecastXlsx = require('../lib/refund-forecast-xlsx');
const server = require('../server');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

async function openBook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}
function allCells(ws) {
  const out = [];
  ws.eachRow((row, r) => row.eachCell((cell, c) => out.push({ r, c, cell, value: cell.value })));
  return out;
}
function findRow(ws, firstCellValue) {
  let found = null;
  ws.eachRow((row) => { if (!found && row.getCell(1).value === firstCellValue) found = row; });
  return found;
}

const NOW = new Date('2026-10-02T07:05:00Z'); // 10:05 in Israel (IDT)

/* ======================= A. the shared helper ======================= */

const SIMPLE_SPEC = {
  generatedAt: NOW,
  sheets: [{
    name: 'בדיקה',
    title: 'דוח בדיקה',
    note: 'הערה',
    columns: [
      { header: 'שם', key: 'name', type: 'text', width: 25 },
      { header: 'סכום', key: 'amount', type: 'money', width: 15 },
      { header: 'תאריך', key: 'day', type: 'date', width: 13 },
      { header: 'מספר', key: 'n', type: 'int', width: 9 },
    ],
    rows: [
      { name: '=HYPERLINK("http://evil")', amount: 1234.5, day: '2026-09-15', n: 3 },
      { name: '+972-50', amount: 10, day: '2026-02-30', n: 1 },
      { name: '-2+3', amount: '', day: '', n: '' },
      { name: '@SUM(A1)', amount: 0, day: new Date(Date.UTC(2026, 9, 1)), n: 0 },
      { name: '\tTAB', amount: 5, day: '2026-10-15', n: 2 },
      { name: 'דנה', amount: 7, day: '2026-10-15', n: 2 },
    ],
    totals: [{ label: 'סה"כ', values: { amount: 1256.5, n: 8 } }],
  }],
};

test('A: RTL view, title + «הופק ב־» rows, frozen bold filled header with autoFilter', async () => {
  const wb = await openBook(await report.buildXlsxReport(SIMPLE_SPEC));
  const ws = wb.getWorksheet('בדיקה');
  assert.ok(ws, 'sheet name');
  assert.strictEqual(ws.views[0].rightToLeft, true, 'RTL');
  assert.strictEqual(ws.getCell('A1').value, 'דוח בדיקה');
  assert.strictEqual(ws.getCell('A1').font.bold, true);
  assert.strictEqual(ws.getCell('A2').value, 'הופק ב־02/10/2026 10:05', 'Israel time, DD/MM/YYYY HH:MM');
  assert.strictEqual(ws.getCell('A3').value, 'הערה');
  // row 4 is blank, row 5 is the header
  const header = ws.getRow(5);
  assert.deepStrictEqual([1, 2, 3, 4].map((c) => header.getCell(c).value), ['שם', 'סכום', 'תאריך', 'מספר']);
  [1, 2, 3, 4].forEach((c) => {
    assert.strictEqual(header.getCell(c).font.bold, true, 'bold header');
    assert.strictEqual(header.getCell(c).fill.fgColor.argb, 'FFD9E2F3', 'header fill');
  });
  assert.strictEqual(ws.views[0].state, 'frozen');
  assert.strictEqual(ws.views[0].ySplit, 5, 'frozen through the header row');
  const af = ws.autoFilter;
  const ref = typeof af === 'string' ? af : `${af.from}:${af.to}`;
  assert.ok(/^A5:D11$/.test(ref), 'autoFilter spans header + data rows: ' + JSON.stringify(af));
});

test('A: money ₪#,##0, int 0, real Excel dates shown DD/MM/YYYY, empty stays empty (never 0)', async () => {
  const wb = await openBook(await report.buildXlsxReport(SIMPLE_SPEC));
  const ws = wb.getWorksheet('בדיקה');
  const r1 = ws.getRow(6);
  assert.strictEqual(r1.getCell(2).value, 1234.5);
  assert.strictEqual(r1.getCell(2).numFmt, '"₪"#,##0');
  assert.ok(r1.getCell(3).value instanceof Date, 'a real date cell');
  assert.strictEqual(r1.getCell(3).value.toISOString().slice(0, 10), '2026-09-15');
  assert.strictEqual(r1.getCell(3).numFmt, 'dd/mm/yyyy');
  assert.strictEqual(r1.getCell(4).value, 3);
  assert.strictEqual(r1.getCell(4).numFmt, '0');
  // an impossible date is kept as (guarded) text, never a wrong date
  assert.strictEqual(ws.getRow(7).getCell(3).value, '2026-02-30');
  // empty money/date/int stay empty
  const r3 = ws.getRow(8);
  assert.strictEqual(r3.getCell(2).value, null);
  assert.strictEqual(r3.getCell(3).value, null);
  assert.strictEqual(r3.getCell(4).value, null);
  // a real 0 is a 0 and a Date input is a date
  assert.strictEqual(ws.getRow(9).getCell(2).value, 0);
  assert.strictEqual(ws.getRow(9).getCell(3).value.toISOString().slice(0, 10), '2026-10-01');
});

test('A: the formula guard — = + - @ tab get a leading \', no cell is a formula', async () => {
  const wb = await openBook(await report.buildXlsxReport(SIMPLE_SPEC));
  const ws = wb.getWorksheet('בדיקה');
  const names = [6, 7, 8, 9, 10, 11].map((r) => ws.getRow(r).getCell(1).value);
  assert.deepStrictEqual(names, [`'=HYPERLINK("http://evil")`, "'+972-50", "'-2+3", "'@SUM(A1)", "'\tTAB", 'דנה']);
  for (const { value } of allCells(ws)) {
    assert.ok(!(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)), 'no formula cells');
    if (typeof value === 'string') assert.ok(!/^[=+\-@\t\r]/.test(value), 'unguarded: ' + value);
  }
  assert.strictEqual(report.guardText('=1+1'), "'=1+1");
  assert.strictEqual(report.guardText('\r'), "'\r");
  assert.strictEqual(report.guardText('שלום'), 'שלום');
  assert.strictEqual(report.guardText(null), '');
});

test('A: the total row is bold with the values given; column widths are set', async () => {
  const wb = await openBook(await report.buildXlsxReport(SIMPLE_SPEC));
  const ws = wb.getWorksheet('בדיקה');
  const tot = findRow(ws, 'סה"כ');
  assert.ok(tot, 'total row');
  assert.strictEqual(tot.getCell(2).value, 1256.5);
  assert.strictEqual(tot.getCell(2).numFmt, '"₪"#,##0');
  assert.strictEqual(tot.getCell(4).value, 8);
  [1, 2, 3, 4].forEach((c) => assert.strictEqual(tot.getCell(c).font.bold, true));
  // Widths are computed from the longest displayed value, never below 12
  // (CHANGELOG-billing-tab-section-colors.md); the spec's `width` is ignored.
  const widths = [1, 2, 3, 4].map((c) => ws.getColumn(c).width);
  widths.forEach((w) => assert.ok(w >= 12 && w <= 60, String(w)));
  assert.ok(widths[0] >= '=HYPERLINK("http://evil")'.length + 1, 'the longest name fits');
});

test('A: empty rows → an explicit empty text; a bad spec throws', async () => {
  const wb = await openBook(await report.buildXlsxReport({
    generatedAt: NOW, sheets: [{ name: 'ריק', title: 'ריק', columns: [{ header: 'שם', key: 'n' }], rows: [], emptyText: 'אין נתונים' }],
  }));
  assert.ok(findRow(wb.getWorksheet('ריק'), 'אין נתונים'));
  await assert.rejects(report.buildXlsxReport({ sheets: [] }));
  await assert.rejects(report.buildXlsxReport({ sheets: [{ name: 'x', columns: [] }] }));
  await assert.rejects(report.buildXlsxReport({ sheets: [{ name: 'x', columns: [{ header: 'a', key: 'a', type: 'formula' }] }] }));
});

test('A: toExcelDate / isoDayInIsrael / formatStamp', () => {
  assert.strictEqual(report.toExcelDate('2026-12-31').toISOString(), '2026-12-31T00:00:00.000Z');
  assert.strictEqual(report.toExcelDate('31/12/2026'), null);
  assert.strictEqual(report.toExcelDate(''), null);
  assert.strictEqual(report.toExcelDate('2026-13-01'), null);
  assert.strictEqual(report.isoDayInIsrael(new Date('2026-10-01T22:30:00Z')), '2026-10-02', 'Israel day, not UTC');
  assert.strictEqual(report.formatStamp(new Date('2026-01-05T08:07:00Z')), '05/01/2026 10:07');
});

/* ======================= B. the refund-forecast workbook ======================= */

function forecastFixture() {
  const rows = [
    { creditId: 'c1', auto: false, patientKey: 'k1', patientName: '@SUM(A1)', houseId: 'ramot', totalPaid: 12000, entryDate: '2026-08-20', exitDate: '2026-09-08',
      disposition: 'stopped_early', dischargeNote: '-2+3', daysStayed: 19, refundDays: 9, amount: 1000, calculatedAmount: 1000, overridden: false,
      ruleVersion: 1, rule: 'residential_prorata', creditType: 'days_unused', allocationMonth: '2026-09', payoutDate: '2026-09-15' },
    { creditId: '', auto: true, patientKey: 'k2', patientName: 'דנה', houseId: 'rehab', totalPaid: 8000, entryDate: '2026-09-10', exitDate: '2026-09-28',
      disposition: 'completed', dischargeNote: '', daysStayed: 18, refundDays: 3, amount: 500, calculatedAmount: 500, overridden: false,
      ruleVersion: 2, rule: 'stay_prorata,prepaid_return', creditType: 'days_unused', allocationMonth: '2026-10', payoutDate: '2026-10-15' },
    { creditId: 'c3', auto: false, patientKey: 'k3', patientName: '=HYPERLINK("http://x")', houseId: 'ramot', totalPaid: 9000, entryDate: '2026-09-01', exitDate: '2026-09-25',
      disposition: 'released_outpatient', dischargeNote: 'עבר לטיפול חוץ', daysStayed: 24, refundDays: 4, amount: 2345, calculatedAmount: 2000, overridden: true,
      ruleVersion: 2, rule: 'stay_prorata', creditType: 'days_unused', allocationMonth: '2026-10', payoutDate: '2026-10-15' },
  ];
  return {
    ok: true, today: '2026-10-02', recordsCutoff: '2026-07-01', policyCutover: '2026-10-01',
    toPay: {
      count: 3, total: 3845,
      byPayoutDate: [
        { payoutDate: '2026-09-15', count: 1, total: 1000 },
        { payoutDate: '2026-10-15', count: 2, total: 2845 },
      ],
      rows,
    },
    missing_payment_data: { count: 1, rows: [{ patientName: '+972-50', houseId: 'rehab', entryDate: '2026-09-02', exitDate: '2026-09-06', note: 'אין תשלום רשום — לבדוק' }] },
    unresolved: { count: 1, rows: [{ patientName: 'יוסי', houseId: 'mars', entryDate: '2026-08-01', exitDate: '2026-09-01', error: 'unknown_house' }] },
    zeroByPolicyCount: 40, preCutoffExcludedCount: 2, zeroCreditsHidden: true,
  };
}

async function forecastBook(data) {
  return openBook(await report.buildXlsxReport(forecastXlsx.buildRefundForecastSpec(data || forecastFixture(), NOW)));
}
function rowWhere(ws, col, value) {
  let found = null;
  ws.eachRow((x) => { if (!found && x.getCell(col).value === value) found = x; });
  return found;
}
function headerOf(ws) {
  const r = ws.getRow(ws.views[0].ySplit);
  const out = [];
  r.eachCell((c) => out.push(c.value));
  return out;
}

test('B: three sheets with the agreed Hebrew names, every one RTL with a frozen header', async () => {
  const wb = await forecastBook();
  // No sheet for discharges with no recorded payment — they are debt, shown in
  // «חובות פתוחים»; «סיכום» keeps their count (CHANGELOG-billing-tab-section-colors.md).
  // No decision sheet — refunds are automatic (CHANGELOG-refunds-auto-policy.md).
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['סיכום', 'זיכויים לתשלום', 'לא ניתן לחשב']);
  wb.worksheets.forEach((ws) => {
    assert.strictEqual(ws.views[0].rightToLeft, true, ws.name + ' RTL');
    assert.strictEqual(ws.views[0].state, 'frozen', ws.name + ' frozen');
    assert.ok(ws.views[0].ySplit > 0);
    assert.strictEqual(ws.getRow(ws.views[0].ySplit).getCell(1).font.bold, true, ws.name + ' header bold');
    assert.ok(ws.autoFilter, ws.name + ' autoFilter');
    assert.strictEqual(ws.getCell('A2').value, 'הופק ב־02/10/2026 10:05');
  });
});

test('B: «זיכויים לתשלום» — every screen column, payout dates as dates, money, leave reason, rule, guarded text, own total', async () => {
  const ws = (await forecastBook()).getWorksheet('זיכויים לתשלום');
  assert.deepStrictEqual(headerOf(ws), [
    'תאריך תשלום', 'מטופל', 'בית', 'סה"כ שולם', 'תאריך כניסה', 'תאריך יציאה', 'סיבת עזיבה',
    'ימי שהייה', 'ימי זיכוי', 'סכום זיכוי (כולל מע"מ)', 'כלל', 'פירוט הכלל',
  ]);
  const row = rowWhere(ws, 2, "'@SUM(A1)");
  assert.ok(row, 'row present, name guarded');
  assert.strictEqual(row.getCell(1).value.toISOString().slice(0, 10), '2026-09-15');
  assert.strictEqual(row.getCell(1).numFmt, 'dd/mm/yyyy');
  assert.strictEqual(row.getCell(3).value, 'רמות השבים');
  assert.strictEqual(row.getCell(4).value, 12000);
  assert.strictEqual(row.getCell(4).numFmt, '"₪"#,##0');
  assert.strictEqual(row.getCell(5).value.toISOString().slice(0, 10), '2026-08-20');
  assert.strictEqual(row.getCell(6).value.toISOString().slice(0, 10), '2026-09-08');
  // disposition label + discharge note; the note is guarded text
  assert.strictEqual(row.getCell(7).value, 'הפסיק לפני הזמן — -2+3');
  assert.strictEqual(row.getCell(8).value, 19);
  assert.strictEqual(row.getCell(9).value, 9);
  assert.strictEqual(row.getCell(10).value, 1000);
  assert.strictEqual(row.getCell(10).numFmt, '"₪"#,##0');
  assert.strictEqual(row.getCell(11).value, 'ישן (לפי בית)');
  assert.strictEqual(row.getCell(12).value, 'מגורים — זיכוי יחסי על הימים שלא שהה');

  const auto = rowWhere(ws, 2, 'דנה');
  assert.ok(auto, 'a computed (auto) row is listed too');
  assert.strictEqual(auto.getCell(7).value, 'סיים טיפול', 'no note → the label alone');
  assert.strictEqual(auto.getCell(11).value, 'חדש (אחיד)');
  assert.strictEqual(auto.getCell(12).value, 'יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי + מחזור ששולם מראש ולא התחיל — החזר מלא');

  const formulaName = rowWhere(ws, 2, `'=HYPERLINK("http://x")`);
  assert.ok(formulaName, 'a formula-like name is guarded');
  assert.strictEqual(formulaName.getCell(10).value, 2345, 'the stored (overridden) amount, not the calculated one');

  const tot = findRow(ws, 'סה"כ לתשלום');
  assert.ok(tot);
  assert.strictEqual(tot.getCell(10).value, 3845);
  assert.strictEqual(tot.getCell(10).font.bold, true);

  assert.strictEqual(forecastXlsx.leaveReasonText({ disposition: '', dischargeNote: '' }), '—');
  assert.strictEqual(forecastXlsx.leaveReasonText({ disposition: 'odd_code' }), 'odd_code');
});

test('B: «לא ניתן לחשב» — rows; no-payment discharges are never listed', async () => {
  const wb = await forecastBook();
  assert.strictEqual(wb.getWorksheet('חסרים נתוני תשלום'), undefined);
  wb.worksheets.forEach((w) => assert.ok(!findRow(w, "'+972-50") && !rowWhere(w, 2, "'+972-50"), 'the no-payment patient is not listed in ' + w.name));

  const un = wb.getWorksheet('לא ניתן לחשב');
  const u = findRow(un, 'יוסי');
  assert.strictEqual(u.getCell(2).value, 'mars', 'an unknown house id is shown as-is');
  assert.strictEqual(u.getCell(5).value, 'בית לא מוכר');
});

test('B: «סיכום» — totals per payment date with a grand total, counts only for the rest', async () => {
  const ws = (await forecastBook()).getWorksheet('סיכום');
  const cells = allCells(ws);
  const texts = cells.map((c) => c.value).filter((v) => typeof v === 'string');
  assert.ok(texts.includes('זיכויים לתשלום — לפי תאריך תשלום'));
  assert.ok(texts.includes('לבדיקה — ספירה בלבד, ללא סכום'));
  // per-date rows are real dates with their own count and total
  const dateRows = [];
  ws.eachRow((r) => { if (r.getCell(1).value instanceof Date) dateRows.push([r.getCell(1).value.toISOString().slice(0, 10), r.getCell(2).value, r.getCell(3).value]); });
  assert.deepStrictEqual(dateRows, [['2026-09-15', 1, 1000], ['2026-10-15', 2, 2845]]);
  cells.filter((c) => c.value instanceof Date).forEach((c) => assert.strictEqual(c.cell.numFmt, 'dd/mm/yyyy'));
  const grand = findRow(ws, 'סה"כ לתשלום');
  assert.strictEqual(grand.getCell(2).value, 3);
  assert.strictEqual(grand.getCell(3).value, 3845);
  assert.strictEqual(grand.getCell(3).font.bold, true);
  // the counts block
  const line = findRow(ws, 'משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״');
  assert.strictEqual(line.getCell(2).value, 1, 'count only');
  assert.ok(line.getCell(3).value == null, 'no amount');
  assert.strictEqual(findRow(ws, 'לא ניתן לחשב — לבדוק').getCell(2).value, 1);
  assert.strictEqual(findRow(ws, 'אפס לפי מדיניות (לא מוצגים)').getCell(2).value, 40);
});

test('B: no section total is ever summed with another', async () => {
  const data = forecastFixture();
  const wb = await forecastBook(data);
  const countSum = data.missing_payment_data.count + data.unresolved.count + data.zeroByPolicyCount;
  const withCounts = data.toPay.count + countSum;
  wb.worksheets.forEach((ws) => {
    allCells(ws).forEach(({ value }) => {
      assert.notStrictEqual(value, withCounts, `${ws.name}: the list count is never added to the check counts`);
      if (typeof value === 'string') assert.ok(!/סה"כ כולל|כל הסעיפים|סה"כ כללי/.test(value), ws.name + ': ' + value);
    });
  });
  const summary = wb.getWorksheet('סיכום');
  const totalLabels = [];
  summary.eachRow((r) => { if (/^סה"כ/.test(String(r.getCell(1).value))) totalLabels.push([r.getCell(1).value, r.getCell(3).value]); });
  assert.deepStrictEqual(totalLabels, [['סה"כ לתשלום', 3845]], 'only the list carries a money total');
  allCells(summary).forEach(({ value }) => assert.notStrictEqual(value, countSum, 'the counts are never added up'));
  // Built only from the server's own totals: the grand total is toPay.total,
  // never a re-sum of the rows or the per-date groups.
  const d2 = forecastFixture(); d2.toPay.total = 4000; d2.toPay.byPayoutDate[0].total = 99999;
  const wb2 = await forecastBook(d2);
  assert.strictEqual(findRow(wb2.getWorksheet('זיכויים לתשלום'), 'סה"כ לתשלום').getCell(10).value, 4000);
  assert.strictEqual(findRow(wb2.getWorksheet('סיכום'), 'סה"כ לתשלום').getCell(3).value, 4000);
});

test('B: empty sections say so in words; isForecastResponse rejects bad shapes', async () => {
  const empty = {
    ok: true, toPay: { count: 0, total: 0, byPayoutDate: [], rows: [] },
    missing_payment_data: { count: 0, rows: [] }, zeroByPolicyCount: 0,
  };
  assert.ok(forecastXlsx.isForecastResponse(empty));
  const wb = await forecastBook(empty);
  assert.ok(findRow(wb.getWorksheet('זיכויים לתשלום'), 'אין זיכויים לתשלום'));
  assert.ok(findRow(wb.getWorksheet('סיכום'), 'אין זיכויים לתשלום'));
  assert.ok(findRow(wb.getWorksheet('לא ניתן לחשב'), 'אין שחרורים שלא ניתן לחשב'));
  assert.ok(!forecastXlsx.isForecastResponse(null));
  assert.ok(!forecastXlsx.isForecastResponse({ ok: false, error: 'x' }));
  assert.ok(!forecastXlsx.isForecastResponse({ ok: true, toPay: {} }));
  assert.ok(!forecastXlsx.isForecastResponse({ ok: true, toPay: { rows: [] }, missing_payment_data: { count: 0 } }), 'no byPayoutDate');
  assert.ok(!forecastXlsx.isForecastResponse({ ok: true, toPay: { rows: [], byPayoutDate: [] } }), 'no missing count');
  // the old (decision-step) shape is no longer accepted
  assert.ok(!forecastXlsx.isForecastResponse({
    ok: true, decided: { count: 0, total: 0, byPayoutDate: [], byHouse: [] },
    awaiting_decision: { count: 0, total: 0, byPayoutDate: [], byHouse: [] },
    missing_payment_data: { count: 0, rows: [] },
  }));
});

test('B: the server label copies match public/app.js exactly', () => {
  const plainObj = (o) => JSON.parse(JSON.stringify(o));
  const lit = (name) => {
    const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(APP_SRC);
    assert.ok(m, name + ' found in app.js');
    return JSON.parse(JSON.stringify(vm.runInNewContext('(' + m[1] + ')')));
  };
  const houses = vm.runInNewContext('(' + /const HOUSES = (\[[\s\S]*?\n\]);/.exec(APP_SRC)[1] + ')');
  const houseMap = {}; houses.forEach((h) => { houseMap[h.id] = h.name; });
  assert.deepStrictEqual(forecastXlsx.HOUSE_NAMES, houseMap);
  assert.deepStrictEqual(forecastXlsx.RULE_LABELS, lit('CREDIT_RULE_LABELS'));
  assert.deepStrictEqual(forecastXlsx.CREDIT_TYPE_LABELS, lit('CREDIT_TYPE_LABELS'));
  assert.deepStrictEqual(forecastXlsx.SECTION_LABELS, lit('PAYOUT_FORECAST_SECTION_LABELS'));
  assert.deepStrictEqual(forecastXlsx.ERROR_LABELS, lit('PAYOUT_FORECAST_ERROR_LABELS'));
  assert.deepStrictEqual(forecastXlsx.DISPOSITION_LABELS, lit('DISPOSITION_LABELS'));
  assert.deepStrictEqual(plainObj(forecastXlsx.RULE_VERSION_LABELS),
    plainObj(vm.runInNewContext('(' + /const REFUND_RULE_VERSION_LABELS = (\{[^}]*\});/.exec(APP_SRC)[1] + ')')));
  assert.ok(APP_SRC.includes(`const PAYOUT_FORECAST_MISSING_LINE = '${forecastXlsx.MISSING_LINE}';`));
});

/* ======================= C. the route ======================= */

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const ROUTE = '/api/export/refund-forecast.xlsx';
// A finance user's personal cookie (Shiran / Yael get 403 on these routes — restricted view).
const cookie = (user) => ({ Cookie: `ezone_session=${personalToken(SECRET, ID_BY_NAME[user])}` });

function captureLogs() {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  ['log', 'error', 'warn'].forEach((k) => { console[k] = (...a) => lines.push(a.map(String).join(' ')); });
  return { lines, restore: () => Object.assign(console, orig) };
}

test('C: the real app — 401 without a session (no export), 503 fail-closed without PROXY_SECRET', async () => {
  const s = await listen(server.app);
  try {
    const port = s.address().port;
    const none = await get(port, ROUTE);
    assert.strictEqual(none.status, 401);
    assert.ok(!/spreadsheetml/.test(none.headers['content-type'] || ''));
    assert.deepStrictEqual(JSON.parse(none.body.toString()), { error: 'unauthorized' });
    const bad = await get(port, ROUTE, { Cookie: 'ezone_session=123.deadbeef' });
    assert.strictEqual(bad.status, 401);
    const ok = await get(port, ROUTE, cookie('ורד'));
    assert.strictEqual(ok.status, 503, 'route is mounted behind requireProxySecret');
    assert.ok(/no-store/.test(ok.headers['cache-control']));
  } finally { s.close(); }
});

function stubApp(fetchForecast) {
  const app = express();
  app.get(ROUTE, server.requireSession, server.refundForecastXlsxHandler({ fetchForecast, now: () => NOW }));
  return app;
}

test('C: success — xlsx content type, RFC 5987 filename, no-store, a real workbook; the session user is forwarded', async () => {
  const users = [];
  const s = await listen(stubApp(async (u) => { users.push(u); return forecastFixture(); }));
  const logs = captureLogs();
  let res;
  try {
    res = await get(s.address().port, ROUTE, cookie('ורד'));
  } finally { logs.restore(); s.close(); }
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  const cd = res.headers['content-disposition'];
  const expected = encodeURIComponent('זיכויים-לתשלום-2026-10-02.xlsx');
  assert.strictEqual(cd, `attachment; filename="refund-forecast-2026-10-02.xlsx"; filename*=UTF-8''${expected}`);
  assert.strictEqual(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(cd)[1]), 'זיכויים-לתשלום-2026-10-02.xlsx');
  assert.strictEqual(Number(res.headers['content-length']), res.body.length);
  assert.deepStrictEqual(users, ['ורד']);
  const wb = await openBook(res.body);
  assert.strictEqual(wb.worksheets.length, 3);
  // no patient data in the logs
  const joined = logs.lines.join('\n');
  for (const p of ['@SUM(A1)', 'דנה', 'HYPERLINK', '+972-50', 'יוסי', '2345', '3845']) assert.ok(!joined.includes(p), 'log leaked ' + p);
});

test('C: failures answer JSON with no-store and log only a code', async () => {
  const cases = [
    [async () => ({ ok: false, error: 'lock_busy' }), 503, 'lock_busy'],
    [async () => ({ ok: false, error: 'unauthorized' }), 502, 'unauthorized'],
    [async () => ({ ok: true, toPay: {} }), 502, 'bad_response'],
    [async () => { throw new Error('ECONNRESET דנה'); }, 502, 'sheets_unreachable'],
  ];
  for (const [fn, status, error] of cases) {
    const s = await listen(stubApp(fn));
    const logs = captureLogs();
    let res;
    try { res = await get(s.address().port, ROUTE, cookie('סנדרה')); } finally { logs.restore(); s.close(); }
    assert.strictEqual(res.status, status, error);
    assert.deepStrictEqual(JSON.parse(res.body.toString()), { ok: false, error });
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.ok(!res.headers['content-disposition']);
    assert.ok(!logs.lines.join('\n').includes('דנה'), 'no patient text in logs');
  }
});

test('C: contentDisposition — ASCII fallback, encoded UTF-8 name, a bad day never reaches the header', () => {
  const v = forecastXlsx.contentDisposition('2026-01-31');
  assert.ok(/^[\x20-\x7e]+$/.test(v), 'the header value is pure ASCII');
  assert.ok(v.includes('filename="refund-forecast-2026-01-31.xlsx"'));
  const injected = forecastXlsx.contentDisposition('2026-01-31"\r\nSet-Cookie: x=1');
  assert.ok(!/[\r\n"]x=1|Set-Cookie/.test(injected));
  assert.ok(injected.includes('unknown-date'));
});

/* ======================= D. service worker ======================= */

function loadSw() {
  const handlers = {};
  const puts = [];
  const moduleObj = { exports: {} };
  const sandbox = {
    self: { addEventListener: (n, f) => { handlers[n] = f; }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: {
      open: () => Promise.resolve({ put: (k) => { puts.push(String(k)); return Promise.resolve(); }, addAll: () => Promise.resolve() }),
      keys: () => Promise.resolve([]), delete: () => Promise.resolve(true), match: () => Promise.resolve(undefined),
    },
    fetch: () => Promise.resolve({ clone() { return this; }, ok: true, status: 200 }),
    Response: { error: () => ({}) }, Promise, URL, TypeError, Array, String,
    console: { log() {}, warn() {}, error() {} }, module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, puts, exports: moduleObj.exports };
}

test('D: the SW never caches /api/export/* and is bumped to v23 or later', async () => {
  const sw = loadSw();
  // v23 shipped with this export; later PRs bump it again (v24: debt aging).
  assert.ok(Number(String(sw.exports.CACHE_VERSION).slice(1)) >= 23, sw.exports.CACHE_VERSION);
  for (const u of ['/api/export/refund-forecast.xlsx', 'https://ezone.example/api/export/refund-forecast.xlsx', '/api/export/anything.xlsx?x=1']) {
    assert.strictEqual(sw.exports.cacheStrategy(u), 'network-only', u);
    assert.strictEqual(sw.exports.shouldCache(u), false, u);
    let intercepted = false;
    sw.handlers.fetch({ request: { method: 'GET', url: u }, respondWith: () => { intercepted = true; } });
    assert.strictEqual(intercepted, false, 'the SW does not intercept ' + u);
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(sw.puts, [], 'nothing written to the cache');
});

/* ======================= E. app.js ======================= */

test('E: the CSV path and its code are gone; the button is the .xlsx export', () => {
  for (const gone of ['buildPayoutForecastCsv', 'exportPayoutForecastCsv', 'csvCell', 'csvLine', 'text/csv', '.csv`', 'payoutForecastStamp']) {
    assert.ok(!APP_SRC.includes(gone), 'still in app.js: ' + gone);
  }
  assert.ok(APP_SRC.includes("const PAYOUT_FORECAST_XLSX_URL = '/api/export/refund-forecast.xlsx';"));
  assert.ok(/busyButton\(exp, 'load', exportPayoutForecastXlsx\)/.test(APP_SRC), 'spinner while busy');
  assert.ok(HTML_SRC.includes('id="credits-forecast-export"') && HTML_SRC.includes('ייצוא זיכויים לאקסל'));
});

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '', value: '', hidden: false, download: '', href: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {}, click() { this.clicked = true; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function loadApp(fetchImpl) {
  const created = [];
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      getElementById: () => fakeEl(),
      createElement: () => { const e = fakeEl(); created.push(e); return e; },
      querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL: Object.assign(function () {}, { createObjectURL: () => 'blob:x', revokeObjectURL: noop }),
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Intl, Set, Map,
    setTimeout, clearTimeout,
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    showPinScreen = () => { globalThis.__pin++; };
    globalThis.__pin = 0;
    globalThis.__t = { exportPayoutForecastXlsx, payoutForecastXlsxErrorText, todayISO };`, sandbox);
  return { t: sandbox.__t, created, calls, pin: () => sandbox.__pin };
}

test('E: a successful export GETs the route (no-store) and downloads זיכויים-לתשלום-<day>.xlsx', async () => {
  const app = loadApp(async () => ({ ok: true, status: 200, blob: async () => ({ size: 3 }) }));
  await app.t.exportPayoutForecastXlsx();
  assert.strictEqual(app.calls.length, 1);
  assert.strictEqual(app.calls[0].url, '/api/export/refund-forecast.xlsx');
  assert.strictEqual(app.calls[0].opts.cache, 'no-store');
  assert.strictEqual(app.calls[0].opts.method, 'GET');
  const a = app.created.find((e) => e.download);
  assert.strictEqual(a.download, `זיכויים-לתשלום-${app.t.todayISO()}.xlsx`);
  assert.ok(a.clicked);
});

test('E: failures throw a Hebrew message (the click handler shows «הייצוא נכשל — …»)', async () => {
  const busy = loadApp(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'lock_busy' }) }));
  await assert.rejects(busy.t.exportPayoutForecastXlsx(), /המערכת עסוקה, נסו שוב/);
  const down = loadApp(async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: 'sheets_unreachable' }) }));
  await assert.rejects(down.t.exportPayoutForecastXlsx(), /אין חיבור לגיליון הנתונים/);
  const offline = loadApp(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(offline.t.exportPayoutForecastXlsx(), /אין חיבור לשרת/);
  const unauth = loadApp(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }));
  await assert.rejects(unauth.t.exportPayoutForecastXlsx(), /נדרשת התחברות מחדש/);
  assert.strictEqual(unauth.pin(), 1, 'a 401 shows the PIN screen');
  assert.strictEqual(down.t.payoutForecastXlsxErrorText(500, 'weird'), 'השרת החזיר שגיאה 500');
  assert.ok(APP_SRC.includes(".catch(e => showError('הייצוא נכשל — ' + ((e && e.message) || 'שגיאה')));"));
});
