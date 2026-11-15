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
  const doc = { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ dataset: {} }) };
  const ctx = { state, doc, $: () => null, billingWaiters: [], calls, renderNav() {}, renderMain() {}, String, Promise,
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

/* Stage 2B — stale quarantine, checked against the ACTUAL source text (vm for the helpers; markers for wiring). */
test('2B: requireFreshBilling blocks only while stale; warning carries markers and no write claim', () => {
  const a2 = SRC.indexOf('function billingReadWarning()'), b2 = SRC.indexOf('function retryBillingRead()');
  assert.ok(a2 > 0 && b2 > a2);
  const toasts = [];
  const ctx = { state: { billingStale: false }, toast: (t, bad) => toasts.push([t, bad]) };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(a2, b2) + ';this.warn=billingReadWarning;this.req=requireFreshBilling;', ctx);
  assert.equal(ctx.req(), true); assert.equal(toasts.length, 0);
  ctx.state.billingStale = true;
  assert.equal(ctx.req(), false); assert.equal(toasts.length, 1); assert.equal(toasts[0][1], true);
  const w = ctx.warn();
  assert.match(w, /data-billing-stale/); assert.match(w, /data-billing-read-retry/);
  assert.match(w, /אין לדווח תשלום נוסף/);
  assert.doesNotMatch(w, /נכשל|נשמר/);
});
test('2B: every finance write entry guards first; renderers quarantine; retry is read-only', () => {
  for (const fn of ['submitLink', 'submitCleanup', 'submitReport', 'submitSmall', 'submitCredit', 'submitRefundAction', 'submitReceiptForm', 'savePartial', 'verifyReceipt']) {
    const i = SRC.indexOf('function ' + fn + '(');
    assert.ok(i > 0, fn);
    assert.ok(SRC.slice(i, i + 200).includes('requireFreshBilling()'), fn + ' guard at entry');
  }
  const rb = SRC.indexOf('function renderBilling()'), ra = SRC.indexOf('function renderAccount(a)');
  assert.ok(SRC.slice(rb, rb + 400).includes('billingReadWarning()'));
  assert.ok(SRC.slice(ra, ra + 200).includes('billingReadWarning()'));
  const rr = SRC.indexOf('function retryBillingRead()');
  const body = SRC.slice(rr, SRC.indexOf('function loadBilling(', rr));
  assert.ok(body.includes('loadBilling('));
  assert.doesNotMatch(body, /fetch|reportPayment|confirmPayment|setBillingDiscount/);
});

/* Final pass — Today consumes state.debt / state.payments (initial reads), strict on the ACTUAL myDay. */
test('Today collection card: missing/failed/malformed receipts are unknown (not 0); healthy empty is a valid 0', () => {
  const C = require('../public/crm/crm.js');
  const me = { view: 'full', user: 'ורד', finance: true };
  const debtOk = { ok: true, byPatient: [] };
  const run = (debt, pay) => C.myDay(C.compute({ ok: true, leads: [], patients: {}, dischargedPatients: [], irrelevantLeads: [], removedLeads: [] }, '2026-11-15'), [], { ok: true, leads: {}, patients: {}, flags: {} }, debt, '2026-11-15', me, {}, pay);
  const val = (m) => m.cards.find((x) => x.id === 'collection');
  for (const bad of [null, { ok: false }, { ok: true }, { ok: true, payments: [] }]) {
    const m = run(debtOk, bad);
    assert.equal(val(m).value, null); assert.equal(m.sourceState.collection, bad === null ? 'partial' : 'partial');
  }
  const healthy = run(debtOk, { ok: true, receipts: [], payments: [] });
  assert.equal(val(healthy).value, 0); assert.equal(healthy.sourceState.collection, 'complete');
});
test('Today wiring: stale quarantines the model inputs; retry button exists and re-reads', () => {
  assert.match(SRC, /const st = state\.billingStale === true; return myDay\(c, state\.tasks, state\.index, st \? false : state\.debt/);
  assert.match(SRC, /sourceState\.collection === 'partial' \? ' <button[^']*data-billing-read-retry/);
});
