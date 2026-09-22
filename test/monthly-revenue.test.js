/* Tests for the הכנסות חודשיות (monthly revenue) screen in public/app.js.
 *
 * "How much revenue belongs to month X", as opposed to "how much cash arrived
 * in month X". Four layers:
 *
 *   1. The ALLOCATION: coverage windows split day by day across month
 *      boundaries, RECEIVED vs EXPECTED partitioning a month without overlap
 *      or gap, credits as a negative, NET, the ex-VAT basis, the per-house
 *      breakdown, and BillingOverrides-awareness.
 *
 *   2. CROSS-APP PARITY with ezone-outpatient PR #109: the same window rule,
 *      the same four figures, the same never-blend rule, the same ÷1.18 and
 *      the same per-row ex-VAT rounding. The two apps' figures are meant to be
 *      added into a network total, so a divergence here makes that total
 *      silently wrong. The worked example from #109 is asserted numerically.
 *
 *   3. THE NO-FORK GUARD: each shared coverage-window primitive is declared
 *      EXACTLY ONCE in app.js, so the rule cannot fork between the credits
 *      ledger and this screen — and the duplicate monthKey declaration this PR
 *      removed cannot come back.
 *
 *   4. SCOPE + SECURITY guards (PR #124 parity): no new endpoint, server.js
 *      untouched, nothing writes, everything interpolated is escaped, and the
 *      daily גבייה view is not modified.
 *
 * Same vm-sandbox approach as dashboard-revenue-exvat.test.js: app.js is a
 * browser global script, so we read the source, append an epilogue exposing
 * the pure functions, and evaluate it with browser globals stubbed. TZ is
 * pinned to Asia/Jerusalem so the DST cases mean what they say.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

const VAT_RATE = 1.18;   // must match the constant in public/app.js

// --- harness ---------------------------------------------------------------

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      buildMonthlyRevenue, revenueAllocate, revenueMonthBounds, revenueExVat,
      revenueOverlapDays, revenueMonthLabel, revenueShiftMonth, isMonthKey,
      projectedCycleDueDates, patientBillingAnchorISO, creditRefundSpan,
      revenueBreakdownByHouse, isBillablePatient, REVENUE_NO_HOUSE,
      paymentCoverage, patientKey, paymentId, monthKey, isoDate, exVat,
      roundMoney, isoFromLocalDate, VAT_RATE,
      // The גבייה row's month split — the third consumer of the allocation.
      splitByMonth, paymentMonthSplit,
      // The credits ledger, so the no-fork guard can prove both consumers
      // really do read the same window off the same row.
      suggestCredits,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

/* Values built inside the vm carry the VM's Array/Object prototypes, so
 * deepStrictEqual fails its prototype check even when the contents match.
 * Round-trip through JSON to get host-realm plainness — the same fix
 * meetings-tab-shell.test.js already uses. */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** Extract one `function NAME(...) { ... }` body out of a source string. */
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// --- fixtures --------------------------------------------------------------

function patient(over) {
  return Object.assign({
    id: 'p1', houseId: 'arfoni', name: 'דנה כהן',
    date: '2025-06-20',            // entry date — the billing-cycle anchor
    pay: 3000,                     // VAT-inclusive monthly payment
    status: 'active', exitDate: '',
  }, over || {});
}
const KEY = app.patientKey(patient());

function payment(over) {
  const dueDate = (over && over.dueDate) || '2026-01-20';
  return Object.assign({
    id: 'pay::' + KEY + '::' + dueDate,
    patientId: KEY, patientName: 'דנה כהן', houseId: 'arfoni',
    dueDate, amount: 3000, amountPaid: 0, status: 'unpaid', balance: 3000,
  }, over || {});
}
function credit(over) {
  return Object.assign({
    id: 'credit::' + KEY + '::2026-01::1',
    patientId: KEY, patientKey: KEY, patientName: 'דנה כהן', houseId: 'arfoni',
    creditType: 'days_unused', allocationMonth: '2026-01',
    calculatedAmount: 1000, amount: 1000, status: 'pending', basis: {},
  }, over || {});
}
/** Build a month with everything defaulted, so each test states only its point.
 *
 * `recordsFrom` is pinned well before these fixtures on purpose. This suite is
 * about the ALLOCATION — which day belongs to which month — and its January
 * 2026 fixtures predate the records cutoff this app now ships
 * (RECORDS_COMPLETE_FROM = '2026-07-01'), which would route every projected
 * cycle here into the לפני תחילת הרישום bucket and test nothing about the
 * arithmetic. The cutoff has its own suite, test/stay-window-records-cutoff.test.js,
 * which exercises the real default AND pins that nothing in the app passes an
 * override — so production can only ever read the constant. */
function build(over) {
  return app.buildMonthlyRevenue(Object.assign({
    month: '2026-01', patients: [], payments: [], credits: [], overrides: [],
    today: '2026-01-15', recordsFrom: '2025-01-01',
  }, over || {}));
}

/* ================= A. the allocation primitive ================= */

test('A: revenueMonthBounds knows month lengths, including a leap February', () => {
  assert.equal(app.revenueMonthBounds('2026-01').days, 31);
  assert.equal(app.revenueMonthBounds('2026-02').days, 28);
  assert.equal(app.revenueMonthBounds('2024-02').days, 29, 'leap year');
  assert.equal(app.revenueMonthBounds('2026-04').days, 30);
  assert.equal(app.revenueMonthBounds('2026-02').startISO, '2026-02-01');
  assert.equal(app.revenueMonthBounds('2026-02').endISO, '2026-02-28');
  // A month key that is not one is refused, never guessed at.
  assert.equal(app.revenueMonthBounds('2026-13'), null);
  assert.equal(app.revenueMonthBounds('2026-1'), null);
  assert.equal(app.revenueMonthBounds(''), null);
  assert.equal(build({ month: 'nonsense' }), null);
  assert.equal(app.buildMonthlyRevenue(), null);
  assert.equal(app.buildMonthlyRevenue({}), null);
});

