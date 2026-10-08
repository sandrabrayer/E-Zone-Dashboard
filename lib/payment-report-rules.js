/* The strict payment report — the validation rules as pure functions.
 *
 * docs/billing-control-plan.md Phase 3 (§6.2, §14.1), decided by Sandra on
 * 2026-10-04. apps-script/Code.gs validatePaymentReport_ is the AUTHORITY;
 * this file is its mirror, for instant feedback in the form (Phase 3 PR 2) and
 * for the tests. test/payment-report-foundation.test.js runs both on the same
 * inputs and requires the same answer, field by field.
 *
 * Pure: no I/O, no clock unless the caller omits ctx.todayIso (then today in
 * Asia/Jerusalem), nothing logged.
 *
 * A report is the money actually received for one billing cycle:
 *   receivedDate   the day the money arrived — 'YYYY-MM-DD' (stored) or
 *                  'DD/MM/YYYY' (typed); never in the future (Asia/Jerusalem)
 *   amount         ₪, > 0, at most 2 decimals (on a Payments row: amountPaid)
 *   method         one of PAYMENT_METHODS
 *   payer          free text, 2–100 characters, no control character, not
 *                  starting with = + @ - (a formula lead-in in an export)
 *   coverageStart / coverageEnd  both required, a real period ≤ 366 days
 *   funder         one of PAYMENT_FUNDERS
 *   reference      transaction / cheque number: required for the methods in
 *                  REFERENCE_REQUIRED_METHODS, optional otherwise; when given,
 *                  3–40 letters, digits, '-' or '/', starting with a letter
 *                  or a digit
 * recordedBy / recordedAt and the confirm* fields are server-stamped and are
 * not validated here.
 *
 * → [{ field, code, hebrewMessage }], in REPORT_FIELDS order; [] = valid.
 *
 * Phase 3 PR 2: ctx.maxDaysBack — a receivedDate more than that many days
 * before today is refused (received_date_too_old, «פנו לסנדרה»). The form and
 * reportPayment_ pass RECEIVED_DATE_STAFF_MAX_DAYS for everyone but the
 * approver; omitted, there is no age limit (the PR 1 behaviour).
 *
 * LOADED TWICE: by Node (require, server tests) and by the browser as a
 * classic <script> (served at /payment-report-rules.js) — the IIFE keeps every
 * name out of the page's global scope except window.PaymentReportRules. */

