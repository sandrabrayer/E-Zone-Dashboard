'use strict';

/* «לגבייה בתאריך» inside the CRM (CHANGELOG-crm-collect-on-date.md).
 * Pure core: CrmCore.dueOnDate / filterDueRows / monthSplit, over getData +
 * getPayments shaped answers. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

const ROOT = path.join(__dirname, '..');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');

const KEY = (h, n, d) => h + '::' + n + '::' + d;

function data(patients, overrides) {
  return { ok: true, leads: [], patients: { arfoni: patients }, billingOverrides: overrides || [] };
}
const P = (o) => Object.assign({ id: 'id-p1', name: 'דן לוי', date: '2026-07-27', pay: 30000, status: 'active', exitDate: '' }, o || {});
const PAY = (o) => Object.assign({ payments: [], receipts: [], funders: [], ok: true }, o || {});

test('a patient is due on each monthly anniversary of entry, not on other days', () => {
  const d = data([P()]);
  assert.equal(core.dueOnDate(d, PAY(), '2026-08-27', CB).count, 1);
  assert.equal(core.dueOnDate(d, PAY(), '2026-08-26', CB).count, 0);
  assert.equal(core.dueOnDate(d, PAY(), '2026-06-27', CB).count, 0, 'never before entry');
});

test('discharged ON the billing day → not due that day (the reported case); earlier cycles still are', () => {
  const d = data([P({ status: 'released', exitDate: '2026-10-27' })]);
  assert.equal(core.dueOnDate(d, PAY(), '2026-10-27', CB).count, 0);
  assert.equal(core.dueOnDate(d, PAY(), '2026-09-27', CB).count, 1);
  // a day after the billing day → that cycle was entered
  assert.equal(core.dueOnDate(data([P({ status: 'released', exitDate: '2026-10-28' })]), PAY(), '2026-10-27', CB).count, 1);
  // released with no exit date → not listed (the classic conservative reading)
  assert.equal(core.dueOnDate(data([P({ status: 'released', exitDate: '' })]), PAY(), '2026-09-27', CB).count, 0);
});

test('month-end clamp: entry on the 31st is due on the 30th of a 30-day month', () => {
  const d = data([P({ date: '2026-08-31' })]);
  assert.equal(core.dueOnDate(d, PAY(), '2026-09-30', CB).count, 1);
  assert.equal(core.dueOnDate(d, PAY(), '2026-10-31', CB).count, 1);
});

test('no Payments row → unpaid at the agreed price, override and discount applied', () => {
  const key = KEY('arfoni', 'דן לוי', '2026-07-27');
  const r = core.dueOnDate(data([P()], [{ patientId: key, month: '2026-08', amount: '28000', discountAmount: '1000' }]), PAY(), '2026-08-27', CB).rows[0];
  assert.equal(r.expected, 27000);
  assert.equal(r.paid, 0);
  assert.equal(r.balance, 27000);
  assert.equal(r.status, 'unpaid');
  assert.equal(r.recorded, false);
  assert.equal(r.cycle.id, 'pay::' + key + '::2026-08-27');
  assert.equal(r.cycle.coverageStart, '2026-08-27');
  assert.equal(r.cycle.coverageEnd, '2026-09-26');
});

test('a stamped row above the corrected agreed price, fully paid at the new price → paid, no phantom balance', () => {
  const key = KEY('arfoni', 'דן לוי', '2026-07-27');
  const pay = PAY({ payments: [{ id: 'pay::' + key + '::2026-09-27', patientId: key, patientUid: 'id-p1', patientName: 'דן לוי', houseId: 'arfoni',
    dueDate: '2026-09-27', amount: 33000, amountPaid: 30000, status: 'partial', balance: 3000, coverageStart: '2026-09-27', coverageEnd: '2026-10-26' }] });
  const r = core.dueOnDate(data([P()]), pay, '2026-09-27', CB).rows[0];
  assert.equal(r.status, 'paid');
  assert.equal(r.balance, 0);
  assert.equal(r.paid, 30000);
  assert.equal(r.recorded, true);
  assert.equal(r.cycle.id, 'pay::' + key + '::2026-09-27', 'the report goes to the existing row');
});

test('pro-bono on the date → not listed; funder recorded on the row otherwise', () => {
  const key = KEY('arfoni', 'דן לוי', '2026-07-27');
  const pb = PAY({ funders: [{ patientId: key, funder: 'פרו-בונו', effectiveFrom: '2026-08-01' }] });
  assert.equal(core.dueOnDate(data([P()]), pb, '2026-08-27', CB).count, 0);
  assert.equal(core.dueOnDate(data([P()]), pb, '2026-07-27', CB).count, 1, 'before it took effect');
  const ml = PAY({ funders: [{ patientUid: 'id-p1', patientId: 'id-p1', funder: 'מכבי', effectiveFrom: '2026-07-01' }] });
  assert.equal(core.dueOnDate(data([P()]), ml, '2026-08-27', CB).rows[0].funder, 'מכבי');
  assert.equal(core.dueOnDate(data([P()]), PAY(), '2026-08-27', CB).rows[0].funder, core.FUNDER_UNSET_LABEL);
});

test('KPIs + filters: funder and name search recompute the totals', () => {
  const d = data([P(), P({ id: 'id-p2', name: 'רון כץ', pay: 35000 })]);
  const due = core.dueOnDate(d, PAY(), '2026-08-27', CB);
  assert.equal(due.count, 2);
  assert.equal(due.total, 65000);
  assert.equal(due.collected, 0);
  const one = core.filterDueRows(due, '', 'רון');
  assert.equal(one.count, 1);
  assert.equal(one.total, 35000);
  assert.equal(core.filterDueRows(due, 'מכבי', '').count, 0);
});

test('a void Payments row is ignored; a missing payments answer still lists at the card price with an error', () => {
  const key = KEY('arfoni', 'דן לוי', '2026-07-27');
  const v = PAY({ payments: [{ id: 'x', patientId: key, dueDate: '2026-08-27', amount: 30000, amountPaid: 30000, status: 'void' }] });
  assert.equal(core.dueOnDate(data([P()]), v, '2026-08-27', CB).rows[0].status, 'unpaid');
  const miss = core.dueOnDate(data([P()]), { ok: false, error: 'forbidden' }, '2026-08-27', CB);
  assert.equal(miss.count, 1);
  assert.equal(miss.error, 'forbidden');
  assert.equal(core.dueOnDate(data([P()]), PAY(), 'nope', CB).error, 'bad_date');
});

test('monthSplit: the coverage-month split adds up to the cycle price', () => {
  const s = core.monthSplit('2026-10-27', '2026-11-26', 30000);
  assert.deepEqual(s.map((x) => [x.month, x.days]), [['2026-10', 5], ['2026-11', 26]]);
  assert.equal(s[0].amount + s[1].amount, 30000);
  assert.equal(s[0].amount, 4839);
});

test('page wiring: cycle-balance loaded before crm.js; the date list renders above the debt KPIs; escaped; no report for Ortal', () => {
  assert.ok(CRM_HTML.indexOf('cycle-balance.js') > 0 && CRM_HTML.indexOf('cycle-balance.js') < CRM_HTML.indexOf('crm/crm.js'));
  // the cash-flow forecast sits between the date list and the debt KPIs (CHANGELOG-cashflow-forecast.md)
  assert.match(CRM_SRC, /html \+= renderDueOnDate\(isController\);\n\s+html \+= renderCashForecast\(\);\n\s+html \+= '<div class="kpis">' \+ kpi\(fmtMoney\(b\.openDebt\)/);
  const fn = CRM_SRC.slice(CRM_SRC.indexOf('function renderDueOnDate('), CRM_SRC.indexOf('function renderCashForecast('));
  assert.match(fn, /!isController && r\.balance > 0 \? '<button type="button" class="btn small primary" data-due-report=/);
  assert.match(fn, /esc\(r\.name\)/);
  assert.doesNotMatch(fn, /\+ r\.name \+/, 'every name goes through esc()');
});
