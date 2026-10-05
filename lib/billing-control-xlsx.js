/* «ייצוא אימות» — the billingControlQueue response (apps-script/Code.gs
 * billingControlQueue_) as an .xlsx spec for lib/xlsx-report.js, the same
 * look as every other dashboard export. Pure: no I/O, no clock (the caller
 * passes `now`).
 *
 * NO NEW MATH. The rows are the server's receipts; «הכנסה מאומתת» per month
 * is lib/billing-control-rules.js verifiedForMonth — the very function the
 * «בקרת גבייה» tab and the «מאומת» figure on הכנסות חודשיות use.
 *
 * Sheets:
 *   סיכום         the counts (ממתין / בעיה / אומת) and «חובות מעל 60 יום»
 *   ממתין לאימות  every receipt still reported, newest first
 *   סומנו כבעיה   every flagged receipt, with Ortal's note
 *   אומתו         one section per month (newest first): each confirmed
 *                 receipt's slice of that month and the month's total
 *                 «הכנסה מאומתת». A receipt whose coverage spans two months
 *                 appears in both, each with its own share — the sections are
 *                 never added together. */

const rules = require('./billing-control-rules');
const { HOUSE_NAMES } = require('./refund-forecast-xlsx');

const SHEET_NAMES = {
  summary: 'סיכום',
  reported: 'ממתין לאימות',
  flagged: 'סומנו כבעיה',
  confirmed: 'אומתו',
};
/* lib/report-colors.js keys: waiting amber, flagged red, confirmed green. */
const STATUS_COLORS = { reported: 'open', flagged: 'debt', confirmed: 'credits' };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const arr = (v) => (Array.isArray(v) ? v : []);
function houseName(id) { return HOUSE_NAMES[id] || id || '—'; }
const fmtDayHe = (iso) => (ISO_RE.test(String(iso)) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : String(iso || ''));
const fmtMonthHe = (key) => (rules.isMonthKey(key) ? `${key.slice(5, 7)}/${key.slice(0, 4)}` : String(key || ''));

/* True when `data` has the shape billingControlQueue returns on success. */
function isBillingControlResponse(data) {
  return !!(data && data.ok === true && Array.isArray(data.receipts) && data.counts && typeof data.today === 'string');
}

