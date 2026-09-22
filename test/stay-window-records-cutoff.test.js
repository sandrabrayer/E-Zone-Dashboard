/* WHO WAS DUE WHEN, AND A RECORDS CUTOFF.
 *
 * TWO PROBLEMS, ONE SCREEN'S WORTH OF WRONG MONEY.
 *
 * 1. THE STAY WINDOW. Being "due on a date" was decided by DAY-OF-MONTH alone.
 *    עמית בורנשטיין entered עפרוני on 7.9.2026 and appeared on the גבייה list
 *    for 07/07/2026 — two months before he arrived. ניר כהן, אבי משען,
 *    בן שלום, שחר חיון and גיל, all September admissions, did the same on July
 *    dates. The day matched; nothing asked whether the stay did.
 *
 *    The mirror-image error lived on הכנסות חודשיות: EXPECTED was built from
 *    patients who are active TODAY, so a patient discharged in August
 *    contributed nothing to JULY — a month they spent entirely in the house.
 *
 * 2. THE RECORDS CUTOFF. No payment was entered in this app before July 2026:
 *    of 27 patients admitted in June, not one has a first payment recorded.
 *    Every screen that infers a cycle from an entry day was reading that
 *    absence as unpaid debt. RECORDS_COMPLETE_FROM draws the line, and cycles
 *    before it go to their own bucket — לפני תחילת הרישום — which no total
 *    sums and no screen hides.
 *
 * Locked contracts:
 *   - ONE stay rule: entryDate <= date AND (exitDate empty OR exitDate >= date),
 *     every date normalized through isoDate() so the known one-day drift
 *     cannot move a boundary;
 *   - dayOfMonth() is isoDate-routed, so a date-TYPED cell cannot anchor a
 *     patient's whole billing schedule one day early;
 *   - EXPECTED is built from the STAY, not from today's status;
 *   - a pre-cutoff cycle is never in EXPECTED, NET, byHouse, or any debt
 *     total — and is never silently dropped either;
 *   - the cutoff is ONE configurable constant, and nothing in the app
 *     overrides it.
 *
 * TZ pinned to Asia/Jerusalem. vm-sandbox on the REAL shipped app.js.
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
      state, RECORDS_COMPLETE_FROM, isPreRecordsCycle,
      patientExitISO, patientStayCoversDate, patientStayOverlapsRange,
      patientDueOnDate, patientsDueOn, dayOfMonth, isBillablePatient,
      buildMonthlyRevenue, paymentForPatientOnDate, projectedCycleDueDates,
      revenueMonthBounds, revenueExVat, patientKey, paymentId, isoDate,
      roundMoney, monthKey, VAT_RATE,
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
const plain = (v) => JSON.parse(JSON.stringify(v));

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

/* עמית בורנשטיין, עפרוני, entered 7.9.2026 — the row from the bug report. */
const amit = (over) => Object.assign({
  id: 'pt-amit', houseId: 'arfoni', name: 'עמית בורנשטיין',
  date: '2026-09-07', pay: 35000, status: 'active', exitDate: '',
}, over || {});

const patient = (over) => Object.assign({
  id: 'pt1', houseId: 'arfoni', name: 'דנה כהן',
  date: '2026-07-10', pay: 30000, status: 'active', exitDate: '',
}, over || {});

const payment = (over) => Object.assign({
  id: 'pay1', patientId: '', patientName: 'דנה כהן', houseId: 'arfoni',
  dueDate: '2026-07-10', amount: 30000, amountPaid: 0, status: 'unpaid', balance: 30000,
}, over || {});

/* buildMonthlyRevenue with everything defaulted. NO recordsFrom override —
 * this suite is about the real, shipped cutoff. */
const build = (over) => app.buildMonthlyRevenue(Object.assign({
  month: '2026-07', patients: [], payments: [], credits: [], overrides: [],
  today: '2026-09-22',
}, over || {}));

/* patientsDueOn reads module state; set it, call, restore. */
function dueOn(patients, dateISO) {
  const prev = app.state.patients;
  app.state.patients = patients;
  try { return app.patientsDueOn(dateISO).map((p) => p.name); }
  finally { app.state.patients = prev; }
}

/* ================= A. the stay window ================= */

