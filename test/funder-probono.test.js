/* Pro-bono — the fifth funder. See CHANGELOG-funder-probono.md.
 *
 * Locked here (Sandra, 2026-10-05):
 *   - label 'פרו-בונו', key 'probono', appended LAST everywhere (Code.gs
 *     PAYMENT_FUNDERS, lib/payment-report-rules.js, public/funder.js
 *     LABEL_TO_KEY / FUNDER_KEYS); the four older entries do not move
 *   - a pro-bono patient owes nothing: debtAging_ drops every cycle whose
 *     funder on its start day is pro-bono — from byPatient, byHouse and totals
 *     (counted apart in probonoExcluded); switching mid-stay drops only the
 *     cycles from that day on; the debtByFunder invariant (5 funders + unset
 *     = totals) still holds and the pro-bono strip row is ₪0
 *   - the client's «לגבייה בתאריך הנבחר», «יתרות פתוחות» and the renewal /
 *     overdue alerts skip a row whose funder on its due date is pro-bono;
 *     Ortal's digest skips pro-bono rows
 *   - the cleanup workbook lists them under «מטופלי פרו-בונו»
 *   - a payment report for a pro-bono patient is allowed but must name its
 *     funder (no default; never filled in for it)
 *   - restricted view (Shiran / Yael): unchanged
 *
 * vm sandboxes on the real Code.gs, app.js, funder.js and the payment-report
 * rules. TZ pinned to Israel. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const Funder = require('../public/funder.js');
const rules = require('../lib/payment-report-rules.js');
const cleanup = require('../lib/cleanup-xlsx');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const FUNDER_SRC = read('public', 'funder.js');
const SW_SRC = read('public', 'sw.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const r2 = (n) => Math.round(n * 100) / 100;
const TODAY = '2026-09-30';
const PROBONO = 'פרו-בונו';
const OLD_LABELS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי'];
const OLD_KEYS = ['private', 'btl', 'mod', 'maccabi'];
const KINDS = ['recorded_debt', 'unrecorded_cycles'];

const GS = loadGs();
const frow = (patientId, funder, effectiveFrom, setAt) => ({ patientId, funder, effectiveFrom, setBy: 'ורד', setAt: setAt || '2026-07-01T09:00:00+03:00' });

/* ============================ the key / label guards ============================ */

test('guard: פרו-בונו / probono is the FIFTH funder, appended last — the four older entries do not move', () => {
  const gs = arr(GS.run('PAYMENT_FUNDERS'));
  assert.deepEqual(gs, OLD_LABELS.concat([PROBONO]));
  assert.deepEqual(gs.slice(0, 4), OLD_LABELS, 'append-only');
  assert.equal(GS.run('FUNDER_PROBONO'), PROBONO);
  assert.deepEqual(arr(rules.PAYMENT_FUNDERS), gs);
  assert.equal(rules.FUNDER_PROBONO, PROBONO);
  assert.deepEqual(Object.keys(Funder.LABEL_TO_KEY), gs);
  assert.deepEqual([...Funder.FUNDER_KEYS], OLD_KEYS.concat(['probono']));
  assert.equal(Funder.FUNDER_PROBONO, 'probono');
  assert.equal(Funder.keyFromLabel(PROBONO), 'probono');
  assert.equal(Funder.labelFor('probono'), PROBONO);
  for (const bad of ['פרו בונו', 'פרובונו', ' פרו-בונו', 'probono', 'Pro-Bono']) assert.equal(Funder.keyFromLabel(bad), 'unset', bad);
  // the server accepts it wherever a funder is checked
  assert.deepEqual(plain(rules.validatePaymentReport({ funder: PROBONO }, { todayIso: TODAY })).filter((i) => i.field === 'funder'), []);
  assert.equal(plain(GS.sandbox.currentFunderFrom_([frow('p1', PROBONO, '2026-07-01')], 'p1', TODAY)).funder, PROBONO);
});

test('guard: the message key funder_probono_implicit is the same on both sides; SW bumped with its comment', () => {
  assert.equal(GS.run('PAYMENT_REPORT_MESSAGES.funder_probono_implicit'), rules.MESSAGES.funder_probono_implicit);
  assert.equal(rules.MESSAGES.funder_probono_implicit, 'המטופל מוגדר פרו-בונו — יש לבחור גורם מממן במפורש בדיווח');
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 35, 'v35 or later');
  assert.match(SW_SRC, /v34 → v35: pro-bono funder/);
});