test('A: revenueAllocate splits a straddling window by DAY COUNT; the halves sum to the whole', () => {
  // 20 Jan → 19 Feb is 31 days: 12 in January, 19 in February.
  const win = app.paymentCoverage({ dueDate: '2026-01-20' });
  const jan = app.revenueAllocate(3000, win, app.revenueMonthBounds('2026-01'));
  const feb = app.revenueAllocate(3000, win, app.revenueMonthBounds('2026-02'));
  assert.equal(jan.daysInMonth, 12);
  assert.equal(feb.daysInMonth, 19);
  assert.equal(jan.windowDays, 31);
  assert.equal(jan.amount, 1161.29);           // 12/31 × 3000
  assert.equal(feb.amount, 1838.71);           // 19/31 × 3000
  assert.equal(Math.round(jan.amount + feb.amount), 3000, 'nothing lost between months');
  // A month the window never reaches gets a zero slice, not null.
  const mar = app.revenueAllocate(3000, win, app.revenueMonthBounds('2026-03'));
  assert.equal(mar.amount, 0);
  assert.equal(mar.daysInMonth, 0);
});

test('A: effectiveEnd truncates the window WITHOUT raising the daily rate', () => {
  // Shortening the denominator would charge the same money for fewer days.
  const win = app.paymentCoverage({ dueDate: '2026-01-20' });
  const bounds = app.revenueMonthBounds('2026-01');
  const clipped = app.revenueAllocate(3100, win, bounds, new Date(2026, 0, 25));
  assert.equal(clipped.daysInMonth, 6, '20–25 January inclusive');
  assert.equal(clipped.windowDays, 31, 'the denominator stays the full cycle');
  assert.equal(clipped.amount, 600, '6/31 × 3100 — the daily rate is unchanged');
  // An effectiveEnd before the window even starts yields nothing.
  const gone = app.revenueAllocate(3100, win, bounds, new Date(2026, 0, 1));
  assert.equal(gone.amount, 0);
  assert.equal(gone.windowDays, 31);
});

/* ================= B. RECEIVED — by window, not by month key ============== */

test('B: a payment covering 20 Jan – 19 Feb contributes to BOTH months, split by days', () => {
  const p = payment({ dueDate: '2026-01-20', amountPaid: 3000, status: 'paid' });
  const jan = build({ patients: [patient()], payments: [p] });
  const feb = build({ month: '2026-02', patients: [patient()], payments: [p] });
  assert.equal(jan.received.inclVat, 1161.29);
  assert.equal(feb.received.inclVat, 1838.71);
  // The drill-down shows the fraction, so the arithmetic is inspectable.
  assert.equal(jan.received.rows[0].daysInMonth, 12);
  assert.equal(jan.received.rows[0].windowDays, 31);
  assert.equal(feb.received.rows[0].daysInMonth, 19);
});

test('B: the dueDate MONTH KEY never decides — most of a late-month cycle lands next month', () => {
  // monthKey(dueDate) would post all ₪3,000 into January, which is exactly the
  // error the גבייה tab's סיכום חודשי panel makes.
  const p = payment({ dueDate: '2026-01-20', amountPaid: 3000, status: 'paid' });
  assert.equal(app.monthKey(p.dueDate), '2026-01', 'the month key says January');
  const feb = build({ month: '2026-02', patients: [patient()], payments: [p] });
  assert.ok(feb.received.inclVat > 1800, 'but most of the money belongs to February');
});

test('B: a window across each DST switch counts exact days — no drift', () => {
  // Israel springs forward in late March and falls back in late October.
  // Math.round on the day span absorbs the ±1h either way.
  const spring = payment({ dueDate: '2026-03-20', amountPaid: 3100, status: 'paid' });
  assert.equal(build({ month: '2026-03', patients: [patient()], payments: [spring] })
    .received.rows[0].daysInMonth, 12, '20–31 March');
  assert.equal(build({ month: '2026-04', patients: [patient()], payments: [spring] })
    .received.rows[0].daysInMonth, 19, '1–19 April');
  const autumn = payment({ dueDate: '2026-10-20', amountPaid: 3100, status: 'paid' });
  assert.equal(build({ month: '2026-10', patients: [patient()], payments: [autumn] })
    .received.rows[0].daysInMonth, 12, '20–31 October');
  assert.equal(build({ month: '2026-11', patients: [patient()], payments: [autumn] })
    .received.rows[0].daysInMonth, 19, '1–19 November');
});

test('B: a payment whose patient is gone still counts, bucketed not dropped', () => {
  const orphan = payment({ patientId: 'vanished::x::y', dueDate: '2026-01-01', amountPaid: 900, status: 'paid', houseId: '' });
  const r = build({ patients: [], payments: [orphan] });
  assert.equal(r.received.inclVat, 900, 'money is money even when the patient row is gone');
  assert.equal(app.REVENUE_NO_HOUSE, 'ללא בית');
  assert.equal(r.byHouse[0].house, 'ללא בית');
  assert.notEqual(r.byHouse[0].house, '', 'an unlabelled breakdown row reads as a rendering bug');
});

/* ================= C. EXPECTED, and never double counting ================= */

test('C: an active patient with no payment row projects the cycles covering the month', () => {
  // A patient whose entry day is the 20th has TWO cycles touching January: the
  // December one (covering 1–19 Jan) and the January one (20–31). Together they
  // are exactly one month of money — the point of splitting by window.
  const r = build({ patients: [patient()], today: '2025-12-01' });
  assert.equal(r.received.inclVat, 0, 'no cash yet');
  assert.equal(r.expected.projected.count, 2);
  const byDue = {};
  r.expected.rows.forEach((x) => { byDue[x.dueDate] = x; });
  assert.deepEqual(plain(Object.keys(byDue).sort()), ['2025-12-20', '2026-01-20']);
  assert.equal(byDue['2026-01-20'].amountInMonth, 1161.29, '12 of its 31 window days are in January');
  assert.equal(byDue['2025-12-20'].amountInMonth, 1838.71, '19 of its 31 window days are in January');
  assert.equal(r.expected.inclVat, 3000, 'one month of money, counted once');
});

test('C: RECEIVED and EXPECTED PARTITION a partly-paid cycle — no overlap, no gap', () => {
  // December is settled in full, so January isolates the January cycle:
  // ₪1,200 of its ₪3,000 is in hand.
  const dec = payment({ dueDate: '2025-12-20', amountPaid: 3000, status: 'paid' });
  const jan = payment({ dueDate: '2026-01-20', amountPaid: 1200, status: 'partial', balance: 1800 });
  const r = build({ patients: [patient()], payments: [dec, jan] });
  const janRecv = r.received.rows.filter((x) => x.dueDate === '2026-01-20');
  assert.equal(janRecv.length, 1);
  assert.equal(janRecv[0].amountInMonth, 464.52);              // 12/31 × 1200
  assert.equal(r.expected.billedUnpaid.inclVat, 696.77);       // 12/31 × 1800
  assert.equal(
    Math.round(janRecv[0].amountInMonth + r.expected.inclVat), 1161,
    'paid part + shortfall = the full cycle share, counted once'
  );
  assert.equal(r.expected.projected.count, 0, 'the cycle is billed, so NOT also projected');
});