test('A: a patient is NOT due before they arrived — the עמית בורנשטיין bug', () => {
  const p = amit();
  // The reported symptom: entry day 7, so 07/07/2026 "matched" and he was
  // billed for a July he spent somewhere else entirely.
  assert.equal(app.patientDueOnDate(p, '2026-07-07'), false, 'two months before entry');
  assert.equal(app.patientDueOnDate(p, '2026-08-07'), false, 'one month before entry');
  // His own entry day IS his first cycle, and every anniversary after it.
  assert.equal(app.patientDueOnDate(p, '2026-09-07'), true);
  assert.equal(app.patientDueOnDate(p, '2026-10-07'), true);
  // Through the list the גבייה screen actually calls.
  assert.deepEqual(plain(dueOn([p], '2026-07-07')), []);
  assert.deepEqual(plain(dueOn([p], '2026-09-07')), ['עמית בורנשטיין']);
});

test('A: all six reported September admissions vanish from their July dates', () => {
  /* The others named in the report — same shape, different entry days, so the
   * fix is the rule and not a patch for one row. */
  const roster = [
    { name: 'ניר כהן', date: '2026-09-03' },
    { name: 'אבי משען', date: '2026-09-14' },
    { name: 'בן שלום', date: '2026-09-21' },
    { name: 'שחר חיון', date: '2026-09-07' },
    { name: 'גיל', date: '2026-09-28' },
  ].map((o, i) => amit(Object.assign({ id: 'r' + i }, o)));

  roster.forEach((p) => {
    const julyEcho = '2026-07-' + String(app.dayOfMonth(p.date)).padStart(2, '0');
    assert.equal(app.patientDueOnDate(p, julyEcho), false,
      p.name + ' must not be due on ' + julyEcho);
    assert.equal(app.patientDueOnDate(p, app.isoDate(p.date)), true,
      p.name + ' IS due on their own entry day');
  });
  assert.deepEqual(plain(dueOn(roster, '2026-07-14')), [], 'the July list is empty of them');
});

test('A: a discharged patient IS due inside the stay, and not after it', () => {
  // Entered 10 Jul, discharged 20 Aug. July cycle: yes. September: no.
  const p = patient({ status: 'released', exitDate: '2026-08-20' });
  assert.equal(app.patientDueOnDate(p, '2026-07-10'), true, 'inside the stay');
  assert.equal(app.patientDueOnDate(p, '2026-08-10'), true, 'still inside on the exit month');
  assert.equal(app.patientDueOnDate(p, '2026-09-10'), false, 'after the discharge');
  // Both ends are INCLUSIVE: the entry day and the exit day are stay days.
  assert.equal(app.patientStayCoversDate(p, '2026-07-10'), true);
  assert.equal(app.patientStayCoversDate(p, '2026-08-20'), true);
  assert.equal(app.patientStayCoversDate(p, '2026-07-09'), false);
  assert.equal(app.patientStayCoversDate(p, '2026-08-21'), false);
});

test('A: released with NO exit date is treated as gone — the conservative reading', () => {
  /* The one case the dates cannot answer. Status is then the only signal, and
   * inventing a stay would re-create the "billed for a period they were not
   * here" this rule exists to stop. Flagged in the PR. */
  const p = patient({ status: 'released', exitDate: '' });
  assert.equal(app.patientStayCoversDate(p, '2026-07-10'), false);
  assert.equal(app.patientStayOverlapsRange(p, '2026-07-01', '2026-07-31'), false);
  // An ACTIVE patient with no exit date is open-ended, as they should be.
  assert.equal(app.patientStayCoversDate(patient(), '2099-07-10'), true);
});