/* The stamp a person reads: 'YYYY-MM-DD' / ISO → DD/MM/YYYY (+ HH:MM). */
function stampHe(s) {
  const t = String(s || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t);
  if (!m) return t;
  return `${m[3]}/${m[2]}/${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : '');
}

/* «חשבונית»: 'yes' → כן, 'no' → לא; a receipt from before the question → «—»
 * (never guessed). «על שם» only for כן. CHANGELOG-payment-invoice.md. */
function invoiceLabel(v) { return v === 'yes' ? 'כן' : v === 'no' ? 'לא' : '—'; }
function invoiceToLabel(r) { return r.invoiceWanted === 'yes' && r.invoiceTo ? String(r.invoiceTo) : '—'; }

function receiptRow(r) {
  return {
    receivedDate: r.receivedDate, patient: r.patientName, house: houseName(r.houseId),
    amount: r.amount, method: r.method, reference: r.reference || '—', payer: r.payer,
    funder: r.funder, invoice: invoiceLabel(r.invoiceWanted), invoiceTo: invoiceToLabel(r),
    recordedBy: r.recordedBy, recordedAt: stampHe(r.recordedAt),
    coverage: `${fmtDayHe(r.coverageStart)}–${fmtDayHe(r.coverageEnd)}`,
    flagNote: r.flagNote, flaggedAt: stampHe(r.flaggedAt),
    confirmedBy: r.confirmedBy, confirmedAt: stampHe(r.confirmedAt),
  };
}

const BASE_COLUMNS = [
  { header: 'תאריך קבלה', key: 'receivedDate', type: 'date', width: 14 },
  { header: 'מטופל', key: 'patient', type: 'text', width: 22 },
  { header: 'בית', key: 'house', type: 'text', width: 16 },
  { header: 'סכום', key: 'amount', type: 'money', width: 14 },
  { header: 'אמצעי', key: 'method', type: 'text', width: 14 },
  { header: 'אסמכתא', key: 'reference', type: 'text', width: 14 },
  { header: 'משלם', key: 'payer', type: 'text', width: 18 },
  { header: 'גורם מממן', key: 'funder', type: 'text', width: 14 },
  { header: 'חשבונית', key: 'invoice', type: 'text', width: 10 },
  { header: 'על שם', key: 'invoiceTo', type: 'text', width: 20 },
  { header: 'נרשם ע״י', key: 'recordedBy', type: 'text', width: 12 },
];

/* The workbook spec. Pure. */
function buildBillingControlSpec(data, now) {
  const receipts = arr(data.receipts);
  const today = String(data.today || '');
  const title = `בקרת גבייה — נכון ל־${fmtDayHe(today)}`;
  const reported = rules.receiptsByStatus(receipts, 'reported');
  const flagged = rules.receiptsByStatus(receipts, 'flagged');
  const confirmed = rules.receiptsByStatus(receipts, 'confirmed');
  const sum = (list) => rules.sumOf(list);
  const d60 = data.debt60 || null;

  const summary = {
    name: SHEET_NAMES.summary, title,
    note: ['«אומת» = אורטל בדקה בבנק ואישרה · רק «אומת» הוא הכנסה מאומתת · הסכומים כוללים מע"מ'],
    sections: [
      { heading: 'מצב האימות', color: 'due',
        columns: [
          { header: 'מצב', key: 'label', type: 'text', width: 22 },
          { header: 'מספר', key: 'count', type: 'int', width: 10 },
          { header: 'סכום', key: 'amount', type: 'money', width: 14 },
        ],
        rows: [
          Object.assign({ label: rules.STATUS_LABELS.reported }, sum(reported)),
          Object.assign({ label: rules.STATUS_LABELS.flagged }, sum(flagged)),
          Object.assign({ label: rules.STATUS_LABELS.confirmed + ' (כל הזמנים)' }, sum(confirmed)),
        ] },
      { heading: 'חובות מעל 60 יום (נכון להיום, מ«חובות פתוחים»)', color: 'debt',
        columns: [
          { header: 'גוש', key: 'label', type: 'text', width: 22 },
          { header: 'מחזורים', key: 'count', type: 'int', width: 10 },
          { header: 'סכום', key: 'amount', type: 'money', width: 14 },
        ],
        rows: d60 ? [
          { label: 'חוב רשום', count: d60.recorded.count, amount: d60.recorded.amount },
          { label: 'מחזורים ללא רישום', count: d60.unrecorded.count, amount: d60.unrecorded.amount },
        ] : [],
        emptyText: 'לא ניתן לחשב כרגע' },
    ],
  };

  const reportedSheet = {
    name: SHEET_NAMES.reported, title: title + ' — ' + SHEET_NAMES.reported, color: STATUS_COLORS.reported,
    columns: BASE_COLUMNS.concat([{ header: 'נרשם ב־', key: 'recordedAt', type: 'text', width: 16 }]),
    rows: reported.map(receiptRow),
    totals: [{ label: `סה"כ ${SHEET_NAMES.reported} (${reported.length})`, values: { amount: sum(reported).amount } }],
    emptyText: 'אין קבלות שממתינות לאימות',
  };
  const flaggedSheet = {
    name: SHEET_NAMES.flagged, title: title + ' — ' + SHEET_NAMES.flagged, color: STATUS_COLORS.flagged,
    note: 'ורד מטפלת: ביטול הקבלה ודיווח מחדש. הקבלה שסומנה נשארת בהיסטוריה.',
    columns: BASE_COLUMNS.concat([
      { header: 'הערת אורטל', key: 'flagNote', type: 'text', width: 30 },
      { header: 'סומן ב־', key: 'flaggedAt', type: 'text', width: 16 },
    ]),
    rows: flagged.map(receiptRow),
    totals: [{ label: `סה"כ ${SHEET_NAMES.flagged} (${flagged.length})`, values: { amount: sum(flagged).amount } }],
    emptyText: 'אין קבלות שסומנו כבעיה',
  };

  const months = rules.verifiedMonths(receipts);
  const monthCols = [
    { header: 'תאריך קבלה', key: 'receivedDate', type: 'date', width: 14 },
    { header: 'מטופל', key: 'patient', type: 'text', width: 22 },
    { header: 'בית', key: 'house', type: 'text', width: 16 },
    { header: 'תקופת כיסוי', key: 'coverage', type: 'text', width: 24 },
    { header: 'סכום הקבלה', key: 'amount', type: 'money', width: 14 },
    { header: 'החלק בחודש', key: 'amountInMonth', type: 'money', width: 14 },
    { header: 'ימים בחודש', key: 'daysInMonth', type: 'int', width: 10 },
    { header: 'אומת ע״י', key: 'confirmedBy', type: 'text', width: 12 },
    { header: 'אומת ב־', key: 'confirmedAt', type: 'text', width: 16 },
  ];
  const confirmedSheet = {
    name: SHEET_NAMES.confirmed, title: title + ' — הכנסה מאומתת לפי חודש',
    note: 'כל קבלה מחולקת לחודשים לפי תקופת הכיסוי שלה (כמו «נגבה» בהכנסות חודשיות). אין סיכום בין החודשים.',
    sections: months.length ? months.map((key) => {
      const v = rules.verifiedForMonth(receipts, key, 'all');
      return {
        heading: `${fmtMonthHe(key)} — הכנסה מאומתת`, color: STATUS_COLORS.confirmed, columns: monthCols,
        rows: v.rows.map((r) => Object.assign(receiptRow(r), { amountInMonth: r.amountInMonth, daysInMonth: r.daysInMonth })),
        totals: [{ label: `הכנסה מאומתת ${fmtMonthHe(key)}`, values: { amountInMonth: v.total } }],
      };
    }) : [{ heading: 'הכנסה מאומתת', color: STATUS_COLORS.confirmed, columns: monthCols, rows: [], emptyText: 'עדיין אין קבלות שאומתו' }],
  };

  return { generatedAt: now, sheets: [summary, reportedSheet, flaggedSheet, confirmedSheet] };
}

/* An attachment Content-Disposition: ASCII fallback + RFC 5987 UTF-8
 * «אימות-YYYY-MM-DD.xlsx». The day is validated, so nothing from the request
 * reaches the header. Pure. */
function billingControlContentDisposition(isoDay) {
  const day = rules.isIsoDay(String(isoDay)) ? String(isoDay) : 'unknown-date';
  const utf8Name = `אימות-${day}.xlsx`;
  const encoded = encodeURIComponent(utf8Name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="billing-control-${day}.xlsx"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  SHEET_NAMES,
  isBillingControlResponse,
  buildBillingControlSpec,
  billingControlContentDisposition,
};