test('C: a cycle that already has a payment row is never ALSO projected', () => {
  // Both cycles touching January are paid. Without the skip each would be
  // counted twice — once as cash, once as forecast — and January would read as
  // ₪6,000 of revenue on ₪3,000 of money.
  const dec = payment({ dueDate: '2025-12-20', amountPaid: 3000, status: 'paid' });
  const jan = payment({ dueDate: '2026-01-20', amountPaid: 3000, status: 'paid' });
  const r = build({ patients: [patient()], payments: [dec, jan] });
  assert.equal(r.expected.inclVat, 0, 'fully paid leaves nothing expected');
  assert.equal(r.expected.rows.length, 0);
  assert.equal(r.received.inclVat, 3000, 'January is exactly one month of money');
  assert.notEqual(r.received.inclVat, 6000, 'and emphatically not double counted');
});

test('C: each DAY is either a paid coverage day or a scheduled-unbilled one, never both', () => {
  // December paid, January unrecorded. Days 1–19 belong to the paid December
  // window; days 20–31 to the unbilled January cycle. Exactly 31 days, once.
  const dec = payment({ dueDate: '2025-12-20', amountPaid: 3000, status: 'paid' });
  const r = build({ patients: [patient()], payments: [dec], today: '2026-01-25' });
  assert.equal(r.received.rows.length, 1);
  assert.equal(r.received.rows[0].daysInMonth, 19, 'paid days: 1–19 January');
  assert.equal(r.expected.rows.length, 1);
  assert.equal(r.expected.rows[0].daysInMonth, 12, 'unbilled days: 20–31 January');
  assert.equal(
    r.received.rows[0].daysInMonth + r.expected.rows[0].daysInMonth, 31,
    'every day of January is accounted for exactly once'
  );
});

test('C: a cycle whose date has PASSED with no payment row is unbilled_past, not a forecast', () => {
  // Same money, very different confidence — usually a recording gap. It stays
  // inside EXPECTED (the days are genuinely owed) but is named apart so the UI
  // can flag it instead of passing it off as future income.
  const late = build({ patients: [patient()], today: '2026-01-25' });
  assert.equal(late.expected.unbilledPast.count, 2, 'both January cycles are in the past');
  assert.equal(late.expected.projected.count, 0);
  assert.deepEqual(plain(late.expected.rows.map((x) => x.kind)), ['unbilled_past', 'unbilled_past']);
  // On the 5th the January cycle has not come round yet: an ordinary forecast,
  // while the December one is already a gap.
  const early = build({ patients: [patient()], today: '2026-01-05' });
  assert.equal(early.expected.projected.count, 1, 'the 20 Jan cycle is still ahead');
  assert.equal(early.expected.unbilledPast.count, 1, 'the 20 Dec cycle passed unrecorded');
  assert.equal(early.expected.inclVat, late.expected.inclVat, 'the money is the same either way');
});

test('C: released patients project nothing', () => {
  assert.equal(app.isBillablePatient(patient()), true);
  assert.equal(app.isBillablePatient(patient({ status: 'released' })), false);
  const r = build({ patients: [patient({ status: 'released' })], today: '2025-12-01' });
  assert.equal(r.expected.inclVat, 0, 'a released patient is not billed');
  // An active one in the same shape does project, so the guard above is real.
  assert.ok(build({ patients: [patient()], today: '2025-12-01' }).expected.inclVat > 0);
});

test('C: projection respects the stay — entry date, exit date, and a mid-cycle discharge', () => {
  const late = build({ patients: [patient({ date: '2026-02-01' })], today: '2026-01-05' });
  assert.equal(late.expected.inclVat, 0, 'not billed for months before they arrived');

  // Exit on 10 January. The 20 Jan cycle starts after they have gone, so it is
  // dropped outright. The 20 Dec cycle straddles the exit: days 1–10 January
  // were earned, days 11–19 were not.
  const gone = build({ patients: [patient({ exitDate: '2026-01-10' })], today: '2025-12-01' });
  assert.equal(gone.expected.rows.length, 1);
  assert.equal(gone.expected.rows[0].dueDate, '2025-12-20');
  assert.equal(gone.expected.rows[0].daysInMonth, 10, 'only up to and including the exit day');
  assert.equal(gone.expected.rows[0].windowDays, 31, 'the denominator stays the full cycle');
  assert.equal(gone.expected.inclVat, 967.74, '10/31 × 3000 — daily rate unchanged by the exit');

  const longGone = build({ patients: [patient({ exitDate: '2025-12-15' })], today: '2025-12-01' });
  assert.equal(longGone.expected.inclVat, 0);
});

test('C: the cycle anchor is the ENTRY day-of-month, clamped in short months', () => {
  // The same anchor patientsDueOn / lastBillingDayOnOrBefore use, so this
  // screen and the גבייה tab agree on when a cycle falls due.
  assert.equal(app.patientBillingAnchorISO(patient({ date: '2025-06-20' })), '2025-06-20');
  const feb = app.revenueMonthBounds('2026-02');
  // Entry day 31 → the February occurrence clamps to the 28th, and is
  // re-clamped from the original entry date rather than walked forward.
  const due = app.projectedCycleDueDates(patient({ date: '2025-01-31' }), feb);
  assert.ok(due.includes('2026-02-28'), 'clamped to the last day of February, got ' + due.join(','));
  const mar = app.projectedCycleDueDates(patient({ date: '2025-01-31' }), app.revenueMonthBounds('2026-03'));
  assert.ok(mar.includes('2026-03-31'), 'and March returns to the 31st, not 28th: ' + mar.join(','));
});

