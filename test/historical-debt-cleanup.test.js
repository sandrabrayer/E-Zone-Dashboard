'use strict';

/* «ניקוי חובות היסטוריים» — released patients' open cycles closed in bulk
 * (CHANGELOG-historical-debt-cleanup.md). Names are SYNTHETIC.
 *
 * A. Candidates: only released patients not in a house, only open cycles.
 * B. The plan: one setBillingDiscount per patient + month with the month's
 *    TOTAL (existing + every ticked balance), a reason with a fixed prefix.
 * C. Wiring: finance only, never Ortal's view; ticking never re-renders; the
 *    run is sequential and stops at the first refusal; a confirm first.
 * D. The real cycle rule: the discount closes a recorded partial cycle and
 *    an unrecorded one. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const KEY = 'ramot::טל לי::2026-06-01';
const DEBT = () => ({ ok: true, byPatient: [
  { patientId: 'px', patientKey: KEY, name: 'טל לי', houseId: 'ramot', status: 'released', inHouseAtAsOf: false, cycles: [
    { start: '2026-07-17', end: '2026-08-16', expected: 41300, received: 0, balance: 41300, days: 114, kind: 'unrecorded', month: '2026-07', discount: 0 },
    { start: '2026-08-17', end: '2026-09-13', expected: 41300, received: 10000, balance: 31300, days: 83, kind: 'recorded', paymentId: 'c2', month: '2026-08', discount: 0 },
    { start: '2026-09-14', end: '2026-09-20', expected: 0, received: 0, balance: 0, days: 55, kind: 'recorded', month: '2026-09' }] },
  { patientId: 'p1', patientKey: 'ramot::דנה::2026-01-01', name: 'דנה', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [
    { start: '2026-10-01', balance: 5000, month: '2026-10', days: 38 }] },
  { patientId: 'p2', patientKey: 'pardes::אבי::2026-05-03', name: 'אבי', houseId: 'pardes', status: 'released', inHouseAtAsOf: false, cycles: [
    { start: '2026-08-03', end: '2026-09-02', expected: 30000, received: 0, balance: 29500, days: 97, kind: 'unrecorded', month: '2026-08', discount: 500 }] },
] });

/* ================= A ================= */

test('A: only released patients out of the house, only open cycles, sorted by name then date', () => {
  const rows = core.cleanupCandidates(DEBT());
  assert.deepEqual(rows.map((r) => [r.name, r.start, r.balance]), [
    ['אבי', '2026-08-03', 29500], ['טל לי', '2026-07-17', 41300], ['טל לי', '2026-08-17', 31300]]);
  assert.equal(rows[1].patientKey, KEY);
  assert.equal(rows[1].houseName, 'רמות השבים');
});

test('A: a missing / failed debt answer → no candidates, no throw', () => {
  assert.deepEqual(core.cleanupCandidates(null), []);
  assert.deepEqual(core.cleanupCandidates({ ok: false, error: 'x' }), []);
  assert.deepEqual(core.cleanupCandidates({ ok: true, byPatient: [{ status: 'released', patientKey: '', cycles: [{ balance: 1, month: '2026-01' }] }] }), []);
});

/* ================= B ================= */

test('B: one write per patient + month; the month total keeps an existing discount', () => {
  const rows = core.cleanupCandidates(DEBT());
  const plan = core.cleanupPlan(rows, 'paid_unrecorded', 'בדיקה מול הבנק');
  assert.equal(plan.ok, true);
  assert.equal(plan.cycles, 3);
  assert.equal(plan.total, 102100);
  assert.deepEqual(plan.writes.map((w) => [w.patientKey, w.month, w.discountTotal]), [
    ['pardes::אבי::2026-05-03', '2026-08', 30000],      // 500 existing + 29,500
    [KEY, '2026-07', 41300],
    [KEY, '2026-08', 31300]]);
  assert.equal(plan.reasonText, 'ניקוי חוב היסטורי · שולם — לא נרשם באפליקציה · בדיקה מול הבנק');
});

test('B: two ticked cycles in the same month of one patient → ONE write with both balances', () => {
  const rows = [
    { patientKey: KEY, name: 'טל לי', month: '2026-07', balance: 1000, discount: 200 },
    { patientKey: KEY, name: 'טל לי', month: '2026-07', balance: 500, discount: 200 }];
  const plan = core.cleanupPlan(rows, 'not_charged', '');
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].discountTotal, 1700);
  assert.equal(plan.reasonText, 'ניקוי חוב היסטורי · לא חויב בפועל / טעות רישום');
});

