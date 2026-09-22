/* תקופת כיסוי, part two — the period as PEOPLE read it, and the month split
 * underneath it.
 *
 * PR #135 put the coverage period on the גבייה row. It printed the pair as two
 * bare ISO dates ("2026-09-22 → 2026-10-21") and said nothing about what the
 * period does to the money. Both are closed here, matching the contract
 * ezone-outpatient PR #110 already settled on.
 *
 * Locked contracts:
 *   - DISPLAY ONLY. Everywhere a coverage date is SHOWN it goes through
 *     formatDate() — the app's own people-facing formatter, the one תאריך
 *     כניסה already uses on תפוסה. Nothing new was written for it. What is
 *     STORED, validated, posted and fed to the native <input type="date">
 *     stays bare 'YYYY-MM-DD' text, exactly as #135 built it.
 *   - THE SPLIT IS NOT A SECOND OPINION. splitByMonth() divides the payment
 *     between calendar months through revenueAllocate() — literally the
 *     function הכנסות חודשיות allocates with. A row's split and that screen's
 *     allocation for the same payment are the same number, asserted here and
 *     guarded against forking in test/monthly-revenue.test.js.
 *   - The denominator is the WINDOW's own length, never the calendar month's.
 *   - VAT-INCLUSIVE, like the amount printed beside it on the row.
 *   - The printed lines sum EXACTLY to the payment; the rounding residual is
 *     parked on the longest month, and `allocated` still carries the monthly
 *     view's own unadjusted figure.
 *   - A period inside one month yields one line. Months after the first read
 *     as deferred (muted + נדחה), and that is clock-independent.
 *   - The split follows the date inputs LIVE while the period is edited, and
 *     an impossible pair shows the shared refusal reason instead of a window.
 *
 * TZ pinned to Asia/Jerusalem so the local-part assertions mean what they say.
 * vm-sandbox on the REAL shipped app.js, per repo convention.
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
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      splitByMonth, paymentMonthSplit, coverageSplitHtml, coveragePeriodText,
      formatDate, paymentCoverage, withDefaultCoverage, coveragePeriodError,
      buildMonthlyRevenue, revenueAllocate, revenueMonthBounds, revenueExVat,
      localDateFromISO, isoFromLocalDate, isoDate, roundMoney, monthKey,
      patientKey, creditBasisText, fmtShekel, VAT_RATE,
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

/* A window from two ISO dates, built the way every caller builds one. */
const win = (a, b) => ({ start: app.localDateFromISO(a), end: app.localDateFromISO(b) });
/* Values built inside the vm carry the VM's Array/Object prototypes, so
 * deepStrictEqual fails its prototype check even when the contents match.
 * Round-trip through JSON for host-realm plainness — the same fix
 * test/monthly-revenue.test.js already uses. */
const plain = (v) => JSON.parse(JSON.stringify(v));
/* [month, days, displayed amount, deferred] — the split as it is read. */
const lines = (split) => plain(split.months.map(
  (m) => [m.month, m.daysInMonth, m.amount, m.deferred]));

/* ================= A. the date display ================= */

test('A: a coverage window prints in the app\'s people-facing date format, never ISO', () => {
  // The very pair the bug report quoted.
  assert.equal(app.coveragePeriodText(win('2026-09-22', '2026-10-21')),
    '22.9.2026 – 21.10.2026');
  // Which is exactly what the rest of the app prints a person's dates as —
  // תאריך כניסה on תפוסה goes through this same formatDate().
  assert.equal(app.formatDate('2026-09-22'), '22.9.2026');
});

