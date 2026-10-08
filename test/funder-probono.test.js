/* Pro-bono — the fifth funder (פרו-בונו / probono). See
 * CHANGELOG-funder-probono.md.
 *
 * Locked here:
 *   - the key / label sets: Code.gs PAYMENT_FUNDERS == lib rules ==
 *     funder.js LABEL_TO_KEY, five entries, pro-bono APPENDED LAST; every
 *     select (admission, card editor, fill screen, payment form, גבייה
 *     filter) offers it last;
 *   - debtAging_: a cycle whose start day falls in a pro-bono period is
 *     absent from byPatient, byHouse and totals (counted in probonoExcluded);
 *     a mid-stay switch drops only the cycles from that date on;
 *   - the invariant: the five funders + unset still sum to the totals, and
 *     the strip always carries a ₪0 פרו-בונו row;
 *   - the page: the due list, «יתרות פתוחות» and the renewal / overdue
 *     alerts skip a row whose patient is pro-bono on its date; the report
 *     form never prefills pro-bono;
 *   - Ortal's digest is NOT affected: every payment received is listed,
 *     pro-bono or not (money received is always reported);
 *   - a payment for a pro-bono patient is allowed with an explicit funder;
 *     the savePayment fill path refuses (funder_probono_explicit);
 *   - the cleanup workbook's «מטופלי פרו-בונו» tab;
 *   - restricted sessions: unchanged.
 *
 * vm sandboxes on the real Code.gs, app.js, funder.js and the shared rules.
 * TZ pinned to Israel. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const FUNDER_SRC = read('public', 'funder.js');
const SW_SRC = read('public', 'sw.js');
const Funder = require('../public/funder.js');
const rules = require('../lib/payment-report-rules.js');
const cleanup = require('../lib/cleanup-xlsx.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const r2 = (n) => Math.round(n * 100) / 100;

const TODAY = '2026-09-30';
const PB = 'פרו-בונו';
const LABELS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי', PB];
const KEYS = ['private', 'btl', 'mod', 'maccabi', 'probono'];
const BUCKETS = KEYS.concat(['unset']);
const KINDS = ['recorded_debt', 'unrecorded_cycles'];

const GS = loadGs();
const frow = (patientId, funder, effectiveFrom, setAt) => ({ patientId, funder, effectiveFrom, setBy: 'ורד', setAt: setAt || '2026-06-01T09:00:00+03:00' });

/* ---- a REAL debtAging_ report ---- */
const AVI = 'ramot::אבי בדיקה::2026-07-10';
const GAL = 'rehab::גל בדיקה::2026-07-05';
const PATIENTS = [
  { id: 'id-avi', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, status: 'active' },  // pro-bono throughout
  { id: 'id-gal', houseId: 'rehab', name: 'גל בדיקה', date: '2026-07-05', pay: 20000, status: 'active' },   // switches mid-stay
  { id: 'id-bat', houseId: 'ramot', name: 'בת בדיקה', date: '2026-07-20', pay: 25000, status: 'active' },   // private
];
const pay = (pid, due, f) => Object.assign({ id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due }, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(AVI, '2026-08-10', { amount: 30000, status: 'partial', amountPaid: 1000, chargedAt: '2026-08-11T10:00:00+03:00' }),
  pay(GAL, '2026-07-05', { amount: 20000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-08-05', { amount: 20000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-09-05', { amount: 20000, status: 'unpaid', amountPaid: 0 }),
];
const HIST = [
  frow('id-avi', PB, '2026-07-01'),
  frow('id-gal', 'פרטי', '2026-07-01'), frow('id-gal', PB, '2026-08-05'),   // pro-bono from the 2nd cycle on
  frow('id-bat', 'פרטי', '2026-07-01'),
];
const rowsOf = (l) => ({ rows: l.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
function aging(asOf, funders) {
  return plain(GS.sandbox.debtAging_(asOf, {
    patients: rowsOf(PATIENTS), payments: rowsOf(PAYMENTS), credits: rowsOf([]), overrides: rowsOf([]),
    funders: rowsOf(funders === undefined ? HIST : funders),
  }));
}
const cyclesOf = (rep, id) => ((rep.byPatient.find((p) => p.patientId === id) || {}).cycles || []);

/* ============================ the key / label sets ============================ */

test('guard: five funders, pro-bono APPENDED LAST — Code.gs == rules == funder.js, exact strings, in order', () => {
  assert.deepEqual(Array.from(GS.run('PAYMENT_FUNDERS')), LABELS);
  assert.deepEqual(Array.from(rules.PAYMENT_FUNDERS), LABELS);
  assert.deepEqual(Object.keys(Funder.LABEL_TO_KEY), LABELS);
  assert.deepEqual(Object.values(Funder.LABEL_TO_KEY), KEYS);
  assert.deepEqual([...Funder.FUNDER_KEYS], KEYS);
  assert.equal(GS.run('FUNDER_PROBONO'), PB);
  assert.equal(rules.FUNDER_PROBONO, PB);
  assert.equal(Funder.FUNDER_PROBONO, 'probono');
  assert.equal(Funder.keyFromLabel(PB), 'probono');
  assert.equal(Funder.labelFor('probono'), PB);
  for (const bad of ['פרו בונו', 'פרובונו', ' פרו-בונו', 'probono', 'Pro-bono']) assert.equal(Funder.keyFromLabel(bad), 'unset', bad);
  // the four existing positions never move (append-only)
  assert.deepEqual(LABELS.slice(0, 4), ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי']);
  // the shared message map stays word-for-word on both sides
  assert.deepEqual(plain(GS.run('PAYMENT_REPORT_MESSAGES')), plain(rules.MESSAGES));
  assert.equal(rules.MESSAGES.funder_probono_explicit, 'המטופל פרו-בונו — יש לבחור גורם מממן בדיווח במפורש');
});

test('guard: app.js carries no funder label literal (pro-bono included) — it reads the shared lists', () => {
  assert.ok(!/['"`]פרו-בונו['"`]/.test(APP_SRC), 'no pro-bono literal in app.js');
  assert.ok(/const FUNDER_PROBONO_KEY = 'probono';/.test(APP_SRC));
});

/* ============================ debtAging_ ============================ */

test('debtAging_: a pro-bono patient\'s cycles are absent from byPatient, byHouse and totals', () => {
  const none = aging(TODAY, []);
  const with_ = aging(TODAY, HIST);
  assert.equal(with_.ok, true);
  assert.ok(cyclesOf(none, 'id-avi').length >= 3, 'without the Funders rows Avi owes');
  assert.equal(with_.byPatient.some((p) => p.patientId === 'id-avi'), false, 'Avi is gone from byPatient');
  // the totals drop by exactly Avi's balances, per figure
  for (const k of KINDS) {
    const avi = r2(cyclesOf(none, 'id-avi').filter((c) => (k === 'recorded_debt' ? c.kind === 'recorded' : c.kind === 'unrecorded')).reduce((s, c) => s + c.balance, 0));
    const galLater = r2(cyclesOf(none, 'id-gal').filter((c) => c.start >= '2026-08-05' && (k === 'recorded_debt' ? c.kind === 'recorded' : c.kind === 'unrecorded')).reduce((s, c) => s + c.balance, 0));
    assert.equal(with_.totals[k].total, r2(none.totals[k].total - avi - galLater), k);
    // byHouse sums to totals
    assert.equal(r2(with_.byHouse.reduce((s, h) => s + h[k].total, 0)), with_.totals[k].total, k + ' byHouse');
    assert.equal(r2(with_.byPatient.reduce((s, p) => s + p.cycles.filter((c) => (k === 'recorded_debt' ? c.kind === 'recorded' : c.kind === 'unrecorded')).reduce((a, c) => a + c.balance, 0), 0)), with_.totals[k].total, k + ' byPatient');
  }
  const ramot = with_.byHouse.find((h) => h.houseId === 'ramot');
  const batOnly = r2(cyclesOf(with_, 'id-bat').reduce((s, c) => s + c.balance, 0));
  assert.equal(r2(ramot.recorded_debt.total + ramot.unrecorded_cycles.total), batOnly, 'ramot holds Bat only');
  assert.equal(with_.probonoExcluded.patients, 2);
  assert.equal(with_.probonoExcluded.count, cyclesOf(none, 'id-avi').length + cyclesOf(none, 'id-gal').filter((c) => c.start >= '2026-08-05').length);
});

test('debtAging_: switching to pro-bono mid-stay removes ONLY the cycles from that date on', () => {
  const before = cyclesOf(aging(TODAY, []), 'id-gal').map((c) => c.start);
  const after = cyclesOf(aging(TODAY, HIST), 'id-gal').map((c) => c.start);
  assert.deepEqual(before, ['2026-07-05', '2026-08-05', '2026-09-05']);
  assert.deepEqual(after, ['2026-07-05'], 'the July cycle (private) stays; August on are pro-bono');
  // a switch BACK to private re-opens the cycles from that date on
  const back = cyclesOf(aging(TODAY, HIST.concat([frow('id-gal', 'פרטי', '2026-09-05')])), 'id-gal').map((c) => c.start);
  assert.deepEqual(back, ['2026-07-05', '2026-09-05']);
  // an as-of BEFORE the switch: nothing pro-bono yet
  assert.deepEqual(cyclesOf(aging('2026-07-31', HIST), 'id-gal').map((c) => c.start), ['2026-07-05']);
  // a later-dated pro-bono row with an earlier setAt still wins by effectiveFrom
  const fut = cyclesOf(aging(TODAY, [frow('id-gal', PB, '2026-09-05', '2026-01-01T00:00:00+02:00'), frow('id-gal', 'פרטי', '2026-07-01')]), 'id-gal').map((c) => c.start);
  assert.deepEqual(fut, ['2026-07-05', '2026-08-05']);
});

test('debtAging_: no Funders tab → unchanged (nothing pro-bono); debtAgingAction_ reads the Funders tab', () => {
  const noTab = plain(GS.sandbox.debtAging_(TODAY, { patients: rowsOf(PATIENTS), payments: rowsOf(PAYMENTS), credits: rowsOf([]), overrides: rowsOf([]) }));
  assert.deepEqual(noTab.totals, aging(TODAY, []).totals);
  assert.equal(noTab.probonoExcluded.count, 0);
  const g = loadGs();
  const S = g.sandbox.__sheets;
  const tab = (name, colsExpr, list) => {
    const cols = Array.from(g.run(colsExpr));
    S[name] = richSheet(name, cols);
    list.forEach((o) => S[name].appendRow(cols.map((c) => (o[c] === undefined ? '' : o[c]))));
  };
  tab('Patients', 'PATIENT_COLUMNS', PATIENTS);
  tab('Payments', 'PAYMENT_COLUMNS', PAYMENTS);
  tab('Funders', 'FUNDER_COLUMNS', HIST);
  const out = plain(g.sandbox.debtAgingAction_({ asOf: TODAY }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.totals, aging(TODAY, HIST).totals);
  assert.equal(out.byPatient.some((p) => p.patientId === 'id-avi'), false);
});

test('invariant: the five funders + unset still sum to the totals; the pro-bono bucket is ₪0', () => {
  for (const asOf of ['2026-08-31', '2026-09-15', TODAY]) {
    const rep = aging(asOf, HIST);
    for (const hist of [HIST, [], [frow('id-bat', 'מכבי', '2026-07-01')]]) {
      const split = Funder.debtByFunder(rep, hist, asOf);
      assert.deepEqual(Object.keys(split).sort(), [...BUCKETS].sort());
      for (const k of KINDS) {
        assert.equal(r2(BUCKETS.reduce((s, f) => s + split[f][k].total, 0)), rep.totals[k].total, asOf + ' ' + k);
        assert.equal(BUCKETS.reduce((s, f) => s + split[f][k].count, 0), rep.totals[k].count);
        for (const h of rep.byHouse) {
          assert.equal(r2(BUCKETS.reduce((s, f) => s + (((split[f].byHouse[h.houseId] || {})[k]) || { total: 0 }).total, 0)), h[k].total);
        }
      }
      if (hist === HIST) for (const k of KINDS) assert.equal(split.probono[k].total, 0, 'the server already dropped them');
    }
  }
});

/* ============================ Ortal's digest ============================ */

test('digest: money received is ALWAYS reported — a pro-bono patient\'s payments stay in Ortal\'s email, whatever the funder', () => {
  const at = (iso) => iso + 'T10:00:00+03:00';
  const rows = [
    { id: 'a1', patientUid: 'id-avi', patientName: 'אבי בדיקה', houseId: 'ramot', dueDate: '2026-09-10', amount: 100, amountPaid: 100, status: 'paid', chargedAt: at('2026-09-28') },
    { id: 'g1', patientUid: 'id-gal', patientName: 'גל בדיקה', houseId: 'rehab', dueDate: '2026-07-05', receivedDate: '2026-07-20', amount: 200, amountPaid: 200, status: 'paid', chargedAt: at('2026-09-28') },
    { id: 'g2', patientUid: 'id-gal', patientName: 'גל בדיקה', houseId: 'rehab', dueDate: '2026-09-05', amount: 300, amountPaid: 300, status: 'paid', chargedAt: at('2026-09-28') },
    { id: 'b1', patientUid: 'id-bat', patientName: 'בת בדיקה', houseId: 'ramot', dueDate: '2026-09-20', amount: 400, amountPaid: 400, status: 'paid', chargedAt: at('2026-09-28') },
  ];
  const since = Date.parse('2026-09-27T00:00:00+03:00'), until = Date.parse('2026-09-29T00:00:00+03:00');
  const ALL = ['אבי בדיקה:100', 'בת בדיקה:400', 'גל בדיקה:200', 'גל בדיקה:300'];
  const names = (out) => plain(out).map((r) => r.patientName + ':' + r.amount).sort();
  // Through the real digestBuild_, with a Funders tab where Avi is pro-bono
  // throughout and Gal from 05/08: every payment is still listed.
  const g = loadGs();
  const S = g.sandbox.__sheets;
  const tab = (name, colsExpr, list) => {
    const cols = Array.from(g.run(colsExpr));
    S[name] = richSheet(name, cols);
    list.forEach((o) => S[name].appendRow(cols.map((c) => (o[c] === undefined ? '' : o[c]))));
  };
  tab('Payments', 'PAYMENT_COLUMNS', rows);
  tab('Funders', 'FUNDER_COLUMNS', HIST);
  const props = { getProperty: (k) => (k === 'DIGEST_LAST_AT' ? '2026-09-27T00:00:00+03:00' : null) };
  const built = g.sandbox.digestBuild_(props, new Date(until), true);
  assert.deepEqual(names(built.rows), ALL, 'nobody is skipped for being pro-bono');
  assert.deepEqual(names(GS.sandbox.digestSelect_(rows, since, until, {})), ALL);
  // The digest never consults the Funders tab (pro-bono stays out of it).
  const src = read('apps-script', 'Code.gs');
  for (const fn of ['digestSelect_', 'digestBuild_']) {
    const body = src.slice(src.indexOf('function ' + fn + '('), src.indexOf('\n}\n', src.indexOf('function ' + fn + '(')));
    assert.ok(!/fundersRows_|probono|FUNDER_PROBONO/i.test(body), fn + ' knows nothing about funders');
  }
});

/* ============================ the cleanup workbook ============================ */

test('cleanup: «מטופלי פרו-בונו» lists the pro-bono patients (now, or with cycles left out); the tab is built after «חסר גורם מממן» (then «גורם מממן ברירת מחדל»)', () => {
  const t = { patients: rowsOf(PATIENTS), payments: rowsOf(PAYMENTS), credits: rowsOf([]), overrides: rowsOf([]), funders: rowsOf(HIST) };
  const r = plain(GS.sandbox.cleanupReport_(TODAY, t));
  assert.equal(r.ok, true);
  // The defaulted-funder tab (CHANGELOG-defaulted-funder-report.md) was appended after it.
  assert.deepEqual(Array.from(GS.run('CLEANUP_SECTION_KEYS')).slice(-2), ['probono', 'defaultedFunder']);
  assert.deepEqual(r.sections.probono.map((x) => [x.kind, x.name, x.from, x.current]),
    [['probono', 'אבי בדיקה', '2026-07-01', PB], ['probono', 'גל בדיקה', '2026-08-05', PB]]);
  assert.equal(r.counts.probono, 2);
  // switched back: still listed for the cycles that were left out, «from» empty
  const back = plain(GS.sandbox.cleanupReport_(TODAY, Object.assign({}, t, { funders: rowsOf(HIST.concat([frow('id-gal', 'פרטי', '2026-09-05')])) })));
  const gal = back.sections.probono.find((x) => x.name === 'גל בדיקה');
  assert.equal(gal.from, '');
  assert.equal(gal.current, 'פרטי');
  assert.equal(gal.excludedCycles, 1);
  // the workbook
  assert.equal(cleanup.TABS[cleanup.TABS.length - 2].key, 'probono');
  const spec = cleanup.buildCleanupSpec(r, new Date('2026-09-30T08:00:00Z'));
  const tab = spec.sheets.find((s) => s.name === 'מטופלי פרו-בונו');
  assert.ok(tab);
  assert.equal(tab.rows.length, 2);
  assert.equal(tab.rows[0].owner, 'ורד');
  assert.ok(tab.columns.some((c) => c.header === 'פרו-בונו מתאריך'));
  // an older Code.gs without the section still renders
  const older = plain(r); delete older.sections.probono;
  assert.equal(cleanup.isCleanupResponse(older), true);
  assert.equal(cleanup.buildCleanupSpec(older, new Date()).sheets.find((s) => s.name === 'מטופלי פרו-בונו').rows.length, 0);
});

/* ============================ payment reports ============================ */

const PROXY_SECRET = 'proxy-secret-PROBONO-0123456789abcdef0123456789abcd';
const VERED = () => ({ proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered', proxyRoles: ['staff', 'reporter', 'deleter'] });
function payWorld(funders) {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = Array.from(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01', pay: 30000, status: 'active' }[c] || '')));
  const fcols = Array.from(g.run('FUNDER_COLUMNS'));
  S.Funders = richSheet('Funders', fcols);
  funders.forEach((f) => S.Funders.appendRow(fcols.map((c) => (f[c] === undefined ? '' : f[c]))));
  const row = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS')[0];
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, row, snapshot, post: (body) => plain(g.post(Object.assign(body, VERED()))) };
}
const BASE = { id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 0, balance: 30000, status: 'unpaid' };
const REPORT = { receivedDate: '20/09/2026', method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-2026/0042', coverageStart: '2026-09-07', coverageEnd: '2026-10-06' };

test('save path: a report for a pro-bono patient that names NO funder is refused (funder_probono_explicit), nothing written; naming one is accepted', () => {
  const w = payWorld([{ patientId: 'p1', funder: PB, effectiveFrom: '2026-01-01' }]);
  w.post({ action: 'savePayment', payment: BASE });
  // money in place first, editor-side (Phase 4 item H), as legacy rows sit on the sheet
  w.g.sandbox.upsertPayment_(Object.assign({}, BASE, { status: 'paid', amountPaid: 30000, balance: 0 }), 'ורד');
  const before = w.snapshot();
  const r = w.post({ action: 'savePayment', payment: Object.assign({}, BASE, { status: 'paid', amountPaid: 30000, balance: 0 }, REPORT) });
  assert.deepEqual([r.ok, r.error], [false, 'funder_probono_explicit']);
  assert.equal(r.message, 'המטופל פרו-בונו — יש לבחור גורם מממן בדיווח במפורש');
  assert.equal(w.snapshot(), before, 'nothing written');
  for (const f of [PB, 'פרטי']) {
    const ok = w.post({ action: 'savePayment', payment: Object.assign({}, BASE, { status: 'paid', amountPaid: 30000, balance: 0 }, REPORT, { funder: f }) });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(w.row().funder, f, 'the explicit funder is stored as named');
  }
});

test('reportPayment: allowed for a pro-bono patient WITH an explicit funder; refused without one (funder_missing) — the rule is unchanged', () => {
  const w = payWorld([{ patientId: 'p1', funder: PB, effectiveFrom: '2026-01-01' }]);
  const today = GS.sandbox.paymentReportToday_();
  const due = today.slice(0, 8) + '01';
  const end = GS.sandbox.refundIsoFromDayNum_(GS.sandbox.refundDayNum_(GS.sandbox.refundAddMonths_(due, 1)) - 1);
  const cycle = { id: 'pay::arfoni::מטופל::2026-09-01::' + due, patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni', dueDate: due, amount: 30000, coverageStart: due, coverageEnd: end };
  // invoiceWanted: ignored today, required once the invoice PR lands (CHANGELOG-payment-invoice.md).
  const rep = { receivedDate: today, amount: '5000', method: 'מזומן', payer: 'משפחת כהן', coverageStart: due, coverageEnd: end, invoiceWanted: 'no' };
  const before = w.snapshot();
  const bad = w.post({ action: 'reportPayment', report: { cycle, report: rep } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === 'funder_missing'), JSON.stringify(bad));
  assert.equal(w.snapshot(), before, 'nothing written');
  // Two different amounts: the same amount twice the same day is now a
  // possible duplicate (CHANGELOG-receipt-duplicates-and-edit.md) — not this
  // test's rule.
  for (const [f, amount] of [[PB, '5000'], ['ביטוח לאומי', '5001']]) {
    const ok = w.post({ action: 'reportPayment', report: { cycle, report: Object.assign({}, rep, { funder: f, amount }) } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.receipt.funder, f);
  }
});

/* ============================ app.js harness ============================ */

function fakeEl(id) {
  return {
    id: id || '', _html: '', textContent: '', value: '', children: [], style: {}, dataset: {},
    classList: {
      _c: new Set(['hidden']),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      toggle(c, on) { if (on === undefined ? !this._c.has(c) : on) this._c.add(c); else this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    remove() {}, closest() { return null; },
  };
}

function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop, body: fakeEl('body'),
      getElementById: (id) => (els[id] || (els[id] = fakeEl(id))),
      createElement: () => fakeEl(), querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map, Intl,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__modal = null;
    showError = () => {}; showToast = () => {}; renderAll = () => {};
    showModal = (m) => { globalThis.__modal = m; };
    todayISO = () => '${TODAY}';
    buildBillingRow = (patient, payment, iso, carry) => ({ name: patient.name, due: iso, carry: !!carry });
    renderBillingMonthlySummary = () => {};
    globalThis.__test = {
      get state() { return state; },
      funderView, isProbonoOn, isProbonoLabel, overduePatients, patientsNeedingRenewal, renderBilling,
      paymentReportDefaults, admissionFunderFields, funderSelectOptions, paymentFunderLabels, initFunderControls,
      debtFunderStrip, debtFunderStripHtml, normalizePatient, normalizePayment, normalizeFunderRow,
      modal: () => globalThis.__modal,
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.leads = [];
  app.state.patients = (o.patients || []).map(app.normalizePatient);
  app.state.payments = (o.payments || []).map(app.normalizePayment);
  app.state.billingOverrides = [];
  app.state.funders = (o.funders || []).map(app.normalizeFunderRow);
  return { app, els };
}

// Two patients due on the 10th; Avi is pro-bono from 01/09, Bat is private.
const AP = [
  { id: 'id-avi', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, adv: 0, status: 'active' },
  { id: 'id-bat', houseId: 'ramot', name: 'בת בדיקה', date: '2026-07-10', pay: 25000, adv: 0, status: 'active' },
];
const AF = [frow('id-avi', 'פרטי', '2026-07-01'), frow('id-avi', PB, '2026-09-01'), frow('id-bat', 'פרטי', '2026-07-01')];
const unpaid = (name, uid, due) => ({ id: 'pay::ramot::' + name + '::2026-07-10::' + due, patientId: 'ramot::' + name + '::2026-07-10', patientName: name, houseId: 'ramot', dueDate: due, amount: 30000, status: 'unpaid', amountPaid: 0, balance: 30000, patientUid: uid });
const AY = [unpaid('אבי בדיקה', 'id-avi', '2026-08-10'), unpaid('אבי בדיקה', 'id-avi', '2026-09-10'), unpaid('בת בדיקה', 'id-bat', '2026-09-10')];

test('page: every funder select offers פרו-בונו LAST — admission, fill screen, card editor / report form, גבייה filter', () => {
  const h = loadApp();
  assert.deepEqual(Array.from(h.app.paymentFunderLabels()), LABELS);
  assert.deepEqual(Array.from(h.app.admissionFunderFields()[0].options, (x) => x.value), [''].concat(LABELS));
  assert.deepEqual(Array.from(h.app.funderSelectOptions(), (x) => x.value).slice(-1), [PB]);
  h.app.initFunderControls();
  const opts = h.els['billing-funder'].innerHTML.match(/value="([^"]+)"/g).map((m) => m.slice(7, -1));
  assert.deepEqual(opts, ['all'].concat(KEYS, ['unset']));
  assert.ok(h.els['billing-funder'].innerHTML.includes('>פרו-בונו<'));
});

test('page: the due list («לגבייה בתאריך הנבחר») and «יתרות פתוחות» skip a row whose patient is pro-bono on its due date', () => {
  const h = loadApp({ patients: AP, payments: AY, funders: AF });
  h.app.state.billingDate = '2026-09-10';
  h.app.renderBilling();
  const due = h.els['billing-due-list'].children.map((c) => c.name);
  assert.deepEqual(due, ['בת בדיקה'], 'Avi is pro-bono on 10/09');
  assert.equal(h.els['bill-due-count'].textContent, 1);
  // «יתרות פתוחות» on 30/09: Avi's August row (private then) stays, his September row (pro-bono) does not
  h.app.state.billingDate = TODAY;
  h.app.renderBilling();
  const open = h.els['billing-open-list'].children.map((c) => c.name + ' ' + c.due).sort();
  assert.deepEqual(open, ['אבי בדיקה 2026-08-10', 'בת בדיקה 2026-09-10']);
});

test('page: renewal and overdue alerts skip a pro-bono patient; occupancy / cards untouched', () => {
  const h = loadApp({ patients: AP, payments: [], funders: AF });
  assert.deepEqual(Array.from(h.app.overduePatients(TODAY), (x) => x.patient.name), ['בת בדיקה']);
  assert.deepEqual(Array.from(h.app.patientsNeedingRenewal(TODAY, 14), (x) => x.patient.name), ['בת בדיקה']);
  assert.equal(h.app.isProbonoOn(h.app.state.patients[0], '2026-08-31'), false, 'before 01/09: private');
  assert.equal(h.app.isProbonoOn(h.app.state.patients[0], '2026-09-01'), true);
  assert.equal(h.app.state.patients.length, 2, 'the patients themselves are not filtered');
});

test('page: the report form never PREFILLS pro-bono — the funder must be chosen explicitly', () => {
  const h = loadApp({ patients: AP, payments: AY, funders: AF });
  const d = h.app.paymentReportDefaults(h.app.state.patients[0], h.app.state.payments[1], '2026-09-10', TODAY);
  assert.equal(d.report.funder, '', 'pro-bono → «בחרו…»');
  const d2 = h.app.paymentReportDefaults(h.app.state.patients[1], h.app.state.payments[2], '2026-09-10', TODAY);
  assert.equal(d2.report.funder, 'פרטי', 'other funders still prefill');
  assert.equal(h.app.isProbonoLabel(PB), true);
  assert.equal(h.app.isProbonoLabel('פרטי'), false);
});

test('strip: always a פרו-בונו row at ₪0 — even with no pro-bono patient at all', () => {
  const h = loadApp({ funders: [] });
  const rep = aging(TODAY, []);
  const strip = h.app.debtFunderStrip(rep, [], { house: 'all', status: 'all' });
  for (const k of KINDS) {
    assert.deepEqual(Array.from(strip[k].rows, (r) => r.funder), BUCKETS);
    const pbRow = strip[k].rows.find((r) => r.funder === 'probono');
    assert.equal(pbRow.total, 0);
    assert.equal(pbRow.label, PB);
    assert.equal(strip[k].totals.total, rep.totals[k].total, 'strip totals = aging totals');
  }
  const html = h.app.debtFunderStripHtml(strip);
  assert.equal((html.match(/data-funder="probono"/g) || []).length, 2, 'one row in each of the two tables');
});

for (const finance of [false, null]) {
  test(`restricted (finance=${finance}): unchanged — nothing skipped, no funder DOM`, () => {
    const h = loadApp({ finance, patients: AP, payments: AY, funders: AF });
    assert.equal(h.app.funderView(), false);
    assert.equal(h.app.isProbonoOn(h.app.state.patients[0], '2026-09-10'), false);
    assert.equal(h.app.overduePatients(TODAY).length, 2, 'the alert logic itself is unchanged');
    h.app.state.billingDate = '2026-09-10';
    h.app.renderBilling();
    const due = (h.els['billing-due-list'] || { children: [] }).children.map((c) => c.name);
    // false: no billing UI at all (renderBilling returns at once); null
    // (before /api/me): the list renders exactly as before — nobody skipped.
    assert.deepEqual(due, finance === false ? [] : ['אבי בדיקה', 'בת בדיקה']);
    assert.deepEqual(Array.from(h.app.admissionFunderFields()), []);
  });
}

test('SW: at least v37 (above the live v34 and open PRs #181 / #182 at v35 / v36), with its bump comment', () => {
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 37, 'v' + v);   // a later PR may bump it again
  assert.ok(SW_SRC.includes('v36 → v37:'));
});
