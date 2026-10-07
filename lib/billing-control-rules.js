/* «בקרת גבייה» (Phase 4) — the tab's pure views and «הכנסה מאומתת».
 *
 * docs/billing-control-plan.md Phase 4 / §7, decided by Sandra on 2026-10-04.
 * CHANGELOG-billing-control-tab.md.
 *
 * ONE definition, two runtimes: server.js requires it for the «ייצוא אימות»
 * workbook (lib/billing-control-xlsx.js), and the page loads the same file at
 * /billing-control-rules.js (window.BillingControlRules) for the tab and for
 * the «מאומת» figure on הכנסות חודשיות. No data in it, no I/O, no clock.
 *
 * «הכנסה מאומתת» (verified revenue) of a month = the CONFIRMED receipts
 * (confirmStatus 'confirmed', not void), each allocated to the month by its
 * coverage window, day by day — exactly the rule buildMonthlyRevenue
 * (public/app.js revenueAllocate) uses for «נגבה»: share = days of the window
 * inside the month ÷ days of the window, amount = round2(amount × share).
 * test/billing-control-tab.test.js checks the two agree on one fixture.
 *
 * The receipts come from action=billingControlQueue (apps-script/Code.gs
 * billingControlQueue_): { id, patientName, houseId, amount, receivedDate,
 * method, reference, payer, funder, coverageStart, coverageEnd, recordedBy,
 * recordedAt, confirmStatus, confirmedBy, confirmedAt, flagNote, flaggedAt,
 * verifiedAmount, openAmount, confirmedAmount, controlNote }.
 *
 * Partial confirmation + Ortal's note (CHANGELOG-ortal-billing-access.md,
 * Sandra 2026-10-06): a receipt may also be 'partial' («שולם חלקית»). Only the
 * CONFIRMED money is verified: a confirmed receipt counts in full, a partial
 * one counts its confirmedAmount, and its rest is open debt in the tab
 * (openAmountOf / openDebt) — Code.gs receiptVerifiedAmount_ /
 * receiptOpenAmount_ / billingControlOpenDebt_ are the same rules (parity
 * test). «נגבה», debt aging and every shared revenue rule are unchanged. */
(function (root) {
'use strict';

const CONFIRM_STATUSES = ['reported', 'confirmed', 'flagged'];
/* Every status a receipt can hold (Code.gs CONTROL_STATUSES). */
const CONTROL_STATUSES = ['reported', 'confirmed', 'partial', 'flagged'];
const STATUS_LABELS = { reported: 'ממתין לאימות', flagged: 'סומן כבעיה', confirmed: 'אומת', partial: 'שולם חלקית' };
/* The status dropdown (replaces ✓ / ⚑): value → label, in display order. */
const DECISION_OPTIONS = [
  { value: 'confirmed', label: 'שולם' },
  { value: 'partial', label: 'שולם חלקית' },
  { value: 'flagged', label: 'לא שולם' },
];
const FLAG_NOTE_MIN = 2;
const FLAG_NOTE_MAX = 300;
const CONTROL_NOTE_MAX = 500;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* A bare 'YYYY-MM-DD' naming a real calendar day. Pure. */
function isIsoDay(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
  return d.toISOString().slice(0, 10) === s;
}
function isMonthKey(s) {
  return typeof s === 'string' && MONTH_RE.test(s);
}
function dayNum(iso) {
  return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000);
}
/* 'YYYY-MM' → { startN, endN } (inclusive day numbers). */
function monthSpan(key) {
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7));
  const startN = Math.round(Date.UTC(y, m - 1, 1) / 86400000);
  const endN = Math.round(Date.UTC(y, m, 0) / 86400000);
  return { startN, endN };
}

/* A receipt's coverage window { start, end } ('YYYY-MM-DD'): the recorded
 * coverage (every receipt has one — the report is strict), else its
 * receivedDate as a one-day window. null when neither is a real day. Pure. */
function receiptWindow(r) {
  const o = r || {};
  const s = String(o.coverageStart || ''), e = String(o.coverageEnd || '');
  if (isIsoDay(s) && isIsoDay(e) && e >= s) return { start: s, end: e };
  const d = String(o.receivedDate || '');
  if (isIsoDay(d)) return { start: d, end: d };
  return null;
}

