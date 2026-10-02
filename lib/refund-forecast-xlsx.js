/* «ייצוא להנהלת חשבונות» — the refundPayoutForecast response as an .xlsx spec
 * for lib/xlsx-report.js. Pure: no I/O, no clock (the caller passes `now`).
 *
 * Five sheets: «סיכום», «הוחלט», «ממתין להחלטה», «חסרים נתוני תשלום»,
 * «לא ניתן לחשב». Each section keeps its OWN total; nothing here adds one
 * section to another (CHANGELOG-refund-payout-forecast.md: "never summed
 * together"). A missing-data row has no amount column at all, so it can never
 * read as 0.
 *
 * The Hebrew labels below mirror the constants in public/app.js
 * (HOUSES, CREDIT_RULE_LABELS, CREDIT_TYPE_LABELS, PAYOUT_FORECAST_*). The
 * test test/xlsx-export.test.js fails if the two copies drift apart. */

const HOUSE_NAMES = {
  arfoni: 'קיסריה עפרוני',
  rehab:  'קיסריה ריהאב',
  asher:  'רעננה אשר',
  pardes: 'רעננה הפרדס',
  ramot:  'רמות השבים',
  sde:    'שדה אליעזר',
};

const RULE_LABELS = {
  residential_prorata:        'מגורים — זיכוי יחסי על הימים שלא שהה',
  residential_last_days_zero: '7 הימים האחרונים במחזור — ללא זיכוי',
  detox_prorata:              'גמילה/דואלי — יציאה עד יום 13 — זיכוי יחסי',
  detox_tenure_cutoff_zero:   'יום 14 ומעלה — ללא זיכוי',
  prepaid_return:             'מחזור ששולם מראש ולא התחיל — החזר מלא',
  cycle_fully_used:           'המחזור הסתיים לפני היציאה — ללא זיכוי',
};
const CREDIT_TYPE_LABELS = {
  days_unused:    'ימים שלא נוצלו',
  prepaid_return: 'החזר תשלום מראש',
  other:          'זיכוי אחר',
};
const SECTION_LABELS = {
  decided:    'הוחלט — ממתין לתשלום',
  awaiting:   'ממתין להחלטה — לא לתשלום',
  missing:    'חסרים נתוני תשלום — לבדוק',
  unresolved: 'לא ניתן לחשב — לבדוק',
};
const ERROR_LABELS = {
  unknown_house:     'בית לא מוכר',
  bad_date:          'תאריך כניסה או יציאה חסר / לא תקין',
  exit_before_entry: 'תאריך היציאה לפני תאריך הכניסה',
  bad_amount:        'סכום ששולם לא תקין',
  bad_coverage:      'תקופת כיסוי לא תקינה',
};
const MISSING_NOTE = 'אין תשלום רשום — לבדוק';

const SHEET_NAMES = {
  summary:    'סיכום',
  decided:    'הוחלט',
  awaiting:   'ממתין להחלטה',
  missing:    'חסרים נתוני תשלום',
  unresolved: 'לא ניתן לחשב',
};

function houseName(id) { return HOUSE_NAMES[id] || id || '—'; }
function ruleText(rule) {
  return String(rule || '').split(',').filter(Boolean)
    .map((r) => RULE_LABELS[r] || CREDIT_TYPE_LABELS[r] || r).join(' + ') || '—';
}
function errorText(code) { return ERROR_LABELS[code] || String(code || 'שגיאה'); }

/* True when `data` has the shape refundPayoutForecast returns on success. */
function isForecastResponse(data) {
  return !!(data && data.ok === true &&
    data.decided && Array.isArray(data.decided.byPayoutDate) && Array.isArray(data.decided.byHouse) &&
    data.awaiting_decision && Array.isArray(data.awaiting_decision.byPayoutDate) && Array.isArray(data.awaiting_decision.byHouse) &&
    data.missing_payment_data && Array.isArray(data.missing_payment_data.rows));
}

const num = (v) => Number(v) || 0;
const flatRows = (section) => section.byPayoutDate.reduce((all, g) => all.concat(g.rows || []), []);

