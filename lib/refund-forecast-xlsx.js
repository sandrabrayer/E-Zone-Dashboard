/* «ייצוא זיכויים לאקסל» — the refundPayoutForecast response («זיכויים
 * לתשלום») as an .xlsx spec for lib/xlsx-report.js. Pure: no I/O, no clock
 * (the caller passes `now`).
 *
 * Refunds are computed by policy and created automatically at discharge
 * (CHANGELOG-refunds-auto-policy.md) — there is no decision section any more.
 * Three sheets: «סיכום» (totals per payment date + a grand total, and a
 * count-only table of what is NOT in the list), «זיכויים לתשלום» (one row per
 * refund, every column the screen shows) and «לא ניתן לחשב».
 *
 * A discharged patient with NO recorded payment is DEBT, not a refund
 * (Sandra, 02/10/2026 — CHANGELOG-billing-tab-section-colors.md): only its
 * COUNT appears, as one line in «סיכום» that points to «חובות פתוחים».
 *
 * Colours (lib/report-colors.js, the same hex as the screen): the list green,
 * לא ניתן לחשב and the count table grey.
 *
 * The Hebrew labels below mirror the constants in public/app.js
 * (HOUSES, CREDIT_RULE_LABELS, CREDIT_TYPE_LABELS, DISPOSITION_LABELS,
 * PAYOUT_FORECAST_*). test/xlsx-export.test.js fails if the copies drift. */

const HOUSE_NAMES = {
  arfoni: 'קיסריה עפרוני',
  rehab:  'קיסריה ריהאב',
  asher:  'רעננה אשר',
  pardes: 'רעננה הפרדס',
  ramot:  'רמות השבים',
  sde:    'שדה אליעזר',
};

const RULE_LABELS = {
  stay_prorata:               'יציאה ביום שהייה 1–13 — זיכוי יחסי על המחזור הנוכחי',
  stay_day14_zero:            'יציאה ביום שהייה 14 ומעלה — ללא זיכוי על המחזור הנוכחי',
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
  toPay:      'זיכויים לתשלום',
  unresolved: 'לא ניתן לחשב — לבדוק',
};
const DISPOSITION_LABELS = {
  not_relevant:        'לא רלוונטי',
  completed:           'סיים טיפול',
  stopped_early:       'הפסיק לפני הזמן',
  released_outpatient: 'משוחרר לטיפול חוץ',
};
/* ruleVersion → the rule family the refund was computed under. */
const RULE_VERSION_LABELS = { 1: 'ישן (לפי בית)', 2: 'חדש (אחיד)' };
const ERROR_LABELS = {
  unknown_house:     'בית לא מוכר',
  bad_date:          'תאריך כניסה או יציאה חסר / לא תקין',
  exit_before_entry: 'תאריך היציאה לפני תאריך הכניסה',
  bad_amount:        'סכום ששולם לא תקין',
  bad_coverage:      'תקופת כיסוי לא תקינה',
};
/* The one count-only line for discharges with no recorded payment; the
 * screen prefixes the count: «N משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״». */
const MISSING_LINE = 'משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״';

const SHEET_NAMES = {
  summary:    'סיכום',
  toPay:      'זיכויים לתשלום',
  unresolved: 'לא ניתן לחשב',
};

function houseName(id) { return HOUSE_NAMES[id] || id || '—'; }
function ruleText(rule) {
  return String(rule || '').split(',').filter(Boolean)
    .map((r) => RULE_LABELS[r] || CREDIT_TYPE_LABELS[r] || r).join(' + ') || '—';
}
function errorText(code) { return ERROR_LABELS[code] || String(code || 'שגיאה'); }
/* «סיים טיפול — <note>»: the disposition label and the discharge note. */
function leaveReasonText(r) {
  const label = DISPOSITION_LABELS[r && r.disposition] || String((r && r.disposition) || '');
  const note = String((r && r.dischargeNote) || '').trim();
  return [label, note].filter(Boolean).join(' — ') || '—';
}
function ruleVersionText(v) { return RULE_VERSION_LABELS[Number(v)] || '—'; }

/* True when `data` has the shape refundPayoutForecast returns on success. */
function isForecastResponse(data) {
  return !!(data && data.ok === true &&
    data.toPay && Array.isArray(data.toPay.rows) && Array.isArray(data.toPay.byPayoutDate) &&
    // Only the COUNT is shown (as one line in «סיכום»), so only the count is
    // required: a server that trims the rows keeps working.
    data.missing_payment_data && isFinite(Number(data.missing_payment_data.count)));
}

const num = (v) => Number(v) || 0;
const COLORS = { toPay: 'credits', unresolved: 'unresolved' };

