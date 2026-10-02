/* Shared .xlsx report builder (server side). One plain spec in, one Buffer out.
 *
 * Any report can reuse it: the caller describes WHAT to show; this file owns
 * HOW it looks, so every export from the dashboard reads the same.
 *
 * Spec:
 *   {
 *     generatedAt: Date,                    // shown as «הופק ב־DD/MM/YYYY HH:MM» (Asia/Jerusalem)
 *     sheets: [{
 *       name:  'סיכום',                     // the tab name (max 31 chars, Excel rule)
 *       title: 'תחזית החזרים לתשלום',       // row 1, bold
 *       note:  'הסעיפים אינם מסתכמים יחד',  // optional row under the generated-at row
 *       // EITHER one table on the sheet:
 *       columns: [{ header, key, type: 'text'|'money'|'date'|'int', width }],
 *       rows:    [{ <key>: value, … }],
 *       totals:  [{ label, values: { <key>: number } }],   // bold rows under the table
 *       emptyText: 'אין רשומות',            // written instead of rows when rows is empty
 *       // OR several tables, each with its own header and totals:
 *       sections: [{ heading, columns, rows, totals, emptyText }],
 *     }],
 *   }
 *
 * Formatting, on every sheet:
 *   - right-to-left view;
 *   - row 1 the title, row 2 «הופק ב־…», then the optional note;
 *   - each table header is bold on a fill colour; the FIRST header on a sheet
 *     is frozen and carries the sheet's autoFilter (Excel allows one per sheet);
 *   - money → number with format ₪#,##0; int → format 0;
 *   - date  → a real Excel date (a 'YYYY-MM-DD' string or a Date), shown DD/MM/YYYY;
 *   - totals rows are bold with a top border; each table gets ONLY its own
 *     totals — this helper never sums one table into another;
 *   - column widths come from the spec (minimum 10).
 *
 * Security: every text cell is formula-guarded — a value starting with = + - @,
 * a tab or a CR gets a leading ' so a spreadsheet never runs it. Values are
 * always written as plain values, never as formulas. This module logs nothing. */

const ExcelJS = require('exceljs');

const MONEY_FORMAT = '"₪"#,##0';
const INT_FORMAT = '0';
const DATE_FORMAT = 'dd/mm/yyyy';
const HEADER_FILL = 'FFD9E2F3';
const TOTAL_FILL = 'FFF2F2F2';
const COLUMN_TYPES = ['text', 'money', 'date', 'int'];
const TZ = 'Asia/Jerusalem';
const MIN_WIDTH = 10;

