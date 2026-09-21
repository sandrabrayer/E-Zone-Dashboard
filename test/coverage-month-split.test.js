/* Tests for the גבייה row's month split + the human date format
 * (CHANGELOG-coverage-month-split.md).
 *
 * Two changes to the תקופת כיסוי cell PR #135 added:
 *
 *  1. DISPLAY FORMAT. The period read as ISO — "2026-09-06 → 2026-10-05". It
 *     now reads the way every other date the app shows a person reads
 *     (15.9.2026), through the SAME formatDate() that תאריך כניסה goes through
 *     on תפוסה. Storage is untouched: bare 'YYYY-MM-DD', text-forced, and the
 *     native date inputs keep their ISO value. The tests below assert that
 *     separation directly, because "display only" is the whole safety claim.
 *
 *  2. THE MONTH SPLIT. A payment is one number but almost never buys one
 *     calendar month. The row now says where the money lands — and it must say
 *     the SAME thing הכנסות חודשיות says, or the feature is worse than
 *     nothing. It does not divide anything itself: every slice comes out of
 *     revenueAllocate(), the same function with the same window and the same
 *     bounds the monthly view calls. The cross-check at the bottom pins a
 *     row's split against buildMonthlyRevenue()'s allocation of the identical
 *     payment, month by month, so a future edit to either cannot move one
 *     without the other. test/monthly-revenue.test.js names coverageMonthSplit
 *     in the no-fork guard's consumer list for the same reason.
 *
 * Exercises the REAL shipped app.js in a vm sandbox — not a reimplementation.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

const VAT_RATE = 1.18;   // must match the constant in public/app.js

// --- harness ---------------------------------------------------------------

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      coverageMonthSplit, coverageMonthKeys, coverageSplitHtml,
      coverageDateText, coverageWindowText,
      paymentCoverage, withDefaultCoverage, coverageDiffersFromDefault,
      revenueAllocate, revenueMonthBounds, revenueMonthLabel, revenueExVat,
      buildMonthlyRevenue, patientKey, monthKey, isoDate, isoFromLocalDate,
      localDateFromISO, formatDate, roundMoney, escapeHtml, VAT_RATE,
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

/* Values built inside the vm carry the VM's Array/Object prototypes, so
 * deepEqual fails its prototype check even when the contents match. Round-trip
 * through JSON for host-realm plainness — the same fix monthly-revenue.test.js
 * already uses. */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** The window a payment covers, straight from the shared primitive. */
function win(startISO, endISO) {
  return app.paymentCoverage({ coverageStart: startISO, coverageEnd: endISO });
}
/** [label, days, amount] per month, the shape the row renders. */
function split(amount, startISO, endISO) {
  return plain(app.coverageMonthSplit(amount, win(startISO, endISO))
    .map(p => [p.label, p.days, p.amount]));
}
const sum = parts => parts.reduce((s, p) => s + p[2], 0);

/* One rendered line per month. Each line opens with the same marker, so
 * splitting on it gives whole lines — slicing on the month NAME would put the
 * NEXT line's opening tag (and its `deferred` class) into the previous chunk. */
function renderedLines(html) {
  return html.split('<span class="cov-split-line').slice(1).map(chunk => ({
    deferred: chunk.startsWith(' deferred'),
    text: chunk,
  }));
}

/* ================= A. THE REPORTED CASE ================= */

test('A: 6 Sep – 5 Oct on ₪29,000 splits 25 / 5 days into 24,167 + 4,833', () => {
  /* The exact example in the brief. 30-day window, 25 of its days in
   * September and 5 in October; the denominator is the WINDOW's length, not
   * either calendar month's. */
  const parts = split(29000, '2026-09-06', '2026-10-05');
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], ['ספטמבר 2026', 25, 24167]);
  assert.deepEqual(parts[1], ['אוקטובר 2026', 5, 4833]);
  assert.equal(sum(parts), 29000, 'the two lines account for the whole payment');
});

