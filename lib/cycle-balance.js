/* The cycle balance — ONE rule for גבייה, בקרת גבייה and «מטופלים».
 * CHANGELOG-cycle-balance.md (Sandra, 11/10/2026).
 *
 * ONE definition, two runtimes, like lib/funder-grace.js: the page loads it
 * at /cycle-balance.js (window.CycleBalance); apps-script/Code.gs holds the
 * same rule as cycleBalanceState_ (Apps Script cannot require a file). The
 * parity test test/cycle-balance.test.js runs both over a grid and fails on
 * any difference. No data, no I/O, no clock.
 *
 * THE RULE.
 *   - A cycle is one coverage period: entry date → +1 month (cycleWindow).
 *     Its price is owed ONCE for the whole period.
 *   - Splitting it across calendar months (September 9 days + October 21
 *     days) is revenue allocation / display ONLY. It never creates a balance:
 *     the balance is the cycle's expected amount − ALL money attached to the
 *     cycle, whatever calendar month the money or a slice of it falls in.
 *   - The expected amount (cycleExpected):
 *       1. a cycle already SETTLED (stored status «שולם», or paid ≥ stamped)
 *          is history — it stays settled at what was billed, balance 0;
 *       2. an OPEN cycle (nothing yet, or less than stamped) owes, in order:
 *          the per-month override (Sandra's explicit price for that month),
 *          else the patient's AGREED price (Patients `pay`, «תשלום כולל מעמ»),
 *          else the stamped amount.
 *     Why 2: the cycle row freezes the price the moment it is created. Vered
 *     reports the money and THEN corrects the agreed price on the patient
 *     (אליהו חן: report 11:21, pay 33,000 → 30,000 at 11:23; שחר חיון 35,000 →
 *     32,000; נועם שני 30,000 → 28,000). The correction never reached the
 *     frozen row, so a full payment read «שולם חלקית» with a phantom balance.
 *   - Every amount is VAT-inclusive (the Patients `pay` column, every
 *     Payments amount) — no VAT conversion happens here.
 *   - A void cycle owes nothing.
 *   - UNDER-STAMPED (Sandra, 11/10/2026): a settled cycle is never reopened —
 *     but when its stamped amount is LOWER than what the override / agreed
 *     price says it should have been, cycleState adds `underStamped: true`,
 *     `priceExpected` and `gap = priceExpected − stamped`. Status stays
 *     «שולם», balance 0; the flag only feeds an exception row in בקרת גבייה
 *     for a person to decide. Never auto-changed, never hidden.
 *   - DISCOUNT (CHANGELOG-ortal-billing-discounts.md, 22/10/2026): an OPEN
 *     cycle owes base − discountAmount, never below 0 (base = the override /
 *     agreed / stamped amount above). A settled cycle is history — the
 *     discount plays no part. A discount is not debt and not revenue: no
 *     money moves; a cycle it fully covers reads settled (balance 0,
 *     «שולם»). The under-stamped price is net of the discount. */
