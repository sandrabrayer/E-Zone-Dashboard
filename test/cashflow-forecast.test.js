'use strict';

/* «צפי תזרים» — the cash-flow forecast in the CRM «גבייה» area
 * (CHANGELOG-cashflow-forecast.md). Pure core: CrmCore.cashForecast over
 * getData + getPayments shaped answers. Names are SYNTHETIC.
 *
 * Sandra's rules (08/11/2026):
 *   - active patients only, no past debt;
 *   - private: on the due date; institutional (ביטוח לאומי / מכבי / משרד
 *     הביטחון): «שוטף +30» — expected 30 days after the due date;
 *   - pro-bono never; no funder → its own line, not in the total. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');
const FG = require('../lib/funder-grace.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-08';
const KEY = (h, n, d) => h + '::' + n + '::' + d;

function data(byHouse, overrides) {
  return { ok: true, leads: [], patients: byHouse, billingOverrides: overrides || [] };
}
const P = (o) => Object.assign({ id: 'id-p1', name: 'דן לוי', date: '2026-07-17', pay: 30000, status: 'active', exitDate: '' }, o || {});
const PAY = (o) => Object.assign({ ok: true, payments: [], receipts: [], funders: [] }, o || {});
const FUND = (id, funder, from) => ({ patientId: id, funder: funder, effectiveFrom: from || '2026-01-01' });
const fc = (d, p, from, to, today) => core.cashForecast(d, p, from || TODAY, to || '2026-11-30', today || TODAY, CB);

test('private: the cycle due inside the range, on its due date, at its open balance', () => {
  const r = fc(data({ ramot: [P()] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.equal(r.rows.length, 1);
  assert.deepEqual([r.rows[0].kind, r.rows[0].dueDate, r.rows[0].expectedDate, r.rows[0].amount], ['private', '2026-11-17', '2026-11-17', 30000]);
  assert.deepEqual(r.private, { count: 1, total: 30000 });
  assert.equal(r.total, 30000);
});

test('no past debt: a private cycle due before today is never in the forecast', () => {
  // entry 03/07 → due 03/11 (unpaid, 5 days ago) and 03/12 (outside the range)
  const r = fc(data({ ramot: [P({ date: '2026-07-03' })] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.total, 0);
});

test('a range that starts in the past starts today', () => {
  const r = fc(data({ ramot: [P({ date: '2026-07-03' })] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }), '2026-10-01', '2026-12-31');
  assert.equal(r.from, TODAY);
  assert.deepEqual(r.rows.map((x) => x.dueDate), ['2026-12-03']);
});

test('institutional «שוטף +30»: expected 30 days after the due date — a cycle due last month that is still within terms counts', () => {
  for (const funder of ['ביטוח לאומי', 'מכבי', 'משרד הביטחון']) {
    const r = fc(data({ ramot: [P({ date: '2026-07-20' })] }), PAY({ funders: [FUND('id-p1', funder)] }));
    // due 20/10 → expected 19/11 (in range); due 20/11 → 20/12 (after the range)
    assert.deepEqual(r.rows.map((x) => [x.kind, x.dueDate, x.expectedDate]), [['institutional', '2026-10-20', '2026-11-19']], funder);
    assert.deepEqual(r.institutional, { count: 1, total: 30000 });
    assert.equal(r.private.count, 0);
  }
});

test('institutional: a cycle whose «שוטף +30» date already passed is past debt — excluded', () => {
  // due 05/10 → expected 04/11, before today
  const r = fc(data({ ramot: [P({ date: '2026-07-05' })] }), PAY({ funders: [FUND('id-p1', 'ביטוח לאומי')] }));
  assert.equal(r.rows.length, 0);
});

test('the funder on the DUE date decides (a change mid-stay moves later cycles only)', () => {
  const d = data({ ramot: [P({ date: '2026-07-20' })] });
  const p = PAY({ funders: [FUND('id-p1', 'ביטוח לאומי', '2026-07-20'), FUND('id-p1', 'פרטי', '2026-11-01')] });
  const r = fc(d, p, TODAY, '2026-12-31');
  // 20/10 under ביטוח לאומי → 19/11; 20/11 private → 20/11; 20/12 private → 20/12
  assert.deepEqual(r.rows.map((x) => [x.dueDate, x.kind, x.expectedDate]), [
    ['2026-10-20', 'institutional', '2026-11-19'], ['2026-11-20', 'private', '2026-11-20'], ['2026-12-20', 'private', '2026-12-20']]);
});

test('released patients are never forecast, even with a cycle date ahead; pro-bono neither', () => {
  const d = data({ ramot: [P({ status: 'released', exitDate: '2026-11-25' }), P({ id: 'id-p2', name: 'גל', date: '2026-07-18' })] });
  const r = fc(d, PAY({ funders: [FUND('id-p1', 'פרטי'), FUND('id-p2', 'פרו-בונו')] }));
  assert.equal(r.rows.length, 0);
});

test('an active patient leaving before the due date: no cycle on or after the exit', () => {
  const r = fc(data({ ramot: [P({ exitDate: '2026-11-17' })] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.equal(r.rows.length, 0, 'leaving on the billing day opens no new cycle');
});

test('prepaid / partly paid / discounted: only the open balance is expected', () => {
  const key = KEY('ramot', 'דן לוי', '2026-07-17');
  const paid = PAY({ funders: [FUND('id-p1', 'פרטי')], payments: [{ id: 'c1', patientId: key, dueDate: '2026-11-17', amount: 30000, amountPaid: 30000, status: 'paid' }] });
  assert.equal(fc(data({ ramot: [P()] }), paid).rows.length, 0, 'an advance already paid brings nothing');
  const part = PAY({ funders: [FUND('id-p1', 'פרטי')], payments: [{ id: 'c1', patientId: key, dueDate: '2026-11-17', amount: 30000, amountPaid: 10000, status: 'partial' }] });
  const r = fc(data({ ramot: [P()] }), part);
  assert.equal(r.rows[0].amount, 20000);
  assert.equal(r.rows[0].paid, 10000);
  const disc = fc(data({ ramot: [P()] }, [{ id: 'ovr::' + key + '::2026-11', patientId: key, month: '2026-11', amount: '', discountAmount: 5000 }]), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.equal(disc.rows[0].amount, 25000, 'discount net');
  const ovr = fc(data({ ramot: [P()] }, [{ id: 'ovr::' + key + '::2026-11', patientId: key, month: '2026-11', amount: 28000 }]), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.equal(ovr.rows[0].amount, 28000, 'the month override wins');
});

test('no funder on the due date → the «לא הוגדר» line, never in the total', () => {
  const r = fc(data({ ramot: [P()] }), PAY());
  assert.equal(r.rows[0].kind, 'unset');
  assert.deepEqual(r.unset, { count: 1, total: 30000 });
  assert.equal(r.total, 0);
  assert.equal(r.byWeek.length, 0);
  assert.equal(r.byHouse.length, 0);
});

test('by week (Sunday) and by house add up to the total', () => {
  const d = data({
    ramot: [P(), P({ id: 'id-p2', name: 'גל', date: '2026-08-10', pay: 20000 })],
    pardes: [P({ id: 'id-p3', name: 'שי', date: '2026-07-24', pay: 35000 })],
  });
  const p = PAY({ funders: [FUND('id-p1', 'פרטי'), FUND('id-p2', 'פרטי'), FUND('id-p3', 'מכבי')] });
  const r = fc(d, p);
  // p1 17/11 (week of 15/11), p2 10/11 (week of 08/11), p3 due 24/10 → 23/11 (week of 22/11)
  assert.deepEqual(r.byWeek.map((w) => [w.weekStart, w.total]), [['2026-11-08', 20000], ['2026-11-15', 30000], ['2026-11-22', 35000]]);
  assert.equal(r.total, 85000);
  assert.equal(r.byWeek.reduce((t, w) => t + w.total, 0), r.total);
  assert.equal(r.byHouse.reduce((t, h) => t + h.total, 0), r.total);
  assert.deepEqual(r.byHouse.map((h) => [h.name, h.total]), [['רמות השבים', 50000], ['רעננה הפרדס', 35000]], 'largest first');
});

test('month-end clamping: entry on the 31st is due on the last day of a short month', () => {
  const r = fc(data({ ramot: [P({ date: '2026-08-31' })] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }));
  assert.deepEqual(r.rows.map((x) => x.dueDate), ['2026-11-30']);
});

test('«שוטף +30» across a year boundary', () => {
  const r = fc(data({ ramot: [P({ date: '2026-09-15' })] }), PAY({ funders: [FUND('id-p1', 'משרד הביטחון')] }), '2027-01-01', '2027-01-31', TODAY);
  assert.deepEqual(r.rows.map((x) => [x.dueDate, x.expectedDate]), [['2026-12-15', '2027-01-14']]);
});

test('bad input never throws: bad dates, an inverted range, a missing payments answer', () => {
  assert.equal(core.cashForecast(data({}), PAY(), 'x', '2026-11-30', TODAY, CB).error, 'bad_date');
  assert.equal(core.cashForecast(data({}), PAY(), '2026-12-01', '2026-11-30', TODAY, CB).error, 'bad_range');
  const r = core.cashForecast(data({ ramot: [P()] }), { ok: false, error: 'boom' }, TODAY, '2026-11-30', TODAY, CB);
  assert.equal(r.error, 'boom');
  assert.equal(r.rows[0].kind, 'unset', 'still computed from the agreed price');
  assert.doesNotThrow(() => core.cashForecast(null, null, TODAY, '2026-11-30', TODAY, CB));
});

test('presets: to month end, next month, 90 days', () => {
  assert.deepEqual(core.forecastPreset('month', TODAY), { from: TODAY, to: '2026-11-30' });
  assert.deepEqual(core.forecastPreset('next', TODAY), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(core.forecastPreset('90', TODAY), { from: TODAY, to: '2027-02-06' });
  assert.deepEqual(core.forecastPreset('next', '2026-12-15'), { from: '2027-01-01', to: '2027-01-31' });
});

test('pins: the terms days = the funder grace window; the institutional list = the grace funders', () => {
  assert.equal(core.FORECAST_TERMS_DAYS, FG.FUNDER_GRACE_DAYS);
  const graceKeys = core.FORECAST_INSTITUTIONAL.map((f) => FG.graceFunderKey(f));
  assert.ok(graceKeys.every(Boolean), 'every institutional label is a grace funder');
  assert.equal(new Set(graceKeys).size, FG.FUNDER_GRACE_KEYS.length);
});

test('the shared cycle rule: dueOnDate and the forecast read the same cycle (cycleOnDay)', () => {
  const d = data({ ramot: [P()] });
  const p = PAY({ funders: [FUND('id-p1', 'פרטי')] });
  const due = core.dueOnDate(d, p, '2026-11-17', CB).rows[0];
  const f = fc(d, p).rows[0];
  assert.equal(f.amount, due.balance);
  assert.deepEqual([f.start, f.end], [due.start, due.end]);
  assert.match(SRC, /const row = cycleOnDay\(pt, day, k, ctx\);/);
  assert.match(SRC, /const row = cycleOnDay\(pt, due, k, ctx\);/);
});

test('UI wiring: the section sits under «לגבייה בתאריך», dates and presets re-render, every value escaped', () => {
  assert.match(SRC, /html \+= renderDueOnDate\(isController\);\n\s+html \+= renderCashForecast\(\);/);
  assert.match(SRC, /if \(t\.id === 'crm-fc-from'\) \{ if \(isoDateOk\(t\.value\)\) state\.fcFrom = t\.value; return renderMain\(\); \}/);
  assert.match(SRC, /if \(t\.dataset\.fcPreset\) \{ const r = forecastPreset\(t\.dataset\.fcPreset, state\.today\);/);
  const fn = SRC.slice(SRC.indexOf('function renderCashForecast('), SRC.indexOf('function renderBilling('));
  assert.ok(fn.length > 100);
  assert.doesNotMatch(fn, /\+ r\.(name|houseName|funder) \+/, 'row text always through esc()');
  assert.doesNotMatch(fn, /fetch\(|api\(/, 'read-only: no request of its own');
});
