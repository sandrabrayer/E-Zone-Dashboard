'use strict';

/* «רשימת חייבים לגבייה» under «צפי תזרים» (CHANGELOG-billing-debtors-list.md).
 * Pure core: CrmCore.collectionDebtors over debtAging + getPayments shaped
 * answers. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-11';
const CYC = (balance, days, o) => Object.assign({ start: '2026-09-01', end: '2026-09-30', expected: balance, received: 0, balance: balance, days: days, kind: 'recorded', month: '2026-09' }, o || {});
const DEBT = { ok: true, asOf: TODAY, totals: {}, byHouse: [], byPatient: [
  { patientId: 'p1', patientKey: 'ramot::דנה כהן::2026-07-01', name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [CYC(3500, 70), CYC(5000, 3, { kind: 'unrecorded' })] },
  { patientId: 'p2', patientKey: 'asher::אבי רז::2026-05-01', name: 'אבי רז', houseId: 'asher', status: 'released', inHouseAtAsOf: false, cycles: [CYC(20000, 95)] },
  { patientId: 'p3', patientKey: 'rehab::גל שי::2026-08-01', name: 'גל שי', houseId: 'rehab', status: 'active', inHouseAtAsOf: true, cycles: [CYC(9000, 20, { funderGrace: true })] },
  { patientId: 'p4', patientKey: 'rehab::אפס::2026-08-01', name: 'אפס', houseId: 'rehab', status: 'active', inHouseAtAsOf: true, cycles: [CYC(0, 40)] }] };
const PAY = { ok: true, payments: [], funders: [
  { patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-07-01' },
  { patientId: 'p1', funder: 'משרד הביטחון', effectiveFrom: '2026-12-01' },          // not yet in force
  { patientId: 'rehab::גל שי::2026-08-01', funder: 'ביטוח לאומי', effectiveFrom: '2026-08-01' }],   // matched by the stay key
  receipts: [
    { id: 'r1', patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', amount: 2500, receivedDate: '2026-10-02', status: 'receipt' },
    { id: 'r2', patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', amount: 100, receivedDate: '2026-11-05', status: 'receipt' },
    { id: 'r3', patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', amount: 999, receivedDate: '2026-11-09', status: 'void' },
    { id: 'r4', patientUid: 'pX', patientName: 'אחר', houseId: 'ramot', amount: 50, receivedDate: '2026-11-10', status: 'receipt' }] };

test('every patient with an open past-due balance — in a house or released — oldest debt first; a zero balance is not a debtor', () => {
  const cd = core.collectionDebtors(DEBT, PAY, TODAY, '');
  assert.equal(cd.ok, true);
  assert.deepEqual(cd.rows.map((r) => [r.name, r.balance, r.oldestDays, r.inHouse]), [['אבי רז', 20000, 95, false], ['דנה כהן', 8500, 70, true], ['גל שי', 9000, 20, true]]);
  assert.deepEqual([cd.count, cd.total, cd.inHouse], [3, 37500, 2]);
});

test('the total equals the sum of the SAME per-patient debt figures «חובות פתוחים לפי מטופל/ת» shows (no second debt computation)', () => {
  const b = core.billingOverview(DEBT, PAY, TODAY);
  const cd = core.collectionDebtors(DEBT, PAY, TODAY, '');
  const sum = b.patients.reduce((t, p) => t + p.balance, 0);
  assert.equal(cd.total, sum);
  for (const r of cd.rows) assert.equal(r.balance, b.patients.find((p) => p.id === r.id).balance, r.name);
  assert.ok(SRC.includes('const b = billingOverview(scoped, payments, today);'), 'built on billingOverview (the same roll-up, with or without a period)');
});

test('funder = the one in force today (by patient id or stay key); none → «לא הוגדר»; the grace flag and the unrecorded count ride along', () => {
  const cd = core.collectionDebtors(DEBT, PAY, TODAY, '');
  const by = Object.fromEntries(cd.rows.map((r) => [r.name, r]));
  assert.equal(by['דנה כהן'].funder, 'פרטי', 'the future funder row is not in force yet');
  assert.equal(by['גל שי'].funder, 'ביטוח לאומי');
  assert.equal(by['אבי רז'].funder, 'לא הוגדר');
  assert.equal(by['גל שי'].grace, true); assert.equal(by['דנה כהן'].unrecorded, 1); assert.equal(by['דנה כהן'].cycles, 2);
});

test('last payment = the latest real receipt of THAT patient (void and other people ignored); none → empty', () => {
  const by = Object.fromEntries(core.collectionDebtors(DEBT, PAY, TODAY, '').rows.map((r) => [r.name, r]));
  assert.equal(by['דנה כהן'].lastPaid, '2026-11-05');
  assert.equal(by['אבי רז'].lastPaid, '');
});

test('the funder filter narrows the list and its total; `all` still says how many debtors exist', () => {
  const cd = core.collectionDebtors(DEBT, PAY, TODAY, 'ביטוח לאומי');
  assert.deepEqual([cd.count, cd.total, cd.all, cd.funder], [1, 9000, 4, 'ביטוח לאומי']);
  assert.equal(core.collectionDebtors(DEBT, PAY, TODAY, 'מכבי').count, 0);
});

test('fail-soft: debt not loaded → ok:false + no rows (never «אין חובות»); payments missing → the debts still list, funder «לא הוגדר»', () => {
  for (const bad of [null, undefined, { ok: false, error: 'boom' }]) {
    const cd = core.collectionDebtors(bad, PAY, TODAY, '');
    assert.equal(cd.ok, false); assert.equal(cd.count, 0);
  }
  const cd = core.collectionDebtors(DEBT, { ok: false }, TODAY, '');
  assert.equal(cd.ok, true); assert.equal(cd.count, 3);
  assert.ok(cd.rows.every((r) => r.funder === 'לא הוגדר' && r.lastPaid === ''));
  assert.match(SRC, /חובות לא נטענו <button type="button" class="btn small" data-billing-retry>/);
});

test('wiring: rendered inside «צפי תזרים», open by default, rows open «חשבון», every text cell escaped, no new request', () => {
  const fc = SRC.slice(SRC.indexOf('function renderCashForecast()'), SRC.indexOf('function renderCollectionDebtors()'));
  assert.ok(fc.includes('html += renderCollectionDebtors();'), 'inside the forecast block');
  assert.ok(fc.indexOf('html += renderCollectionDebtors();') < fc.indexOf('id="crm-fc-weeks"'), 'right under the cards, before the weekly table');
  const block = SRC.slice(SRC.indexOf('function renderCollectionDebtors()'), SRC.indexOf('function renderCleanup()'));
  assert.ok(block.includes("'<details id=\"crm-fc-debtors\"' + (state.fcDebtorsClosed ? '' : ' open')"));
  assert.ok(block.includes('data-open-patient="\' + esc(r.id) + \'" data-open-tab="account"'));
  for (const cell of ['esc(r.name)', 'esc(r.houseName)', 'esc(r.funder)', 'esc(fmtMoney(r.balance))']) assert.ok(block.includes(cell), cell);
  assert.ok(!/api\(/.test(block), 'computed from the loaded reads');
  assert.ok(SRC.includes("if (ev.target && ev.target.id === 'crm-fc-debtors') state.fcDebtorsClosed = !ev.target.open;"), 'closing it survives a re-render');
});