(function (root) {
'use strict';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function round2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

/* A finite number ≥ 0, else null ('' / null / junk / negative → null). */
function money(v) {
  if (v === '' || v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? round2(x) : null;
}

function isIso(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  return d.toISOString().slice(0, 10) === s;
}

/* The coverage window of a cycle: the recorded one when it is a valid pair,
 * else start → (start + 1 month) − 1 day (month-end clamped: 31/01 → 27/02
 * in a non-leap year, the day before 28/02). → { start, end } or null. */
function cycleWindow(startISO, coverageStart, coverageEnd) {
  if (isIso(coverageStart) && isIso(coverageEnd) && coverageEnd >= coverageStart) {
    return { start: coverageStart, end: coverageEnd };
  }
  if (!isIso(startISO)) return null;
  const y = +startISO.slice(0, 4), m = +startISO.slice(5, 7), d = +startISO.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // days in the next month
  const next = new Date(Date.UTC(y, m, Math.min(d, last)));
  next.setUTCDate(next.getUTCDate() - 1);
  return { start: startISO, end: next.toISOString().slice(0, 10) };
}

/* Is a payment's anchor day inside the cycle's window? The anchor is the
 * payment's coverageStart, else its dueDate — NEVER the received date's
 * calendar month. Pure. */
function paymentInCycle(win, payment) {
  if (!win || !payment) return false;
  const at = isIso(payment.coverageStart) ? payment.coverageStart : (isIso(payment.dueDate) ? payment.dueDate : '');
  return !!at && at >= win.start && at <= win.end;
}

/* Settled = the stored status says «שולם», or the money covers the stamp. */
function isSettled(status, stamped, paid) {
  if (String(status || '').trim().toLowerCase() === 'paid') return true;
  return stamped !== null && stamped > 0 && paid >= stamped;
}

/* The amount a cycle owes.
 *   o.stampedAmount   the cycle row's `amount` (frozen at creation)
 *   o.amountPaid      everything attached to the cycle (any calendar month)
 *   o.overrideAmount  the per-month override, or null / ''
 *   o.agreedPrice     the patient's agreed price (Patients `pay`), or null
 *   o.status          the stored status ('void' owes nothing)
 * → { amount, source: 'void' | 'settled' | 'override' | 'agreed' | 'stamped' } */
function cycleExpected(o) {
  const x = o || {};
  if (String(x.status || '').trim().toLowerCase() === 'void') return { amount: 0, source: 'void' };
  const stamped = money(x.stampedAmount);
  const paid = money(x.amountPaid) || 0;
  if (isSettled(x.status, stamped, paid)) return { amount: stamped || 0, source: 'settled' };
  const override = money(x.overrideAmount);
  let base;
  if (override !== null) base = { amount: override, source: 'override' };
  else {
    const agreed = money(x.agreedPrice);
    base = agreed !== null && agreed > 0 ? { amount: agreed, source: 'agreed' } : { amount: stamped || 0, source: 'stamped' };
  }
  const disc = money(x.discountAmount) || 0;
  if (disc > 0) {
    return { amount: Math.max(0, round2(base.amount - disc)), source: base.source, discount: round2(Math.min(disc, base.amount)) };
  }
  return base;
}

/* What the price says the cycle owes, ignoring the stamp: the override,
 * else the agreed price (> 0), else null. Pure. */
function priceOf(x) {
  const disc = money(x.discountAmount) || 0;
  const net = (n) => Math.max(0, round2(n - disc));
  const override = money(x.overrideAmount);
  if (override !== null) return net(override);
  const agreed = money(x.agreedPrice);
  return agreed !== null && agreed > 0 ? net(agreed) : null;
}

/* expected − paid → { balance, status }. Pure. */
function cycleBalance(expected, amountPaid, isVoid) {
  const exp = round2(expected), paid = round2(amountPaid);
  if (isVoid) return { balance: 0, status: 'void' };
  const balance = Math.max(0, round2(exp - paid));
  const status = paid <= 0 ? 'unpaid' : (paid >= exp ? 'paid' : 'partial');
  return { balance, status };
}

/* The whole answer for one cycle. Same input as cycleExpected.
 * → { expected, source, paid, balance, status } */
function cycleState(o) {
  const x = o || {};
  const isVoid = String(x.status || '').trim().toLowerCase() === 'void';
  const e = cycleExpected(x);
  const paid = money(x.amountPaid) || 0;
  if (e.source === 'settled') {
    const out = { expected: e.amount, source: e.source, paid, balance: 0, status: 'paid' };
    const price = priceOf(x);
    if (price !== null && price > e.amount) {
      out.underStamped = true;
      out.priceExpected = price;
      out.gap = round2(price - e.amount);
    }
    return out;
  }
  const b = cycleBalance(e.amount, paid, isVoid);
  const out = { expected: e.amount, source: e.source, paid, balance: b.balance, status: b.status };
  if (!isVoid && e.discount > 0) {
    out.discount = e.discount;
    // A discount that leaves nothing owed settles the cycle — never debt.
    if (out.balance === 0) out.status = 'paid';
  }
  return out;
}

/* Sum the money of the payments attached to a cycle window (void rows are
 * not money). `payments`: [{ amount | amountPaid, status, coverageStart?,
 * dueDate? }]. Calendar months play no part. → number (2dp). */
function paidInCycle(win, payments) {
  let sum = 0;
  (Array.isArray(payments) ? payments : []).forEach(p => {
    if (!p || String(p.status || '').toLowerCase() === 'void' || !paymentInCycle(win, p)) return;
    const a = p.amountPaid !== undefined && p.amountPaid !== '' && p.amountPaid !== null ? p.amountPaid : p.amount;
    sum = round2(sum + (Number(a) || 0));
  });
  return sum;
}

const API = {
  cycleWindow,
  paymentInCycle,
  paidInCycle,
  cycleExpected,
  cycleBalance,
  cycleState,
};

if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.CycleBalance = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