/* A text value made safe for a spreadsheet. Pure. */
function guardText(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/* 'YYYY-MM-DD' (or a Date) → a Date at UTC midnight, which exceljs writes as
 * that calendar day. Anything else → null. Pure. */
function toExcelDate(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

/* «DD/MM/YYYY HH:MM» in Israel time. Pure. */
function formatStamp(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/* 'YYYY-MM-DD' in Israel time. Pure. */
function isoDayInIsrael(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/* Write one value into a cell by column type. An empty value stays an empty
 * cell — never a 0. */
function setCell(cell, type, value) {
  if (value === undefined || value === null || value === '') return;
  if (type === 'money' || type === 'int') {
    const n = Number(value);
    if (typeof value !== 'boolean' && isFinite(n)) {
      cell.value = n;
      cell.numFmt = type === 'money' ? MONEY_FORMAT : INT_FORMAT;
      return;
    }
    cell.value = guardText(value);
    return;
  }
  if (type === 'date') {
    const d = toExcelDate(value);
    if (d) { cell.value = d; cell.numFmt = DATE_FORMAT; return; }
    cell.value = guardText(value);
    return;
  }
  cell.value = guardText(value);
}

function validateColumns(columns, where) {
  if (!Array.isArray(columns) || !columns.length) throw new Error(`xlsx-report: ${where} needs columns`);
  columns.forEach((c) => {
    if (!c || !c.key || !c.header) throw new Error(`xlsx-report: ${where} has a column without key/header`);
    if (COLUMN_TYPES.indexOf(c.type || 'text') < 0) throw new Error(`xlsx-report: unknown column type ${c.type}`);
  });
}

/* Write one table from row `r`; returns the next free row. `first` marks the
 * sheet's first table (frozen header + autoFilter). */
function writeSection(ws, r, sec, first, meta) {
  validateColumns(sec.columns, `sheet «${ws.name}»`);
  const cols = sec.columns;
  if (sec.heading) {
    const h = ws.getRow(r);
    h.getCell(1).value = guardText(sec.heading);
    h.font = { bold: true, size: 12 };
    r++;
  }
  const headerRow = ws.getRow(r);
  cols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = guardText(c.header);
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin' } };
  });
  const headerAt = r;
  r++;

  const rows = Array.isArray(sec.rows) ? sec.rows : [];
  if (!rows.length) {
    ws.getRow(r).getCell(1).value = guardText(sec.emptyText || 'אין רשומות');
    ws.getRow(r).getCell(1).font = { italic: true };
    r++;
  }
  rows.forEach((row) => {
    const xr = ws.getRow(r);
    cols.forEach((c, i) => setCell(xr.getCell(i + 1), c.type || 'text', row ? row[c.key] : ''));
    r++;
  });
  const lastDataRow = r - 1;

  (Array.isArray(sec.totals) ? sec.totals : []).forEach((t) => {
    const xr = ws.getRow(r);
    xr.getCell(1).value = guardText(t.label);
    cols.forEach((c, i) => {
      if (i === 0 || !t.values || !(c.key in t.values)) return;
      setCell(xr.getCell(i + 1), c.type === 'text' || c.type === 'date' ? 'int' : c.type, t.values[c.key]);
    });
    cols.forEach((_c, i) => {
      const cell = xr.getCell(i + 1);
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
      cell.border = { top: { style: 'thin' } };
    });
    r++;
  });

  if (first) {
    meta.frozenRow = headerAt;
    ws.autoFilter = { from: { row: headerAt, column: 1 }, to: { row: Math.max(headerAt, lastDataRow), column: cols.length } };
  }
  return r + 1; // one blank row between tables
}

/* Build the workbook. Returns a Promise<Buffer>. */
async function buildXlsxReport(spec) {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) throw new Error('xlsx-report: spec.sheets is required');
  const generatedAt = spec.generatedAt instanceof Date ? spec.generatedAt : new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'E-ZONE Dashboard';
  wb.created = generatedAt;
  wb.calcProperties.fullCalcOnLoad = false;

  spec.sheets.forEach((sheet) => {
    const name = String(sheet.name || '').slice(0, 31);
    if (!name) throw new Error('xlsx-report: every sheet needs a name');
    const ws = wb.addWorksheet(name);
    const sections = Array.isArray(sheet.sections) && sheet.sections.length
      ? sheet.sections
      : [{ columns: sheet.columns, rows: sheet.rows, totals: sheet.totals, emptyText: sheet.emptyText }];

    // Column widths: the widest spec'd width at each position, at least
    // MIN_WIDTH (exceljs drops a width of exactly 9 as "default").
    const widths = [];
    sections.forEach((s) => (s.columns || []).forEach((c, i) => {
      widths[i] = Math.max(widths[i] || 0, MIN_WIDTH, Number(c.width) || 14);
    }));
    ws.columns = widths.map((w) => ({ width: w }));

    let r = 1;
    ws.getRow(r).getCell(1).value = guardText(sheet.title || name);
    ws.getRow(r).font = { bold: true, size: 14 };
    r++;
    ws.getRow(r).getCell(1).value = 'הופק ב־' + formatStamp(generatedAt);
    ws.getRow(r).font = { italic: true, color: { argb: 'FF595959' } };
    r++;
    if (sheet.note) {
      ws.getRow(r).getCell(1).value = guardText(sheet.note);
      ws.getRow(r).font = { bold: true, color: { argb: 'FF9C5700' } };
      r++;
    }
    r++; // blank row before the first table

    const meta = { frozenRow: 0 };
    sections.forEach((s, i) => { r = writeSection(ws, r, s, i === 0, meta); });
    ws.views = [{ rightToLeft: true, state: 'frozen', xSplit: 0, ySplit: meta.frozenRow, activeCell: `A${meta.frozenRow + 1}` }];
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  buildXlsxReport,
  guardText,
  toExcelDate,
  formatStamp,
  isoDayInIsrael,
  MONEY_FORMAT,
  INT_FORMAT,
  DATE_FORMAT,
  XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
