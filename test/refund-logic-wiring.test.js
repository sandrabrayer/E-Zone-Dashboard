/* Refund logic wiring — Phase 1b of docs/billing-control-plan.md.
 * See CHANGELOG-refund-logic-wiring.md.
 *
 * Locked contracts:
 *   - the live refund suggestion comes from the SERVER: action=suggestRefunds
 *     → refundSuggestionsFor_ → computeRefund_ (Code.gs). For the boundary
 *     fixtures of #156 every suggestion carries exactly computeRefund_'s
 *     refund, rule and cycle — through handle_ AND through the credits modal;
 *   - suggestRefunds is READ-ONLY (no sheet created, no cell written, no
 *     audit row) and gated by PROXY_SECRET: refused without it in enforce
 *     mode, not in OPEN_ACTIONS, listed in PROXY_KNOWN_ACTIONS;
 *   - payoutDate: refundPayoutDate_ (cutoff on the 10th) on the server; the
 *     app.js echo matches it on every day of 2026–2028;
 *   - saved credits are not recalculated or changed: an edit that keeps the
 *     decision date keeps the stored payoutDate, calculatedAmount, basis and
 *     reason; the modal shows the stored payout date;
 *   - unknown_house is an explicit Hebrew error in the modal — never a 0;
 *   - every rendered breakdown value goes through escapeHtml;
 *   - getData keeps its keys;
 *   - the pre-wiring client invariants still hold on the server (recorded
 *     window, blank-coverage row, overlapping windows credit no day twice,
 *     recorded prepaid window, void rows skipped, rate from money received,
 *     zero row when nothing was paid, revenue-allocation fields present).
 *
 * vm-sandbox on the REAL shipped Code.gs / app.js, per repo convention. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));
const PROXY = 'proxy-secret-for-tests';

/* ======================= Code.gs harness ======================= */

function fakeSheet(grid) {
  return {
    grid,
    getName: () => 'sheet',
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {}, hideSheet() {}, isSheetHidden() { return false; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {},
      };
    },
  };
}

function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* o.today pins "now" (Asia/Jerusalem) for the decision day; o.props are the
 * Script Properties. */