test('A: the formatter is REUSED, not twinned — app.js declares one formatDate', () => {
  assert.equal((APP.match(/^function formatDate\s*\(/gm) || []).length, 1,
    'a second date formatter is a second answer to "how does this app write a date"');
  assert.match(fnSource(APP, 'coveragePeriodText'), /formatDate\(/,
    'the window text goes through the shared formatter');
  /* And it writes no date arithmetic of its own: it reads the two ends the way
   * every other consumer does and hands them straight to the formatter. */
  assert.doesNotMatch(fnSource(APP, 'coveragePeriodText'), /toLocaleDateString|getFullYear|padStart/);
});

test('A: a single-day period prints ONCE — "22.9.2026 – 22.9.2026" reads as a bug', () => {
  assert.equal(app.coveragePeriodText(win('2026-09-22', '2026-09-22')), '22.9.2026');
  // And a row with no window at all says so rather than printing an empty range.
  assert.equal(app.coveragePeriodText(null), '—');
  assert.equal(app.coveragePeriodText({ start: null, end: null }), '—');
});

test('A: the גבייה row prints the window through it, and keeps ISO in the inputs', () => {
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /const covText = coveragePeriodText\(cov\);/);
  assert.doesNotMatch(row, /\$\{covStart\} → \$\{covEnd\}/, 'the raw ISO pair is gone from the view');
  /* The native <input type="date"> takes bare ISO and nothing else — a
   * formatted value would be rejected by the control and would break the
   * round-trip to the sheet. */
  assert.match(row, /const covStart = cov \? isoFromLocalDate\(cov\.start\) : '';/);
  assert.match(row, /class="bill-cov-start" type="date" value="\$\{escapeHtml\(covStart\)\}"/);
  assert.match(row, /class="bill-cov-end" type="date" value="\$\{escapeHtml\(covEnd\)\}"/);
});

test('A: the same format everywhere else a coverage date is shown', () => {
  // הכנסות חודשיות drill-down.
  const detail = fnSource(APP, 'buildRevenueDetailRow');
  assert.match(detail, /formatDate\(row\.coverageStart\)/);
  assert.match(detail, /formatDate\(row\.coverageEnd\)/);
  // The credits UI — the window inside a refund's calculation trail.
  const basis = fnSource(APP, 'creditBasisText');
  assert.match(basis, /formatDate\(basis\.coverageStart\)/);
  assert.match(basis, /formatDate\(basis\.coverageEnd\)/);
  assert.match(app.creditBasisText('prepaid_return', {
    coverageStart: '2026-09-22', coverageEnd: '2026-10-21', windowDays: 30,
    paymentDueDate: '2026-09-22', exitDate: '2026-09-25', billedAmount: 37000, amountPaid: 37000,
  }), /חלון כיסוי 22\.9\.2026 → 21\.10\.2026/);
});

test('A: STORAGE is untouched — what is written and validated is still bare ISO', () => {
  const stamped = app.withDefaultCoverage({ id: 'p1', dueDate: '2026-09-22' });
  assert.equal(stamped.coverageStart, '2026-09-22');
  assert.equal(stamped.coverageEnd, '2026-10-21');
  for (const v of [stamped.coverageStart, stamped.coverageEnd]) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, 'the sheet keeps bare YYYY-MM-DD text');
  }
  // The validation rule never learned about the display format.
  assert.equal(app.coveragePeriodError('2026-09-22', '2026-10-21'), '');
  assert.match(app.coveragePeriodError('22.9.2026', '21.10.2026'), /תאריך לא תקין/,
    'a formatted date is still refused as INPUT — display is one-way');
  // Nothing on the write path formats.
  assert.doesNotMatch(fnSource(APP, 'savePayment'), /formatDate|coveragePeriodText/);
  assert.doesNotMatch(fnSource(APP, 'withDefaultCoverage'), /formatDate|coveragePeriodText/);
  assert.doesNotMatch(fnSource(APP, 'saveCoveragePeriod'), /formatDate|coveragePeriodText/);
});

/* ================= B. the split, month by month ================= */

test('B: 22 Sep – 21 Oct on ₪37,000 splits 9 / 21, and the later month is deferred', () => {
  const split = app.splitByMonth(37000, win('2026-09-22', '2026-10-21'));
  assert.equal(split.windowDays, 30);
  assert.deepEqual(lines(split), [
    ['2026-09', 9, 11100, false],
    ['2026-10', 21, 25900, true],
  ]);
  // As the row prints them.
  assert.deepEqual(plain(split.months.map((m) => m.monthName)), ['ספטמבר', 'אוקטובר']);
  assert.equal(split.months[0].share, 9 / 30);
  assert.equal(split.residual, 0);
});

test('B: the denominator is the WINDOW\'s own length, never the calendar month\'s', () => {
  /* 9 days of a 30-day window is 30% of the money. September has 30 days, so
   * a calendar-month denominator would give the same answer here by accident
   * — February is where the two rules part company. 1 Feb – 15 Mar is a
   * 43-day window: February contributes 28 of 43, not 28 of 28. */
  const split = app.splitByMonth(4300, win('2026-02-01', '2026-03-15'));
  assert.equal(split.windowDays, 43);
  assert.deepEqual(lines(split), [
    ['2026-02', 28, 2800, false],
    ['2026-03', 15, 1500, true],
  ]);
  assert.equal(split.months[0].windowDays, 43, 'the denominator is reported, not implied');
});

test('B: a period inside one month yields ONE line, and nothing is deferred', () => {
  const split = app.splitByMonth(3000, win('2026-03-01', '2026-03-31'));
  assert.deepEqual(lines(split), [['2026-03', 31, 3000, false]]);
  // Even a single day.
  assert.deepEqual(lines(app.splitByMonth(500, win('2026-03-07', '2026-03-07'))),
    [['2026-03', 1, 500, false]]);
});