function buildRefundForecastSpec(data, now) {
  const toPay = data.toPay;
  const missingCount = num(data.missing_payment_data && data.missing_payment_data.count);
  const unresolved = data.unresolved && Array.isArray(data.unresolved.rows) ? data.unresolved : { count: 0, rows: [] };
  const title = SECTION_LABELS.toPay;
  const note = 'זיכויים מחושבים אוטומטית לפי המדיניות — אין שלב החלטה';

  const summary = {
    name: SHEET_NAMES.summary, title, note,
    sections: [
      { heading: SECTION_LABELS.toPay + ' — לפי תאריך תשלום', color: COLORS.toPay, columns: [
          { header: 'תאריך תשלום', key: 'payoutDate', type: 'date', width: 22 },
          { header: 'מספר זיכויים', key: 'count', type: 'int', width: 14 },
          { header: 'סכום (כולל מע"מ)', key: 'total', type: 'money', width: 18 },
        ],
        rows: toPay.byPayoutDate.map((g) => ({ payoutDate: g.payoutDate || '', count: num(g.count), total: num(g.total) })),
        totals: [{ label: 'סה"כ לתשלום', values: { count: num(toPay.count), total: num(toPay.total) } }],
        emptyText: 'אין זיכויים לתשלום' },
      { heading: 'לבדיקה — ספירה בלבד, ללא סכום', color: COLORS.unresolved, columns: [
          { header: 'קטגוריה', key: 'label', type: 'text', width: 22 },
          { header: 'מספר', key: 'count', type: 'int', width: 10 },
        ],
        rows: [
          { label: MISSING_LINE, count: missingCount },
          { label: SECTION_LABELS.unresolved, count: num(unresolved.count) },
          { label: 'אפס לפי מדיניות (לא מוצגים)', count: num(data.zeroByPolicyCount) },
        ] },
    ],
  };

  const listSheet = {
    name: SHEET_NAMES.toPay, title: title, color: COLORS.toPay,
    columns: [
      { header: 'תאריך תשלום', key: 'payoutDate', type: 'date', width: 14 },
      { header: 'מטופל', key: 'patientName', type: 'text', width: 24 },
      { header: 'בית', key: 'house', type: 'text', width: 16 },
      { header: 'סה"כ שולם', key: 'totalPaid', type: 'money', width: 14 },
      { header: 'תאריך כניסה', key: 'entryDate', type: 'date', width: 14 },
      { header: 'תאריך יציאה', key: 'exitDate', type: 'date', width: 14 },
      { header: 'סיבת עזיבה', key: 'leaveReason', type: 'text', width: 30 },
      { header: 'ימי שהייה', key: 'daysStayed', type: 'int', width: 10 },
      { header: 'ימי זיכוי', key: 'refundDays', type: 'int', width: 10 },
      { header: 'סכום זיכוי (כולל מע"מ)', key: 'amount', type: 'money', width: 16 },
      { header: 'כלל', key: 'ruleVersion', type: 'text', width: 14 },
      { header: 'פירוט הכלל', key: 'rule', type: 'text', width: 40 },
    ],
    rows: toPay.rows.map((r) => ({
      payoutDate: r.payoutDate, patientName: r.patientName, house: houseName(r.houseId), totalPaid: num(r.totalPaid),
      entryDate: r.entryDate, exitDate: r.exitDate, leaveReason: leaveReasonText(r),
      daysStayed: r.daysStayed === '' ? null : num(r.daysStayed), refundDays: r.refundDays === '' ? null : num(r.refundDays),
      amount: num(r.amount), ruleVersion: ruleVersionText(r.ruleVersion), rule: ruleText(r.rule),
    })),
    totals: [{ label: 'סה"כ לתשלום', values: { amount: num(toPay.total) } }],
    emptyText: 'אין זיכויים לתשלום',
  };

  const identCols = [
    { header: 'מטופל', key: 'patientName', type: 'text', width: 24 },
    { header: 'בית', key: 'house', type: 'text', width: 16 },
    { header: 'תאריך כניסה', key: 'entryDate', type: 'date', width: 14 },
    { header: 'תאריך יציאה', key: 'exitDate', type: 'date', width: 14 },
  ];
  const ident = (r) => ({ patientName: r.patientName, house: houseName(r.houseId), entryDate: r.entryDate, exitDate: r.exitDate });

  const unresolvedSheet = {
    name: SHEET_NAMES.unresolved, title: title + ' — ' + SECTION_LABELS.unresolved, color: COLORS.unresolved,
    columns: identCols.concat([{ header: 'סיבה', key: 'reason', type: 'text', width: 34 }]),
    rows: unresolved.rows.map((r) => Object.assign(ident(r), { reason: errorText(r.error) })),
    totals: [{ label: 'מספר שחרורים לבדיקה', values: { house: num(unresolved.count) } }],
    emptyText: 'אין שחרורים שלא ניתן לחשב',
  };

  return { generatedAt: now, sheets: [summary, listSheet, unresolvedSheet] };
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
  DISPOSITION_LABELS,
  RULE_VERSION_LABELS,
  leaveReasonText,
  ERROR_LABELS,
  MISSING_LINE,
  SHEET_NAMES,
};