/* ============================ debtAging_ ============================ */

const AVI = 'ramot::אבי בדיקה::2026-07-10';
const PATIENTS = [
  { id: 'id-a', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, status: 'active' },   // private, then pro-bono from 01/09
  { id: 'id-b', houseId: 'rehab', name: 'בת בדיקה', date: '2026-07-05', pay: 20000, status: 'active' },    // pro-bono from entry
  { id: 'id-c', houseId: 'rehab', name: 'גל בדיקה', date: '2026-07-15', pay: 25000, status: 'active' },    // מכבי
  { id: 'id-d', houseId: 'pardes', name: 'דנה בדיקה', date: '2026-07-20', pay: 28000, status: 'active' },  // no Funders row (unset)
];
const pay = (pid, due, f) => Object.assign({ id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due }, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),   // recorded debt, before the switch
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),   // recorded, after the switch → dropped
];
const FUNDERS = [
  frow('id-a', 'פרטי', '2026-07-10'), frow('id-a', PROBONO, '2026-09-01'),
  frow('id-b', PROBONO, '2026-07-05'),
  frow('id-c', 'מכבי', '2026-07-15'),
];
const tab = (list) => ({ rows: list.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
function aging(asOf, funders) {
  const t = { patients: tab(PATIENTS), payments: tab(PAYMENTS), credits: tab([]), overrides: tab([]) };
  if (funders) t.funders = tab(funders);
  return plain(GS.sandbox.debtAging_(asOf, t));
}
const starts = (rep, id) => ((rep.byPatient.find((p) => p.patientId === id) || {}).cycles || []).map((c) => c.start + ':' + c.kind);

test('debtAging_: a pro-bono patient is ABSENT from byPatient, byHouse and totals; counted apart in probonoExcluded', () => {
  const before = aging(TODAY);           // no Funders tab → nothing dropped
  const after = aging(TODAY, FUNDERS);
  assert.equal(before.ok, true); assert.equal(after.ok, true);
  assert.ok(starts(before, 'id-b').length > 0, 'the fixture owes something for id-b without the funder');
  assert.equal(after.byPatient.find((p) => p.patientId === 'id-b'), undefined, 'pro-bono from entry → no row at all');
  for (const k of KINDS) {
    const dropped = after.probonoExcluded[k];
    assert.equal(r2(before.totals[k].total - after.totals[k].total), dropped.total, k + ' total');
    assert.equal(before.totals[k].count - after.totals[k].count, dropped.count, k + ' count');
    const sumHouses = (rep) => r2(rep.byHouse.reduce((s, h) => s + h[k].total, 0));
    assert.equal(sumHouses(after), after.totals[k].total, 'byHouse still sums to totals');
    assert.equal(r2(sumHouses(before) - sumHouses(after)), dropped.total, 'byHouse lost exactly the pro-bono cycles');
  }
  // the rehab house keeps גל (מכבי) and loses בת
  const rehab = (rep) => rep.byHouse.find((h) => h.houseId === 'rehab');
  const gal = before.byPatient.find((p) => p.patientId === 'id-c').cycles.reduce((s, c) => s + c.balance, 0);
  assert.equal(r2(rehab(after).recorded_debt.total + rehab(after).unrecorded_cycles.total), r2(gal));
  // untouched: patients who are not pro-bono
  assert.deepEqual(starts(after, 'id-c'), starts(before, 'id-c'));
  assert.deepEqual(starts(after, 'id-d'), starts(before, 'id-d'));
  assert.deepEqual(before.probonoExcluded, { recorded_debt: { count: 0, total: 0 }, unrecorded_cycles: { count: 0, total: 0 } });
});

test('debtAging_: switching to pro-bono mid-stay drops ONLY the cycles that start on/after that day', () => {
  const before = aging(TODAY);
  const after = aging(TODAY, FUNDERS);
  const b = starts(before, 'id-a'), a = starts(after, 'id-a');
  assert.ok(b.some((s) => s >= '2026-09-01'), 'the fixture has cycles after the switch');
  assert.deepEqual(a, b.filter((s) => s < '2026-09-01'), 'cycles before 01/09 stay, the rest go');
  assert.ok(a.includes('2026-07-10:recorded'), 'the July recorded debt stays');
  assert.ok(!a.includes('2026-09-10:recorded'), 'the September recorded debt goes');
  // a switch BACK from pro-bono restores the cycles from that day on
  const back = aging(TODAY, FUNDERS.concat([frow('id-a', 'פרטי', '2026-09-10')]));
  assert.deepEqual(starts(back, 'id-a'), b.filter((s) => s < '2026-09-01' || s >= '2026-09-10'));
  // as of a day before the switch, nothing is dropped for id-a
  assert.deepEqual(starts(aging('2026-08-31', FUNDERS), 'id-a'), starts(aging('2026-08-31'), 'id-a'));
});

test('invariant: the five funders + unset sum EXACTLY to the totals (per figure, per house); the pro-bono bucket is ₪0', () => {
  for (const asOf of ['2026-08-31', '2026-09-15', TODAY]) {
    const report = aging(asOf, FUNDERS);
    const split = Funder.debtByFunder(report, FUNDERS, asOf);
    const keys = Funder.FUNDER_KEYS.concat([Funder.FUNDER_UNSET]);
    assert.equal(keys.length, 6);
    assert.deepEqual(Object.keys(split).sort(), [...keys].sort());
    for (const k of KINDS) {
      assert.equal(r2(keys.reduce((s, f) => s + split[f][k].total, 0)), report.totals[k].total, asOf + ' ' + k);
      assert.equal(keys.reduce((s, f) => s + split[f][k].count, 0), report.totals[k].count);
      for (const h of report.byHouse) {
        assert.equal(r2(keys.reduce((s, f) => s + (((split[f].byHouse[h.houseId] || {})[k]) || { total: 0 }).total, 0)), h[k].total);
      }
      assert.deepEqual(split.probono[k], { count: 0, total: 0 }, 'pro-bono owes nothing');
    }
  }
});

test('action debtAging: reads the Funders tab (read-only) and drops the pro-bono cycles', () => {
  const g = loadGs({ props: { PROXY_SECRET: 'proxy-secret-PROBONO-0123456789abcdef0123456789abcdef' } });
  const S = g.sandbox.__sheets;
  const sheet = (name, colsName, list) => {
    const cols = arr(g.run(colsName));
    S[name] = richSheet(name, cols);
    list.forEach((o) => S[name].appendRow(cols.map((c) => (o[c] === undefined ? '' : o[c]))));
  };
  sheet('Patients', 'PATIENT_COLUMNS', PATIENTS);
  sheet('Payments', 'PAYMENT_COLUMNS', PAYMENTS);
  const without = plain(g.sandbox.debtAgingAction_({ asOf: TODAY }));
  sheet('Funders', 'FUNDER_COLUMNS', FUNDERS);
  const withF = plain(g.sandbox.debtAgingAction_({ asOf: TODAY }));
  assert.equal(without.ok, true); assert.equal(withF.ok, true);
  assert.ok(without.byPatient.some((p) => p.patientId === 'id-b'));
  assert.ok(!withF.byPatient.some((p) => p.patientId === 'id-b'));
  assert.ok(withF.probonoExcluded.unrecorded_cycles.count > 0);
});

/* ============================ the cleanup workbook ============================ */

test('cleanup: «מטופלי פרו-בונו» lists every patient whose funder today (or at exit) is pro-bono — last tab, owner ורד', () => {
  const pts = PATIENTS.concat([
    { id: 'id-e', houseId: 'ramot', name: 'הדס בדיקה', date: '2026-06-01', pay: 30000, status: 'released', exitDate: '2026-08-15' },
  ]);
  const funders = FUNDERS.concat([frow('id-e', PROBONO, '2026-06-01'), frow('id-e', 'פרטי', '2026-09-01')]);   // left as pro-bono
  const rep = plain(GS.sandbox.cleanupReport_(TODAY, {
    patients: tab(pts), payments: tab(PAYMENTS), credits: tab([]), overrides: tab([]), funders: tab(funders),
  }));
  assert.equal(rep.ok, true);
  assert.equal(arr(GS.run('CLEANUP_SECTION_KEYS')).slice(-1)[0], 'probono', 'appended last');
  assert.deepEqual(rep.sections.probono.map((r) => [r.name, r.effectiveFrom]),
    [['אבי בדיקה', '2026-09-01'], ['הדס בדיקה', '2026-06-01'], ['בת בדיקה', '2026-07-05']]);
  assert.equal(rep.counts.probono, 3);
  assert.ok(rep.sections.gaps.every((g) => g.name !== 'בת בדיקה'), 'their cycles are not gaps');
  assert.ok(rep.sections.noFunder.every((r) => r.name !== 'בת בדיקה'));
  assert.deepEqual(rep.sections.probono, plain(GS.sandbox.cleanupProbono_(GS.sandbox.recModel_(
    GS.sandbox.paymentTabsDerived_({ patients: tab(pts), payments: tab(PAYMENTS) }), TODAY), funders, TODAY)));
  // no Funders tab → an empty list, never a crash
  assert.deepEqual(plain(GS.sandbox.cleanupReport_(TODAY, { patients: tab(pts), payments: tab(PAYMENTS) })).sections.probono, []);
  // the workbook
  const t = cleanup.TABS.slice(-1)[0];
  assert.deepEqual([t.key, t.name], ['probono', 'מטופלי פרו-בונו']);
  assert.equal(cleanup.KINDS.probono.owner, 'vered');
  const spec = cleanup.buildCleanupSpec(rep, new Date('2026-09-30T07:00:00Z'));
  const sheet = spec.sheets.find((s) => s.name === 'מטופלי פרו-בונו');
  assert.equal(sheet.rows.length, 3);
  assert.ok(sheet.columns.some((c) => c.header === 'פרו-בונו מתאריך'));
  // a Code.gs deployed before this PR (no probono section) is still a valid response
  const old = Object.assign({}, rep, { sections: Object.assign({}, rep.sections) });
  delete old.sections.probono;
  assert.equal(cleanup.isCleanupResponse(old), true);
});

/* ============================ Ortal's digest ============================ */

test('digest: a pro-bono patient\'s rows are skipped — by the row\'s own funder, else Funders on the payment day', () => {
  const since = Date.parse('2026-09-01T00:00:00+03:00'), until = Date.parse('2026-10-01T00:00:00+03:00');
  const row = (id, f) => Object.assign({ id, patientName: id, houseId: 'ramot', dueDate: '2026-09-10', amount: 1000, amountPaid: 1000,
    status: 'paid', chargedAt: '2026-09-12T10:00:00+03:00' }, f);
  const rows = [
    row('own-probono', { funder: PROBONO, patientUid: 'id-x' }),
    row('own-private', { funder: 'פרטי', patientUid: 'id-b' }),                      // names its funder: kept
    row('sheet-probono', { patientUid: 'id-b', receivedDate: '2026-09-10' }),         // Funders: pro-bono on 10/09
    row('before-switch', { patientUid: 'id-a', receivedDate: '2026-08-20' }),         // id-a: private on 20/08
    row('after-switch', { patientUid: 'id-a', receivedDate: '2026-09-05' }),          // id-a: pro-bono from 01/09
    row('no-uid', {}),
  ];
  const pick = (f) => plain(GS.sandbox.digestSelect_(rows, since, until, {}, f)).map((r) => r.patientName).sort();
  assert.deepEqual(pick(FUNDERS), ['before-switch', 'no-uid', 'own-private']);
  assert.deepEqual(pick([]), ['before-switch', 'no-uid', 'own-private', 'sheet-probono', 'after-switch'].sort(), 'no Funders: only the row\'s own funder decides');
  assert.equal(pick(undefined).length, 5, 'the old 4-argument call still works');
  assert.match(read('apps-script', 'Code.gs'), /digestSelect_\(payRows, sinceMs, nowMs, ledger, fundersRows_\(\)\)/);
});

/* ============================ the payment report ============================ */

test('report: a pro-bono patient\'s report is ALLOWED with an explicit funder and REFUSED without one — nothing written', () => {
  const g = loadGs({ props: {} });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'מטופל', date: '2026-09-01', pay: 30000, status: 'active' }[c] || '')));
  const fcols = arr(g.run('FUNDER_COLUMNS'));
  S.Funders = richSheet('Funders', fcols);
  S.Funders.appendRow(fcols.map((c) => (frow('p1', PROBONO, '2026-01-01')[c] || '')));
  const base = { id: 'pay1', patientId: 'arfoni::מטופל::2026-09-01', patientName: 'מטופל', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 0, balance: 30000, status: 'unpaid' };
  const save = (p) => plain(g.sandbox.upsertPayment_(JSON.parse(JSON.stringify(p)), 'ורד'));
  const rowNow = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS')[0];
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  assert.equal(save(base).ok, true);
  assert.equal(save(Object.assign({}, base, { status: 'paid', amountPaid: 30000, balance: 0 })).ok, true);
  const REPORT = { receivedDate: '20/09/2026', method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-2026/0042',
    coverageStart: '2026-09-07', coverageEnd: '2026-10-06', status: 'paid', amountPaid: 30000, balance: 0 };
  const before = snapshot();
  const r = save(Object.assign({}, base, REPORT));
  assert.deepEqual([r.ok, r.error, r.message], [false, 'funder_probono_implicit', 'המטופל מוגדר פרו-בונו — יש לבחור גורם מממן במפורש בדיווח']);
  assert.equal(snapshot(), before, 'nothing written');
  const ok = save(Object.assign({}, base, REPORT, { funder: PROBONO }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(rowNow().funder, PROBONO, 'stored as the label');
  // the strict form rules: «פרו-בונו» is a valid choice; no funder is still funder_missing (no default)
  const full = { receivedDate: '2026-09-20', amount: '1000', method: 'מזומן', payer: 'משפחת כהן', coverageStart: '2026-09-07', coverageEnd: '2026-10-06' };
  assert.deepEqual(plain(GS.sandbox.validatePaymentReport_(Object.assign({}, full, { funder: PROBONO }), { todayIso: TODAY })), []);
  assert.deepEqual(plain(rules.validatePaymentReport(Object.assign({}, full, { funder: PROBONO }), { todayIso: TODAY })), []);
  assert.deepEqual(plain(GS.sandbox.validatePaymentReport_(full, { todayIso: TODAY })).map((i) => i.code), ['funder_missing']);
});

