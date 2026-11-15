'use strict';
// Independent synthetic review of #391/#392. GAP tests characterize an existing
// defect: a passing GAP means reproduced, NOT repaired. No live data/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/crm/crm');
const emit = (id, data) => console.log('BILLING_AUDIT ' + JSON.stringify({ id, ...data }));
const TODAY = '2026-11-15';
const patient = { id: 'audit-p1', name: 'בדיקת גבייה', houseId: 'ramot', date: '2026-10-01', status: 'active' };
const key = 'ramot::בדיקת גבייה::2026-10-01';
function debt(balance) { return { ok: true, asOf: TODAY, byPatient: [{ patientId: patient.id, patientKey: key, name: patient.name, houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: balance ? [{ start: '2026-11-01', end: '2026-11-30', balance, expected: 5000, received: 5000 - balance, days: 14, kind: 'recorded' }] : [] }] }; }
function pay(amount, status = 'reported') { return { ok: true, payments: [], funders: [], receipts: [{ id: 'rcpt-audit', patientUid: patient.id, patientId: key, patientName: patient.name, houseId: 'ramot', amount, confirmStatus: status, dueDate: '2026-11-01', receivedDate: '2026-11-10' }] }; }
function view(d, p) { return core.collectionDebtors(d, p, TODAY, '', null, [patient]); }

test('BILLING AUDIT control: full, partial and discounted report/verification totals', () => {
  for (const [kind, sourceBalance, reported, before, after] of [
    ['full', 0, 5000, 5000, 0], ['partial', 3000, 2000, 5000, 3000], ['discount', 0, 4000, 4000, 0]
  ]) {
    const p = pay(reported), d = debt(sourceBalance);
    assert.equal(view(d, p).total, before, kind + ' before verification');
    const acc = core.patientAccount(patient, d, p);
    assert.equal(acc.openTotal + acc.unverifiedTotal, before);
    p.receipts = core.applyVerified(p.receipts, 'rcpt-audit', 'אורטל', '2026-11-15T10:00:00Z');
    assert.equal(view(d, p).total, after, kind + ' after verification');
    emit(kind, { before, after, sourceBalance, reported });
  }
});

test('BILLING AUDIT control: a refused or mismatched verification is not proof', () => {
  for (const r of [null, {}, { ok: true }, { ok: false }, { ok: true, changed: [{ id: 'other', confirmStatus: 'confirmed' }] }, { ok: true, changed: [{ id: 'rcpt-audit', confirmStatus: 'reported' }] }])
    assert.equal(core.verifyAccepted(r, 'rcpt-audit'), false);
  assert.equal(core.verifyAccepted({ ok: true, unchangedRows: [{ id: 'rcpt-audit', confirmStatus: 'confirmed' }] }, 'rcpt-audit'), true);
});

test('BILLING AUDIT control: void receipts and a partial verified amount', () => {
  const p = pay(5000, 'partial'); p.receipts[0].confirmedAmount = 2000;
  assert.equal(view(debt(0), p).total, 3000);
  p.receipts[0].status = 'void';
  assert.equal(core.unverifiedTotal(p).total, 0);
  assert.equal(core.canVerifyReceipt({ canConfirm: true }, p.receipts[0]), false);
});

test('BILLING AUDIT GAP: missing receipt source is reported as a successful zero debt', () => {
  const d = debt(0);
  assert.equal(view(d, pay(5000)).total, 5000);
  for (const p of [null, { ok: false, error: 'synthetic_receipts_unavailable' }, { ok: true }]) {
    const got = view(d, p);
    assert.equal(got.ok, true, 'characterization: unknown payment source is incorrectly accepted');
    assert.equal(got.total, 0);
  }
  emit('missing_receipt_source', { knownPending: 5000, unavailableSourceShows: 0, resultClaimsOk: true, fixed: false });
});

test('BILLING AUDIT observation: equal partial confirmation and unapplied excess', () => {
  const partial = pay(5000, 'partial'); partial.receipts[0].confirmedAmount = 5000;
  const inconsistentPartial = core.unverifiedTotal(partial).total;
  const excess = view(debt(0), pay(6000)).total;
  emit('edge_inputs', { inconsistentPartial, reportedOverpayment: 6000, knownCharge: 5000, displayedPendingDebt: excess, scope: 'model inputs only; server reachability not established' });
  assert.equal(inconsistentPartial, 5000); assert.equal(excess, 6000);
});
