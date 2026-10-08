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
 *       note:  'הסעיפים אינם מסתכמים יחד',  // optional line(s) under the generated-at row (a string or an array)
 *       color: 'credits',                   // optional: a lib/report-colors.js key
 *       // EITHER one table on the sheet:
 *       columns: [{ header, key, type: 'text'|'money'|'date'|'int' }],
 *       rows:    [{ <key>: value, … }],
 *       totals:  [{ label, values: { <key>: number } }],   // bold rows under the table
 *       emptyText: 'אין רשומות',            // written instead of rows when rows is empty
 *       // OR several tables, each with its own header, totals and colour:
 *       sections: [{ heading, color, columns, rows, totals, emptyText }],
 *     }],
 *   }
 *
 * Formatting, on every sheet:
 *   - right-to-left view;
 *   - row 1 the title, row 2 «הופק ב־…», then the optional note — each merged
 *     across the sheet's table width, so a long line never squeezes column A;
 *   - a section with a `color` (one of GROUP_COLORS, the same hex values as
 *     the screen's CSS tokens) gets: its heading row bold white on the dark
 *     shade, merged across the section's columns; the column-header row on a
 *     light tint; the total rows bold on a medium tint. A one-table sheet with
 *     a `color` shows its title row that way. No colour → the neutral look;
 *   - the FIRST header on a sheet is frozen and carries the sheet's autoFilter
 *     (Excel allows one per sheet);
 *   - money → number with format ₪#,##0; int → format 0;
 *   - date  → a real Excel date (a 'YYYY-MM-DD' string or a Date), shown DD/MM/YYYY;
 *   - totals rows are bold with a top border; each table gets ONLY its own
 *     totals — this helper never sums one table into another;
 *   - column widths are COMPUTED from the longest value in each column
 *     (headers, cells and totals, as displayed; Hebrew and bold text are
 *     counted wider) + padding, between 12 and 60. A merged line that is
 *     still wider than its columns widens them. Nothing wraps;
 *   - fixed row heights, so there is no oversized empty row;
 *   - printed one page wide (landscape when a table has more than 4 columns).
 *
 * Security: every text cell is formula-guarded — a value starting with = + - @,
 * a tab or a CR gets a leading ' so a spreadsheet never runs it. Values are
 * always written as plain values, never as formulas. This module logs nothing.
 * The workbook properties carry no product or company name. */

const ExcelJS = require('exceljs');
const { xlsxShades } = require('./report-colors');

const MONEY_FORMAT = '"₪"#,##0';
const INT_FORMAT = '0';
const DATE_FORMAT = 'dd/mm/yyyy';
const HEADER_FILL = 'FFD9E2F3';
const TOTAL_FILL = 'FFF2F2F2';
const COLUMN_TYPES = ['text', 'money', 'date', 'int'];
const TZ = 'Asia/Jerusalem';
const MIN_WIDTH = 12;
const MAX_WIDTH = 60;
const PADDING = 3;
const HEIGHTS = { title: 24, line: 18, blank: 6, heading: 22, header: 20, row: 18 };
const HEBREW = /[\u0590-\u05FF]/;

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

/* The text a cell shows, for width purposes. Pure. */
function displayText(type, value) {
  if (value === undefined || value === null || value === '') return '';
  if ((type === 'money' || type === 'int') && typeof value !== 'boolean' && isFinite(Number(value))) {
    const n = Math.round(Number(value));
    return (type === 'money' ? '₪' : '') + (type === 'money' ? n.toLocaleString('en-US') : String(n));
  }
  if (type === 'date' && toExcelDate(value)) return '00/00/0000';
  return guardText(value);
}
/* Excel width units a string needs. Hebrew glyphs and bold text run wider. */
function textWidth(text, bold) {
  const s = String(text || '');
  let w = s.length * (HEBREW.test(s) ? 1.2 : 1) * (bold ? 1.1 : 1);
  return Math.ceil(w) + (s ? PADDING : 0);
}
const clampWidth = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }

/* A line merged across columns 1..span (span ≥ 2), or a single cell. */
function mergedLine(ws, r, span, value, font, argb, height, meta) {
  const row = ws.getRow(r);
  const cell = row.getCell(1);
  cell.value = guardText(value);
  cell.font = font;
  cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: false };
  if (argb) for (let i = 1; i <= Math.max(1, span); i++) row.getCell(i).fill = fill(argb);
  if (span > 1) ws.mergeCells(r, 1, r, span);
  row.height = height;
  meta.merged.push({ span: Math.max(1, span), width: textWidth(value, !!(font && font.bold)) * ((font && font.size) > 12 ? 1.3 : 1) });
}

/* Write one table from row `r`; returns the next free row. `first` marks the
 * sheet's first table (frozen header + autoFilter). */