/* ============================ app.js ============================ */

function fakeEl(id) {
  const el = {
    id: id || '', _html: '', textContent: '', value: '', children: [], style: {}, dataset: {}, parentNode: null,
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
    remove() {}, closest() { return null; }, insertBefore() {},
  };
  return el;
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
    showError = () => {}; showToast = () => {}; renderAll = () => {};
    todayISO = () => '${TODAY}';
    globalThis.__test = {
      get state() { return state; },
      isProbonoOn, overduePatients, patientsNeedingRenewal, renderBilling, renderBillingOpenList, funderView,
      normalizePatient, normalizePayment, normalizeFunderRow, funderSelectOptions, admissionFunderFields, initFunderControls,
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.leads = [];
  app.state.patients = (o.patients || []).map(app.normalizePatient);
  app.state.payments = (o.payments || []).map(app.normalizePayment);
  app.state.funders = (o.funders || []).map(app.normalizeFunderRow);
  return { app, els };
}

// Both enter on the 15th; ניר is pro-bono from 01/09, ליה is private.
const NIR = { id: 'id-nir', houseId: 'ramot', name: 'ניר בדיקה', date: '2026-07-15', pay: 30000, adv: 0, status: 'active' };
const LIA = { id: 'id-lia', houseId: 'ramot', name: 'ליה בדיקה', date: '2026-07-15', pay: 25000, adv: 0, status: 'active' };
const APP_FUNDERS = [frow('id-nir', 'פרטי', '2026-07-15'), frow('id-nir', PROBONO, '2026-09-01'), frow('id-lia', 'פרטי', '2026-07-15')];
const unpaid = (p, due) => ({ id: `pay::${p.houseId}::${p.name}::${p.date}::${due}`, patientId: `${p.houseId}::${p.name}::${p.date}`,
  patientUid: p.id, patientName: p.name, houseId: p.houseId, dueDate: due, amount: p.pay, amountPaid: 0, balance: p.pay, status: 'unpaid' });

test('client: isProbonoOn reads the funder on the DUE date (same rule as the filter)', () => {
  const { app } = loadApp({ patients: [NIR, LIA], funders: APP_FUNDERS });
  const nir = app.state.patients[0];
  assert.equal(app.isProbonoOn(nir, '2026-08-15'), false, 'private before the switch');
  assert.equal(app.isProbonoOn(nir, '2026-09-15'), true);
  assert.equal(app.isProbonoOn(app.state.patients[1], '2026-09-15'), false);
  assert.equal(app.isProbonoOn(null, '2026-09-15'), false);
});

test('client: «לגבייה בתאריך הנבחר» skips a pro-bono row; the KPI cards count only what is listed', () => {
  const { app, els } = loadApp({ patients: [NIR, LIA], funders: APP_FUNDERS });
  app.state.billingDate = '2026-09-15';
  app.renderBilling();
  assert.equal(els['billing-due-list'].children.length, 1, 'ליה only');
  assert.equal(els['bill-due-count'].textContent, 1);
  assert.equal(els['bill-due-total'].textContent, '₪ ' + (25000).toLocaleString('he-IL'));
  // before the switch both are listed
  app.state.billingDate = '2026-08-15';
  app.renderBilling();
  assert.equal(els['billing-due-list'].children.length, 2);
});

test('client: «יתרות פתוחות» skips the rows whose funder on the due date is pro-bono — only from the switch on', () => {
  const pays = [unpaid(NIR, '2026-08-15'), unpaid(NIR, '2026-09-15'), unpaid(LIA, '2026-09-15')];
  const { app, els } = loadApp({ patients: [NIR, LIA], payments: pays, funders: APP_FUNDERS });
  app.renderBillingOpenList('2026-09-30');
  assert.equal(els['billing-open-list'].children.length, 2, 'ניר 15/08 (private then) + ליה 15/09; ניר 15/09 skipped');
  // every row pro-bono → the real empty message, never «לא נמצאו תוצאות»
  const only = loadApp({ patients: [NIR], payments: [unpaid(NIR, '2026-09-15')], funders: APP_FUNDERS });
  only.app.renderBillingOpenList('2026-09-30');
  assert.match(only.els['billing-open-list'].innerHTML, /אין יתרות פתוחות מתאריכים קודמים/);
});

test('client: the renewal and overdue alerts skip a pro-bono patient', () => {
  const { app } = loadApp({ patients: [NIR, LIA], funders: APP_FUNDERS });
  assert.deepEqual(plain(app.overduePatients('2026-09-20').map((x) => x.patient.name)), ['ליה בדיקה']);
  assert.deepEqual(plain(app.patientsNeedingRenewal('2026-10-10', 7).map((x) => x.patient.name)), ['ליה בדיקה']);
  // without the funder rows (or before the switch) ניר is back
  const none = loadApp({ patients: [NIR, LIA] });
  assert.equal(none.app.overduePatients('2026-09-20').length, 2);
  assert.equal(app.overduePatients('2026-08-20').length, 2);
});

test('client: every funder select and the גבייה filter offer פרו-בונו, last', () => {
  const { app, els } = loadApp({});
  const opts = plain(app.funderSelectOptions()).map((x) => x.value);
  assert.deepEqual(opts, [''].concat(OLD_LABELS, [PROBONO]), 'admission, card editor, fill screen, payment form');
  assert.deepEqual(plain(app.admissionFunderFields())[0].options.map((x) => x.value).slice(-1), [PROBONO]);
  app.initFunderControls();
  const values = [...els['billing-funder'].innerHTML.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['all'].concat(OLD_KEYS, ['probono', 'unset']));
  assert.match(els['billing-funder'].innerHTML, /<option value="probono">פרו-בונו<\/option>/);
});

test('restricted view unchanged: no funder rows, no funder field, nothing skipped, no billing render', () => {
  for (const finance of [false, null]) {
    const { app, els } = loadApp({ finance, patients: [NIR, LIA] });
    assert.equal(app.funderView(), false);
    assert.deepEqual(plain(app.admissionFunderFields()), []);
    assert.equal(app.isProbonoOn(app.state.patients[0], '2026-09-15'), false);
    assert.equal(app.overduePatients('2026-09-20').length, 2, 'the pure list is the old one');
    if (finance === false) {
      app.renderBilling();
      assert.equal(els['billing-due-list'], undefined, 'restricted: renderBilling returns before touching the DOM');
    }
  }
});
