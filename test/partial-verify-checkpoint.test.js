'use strict';
/* CHANGELOG-partial-verify-checkpoint.md — «אימות חלקי» pure rules. Synthetic ids/amounts only. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const ORTAL = { canConfirm: true }, VERED = { canConfirm: false, finance: true };
const rc = (o) => Object.assign({ id: 'rcpt-t1', amount: 2000, confirmStatus: 'reported', confirmedAmount: 0 }, o);

test('partialVerifyCheck: total verified, 0 < n < reported, ≤2 decimals', () => {
  assert.deepEqual(core.partialVerifyCheck('1000', 2000), { amount: 1000, remaining: 1000, error: '' });
  assert.equal(core.partialVerifyCheck('1,000.50', 2000).amount, 1000.5);
  for (const bad of ['', '0', '2000', '2500', '-5', '1.234', 'abc', '1e3']) {
    const c = core.partialVerifyCheck(bad, 2000);
    assert.equal(c.amount, null, bad); assert.ok(c.error, bad);
  }
});

test('partialVerifyBody: the exact existing wire contract; bad input → null', () => {
  assert.deepEqual(core.partialVerifyBody('rcpt-t1', 1000), { action: 'confirmPayment', confirm: { ids: ['rcpt-t1'], status: 'partial', confirmedAmount: 1000 } });
  assert.equal(core.partialVerifyBody('x-1', 1000), null);
  assert.equal(core.partialVerifyBody('rcpt-t1', 0), null);
  assert.equal(core.partialVerifyBody('rcpt-t1', 10.123), null);
});

test('role: only a session that may confirm can partially verify (same guard as «אמת»)', () => {
  assert.equal(core.canVerifyReceipt(ORTAL, rc()), true);
  assert.equal(core.canVerifyReceipt(VERED, rc()), false);
  assert.equal(core.canVerifyReceipt(ORTAL, rc({ confirmStatus: 'confirmed' })), false);
  assert.ok(/data-verify-partial[\s\S]{0,40}/.test(SRC) && SRC.indexOf('canVerifyReceipt(state.me, r) ?') > 0, 'partial button sits inside the canVerifyReceipt branch');
});

test('partialAccepted: exact id + partial + exact confirmedAmount + ok===true', () => {
  const ok = { ok: true, changed: [{ id: 'rcpt-t1', confirmStatus: 'partial', confirmedAmount: 1000 }] };
  assert.equal(core.partialAccepted(ok, 'rcpt-t1', 1000), true);
  assert.equal(core.partialAccepted({ ok: true, unchangedRows: ok.changed }, 'rcpt-t1', 1000), true, 'repeat ack');
  assert.equal(core.partialAccepted(ok, 'rcpt-t1', 900), false, 'wrong amount');
  assert.equal(core.partialAccepted(ok, 'rcpt-t2', 1000), false, 'wrong receipt');
  assert.equal(core.partialAccepted({ ok: true, changed: [{ id: 'rcpt-t1', confirmStatus: 'partial' }] }, 'rcpt-t1', 1000), false, 'missing amount');
  assert.equal(core.partialAccepted({ ok: true, changed: [{ id: 'rcpt-t1', confirmStatus: 'confirmed', confirmedAmount: 1000 }] }, 'rcpt-t1', 1000), false, 'wrong status');
  assert.equal(core.partialAccepted({ ok: false, changed: ok.changed }, 'rcpt-t1', 1000), false);
  assert.equal(core.partialAccepted(null, 'rcpt-t1', 1000), false);
});

test('partial 1000 of 2000 then confirmed 2000: cumulative, consistent, repeat adds nothing, no new receipt', () => {
  let l = [rc(), rc({ id: 'rcpt-t2' })];
  l = core.applyPartial(l, 'rcpt-t1', 1000, 'אורטל', '2026-11-15');
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].confirmStatus, l[0].confirmedAmount], ['partial', 1000]);
  assert.equal(l[1].confirmStatus, 'reported', 'other receipt untouched');
  const again = core.applyPartial(l, 'rcpt-t1', 1000, 'אורטל', '2026-11-15');
  assert.equal(again[0].confirmedAmount, 1000, 'same ack never adds');
  const full = core.applyVerified(again, 'rcpt-t1', 'אורטל', '2026-11-15');
  assert.deepEqual([full[0].confirmStatus, full[0].confirmedAmount], ['confirmed', 2000]);
  assert.equal(core.applyPartial(l, 'rcpt-t1', 1000)[0] !== l[0], true, 'pure');
});

test('arithmetic: charge 5000 / discount 1000 / reported 4000 awaits 4000, zero once verified; partial leaves only the rest', () => {
  const pay = (r) => ({ receipts: [r] });
  const wait = (r) => core.unverifiedTotal(pay(r)).total;
  assert.equal(wait(rc({ amount: 4000 })), 4000);
  assert.equal(wait(rc({ amount: 4000, confirmStatus: 'confirmed', confirmedAmount: 4000 })), 0);
  assert.equal(wait(rc({ amount: 2000, confirmStatus: 'partial', confirmedAmount: 1000 })), 1000);
});

test('mismatch hint is neutral; toast for full verification does not claim the whole debt closed', () => {
  const i = SRC.indexOf('id="crm-account-mismatch"');
  const block = SRC.slice(i, SRC.indexOf('</p>', i));
  assert.match(block, /רמז, לא הוכחה/); assert.match(block, /אל תדווחי שוב/); assert.match(block, /אל תסגרי כהנחה/);
  assert.ok(!/והחוב נסגר/.test(SRC));
});

test('applyVerified after a partial: derived queue fields follow the full receipt (replace, never add) — BillingControlRules', () => {
  const rules = require('../lib/billing-control-rules.js');
  const q = { id: 'rcpt-q1', amount: 2000, confirmStatus: 'reported', verifiedAmount: 0, openAmount: 0 };
  const p = core.applyPartial([q], 'rcpt-q1', 1000, 'ortal', 't')[0];
  assert.equal(rules.verifiedAmountOf(p), 1000); assert.equal(rules.openAmountOf(p), 1000);
  const f = core.applyVerified([p], 'rcpt-q1', 'ortal', 't')[0];
  assert.equal(f.confirmStatus, 'confirmed'); assert.equal(f.confirmedAmount, 2000);
  assert.equal(f.verifiedAmount, 2000); assert.equal(f.openAmount, 0);
  assert.equal(rules.verifiedAmountOf(f), 2000); assert.equal(rules.openAmountOf(f), 0);
  // shape without derived fields is preserved
  const g = core.applyVerified([rc({ confirmStatus: 'partial', confirmedAmount: 1000 })], 'rcpt-t1', 'o', 't')[0];
  assert.ok(!('verifiedAmount' in g) && !('openAmount' in g));
});

test('partialVerifyBody / partialAccepted refuse Infinity, NaN and rounded-malformed amounts', () => {
  for (const bad of [Infinity, NaN, 10.005, 1000.123]) assert.equal(core.partialVerifyBody('rcpt-t1', bad), null, String(bad));
  const ok = (a) => ({ ok: true, changed: [{ id: 'rcpt-t1', confirmStatus: 'partial', confirmedAmount: a }] });
  assert.equal(core.partialAccepted(ok(1000), 'rcpt-t1', 1000), true);
  assert.equal(core.partialAccepted(ok(1000.004), 'rcpt-t1', 1000), false);
  assert.equal(core.partialAccepted(ok(Infinity), 'rcpt-t1', Infinity), false);
  assert.equal(core.partialAccepted(ok(1000), 'rcpt-t1', 1000.004), false);
});
