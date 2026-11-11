'use strict';

/* «צפי תזרים» net of the refunds to pay (CHANGELOG-cashflow-refunds.md).
 * Pure core: CrmCore.forecastRefunds / cashForecastNet. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');
const scope = require('../lib/finance-scope.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-11';
const ROW = (o) => Object.assign({ creditId: 'cr-1', auto: false, patientName: 'דן לוי', houseId: 'ramot', amount: 4000, payoutDate: '2026-11-15', creditType: 'days_unused' }, o || {});
const FORECAST = (rows) => ({ ok: true, today: TODAY, toPay: { count: rows.length, total: 0, rows: rows } });
const rf = (f, c, from, to) => core.forecastRefunds(f, c, from || TODAY, to || '2026-11-30', TODAY);

test('a refund is placed on its payout date; only refunds inside the range count', () => {
  const r = rf(FORECAST([ROW(), ROW({ creditId: 'cr-2', patientName: 'גל', amount: 2500, payoutDate: '2026-12-15' })]));
  assert.equal(r.ok, true); assert.equal(r.source, 'forecast');
  assert.deepEqual(r.rows.map((x) => [x.name, x.expectedDate, x.amount, x.late]), [['דן לוי', '2026-11-15', 4000, false]]);
  assert.deepEqual([r.count, r.total], [1, 4000]);
  const wide = rf(FORECAST([ROW(), ROW({ creditId: 'cr-2', amount: 2500, payoutDate: '2026-12-15' })]), null, TODAY, '2026-12-31');
  assert.deepEqual([wide.count, wide.total], [2, 6500]);
});

test('a payout date that passed (or none) is money still owed → today, flagged late only when it had a date', () => {
  const r = rf(FORECAST([ROW({ payoutDate: '2026-10-15' }), ROW({ creditId: 'cr-3', patientName: 'נוי', amount: 100, payoutDate: '' })]));
  assert.deepEqual(r.rows.map((x) => [x.expectedDate, x.late, x.payoutDate]), [['2026-11-11', true, '2026-10-15'], ['2026-11-11', false, '']]);
  assert.equal(r.late, 1);
  // a range that starts later than today does not carry the overdue ones
  assert.equal(rf(FORECAST([ROW({ payoutDate: '2026-10-15' })]), null, '2026-12-01', '2026-12-31').count, 0);
});

test('computed lines (no decision yet) are included and marked; zero / negative / junk amounts are never rows', () => {
  const r = rf(FORECAST([ROW({ creditId: '', auto: true, amount: 1800 }), ROW({ amount: 0 }), ROW({ amount: -5 }), ROW({ amount: 'x' }), null]));
  assert.deepEqual([r.count, r.total, r.auto], [1, 1800, 1]);
  assert.equal(r.rows[0].auto, true);
});

test('a Sheets date object string (UTC timestamp) is read as its Israel day, and the house id becomes its Hebrew name', () => {
  const r = rf(FORECAST([ROW({ payoutDate: '2026-11-14T22:00:00.000Z', houseId: 'asher' })]));
  assert.equal(r.rows[0].expectedDate, '2026-11-15');
  assert.equal(r.rows[0].houseName, 'רעננה אשר');
});

test('fallback: the forecast read failed → the saved pending credits alone (source «credits»); both failed → ok:false, nothing invented', () => {
  const credits = { ok: true, credits: [
    { id: 'cr-1', patientName: 'דן לוי', houseId: 'ramot', creditType: 'days_unused', allocationMonth: '2026-10', amount: 4000, status: 'pending', payoutDate: '2026-11-15' },
    { id: 'cr-2', patientName: 'שולם', houseId: 'ramot', creditType: 'other', allocationMonth: '2026-10', amount: 900, status: 'paid', payoutDate: '2026-11-15' },
    { id: 'cr-3', patientName: 'בוטל', houseId: 'ramot', creditType: 'other', allocationMonth: '2026-10', amount: 900, status: 'cancelled', payoutDate: '2026-11-15' }] };
  const r = rf({ ok: false, error: 'forecast_failed' }, credits);
  assert.deepEqual([r.ok, r.source, r.count, r.total], [true, 'credits', 1, 4000]);
  for (const bad of [null, undefined, { ok: false }, { ok: true }, { ok: true, toPay: {} }]) {
    const none = rf(bad, { ok: false, error: 'x' });
    assert.deepEqual([none.ok, none.source, none.count, none.total], [false, 'none', 0, 0]);
  }
});

test('bad dates / a reversed range → ok:false; a range that starts in the past starts today', () => {
  assert.equal(core.forecastRefunds(FORECAST([ROW()]), null, 'x', '2026-11-30', TODAY).ok, false);
  assert.equal(core.forecastRefunds(FORECAST([ROW()]), null, '2026-11-20', '2026-11-12', TODAY).ok, false);
  const r = core.forecastRefunds(FORECAST([ROW()]), null, '2026-10-01', '2026-11-30', TODAY);
  assert.equal(r.from, TODAY); assert.equal(r.count, 1);
});

test('cashForecastNet: net = receipts − refunds, in total and per week; a week with refunds only is a row; the income columns are untouched', () => {
  const data = { ok: true, leads: [], patients: { ramot: [{ id: 'id-p1', name: 'דן לוי', date: '2026-07-17', pay: 30000, status: 'active', exitDate: '' }] }, billingOverrides: [] };
  const pay = { ok: true, payments: [], receipts: [], funders: [{ patientId: 'id-p1', funder: 'פרטי', effectiveFrom: '2026-01-01' }] };
  const fc = core.cashForecast(data, pay, TODAY, '2026-11-30', TODAY, CB);
  assert.equal(fc.total, 30000);
  const refunds = rf(FORECAST([ROW({ payoutDate: '2026-10-15', amount: 1000 }), ROW({ creditId: 'cr-2', amount: 4000, payoutDate: '2026-11-17' })]));
  const net = core.cashForecastNet(fc, refunds);
  assert.deepEqual([net.known, net.income, net.refunds, net.refundCount, net.net], [true, 30000, 5000, 2, 25000]);
  assert.deepEqual(net.byWeek.map((w) => [w.weekStart, w.total, w.refunds, w.net]), [['2026-11-08', 0, 1000, -1000], ['2026-11-15', 30000, 4000, 26000]]);
  assert.equal(net.byWeek.reduce((t, w) => t + w.net, 0), net.net, 'the weeks add up to the net');
  assert.equal(fc.total, 30000, 'cashForecast itself is unchanged');
});

test('cashForecastNet with refunds unknown: known:false, net = income, no refund column data — never a silent 0 presented as a figure', () => {
  const net = core.cashForecastNet({ total: 12000, byWeek: [{ weekStart: '2026-11-15', private: 12000, institutional: 0, total: 12000 }] }, rf(null, null));
  assert.deepEqual([net.known, net.net, net.refunds], [false, 12000, 0]);
  assert.match(SRC, /זיכויים לתשלום · לא נטענו/);
  assert.match(SRC, /זיכויים לתשלום לא נטענו — הצפי מוצג ללא הפחתת זיכויים/);
});

test('fmtSigned: a negative amount reads «−₪…»', () => {
  assert.equal(core.fmtSigned(-5000), '−₪5,000'); assert.equal(core.fmtSigned(5000), '₪5,000'); assert.equal(core.fmtSigned(0), '₪0'); assert.equal(core.fmtSigned('x'), '₪0');
  // on the RTL page the minus must stay in front of the amount
  assert.ok(SRC.includes("function signedHtml(n) { return '<bdi dir=\"ltr\">' + esc(fmtSigned(n)) + '</bdi>'; }"));
});

test('wiring: «גבייה» reads refundPayoutForecast fail-soft with its other reads; the action is a READ both Vered/Sandra and Ortal may call; every rendered value is escaped', () => {
  assert.ok(SRC.includes("const refundP = api('refundPayoutForecast').catch("));
  assert.ok(SRC.includes("state.billing = { debt: res[0], payments: res[1], credits: res[2], refunds: res[3] };"));
  assert.ok(SRC.includes('forecastRefunds(state.billing.refunds, state.billing.credits, fc.from, fc.to, state.today)'));
  assert.ok(scope.CONTROLLER_ACTIONS.includes('refundPayoutForecast'), 'Ortal may read it');
  assert.ok(scope.FINANCE_ACTIONS.includes('refundPayoutForecast'), 'finance-gated: Dana never reads it');
  const block = SRC.slice(SRC.indexOf('function renderCashForecast()'), SRC.indexOf('function renderCleanup()'));
  for (const id of ['crm-fc-refunds', 'crm-fc-net', 'crm-fc-refund-detail', 'crm-fc-refund-rows']) assert.ok(block.includes(id), id);
  assert.ok(block.includes("esc(r.name)") && block.includes("esc(r.houseName)") && block.includes("esc(fmtMoney(r.amount))"));
  assert.ok(!/'<td>' \+ r\.(name|houseName)/.test(block), 'no unescaped text cell');
});