test('B: refused before anything is sent — no reason, an unknown reason, a long note, nothing ticked', () => {
  const rows = core.cleanupCandidates(DEBT());
  assert.ok(core.cleanupPlan(rows, '', '').errors.reason);
  assert.ok(core.cleanupPlan(rows, 'write_off', '').errors.reason, 'no write-off through this tool');
  assert.ok(core.cleanupPlan(rows, 'paid_unrecorded', 'x'.repeat(61)).errors.note);
  assert.ok(core.cleanupPlan([], 'paid_unrecorded', '').errors._form);
  assert.deepEqual(core.CLEANUP_REASONS.map((r) => r.id), ['paid_unrecorded', 'not_charged']);
});

test('B: the body is the classic setBillingDiscount contract and fits the server limits', () => {
  const plan = core.cleanupPlan(core.cleanupCandidates(DEBT()), 'paid_unrecorded', 'א'.repeat(60));
  const body = core.cleanupBody(plan.writes[1], plan.reasonText);
  assert.deepEqual(body, { action: 'setBillingDiscount', discount: { patientId: KEY, month: '2026-07', discountAmount: 41300, discountReason: plan.reasonText } });
  assert.ok(plan.reasonText.length >= 2 && plan.reasonText.length <= 120, 'BILLING_DISCOUNT_REASON_MIN/MAX');
  assert.match(body.discount.patientId, /^[a-z]{2,20}::.+::\d{4}-\d{2}-\d{2}$/, 'billingDiscountRequestClean_ key shape');
});

/* ================= C ================= */

test('C: finance only and never in Ortal\'s (controller) view', () => {
  const fn = SRC.slice(SRC.indexOf('function renderCleanup('), SRC.indexOf('function cleanupSelected('));
  assert.match(fn, /if \(!me\.canDiscount\) return '';/);
  assert.match(SRC, /if \(!isController\) html \+= renderCleanup\(\);/);
  assert.doesNotMatch(fn, /\+ r\.(name|houseName) \+/, 'every value through esc()');
});

test('C: a confirm first; one write at a time; the first refusal stops the run and says how many closed', () => {
  const fn = SRC.slice(SRC.indexOf('function submitCleanup('), SRC.indexOf('function renderBilling('));
  const confirmAt = fn.indexOf('win.confirm(');
  const fetchAt = fn.indexOf("win.fetch('/api/sheets'");
  assert.ok(confirmAt > 0 && fetchAt > confirmAt);
  assert.match(fn, /if \(why\) return plan\.writes\[i\]\.name/, 'stops at the first refusal');
  assert.match(fn, /done\+\+; return step\(i \+ 1\);/, 'sequential');
  assert.match(fn, /נסגרו ' \+ done \+ ' מתוך '/);
  assert.match(fn, /resetBilling\(\); renderMain\(\);/, 'the server answer is re-read');
});

test('C: ticking updates the summary without re-rendering (the typed reason survives)', () => {
  const h = SRC.slice(SRC.indexOf('«ניקוי חובות היסטוריים»: ticking never re-renders'), SRC.indexOf('// a field inside a form (report, restore, …)'));
  assert.match(h, /cleanupSumText\(\)/);
  assert.doesNotMatch(h, /renderMain\(\)/);
});

/* ================= D ================= */

test('D: the month total closes a part-paid recorded cycle and an unrecorded one', () => {
  const plan = core.cleanupPlan(core.cleanupCandidates(DEBT()), 'paid_unrecorded', '');
  const aug = plan.writes.find((w) => w.patientKey === KEY && w.month === '2026-08');
  const rec = CB.cycleState({ stampedAmount: 41300, amountPaid: 10000, overrideAmount: null, agreedPrice: 41300, status: 'partial', discountAmount: aug.discountTotal });
  assert.equal(rec.balance, 0);
  assert.equal(rec.paid, 10000, 'money already received stays received');
  const jul = plan.writes.find((w) => w.patientKey === KEY && w.month === '2026-07');
  const unrec = CB.cycleState({ stampedAmount: 41300, amountPaid: 0, overrideAmount: null, agreedPrice: 41300, status: 'unpaid', discountAmount: jul.discountTotal });
  assert.equal(unrec.balance, 0);
});