test('C: EXPECTED uses the patient pay, and respects a per-month BillingOverride', () => {
  // A naive p.pay would ignore the override layer the גבייה tab writes, and the
  // forecast would silently disagree with what the app actually bills.
  const dec = payment({ dueDate: '2025-12-20', amountPaid: 3000, status: 'paid' });
  const plain = build({ patients: [patient()], payments: [dec], today: '2026-01-05' });
  assert.equal(plain.expected.inclVat, 1161.29, '12/31 × 3000');

  const overridden = build({
    patients: [patient()], payments: [dec], today: '2026-01-05',
    overrides: [{ id: 'ovr::' + KEY + '::2026-01', patientId: KEY, month: '2026-01', amount: 1000 }],
  });
  assert.equal(overridden.expected.inclVat, 387.1, '12/31 × 1000 — the override wins');
  assert.equal(overridden.expected.rows[0].overridden, true, 'and the row says so, for the UI chip');
  // An override for a DIFFERENT month must not leak into this one.
  const other = build({
    patients: [patient()], payments: [dec], today: '2026-01-05',
    overrides: [{ patientId: KEY, month: '2026-07', amount: 1 }],
  });
  assert.equal(other.expected.inclVat, 1161.29);
  // A zero pay has nothing to forecast, rather than a zero-amount row.
  assert.equal(build({ patients: [patient({ pay: 0 })], today: '2026-01-05' }).expected.rows.length, 0);
});

test('C: an override also drives the billed-unpaid half of EXPECTED', () => {
  const unpaid = payment({ dueDate: '2026-01-20', amount: 3000, amountPaid: 0, status: 'unpaid' });
  const r = build({
    patients: [patient()], payments: [unpaid],
    overrides: [{ patientId: KEY, month: '2026-01', amount: 1000 }],
  });
  const billed = r.expected.rows.filter((x) => x.kind === 'billed_unpaid');
  assert.equal(billed.length, 1);
  assert.equal(billed[0].amountInMonth, 387.1, '12/31 × 1000, not × 3000');
  assert.equal(billed[0].overridden, true);
});

/* ================= D. CREDITS ================= */

test('D: a days_unused credit is split over the days it actually refunds', () => {
  // The refunded tail is creditedFrom..coverageEnd — days BEFORE the exit were
  // used and were never refunded, so they must attract none of it.
  const c = credit({
    amount: 1000,
    basis: { coverageStart: '2026-01-20', coverageEnd: '2026-02-19', creditedFrom: '2026-01-26' },
  });
  const jan = build({ patients: [patient()], credits: [c] });
  const feb = build({ month: '2026-02', patients: [patient()], credits: [c] });
  // 26 Jan–19 Feb is 25 days: 6 in January, 19 in February.
  assert.equal(jan.credits.rows[0].daysInMonth, 6);
  assert.equal(jan.credits.rows[0].windowDays, 25);
  assert.equal(feb.credits.rows[0].daysInMonth, 19);
  assert.equal(Math.round(jan.credits.inclVat + feb.credits.inclVat), 1000);
  assert.equal(jan.credits.rows[0].spanSource, 'coverage_window');
});

test('D: a prepaid_return credit is split over the WHOLE window it returns', () => {
  const c = credit({
    creditType: 'prepaid_return', amount: 3000,
    basis: { coverageStart: '2026-01-20', coverageEnd: '2026-02-19', creditedFrom: '2026-01-20' },
  });
  const jan = build({ patients: [patient()], credits: [c] });
  assert.equal(jan.credits.rows[0].daysInMonth, 12);
  assert.equal(jan.credits.inclVat, 1161.29);
});

test('D: allocationMonth is NOT the allocator — the window overrides it', () => {
  // suggestCredits documents allocationMonth as reporting metadata that never
  // enters the math. A credit keyed to January whose refunded span is entirely
  // in February belongs to February.
  const c = credit({
    allocationMonth: '2026-01', amount: 1000,
    basis: { coverageStart: '2026-01-20', coverageEnd: '2026-02-19', creditedFrom: '2026-02-01' },
  });
  assert.equal(build({ patients: [patient()], credits: [c] }).credits.inclVat, 0, 'January gets none of it');
  assert.equal(build({ month: '2026-02', patients: [patient()], credits: [c] }).credits.inclVat, 1000);
});

test('D: a credit with no usable window falls back to allocationMonth, and SAYS so', () => {
  const c = credit({ creditType: 'other', amount: 750, allocationMonth: '2026-01', basis: {} });
  const jan = build({ patients: [patient()], credits: [c] });
  assert.equal(jan.credits.inclVat, 750);
  assert.equal(jan.credits.rows[0].spanSource, 'allocation_month');
  assert.equal(build({ month: '2026-02', patients: [patient()], credits: [c] }).credits.inclVat, 0);
  // A credit with neither a window nor a usable month is skipped, not crashed on.
  assert.equal(app.creditRefundSpan({ creditType: 'other', allocationMonth: '', basis: {} }), null);
});

test('D: cancelled credits count for nothing; pending and paid both reduce revenue', () => {
  const basis = { coverageStart: '2026-01-01', coverageEnd: '2026-01-31', creditedFrom: '2026-01-01' };
  assert.equal(build({ patients: [patient()], credits: [credit({ status: 'cancelled', basis })] })
    .credits.inclVat, 0, 'a void decision is not money');
  for (const status of ['pending', 'paid']) {
    assert.equal(build({ patients: [patient()], credits: [credit({ status, basis })] })
      .credits.inclVat, 1000, status + ' credits reduce the month');
  }
});

/* ================= E. NET, and the never-blend rule ================= */

test('E: NET = received + expected − credits, and credits pull it DOWN', () => {
  const p = payment({ dueDate: '2026-01-01', amount: 3100, amountPaid: 3100, status: 'paid' });
  const basis = { coverageStart: '2026-01-01', coverageEnd: '2026-01-31', creditedFrom: '2026-01-01' };
  const r = build({ patients: [patient({ date: '2026-01-01' })], payments: [p], credits: [credit({ amount: 600, basis })] });
  assert.equal(r.credits.inclVat, 600);
  assert.equal(r.net.inclVat, app.roundMoney(r.received.inclVat + r.expected.inclVat - r.credits.inclVat));
  const noCredit = build({ patients: [patient({ date: '2026-01-01' })], payments: [p] });
  assert.equal(Math.round(noCredit.net.inclVat - r.net.inclVat), 600, 'the sign is real');
});