test('B: a three-month period lists all three, with only the first not deferred', () => {
  // 15 Jan – 14 Apr 2026: 17 + 28 + 31 + 14 = 90 days.
  const split = app.splitByMonth(9000, win('2026-01-15', '2026-04-14'));
  assert.equal(split.windowDays, 90);
  assert.deepEqual(lines(split), [
    ['2026-01', 17, 1700, false],
    ['2026-02', 28, 2800, true],
    ['2026-03', 31, 3100, true],
    ['2026-04', 14, 1400, true],
  ]);
  assert.equal(split.months.reduce((t, m) => t + m.amount, 0), 9000);
});

test('B: deferred means "after the month the window starts in" — not "after today"', () => {
  /* Clock-independent on purpose: a row's split must not change meaning
   * because the calendar turned over. A window wholly in the past still
   * marks its second month deferred, and a window wholly in the future
   * still does not mark its first. */
  const past = app.splitByMonth(3000, win('2019-01-20', '2019-02-19'));
  assert.deepEqual(plain(past.months.map((m) => m.deferred)), [false, true]);
  const future = app.splitByMonth(3000, win('2099-01-20', '2099-02-19'));
  assert.deepEqual(plain(future.months.map((m) => m.deferred)), [false, true]);
});

test('B: the printed lines sum EXACTLY to the payment — the residual is parked, not lost', () => {
  /* ₪100 over three months of equal length: 33.33 × 3 = 99.99, and a split
   * that does not add up to the row's own amount reads as a bug to whoever
   * is checking it. The agora goes to the LONGEST month. */
  const split = app.splitByMonth(100, win('2026-01-01', '2026-03-31'));
  assert.equal(split.windowDays, 90);
  assert.equal(split.months.reduce((t, m) => t + m.amount, 0), 100);
  assert.equal(app.roundMoney(split.residual), split.residual);
  assert.notEqual(split.residual, 0, 'this window really does leave a residual');
  // Jan and Mar have 31 days, Feb 28 — the earlier of the two longest wins,
  // so the same payment always splits identically.
  assert.equal(split.months[0].amount, app.roundMoney(split.months[0].allocated + split.residual));
  assert.equal(split.months[1].amount, split.months[1].allocated);
  assert.equal(split.months[2].amount, split.months[2].allocated);
  /* `allocated` is left alone precisely so it still reconciles with the
   * monthly view, which knows nothing about the row's presentation. */
  split.months.forEach((m) => {
    const bounds = app.revenueMonthBounds(m.month);
    assert.equal(m.allocated, app.revenueAllocate(100, win('2026-01-01', '2026-03-31'), bounds).amount);
  });
});

test('B: a window longer than one year, and a nonsense window, do not run away', () => {
  // 366 days is the most coveragePeriodError() allows: 13 months touched.
  const split = app.splitByMonth(36600, win('2026-01-15', '2027-01-15'));
  assert.equal(split.months.length, 13);
  assert.equal(split.months[0].month, '2026-01');
  assert.equal(split.months[12].month, '2027-01');
  assert.equal(split.months.reduce((t, m) => t + m.amount, 0), 36600);
  // Backwards or absent windows yield nothing rather than a bogus line.
  assert.equal(app.splitByMonth(3000, win('2026-03-31', '2026-03-01')), null);
  assert.equal(app.splitByMonth(3000, null), null);
});

/* ================= C. it is the monthly view's own arithmetic ================= */

const patient = (o) => Object.assign({
  id: 'pt1', name: 'דנה כהן', date: '2026-09-22', pay: 37000,
  houseId: 'ramot', status: 'active',
}, o);
const payment = (o) => Object.assign({
  id: 'p1', patientId: 'pt1', patientName: 'דנה כהן', houseId: 'ramot',
  dueDate: '2026-09-22', amount: 37000, amountPaid: 37000, balance: 0, status: 'paid',
}, o);