test('A: the window itself is the denominator, not the calendar month', () => {
  /* If either month's own length were used, September's slice would be
   * 29000 × 25/30 ≠ 29000 × 25/31 and the two lines would not sum to the
   * payment. Stated explicitly because it is the single easiest thing for a
   * later "simplification" to get wrong. */
  const raw = app.coverageMonthSplit(29000, win('2026-09-06', '2026-10-05'));
  assert.equal(raw[0].windowDays, 30);
  assert.equal(raw[1].windowDays, 30);
  assert.equal(raw[0].days + raw[1].days, 30, 'every day of the window is allocated once');
});

/* ================= B. SHAPES OF WINDOW ================= */

test('B: a period inside ONE month shows that month, with no split', () => {
  /* "No split line pretending there is a division." One part, and it carries
   * the whole amount. */
  const parts = split(5000, '2026-09-01', '2026-09-30');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], ['ספטמבר 2026', 30, 5000]);
});

test('B: a period inside one month that is not a whole month still shows one line', () => {
  const parts = split(4000, '2026-09-08', '2026-09-19');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], ['ספטמבר 2026', 12, 4000]);
});

test('B: a period spanning THREE months shows three lines that sum exactly', () => {
  // 20 Aug – 10 Oct: 12 + 30 + 10 = 52 days.
  const parts = split(10000, '2026-08-20', '2026-10-10');
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => p[0]), ['אוגוסט 2026', 'ספטמבר 2026', 'אוקטובר 2026']);
  assert.deepEqual(parts.map(p => p[1]), [12, 30, 10]);
  assert.equal(parts[1][1], 30, 'a fully-enclosed month contributes all of its days');
  assert.equal(sum(parts), 10000);
});

test('B: month keys are enumerated in order, including across a year boundary', () => {
  assert.deepEqual(plain(app.coverageMonthKeys(win('2026-12-15', '2027-01-14'))),
    ['2026-12', '2027-01']);
  assert.deepEqual(plain(app.coverageMonthKeys(win('2026-09-06', '2026-09-30'))), ['2026-09']);
  assert.deepEqual(plain(app.coverageMonthKeys(win('2026-11-20', '2027-02-05'))),
    ['2026-11', '2026-12', '2027-01', '2027-02']);
  // Nothing usable in, nothing out — never a throw, never a guessed window.
  assert.deepEqual(plain(app.coverageMonthKeys(null)), []);
  assert.deepEqual(plain(app.coverageMonthKeys({})), []);
  assert.deepEqual(plain(app.coverageMonthSplit(1000, null)), []);
});

test('B: a December→January split names both years, so the two lines cannot be confused', () => {
  const parts = split(6200, '2026-12-15', '2027-01-14');
  assert.deepEqual(parts.map(p => p[0]), ['דצמבר 2026', 'ינואר 2027']);
  assert.equal(sum(parts), 6200);
});

/* ================= C. ROUNDING ================= */

test('C: the lines sum to the payment EXACTLY — no ₪1 drift', () => {
  /* The failure this guards: revenueAllocate rounds each slice to 2dp
   * independently, so three slices of 9,666.66… print as 9,667 ×3 = 29,001
   * directly beneath an amount of 29,000. Largest-remainder fixes it. Swept
   * across amounts and window shapes rather than asserted on one lucky case. */
  const windows = [
    ['2026-09-06', '2026-10-05'],
    ['2026-08-20', '2026-10-10'],
    ['2026-01-31', '2026-02-27'],
    ['2026-02-10', '2026-04-09'],
    ['2026-11-20', '2027-02-05'],
    ['2026-09-01', '2026-09-30'],
    ['2026-12-15', '2027-01-14'],
  ];
  const amounts = [29000, 10000, 3000, 3333, 1, 7, 99, 12345, 5555, 100000, 0];
  for (const [s, e] of windows) {
    for (const amount of amounts) {
      const parts = split(amount, s, e);
      if (!parts.length) continue;
      assert.equal(sum(parts), Math.round(amount),
        `${amount} over ${s}→${e} summed to ${sum(parts)}`);
    }
  }
});