(function (root) {
'use strict';

const PAYMENT_METHODS = Object.freeze(['העברה בנקאית', 'אשראי', "צ'ק", 'מזומן', 'ביט', 'אחר']);
const PAYMENT_FUNDERS = Object.freeze(['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי', 'פרו-בונו']);
/* Appended last (append-only; CHANGELOG-funder-probono.md). A pro-bono
 * patient owes nothing; a report for one still names its funder explicitly. */
const FUNDER_PROBONO = 'פרו-בונו';
/* No default funder (Code.gs FUNDER_UNSET): a patient without one reads as
 * «לא הוגדר» and a report must name one. */
const FUNDER_UNSET = 'unset';
const REFERENCE_REQUIRED_METHODS = Object.freeze(['העברה בנקאית', "צ'ק"]);
const CONFIRM_STATUSES = Object.freeze(['reported', 'confirmed', 'flagged']);
const REPORT_FIELDS = Object.freeze(['receivedDate', 'amount', 'method', 'payer', 'coverageStart', 'coverageEnd', 'funder', 'reference']);

const PAYER_MIN = 2;
const PAYER_MAX = 100;
const REFERENCE_MIN = 3;
const REFERENCE_MAX = 40;
const FLAG_NOTE_MIN = 2;
const FLAG_NOTE_MAX = 300;
const COVERAGE_MAX_DAYS = 366;
const RECEIVED_DATE_STAFF_MAX_DAYS = 90;
/* «חשבונית?» / «על שם» (CHANGELOG-payment-invoice.md) — mirrors Code.gs
 * validatePaymentInvoice_. NO default: the choice is required. */
const INVOICE_CHOICES = Object.freeze(['yes', 'no']);
const INVOICE_FIELDS = Object.freeze(['invoiceWanted', 'invoiceTo']);
const INVOICE_TO_MAX = 120;

const MESSAGES = Object.freeze({
  received_date_missing: 'חסר: תאריך קבלת התשלום',
  received_date_invalid: 'תאריך קבלת התשלום לא תקין',
  received_date_future: 'תאריך קבלת התשלום לא יכול להיות בעתיד',
  amount_missing: 'חסר: סכום',
  amount_invalid: 'סכום לא תקין',
  amount_not_positive: 'הסכום חייב להיות גדול מאפס',
  method_missing: 'חסר: אמצעי תשלום',
  method_invalid: 'אמצעי תשלום לא מוכר',
  payer_missing: 'חסר: שם משלם',
  payer_invalid: 'שם משלם לא תקין',
  coverage_start_missing: 'חסר: תחילת תקופת הכיסוי',
  coverage_end_missing: 'חסר: סוף תקופת הכיסוי',
  coverage_invalid: 'תאריך לא תקין בתקופת הכיסוי',
  coverage_reversed: 'תאריך הסיום מוקדם מתאריך ההתחלה',
  coverage_too_long: 'תקופת כיסוי ארוכה מדי (המקסימום ' + COVERAGE_MAX_DAYS + ' ימים)',
  funder_missing: 'חסר: גורם מממן',
  funder_invalid: 'גורם מממן לא מוכר',
  funder_unset: 'לא הוגדר גורם מממן למטופל — יש לבחור גורם מממן בדיווח או להגדיר אותו בכרטיס המטופל',
  funder_probono_explicit: 'המטופל פרו-בונו — יש לבחור גורם מממן בדיווח במפורש',
  reference_missing: "חסר: מספר אסמכתא (חובה בהעברה בנקאית ובצ'ק)",
  reference_invalid: 'מספר אסמכתא לא תקין',
  // Server-only (the confirm fields, Phase 4) — listed so the form can show them.
  confirm_status_invalid: 'סטטוס אישור לא מוכר',
  confirm_without_report: 'אין דיווח תשלום לאשר — חסר תאריך קבלה',
  flag_note_missing: 'בסימון «בעיה» חובה לפרט (2 עד 300 תווים)',
  received_date_too_old: 'תאריך קבלה לפני יותר מ-' + RECEIVED_DATE_STAFF_MAX_DAYS + ' יום — פנו לסנדרה',
  invoice_choice_missing: 'חסר: חשבונית? — יש לבחור כן או לא',
  invoice_choice_invalid: 'בחירת חשבונית לא תקינה — כן או לא בלבד',
  invoice_to_missing: 'חסר: על שם מי החשבונית',
  invoice_to_invalid: 'שם לחשבונית לא תקין — עד ' + INVOICE_TO_MAX + ' תווים, לא מתחיל ב-= + - @',
});

function text(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/* "צ׳ק" (Hebrew geresh) and "צ’ק" (typographic quote) are the same method as
 * the stored "צ'ק". Nothing else is folded. */
function normalizeMethod(v) {
  return text(v).replace(/[\u05F3\u2019\u2018`]/g, "'");
}

function isRealDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* 'YYYY-MM-DD' or 'DD/MM/YYYY' (also D/M/YYYY) → 'YYYY-MM-DD'; '' when blank;
 * null when it is not a real calendar date. Nothing else is accepted. */
function parseReportDate(v) {
  const t = text(v);
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? t : null;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return isRealDate(+m[3], +m[2], +m[1]) ? m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]) : null;
  return null;
}

/* 'YYYY-MM-DD' → 'DD/MM/YYYY' for display; anything else as is. */
function formatReportDate(iso) {
  const m = text(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : text(iso);
}

/* Today in Asia/Jerusalem as 'YYYY-MM-DD'. */
function jerusalemToday(now) {
  const d = now instanceof Date ? now : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dayNum(iso) {
  const p = iso.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

/* A finite number > 0 with at most 2 decimals. Numbers and plain decimal
 * strings only: no comma, no sign, no exponent. */
function amountCode(v) {
  if (v === null || v === undefined || text(v) === '') return 'amount_missing';
  let n;
  if (typeof v === 'number') {
    if (!isFinite(v)) return 'amount_invalid';
    n = v;
    if (Math.round(n * 100) / 100 !== n) return 'amount_invalid';
  } else {
    const t = text(v);
    if (/^-\d/.test(t) || t === '0' || /^0(\.0+)?$/.test(t)) return 'amount_not_positive';
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'amount_invalid';
    n = Number(t);
  }
  return n > 0 ? '' : 'amount_not_positive';
}

/* Control characters are never a name. */
function payerCode(v) {
  const t = text(v);
  if (!t) return 'payer_missing';
  if (/[\u0000-\u001f\u007f]/.test(t) || /^[=+@-]/.test(t) || t.length < PAYER_MIN || t.length > PAYER_MAX) return 'payer_invalid';
  return '';
}

function referenceCode(v, method) {
  const t = text(v);
  if (!t) return REFERENCE_REQUIRED_METHODS.indexOf(normalizeMethod(method)) >= 0 ? 'reference_missing' : '';
  if (t.length < REFERENCE_MIN || t.length > REFERENCE_MAX) return 'reference_invalid';
  return /^[A-Za-z0-9\u05D0-\u05EA][A-Za-z0-9\u05D0-\u05EA\-/]*$/.test(t) ? '' : 'reference_invalid';
}

function issue(field, code) {
  return { field, code, hebrewMessage: MESSAGES[code] };
}

function validatePaymentReport(report, ctx) {
  const r = report && typeof report === 'object' ? report : {};
  const today = (ctx && ctx.todayIso) || jerusalemToday();
  const out = [];

  const rd = parseReportDate(r.receivedDate);
  if (rd === '') out.push(issue('receivedDate', 'received_date_missing'));
  else if (rd === null) out.push(issue('receivedDate', 'received_date_invalid'));
  else if (rd > today) out.push(issue('receivedDate', 'received_date_future'));
  else if (ctx && Number(ctx.maxDaysBack) > 0 && dayNum(today) - dayNum(rd) > Number(ctx.maxDaysBack)) {
    out.push(issue('receivedDate', 'received_date_too_old'));
  }

  const ac = amountCode(r.amount);
  if (ac) out.push(issue('amount', ac));

  const method = normalizeMethod(r.method);
  if (!method) out.push(issue('method', 'method_missing'));
  else if (PAYMENT_METHODS.indexOf(method) < 0) out.push(issue('method', 'method_invalid'));

  const pc = payerCode(r.payer);
  if (pc) out.push(issue('payer', pc));

  const cs = parseReportDate(r.coverageStart);
  const ce = parseReportDate(r.coverageEnd);
  if (cs === '') out.push(issue('coverageStart', 'coverage_start_missing'));
  else if (cs === null) out.push(issue('coverageStart', 'coverage_invalid'));
  if (ce === '') out.push(issue('coverageEnd', 'coverage_end_missing'));
  else if (ce === null) out.push(issue('coverageEnd', 'coverage_invalid'));
  if (cs && ce) {
    if (ce < cs) out.push(issue('coverageEnd', 'coverage_reversed'));
    else if (dayNum(ce) - dayNum(cs) + 1 > COVERAGE_MAX_DAYS) out.push(issue('coverageEnd', 'coverage_too_long'));
  }

  const funder = text(r.funder);
  if (!funder) out.push(issue('funder', 'funder_missing'));
  else if (PAYMENT_FUNDERS.indexOf(funder) < 0) out.push(issue('funder', 'funder_invalid'));

  const rc = referenceCode(r.reference, method);
  if (rc) out.push(issue('reference', rc));

  return out;
}

/* «על שם»: '' valid, else the error code (Code.gs paymentInvoiceToCode_). */
function invoiceToCode(v) {
  const t = text(v);
  if (!t) return 'invoice_to_missing';
  if (/[\u0000-\u001f\u007f]/.test(t) || /^[=+@-]/.test(t) || t.length > INVOICE_TO_MAX) return 'invoice_to_invalid';
  return '';
}

/* validatePaymentInvoice({ invoiceWanted, invoiceTo }) → issues; [] = valid.
 * Code.gs validatePaymentInvoice_ is the authority (parity-tested). */
function validatePaymentInvoice(report) {
  const r = report && typeof report === 'object' ? report : {};
  const w = text(r.invoiceWanted);
  if (!w) return [issue('invoiceWanted', 'invoice_choice_missing')];
  if (INVOICE_CHOICES.indexOf(w) < 0) return [issue('invoiceWanted', 'invoice_choice_invalid')];
  if (w === 'yes') {
    const code = invoiceToCode(r.invoiceTo);
    if (code) return [issue('invoiceTo', code)];
  }
  return [];
}

/* A Payments row as a report: the money received is amountPaid. */
function reportFromPaymentRow(row) {
  const p = row && typeof row === 'object' ? row : {};
  return {
    receivedDate: p.receivedDate, amount: p.amountPaid, method: p.method, payer: p.payer,
    coverageStart: p.coverageStart, coverageEnd: p.coverageEnd, funder: p.funder, reference: p.reference,
  };
}

const API = {
  PAYMENT_METHODS,
  PAYMENT_FUNDERS,
  FUNDER_UNSET,
  FUNDER_PROBONO,
  REFERENCE_REQUIRED_METHODS,
  CONFIRM_STATUSES,
  REPORT_FIELDS,
  MESSAGES,
  PAYER_MIN,
  PAYER_MAX,
  REFERENCE_MIN,
  REFERENCE_MAX,
  FLAG_NOTE_MIN,
  FLAG_NOTE_MAX,
  COVERAGE_MAX_DAYS,
  RECEIVED_DATE_STAFF_MAX_DAYS,
  INVOICE_CHOICES,
  INVOICE_FIELDS,
  INVOICE_TO_MAX,
  validatePaymentReport,
  validatePaymentInvoice,
  reportFromPaymentRow,
  parseReportDate,
  formatReportDate,
  normalizeMethod,
  jerusalemToday,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.PaymentReportRules = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