test('E: RECEIVED and EXPECTED are never blended — no combined field exists', () => {
  const r = build({ patients: [patient()], payments: [payment({ amountPaid: 500, status: 'partial' })] });
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'received'));
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'expected'));
  const combinedish = Object.keys(r).filter((k) => /^(total|revenue|gross|combined|all)/i.test(k));
  assert.deepEqual(plain(combinedish), [], 'no field invites reading cash and forecast as one number');
  // The two cards read from separate buckets into separate elements…
  const render = fnSource(APP, 'renderMonthlyRevenue');
  assert.match(render, /set\('rev-received', revMoney\(model\.received\.exVat\)\)/);
  assert.match(render, /set\('rev-expected', revMoney\(model\.expected\.exVat\)\)/);
  // …and are coloured apart, so they cannot be skim-read as the same thing.
  assert.match(CSS, /\.card\.stat\.rev-stat-received \.stat-value \{ color: var\(--success\); \}/);
  assert.match(CSS, /\.card\.stat\.rev-stat-expected \.stat-value \{ color: var\(--primary\); \}/);
  // And the screen says so in words, where a reader will actually see it.
  assert.match(INDEX, /רק <b>נטו<\/b> מחבר ביניהם, והוא תחזית/);
});

/* ================= F. VAT + cross-app parity with #109 =================== */

test('F: the divisor is 1.18 and the amounts it divides are stored VAT-inclusive', () => {
  assert.equal(app.VAT_RATE, VAT_RATE);
  assert.match(APP, /const VAT_RATE = 1\.18;/);
  // The premise, as this file states it.
  assert.match(APP, /PRICE_FALLBACKS below are stored VAT-inclusive/);
  assert.equal(app.revenueExVat(1180), 1000);
  assert.equal(app.revenueExVat(0), 0);
});