function writeSection(ws, r, sec, first, meta) {
  validateColumns(sec.columns, `sheet «${ws.name}»`);
  const cols = sec.columns;
  const shades = sec.color ? xlsxShades(sec.color) : null;
  const need = (i, text, bold) => { meta.widths[i] = Math.max(meta.widths[i] || 0, textWidth(text, bold)); };
  if (sec.heading) {
    mergedLine(ws, r, cols.length, sec.heading,
      shades ? { bold: true, size: 12, color: { argb: 'FFFFFFFF' } } : { bold: true, size: 12 },
      shades ? shades.heading : null, HEIGHTS.heading, meta);
    r++;
  }
  const headerRow = ws.getRow(r);
  cols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = guardText(c.header);
    cell.font = { bold: true };
    cell.fill = fill(shades ? shades.header : HEADER_FILL);
    cell.alignment = { vertical: 'middle', wrapText: false };
    cell.border = { bottom: { style: 'thin' } };
    need(i, c.header, true);
  });
  headerRow.height = HEIGHTS.header;
  const headerAt = r;
  r++;

  const rows = Array.isArray(sec.rows) ? sec.rows : [];
  if (!rows.length) {
    mergedLine(ws, r, cols.length, sec.emptyText || 'אין רשומות', { italic: true }, null, HEIGHTS.row, meta);
    r++;
  }
  rows.forEach((row) => {
    const xr = ws.getRow(r);
    cols.forEach((c, i) => {
      const v = row ? row[c.key] : '';
      setCell(xr.getCell(i + 1), c.type || 'text', v);
      need(i, displayText(c.type || 'text', v), false);
    });
    xr.height = HEIGHTS.row;
    r++;
  });
  const lastDataRow = r - 1;

  (Array.isArray(sec.totals) ? sec.totals : []).forEach((t) => {
    const xr = ws.getRow(r);
    xr.getCell(1).value = guardText(t.label);
    need(0, t.label, true);
    cols.forEach((c, i) => {
      if (i === 0 || !t.values || !(c.key in t.values)) return;
      const type = c.type === 'text' || c.type === 'date' ? 'int' : c.type;
      setCell(xr.getCell(i + 1), type, t.values[c.key]);
      need(i, displayText(type, t.values[c.key]), true);
    });
    cols.forEach((_c, i) => {
      const cell = xr.getCell(i + 1);
      cell.font = { bold: true };
      cell.fill = fill(shades ? shades.total : TOTAL_FILL);
      cell.border = { top: { style: 'thin' } };
    });
    xr.height = HEIGHTS.row;
    r++;
  });

  if (first) {
    meta.frozenRow = headerAt;
    ws.autoFilter = { from: { row: headerAt, column: 1 }, to: { row: Math.max(headerAt, lastDataRow), column: cols.length } };
  }
  ws.getRow(r).height = HEIGHTS.blank;
  return r + 1; // one short blank row between tables
}

/* Build the workbook. Returns a Promise<Buffer>. */
async function buildXlsxReport(spec) {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) throw new Error('xlsx-report: spec.sheets is required');
  const generatedAt = spec.generatedAt instanceof Date ? spec.generatedAt : new Date();
  const wb = new ExcelJS.Workbook();
  // No product or company name anywhere in the file's properties.
  wb.creator = '';
  wb.lastModifiedBy = '';
  wb.company = '';
  wb.manager = '';
  wb.title = '';
  wb.subject = '';
  wb.keywords = '';
  wb.category = '';
  wb.description = '';
  wb.created = generatedAt;
  wb.modified = generatedAt;
  wb.calcProperties.fullCalcOnLoad = false;

  spec.sheets.forEach((sheet) => {
    const name = String(sheet.name || '').slice(0, 31);
    if (!name) throw new Error('xlsx-report: every sheet needs a name');
    const ws = wb.addWorksheet(name);
    const sections = Array.isArray(sheet.sections) && sheet.sections.length
      ? sheet.sections
      : [{ color: sheet.color, columns: sheet.columns, rows: sheet.rows, totals: sheet.totals, emptyText: sheet.emptyText }];
    const span = sections.reduce((m, s) => Math.max(m, (s.columns || []).length), 1);
    const meta = { frozenRow: 0, widths: [], merged: [] };
    const oneTableColor = !(Array.isArray(sheet.sections) && sheet.sections.length) && sheet.color ? xlsxShades(sheet.color) : null;

    let r = 1;
    mergedLine(ws, r, span, sheet.title || name,
      oneTableColor ? { bold: true, size: 14, color: { argb: 'FFFFFFFF' } } : { bold: true, size: 14 },
      oneTableColor ? oneTableColor.heading : null, HEIGHTS.title, meta);
    r++;
    mergedLine(ws, r, span, 'הופק ב־' + formatStamp(generatedAt), { italic: true, color: { argb: 'FF595959' } }, null, HEIGHTS.line, meta);
    r++;
    (Array.isArray(sheet.note) ? sheet.note : [sheet.note]).filter(Boolean).forEach((line) => {
      mergedLine(ws, r, span, line, { bold: true, color: { argb: 'FF9C5700' } }, null, HEIGHTS.line, meta);
      r++;
    });
    ws.getRow(r).height = HEIGHTS.blank;
    r++; // a short blank row before the first table

    sections.forEach((s, i) => { r = writeSection(ws, r, s, i === 0, meta); });

    // Widths: the longest value per column, then widen for merged lines that
    // still do not fit their columns (spread over the span, each ≤ MAX_WIDTH).
    const widths = [];
    for (let i = 0; i < span; i++) widths[i] = clampWidth(meta.widths[i] || 0);
    meta.merged.forEach((m) => {
      let deficit = m.width - widths.slice(0, m.span).reduce((t, w) => t + w, 0);
      for (let guard = 0; deficit > 0 && guard < 100; guard++) {
        const room = widths.slice(0, m.span).map((w, i) => (w < MAX_WIDTH ? i : -1)).filter((i) => i >= 0);
        if (!room.length) break;
        const add = Math.ceil(deficit / room.length);
        room.forEach((i) => { const d = Math.min(add, MAX_WIDTH - widths[i], deficit); widths[i] += d; deficit -= d; });
      }
    });
    ws.columns = widths.map((w) => ({ width: w }));
    // Printing / PDF: one page wide, as many pages tall as needed.
    ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: span > 4 ? 'landscape' : 'portrait', paperSize: 9 };
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
  displayText,
  textWidth,
  MIN_WIDTH,
  MAX_WIDTH,
  MONEY_FORMAT,
  INT_FORMAT,
  DATE_FORMAT,
  XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