function loadGs(o) {
  const opts = o || {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, Error, isNaN, isFinite,
    Logger: { log: noop },
    __sheets: {}, __inserted: [], __props: Object.assign({}, opts.props || {}), __cache: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sandbox.__sheets[n] || null,
      getSheets: () => Object.values(sandbox.__sheets),
      insertSheet: (n) => { sandbox.__inserted.push(n); return (sandbox.__sheets[n] = fakeSheet([])); },
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null), setProperty() { return this; } }),
  };
  sandbox.CacheService = { getScriptCache: () => ({ get: (k) => sandbox.__cache[k] || null, put: (k, v) => { sandbox.__cache[k] = v; } }) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
  sandbox.ContentService = { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } };
  sandbox.Utilities = {
    getUuid: () => 'uuid',
    formatDate: (d, tz, fmt) => {
      if (opts.today && fmt === 'yyyy-MM-dd' && tz === 'Asia/Jerusalem' && Math.abs(Date.now() - d.getTime()) < 60000) return opts.today;
      if (fmt === 'yyyy-MM-dd') return formatInTz(d, tz || 'Asia/Jerusalem');
      return d.toISOString();
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__t = {
      PAYMENT_COLUMNS, CREDIT_COLUMNS, OPEN_ACTIONS, PROXY_KNOWN_ACTIONS,
      handle: (p) => handle_(p).json,
      post: (body) => doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).json,
      computeRefund: (x) => computeRefund_(x),
      payoutDate: (d) => refundPayoutDate_(d),
      upsert: (c, u) => upsertCredit_(c, u),
      readSheet: (sh, cols) => readSheet_(sh, cols),
    };`, sandbox);
  const t = sandbox.__t;
  const setPayments = (rows) => {
    const cols = Array.from(t.PAYMENT_COLUMNS);
    sandbox.__sheets.Payments = fakeSheet([cols.slice()].concat(rows.map((r) => cols.map((c) => (r[c] === undefined ? '' : r[c])))));
  };
  const snapshot = () => JSON.stringify(Object.keys(sandbox.__sheets).sort().map((k) => [k, sandbox.__sheets[k].grid]));
  return { t, sandbox, setPayments, snapshot };
}

const keyOf = (houseId, name, entry) => `${houseId}::${name}::${entry}`;
function payRow(key, over) {
  return Object.assign({
    id: 'pay::' + key + '::' + over.dueDate, patientId: key, patientName: key.split('::')[1], houseId: key.split('::')[0],
    amount: 30000, status: 'paid', amountPaid: 30000, balance: 0,
  }, over);
}
function suggest(g, houseId, entry, exit, rows, name) {
  const key = keyOf(houseId, name || 'דנה', entry);
  g.setPayments(rows ? rows(key) : [payRow(key, { dueDate: entry })]);
  return plain(g.t.handle({ action: 'suggestRefunds', houseId, entryDate: entry, exitDate: exit, patientKey: key }));
}

/* ======================= A. live path = computeRefund_ ======================= */

/* The boundary fixtures of #156: [houseId, entry, exit]. */
const FIXTURES = [
  ['ramot', '2026-09-10', '2026-10-09'],   // balance: exit on cycle end → 0
  ['ramot', '2026-09-10', '2026-10-03'],   // balance: end − 6 → 0
  ['ramot', '2026-09-10', '2026-10-02'],   // balance: end − 7 → pro-rata 7000
  ['asher', '2026-09-10', '2026-09-28'],   // balance: calendar month irrelevant → 11000
  ['rehab', '2026-09-01', '2026-09-13'],   // rehab day 13 → pro-rata 17000
  ['rehab', '2026-09-01', '2026-09-14'],   // rehab day 14 → 0
  ['pardes', '2026-09-01', '2026-09-14'],
  ['arfoni', '2026-09-01', '2026-09-13'],
  ['asher', '2026-01-31', '2026-02-21'],   // clamp: last 7 days 21/02–27/02 → 0
  ['asher', '2026-01-31', '2026-02-20'],   // clamp: → 7000
];

test('A: suggestRefunds returns computeRefund_\'s result for every boundary fixture of #156', () => {
  const g = loadGs({ today: '2026-10-01' });
  for (const [houseId, entry, exit] of FIXTURES) {
    const res = suggest(g, houseId, entry, exit);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const want = plain(g.t.computeRefund({ houseId, entryDate: entry, exitDate: exit, amountPaid: 30000, decidedDate: '2026-10-01', cycleStart: entry }));
    const du = res.suggestions.find((s) => s.creditType === 'days_unused');
    const tag = `${houseId} ${entry} → ${exit}`;
    assert.strictEqual(res.suggestions.length, 1, tag);
    assert.strictEqual(du.calculatedAmount, want.refund, tag);
    for (const k of ['rule', 'cycleStart', 'cycleEnd', 'daysStayed', 'daysNotStayed', 'dailyRate', 'stayDay', 'lastDaysFrom', 'lastDaysTo', 'payoutDate', 'uncappedRefund']) {
      assert.strictEqual(du.basis[k], want[k], tag + ' ' + k);
    }
    assert.strictEqual(du.basis.basisVersion, 2);
  }
  const amounts = FIXTURES.map(([h, e, x]) => suggest(g, h, e, x).suggestions[0].calculatedAmount);
  assert.deepStrictEqual(amounts, [0, 0, 7000, 11000, 17000, 0, 0, 17000, 0, 7000]);
});

test('A: a prepaid cycle not started at the exit returns in full beside the current cycle\'s decision (#156 fixture)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = suggest(g, 'rehab', '2026-08-01', '2026-08-20', (k) => [payRow(k, { dueDate: '2026-08-01' }), payRow(k, { dueDate: '2026-09-01' })]);
  assert.deepStrictEqual(res.suggestions.map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount, s.basis.rule]), [
    ['days_unused', '2026-08', 0, 'detox_tenure_cutoff_zero'],
    ['prepaid_return', '2026-09', 30000, 'prepaid_return'],
  ]);
  assert.strictEqual(res.suggestions[1].basis.cycleStart, '2026-09-01');
  assert.strictEqual(res.suggestions[1].basis.cycleEnd, '2026-09-30');
});

test('A: the credits modal shows the server\'s figure, rule label and breakdown (app.js → /api/sheets → handle_)', async () => {
  const g = loadGs({ today: '2026-10-01' });
  const key = keyOf('ramot', 'דנה', '2026-09-10');
  g.setPayments([payRow(key, { dueDate: '2026-09-10' })]);
  const app = loadApp((body) => g.t.handle(body));
  const patient = app.t.normalizePatient({ id: 'pt-1', houseId: 'ramot', name: 'דנה', date: '2026-09-10', pay: 30000, status: 'released', exitDate: '2026-10-02' });
  await app.t.showCreditsModal({ patient, patientId: 'pt-1', patientKey: key, exitDate: '2026-10-02' });
  const html = app.modalHtml();
  assert.ok(html.includes('מחושב: <b>' + app.t.fmtShekel(7000) + '</b>'), 'the computeRefund_ figure');
  assert.ok(html.includes('מגורים — זיכוי יחסי על הימים שלא שהה'));
  for (const s of ['מחזור:', '10/09/2026 – 09/10/2026', 'ימים ששהה במחזור:', 'ימים שלא שהה:', 'תעריף יומי:',
    '7 הימים האחרונים במחזור:', '03/10/2026 – 09/10/2026', 'ישולם ב־15/10/2026']) {
    assert.ok(html.includes(s), 'breakdown shows ' + s);
  }
  assert.deepStrictEqual(app.errors(), []);
  assert.deepStrictEqual(app.sent().map((b) => b.action), ['suggestRefunds']);
  const body = app.sent()[0];
  assert.deepStrictEqual([body.houseId, body.entryDate, body.exitDate, body.patientKey], ['ramot', '2026-09-10', '2026-10-02', key]);
});

test('A: rule labels in Hebrew — «7 הימים האחרונים במחזור — ללא זיכוי», «יום 14 ומעלה — ללא זיכוי»', async () => {
  const g = loadGs({ today: '2026-10-01' });
  const run = async (houseId, entry, exit) => {
    const key = keyOf(houseId, 'דנה', entry);
    g.setPayments([payRow(key, { dueDate: entry })]);
    const app = loadApp((body) => g.t.handle(body));
    const patient = app.t.normalizePatient({ id: 'p', houseId, name: 'דנה', date: entry, pay: 30000, status: 'released', exitDate: exit });
    await app.t.showCreditsModal({ patient, patientId: 'p', patientKey: key, exitDate: exit });
    return app.modalHtml();
  };
  const bal = await run('asher', '2026-09-10', '2026-10-03');
  assert.ok(bal.includes('7 הימים האחרונים במחזור — ללא זיכוי'));
  assert.ok(bal.includes('לפני הכלל: ' + loadApp(() => ({})).t.fmtShekel(6000)), 'the raw figure is on record');
  const dtx = await run('rehab', '2026-09-01', '2026-09-14');
  assert.ok(dtx.includes('יום 14 ומעלה — ללא זיכוי'));
  assert.ok(dtx.includes('יום שהייה ביציאה:'));
});

/* ======================= B. payout date ======================= */

test('B: payout on the 10th vs the 11th — suggestRefunds, a new saved credit, and the app.js echo agree', () => {
  for (const [today, payout] of [['2026-10-10', '2026-10-15'], ['2026-10-11', '2026-11-15'], ['2026-12-11', '2027-01-15']]) {
    const g = loadGs({ today });
    const res = suggest(g, 'ramot', '2026-09-10', '2026-09-28');
    assert.strictEqual(res.decidedDate, today);
    assert.strictEqual(res.payoutDate, payout, today);
    assert.strictEqual(res.suggestions[0].basis.payoutDate, payout);
    const saved = g.t.upsert({ patientId: 'pt-1', patientKey: 'ramot::דנה::2026-09-10', patientName: 'דנה', houseId: 'ramot',
      creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 11000, amount: 11000, decidedDate: today, basis: {} }, 'ורד');
    assert.strictEqual(saved.credit.payoutDate, payout, 'saved ' + today);
  }
});

test('B: app.js payoutDateFor matches refundPayoutDate_ on every day of 2026–2028 (parity)', () => {
  const g = loadGs();
  const app = loadApp(() => ({}));
  let n = 0;
  for (let d = new Date(Date.UTC(2026, 0, 1)); d < new Date(Date.UTC(2029, 0, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    assert.strictEqual(app.t.payoutDateFor(iso), g.t.payoutDate(iso), iso);
    n++;
  }
  assert.strictEqual(n, 1096);
});

/* ======================= C. saved credits untouched ======================= */

const LEGACY = {
  id: 'credit::pt-1::2026-09::1', patientId: 'pt-1', patientKey: 'ramot::דנה::2026-07-01', patientName: 'דנה', houseId: 'ramot',
  facilityType: 'residential', creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 4800, amount: 4800,
  overrideReason: '', reason: 'מגורים — שחרור בשבוע האחרון של החודש | trail', approvedBy: '', decidedDate: '2026-09-14',
  payoutDate: '2026-09-15', status: 'pending', paidDate: '', method: '', notes: '',
  basis: '{"rule":"residential_last_days_zero","uncappedAmount":4800}', createdAt: '2026-09-14T08:00:00.000Z', createdBy: 'ורד',
  updatedAt: '2026-09-14T08:00:00.000Z', updatedBy: 'ורד', creditUid: 'crd-legacy',
};
function withLegacyCredit(g) {
  const cols = Array.from(g.t.CREDIT_COLUMNS);
  g.sandbox.__sheets.Credits = fakeSheet([cols.slice(), cols.map((c) => LEGACY[c])]);
}

test('C: a credit saved under the old 15th cutoff keeps its payoutDate, amount, basis and reason when re-saved', () => {
  const g = loadGs();
  withLegacyCredit(g);
  const res = g.t.upsert({ id: LEGACY.id, updatedAt: LEGACY.updatedAt, decidedDate: '2026-09-14', notes: 'נבדק' }, 'ורד');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.credit.payoutDate, '2026-09-15', 'not moved to 2026-10-15 by the new cutoff');
  assert.strictEqual(res.credit.calculatedAmount, 4800);
  assert.strictEqual(res.credit.amount, 4800);
  assert.strictEqual(res.credit.basis, LEGACY.basis);
  assert.strictEqual(res.credit.reason, LEGACY.reason);
  // Changing the decision date is a new decision → the current rule.
  const moved = g.t.upsert({ id: LEGACY.id, updatedAt: res.credit.updatedAt, decidedDate: '2026-10-05' }, 'ורד');
  assert.strictEqual(moved.credit.payoutDate, '2026-10-15');
});

test('C: suggestRefunds is read-only — no sheet created, no cell written, Credits untouched (with and without a Payments tab)', () => {
  const g = loadGs({ today: '2026-10-01' });
  withLegacyCredit(g);
  g.setPayments([payRow(keyOf('ramot', 'דנה', '2026-07-01'), { dueDate: '2026-09-01' })]);
  const before = g.snapshot();
  const res = plain(g.t.handle({ action: 'suggestRefunds', houseId: 'ramot', entryDate: '2026-07-01', exitDate: '2026-09-20', patientKey: 'ramot::דנה::2026-07-01' }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(g.snapshot(), before, 'every grid byte-identical');
  assert.deepStrictEqual(g.sandbox.__inserted, []);
  const empty = loadGs({ today: '2026-10-01' });
  const r2 = plain(empty.t.handle({ action: 'suggestRefunds', houseId: 'ramot', entryDate: '2026-07-01', exitDate: '2026-09-20', patientKey: 'ramot::דנה::2026-07-01' }));
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(Object.keys(empty.sandbox.__sheets), [], 'no Payments tab → nothing created');
});

test('C: the modal shows a saved credit as saved — stored payout date, stored amount, legacy rule label, no duplicate suggestion', async () => {
  const g = loadGs({ today: '2026-10-01' });
  const key = 'ramot::דנה::2026-07-01';
  g.setPayments([payRow(key, { dueDate: '2026-09-01' })]);
  const app = loadApp((body) => g.t.handle(body));
  app.t.state.credits = [app.t.normalizeCredit(LEGACY)];
  const patient = app.t.normalizePatient({ id: 'pt-1', houseId: 'ramot', name: 'דנה', date: '2026-07-01', pay: 30000, status: 'released', exitDate: '2026-09-20' });
  await app.t.showCreditsModal({ patient, patientId: 'pt-1', patientKey: key, exitDate: '2026-09-20' });
  const html = app.modalHtml();
  assert.strictEqual((html.match(/class="credit-line"/g) || []).length, 1, 'the saved 2026-09 days_unused line only');
  assert.ok(html.includes('מחושב: <b>' + app.t.fmtShekel(4800) + '</b>'), 'stored calculatedAmount, not recomputed');
  assert.ok(html.includes('ישולם ב־15/09/2026'), 'stored payout date');
  assert.ok(html.includes('מגורים — שחרור בשבוע האחרון של החודש: אין זיכוי ימים'), 'labelled with the rule it was decided under');
  const lines = app.t.buildCreditLines(app.t.state.credits, [], '2026-10-01');
  assert.strictEqual(app.t.linePayoutDate(lines[0], '2026-09-14'), '2026-09-15');
  assert.strictEqual(app.t.linePayoutDate(lines[0], '2026-10-05'), '2026-10-15', 'a changed decision date takes the current rule');
});

/* ======================= D. unknown_house ======================= */

test('D: unknown_house → explicit error from the server, and a Hebrew error in the modal — never a 0', async () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = plain(g.t.handle({ action: 'suggestRefunds', houseId: 'nowhere', entryDate: '2026-09-01', exitDate: '2026-09-10', patientKey: 'nowhere::דנה::2026-09-01' }));
  assert.deepStrictEqual(res, { ok: false, error: 'unknown_house', field: 'houseId' });
  const app = loadApp((body) => g.t.handle(body));
  const patient = app.t.normalizePatient({ id: 'p', houseId: 'nowhere', name: 'דנה', date: '2026-09-01', pay: 1, status: 'released', exitDate: '2026-09-10' });
  await app.t.showCreditsModal({ patient, patientId: 'p', patientKey: 'nowhere::דנה::2026-09-01', exitDate: '2026-09-10' });
  const html = app.modalHtml();
  assert.match(html, /<div class="credit-error" role="alert">לא ניתן לחשב זיכוי: הבית של המטופל לא מוכר במערכת/);
  assert.ok(!html.includes('class="credit-line"'), 'no suggested line, so no silent 0');
  assert.ok(app.errors().some((m) => m.includes('הבית של המטופל לא מוכר')), 'and the banner says so');
  // A network failure is an error too, never an empty "no refund".
  const down = loadApp(() => { throw new Error('offline'); });
  await down.t.showCreditsModal({ patient, patientId: 'p', patientKey: 'x', exitDate: '2026-09-10' });
  assert.match(down.modalHtml(), /class="credit-error"/);
});

/* ======================= E. escaping ======================= */

test('E: every breakdown value is escaped', () => {
  const app = loadApp(() => ({}));
  const evil = '<img src=x onerror=alert(1)>';
  const html = app.t.creditBreakdownHtml({
    basisVersion: 2, rule: evil, cycleStart: evil, cycleEnd: evil, cycleDays: evil, daysStayed: evil, daysNotStayed: evil,
    dailyRate: 1, amountPaid: 30, divisor: evil, facilityType: 'residential', lastDaysFrom: evil, lastDaysTo: evil,
    alreadyCreditedThrough: evil,
  });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'));
  assert.strictEqual(app.t.creditBreakdownHtml({ rule: 'residential_prorata' }), '', 'a legacy basis renders no breakdown');
});

/* ======================= F. gate ======================= */

test('F: suggestRefunds is gated by PROXY_SECRET — refused without it in enforce mode, served with it; not an open action', () => {
  const body = { action: 'suggestRefunds', houseId: 'ramot', entryDate: '2026-09-10', exitDate: '2026-09-28', patientKey: 'ramot::דנה::2026-09-10' };
  const en = loadGs({ today: '2026-10-01', props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  assert.deepStrictEqual(plain(en.t.post(body)), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(plain(en.t.post(Object.assign({ proxySecret: 'wrong' }, body))), { ok: false, error: 'unauthorized' });
  const ok = plain(en.t.post(Object.assign({ proxySecret: PROXY, proxyUser: 'ורד' }, body)));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.suggestions.length, 1);
  assert.ok(!Array.from(en.t.OPEN_ACTIONS).includes('suggestRefunds'));
  assert.ok(Array.from(en.t.PROXY_KNOWN_ACTIONS).includes('suggestRefunds'));
});

/* ======================= G. getData ======================= */

test('G: getData keeps its keys (the refund wiring adds nothing to it)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = plain(g.t.handle({ action: 'getData' }));
  assert.deepStrictEqual(Object.keys(res).sort(), [
    'billingOverrides', 'currentManagers', 'currentManagersSource', 'dischargedPatients', 'houseManagers',
    'irrelevantLeads', 'leads', 'managerPhones', 'ok', 'patients', 'removedLeads',
  ]);
});

/* ======================= H. invariants ported from the client ======================= */

test('H: the RECORDED window wins; a blank-coverage row uses its cycle (ported from payment-coverage-period E)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const rec = suggest(g, 'ramot', '2026-01-20', '2026-03-10',
    (k) => [payRow(k, { dueDate: '2026-01-20', amountPaid: 3000, coverageStart: '2026-03-01', coverageEnd: '2026-03-31' })]);
  const du = rec.suggestions.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(du.basis.coverageStart, '2026-03-01');
  assert.strictEqual(du.basis.coverageEnd, '2026-03-31');
  assert.strictEqual(du.basis.coverageWindowSource, 'recorded');
  assert.strictEqual(du.basis.unusedDays, 21, '11–31 March');
  assert.strictEqual(du.basis.dailyRate, 100);
  assert.strictEqual(du.calculatedAmount, 2100);
  const blank = suggest(g, 'ramot', '2026-01-20', '2026-02-01', (k) => [payRow(k, { dueDate: '2026-01-20', amountPaid: 3000 })]);
  const b = blank.suggestions[0];
  assert.strictEqual(b.basis.coverageStart, '2026-01-20');
  assert.strictEqual(b.basis.coverageEnd, '2026-02-19');
  assert.strictEqual(b.basis.coverageWindowSource, 'inferred');
  assert.strictEqual(b.basis.unusedDays, 18, '2–19 February');
});

test('H: OVERLAPPING windows credit no day twice (ported from payment-coverage-period E)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = suggest(g, 'ramot', '2026-01-20', '2026-03-05', (k) => [
    payRow(k, { id: 'a', dueDate: '2026-02-20', amountPaid: 3000, coverageStart: '2026-03-01', coverageEnd: '2026-03-31' }),
    payRow(k, { id: 'b', dueDate: '2026-03-01', amountPaid: 3000, coverageStart: '2026-03-03', coverageEnd: '2026-04-09' }),
  ]);
  const unused = res.suggestions.filter((s) => s.creditType === 'days_unused');
  assert.strictEqual(res.suggestions.filter((s) => s.creditType === 'prepaid_return').length, 0);
  assert.deepStrictEqual(unused.map((s) => s.basis.unusedDays).sort((x, y) => x - y), [9, 26]);
  assert.strictEqual(unused[1].basis.alreadyCreditedThrough, '2026-03-31');
  assert.strictEqual(unused[1].basis.creditedFrom, '2026-04-01');
  assert.strictEqual(unused[1].calculatedAmount, 900, '9 × 100 — never the 35 days of its whole tail');
});

test('H: a recorded window after the exit is prepaid_return in full (ported from monthly-revenue H)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = suggest(g, 'ramot', '2026-01-20', '2026-02-10',
    (k) => [payRow(k, { dueDate: '2026-01-20', amount: 3100, amountPaid: 3100, coverageStart: '2026-03-01', coverageEnd: '2026-03-31' })]);
  const pre = res.suggestions.find((s) => s.creditType === 'prepaid_return');
  assert.strictEqual(pre.basis.coverageStart, '2026-03-01');
  assert.strictEqual(pre.basis.coverageEnd, '2026-03-31');
  assert.strictEqual(pre.basis.coverageWindowSource, 'recorded');
  assert.strictEqual(pre.calculatedAmount, 3100);
  const zero = res.suggestions.find((s) => s.creditType === 'days_unused');
  assert.strictEqual(zero.calculatedAmount, 0, 'no paid cycle holds the exit → a recorded zero, not silence');
  assert.strictEqual(zero.basis.coverageWindowSource, 'no_payment_row');
});

test('H: a VOID payment refunds nothing (ported from duplicate-payment-void B)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const live = suggest(g, 'arfoni', '2026-09-01', '2026-09-10');
  assert.ok(live.suggestions.some((s) => s.calculatedAmount > 0), 'a real payment does refund');
  for (const status of ['void', 'מבוטל']) {
    const dead = suggest(g, 'arfoni', '2026-09-01', '2026-09-10', (k) => [payRow(k, { dueDate: '2026-09-01', status })]);
    assert.ok(!dead.suggestions.some((s) => s.calculatedAmount > 0), status);
  }
});

test('H: the rate follows money RECEIVED; nothing paid → one zero row; other patients never leak in', () => {
  const g = loadGs({ today: '2026-10-01' });
  const part = suggest(g, 'asher', '2026-09-01', '2026-09-06', (k) => [payRow(k, { dueDate: '2026-09-01', amountPaid: 3000, status: 'partial' })]);
  assert.strictEqual(part.suggestions[0].basis.dailyRate, 100);
  assert.strictEqual(part.suggestions[0].basis.unusedDays, 24);
  assert.strictEqual(part.suggestions[0].calculatedAmount, 2400);
  const none = suggest(g, 'asher', '2026-09-01', '2026-09-10', () => [payRow(keyOf('asher', 'אחר', '2026-09-01'), { dueDate: '2026-09-01' })]);
  assert.strictEqual(none.suggestions.length, 1);
  assert.strictEqual(none.suggestions[0].calculatedAmount, 0);
  assert.strictEqual(none.suggestions[0].allocationMonth, '2026-09');
  assert.strictEqual(none.suggestions[0].basis.coverageWindowSource, 'no_payment_row');
});

test('H: blank patientId joins by the payment id; a due date off the cycle uses its own month; a timestamp exit stays on its Jerusalem day', () => {
  const g = loadGs({ today: '2026-10-01' });
  const blankId = suggest(g, 'asher', '2026-09-01', '2026-09-06', (k) => [payRow(k, { dueDate: '2026-09-01', patientId: '' })]);
  assert.strictEqual(blankId.suggestions[0].calculatedAmount, 24000);
  const off = suggest(g, 'asher', '2026-09-01', '2026-09-20', (k) => [payRow(k, { dueDate: '2026-09-15' })]);
  assert.strictEqual(off.suggestions[0].basis.coverageWindowSource, 'due_date');
  assert.strictEqual(off.suggestions[0].basis.cycleStart, '2026-09-15');
  assert.strictEqual(off.suggestions[0].basis.cycleEnd, '2026-10-14');
  const ts = suggest(g, 'asher', '2026-09-01', '2026-08-31T21:00:00.000Z');
  assert.strictEqual(ts.suggestions[0].basis.exitDate, '2026-09-01', 'not the sliced UTC day');
});

test('H: every suggestion carries the fields the revenue screen allocates by (coverageStart / coverageEnd / creditedFrom)', () => {
  const g = loadGs({ today: '2026-10-01' });
  const res = suggest(g, 'ramot', '2026-09-10', '2026-09-28');
  const b = res.suggestions[0].basis;
  assert.strictEqual(b.coverageStart, '2026-09-10');
  assert.strictEqual(b.coverageEnd, '2026-10-09');
  assert.strictEqual(b.creditedFrom, '2026-09-29');
  const app = loadApp(() => ({}));
  const span = app.t.creditRefundSpan({ creditType: 'days_unused', allocationMonth: '2026-09', basis: b });
  assert.strictEqual(span.source, 'coverage_window');
  assert.strictEqual(app.t.isoFromLocalDate(span.start), '2026-09-29');
  assert.strictEqual(app.t.isoFromLocalDate(span.end), '2026-10-09');
});

/* ======================= app.js harness ======================= */

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '', value: '', hidden: false,
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

/* `server(body)` answers /api/sheets POSTs (it may throw → network error). */
function loadApp(server) {
  const sent = [];
  const created = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      getElementById: () => fakeEl(),
      createElement: () => { const el = fakeEl(); created.push(el); return el; },
      querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Intl, Set, Map,
    setTimeout, clearTimeout,
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      sent.push(body);
      let payload;
      try { payload = plain(server(body)); } catch (e) { return Promise.reject(e); }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    showError = (m) => { globalThis.__errors.push(String(m)); };
    renderAll = () => {};
    globalThis.__errors = [];
    globalThis.__t = {
      state, normalizePatient, normalizeCredit, showCreditsModal, buildCreditLines, linePayoutDate,
      creditBreakdownHtml, payoutDateFor, fmtShekel, creditRefundSpan, isoFromLocalDate,
    };`, sandbox);
  return {
    t: sandbox.__t,
    sent: () => sent.map((b) => plain(b)),
    errors: () => Array.from(sandbox.__errors),
    modalHtml: () => (created.find((el) => /credits-modal/.test(el.innerHTML)) || { innerHTML: '' }).innerHTML,
  };
}