function buildRefundForecastSpec(data, now) {
  const decided = data.decided;
  const awaiting = data.awaiting_decision;
  const missing = data.missing_payment_data;
  const unresolved = data.unresolved && Array.isArray(data.unresolved.rows) ? data.unresolved : { count: 0, rows: [] };
  const title = 'תחזית החזרים לתשלום — E-ZONE';
  const note = 'הסעיפים אינם מסתכמים יחד';

  const byDateCols = (dateHeader) => [
    { header: dateHeader, key: 'payoutDate', type: 'date', width: 22 },
    { header: 'מספר', key: 'count', type: 'int', width: 10 },
    { header: 'סכום (כולל מע"מ)', key: 'total', type: 'money', width: 18 },
  ];
  const byHouseCols = [
    { header: 'בית', key: 'house', type: 'text', width: 22 },
    { header: 'מספר', key: 'count', type: 'int', width: 10 },
    { header: 'סכום (כולל מע"מ)', key: 'total', type: 'money', width: 18 },
  ];
  const sectionTotal = (label, s) => [{ label, values: { count: num(s.count), total: num(s.total) } }];
  const houseRows = (s) => s.byHouse.map((h) => ({ house: houseName(h.houseId), count: num(h.count), total: num(h.total) }));
  const dateRows = (s) => s.byPayoutDate.map((g) => ({ payoutDate: g.payoutDate || '', count: num(g.count), total: num(g.total) }));

  const summary = {
    name: SHEET_NAMES.summary, title, note,
    sections: [
      { heading: SECTION_LABELS.decided + ' — לפי תאריך תשלום', columns: byDateCols('תאריך תשלום'),
        rows: dateRows(decided), totals: sectionTotal('סה"כ הוחלט', decided), emptyText: 'אין זיכויים שהוחלטו וממתינים לתשלום' },
      { heading: SECTION_LABELS.decided + ' — לפי בית', columns: byHouseCols,
        rows: houseRows(decided), totals: sectionTotal('סה"כ הוחלט', decided), emptyText: 'אין זיכויים שהוחלטו וממתינים לתשלום' },
      { heading: SECTION_LABELS.awaiting + ' — לפי תאריך תשלום אם יוחלט היום (הצעה בלבד)', columns: byDateCols('תאריך תשלום אם יוחלט היום'),
        rows: dateRows(awaiting), totals: sectionTotal('סה"כ ממתין להחלטה (הצעה בלבד)', awaiting), emptyText: 'אין שחרורים הממתינים להחלטה' },
      { heading: SECTION_LABELS.awaiting + ' — לפי בית (הצעה בלבד)', columns: byHouseCols,
        rows: houseRows(awaiting), totals: sectionTotal('סה"כ ממתין להחלטה (הצעה בלבד)', awaiting), emptyText: 'אין שחרורים הממתינים להחלטה' },
      { heading: 'לבדיקה — ספירה בלבד, ללא סכום', columns: [
          { header: 'קטגוריה', key: 'label', type: 'text', width: 22 },
          { header: 'מספר', key: 'count', type: 'int', width: 10 },
        ],
        rows: [
          { label: SECTION_LABELS.missing, count: num(missing.count) },
          { label: SECTION_LABELS.unresolved, count: num(unresolved.count) },
          { label: 'אפס לפי מדיניות (לא מוצגים)', count: num(data.zeroByPolicyCount) },
        ] },
    ],
  };

  const decidedSheet = {
    name: SHEET_NAMES.decided, title: title + ' — ' + SECTION_LABELS.decided,
    columns: [
      { header: 'תאריך תשלום', key: 'payoutDate', type: 'date', width: 14 },
      { header: 'מטופל', key: 'patientName', type: 'text', width: 24 },
      { header: 'בית', key: 'house', type: 'text', width: 16 },
      { header: 'סכום (כולל מע"מ)', key: 'amount', type: 'money', width: 16 },
      { header: 'תאריך החלטה', key: 'decidedDate', type: 'date', width: 14 },
      { header: 'כלל', key: 'rule', type: 'text', width: 40 },
      { header: 'סיבת חריגה', key: 'overrideReason', type: 'text', width: 30 },
    ],
    rows: flatRows(decided).map((r) => ({
      payoutDate: r.payoutDate, patientName: r.patientName, house: houseName(r.houseId), amount: r.amount,
      decidedDate: r.decidedDate, rule: ruleText(r.rule), overrideReason: r.overrideReason || '',
    })),
    totals: [{ label: 'סה"כ הוחלט', values: { amount: num(decided.total) } }],
    emptyText: 'אין זיכויים שהוחלטו וממתינים לתשלום',
  };

  const awaitingSheet = {
    name: SHEET_NAMES.awaiting, title: title + ' — ' + SECTION_LABELS.awaiting,
    note: 'הסכום הוא הצעת המערכת בלבד — לא הוחלט ולא לתשלום',
    columns: [
      { header: 'מטופל', key: 'patientName', type: 'text', width: 24 },
      { header: 'בית', key: 'house', type: 'text', width: 16 },
      { header: 'תאריך כניסה', key: 'entryDate', type: 'date', width: 14 },
      { header: 'תאריך יציאה', key: 'exitDate', type: 'date', width: 14 },
      { header: 'סכום מוצע (כולל מע"מ)', key: 'suggestedAmount', type: 'money', width: 18 },
      { header: 'כלל', key: 'rule', type: 'text', width: 40 },
      { header: 'תאריך תשלום אם יוחלט היום', key: 'payoutDate', type: 'date', width: 18 },
    ],
    rows: flatRows(awaiting).map((r) => ({
      patientName: r.patientName, house: houseName(r.houseId), entryDate: r.entryDate, exitDate: r.exitDate,
      suggestedAmount: r.suggestedAmount, rule: ruleText(r.rule), payoutDate: r.payoutDate,
    })),
    totals: [{ label: 'סה"כ ממתין להחלטה (הצעה בלבד)', values: { suggestedAmount: num(awaiting.total) } }],
    emptyText: 'אין שחרורים הממתינים להחלטה',
  };

  const identCols = [
    { header: 'מטופל', key: 'patientName', type: 'text', width: 24 },
    { header: 'בית', key: 'house', type: 'text', width: 16 },
    { header: 'תאריך כניסה', key: 'entryDate', type: 'date', width: 14 },
    { header: 'תאריך יציאה', key: 'exitDate', type: 'date', width: 14 },
  ];
  const ident = (r) => ({ patientName: r.patientName, house: houseName(r.houseId), entryDate: r.entryDate, exitDate: r.exitDate });

  const missingSheet = {
    name: SHEET_NAMES.missing, title: title + ' — ' + SECTION_LABELS.missing,
    columns: identCols.concat([{ header: 'הערה', key: 'note', type: 'text', width: 28 }]),
    rows: missing.rows.map((r) => Object.assign(ident(r), { note: MISSING_NOTE })),
    totals: [{ label: 'מספר שחרורים לבדיקה', values: { house: num(missing.count) } }],
    emptyText: 'אין שחרורים עם נתוני תשלום חסרים',
  };

  const unresolvedSheet = {
    name: SHEET_NAMES.unresolved, title: title + ' — ' + SECTION_LABELS.unresolved,
    columns: identCols.concat([{ header: 'סיבה', key: 'reason', type: 'text', width: 34 }]),
    rows: unresolved.rows.map((r) => Object.assign(ident(r), { reason: errorText(r.error) })),
    totals: [{ label: 'מספר שחרורים לבדיקה', values: { house: num(unresolved.count) } }],
    emptyText: 'אין שחרורים שלא ניתן לחשב',
  };

  return { generatedAt: now, sheets: [summary, decidedSheet, awaitingSheet, missingSheet, unresolvedSheet] };
}

/* «זיכויים-לתשלום-YYYY-MM-DD.xlsx» → a Content-Disposition value: an ASCII
 * fallback name plus the RFC 5987 UTF-8 name. Pure. */
function contentDisposition(isoDay) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(isoDay)) ? String(isoDay) : 'unknown-date';
  const utf8Name = `זיכויים-לתשלום-${day}.xlsx`;
  const encoded = encodeURIComponent(utf8Name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="refund-forecast-${day}.xlsx"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  buildRefundForecastSpec,
  isForecastResponse,
  contentDisposition,
  HOUSE_NAMES,
  RULE_LABELS,
  CREDIT_TYPE_LABELS,
  SECTION_LABELS,
  ERROR_LABELS,
  MISSING_NOTE,
  SHEET_NAMES,
};