test('A: every date is normalized — a UTC-timestamp cell cannot move a boundary', () => {
  /* A date-TYPED sheet cell reaches the client as "2026-09-06T21:00:00.000Z",
   * whose calendar day in Israel is the 7th. Raw string handling reads day 6
   * — one day early for the anchor, and one day wrong at every boundary. */
  const drifted = amit({ date: '2026-09-06T21:00:00.000Z' });
  assert.equal(app.isoDate(drifted.date), '2026-09-07', 'the local day is the 7th');
  assert.equal(app.dayOfMonth(drifted.date), 7, 'so the anchor is day 7, not day 6');
  assert.equal(app.patientDueOnDate(drifted, '2026-09-07'), true);
  assert.equal(app.patientDueOnDate(drifted, '2026-09-06'), false);
  // The boundary itself: an exit stored as a timestamp still includes its day.
  const out = patient({ status: 'released', exitDate: '2026-08-19T21:00:00.000Z' });
  assert.equal(app.patientExitISO(out), '2026-08-20');
  assert.equal(app.patientStayCoversDate(out, '2026-08-20'), true, 'the exit day is a stay day');
  assert.equal(app.patientStayCoversDate(out, '2026-08-21'), false);
  // And the function really is routed, not merely correct by luck.
  assert.match(fnSource(APP, 'dayOfMonth'), /isoDate\(iso\)/);
  for (const name of ['patientStayCoversDate', 'patientStayOverlapsRange', 'patientExitISO']) {
    assert.match(fnSource(APP, name), /isoDate\(/, name + ' must normalize');
  }
});

test('A: ONE rule — the due list and the revenue screen both go through it', () => {
  // patientsDueOn is the daily list + the KPI cards; it delegates, never re-derives.
  assert.match(fnSource(APP, 'patientsDueOn'), /patientDueOnDate\(p, dateISO\)/);
  assert.match(fnSource(APP, 'patientDueOnDate'), /patientStayCoversDate\(patient, dateISO\)/);
  // The revenue screen's EXPECTED pass reads the stay, not the status.
  const build_ = fnSource(APP, 'buildMonthlyRevenue');
  assert.match(build_, /patientStayOverlapsRange\(patient, bounds\.startISO, bounds\.endISO\)/);
  assert.ok(!/if \(!isBillablePatient\(patient\)\) return;/.test(build_),
    'the active-today filter is gone from the EXPECTED pass');
  /* isBillablePatient still exists and is still the ONE statement of
   * "released stops billing" — the stay rule now calls it for the single case
   * the dates cannot answer, rather than a second copy of the comparison. */
  assert.match(fnSource(APP, 'patientStayCoversDate'), /return isBillablePatient\(patient\);/);
  assert.match(fnSource(APP, 'patientStayOverlapsRange'), /return isBillablePatient\(patient\);/);
  // Each helper is declared exactly once — app.js is one flat script scope.
  for (const name of ['patientStayCoversDate', 'patientStayOverlapsRange',
                      'patientDueOnDate', 'patientExitISO', 'patientsDueOn',
                      'dayOfMonth', 'isPreRecordsCycle']) {
    assert.equal((APP.match(new RegExp('^function\\s+' + name + '\\s*\\(', 'gm')) || []).length, 1,
      name + ' must be declared exactly once');
  }
});

/* ================= B. discharged patients in past months ================= */

test('B: July EXPECTED includes a patient discharged in AUGUST', () => {
  /* They were in the house for all of July. Their July cycle is July's
   * revenue, and their status in September has nothing to say about it. */
  const p = patient({ status: 'released', exitDate: '2026-08-20' });
  const july = build({ patients: [p] });
  assert.ok(july.expected.inclVat > 0, 'July counts them');
  const row = july.expected.rows.find((r) => r.patientName === 'דנה כהן');
  assert.ok(row, 'and names them on the drill-down');
  assert.equal(row.dueDate, '2026-07-10');
  // The whole July-owned slice of a 10 Jul – 9 Aug window: 22 of 31 days.
  assert.equal(row.daysInMonth, 22);
  assert.equal(row.windowDays, 31);
  assert.equal(row.amountInMonth, app.roundMoney(30000 * 22 / 31));
});

test('B: the stay still ENDS — nothing is expected after the discharge', () => {
  const p = patient({ status: 'released', exitDate: '2026-08-20' });
  // September is entirely after the exit: no cycle, no row, no shekel.
  const sep = build({ month: '2026-09', patients: [p] });
  assert.equal(sep.expected.inclVat, 0);
  assert.equal(sep.expected.rows.length, 0);
  // August is the straddle: the cycle exists, and revenueAllocate truncates it
  // at the exit day so the days after it earn nothing.
  const aug = build({ month: '2026-08', patients: [p] });
  const augRow = aug.expected.rows.find((r) => r.dueDate === '2026-08-10');
  assert.ok(augRow, 'the August cycle is real — they were here for part of it');
  assert.equal(augRow.daysInMonth, 11, '10–20 Aug, then they left');
  assert.equal(augRow.windowDays, 31, 'the denominator is the whole cycle, not the stay');
});

test('B: an ACTIVE patient is unaffected — this widens the rule, it does not swap it', () => {
  const active = build({ patients: [patient()] });
  const released = build({ patients: [patient({ status: 'released', exitDate: '2026-08-20' })] });
  assert.equal(active.expected.inclVat, released.expected.inclVat,
    'July does not care which of them is still here in September');
});

/* ================= C. the records cutoff ================= */

test('C: the cutoff is ONE constant, and it is the date the data says', () => {
  assert.equal(app.RECORDS_COMPLETE_FROM, '2026-07-01');
  assert.equal((APP.match(/^const RECORDS_COMPLETE_FROM = /gm) || []).length, 1);
  // Nothing hard-codes the date beside it.
  const strays = (APP.match(/'2026-07-01'/g) || []).length;
  assert.equal(strays, 1, "the cutoff date is written once, in the constant");
  assert.equal(app.isPreRecordsCycle('2026-06-30'), true);
  assert.equal(app.isPreRecordsCycle('2026-07-01'), false, 'the cutoff day is INSIDE the records');
  assert.equal(app.isPreRecordsCycle(''), false, 'no date is not a pre-records cycle');
  // Normalized, so a timestamp cannot land on the wrong side of the line.
  assert.equal(app.isPreRecordsCycle('2026-06-30T21:00:00.000Z'), false,
    'that timestamp IS 1 July in Israel');
});

test('C: a JUNE cycle lands in לפני תחילת הרישום and is in NO total', () => {
  /* One of the 27 June admissions: entered 20 June, never had a payment row
   * created for that cycle because the app was not recording payments yet.
   * Its window (20 Jun – 19 Jul) overlaps July, so before this change July's
   * EXPECTED carried it as debt. */
  const p = patient({ id: 'june', name: 'יוני', date: '2026-06-20' });
  const july = build({ patients: [p] });

  const pre = july.preRecords;
  assert.equal(pre.count, 1, 'the June cycle is reported');
  assert.equal(pre.rows[0].dueDate, '2026-06-20');
  assert.equal(pre.rows[0].kind, 'pre_records');
  assert.equal(pre.rows[0].daysInMonth, 19, '1–19 July belong to that cycle');
  assert.ok(pre.inclVat > 0, 'with a real figure, so it can be acted on');
  assert.equal(pre.from, '2026-07-01', 'and it says which line it fell behind');

  // …and it is in NOTHING else.
  assert.equal(july.expected.rows.filter((r) => r.dueDate === '2026-06-20').length, 0);
  assert.equal(july.expected.rows.filter(
    (r) => r.kind === 'unbilled_past' && r.dueDate === '2026-06-20').length, 0,
    'not a recording gap — a pre-records cycle');
  const julyOwn = july.expected.rows.find((r) => r.dueDate === '2026-07-20');
  assert.ok(julyOwn, 'the JULY cycle of the same patient is expected as normal');
  assert.equal(july.expected.inclVat, julyOwn.amountInMonth, 'EXPECTED is that cycle alone');
  assert.equal(july.net.inclVat, app.roundMoney(july.received.inclVat + july.expected.inclVat));
  // The per-house breakdown must not carry it either.
  const house = july.byHouse.find((b) => b.house === 'קיסריה עפרוני');
  assert.equal(house.expected.inclVat, julyOwn.amountInMonth);
});

test('C: BEFORE and AFTER, on the same data — the figure this PR moves', () => {
  /* The delta stated in the PR, as arithmetic rather than a claim.
   * `recordsFrom` is the test-only override; passing a date before the
   * fixtures reproduces exactly what the screen showed before this change. */
  const p = patient({ id: 'june', name: 'יוני', date: '2026-06-20' });
  const before = app.buildMonthlyRevenue({
    month: '2026-07', patients: [p], payments: [], credits: [], overrides: [],
    today: '2026-09-22', recordsFrom: '2020-01-01',
  });
  const after = build({ patients: [p] });

  /* The June cycle runs 20 Jun – 19 Jul: a 30-day window with 19 days in
   * July. That slice is what left EXPECTED. */
  const juneSlice = app.roundMoney(30000 * 19 / 30);
  assert.equal(before.expected.inclVat, app.roundMoney(juneSlice + after.expected.inclVat),
    'before: the June cycle was inside EXPECTED');
  assert.equal(after.expected.inclVat, app.roundMoney(before.expected.inclVat - juneSlice),
    'after: EXPECTED drops by exactly the June cycle\'s July days');
  assert.equal(after.preRecords.inclVat, juneSlice, 'and the same figure is reported, not lost');
  assert.equal(before.preRecords.count, 0);
  assert.equal(after.net.inclVat, app.roundMoney(before.net.inclVat - juneSlice), 'NET moves with it');
});

test('C: a RECORDED pre-cutoff row is still real money — the conservative choice', () => {
  /* The cutoff suppresses INFERRED cycles: rows nobody ever created. A row
   * that EXISTS was entered by somebody, so it is evidence of recording and
   * stays in RECEIVED / EXPECTED. (No such row exists in the live sheet — the
   * premise of the cutoff is that there are none — so this changes no figure
   * today; it is here so that hiding real money can never become the rule.) */
  const p = patient({ id: 'june', name: 'יוני', date: '2026-06-20' });
  const paid = payment({
    id: 'pay-june', patientId: app.patientKey(p), patientName: 'יוני',
    dueDate: '2026-06-20', amountPaid: 30000, status: 'paid', balance: 0,
  });
  const july = build({ patients: [p], payments: [paid] });
  assert.ok(july.received.inclVat > 0, 'money that was recorded arrived');
  assert.equal(july.preRecords.count, 0, 'a recorded cycle is not an unrecorded one');
});

test('C: nothing in the APP overrides the constant — only the tests can', () => {
  assert.match(fnSource(APP, 'buildMonthlyRevenue'),
    /const recordsFrom = isoDate\(opts\.recordsFrom\) \|\| RECORDS_COMPLETE_FROM;/);
  assert.ok(!fnSource(APP, 'renderMonthlyRevenue').includes('recordsFrom'),
    'the screen passes no override, so it always reads the constant');
  assert.ok(!APP.includes('recordsFrom:'), 'and nothing in app.js sets one');
});

/* ================= D. the cutoff wherever cycles are listed ================= */

test('D: the גבייה KPI card, the open balances and the monthly summary all honour it', () => {
  // סך לגבייה excludes pre-records cycles, and says how many it left out.
  const rb = fnSource(APP, 'renderBilling');
  assert.match(rb, /const countableDue\s+= due\.filter\(d => !isPreRecordsCycle\(selected\) && !isVoidPayment\(d\.payment\)\);/);
  assert.match(rb, /const totalDue\s+= countableDue\.reduce/);
  assert.match(rb, /renderPreRecordsNote\(preRecordsDue\.length\)/);
  /* נגבה is not filtered BY THE CUTOFF — money that was recorded arrived.
   * (It is filtered by isVoidPayment: a void row's amountPaid is the second
   * copy of a sum already counted on its twin. Different rule, different
   * reason — see CHANGELOG-duplicate-payment-void.md.) */
  assert.match(rb, /const totalCollected = due\.filter\(d => !isVoidPayment\(d\.payment\)\)/);
  assert.ok(!/const totalCollected = due\.filter\(d => isPreRecordsCycle/.test(rb),
    'the cutoff must still leave נגבה alone');
  assert.match(fnSource(APP, 'renderPreRecordsNote'), /RECORDS_COMPLETE_FROM/);

  // יתרות פתוחות lists them apart, under their own heading, never above it.
  const open = fnSource(APP, 'renderBillingOpenList');
  assert.match(open, /matched\.filter\(o => !isPreRecordsCycle\(o\.pay\.dueDate\)\)/);
  assert.match(open, /pre-records-head/);
  assert.match(open, /לפני תחילת הרישום/);

  // The old סיכום חודשי: יתרה honours the line, נגבה does not.
  const sum = fnSource(APP, 'renderBillingMonthlySummary');
  assert.match(sum, /const debtRows = liveRows\.filter\(p => !isPreRecordsCycle\(p\.dueDate\)\);/);
  assert.match(sum, /const outstanding = debtRows/);
  /* `liveRows` is thisMonth minus VOID rows — a separate rule with a separate
   * reason (see CHANGELOG-duplicate-payment-void.md). What this test still
   * pins is that the CUTOFF touches יתרה and leaves נגבה alone. */
  assert.match(sum, /const liveRows = thisMonth\.filter\(p => !isVoidPayment\(p\)\);/);
  assert.match(sum, /const collected\s+= liveRows\.reduce/);
  assert.ok(!/const collected\s+= .*isPreRecordsCycle/.test(sum),
    'the cutoff must still leave נגבה alone');
});

test('D: the row says so, and the drill-down groups it apart', () => {
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /const preRecords = isPreRecordsCycle\(dueDateISO\);/);
  assert.match(row, /badge pre-records/);
  // And a recorded row whose date is outside the stay is flagged, not hidden.
  assert.match(row, /const outsideStay = /);
  assert.match(row, /מחוץ לתקופת השהות/);
  assert.match(CSS, /\.badge\.pre-records \{/);
  assert.match(CSS, /\.badge\.warn \{/);

  // The drill-down lists the bucket as its own group, last, with the rule in
  // the heading rather than a total.
  const detail = fnSource(APP, 'renderRevenueDetail');
  assert.match(detail, /key: 'preRecords'/);
  assert.match(detail, /לפני תחילת הרישום — לא נספר/);
  // The composition panel names it beside צפוי, and says it is not in it.
  assert.match(fnSource(APP, 'renderRevenueExpectedComposition'), /לא נכלל בצפוי ובנטו/);
});

/* ================= E. the two screens agree ================= */

test('E: the daily list and the monthly view agree about July', () => {
  /* The same three patients, asked the same question two ways. Whoever the
   * daily גבייה list shows as due in July is exactly who הכנסות חודשיות
   * expects a July cycle from — that agreement is the whole point of there
   * being ONE stay rule. */
  const roster = [
    patient({ id: 'a', name: 'דנה כהן', date: '2026-07-10' }),                        // in
    patient({ id: 'b', name: 'עמית בורנשטיין', date: '2026-09-07', pay: 35000 }),      // not yet here
    patient({ id: 'c', name: 'רות', date: '2026-07-22', status: 'released',
              exitDate: '2026-08-20' }),                                               // in, left later
  ];
  const july = build({ patients: roster });
  const expectedNames = july.expected.rows.map((r) => r.patientName).sort();
  assert.deepEqual(plain(expectedNames), ['דנה כהן', 'רות'].sort());

  // The daily list, walked day by day across July, names the same people.
  const seen = {};
  for (let d = 1; d <= 31; d++) {
    const iso = '2026-07-' + String(d).padStart(2, '0');
    dueOn(roster, iso).forEach((n) => { seen[n] = true; });
  }
  assert.deepEqual(Object.keys(seen).sort(), ['דנה כהן', 'רות'].sort());
  assert.ok(!seen['עמית בורנשטיין'], 'the September admission is on neither screen');

  // And the due dates line up, not merely the names.
  const dailyDates = {};
  for (let d = 1; d <= 31; d++) {
    const iso = '2026-07-' + String(d).padStart(2, '0');
    dueOn(roster, iso).forEach((n) => { dailyDates[n] = iso; });
  }
  july.expected.rows.forEach((r) => {
    assert.equal(dailyDates[r.patientName], r.dueDate,
      r.patientName + ': the two screens name the same due date');
  });
});

/* ================= F. scope + security (PR #124 parity) ================= */

test('F: no backend learned anything, and no new endpoint exists', () => {
  for (const token of ['RECORDS_COMPLETE_FROM', 'preRecords', 'patientStayCoversDate']) {
    assert.ok(!SERVER.includes(token), 'server.js must not know about ' + token);
    assert.ok(!GS.includes(token), 'Code.gs must not know about ' + token);
  }
  // Read-only: nothing here writes, and no stored value is rewritten.
  for (const name of ['patientStayCoversDate', 'patientStayOverlapsRange',
                      'patientDueOnDate', 'isPreRecordsCycle', 'patientExitISO']) {
    const src = fnSource(APP, name);
    for (const writer of ['savePayment', 'apiPost', 'state.patients =', 'localStorage']) {
      assert.ok(!src.includes(writer), name + ' must not ' + writer);
    }
  }
  // The input objects are never mutated.
  const p = patient({ status: 'released', exitDate: '2026-08-20T21:00:00.000Z' });
  const before = JSON.stringify(p);
  app.patientStayCoversDate(p, '2026-07-10');
  app.patientStayOverlapsRange(p, '2026-07-01', '2026-07-31');
  app.patientDueOnDate(p, '2026-07-10');
  build({ patients: [p] });
  assert.equal(JSON.stringify(p), before, 'the patient row is byte-identical afterwards');
});

test('F: everything the new UI interpolates is escaped', () => {
  for (const name of ['renderPreRecordsNote', 'renderBillingOpenList', 'renderBillingMonthlySummary']) {
    assert.match(fnSource(APP, name), /escapeHtml\(/, name + ' must escape');
  }
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /escapeHtml\(formatDate\(RECORDS_COMPLETE_FROM\)\)/);
  // No new static markup — the note and the bucket are built by the renderer.
  assert.ok(!INDEX.includes('pre-records'), 'nothing to drift out of sync');
  assert.ok(!INDEX.includes('bill-pre-records-note'));
  // The צפוי card no longer claims to count "active patients".
  assert.ok(!INDEX.includes('מטופלים פעילים × תשלום חודשי'));
  assert.match(INDEX, /מחזורים בתוך תקופת השהות/);
});