test('C: every line is a whole shekel, and the leftover goes to the largest fraction', () => {
  // 3 equal-ish months of 10,000 → 2307.69 / 5769.23 / 1923.08; floors sum to
  // 9,998, so two shekels are owed and land on the two largest fractions.
  const raw = app.coverageMonthSplit(10000, win('2026-08-20', '2026-10-10'));
  assert.ok(raw.every(p => Number.isInteger(p.amount)), 'displayed slices are whole shekels');
  const byFrac = raw
    .map((p, i) => ({ i, frac: p.exact - Math.floor(p.exact), up: p.amount - Math.floor(p.exact) }))
    .sort((a, b) => b.frac - a.frac);
  assert.equal(byFrac[0].up, 1, 'the largest fraction was rounded up');
  assert.equal(byFrac[byFrac.length - 1].up, 0, 'the smallest fraction was not');
  assert.equal(sum(raw.map(p => [p.label, p.days, p.amount])), 10000);
});

test('C: the split is deterministic — the same input never moves a shekel', () => {
  /* A re-render happens on every keystroke in the editor. If the leftover
   * shekel could land on a different month between two identical renders the
   * row would flicker between two answers. Ties break by month order. */
  const once  = split(10000, '2026-08-20', '2026-10-10');
  const twice = split(10000, '2026-08-20', '2026-10-10');
  assert.deepEqual(once, twice);
  // Equal fractions: two months, one day each side of a 2-day window.
  const tied = app.coverageMonthSplit(101, win('2026-09-30', '2026-10-01'));
  assert.deepEqual(plain(tied.map(p => p.amount)), [51, 50],
    'a tie goes to the earlier month, every time');
  assert.equal(tied[0].amount + tied[1].amount, 101);
});

/* ================= D. VAT BASIS ================= */

test('D: the split is VAT-INCLUSIVE, matching the ₪ figure beside it on the row', () => {
  /* The גבייה row shows payment.amount, which is VAT-inclusive. A split shown
   * ex-VAT under an inclusive total would read as a discrepancy on the row
   * that Sandra would have to reconcile in her head. */
  const parts = split(29000, '2026-09-06', '2026-10-05');
  assert.equal(sum(parts), 29000, 'sums to the INCLUSIVE amount, unconverted');
  assert.notEqual(sum(parts), Math.round(29000 / VAT_RATE));
  const src = fnSource(APP, 'coverageMonthSplit');
  assert.doesNotMatch(src, /revenueExVat|VAT_RATE|exVat/,
    'no VAT conversion inside the split — the screen it serves is inclusive');
});

test('D: הכנסות חודשיות shows the SAME slices ex-VAT — one conversion, at the edge', () => {
  const p = app.coverageMonthSplit(29000, win('2026-09-06', '2026-10-05'));
  // The monthly view's own row figure for September is exVat(the inclusive slice).
  assert.equal(app.revenueExVat(p[0].exact), app.roundMoney(24166.67 / VAT_RATE));
});

/* ================= E. THE NO-FORK CROSS-CHECK ================= */

