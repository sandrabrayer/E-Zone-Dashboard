'use strict';
/* Stage 3: collectionDebtors never turns a missing/malformed required source into a 0 total. Actual helper, synthetic data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/crm/crm.js');
const T = '2026-11-15';
const debt = (cycles) => ({ ok: true, asOf: T, byPatient: cycles ? [{ patientId: 'p1', patientKey: 'k1', name: 'א', cycles: [{ start: '2026-10-01', end: '2026-10-31', expected: 1000, received: 0, balance: 1000, days: 10 }] }] : [] });
const pay = () => ({ ok: true, receipts: [], payments: [] });

test('missing / failed / malformed sources are unknown (null), not zero', () => {
  for (const [d, p] of [[debt(0), null], [debt(0), undefined], [debt(0), { ok: false, error: 'x' }], [debt(0), { ok: true }], [debt(0), { ok: true, receipts: 'no' }],
    [null, pay()], [{ ok: false }, pay()], [{ ok: true }, pay()]]) {
    const r = core.collectionDebtors(d, p, T, '', null, []);
    assert.equal(r.ok, false); assert.equal(r.total, null);
  }
});
test('healthy empty arrays are a valid zero; real debt keeps its sum', () => {
  const z = core.collectionDebtors(debt(0), pay(), T, '', null, []);
  assert.equal(z.ok, true); assert.equal(z.total, 0); assert.equal(z.count, 0);
  const r = core.collectionDebtors(debt(1), pay(), T, '', null, []);
  assert.equal(r.ok, true); assert.equal(r.total, 1000);
});
