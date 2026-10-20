/* «ייצוא לאקסל» for every חתך — the leads funnel + the patient-retention
 * report as a real .xlsx, built IN THE BROWSER (CHANGELOG-report-xlsx-export.md).
 *
 * PURE: no DOM, no I/O, no logging, no dependency. The page loads it as
 * window.ReportXlsx; node --test requires it. It is a small OOXML writer
 * (stored ZIP + CRC-32 + the minimum SpreadsheetML parts) plus the sheet
 * builders. No third-party library, no CDN, no server route.
 *
 * THE NUMBERS ARE NEVER RECOMPUTED. Every sheet is built from the report
 * objects the screen already rendered — LeadsFunnel.funnel(...) and
 * PatientRetention.computeRetention(...) — and reads their counts, their
 * percentages (fractions) and their row lists as they are. A count in a sheet
 * is `report.counts.x`, never a re-count of a list.
 *
 * FORMATTING, every sheet: right-to-left view; the header row bold on a fill
 * and frozen; column widths from the spec; a `date` cell is a real Excel date
 * (serial number, `dd/mm/yyyy`) — an invalid date stays text, never a wrong
 * date; a `pct` cell is the fraction with a `0.0%` format; an `int` is a
 * number; a `phone` (and any `text`) is a string cell, so a leading zero is
 * kept.
 *
 * SECURITY: every text cell is formula-guarded exactly like the CSV export
 * (LeadsFunnel.csvCell / PatientRetention.csvCell): a value starting with
 * = + - @ tab or CR gets a leading apostrophe. No cell is ever a formula.
 * Characters XML 1.0 forbids are dropped; everything else is escaped. */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./leads-funnel'), require('./patient-retention'));
  } else {
    root.ReportXlsx = factory(root.LeadsFunnel, root.PatientRetention);
  }
}(typeof self !== 'undefined' ? self : this, function (LeadsFunnel, PatientRetention) {
  'use strict';

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const TZ = 'Asia/Jerusalem';
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SHEET_NAME_MAX = 31;

  /* ===================== cell values ===================== */

  /* The CSV formula guard, for a text cell. */
  function guardText(v) {
    const s = String(v == null ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  /* Drop what XML 1.0 cannot carry (C0 controls except tab / LF / CR, lone
   * surrogates, U+FFFE / U+FFFF), then escape. */
  function xmlText(v) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      // A raw CR would be normalized to LF by every XML reader: keep it.
      .replace(/\r/g, '&#13;');
  }

  function isRealIso(s) {
    if (!ISO_RE.test(String(s || ''))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  /* 'YYYY-MM-DD' → the Excel serial (days since 1899-12-30), or null. */
  function excelSerial(iso) {
    if (!isRealIso(iso)) return null;
    const ms = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    return ms / 86400000 + 25569;
  }

  /* A sheet name Excel accepts: no : \ / ? * [ ], not blank, ≤ 31 chars,
   * no leading / trailing apostrophe; '' → 'גיליון'. */
  function safeSheetName(name) {
    let s = String(name == null ? '' : name).replace(/[:\\/?*[\]]/g, ' ').replace(/[\u0000-\u001F]/g, '').trim();
    s = s.replace(/^'+|'+$/g, '').trim();
    if (!s) s = 'גיליון';
    return Array.from(s).slice(0, SHEET_NAME_MAX).join('');
  }

  /* An Israel-time stamp 'DD/MM/YYYY HH:MM' for the summary. */
  function stampHe(d) {
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return '';
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  }

  /* ===================== the sheet model =====================
   * sheet = { name, columns: [{ header, width, type }], rows: [[value | cell]] }
   * A row entry is a plain value (typed by its column) or a cell
   * { v, type, bold } that overrides. type: 'text' | 'phone' | 'date' | 'int' | 'pct'.
   * A row may be { heading: [...] } — a bold row (a second table's header). */

  const STYLE = { normal: 0, header: 1, date: 2, pct: 3, int: 4, text: 5, bold: 6 };

  function colLetter(i) {
    let n = i + 1, s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function cellXml(ref, value, type, bold) {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'int' || type === 'pct') {
      const n = Number(value);
      if (typeof value === 'number' && isFinite(n)) {
        return `<c r="${ref}" s="${type === 'pct' ? STYLE.pct : STYLE.int}"><v>${n}</v></c>`;
      }
    }
    if (type === 'date') {
      const serial = excelSerial(String(value));
      if (serial !== null) return `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
    }
    const style = bold ? STYLE.bold : (type === 'phone' || type === 'text' ? STYLE.text : STYLE.normal);
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(guardText(value))}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const cols = sheet.columns || [];
    const colsXml = cols.length
      ? '<cols>' + cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Number(c.width) || 14)}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    const rowsXml = [];
    rowsXml.push(`<row r="1">${cols.map((c, i) => `<c r="${colLetter(i)}1" s="${STYLE.header}" t="inlineStr"><is><t xml:space="preserve">${xmlText(guardText(c.header))}</t></is></c>`).join('')}</row>`);
    (sheet.rows || []).forEach((row, ri) => {
      const r = ri + 2;
      if (row && row.heading) {
        rowsXml.push(`<row r="${r}">${row.heading.map((h, i) => `<c r="${colLetter(i)}${r}" s="${STYLE.header}" t="inlineStr"><is><t xml:space="preserve">${xmlText(guardText(h))}</t></is></c>`).join('')}</row>`);
        return;
      }
      const cells = (Array.isArray(row) ? row : []).map((entry, ci) => {
        const isCell = entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'v' in entry;
        const v = isCell ? entry.v : entry;
        const type = (isCell && entry.type) || (cols[ci] && cols[ci].type) || 'text';
        return cellXml(colLetter(ci) + r, v, type, isCell && entry.bold);
      }).join('');
      rowsXml.push(`<row r="${r}">${cells}</row>`);
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheetViews><sheetView workbookViewId="0" rightToLeft="1">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + colsXml
      + `<sheetData>${rowsXml.join('')}</sheetData>`
      + '</worksheet>';
  }

  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>'
    + '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="7">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'                                         // normal
    + '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>' // header
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'                   // date
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'                   // pct
    + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'                     // int
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'                    // text (@)
    + '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'      // bold text
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  /* ===================== ZIP (stored, no compression) ===================== */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }());
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  /* files: [{ name, data: Uint8Array }] → a ZIP archive (Uint8Array). Fixed
   * DOS time (1980-01-01 00:00), so the same input gives the same bytes. */
  function zip(files) {
    const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
    const locals = [], centrals = [];
    let offset = 0;
    files.forEach((f) => {
      const name = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, DOS_TIME, true); ch.setUint16(14, DOS_DATE, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const parts = locals.concat(centrals, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let at = 0;
    parts.forEach((b) => { out.set(b, at); at += b.length; });
    return out;
  }

  /* spec { sheets: [sheet] } → the .xlsx bytes (Uint8Array). Sheet names are
   * made safe and unique. */
  function writeXlsx(spec) {
    const sheets = (spec && Array.isArray(spec.sheets) ? spec.sheets : []);
    const list = sheets.length ? sheets : [{ name: 'גיליון', columns: [], rows: [] }];
    const used = new Set();
    const names = list.map((s) => {
      let n = safeSheetName(s.name), k = 2;
      while (used.has(n)) { const tail = ' (' + k++ + ')'; n = Array.from(safeSheetName(s.name)).slice(0, SHEET_NAME_MAX - tail.length).join('') + tail; }
      used.add(n);
      return n;
    });
    const files = [];
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView/></bookViews><sheets>'
      + names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>') });
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });
    list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) }));
    return zip(files);
  }

  /* ===================== the report sheets ===================== */

  const SHEET_NAMES = Object.freeze({
    summary: 'סיכום',
    leadsCounts: 'לידים – חתך',
    leadsList: 'לידים – רשימה',
    stayCounts: 'שהות – חתך',
    continuity: 'המשך טיפול',
    completion: 'השלמת טיפול',
    patientsList: 'מטופלים – רשימה',
    missing: 'נתונים חסרים',
  });
  /* «סיכום»: the bucket sub-line rows and the check row (CHANGELOG-chitukim-fixes.md). */
  const SUB_LINE_PREFIX = PatientRetention.STILL_IN_TREATMENT_LABEL + ' · ';
  const RECONCILE_LABEL = 'שוחררו + עדיין בטיפול = נכנסו בתקופה';
  const LEADS_RULE_LABEL = 'לידים: לפי תאריך יצירת הליד (כולל שני התאריכים)';
  const PATIENTS_RULE_LABEL = 'מטופלים: ' + PatientRetention.COHORT_RULE_LABEL + ' (כולל שני התאריכים)';

  const okFunnel = (f) => !!f && f.ok === true;
  const okRet = (r) => !!r && r.ok === true;
  const houseOf = (opts, id) => (opts && typeof opts.houseName === 'function' ? (opts.houseName(id) || id) : id) || '';
  const bucketLabel = (key) => (PatientRetention.BUCKETS.find((b) => b.key === key) || {}).label || '';
  const funnelLabel = (key) => (LeadsFunnel.BUCKETS.find((b) => b.key === key) || {}).label || '';
  const contLabel = (row) => (row.status === 'discharged' ? PatientRetention.CONTINUITY_LABELS[row.continuity] || PatientRetention.CONTINUITY_LABELS.unknown : '');

  /* 1. «סיכום» — the period, the rules, the stamp, every headline number. */
  function summarySheet(ctx) {
    const f = ctx.funnel, r = ctx.retention;
    const rows = [
      ['תקופה — מתאריך', { v: ctx.from, type: 'date' }, ''],
      ['תקופה — עד תאריך', { v: ctx.to, type: 'date' }, ''],
      ['כלל הספירה', LEADS_RULE_LABEL, ''],
      ['כלל הספירה', PATIENTS_RULE_LABEL, ''],
      ['ימי שהות', 'מיום הכניסה עד יום השחרור, לא כולל יום הכניסה', ''],
      ['הופק ב־', stampHe(ctx.exportedAt), ''],
    ];
    if (okFunnel(f)) {
      rows.push({ heading: ['חתכים בלידים', 'מספר', ''] });
      rows.push(['לידים שנוצרו בתקופה', { v: f.population, type: 'int' }, '']);
      LeadsFunnel.BUCKETS.forEach((b) => rows.push([b.label, { v: f.counts[b.key], type: 'int' }, '']));
      rows.push(['לידים ללא תאריך יצירה (לא נספרו)', { v: f.noCreated, type: 'int' }, '']);
    }
    if (okRet(r)) {
      rows.push({ heading: ['חתכי מטופלים', 'מספר', 'אחוז'] });
      rows.push(['נכנסו בתקופה (הקבוצה)', { v: r.cohortSize, type: 'int' }, '']);
      // Each bucket's discharged count, then its sub-line «+N עדיין בטיפול» —
      // the same two numbers as the bucket card (CHANGELOG-chitukim-fixes.md).
      const sum = PatientRetention.bucketSummary(r);
      sum.rows.forEach((b) => {
        rows.push(['שוחררו · ' + b.label, { v: b.discharged, type: 'int' }, { v: r.percents[b.key], type: 'pct' }]);
        rows.push([SUB_LINE_PREFIX + b.label, { v: b.still, type: 'int' }, '']);
      });
      rows.push([PatientRetention.STILL_IN_TREATMENT_LABEL, { v: r.stillInTreatment.count, type: 'int' }, { v: r.percents.stillInTreatment, type: 'pct' }]);
      rows.push([RECONCILE_LABEL, { v: sum.cohort, type: 'int' }, '']);
      if (r.custom) {
        ['atOrBelow', 'above'].forEach((k) => rows.push(['שוחררו · ' + PatientRetention.customLabel(k, r.custom.threshold) + ' (אחוז מהמשוחררים)',
          { v: r.custom[k], type: 'int' }, { v: PatientRetention.percentOf(r.custom[k], r.dischargedCount), type: 'pct' }]));
      }
      rows.push(['שוחררו (סה״כ)', { v: r.dischargedCount, type: 'int' }, '']);
      PatientRetention.CONTINUITY_KEYS.forEach((k) => rows.push(['המשך טיפול · ' + PatientRetention.CONTINUITY_LABELS[k] + ' (אחוז מהמשוחררים)',
        { v: r.continuity[k], type: 'int' }, { v: r.percents.continuity[k], type: 'pct' }]));
      rows.push([PatientRetention.MISSING_LABEL + ' (לא נספרו)', { v: r.missingCount, type: 'int' }, '']);
    }
    return { name: SHEET_NAMES.summary, columns: [{ header: 'נושא', width: 46, type: 'text' }, { header: 'ערך', width: 44 }, { header: 'אחוז', width: 10, type: 'pct' }], rows };
  }

  /* 2. «לידים – חתך». */
  function leadsCountsSheet(f) {
    const rows = okFunnel(f) ? LeadsFunnel.BUCKETS.map((b) => [b.label, f.counts[b.key]]) : [];
    if (okFunnel(f)) rows.push([{ v: 'לידים שנוצרו בתקופה (סה״כ)', bold: true }, f.population]);
    return { name: SHEET_NAMES.leadsCounts, columns: [{ header: 'קטגוריה', width: 30, type: 'text' }, { header: 'מספר לידים', width: 14, type: 'int' }], rows };
  }

  const LEAD_COLUMNS = [
    { header: 'קטגוריה', width: 26, type: 'text' }, { header: 'שם', width: 24, type: 'text' },
    { header: 'טלפון', width: 15, type: 'phone' }, { header: 'נוצר', width: 12, type: 'date' },
    { header: 'בית', width: 18, type: 'text' }, { header: 'מקור', width: 16, type: 'text' },
    { header: 'תאריך ביקור', width: 13, type: 'date' },
  ];
  const leadRow = (r) => [funnelLabel(r.bucket), r.name, r.phone, r.created, r.house, r.source, r.visitDate];

  /* 3. «לידים – רשימה» — the rows behind each count, in bucket order. */
  function leadsListSheet(f) {
    const rows = [];
    if (okFunnel(f)) LeadsFunnel.BUCKETS.forEach((b) => (f.rows[b.key] || []).forEach((r) => rows.push(leadRow(r))));
    return { name: SHEET_NAMES.leadsList, columns: LEAD_COLUMNS, rows };
  }

  /* 4. «שהות – חתך». */
  function stayCountsSheet(r) {
    const rows = [];
    if (okRet(r)) {
      PatientRetention.BUCKETS.forEach((b) => rows.push(['שוחררו · ' + b.label, r.counts[b.key], r.percents[b.key], 'הקבוצה']));
      rows.push([PatientRetention.STILL_IN_TREATMENT_LABEL, r.stillInTreatment.count, r.percents.stillInTreatment, 'הקבוצה']);
      PatientRetention.BUCKETS.forEach((b) => rows.push([PatientRetention.STILL_IN_TREATMENT_LABEL + ' · ' + b.label, r.stillInTreatment.buckets[b.key], '', '']));
      if (r.custom) {
        ['atOrBelow', 'above'].forEach((k) => rows.push(['שוחררו · ' + PatientRetention.customLabel(k, r.custom.threshold), r.custom[k],
          PatientRetention.percentOf(r.custom[k], r.dischargedCount), 'המשוחררים']));
      }
      rows.push([{ v: 'נכנסו בתקופה (הקבוצה)', bold: true }, r.cohortSize, '', '']);
      // The bucket card table: discharged (the big number) + still in
      // treatment (its sub-line) = the bucket total; totals = the cohort.
      const sum = PatientRetention.bucketSummary(r);
      rows.push([]);
      rows.push({ heading: PatientRetention.SUMMARY_HEAD.slice() });
      sum.rows.forEach((b) => rows.push([b.label, { v: b.discharged, type: 'int' }, { v: b.still, type: 'int' }, { v: b.total, type: 'int' }]));
      rows.push([{ v: PatientRetention.SUMMARY_TOTAL_LABEL, bold: true }, { v: sum.discharged, type: 'int' }, { v: sum.still, type: 'int' }, { v: sum.cohort, type: 'int' }]);
    }
    return { name: SHEET_NAMES.stayCounts, columns: [
      { header: 'קטגוריה', width: 34, type: 'text' }, { header: 'מספר', width: 10, type: 'int' },
      { header: 'אחוז', width: 10, type: 'pct' }, { header: 'בסיס האחוז', width: 14, type: 'text' },
    ], rows };
  }

  /* 5. «המשך טיפול» — counts, then the bucket × continuity table. */
  function continuitySheet(r) {
    const rows = [];
    if (okRet(r)) {
      PatientRetention.CONTINUITY_KEYS.forEach((k) => rows.push([PatientRetention.CONTINUITY_LABELS[k], r.continuity[k], r.percents.continuity[k]]));
      rows.push([{ v: 'שוחררו (סה״כ)', bold: true }, r.dischargedCount, '']);
      rows.push([]);
      rows.push({ heading: ['משך שהות'].concat(PatientRetention.CONTINUITY_KEYS.map((k) => PatientRetention.CONTINUITY_LABELS[k]), ['סה״כ']) });
      PatientRetention.BUCKETS.forEach((b) => rows.push([b.label].concat(
        PatientRetention.CONTINUITY_KEYS.map((k) => ({ v: r.cross[b.key][k], type: 'int' })), [{ v: r.counts[b.key], type: 'int' }])));
    }
    return { name: SHEET_NAMES.continuity, columns: [
      { header: 'המשך טיפול', width: 30, type: 'text' }, { header: 'מספר', width: 22, type: 'int' },
      { header: 'אחוז מהמשוחררים', width: 22, type: 'pct' }, { header: '', width: 22 }, { header: '', width: 14 }, { header: '', width: 10 },
    ], rows };
  }

  const PATIENT_COLUMNS = [
    { header: 'קטגוריית שהות', width: 26, type: 'text' }, { header: 'שם', width: 24, type: 'text' },
    { header: 'בית', width: 18, type: 'text' }, { header: 'טלפון', width: 15, type: 'phone' },
    { header: 'תאריך כניסה', width: 13, type: 'date' }, { header: 'תאריך שחרור', width: 13, type: 'date' },
    { header: 'ימים', width: 8, type: 'int' }, { header: 'המשך טיפול', width: 28, type: 'text' },
    { header: 'מטופל חוזר', width: 11, type: 'text' },
  ];
  function patientRow(row, opts) {
    return [PatientRetention.stayCategory(row), row.name, houseOf(opts, row.houseId), row.phone, row.entryDate, row.dischargeDate,
      typeof row.days === 'number' ? row.days : '', contLabel(row), row.returning ? 'כן' : ''];
  }
  /* Every placed stay once: discharged by bucket, then still in treatment. */
  function placedStays(r) {
    if (!okRet(r)) return [];
    return [].concat(r.rows.upTo30, r.rows.d31to60, r.rows.over60, r.rows.stillInTreatment);
  }

  /* 6. «מטופלים – רשימה». */
  function patientsListSheet(r, opts) {
    return { name: SHEET_NAMES.patientsList, columns: PATIENT_COLUMNS, rows: placedStays(r).map((x) => patientRow(x, opts)) };
  }

  /* 5b. «השלמת טיפול» (CHANGELOG-completion-view.md) — the numbers table read
   * from PatientRetention.computeCompletion as is (a null rate is the text
   * «אין מספיק נתונים», never 0%), the note, then every row behind every
   * number, then the «נתונים חסרים» count. */
  function completionSheet(c) {
    const rows = [];
    if (okRet(c)) {
      PatientRetention.completionTable(c).forEach((t) => rows.push([t.threshold, t.reached, t.leftEarly, t.tooEarly, t.evaluable,
        t.rate === null ? { v: PatientRetention.NOT_ENOUGH_DATA_LABEL, type: 'text' } : t.rate]));
      rows.push([{ v: PatientRetention.COMPLETION_NOTE, type: 'text' }]);
      rows.push([]);
      rows.push({ heading: ['סף (ימים)', 'סטטוס השלמה', 'שם', 'בית', 'טלפון', 'תאריך כניסה', 'תאריך שחרור', 'ימים'] });
      PatientRetention.completionListRows(c).forEach((x) => rows.push([x.threshold, { v: PatientRetention.COMPLETION_LABELS[x.key], type: 'text' },
        { v: x.row.name, type: 'text' }, { v: houseOf(c.opts, x.row.houseId), type: 'text' }, { v: x.row.phone, type: 'phone' },
        { v: x.row.entryDate, type: 'date' }, { v: x.row.dischargeDate, type: 'date' }, { v: typeof x.row.days === 'number' ? x.row.days : '', type: 'int' }]));
      rows.push([]);
      rows.push([{ v: PatientRetention.MISSING_LABEL + ' (לא נספרו)', type: 'text' }, c.missingCount]);
    }
    return { name: SHEET_NAMES.completion, columns: [
      { header: 'סף (ימים)', width: 12, type: 'int' }, { header: 'הגיעו לסף', width: 16, type: 'int' },
      { header: 'עזבו לפני הסף', width: 22, type: 'int' }, { header: 'מוקדם לקבוע', width: 16, type: 'int' },
      { header: 'ניתנים להערכה', width: 15, type: 'int' }, { header: 'אחוז השלמה', width: 18, type: 'pct' },
      { header: '', width: 13 }, { header: '', width: 8 },
    ], rows };
  }
  const completionOf = (ctx) => (ctx && ctx.completion ? Object.assign({}, ctx.completion, { opts: ctx }) : null);

  /* 7. «נתונים חסרים». */
  function missingSheet(r, opts) {
    const rows = okRet(r) ? r.rows.missing.map((x) => [PatientRetention.MISSING_REASONS[x.reason] || x.reason, x.name, houseOf(opts, x.houseId), x.phone, x.entryDate, x.dischargeDate]) : [];
    return { name: SHEET_NAMES.missing, columns: [
      { header: 'סיבה', width: 26, type: 'text' }, { header: 'שם', width: 24, type: 'text' }, { header: 'בית', width: 18, type: 'text' },
      { header: 'טלפון', width: 15, type: 'phone' }, { header: 'תאריך כניסה', width: 13, type: 'date' }, { header: 'תאריך שחרור', width: 13, type: 'date' },
    ], rows };
  }

  /* ===================== workbooks ===================== */

  /* ctx: { funnel, retention, completion, from, to, exportedAt: Date, houseName(id) } */
  function fullWorkbook(ctx) {
    const c = ctx || {};
    return { sheets: [
      summarySheet(c), leadsCountsSheet(c.funnel), leadsListSheet(c.funnel),
      stayCountsSheet(c.retention), continuitySheet(c.retention), completionSheet(completionOf(c)),
      patientsListSheet(c.retention, c), missingSheet(c.retention, c),
    ] };
  }

  /* One section's sheets only:
   *   'leads'       «לידים – חתך» + «לידים – רשימה»
   *   'retention'   «שהות – חתך» + «מטופלים – רשימה» + «נתונים חסרים»
   *   'continuity'  «המשך טיפול» + «מטופלים – רשימה»
   *   'completion'  «השלמת טיפול» + «נתונים חסרים»
   * null for an unknown section. */
  const SECTIONS = Object.freeze(['leads', 'retention', 'continuity', 'completion']);
  function sectionWorkbook(section, ctx) {
    const c = ctx || {};
    if (section === 'leads') return { sheets: [leadsCountsSheet(c.funnel), leadsListSheet(c.funnel)] };
    if (section === 'retention') return { sheets: [stayCountsSheet(c.retention), patientsListSheet(c.retention, c), missingSheet(c.retention, c)] };
    if (section === 'continuity') return { sheets: [continuitySheet(c.retention), patientsListSheet(c.retention, c)] };
    if (section === 'completion') return { sheets: [completionSheet(completionOf(c)), missingSheet(c.completion, c)] };
    return null;
  }

  /* A click-a-count list as ONE sheet. kind: 'patients' | 'leads' | 'missing'. */
  function listWorkbook(kind, rows, opts) {
    const o = opts || {};
    const list = Array.isArray(rows) ? rows : [];
    const name = safeSheetName(o.title || (kind === 'leads' ? SHEET_NAMES.leadsList : SHEET_NAMES.patientsList));
    if (kind === 'leads') return { sheets: [{ name, columns: LEAD_COLUMNS, rows: list.map(leadRow) }] };
    if (kind === 'missing') {
      const s = missingSheet({ ok: true, rows: { missing: list } }, o);
      return { sheets: [Object.assign(s, { name })] };
    }
    return { sheets: [{ name, columns: PATIENT_COLUMNS, rows: list.map((x) => patientRow(x, o)) }] };
  }

  /* ===================== filenames ===================== */

  const safePart = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z-]/g, '');
  /* ezone-chitukim-<from>_<to>.xlsx */
  function fullFilename(from, to) {
    return 'ezone-chitukim-' + safePart(from) + '_' + safePart(to) + '.xlsx';
  }
  /* ezone-<section>-<from>_<to>.xlsx */
  function sectionFilename(section, from, to) {
    return 'ezone-' + (safePart(section) || 'report') + '-' + safePart(from) + '_' + safePart(to) + '.xlsx';
  }

  return Object.freeze({
    XLSX_MIME, SHEET_NAMES, SECTIONS, SHEET_NAME_MAX, SUB_LINE_PREFIX, RECONCILE_LABEL,
    guardText, xmlText, excelSerial, safeSheetName, stampHe, crc32, zip, writeXlsx,
    summarySheet, leadsCountsSheet, leadsListSheet, stayCountsSheet, continuitySheet, completionSheet, patientsListSheet, missingSheet,
    fullWorkbook, sectionWorkbook, listWorkbook, fullFilename, sectionFilename,
  });
}));
