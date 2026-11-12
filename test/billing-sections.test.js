'use strict';

/* «גבייה» as a secondary menu of single sections, with shared slices and «חתך לפי»
 * (CHANGELOG-billing-sections.md). Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-12';

/* ---- the menu ---- */
test('the sections: nine for finance that may discount, eight for Ortal (no cleanup); each has a label', () => {
  assert.deepEqual(core.BILLING_TABS.map((t) => t.id), ['overview', 'due', 'forecast', 'debts', 'receipts', 'refunds', 'unlinked', 'anomalies', 'cleanup']);
  assert.ok(core.BILLING_TABS.every((t) => t.label));
  assert.equal(core.billingTabsFor({ view: 'full', finance: true, canDiscount: true }).length, 9);
  assert.deepEqual(core.billingTabsFor({ view: 'controller' }), ['overview', 'due', 'forecast', 'debts', 'receipts', 'refunds', 'unlinked', 'anomalies']);
  assert.ok(!core.billingTabsFor(null).includes('cleanup'));
});

test('no duplicates: every list table is rendered once in the whole page, and each section renders one thing', () => {
  for (const id of ['crm-due', 'crm-fc-rows', 'crm-debtors', 'crm-receipts', 'crm-pending-credits', 'crm-detached', 'crm-anomalies', 'crm-cleanup-rows'])
    assert.equal(SRC.split('id="' + id + '"').length - 1, 1, id + ' exists once');
  for (const gone of ['crm-fc-debtor-rows', 'crm-fc-open-rows', 'crm-fc-open-refunds', 'crm-fc-refund-rows', 'crm-fc-detail', 'crm-search-debtors', 'crm-search-receipts', 'data-billing-filter'])
    assert.ok(!SRC.includes(gone), gone + ' (a second path to the same information) is gone');
  const fn = SRC.slice(SRC.indexOf('function renderBilling()'), SRC.indexOf('/* «חריגים לבדיקה» (CHANGELOG-crm-kpi-tab.md)'));
  for (const [tab, call] of [['due', 'renderDueOnDate(isController)'], ['forecast', 'renderCashForecast()'], ['debts', 'renderDebts(b, c.patients)'], ['receipts', 'renderReceipts()'],
    ['refunds', 'renderRefunds()'], ['unlinked', 'renderUnlinked(isController)'], ['anomalies', 'renderAnomalies(anomalies)']]) {
    assert.ok(fn.includes("tab === '" + tab + "') html += " + call), tab);
    assert.equal(fn.split(call).length - 1, 1, call + ' is called from one section only');
  }
  assert.ok(fn.includes("const tab = tabs.indexOf(state.billTab) >= 0 ? state.billTab : 'overview';"), 'an unknown / forbidden section falls back to the overview');
  assert.ok(!/api\(/.test(fn), 'no request of its own');
});

/* ---- slices ---- */
test('billSlice / sliceHit: words over patient + house + funder, one funder, one house (id, alias or Hebrew name)', () => {
  assert.deepEqual(core.billSlice({ q: '  דנה   כהן ', funder: 'פרטי', house: 'רמות השבים' }), { q: 'דנה כהן', funder: 'פרטי', house: 'ramot' });
  assert.deepEqual(core.billSlice({ house: 'raanana' }), { q: '', funder: '', house: 'asher' });
  assert.deepEqual(core.billSlice({ house: 'no-such-house' }), { q: '', funder: '', house: '' });
  assert.equal(core.sliceOn(core.billSlice({})), false); assert.equal(core.sliceOn(core.billSlice({ q: 'x' })), true);
  const hit = (sl, f) => core.sliceHit(core.billSlice(sl), 'דנה כהן', 'ramot', f);
  assert.equal(hit({}, 'פרטי'), true);
  assert.equal(hit({ q: 'כהן דנה' }, 'פרטי'), true, 'any word order');
  assert.equal(hit({ q: 'רמות' }, 'פרטי'), true, 'the house name is searchable');
  assert.equal(hit({ q: 'ביטוח' }, 'ביטוח לאומי'), true, 'the funder is searchable («חיפוש גורם מממן»)');
  assert.equal(hit({ q: 'ביטוח' }, 'פרטי'), false);
  assert.equal(hit({ funder: 'מכבי' }, 'פרטי'), false);
  assert.equal(hit({ funder: 'מכבי' }, undefined), true, 'a row with no funder (a refund) is not dropped by the funder slice');
  assert.equal(hit({ house: 'asher' }, 'פרטי'), false);
  assert.equal(core.sliceHit(core.billSlice({ house: 'asher' }), 'x', 'raanana', 'פרטי'), true, 'a legacy house id resolves');
  assert.equal(core.sliceHit(null, 'x', 'ramot', 'פרטי'), true);
});

test('groupRows: count, sum and share per group, largest first; the shares of the groups cover the rows', () => {
  const rows = [{ f: 'פרטי', a: 100 }, { f: 'מכבי', a: 300 }, { f: 'פרטי', a: 50.5 }, { f: '', a: 49.5 }];
  const g = core.groupRows(rows, (r) => r.f, null, (r) => r.a);
  assert.deepEqual(g, [{ key: 'מכבי', label: 'מכבי', count: 1, total: 300, pct: 60 }, { key: 'פרטי', label: 'פרטי', count: 2, total: 150.5, pct: 30.1 }, { key: '', label: '—', count: 1, total: 49.5, pct: 9.9 }]);
  assert.equal(g.reduce((t, x) => t + x.total, 0), 500);
  assert.equal(g.reduce((t, x) => t + x.count, 0), rows.length);
  assert.deepEqual(core.groupRows([], (r) => r.f, null, (r) => r.a), []);
});

/* ---- debts ---- */
const CYC = (start, balance, days, o) => Object.assign({ start: start, end: start, expected: balance, received: 0, balance: balance, days: days, kind: 'recorded', month: start.slice(0, 7) }, o || {});
const DEBT = { ok: true, asOf: TODAY, totals: {}, byHouse: [], byPatient: [
  { patientId: 'p1', patientKey: 'k1', name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [CYC('2026-08-20', 30000, 84), CYC('2026-10-20', 12000, 23)] },
  { patientId: 'p2', patientKey: 'k2', name: 'אבי רז', houseId: 'asher', status: 'released', inHouseAtAsOf: false, cycles: [CYC('2026-10-02', 20000, 41)] },
  { patientId: 'p3', patientKey: 'k3', name: 'גל שי', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [CYC('2026-11-03', 9000, 9)] }] };
const PAY = { ok: true, payments: [], funders: [{ patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-01-01' }, { patientId: 'p2', funder: 'ביטוח לאומי', effectiveFrom: '2026-01-01' }, { patientId: 'p3', funder: 'פרטי', effectiveFrom: '2026-01-01' }],
  receipts: [
    { id: 'r1', patientUid: 'p1', patientId: 'k1', patientName: 'דנה כהן', houseId: 'ramot', amount: 2500, receivedDate: '2026-11-05', method: 'העברה בנקאית', confirmStatus: 'confirmed' },
    { id: 'r2', patientUid: 'p2', patientId: 'k2', patientName: 'אבי רז', houseId: 'asher', amount: 10000, receivedDate: '2026-10-20', method: 'אשראי', confirmStatus: 'reported' },
    { id: 'r3', patientUid: 'p3', patientId: 'k3', patientName: 'גל שי', houseId: 'ramot', amount: 4000, receivedDate: '2026-09-01', method: 'אשראי', confirmStatus: 'partial', funder: 'מכבי' }] };
const cd = (range) => core.collectionDebtors(DEBT, PAY, TODAY, '', range);

test('debtsView: no filter → the whole list, and its total is the debt list\'s total (one source)', () => {
  const v = core.debtsView(cd(), core.billSlice({}), {});
  assert.deepEqual([v.count, v.total, v.inHouse], [3, 71000, 2]);
  assert.equal(v.total, cd().total);
});

test('debtsView: funder, house, patient search, aging bucket and in-house / released each narrow the SAME rows — and combine', () => {
  const view = (sl, o) => core.debtsView(cd(), core.billSlice(sl), o || {});
  assert.deepEqual(view({ funder: 'פרטי' }).rows.map((r) => r.name), ['דנה כהן', 'גל שי']);
  assert.equal(view({ funder: 'פרטי' }).total, 51000);
  assert.deepEqual(view({ house: 'asher' }).rows.map((r) => r.name), ['אבי רז']);
  assert.deepEqual(view({ q: 'גל' }).rows.map((r) => r.name), ['גל שי']);
  assert.deepEqual(view({ q: 'ביטוח לאומי' }).rows.map((r) => r.name), ['אבי רז'], 'search by funder text');
  assert.deepEqual(view({}, { bucket: 'd61_plus' }).rows.map((r) => r.name), ['דנה כהן']);
  assert.deepEqual(view({}, { status: 'out' }).rows.map((r) => r.name), ['אבי רז']);
  assert.deepEqual(view({}, { status: 'in' }).count, 2);
  assert.deepEqual(view({ funder: 'פרטי', house: 'ramot' }, { bucket: 'd8_30' }).rows.map((r) => r.name), ['גל שי']);
  assert.equal(view({ funder: 'מכבי' }).count, 0);
});

test('«חתך לפי» on debts: by funder, house, aging and status — each cut sums to the list total', () => {
  const v = core.debtsView(cd(), core.billSlice({}), {});
  const byFunder = core.debtGroups(v.rows, 'funder');
  assert.deepEqual(byFunder.map((g) => [g.label, g.count, g.total, g.pct]), [['פרטי', 2, 51000, 71.8], ['ביטוח לאומי', 1, 20000, 28.2]]);
  assert.deepEqual(core.debtGroups(v.rows, 'house').map((g) => [g.key, g.label, g.total]), [['ramot', 'רמות השבים', 51000], ['asher', 'רעננה אשר', 20000]]);
  assert.deepEqual(core.debtGroups(v.rows, 'status').map((g) => [g.key, g.label, g.count]), [['in', 'בבית', 2], ['out', 'משוחררים', 1]]);
  for (const dim of Object.keys(core.DEBT_GROUPS)) assert.equal(core.debtGroups(v.rows, dim).reduce((t, g) => t + g.total, 0), v.total, dim);
  assert.deepEqual(core.debtGroups(v.rows, 'nope'), []);
  // a cut follows the period too
  const oct = core.debtsView(cd({ from: '2026-10-01', to: '2026-10-31' }), core.billSlice({}), {});
  assert.deepEqual(core.debtGroups(oct.rows, 'funder').map((g) => [g.label, g.total]), [['ביטוח לאומי', 20000], ['פרטי', 12000]]);
});

/* ---- receipts ---- */
test('receiptsView: a received-date period (ends included), newest first; the funder is the receipt\'s own, else the patient\'s on that day', () => {
  const all = core.receiptsView(PAY, core.billSlice({}), {}, TODAY);
  assert.deepEqual(all.rows.map((r) => [r.id, r.funderLabel]), [['r1', 'פרטי'], ['r2', 'ביטוח לאומי'], ['r3', 'מכבי']]);
  assert.deepEqual([all.count, all.total], [3, 16500]);
  const oct = core.receiptsView(PAY, core.billSlice({}), { from: '2026-10-20', to: '2026-11-05' }, TODAY);
  assert.deepEqual(oct.rows.map((r) => r.id), ['r1', 'r2']);
  assert.equal(core.receiptsView(PAY, core.billSlice({}), { from: '2026-10-21', to: '2026-11-04' }, TODAY).count, 0);
  assert.deepEqual(core.receiptsView(PAY, core.billSlice({}), { status: 'toVerify' }, TODAY).rows.map((r) => r.id), ['r2', 'r3'], 'everything not confirmed');
  assert.deepEqual(core.receiptsView(PAY, core.billSlice({ funder: 'מכבי' }), {}, TODAY).rows.map((r) => r.id), ['r3']);
  assert.deepEqual(core.receiptsView(PAY, core.billSlice({ house: 'asher', q: 'אבי' }), {}, TODAY).rows.map((r) => r.id), ['r2']);
  assert.equal(core.receiptsView({ ok: false }, core.billSlice({}), {}, TODAY).ok, false);
});

test('«חתך לפי» on receipts: funder / house / method / verification, each summing to the list', () => {
  const v = core.receiptsView(PAY, core.billSlice({}), {}, TODAY);
  assert.deepEqual(core.receiptGroups(v.rows, 'method').map((g) => [g.label, g.count, g.total]), [['אשראי', 2, 14000], ['העברה בנקאית', 1, 2500]]);
  for (const dim of Object.keys(core.RECEIPT_GROUPS)) assert.equal(core.receiptGroups(v.rows, dim).reduce((t, g) => t + g.total, 0), v.total, dim);
});

/* ---- refunds ---- */
test('refundsView: the ONE refunds list — saved credits carry their record (for the payout actions), computed lines do not; overdue included', () => {
  const forecast = { ok: true, toPay: { rows: [
    { creditId: 'cr-1', auto: false, patientName: 'דנה כהן', houseId: 'ramot', amount: 4000, payoutDate: '2026-11-15', creditType: 'days_unused' },
    { creditId: '', auto: true, patientName: 'אבי רז', houseId: 'asher', amount: 1500, payoutDate: '2026-10-15', creditType: 'prepaid_return' },
    { creditId: 'cr-9', auto: false, patientName: 'גל שי', houseId: 'ramot', amount: 700, payoutDate: '2027-01-15', creditType: 'other' }] } };
  const credits = { ok: true, credits: [{ id: 'cr-1', patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused', allocationMonth: '2026-10', amount: 4000, status: 'pending', payoutDate: '2026-11-15' }] };
  const v = core.refundsView(forecast, credits, TODAY, null);
  assert.deepEqual(v.rows.map((r) => [r.name, r.amount, r.late, r.auto, !!r.credit]), [['אבי רז', 1500, true, true, false], ['דנה כהן', 4000, false, false, true], ['גל שי', 700, false, false, false]]);
  assert.deepEqual([v.ok, v.count, v.total, v.late, v.auto, v.source], [true, 3, 6200, 1, 1, 'forecast']);
  assert.equal(v.rows[1].credit.allocationMonth, '2026-10');
  assert.deepEqual(core.refundsView(forecast, credits, TODAY, core.billSlice({ house: 'ramot' })).rows.map((r) => r.name), ['דנה כהן', 'גל שי']);
  assert.equal(core.refundsView(forecast, credits, TODAY, core.billSlice({ funder: 'מכבי' })).count, 3, 'a refund has no funder — the funder slice does not hide it');
  // the forecast read failed → the saved credits alone, flagged; both failed → not ok
  assert.deepEqual([core.refundsView({ ok: false }, credits, TODAY, null).source, core.refundsView({ ok: false }, credits, TODAY, null).count], ['credits', 1]);
  assert.equal(core.refundsView({ ok: false }, { ok: false }, TODAY, null).ok, false);
});

/* ---- forecast in a slice ---- */
test('sliceForecast with no slice = cashForecast\'s own figures exactly (same roll-up); a slice re-sums the same rows', () => {
  const data = { ok: true, leads: [], billingOverrides: [], patients: {
    ramot: [{ id: 'id-p1', name: 'דנה כהן', date: '2026-07-17', pay: 30000, status: 'active', exitDate: '' }, { id: 'id-p3', name: 'נוי בר', date: '2026-08-25', pay: 5000, status: 'active', exitDate: '' }],
    asher: [{ id: 'id-p2', name: 'גל רון', date: '2026-08-20', pay: 20000, status: 'active', exitDate: '' }] } };
  const pay = { ok: true, payments: [], receipts: [], funders: [{ patientId: 'id-p1', funder: 'פרטי', effectiveFrom: '2026-01-01' }, { patientId: 'id-p2', funder: 'ביטוח לאומי', effectiveFrom: '2026-01-01' }] };
  const fc = core.cashForecast(data, pay, TODAY, '2026-12-31', TODAY, CB);
  assert.ok(fc.rows.length >= 3 && fc.total > 0 && fc.unset.count > 0, 'the fixture has all three kinds');
  const same = core.sliceForecast(fc, null, '');
  for (const k of ['private', 'institutional', 'unset', 'total', 'count', 'byWeek', 'byHouse']) assert.deepEqual(same[k], fc[k], k);
  assert.deepEqual(same.rows, fc.rows);
  const priv = core.sliceForecast(fc, core.billSlice({ funder: 'פרטי' }), '');
  assert.deepEqual([priv.total, priv.institutional.total, priv.unset.count], [fc.private.total, 0, 0]);
  const house = core.sliceForecast(fc, core.billSlice({ house: 'asher' }), '');
  assert.equal(house.total, fc.institutional.total);
  assert.deepEqual(house.byHouse.map((h) => h.name), ['רעננה אשר']);
  assert.equal(core.sliceForecast(fc, core.billSlice({ q: 'אין כזה' }), '').total, 0);
});

test('sliceRefunds: name / house only, re-summed; a failed refunds read stays failed', () => {
  const rf = { ok: true, source: 'forecast', rows: [{ name: 'דנה', houseId: 'ramot', amount: 100, late: true }, { name: 'גל', houseId: 'asher', amount: 50, late: false }], count: 2, total: 150, late: 1 };
  assert.deepEqual([core.sliceRefunds(rf, core.billSlice({ house: 'asher' })).total, core.sliceRefunds(rf, core.billSlice({ house: 'asher' })).late], [50, 0]);
  assert.equal(core.sliceRefunds(rf, core.billSlice({ funder: 'פרטי' })).total, 150);
  assert.equal(core.sliceRefunds({ ok: false }, core.billSlice({ q: 'x' })).ok, false);
});

/* ---- wiring ---- */
test('wiring: one shared slice state for every section; the funder select only where rows have a funder; values validated and escaped', () => {
  assert.ok(SRC.includes('function billSliceNow() { return billSlice({ q: state.filters.q, funder: state.dueFunder, house: state.billHouse }); }'));
  for (const [fn, end, withFunder] of [['function renderDueOnDate(', 'function renderCashForecast(', true], ['function renderCashForecast(', 'function renderDebts(', true], ['function renderDebts(', 'function renderReceipts()', true],
    ['function renderReceipts()', 'function renderRefunds()', true], ['function renderRefunds()', 'function renderUnlinked(', false], ['function renderUnlinked(', '/* «ניקוי חובות היסטוריים»', false]]) {
    const block = SRC.slice(SRC.indexOf(fn), SRC.indexOf(end, SRC.indexOf(fn)));
    assert.ok(block.includes('billSliceBar(' + withFunder + ')'), fn);
    assert.ok(!/api\(/.test(block), fn + ' asks the server nothing');
  }
  const bar = SRC.slice(SRC.indexOf('function billSliceBar('), SRC.indexOf('function groupTable('));
  for (const x of ['id="crm-bill-q" value="\' + esc(sl.q)', 'id="crm-due-funder"', 'id="crm-bill-house"', 'data-bill-clear', 'esc(h.id)', 'esc(h.name)', 'esc(f)']) assert.ok(bar.includes(x), x);
  assert.ok(SRC.includes("if (t.id === 'crm-bill-house') { state.billHouse = houseId(t.value) || ''; return renderMain(); }"));
  assert.ok(SRC.includes("if (t.id === 'crm-debt-group') { state.debtGroup = DEBT_GROUPS[t.value] ? t.value : ''; return renderMain(); }"));
  assert.ok(SRC.includes("if (billingTabsFor(state.me).indexOf(g.tab) < 0) return;"), 'a card can only open a section this session has');
  const grp = SRC.slice(SRC.indexOf('function groupTable('), SRC.indexOf('function renderDueOnDate('));
  for (const x of ['esc(dim)', 'esc(g.key)', 'esc(g.label)', 'esc(title)', 'esc(fmtMoney(g.total))']) assert.ok(grp.includes(x), x);
});