test('C: the row\'s split IS the monthly view\'s allocation, month for month', () => {
  /* THE POINT of reusing revenueAllocate(). If the row computed its own
   * day-split, the two screens could drift by an agora — or by a day — and
   * neither would say which one to believe. */
  const p = patient();
  const pay = payment({ patientId: app.patientKey(p) });
  const split = app.paymentMonthSplit(pay, 37000);

  for (const m of split.months) {
    const model = app.buildMonthlyRevenue({
      month: m.month, patients: [p], payments: [pay], today: '2026-10-25',
    });
    const row = model.received.rows.find((r) => r.paymentId === 'p1');
    assert.ok(row, 'the view allocates this payment to ' + m.month);
    assert.equal(m.allocated, row.amountInMonth,
      m.month + ': the row and the view divide the money identically');
    assert.equal(m.daysInMonth, row.daysInMonth, m.month + ': and count the same days');
    assert.equal(m.windowDays, row.windowDays, m.month + ': over the same denominator');
  }
  // And the view really does report the ₪11,100 / ₪25,900 the row prints.
  assert.deepEqual(plain(split.months.map((m) => m.allocated)), [11100, 25900]);
});

test('C: a RECORDED period drives the split, exactly as it drives the allocation', () => {
  const p = patient();
  const pay = payment({
    patientId: app.patientKey(p), coverageStart: '2026-11-01', coverageEnd: '2026-11-30',
  });
  assert.deepEqual(lines(app.paymentMonthSplit(pay, 37000)),
    [['2026-11', 30, 37000, false]], 'the whole payment sits in November');
  const nov = app.buildMonthlyRevenue({ month: '2026-11', patients: [p], payments: [pay], today: '2026-12-01' });
  assert.equal(nov.received.inclVat, 37000);
  const sep = app.buildMonthlyRevenue({ month: '2026-09', patients: [p], payments: [pay], today: '2026-12-01' });
  assert.equal(sep.received.inclVat, 0, 'and none of it in September any more');
});

test('C: the split is VAT-INCLUSIVE — it matches the amount printed beside it', () => {
  /* The גבייה row prints ₪37,000, the gross the patient pays. הכנסות חודשיות
   * is the one screen that divides by VAT, and it labels every figure it
   * does that to. The split belongs to the row, so it is gross. */
  const split = app.paymentMonthSplit(payment(), 37000);
  assert.equal(split.months.reduce((t, m) => t + m.amount, 0), 37000);
  assert.notEqual(split.months[0].amount, app.revenueExVat(11100));
  // The ex-VAT figure the revenue screen reports is derived FROM it, downstream.
  assert.equal(app.revenueExVat(split.months[0].allocated), app.roundMoney(11100 / app.VAT_RATE));
});

test('C: paymentMonthSplit takes the EFFECTIVE amount, so an override splits too', () => {
  const src = fnSource(APP, 'paymentMonthSplit');
  assert.match(src, /paymentCoverage\(payment\)/, 'the window comes from the one primitive');
  assert.match(src, /splitByMonth\(amount, win\)/, 'the amount is the caller\'s, not the row\'s');
  // The row hands it the same `amount` it prints, override included.
  assert.match(fnSource(APP, 'buildBillingRow'), /coverageSplitHtml\(payment, amount\)/);
  assert.deepEqual(lines(app.paymentMonthSplit(payment(), 30000)),
    [['2026-09', 9, 9000, false], ['2026-10', 21, 21000, true]]);
});

/* ================= D. the strip on the row ================= */