test('F: the PRINTED figure rounds to whole shekels; the DATA behind it keeps 2dp', () => {
  // Rounding the data instead would drift a drill-down from its own header by
  // up to half a shekel per row. Only revMoney() rounds, and only for display.
  assert.match(fnSource(APP, 'revMoney'), /fmtShekel\(Math\.round\(/);
  const r = build({ patients: [patient()], payments: [payment({ dueDate: '2026-01-20', amountPaid: 3000, status: 'paid' })] });
  assert.equal(r.received.inclVat, 1161.29, 'the stored figure keeps agorot');
  assert.equal(r.received.exVat, 984.14);
  assert.equal(Math.round(r.received.exVat), 984, 'and the card prints the rounded one');
  // Every revenue renderer prints through revMoney, never raw fmtShekel.
  for (const name of ['renderMonthlyRevenue', 'renderRevenueByHouse',
                      'renderRevenueExpectedComposition', 'renderRevenueDetail',
                      'buildRevenueDetailRow']) {
    assert.ok(!/[^v]fmtShekel\(/.test(fnSource(APP, name)),
      name + ' must print through revMoney, not fmtShekel directly');
  }
});

test('F: revenueExVat keeps 2dp, unlike the whole-shekel exVat() it sits beside', () => {
  // A drill-down of whole-shekel rows drifts from a separately-rounded total by
  // up to half a shekel per row. exVat() is left alone (the credits UI depends
  // on it) and this screen uses the precise helper.
  assert.equal(app.exVat(1000), 847, 'the existing helper rounds to whole shekels');
  assert.equal(app.revenueExVat(1000), 847.46, 'the revenue helper keeps agorot');
  assert.notEqual(app.revenueExVat(1000), app.exVat(1000));
});

test('F: every bucket carries BOTH bases, and a drill-down adds up to its own header', () => {
  const ps = [
    payment({ id: 'a', dueDate: '2026-01-03', amount: 1000, amountPaid: 1000, status: 'paid' }),
    payment({ id: 'b', dueDate: '2026-01-07', amount: 777, amountPaid: 777, status: 'paid' }),
    payment({ id: 'c', dueDate: '2026-01-11', amount: 333.33, amountPaid: 333.33, status: 'paid' }),
  ];
  const r = build({ patients: [patient({ date: '2026-06-01' })], payments: ps });
  const rowSum = r.received.rows.reduce((s, x) => s + x.amountInMonthExVat, 0);
  assert.equal(r.received.exVat, app.roundMoney(rowSum), 'rows reconcile with their total');
  assert.ok(r.received.inclVat > r.received.exVat, 'the inclusive basis is kept, not discarded');
  assert.equal(r.vatRate, VAT_RATE);
  for (const b of [r.received, r.expected, r.credits, r.net]) {
    assert.equal(typeof b.exVat, 'number');
    assert.equal(typeof b.inclVat, 'number');
  }
});

test('F: the worked example from ezone-outpatient #109 reproduces EXACTLY here', () => {
  // THE CROSS-APP CONTRACT. #109's e2e asserts January reads ₪2,542 ex-VAT for
  // a ₪3,000 monthly patient billed on the 20th whose December and January
  // cycles are both paid. The same inputs must give the same figure here, or a
  // consolidated network total is silently wrong.
  const dec = payment({ dueDate: '2025-12-20', amountPaid: 3000, status: 'paid' });
  const jan = payment({ dueDate: '2026-01-20', amountPaid: 3000, status: 'paid' });
  const r = build({ patients: [patient()], payments: [dec, jan], today: '2026-01-25' });
  assert.equal(r.received.inclVat, 3000);
  assert.equal(r.received.exVat, 2542.37);
  assert.equal(Math.round(r.received.exVat), 2542, 'the figure #109 prints on screen');
  assert.equal(r.expected.inclVat, 0);
  assert.equal(r.net.exVat, 2542.37);
  // And the same two day-fractions #109's drill-down shows.
  const fracs = r.received.rows.map((x) => `${x.daysInMonth}/${x.windowDays}`).sort();
  assert.deepEqual(plain(fracs), ['12/31', '19/31']);
  // February likewise: 19 days received, the February cycle forecast.
  const feb = build({ month: '2026-02', patients: [patient()], payments: [dec, jan], today: '2026-01-25' });
  assert.equal(feb.received.inclVat, 1838.71);
  assert.equal(feb.expected.inclVat, 964.29, '9/28 × 3000');
  assert.notEqual(feb.received.inclVat, feb.expected.inclVat, 'cash and forecast are distinct figures');
});

test('F: the screen prints ex-VAT, and says so on screen', () => {
  assert.match(INDEX, /כל הסכומים ללא מע/, 'the basis is stated, not left to be guessed');
  const render = fnSource(APP, 'renderMonthlyRevenue');
  for (const field of ['received', 'expected', 'credits', 'net']) {
    assert.ok(render.includes(`model.${field}.exVat`), `the ${field} card reads exVat`);
  }
  assert.ok(!render.includes('.inclVat'), 'the screen never prints the inclusive basis');
});

/* ================= G. the house breakdown ================= */

test('G: the breakdown is by HOUSE, sorted by NET, reconciling with the headline', () => {
  const a = patient({ id: 'p1', name: 'א', houseId: 'arfoni', date: '2026-06-01' });
  const b = patient({ id: 'p2', name: 'ב', houseId: 'ramot', date: '2026-06-01' });
  const r = build({
    patients: [a, b],
    payments: [
      Object.assign(payment({ dueDate: '2026-01-01', amount: 2000, amountPaid: 2000, status: 'paid' }),
        { id: 'x', patientId: app.patientKey(a), houseId: 'arfoni' }),
      Object.assign(payment({ dueDate: '2026-01-01', amount: 5000, amountPaid: 5000, status: 'paid' }),
        { id: 'y', patientId: app.patientKey(b), houseId: 'ramot' }),
    ],
  });
  assert.equal(r.byHouse.length, 2);
  assert.equal(r.byHouse[0].received.inclVat, 5000, 'biggest NET first');
  assert.equal(r.byHouse[1].received.inclVat, 2000);
  const sum = r.byHouse.reduce((s, x) => s + x.received.exVat, 0);
  assert.equal(app.roundMoney(sum), r.received.exVat, 'per-house reconciles with the headline');
  // House ids resolve to the display names the rest of the app uses.
  assert.ok(r.byHouse.every((x) => x.house && x.house !== 'arfoni' && x.house !== 'ramot'),
    'houses are shown by name, got ' + r.byHouse.map((x) => x.house).join(','));
});

test('G: all-zero houses are dropped from the breakdown', () => {
  assert.deepEqual(plain(build({ patients: [patient({ status: 'released' })] }).byHouse), []);
});

/* ================= H. THE NO-FORK GUARD ================= */

test('H: every shared coverage-window primitive is declared EXACTLY ONCE in app.js', () => {
  // THE POINT: app.js is one flat script scope, so two `function foo()`
  // declarations are not two functions — the later silently overwrites the
  // earlier at hoist time. That is exactly how monthKey came to have a dead
  // twin (removed in this PR): the copy that looked authoritative had never
  // run. If the monthly-revenue code ever redefines one of these instead of
  // reusing it, the coverage rule forks between the credits ledger and this
  // screen and the two quietly disagree about which month owns a shekel.
  const shared = [
    'paymentCoverage', 'localDateFromISO', 'isoFromLocalDate', 'diffWholeDays',
    'addMonthsClamped', 'addDays', 'roundMoney', 'monthKey', 'isoDate',
    'applyBillingOverride', 'billingOverrideFor', 'patientKey', 'exVat',
    /* The recorded-coverage-period pieces. paymentCoverage() is now a CHOICE
     * between a recorded period and an inferred one, so the three functions
     * that choice is made of are shared primitives in their own right: a
     * second copy of any of them is a second answer to "what did this
     * payment cover", which is exactly the fork this guard exists to stop. */
    'recordedCoverage', 'inferredCoverage', 'coveragePeriodError',
    'coverageDateISO', 'coverageDiffersFromDefault', 'withDefaultCoverage',
    /* The month-split consumer. The גבייה row prints the payment divided
     * between calendar months; a second copy of splitByMonth — or a
     * hand-rolled day-split living in the renderer — would be a second answer
     * to "which month owns this shekel", printed a centimetre away from the
     * period it claims to explain. Both go through revenueAllocate(), which
     * the next test pins. */
    'splitByMonth', 'paymentMonthSplit', 'coverageSplitHtml', 'coveragePeriodText',
  ];
  for (const name of shared) {
    const hits = APP.match(new RegExp('^function\\s+' + name + '\\s*\\(', 'gm')) || [];
    assert.equal(hits.length, 1, `${name} must be declared exactly once, found ${hits.length}`);
  }
});

test('H: the monthly-revenue code REUSES those primitives rather than shadowing them', () => {
  // It calls the shared window function…
  const build_ = fnSource(APP, 'buildMonthlyRevenue');
  /* …and for a REAL payment row it hands over THE WHOLE ROW. A
   * `{ dueDate }` stub would drop coverageStart/coverageEnd on the floor and
   * silently re-infer the cycle — the row would say one thing and this
   * screen would allocate by another. */
  assert.match(build_, /const win = paymentCoverage\(raw\);/,
    'the payments pass reads the window from the row itself');
  assert.doesNotMatch(build_.slice(0, build_.indexOf('the projected half')),
    /paymentCoverage\(\{ dueDate: dueISO \}\)/,
    'no { dueDate } stub in the pass over stored payment rows');
  /* The PROJECTED pass is the one legitimate stub: a projected cycle has no
   * payment row, so there is nothing recorded to honour. */
  assert.match(build_, /paymentCoverage\(\{ dueDate: dueISO \}\)/,
    'projected cycles still infer, having no row to read');
  assert.match(build_, /applyBillingOverride\(raw, overrides\)/,
    'RECEIVED/EXPECTED read the effective amount, not the raw one');
  // …and its own helpers are named apart, so none can shadow a shared one.
  for (const name of ['revenueAllocate', 'revenueOverlapDays', 'revenueMonthBounds',
                      'revenueExVat', 'buildMonthlyRevenue', 'creditRefundSpan',
                      'projectedCycleDueDates', 'revenueBreakdownByHouse']) {
    const hits = APP.match(new RegExp('^function\\s+' + name + '\\s*\\(', 'gm')) || [];
    assert.equal(hits.length, 1, `${name} must be declared exactly once`);
  }
  /* The THIRD consumer: the month split under a גבייה row divides the money
   * with revenueAllocate() and reads its window with paymentCoverage(), so a
   * row's split cannot drift from what this screen will report for it. */
  const split_ = fnSource(APP, 'splitByMonth');
  assert.match(split_, /revenueAllocate\(total, win, bounds\)/,
    'the split allocates with the ONE allocation primitive');
  assert.match(split_, /revenueMonthBounds\(key\)/);
  assert.match(split_, /revenueShiftMonth\(key, 1\)/);
  assert.match(fnSource(APP, 'paymentMonthSplit'), /paymentCoverage\(payment\)/,
    'and reads the window from the ONE window function');
  /* No hand-rolled day arithmetic anywhere in the split: the moment it starts
   * counting days itself, it is a fork. */
  for (const forked of ['getDate()', 'getMonth()', '86400', '/ 30', '* 30']) {
    assert.ok(!split_.includes(forked), 'splitByMonth must not re-derive days: ' + forked);
  }
  assert.doesNotMatch(fnSource(APP, 'coverageSplitHtml'), /daysInMonth =|windowDays =/,
    'the renderer displays the split, it does not compute one');

  // And it really is the same window the credits ledger uses for credits.
  const mine = app.paymentCoverage({ dueDate: '2026-01-31' });
  assert.equal(app.isoFromLocalDate(mine.end), '2026-02-27',
    'Jan 31 + 1 month clamps to Feb 28, minus a day');
  assert.equal(mine.source, 'inferred', 'a row with no recorded period infers');
  // A RECORDED period overrules the inference — for every consumer at once,
  // because they all come through this one function.
  const rec = app.paymentCoverage({
    dueDate: '2026-01-31', coverageStart: '2026-03-01', coverageEnd: '2026-03-31',
  });
  assert.equal(app.isoFromLocalDate(rec.start), '2026-03-01');
  assert.equal(app.isoFromLocalDate(rec.end), '2026-03-31');
  assert.equal(rec.source, 'recorded');
});

test('H: the credits ledger and the revenue screen read the SAME recorded period', () => {
  /* THE POINT of the whole change: three consumers, one source of truth.
   * A payment whose recorded period sits a month away from its due date must
   * move BOTH the credit window and the revenue allocation, together — if
   * one of them re-inferred, the two would disagree about which month owns
   * the money and neither screen would say so. */
  const p = patient({ name: 'רות', date: '2026-01-20', pay: 3100, houseId: 'ramot' });
  const pay = Object.assign(
    payment({ dueDate: '2026-01-20', amount: 3100, amountPaid: 3100, status: 'paid' }),
    { id: 'p1', patientId: app.patientKey(p), houseId: 'ramot',
      coverageStart: '2026-03-01', coverageEnd: '2026-03-31' });

  // The revenue screen: not a shekel in January, the whole 3,100 in March.
  const jan = build({ month: '2026-01', patients: [p], payments: [pay] });
  assert.equal(jan.received.inclVat, 0, 'January owns none of it');
  const mar = build({ month: '2026-03', patients: [p], payments: [pay] });
  assert.equal(mar.received.inclVat, 3100, 'March owns all of it');
  assert.equal(mar.received.rows[0].coverageStart, '2026-03-01');
  assert.equal(mar.received.rows[0].coverageEnd, '2026-03-31');
  assert.equal(mar.received.rows[0].coverageWindowSource, 'recorded');
  assert.equal(mar.received.rows[0].coverageAdjusted, true);

  // The credits ledger, on the very same row: a discharge on 10 Feb leaves
  // the WHOLE March window unearned — prepaid_return, not a Jan/Feb prorata.
  const credits = app.suggestCredits(p, '2026-02-10', [pay]);
  const pre = credits.find((c) => c.creditType === 'prepaid_return');
  assert.ok(pre, 'the March window is entirely after the exit');
  assert.equal(pre.basis.coverageStart, '2026-03-01');
  assert.equal(pre.basis.coverageEnd, '2026-03-31');
  assert.equal(pre.basis.coverageWindowSource, 'recorded');
});

test('H: a row\'s month split EQUALS this screen\'s allocation, month for month', () => {
  /* The guard above proves the split calls the same functions. This proves
   * the numbers land in the same place — the two are asserted separately on
   * purpose: reuse can be preserved while a wrapper quietly rounds
   * differently, and a figure that matches today can start matching by
   * coincidence tomorrow. */
  const p = patient({ name: 'דנה', date: '2026-09-22', pay: 37000, houseId: 'ramot' });
  const pay = Object.assign(
    payment({ dueDate: '2026-09-22', amount: 37000, amountPaid: 37000, status: 'paid' }),
    { id: 'p1', patientId: app.patientKey(p), houseId: 'ramot' });

  const split = app.paymentMonthSplit(pay, 37000);
  assert.deepEqual(plain(split.months.map((m) => [m.month, m.daysInMonth, m.allocated])),
    [['2026-09', 9, 11100], ['2026-10', 21, 25900]],
    '22 Sep – 21 Oct on ₪37,000: 9 days in September, 21 in October');

  for (const m of split.months) {
    const model = build({ month: m.month, patients: [p], payments: [pay], today: '2026-10-25' });
    const row = model.received.rows.find((r) => r.paymentId === 'p1');
    assert.ok(row, 'this screen allocates the payment to ' + m.month);
    assert.equal(m.allocated, row.amountInMonth, m.month + ': same shekels');
    assert.equal(m.daysInMonth, row.daysInMonth, m.month + ': same days');
    assert.equal(m.windowDays, row.windowDays, m.month + ': same denominator');
  }
  // The displayed figures still add up to the payment exactly.
  assert.equal(split.months.reduce((t, m) => t + m.amount, 0), 37000);
});

test('H: the dead monthKey twin is gone, and its removal is explained in place', () => {
  assert.match(APP, /function monthKey\(iso\)\s+\{ return String\(isoDate\(iso\)\)\.slice\(0, 7\); \}/,
    'the surviving monthKey is the isoDate-routed one that was always in force');
  assert.doesNotMatch(APP, /\/\/ "YYYY-MM" extracted from an ISO date string\./,
    'the dead twin body is gone');
  assert.match(APP, /monthKey lives ONCE/, 'and a note explains why, where the twin was');
  // Behaviour is unchanged: it still routes through isoDate, so a full
  // timestamp reads on its LOCAL day rather than a UTC-sliced one.
  assert.equal(app.monthKey('2026-06-10'), '2026-06');
  assert.equal(app.monthKey(''), '');
});

/* ================= I. the daily גבייה view is untouched ================= */

test('I: the daily גבייה screen is added ALONGSIDE, not modified', () => {
  assert.match(INDEX, /<button class="tab" data-screen="billing">גבייה<\/button>/);
  assert.match(INDEX, /<button class="tab" data-screen="revenue">הכנסות חודשיות<\/button>/);
  assert.match(INDEX, /<section id="screen-billing" class="screen hidden">/);
  assert.match(INDEX, /<section id="screen-revenue" class="screen hidden">/);
  for (const id of ['billing-date', 'billing-search', 'billing-due-list', 'billing-open-list',
                    'bill-due-count', 'bill-due-total', 'bill-due-collected',
                    'bill-month-collected', 'bill-month-outstanding', 'bill-month-breakdown',
                    'credits-payout-list']) {
    assert.ok(INDEX.includes(`id="${id}"`), `the daily view keeps ${id}`);
  }
  // The daily renderer still does exactly its jobs, and learned nothing here.
  const rb = fnSource(APP, 'renderBilling');
  assert.match(rb, /renderBillingDueList\(due, selected, dueAll\.length\);/);
  assert.match(rb, /renderBillingOpenList\(selected\);/);
  assert.match(rb, /renderBillingMonthlySummary\(selected\);/);
  assert.ok(!/renderMonthlyRevenue|revenueMonth/.test(rb), 'the daily view knows nothing of the monthly one');
  // And the monthly renderer never reaches back into it.
  const rr = fnSource(APP, 'renderMonthlyRevenue');
  assert.ok(!/renderBilling|state\.billingDate|state\.billingSearch/.test(rr));
  // Separate state, so switching months here cannot disturb the daily date.
  assert.match(APP, /revenueMonth: '',/);
  assert.match(APP, /billingDate: '',/);
  // The סיכום חודשי panel keeps its own (month-key) semantics — deliberately
  // not "fixed", so nothing that reads it today changes underfoot.
  assert.match(fnSource(APP, 'renderBillingMonthlySummary'), /monthKey\(p\.dueDate\) === mk/);
});

test('I: the new screen is registered in the router and has a matching section', () => {
  assert.match(APP, /'billing', 'revenue', 'reconnect'/, 'SCREENS carries it, after billing');
  assert.match(APP, /renderMonthlyRevenue\(\);/);
  // The tab needs no bespoke click handler: initTabs wires every .tabs .tab
  // through one loop, and the router toggles screen-<id> for each SCREENS
  // entry — so the section id must match the screen id exactly or the toggle
  // throws on a missing element.
  assert.match(APP, /document\.querySelectorAll\('\.tabs \.tab'\)\.forEach\(btn => \{/);
  assert.match(APP, /document\.getElementById\('screen-' \+ s\)\.classList\.toggle/);
  assert.ok(INDEX.includes('id="screen-revenue"'), 'the router will look up screen-revenue');
  assert.match(APP, /revenueMonthEl\.onchange/);
  assert.match(APP, /revenueSearchEl\.addEventListener\('input'/);
  // renderAll paints it like every other screen.
  assert.match(fnSource(APP, 'renderAll'), /renderMonthlyRevenue\(\);/);
});

/* ================= J. security (PR #124 parity) ================= */

test('J: no new endpoint — server.js and Code.gs are untouched by this screen', () => {
  assert.ok(!/revenue/i.test(SERVER), 'server.js must stay unchanged by the monthly screen');
  assert.ok(!/monthlyRevenue|buildMonthlyRevenue/.test(GS), 'no new Apps Script action');
  // The proxy gate every read still rides is intact.
  assert.match(SERVER, /\/api\/sheets/);
});

test('J: the screen is READ-ONLY — it fetches nothing and writes nothing', () => {
  for (const name of ['buildMonthlyRevenue', 'renderMonthlyRevenue', 'renderRevenueByHouse',
                      'renderRevenueExpectedComposition', 'renderRevenueDetail',
                      'buildRevenueDetailRow']) {
    const body = fnSource(APP, name);
    for (const forbidden of ['apiPost', 'apiGet', 'fetch(', 'saveAll', 'savePayment',
                             'saveBillingOverride', 'saveCredit']) {
      assert.ok(!body.includes(forbidden), `${name} must not ${forbidden}`);
    }
  }
  // Nothing is gated on edit mode, because nothing can edit.
  assert.ok(!fnSource(APP, 'buildRevenueDetailRow').includes("state.mode"));
});

test('J: the allocation is PURE — no DOM, no state, no network', () => {
  const pure = ['buildMonthlyRevenue', 'revenueAllocate', 'revenueMonthBounds',
                'revenueOverlapDays', 'projectedCycleDueDates', 'creditRefundSpan',
                'revenueBreakdownByHouse', 'revenueBucket', 'revenueExVat'];
  for (const name of pure) {
    const body = fnSource(APP, name)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    for (const forbidden of [/\bdocument\b/, /\bstate\s*\./, /\bfetch\s*\(/, /\blocalStorage\b/]) {
      assert.doesNotMatch(body, forbidden, `${name} must not touch ${forbidden}`);
    }
  }
  // Same inputs, same outputs — `today` is injected so a report reruns identically.
  const args = { month: '2026-01', patients: [patient()], payments: [], credits: [], overrides: [], today: '2026-01-05' };
  assert.deepEqual(plain(app.buildMonthlyRevenue(args)), plain(app.buildMonthlyRevenue(args)));
});

test('J: every interpolated value is escaped — no sheet data reaches innerHTML raw', () => {
  const row = fnSource(APP, 'buildRevenueDetailRow');
  for (const field of ["row.patientName || '—'", "row.house || ''", 'windowText', 'daysText', 'typeLabel']) {
    assert.ok(row.includes(`escapeHtml(${field})`), 'unescaped interpolation of ' + field);
  }
  for (const name of ['renderRevenueExpectedComposition', 'renderRevenueByHouse']) {
    const body = fnSource(APP, name);
    const interps = body.match(/\$\{([^}]+)\}/g) || [];
    for (const piece of interps) {
      assert.ok(
        /escapeHtml|fmtShekel|\.count|\.exVat|p\.warn|\?/.test(piece),
        `${name} interpolates something unescaped: ${piece}`
      );
    }
  }
  const detail = fnSource(APP, 'renderRevenueDetail');
  assert.ok(detail.includes('escapeHtml(g.title)'), 'group headings are escaped too');
  assert.match(APP, /function escapeHtml\(s\)/);
});

test('J: unreadable rows are skipped, never fatal', () => {
  const r = build({
    patients: [null, patient(), { id: 'x' }],
    payments: [null, {}, payment({ dueDate: '' }), payment({ dueDate: 'nope' })],
    credits: [null, {}],
    overrides: [null, {}],
  });
  assert.equal(r.received.inclVat, 0);
  assert.equal(r.credits.inclVat, 0);
  assert.ok(Array.isArray(r.byHouse));
});