test('E: the row split matches the MONTHLY VIEW allocation for the same payment', () => {
  /* THE POINT of reusing revenueAllocate. Build the identical payment into
   * buildMonthlyRevenue for each month its window touches and assert, month by
   * month, that the monthly view's daysInMonth and its inclusive slice are the
   * ones the row prints. If either side ever re-derives the split, this fails.
   *
   * Compared against `exact` — the un-reconciled 2dp slice — because that is
   * literally revenueAllocate's own output on both sides; the row's whole
   * shekels are a display rounding applied after, covered in section C. */
  const patient = {
    id: 'p1', houseId: 'arfoni', name: 'דנה כהן',
    date: '2025-06-06', pay: 29000, status: 'active', exitDate: '',
  };
  const key = app.patientKey(patient);
  const pay = {
    id: 'pay::' + key + '::2026-09-06',
    patientId: key, patientName: 'דנה כהן', houseId: 'arfoni',
    dueDate: '2026-09-06', amount: 29000, amountPaid: 29000,
    status: 'paid', balance: 0,
    coverageStart: '2026-09-06', coverageEnd: '2026-10-05',
  };

  const rowParts = app.coverageMonthSplit(29000, app.paymentCoverage(pay));
  assert.equal(rowParts.length, 2);

  for (const part of rowParts) {
    const model = app.buildMonthlyRevenue({
      month: part.key, patients: [patient], payments: [pay],
      credits: [], overrides: [], today: '2026-09-15',
    });
    const mrow = model.received.rows.find(r => r.paymentId === pay.id);
    assert.ok(mrow, `הכנסות חודשיות has no row for ${part.key}`);
    assert.equal(mrow.daysInMonth, part.days,
      `${part.key}: monthly view says ${mrow.daysInMonth} days, the row says ${part.days}`);
    assert.equal(mrow.windowDays, part.windowDays, `${part.key}: same denominator`);
    assert.equal(mrow.amountInMonth, part.exact,
      `${part.key}: monthly view allocates ${mrow.amountInMonth}, the row ${part.exact}`);
    // …and the monthly view's ex-VAT figure is that same slice, converted once.
    assert.equal(mrow.amountInMonthExVat, app.revenueExVat(part.exact));
  }
});

test('E: an ADJUSTED period moves the row split exactly as it moves the monthly view', () => {
  /* A recorded period a month away from the due date. Both screens must follow
   * the recorded window — this is the whole reason #135 exists, and the row is
   * now a third consumer that could have re-inferred instead. */
  const patient = {
    id: 'p1', houseId: 'ramot', name: 'רות', date: '2026-01-20',
    pay: 3100, status: 'active', exitDate: '',
  };
  const key = app.patientKey(patient);
  const pay = {
    id: 'pay::' + key + '::2026-01-20',
    patientId: key, patientName: 'רות', houseId: 'ramot',
    dueDate: '2026-01-20', amount: 3100, amountPaid: 3100, status: 'paid', balance: 0,
    coverageStart: '2026-03-01', coverageEnd: '2026-03-31',
  };
  const parts = app.coverageMonthSplit(3100, app.paymentCoverage(pay));
  assert.equal(parts.length, 1, 'the recorded period is one whole month');
  assert.equal(parts[0].key, '2026-03', 'March, not the January due month');
  assert.equal(parts[0].amount, 3100);

  const jan = app.buildMonthlyRevenue({ month: '2026-01', patients: [patient],
    payments: [pay], credits: [], overrides: [], today: '2026-03-15' });
  const mar = app.buildMonthlyRevenue({ month: '2026-03', patients: [patient],
    payments: [pay], credits: [], overrides: [], today: '2026-03-15' });
  assert.equal(jan.received.inclVat, 0, 'January owns none of it — on both screens');
  assert.equal(mar.received.inclVat, 3100, 'March owns all of it — on both screens');
});

test('E: coverageMonthSplit calls revenueAllocate and re-derives nothing', () => {
  const src = fnSource(APP, 'coverageMonthSplit');
  assert.match(src, /revenueAllocate\(amount, win, revenueMonthBounds\(key\)\)/,
    'every slice comes from the shared allocator, with the shared bounds');
  // No hand-rolled day arithmetic: the split must not know how to divide.
  assert.doesNotMatch(src, /diffWholeDays|86400000|getDate\(\)/,
    'no day arithmetic of its own — that lives in revenueAllocate/revenueOverlapDays');
  for (const name of ['coverageMonthSplit', 'coverageMonthKeys', 'coverageSplitHtml',
                      'coverageDateText', 'coverageWindowText']) {
    const hits = APP.match(new RegExp('^function\\s+' + name + '\\s*\\(', 'gm')) || [];
    assert.equal(hits.length, 1, `${name} must be declared exactly once, found ${hits.length}`);
  }
});