test('D: the split is rendered under the period, across the full row', () => {
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /<div class="bill-cov-split">/);
  assert.match(row, /<span class="p-label">פיצול לפי חודשים<\/span>/);
  assert.match(row, /<span class="bill-cov-parts">\$\{coverageSplitHtml\(payment, amount\)\}<\/span>/);
  // Prominent, not a tooltip: its own full-width strip under the seven columns.
  assert.match(CSS, /\.billing-row \.bill-cov-split \{\s*\n\s*grid-column: 1 \/ -1;/);
  assert.match(CSS, /\.billing-row \.bill-cov-part \{/);
  // The later month reads as deferred — muted, and labelled.
  assert.match(CSS, /\.billing-row \.bill-cov-part\.deferred \{/);
  assert.match(CSS, /\.billing-row \.bill-cov-part \.cov-part-tag \{/);
});

test('D: each line says month · days · money, and only the later ones are tagged נדחה', () => {
  const html = app.coverageSplitHtml(payment(), 37000);
  assert.match(html, /<span class="cov-part-month">ספטמבר<\/span>/);
  assert.match(html, /<span class="cov-part-days">9 ימים<\/span>/);
  assert.match(html, /<span class="cov-part-amount">₪ 11,100<\/span>/);
  assert.match(html, /<span class="cov-part-amount">₪ 25,900<\/span>/);
  assert.equal((html.match(/נדחה</g) || []).length, 1, 'exactly one month is deferred');
  assert.match(html, /class="bill-cov-part deferred"/);
  assert.equal((html.match(/class="bill-cov-part/g) || []).length, 2);
});

test('D: a window crossing December names the YEAR, or two lines look identical', () => {
  const html = app.coverageSplitHtml(payment({ coverageStart: '2026-12-20', coverageEnd: '2027-01-19' }), 3100);
  assert.match(html, /דצמבר 2026/);
  assert.match(html, /ינואר 2027/);
  // Inside one year the bare month name reads cleanest.
  assert.doesNotMatch(app.coverageSplitHtml(payment(), 37000), /ספטמבר 2026/);
});

test('D: the strip follows the date inputs LIVE while the period is edited', () => {
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /const covPartsEl = row\.querySelector\('\.bill-cov-parts'\);/);
  assert.match(row, /covPartsEl\.innerHTML = coverageSplitHtml\(payment, amount, startIn\.value, endIn\.value\)/);
  for (const handler of ['startIn.oninput  = previewSplit;', 'endIn.oninput    = previewSplit;',
                         'startIn.onchange = previewSplit;', 'endIn.onchange   = previewSplit;']) {
    assert.ok(row.includes(handler), 'missing live-preview wiring: ' + handler);
  }
  // Cancel restores what is STORED, preview included.
  const cancel = row.slice(row.indexOf(".bill-cov-cancel'"));
  assert.match(cancel.slice(0, 400), /startIn\.value = covStart;[\s\S]*previewSplit\(\);/);

  // And the preview really does follow the override rather than the row.
  const preview = app.coverageSplitHtml(payment(), 37000, '2026-11-01', '2026-11-30');
  assert.match(preview, /נובמבר/);
  assert.doesNotMatch(preview, /ספטמבר/);
});

test('D: an impossible period being typed shows the SHARED refusal, not a window', () => {
  const html = app.coverageSplitHtml(payment(), 37000, '2026-10-21', '2026-09-22');
  assert.match(html, /class="bill-cov-split-err"/);
  assert.match(html, /תאריך הסיום מוקדם מתאריך ההתחלה/, 'the same message the server returns');
  assert.doesNotMatch(html, /bill-cov-part/);
  // Half-filled, too: the strip must not guess at a period nobody can save.
  assert.match(app.coverageSplitHtml(payment(), 37000, '2026-10-21', ''), /class="bill-cov-split-err"/);
  assert.match(fnSource(APP, 'coverageSplitHtml'), /coveragePeriodError\(startISO, endISO\)/);
});

/* ================= E. scope + security ================= */

test('E: the split is DISPLAY — it writes nothing, anywhere', () => {
  for (const name of ['splitByMonth', 'paymentMonthSplit', 'coverageSplitHtml', 'coveragePeriodText']) {
    const src = fnSource(APP, name);
    for (const writer of ['savePayment', 'apiPost', 'state.payments', 'localStorage']) {
      assert.ok(!src.includes(writer), name + ' must not reach for ' + writer);
    }
  }
  /* And the row it is handed is never mutated: the live preview builds a COPY
   * before overriding the pair, so a half-typed period cannot leak into the
   * object the save path will send. */
  assert.match(fnSource(APP, 'coverageSplitHtml'),
    /probe = \{ \.\.\.payment, coverageStart: startISO \|\| '', coverageEnd: endISO \|\| '' \}/);
  const row = payment();
  const before = JSON.stringify(row);
  app.coverageSplitHtml(row, 37000, '2026-11-01', '2026-11-30');
  app.paymentMonthSplit(row, 37000);
  assert.equal(JSON.stringify(row), before, 'the input row is byte-identical afterwards');
});

test('E: no backend learned anything — server.js and Code.gs are untouched', () => {
  for (const token of ['splitByMonth', 'paymentMonthSplit', 'bill-cov-split', 'coveragePeriodText']) {
    assert.ok(!SERVER.includes(token), 'server.js must not know about ' + token);
    assert.ok(!GS.includes(token), 'Code.gs must not know about ' + token);
  }
  assert.ok(!INDEX.includes('bill-cov-split'), 'the strip is built by the renderer, not static markup');
});

test('E: everything the strip puts in the DOM is escaped', () => {
  const src = fnSource(APP, 'coverageSplitHtml');
  assert.match(src, /escapeHtml\(err\)/, 'the refusal reason');
  assert.match(src, /escapeHtml\(oneYear \? m\.monthName : m\.label\)/, 'the month name');
  assert.match(src, /escapeHtml\(fmtShekel\(m\.amount\)\)/, 'the money');
  /* daysInMonth is a number out of revenueAllocate(), so it cannot carry
   * markup; assert it really is one rather than trusting the shape. */
  assert.equal(typeof app.splitByMonth(37000, win('2026-09-22', '2026-10-21')).months[0].daysInMonth, 'number');
});
