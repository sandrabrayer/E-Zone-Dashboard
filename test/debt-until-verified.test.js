'use strict';

/* CHANGELOG-debt-until-verified.md — in the CRM a reported payment stays an open
 * debt («דווח — ממתין לאימות») until Ortal verifies it. The server engine is not
 * changed; the unverified money is added back here from getPayments. Synthetic names. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const TODAY = '2026-11-15';
const rc = (o) => Object.assign({ patientUid: 'p1', patientId: 'ramot::דנה כהן::2026-09-01', patientName: 'דנה כהן', houseId: 'ramot', receivedDate: '2026-11-10', dueDate: '2026-11-01', amount: 1000, confirmStatus: 'reported' }, o);
const PAY = { ok: true, funders: [{ patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-09-01' }], payments: [], receipts: [
  rc({ id: 'rcpt-a' }),                                                            // waits: 1000
  rc({ id: 'rcpt-b', confirmStatus: 'confirmed', amount: 700 }),                    // verified: nothing
  rc({ id: 'rcpt-c', confirmStatus: 'partial', amount: 900, confirmedAmount: 600 }), // 300 still waits
  rc({ id: 'rcpt-d', confirmStatus: 'flagged', amount: 400 }),                      // 400 waits
  rc({ id: 'rcpt-e', status: 'void', amount: 5000 }),                               // void: nothing
  rc({ id: 'pay::legacy', amount: 5000 }),                                          // a cycle row, not a receipt
  rc({ id: 'rcpt-f', patientUid: 'p7', patientId: 'asher::גל רון::2026-08-01', patientName: 'גל רון', houseId: 'asher', amount: 250, dueDate: '2026-10-05', receivedDate: '2026-10-06' }),
] };
const DEBT = { ok: true, asOf: TODAY, byPatient: [{ patientId: 'p1', patientKey: 'ramot::דנה כהן::2026-09-01', name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true,
  cycles: [{ start: '2026-10-01', balance: 2000, days: 45, kind: 'recorded' }] }] };
const PATIENTS = [{ id: 'p1', name: 'דנה כהן', houseId: 'ramot', status: 'active' }, { id: 'p7', name: 'גל רון', houseId: 'asher', status: 'released', exitDate: '2026-10-20' }];

test('what still waits: reported and flagged whole, partial only its unverified part; confirmed, void and legacy rows nothing', () => {
  const u = core.unverifiedReceipts(PAY);
  assert.deepEqual(u.map((r) => [r.id, r.amount, r.status]), [['rcpt-a', 1000, 'reported'], ['rcpt-c', 300, 'partial'], ['rcpt-d', 400, 'flagged'], ['rcpt-f', 250, 'reported']]);
  assert.deepEqual(core.unverifiedTotal(PAY), { count: 4, total: 1950 });
  assert.deepEqual(core.unverifiedTotal(null), { count: 0, total: 0 });
  assert.deepEqual(core.unverifiedTotal({ ok: false }), { count: 0, total: 0 });
  // a partial with no usable confirmedAmount: the whole amount waits (never less than the truth)
  assert.equal(core.unverifiedReceipts({ ok: true, receipts: [rc({ id: 'rcpt-x', confirmStatus: 'partial', amount: 900 })] })[0].amount, 900);
});

test('«חובות פתוחים»: the waiting money is part of the debt, marked; a patient who only reported is listed too', () => {
  const cd = core.collectionDebtors(DEBT, PAY, TODAY, '', null, PATIENTS);
  const by = Object.fromEntries(cd.rows.map((r) => [r.name, r]));
  assert.equal(by['דנה כהן'].balance, 2000 + 1700); assert.equal(by['דנה כהן'].unverified, 1700); assert.equal(by['דנה כהן'].unverifiedCount, 3);
  assert.equal(by['דנה כהן'].cycles, 1, 'the server\'s open cycles are unchanged');
  assert.deepEqual([by['גל רון'].balance, by['גל רון'].unverified, by['גל רון'].cycles, by['גל רון'].inHouse, by['גל רון'].status, by['גל רון'].houseName !== ''], [250, 250, 0, false, 'released', true]);
  assert.equal(by['גל רון'].oldestDays, 41, 'aged from the cycle\'s billing day'); assert.equal(by['גל רון'].bucket, 'd31_60');
  assert.equal(cd.total, 3950); assert.equal(cd.unverified, 1950); assert.equal(cd.unverifiedCount, 4); assert.equal(cd.count, 2);
});

test('verifying removes it: once the receipts are confirmed the debt is the server\'s alone', () => {
  let receipts = PAY.receipts;
  for (const id of ['rcpt-a', 'rcpt-c', 'rcpt-d', 'rcpt-f']) receipts = core.applyVerified(receipts, id, 'אורטל', '');
  const cd = core.collectionDebtors(DEBT, Object.assign({}, PAY, { receipts }), TODAY, '', null, PATIENTS);
  assert.deepEqual(cd.rows.map((r) => [r.name, r.balance, r.unverified]), [['דנה כהן', 2000, 0]]);
  assert.equal(cd.unverified, 0);
});

test('a period and a funder filter apply to the waiting money as well; missing debt answer adds nothing', () => {
  const oct = core.collectionDebtors(DEBT, PAY, TODAY, '', { from: '2026-10-01', to: '2026-10-31' }, PATIENTS);
  assert.deepEqual(Object.fromEntries(oct.rows.map((r) => [r.name, [r.balance, r.unverified]])), { 'דנה כהן': [2000, 0], 'גל רון': [250, 250] }, 'November receipts are outside October');
  const priv = core.collectionDebtors(DEBT, PAY, TODAY, 'פרטי', null, PATIENTS);
  assert.deepEqual(priv.rows.map((r) => r.name), ['דנה כהן'], 'the other patient has no funder → not «פרטי»');
  const bad = core.collectionDebtors({ ok: false, error: 'x' }, PAY, TODAY, '', null, PATIENTS);
  assert.equal(bad.ok, false); assert.equal(bad.rows.length, 0);
});

test('the patient account shows the waiting part; the engine and the write paths are untouched', () => {
  const a = core.patientAccount({ id: 'p1', name: 'דנה כהן', houseId: 'ramot', date: '2026-09-01' }, DEBT, PAY);
  assert.equal(a.openTotal, 2000, 'the server figure itself is not rewritten');
  assert.equal(a.unverifiedTotal, 1700); assert.deepEqual(a.unverified.map((u) => u.id), ['rcpt-a', 'rcpt-c', 'rcpt-d']);
  assert.ok(SRC.includes('id="crm-debt-unverified"') && SRC.includes('id="crm-account-unverified"'));
  assert.ok(SRC.includes("toast('אומת ✓ — התשלום אושר והחוב נסגר');"));
  assert.ok(SRC.includes("'התשלום נשמר ✓ — החוב ייסגר לאחר אימות'"));
  const fn = SRC.slice(SRC.indexOf('function unverifiedReceipts('), SRC.indexOf('function unverifiedTotal('));
  assert.ok(!/fetch|api\(/.test(fn), 'pure: computed from the answers already read');
});