/* The slice of `amount` over [start, end] that falls in month `key`:
 * { amount, daysInMonth, windowDays }. Same arithmetic as app.js
 * revenueAllocate (amount × (inMonth / windowDays), rounded to agorot). */
function allocateToMonth(amount, win, key) {
  const zero = { amount: 0, daysInMonth: 0, windowDays: 0 };
  if (!win || !isMonthKey(key)) return zero;
  const a = dayNum(win.start), b = dayNum(win.end);
  const windowDays = b - a + 1;
  if (windowDays <= 0) return zero;
  const m = monthSpan(key);
  const from = Math.max(a, m.startN), to = Math.min(b, m.endN);
  if (from > to) return { amount: 0, daysInMonth: 0, windowDays };
  const inMonth = to - from + 1;
  const share = inMonth / windowDays;
  return { amount: round2((Number(amount) || 0) * share), daysInMonth: inMonth, windowDays };
}

/* Every month a window touches, oldest first ('YYYY-MM'). Pure. */
function monthsOfWindow(win) {
  if (!win) return [];
  const out = [];
  let y = Number(win.start.slice(0, 4)), m = Number(win.start.slice(5, 7));
  const endKey = win.end.slice(0, 7);
  for (let i = 0; i < 400; i++) {
    const key = y + '-' + (m < 10 ? '0' : '') + m;
    out.push(key);
    if (key >= endKey) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* A voided receipt (the app's normalized receipts carry status 'void')
 * is no money at all — in no list and no total. */
function isVoid(r) {
  return String((r && r.status) || '').trim().toLowerCase() === 'void';
}

function statusOf(r) {
  const s = String((r && r.confirmStatus) || '').trim();
  return CONTROL_STATUSES.indexOf(s) >= 0 ? s : 'reported';
}

/* A money cell: '' / null / undefined → null, else the number in agorot. */
function moneyCell(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? round2(n) : null;
}

/* The verified money of a receipt — only what Ortal confirmed. Pure.
 *   confirmed → confirmedAmount, or the full amount when blank (a receipt
 *               confirmed before the column existed)
 *   partial   → confirmedAmount
 *   reported / flagged / void → 0
 * A queue projection already carries it (verifiedAmount) — used as is. */
function verifiedAmountOf(r) {
  if (!r || isVoid(r)) return 0;
  const st = statusOf(r);
  if (st !== 'confirmed' && st !== 'partial') return 0;
  const pre = moneyCell(r.verifiedAmount);
  if (pre !== null) return pre;
  const cell = moneyCell(r.confirmedAmount);
  if (st === 'confirmed') return cell === null ? round2(r.amount) : cell;
  return cell === null ? 0 : cell;
}

/* The open (unverified) money of a DECIDED receipt: partial → amount −
 * verified; flagged («לא שולם») → the whole amount; reported (still waiting),
 * confirmed and void → 0. Pure. */
function openAmountOf(r) {
  if (!r || isVoid(r)) return 0;
  const st = statusOf(r);
  if (st === 'partial') return Math.max(0, round2((Number(r.amount) || 0) - verifiedAmountOf(r)));
  if (st === 'flagged') return round2(r.amount);
  return 0;
}

/* The tab's open debt by verification: { partial:{count,amount},
 * notReceived:{count,amount}, total }. Waiting receipts are not debt here.
 * Same as Code.gs billingControlOpenDebt_. Pure. */
function openDebt(receipts, house) {
  const out = { partial: { count: 0, amount: 0 }, notReceived: { count: 0, amount: 0 }, total: 0 };
  (Array.isArray(receipts) ? receipts : []).forEach((r) => {
    if (!r || isVoid(r)) return;
    if (house && house !== 'all' && String(r.houseId || '') !== house) return;
    const open = openAmountOf(r);
    if (open <= 0) return;
    const st = statusOf(r);
    const b = st === 'partial' ? out.partial : st === 'flagged' ? out.notReceived : null;
    if (!b) return;
    b.count++;
    b.amount = round2(b.amount + open);
    out.total = round2(out.total + open);
  });
  return out;
}

/* «שולם חלקית» amount as typed, judged like the server: > 0, < the reported
 * amount, at most two decimals. → { amount, error }. Pure. */
function partialAmountCheck(raw, reported) {
  const t = String(raw == null ? '' : raw).trim().replace(/,/g, '');
  const bad = { amount: null, error: 'בתשלום חלקי חובה להזין סכום שהתקבל (מספר, עד שתי ספרות אחרי הנקודה)' };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return bad;
  const n = round2(Number(t));
  const rep = Number(reported) || 0;
  if (!(n > 0 && n < rep)) return { amount: null, error: 'הסכום שהתקבל חייב להיות גדול מאפס וקטן מהסכום שדווח' };
  return { amount: n, error: '' };
}

/* Ortal's note as the server will store it: one line, trimmed, a formula
 * lead-in dropped; longer than 500 → refused (never cut). '' clears.
 * → { note, error }. Pure. */
function controlNoteCheck(raw) {
  const t = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
  if (t.length > CONTROL_NOTE_MAX) return { note: '', error: 'הערה — עד 500 תווים' };
  return { note: t, error: '' };
}

/* «הכנסה מאומתת» for month `key` (optionally one house): the confirmed
 * receipts' slices in that month — a partial receipt contributes only its
 * confirmed amount (verifiedAmountOf), allocated the same way.
 * → { month, rows: [receipt + amountInMonth, daysInMonth, windowDays],
 *     total, count } — total = Σ rows' amountInMonth (incl. VAT, as stored). */
function verifiedForMonth(receipts, key, house) {
  const rows = [];
  let total = 0;
  if (!isMonthKey(key)) return { month: key, rows, total: 0, count: 0 };
  (Array.isArray(receipts) ? receipts : []).forEach((r) => {
    if (!r || isVoid(r) || verifiedAmountOf(r) <= 0) return;
    if (house && house !== 'all' && String(r.houseId || '') !== house) return;
    const win = receiptWindow(r);
    const a = allocateToMonth(verifiedAmountOf(r), win, key);
    if (!a.daysInMonth) return;
    rows.push(Object.assign({}, r, { amountInMonth: a.amount, daysInMonth: a.daysInMonth, windowDays: a.windowDays }));
    total = round2(total + a.amount);
  });
  rows.sort((x, y) => (String(y.receivedDate).localeCompare(String(x.receivedDate)))
    || String(x.patientName || '').localeCompare(String(y.patientName || ''), 'he'));
  return { month: key, rows, total, count: rows.length };
}

/* Every month any confirmed (or partly confirmed) receipt touches, newest
 * first. Pure. */
function verifiedMonths(receipts) {
  const seen = {};
  (Array.isArray(receipts) ? receipts : []).forEach((r) => {
    if (!r || isVoid(r) || verifiedAmountOf(r) <= 0) return;
    monthsOfWindow(receiptWindow(r)).forEach((k) => { seen[k] = true; });
  });
  return Object.keys(seen).sort().reverse();
}

/* The receipts in one confirm status, newest first (receivedDate, then
 * recordedAt) — the queue order. Optional house filter. Pure. */
function receiptsByStatus(receipts, status, house) {
  return (Array.isArray(receipts) ? receipts : [])
    .filter((r) => r && !isVoid(r) && statusOf(r) === status && (!house || house === 'all' || String(r.houseId || '') === house))
    .slice()
    .sort((a, b) => String(b.receivedDate || '').localeCompare(String(a.receivedDate || ''))
      || String(b.recordedAt || '').localeCompare(String(a.recordedAt || ''))
      || String(a.id || '').localeCompare(String(b.id || '')));
}

/* { count, amount } of a receipt list. */
function sumOf(list) {
  let amount = 0;
  (list || []).forEach((r) => { amount = round2(amount + (Number(r.amount) || 0)); });
  return { count: (list || []).length, amount };
}

/* The four summary cards. Pure.
 *   reported-not-confirmed (count + ₪), flagged (count + ₪), confirmed in
 *   `monthKey` (₪, «הכנסה מאומתת»), and «חובות מעל 60 יום» (from the server's
 *   debt60, recorded and unrecorded kept apart). */
function summaryCards(data, monthKey) {
  const d = data || {};
  const receipts = Array.isArray(d.receipts) ? d.receipts : [];
  const v = verifiedForMonth(receipts, monthKey, 'all');
  return {
    reported: sumOf(receiptsByStatus(receipts, 'reported')),
    flagged: sumOf(receiptsByStatus(receipts, 'flagged')),
    partial: sumOf(receiptsByStatus(receipts, 'partial')),
    confirmedThisMonth: { month: monthKey, amount: v.total, count: v.count },
    debt60: d.debt60 || null,
    // Only confirmed money reduces it (partial rest + «לא שולם»).
    openDebt: openDebt(receipts),
  };
}

/* ===== The «אומתו» line (CHANGELOG-receipt-duplicates-and-edit.md) =====
 * A confirmed receipt whose coverage spans months used to read
 * "₪36,774.19 (מתוך ₪38,000)" — the partial-payment shape. The line now names
 * the month's part, the whole receipt with its period, and the status in
 * words; «שולם חלקית» appears ONLY for status 'partial'. */
const MONTH_NAMES_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/* 'YYYY-MM' → «אוקטובר» ('' when not a month key). Pure. */
function monthNameHe(key) {
  return isMonthKey(key) ? MONTH_NAMES_HE[Number(key.slice(5, 7)) - 1] : '';
}

/* 'YYYY-MM-DD' → 'DD/MM' ('' when not a real day). Pure. */
function dayMonthHe(iso) {
  return isIsoDay(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';
}

function defaultShekel(n) {
  return '₪' + (Number(n) || 0).toLocaleString('he-IL');
}

/* The confirmed-list line of receipt `r` in month `key`, its slice there
 * being `inMonth`. `fmt` formats money (the page passes fmtShekel). Pure.
 *   confirmed, spans months → «חלק אוקטובר: ₪x · הקבלה המלאה ₪y (תקופה
 *                              02/10–01/11) · שולם במלואו»
 *   confirmed, one month    → «₪y · שולם במלואו»
 *   partial                 → «חלק אוקטובר: ₪x · אומת ₪v מתוך ₪y (תקופה …)
 *                              · שולם חלקית» */
function confirmedMonthLine(r, key, inMonth, fmt) {
  const money = typeof fmt === 'function' ? fmt : defaultShekel;
  const o = r || {};
  const win = receiptWindow(o);
  const period = win ? ` (תקופה ${dayMonthHe(win.start)}–${dayMonthHe(win.end)})` : '';
  const spans = monthsOfWindow(win).length > 1;
  const part = `חלק ${monthNameHe(key) || 'החודש'}: ${money(inMonth)}`;
  if (statusOf(o) === 'partial') {
    return `${part} · אומת ${money(verifiedAmountOf(o))} מתוך ${money(o.amount)}${period} · שולם חלקית`;
  }
  if (!spans) return `${money(o.amount)} · שולם במלואו`;
  return `${part} · הקבלה המלאה ${money(o.amount)}${period} · שולם במלואו`;
}

/* The flag note as the server will judge it: trimmed, control characters
 * flattened, a formula lead-in dropped. '' when unusable. → { note, error }. */
function flagNoteCheck(raw) {
  const full = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+@-]+/, '').trim();
  if (full.length < FLAG_NOTE_MIN || full.length > FLAG_NOTE_MAX) {
    return { note: '', error: 'בסימון «בעיה» חובה לפרט (2 עד 300 תווים)' };
  }
  return { note: full, error: '' };
}

const API = {
  CONFIRM_STATUSES,
  CONTROL_STATUSES,
  STATUS_LABELS,
  DECISION_OPTIONS,
  FLAG_NOTE_MIN,
  FLAG_NOTE_MAX,
  CONTROL_NOTE_MAX,
  verifiedAmountOf,
  openAmountOf,
  openDebt,
  partialAmountCheck,
  controlNoteCheck,
  isIsoDay,
  isMonthKey,
  receiptWindow,
  allocateToMonth,
  monthsOfWindow,
  verifiedForMonth,
  verifiedMonths,
  receiptsByStatus,
  summaryCards,
  flagNoteCheck,
  sumOf,
  monthNameHe,
  dayMonthHe,
  confirmedMonthLine,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.BillingControlRules = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