/* ================= F. THE DATE FORMAT ================= */

test('F: a coverage date renders like every other date the app shows a person', () => {
  /* he-IL short form — 15.9.2026 — the same string תאריך כניסה prints on
   * תפוסה, because it is the same formatDate() call. */
  assert.equal(app.coverageDateText('2026-09-06'), '6.9.2026');
  assert.equal(app.coverageDateText('2026-10-05'), '5.10.2026');
  assert.equal(app.coverageDateText('2026-09-15'), app.formatDate('2026-09-15'));
  assert.equal(app.coverageWindowText('2026-09-06', '2026-10-05'), '6.9.2026 → 5.10.2026');
  // Local Dates (what the גבייה row has in hand) format identically to the
  // ISO strings (what the drill-down has) — the two call sites cannot drift.
  assert.equal(
    app.coverageWindowText(app.localDateFromISO('2026-09-06'), app.localDateFromISO('2026-10-05')),
    app.coverageWindowText('2026-09-06', '2026-10-05'));
  // Nothing to show stays an em-dash, never 'Invalid Date' or a bare ''.
  assert.equal(app.coverageDateText(''), '—');
  assert.equal(app.coverageDateText(null), '—');
  assert.equal(app.coverageDateText('nonsense'), '—');
});

test('F: it REUSES formatDate rather than defining a second date format', () => {
  const src = fnSource(APP, 'coverageDateText');
  assert.match(src, /formatDate\(/, 'goes through the app-wide formatter');
  assert.doesNotMatch(src, /toLocaleDateString|padStart|getFullYear/,
    'no second formatting implementation');
  const hits = APP.match(/^function\s+formatDate\s*\(/gm) || [];
  assert.equal(hits.length, 1, 'formatDate itself must stay a single definition');
});

test('F: both display sites go through coverageWindowText', () => {
  // The גבייה row…
  assert.match(fnSource(APP, 'buildBillingRow'),
    /coverageWindowText\(cov\.start, cov\.end\)/);
  // …and the הכנסות חודשיות drill-down.
  assert.match(fnSource(APP, 'buildRevenueDetailRow'),
    /coverageWindowText\(row\.coverageStart, row\.coverageEnd\)/);
  // Neither prints a raw ISO pair any more.
  assert.doesNotMatch(fnSource(APP, 'buildRevenueDetailRow'),
    /\$\{row\.coverageStart\} → \$\{row\.coverageEnd\}/);
});

/* ================= G. DISPLAY ONLY ================= */

test('G: STORAGE is untouched — bare ISO in, bare ISO out', () => {
  /* The safety claim of the whole change. The stored pair, the pair
   * withDefaultCoverage stamps, and the value the native inputs carry are all
   * still 'YYYY-MM-DD'; only what a person reads changed. */
  const stamped = app.withDefaultCoverage({ dueDate: '2026-09-06' });
  assert.equal(stamped.coverageStart, '2026-09-06');
  assert.equal(stamped.coverageEnd, '2026-10-05');
  assert.match(stamped.coverageStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(stamped.coverageEnd, /^\d{4}-\d{2}-\d{2}$/);
  // A row that already records a period is returned untouched, unreformatted.
  const kept = app.withDefaultCoverage({
    dueDate: '2026-09-06', coverageStart: '2026-10-01', coverageEnd: '2026-10-31' });
  assert.equal(kept.coverageStart, '2026-10-01');
  assert.equal(kept.coverageEnd, '2026-10-31');
});

test('G: the native date inputs still carry ISO values', () => {
  /* <input type="date"> only accepts YYYY-MM-DD. Formatting the value would
   * blank the control silently — the one way a display change could break
   * editing. */
  const src = fnSource(APP, 'buildBillingRow');
  assert.match(src, /class="bill-cov-start" type="date" value="\$\{escapeHtml\(covStart\)\}"/);
  assert.match(src, /class="bill-cov-end" type="date" value="\$\{escapeHtml\(covEnd\)\}"/);
  assert.match(src, /const covStart = cov \? isoFromLocalDate\(cov\.start\) : '';/);
});

test('G: the Apps Script side is unchanged — no formatting reached the backend', () => {
  /* Code.gs stores and validates; it must never learn a display format.
   * coverageDateISO_ is the normalizer #135 built and this PR does not touch. */
  assert.match(GS, /function coverageDateISO_/);
  assert.doesNotMatch(GS, /toLocaleDateString/);
  assert.doesNotMatch(GS, /coverageWindowText|coverageMonthSplit|coverageDateText/);
  // The two columns are still the text-forced pair.
  assert.match(GS, /const PAYMENT_TEXT_COLUMNS = \['coverageStart', 'coverageEnd'\]/);
});

test("G: the credits audit trail keeps its ISO dates — it is PERSISTED, not display", () => {
  /* creditBasisText's output is written into the Credits row's `reason`
   * column at creation (test/payment-coverage-period.test.js E). Reformatting
   * it would change stored data, which this change explicitly does not do —
   * so it is deliberately left on ISO and this test says so out loud. */
  const src = fnSource(APP, 'creditBasisText');
  assert.match(src, /\$\{basis\.coverageStart\} → \$\{basis\.coverageEnd\}/,
    'the persisted audit string still records the raw ISO window');
  assert.doesNotMatch(src, /coverageWindowText|coverageDateText/);
});

/* ================= H. THE ROW ================= */

test('H: the rendered split is one line per month, with days and amount', () => {
  const html = app.coverageSplitHtml(29000, win('2026-09-06', '2026-10-05'), '2026-09');
  const lines = html.match(/class="cov-split-line/g) || [];
  assert.equal(lines.length, 2);
  assert.match(html, /ספטמבר 2026/);
  assert.match(html, /25 ימים/);
  assert.match(html, /₪ 24,167/);
  assert.match(html, /אוקטובר 2026/);
  assert.match(html, /5 ימים/);
  assert.match(html, /₪ 4,833/);
});

test('H: the month NOT being viewed is marked deferred; the one being viewed is not', () => {
  const sept = renderedLines(app.coverageSplitHtml(29000, win('2026-09-06', '2026-10-05'), '2026-09'));
  assert.equal(sept.length, 2);
  assert.equal(sept[0].deferred, false, 'the viewed month is not deferred');
  assert.match(sept[0].text, /ספטמבר 2026/);
  assert.equal(sept[1].deferred, true, 'the other month is');
  assert.match(sept[1].text, /אוקטובר 2026/);
  assert.match(sept[1].text, /title="נדחה לחודש אחר/, 'and says so on hover');

  // Switch the screen to October and the marking follows the selection.
  const oct = renderedLines(app.coverageSplitHtml(29000, win('2026-09-06', '2026-10-05'), '2026-10'));
  assert.equal(oct[0].deferred, true, 'September is the deferred one now');
  assert.equal(oct[1].deferred, false);

  // A recorded period entirely outside the viewed month: every line deferred,
  // which is the honest answer — none of this money lands in what you see.
  const away = renderedLines(app.coverageSplitHtml(3100, win('2026-03-01', '2026-03-31'), '2026-01'));
  assert.equal(away.length, 1);
  assert.equal(away[0].deferred, true);
});

test('H: a single-month window renders ONE line and no split', () => {
  const html = app.coverageSplitHtml(5000, win('2026-09-01', '2026-09-30'), '2026-09');
  assert.equal((html.match(/class="cov-split-line/g) || []).length, 1);
  assert.match(html, /₪ 5,000/);
});

test('H: no usable window renders nothing at all', () => {
  assert.equal(app.coverageSplitHtml(5000, null, '2026-09'), '');
  assert.equal(app.coverageSplitHtml(0, win('2026-09-06', '2026-10-05'), '2026-09')
    .includes('cov-split-line'), true, 'a zero payment still shows where its days fall');
});

test('H: the split repaints from the inputs BEFORE save, through the shared primitives', () => {
  /* Editing a period must answer "what does this do to my months?" while you
   * are still choosing it. The preview is not a second opinion: it runs the
   * typed pair through withDefaultCoverage + paymentCoverage — the exact pair
   * savePayment would store and the exact window every consumer would read. */
  const src = fnSource(APP, 'buildBillingRow');
  assert.match(src, /startIn\.oninput = repaintSplit;/);
  assert.match(src, /endIn\.oninput = repaintSplit;/);
  assert.match(src, /paymentCoverage\(withDefaultCoverage\(Object\.assign\(\{\}, payment, \{/,
    'the preview window comes from the same primitives the save path uses');
  assert.match(src, /if \(coveragePeriodError\(startIn\.value, endIn\.value\)\) return;/,
    'a half-typed pair leaves the last good split on screen');
  // Cancelling restores the stored split along with the stored values.
  assert.match(src, /endIn\.value = covEnd;\s*\n\s*\/\/[^\n]*\n\s*repaintSplit\(\);/);
});

test('H: the split lives OUTSIDE the view span, so it stays up while editing', () => {
  /* .bill-cov-view is hidden when the editor opens. A split nested inside it
   * would vanish at exactly the moment it is most useful. */
  const src = fnSource(APP, 'buildBillingRow');
  const viewSpan = src.slice(src.indexOf('bill-cov-view'), src.indexOf('bill-cov-edit hidden'));
  assert.doesNotMatch(viewSpan, /bill-cov-split/);
  assert.match(src, /<span class="bill-cov-split">\$\{coverageSplitHtml\(amount, cov, covCurrentKey\)\}<\/span>/);
});

test('H: every rendered figure is escaped or numeric', () => {
  /* The month label comes from toLocaleDateString and the amounts from
   * toLocaleString, but the label still goes through escapeHtml — the rule on
   * this row is that nothing interpolated is unescaped, so a future label
   * source cannot quietly become an injection point. */
  assert.match(fnSource(APP, 'coverageSplitHtml'), /escapeHtml\(p\.label\)/);
});

/* ================= I. STYLING ================= */

test('I: the split uses the screen accent colours, and marks deferred months apart', () => {
  const block = CSS.slice(CSS.indexOf('.bill-cov-split'), CSS.indexOf('/* ===== Cards ===== */'));
  assert.match(block, /\.cov-split-line\s*\{[^}]*color: var\(--primary\)/,
    'the viewed month reads in the screen accent');
  assert.match(block, /\.cov-split-line\.deferred\s*\{[^}]*color: var\(--warning\)/,
    'a deferred month reads in the existing amber "later" language');
  // Prominent, not a footnote: no muted colour, no shrunken type.
  assert.doesNotMatch(block, /var\(--text-dim\)[^}]*\}\s*$/);
  assert.match(block, /font-weight: 600/);
  // An empty container must not leave a gap on rows with no window.
  assert.match(block, /\.bill-cov-split:empty \{ display: none; \}/);
});

test('I: no new colour tokens were invented for this', () => {
  const block = CSS.slice(CSS.indexOf('.bill-cov-split'), CSS.indexOf('/* ===== Cards ===== */'));
  const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexes, [], 'colours come from the existing tokens, not new hexes');
});

/* ================= J. THE SERVICE WORKER ================= */

test('J: sw.js CACHE_VERSION was bumped for this asset change', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/var CACHE_VERSION = 'v(\d+)'/);
  assert.ok(m, 'CACHE_VERSION not found in sw.js');
  assert.ok(Number(m[1]) >= 15,
    `CACHE_VERSION is v${m[1]}; app.js + style.css changed, so it needs >= v15`);
});
