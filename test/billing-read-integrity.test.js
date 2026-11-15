'use strict';
/* CHANGELOG-billing-read-integrity.md Stage 2A — loadBilling stale flag, run from the ACTUAL source in vm. Synthetic data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const a = SRC.indexOf('function billingSourcesValid(b)'), b = SRC.indexOf('/* C18: link / not-a-patient forms');
assert.ok(a > 0 && b > a, 'source markers');
const CODE = SRC.slice(a, b);

const okDebt = (n) => ({ ok: true, byPatient: n ? [{ id: 'p1' }] : [] });
const okPay = () => ({ ok: true, receipts: [], payments: [] });
function harness(apiImpl, state) {
  const calls = [];
  const ctx = { state, billingWaiters: [], calls, renderNav() {}, renderMain() {}, String, Promise,
    api: (name) => { calls.push(name); return apiImpl(name); } };
  vm.createContext(ctx);
  vm.runInContext(CODE + ';this.loadBilling=loadBilling;this.valid=billingSourcesValid;', ctx);
  return ctx;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('billingSourcesValid: strict; healthy empty arrays are valid', () => {
  const h = harness(() => Promise.resolve({}), {});
  assert.equal(h.valid({ debt: okDebt(0), payments: okPay() }), true);
  for (const bad of [null, {}, { debt: okDebt(1) }, { debt: { ok: true }, payments: okPay() }, { debt: okDebt(1), payments: { ok: true, receipts: [] } },
    { debt: okDebt(1), payments: { ok: false, receipts: [], payments: [] } }, { debt: { ok: 1, byPatient: [] }, payments: okPay() }]) assert.equal(h.valid(bad), false);
});

test('loadBilling: malformed refresh keeps previous bundle and marks stale; stale forces GETs; valid recovery clears', async () => {
  const prev = { debt: okDebt(1), payments: okPay(), credits: { ok: true }, refunds: { ok: true } };
  let mode = 'bad';
  const st = { billing: prev, billingWant: { debt: true, payments: true }, billingGen: 0 };
  const h = harness((n) => Promise.resolve(n === 'debtAging' ? (mode === 'bad' ? { ok: true } : okDebt(0)) : n === 'getPayments' ? okPay() : { ok: true }), st);
  h.loadBilling(); await settle();
  assert.equal(st.billingStale, true); assert.equal(st.billing, prev);
  h.calls.length = 0; mode = 'good';
  h.loadBilling(); await settle();       // no billingWant, but stale => must re-fetch
  assert.ok(h.calls.includes('debtAging') && h.calls.includes('getPayments'));
  assert.equal(st.billingStale, false); assert.notEqual(st.billing, prev);
});

test('loadBilling: optional credits failure is not a required failure; obsolete failure cannot mark stale', async () => {
  const st = { billing: null, billingGen: 0 };
  const h = harness((n) => n === 'getCredits' ? Promise.reject(new Error('x')) : Promise.resolve(n === 'debtAging' ? okDebt(0) : n === 'getPayments' ? okPay() : { ok: true }), st);
  h.loadBilling(); await settle();
  assert.equal(st.billingStale, false); assert.equal(st.billing.credits.ok, false);

  const st2 = { billing: { debt: okDebt(1), payments: okPay() }, billingWant: { debt: true, payments: true }, billingGen: 0, billingStale: false };
  let n = 0;
  const h2 = harness((name) => { if (name === 'debtAging' && n++ === 0) { st2.billingGen++; return Promise.reject(new Error('late')); }
    return Promise.resolve(name === 'debtAging' ? okDebt(0) : name === 'getPayments' ? okPay() : { ok: true }); }, st2);
  h2.loadBilling(); await settle();
  assert.equal(st2.billingStale, false, 'obsolete failure ignored; fresh read won');
});
