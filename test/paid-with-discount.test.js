'use strict';

/* «שולם עם הנחה» in the CRM payment report form (CHANGELOG-paid-with-discount.md).
 *
 * A. The pure plan: the gap between the open cycle's balance and the money
 *    received becomes a discount; the month's TOTAL is written (existing +
 *    gap) because setBillingDiscount replaces the month's value.
 * B. The bodies: the report never carries the discount fields; the discount
 *    body is the classic setBillingDiscount contract.
 * C. Source guards on the form wiring: offered only on an open cycle to a
 *    user who may discount; the discount is written only AFTER the payment
 *    is accepted; a failed discount never hides the saved payment.
 * D. The real Code.gs cycle rule: payment + discount = a settled cycle. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const PAT = { id: 'p1', houseId: 'pardes', name: 'דניאל בן גוזי', date: '2026-07-17', pay: 41300 };

/* ================= A. the plan ================= */

test('A: paid 35,000 of an open 41,300 → a 6,300 discount for the cycle month', () => {
  const plan = core.paidWithDiscountPlan('35000', 41300, { month: '2026-07', discount: 0 }, 'סוכם עם המשפחה');
  assert.deepEqual(plan, { ok: true, amount: 35000, gap: 6300, month: '2026-07', discountTotal: 6300 });
});

test('A: an existing discount on the month is kept — the total written is existing + the new gap', () => {
  // the open balance is already net of the 500 (cycleState): 41,300 − 500 = 40,800
  const plan = core.paidWithDiscountPlan('40000', 40800, { month: '2026-08', discount: 500 }, 'הנחה נוספת');
  assert.equal(plan.ok, true);
  assert.equal(plan.gap, 800);
  assert.equal(plan.discountTotal, 1300);
});

test('A: agorot are exact and commas/₪ are accepted', () => {
  const plan = core.paidWithDiscountPlan('₪ 1,234.56', 2000, { month: '2026-09', discount: 0.44 }, 'עיגול');
  assert.equal(plan.ok, true);
  assert.equal(plan.gap, 765.44);
  assert.equal(plan.discountTotal, 765.88);
});

test('A: refused before anything is written — no gap, no amount, a bad amount, no reason, no month', () => {
  const ctx = { month: '2026-07', discount: 0 };
  assert.match(core.paidWithDiscountPlan('41300', 41300, ctx, 'סיבה').errors.amount, /אין יתרה להנחה/);
  assert.match(core.paidWithDiscountPlan('50000', 41300, ctx, 'סיבה').errors.amount, /אין יתרה להנחה/);
  assert.ok(core.paidWithDiscountPlan('0', 41300, ctx, 'סיבה').errors.amount);
  assert.ok(core.paidWithDiscountPlan('', 41300, ctx, 'סיבה').errors.amount);
  assert.ok(core.paidWithDiscountPlan('-5', 41300, ctx, 'סיבה').errors.amount);
  assert.ok(core.paidWithDiscountPlan('12.345', 41300, ctx, 'סיבה').errors.amount);
  assert.ok(core.paidWithDiscountPlan('35000', 41300, ctx, ' א ').errors.discountReason, 'reason 2–120');
  assert.ok(core.paidWithDiscountPlan('35000', 41300, ctx, 'x'.repeat(121)).errors.discountReason);
  assert.ok(core.paidWithDiscountPlan('35000', 41300, { month: '2026-13' }, 'סיבה').errors._form);
  assert.ok(core.paidWithDiscountPlan('35000', 41300, null, 'סיבה').errors._form);
});

/* ================= B. the bodies ================= */

test('B: the discount body is the classic setBillingDiscount contract with the month TOTAL', () => {
  const plan = core.paidWithDiscountPlan('35000', 41300, { month: '2026-07', discount: 0 }, ' סוכם עם המשפחה ');
  assert.deepEqual(core.paidWithDiscountBody(PAT, plan, ' סוכם עם המשפחה '), {
    action: 'setBillingDiscount',
    discount: { patientId: 'pardes::דניאל בן גוזי::2026-07-17', month: '2026-07', discountAmount: 6300, discountReason: 'סוכם עם המשפחה' },
  });
});

test('B: the report values never carry the discount fields', () => {
  const vals = { amount: '35000', method: 'ביט', withDiscount: 'yes', discountReason: 'סוכם' };
  assert.deepEqual(core.reportValuesOnly(vals), { amount: '35000', method: 'ביט' });
  const body = core.reportBody({ id: 'c1' }, core.reportValuesOnly(vals), 'sub-1');
  assert.equal(body.action, 'reportPayment');
  assert.equal('withDiscount' in body.report.report, false);
  assert.equal('discountReason' in body.report.report, false);
});

/* ================= C. wiring guards ================= */

test('C: the option is offered only to a user who may discount, on an open cycle with a month and a balance', () => {
  assert.match(SRC, /const canPwd = !!\(state\.me && state\.me\.canDiscount && discountCtx && monthOk\(discountCtx\.month\) && Number\(remaining\) > 0\)/);
  assert.match(SRC, /\(canPwd \? '<label class="wide check"><input type="checkbox" name="withDiscount"/);
  // the two open-cycle callers pass the cycle month + its existing discount
  assert.match(SRC, /openReportForm\(reportCycleFor\(state\.account\.patient, c, state\.account\.data\), c\.balance, \{ month: c\.month, discount: c\.discount \}\)/);
  assert.match(SRC, /openReportForm\(r\.cycle, r\.balance, \{ month: s\(r\.cycle && r\.cycle\.dueDate\)\.slice\(0, 7\), discount: r\.discount \}\)/);
  // a stamped row / «מחזור אחר» (balance not net of a discount) never offers it
  assert.match(SRC, /openReportForm\(reportCycleForRow\(state\.account\.patient, row\), Math\.max\(0, row\.amount - row\.amountPaid\)\);/);
  assert.match(SRC, /openReportForm\(reportCycleForWindow\(state\.account\.patient, w, state\.account\.data\), Math\.max\(0, \(Number\(w\.expected\) \|\| 0\) - \(Number\(w\.received\) \|\| 0\)\)\);/);
});

test('C: the plan is checked before any write; the discount is sent only after the payment is accepted', () => {
  const sub = SRC.slice(SRC.indexOf('function submitReport('), SRC.indexOf('function openSmallForm('));
  const planAt = sub.indexOf('paidWithDiscountPlan(');
  const firstFetch = sub.indexOf("win.fetch('/api/sheets'");
  assert.ok(planAt > 0 && firstFetch > planAt, 'plan before the first fetch');
  const okAt = sub.indexOf('if (out.ok) {');
  const discountFetch = sub.indexOf('paidWithDiscountBody(pat, plan, discountReason)');
  assert.ok(okAt > 0 && discountFetch > okAt, 'discount only inside the accepted-payment branch');
  assert.match(sub, /reportValuesOnly\(all\)/, 'report body built from the report fields only');
  assert.match(sub, /התשלום נשמר\. ההנחה לא נשמרה/, 'a failed discount says the payment is saved and what to do');
  assert.match(sub, /el\.type !== 'checkbox'/, 'a checkbox value never leaks into the report');
});

test('C: the server stays the authority — finance only for the discount (DISCOUNT_ACTIONS)', () => {
  const scope = require('../lib/role-scope.js');
  assert.ok(Array.isArray(scope.DISCOUNT_ACTIONS) && scope.DISCOUNT_ACTIONS.indexOf('setBillingDiscount') >= 0);
});

/* ================= D. the cycle rule ================= */

test('D: payment then discount → the cycle reads settled (balance 0); the discount is not counted as paid', () => {
  // after reportPayment: a partial row
  const afterPay = CB.cycleState({ stampedAmount: 41300, amountPaid: 35000, overrideAmount: null, agreedPrice: 41300, status: 'partial', discountAmount: null });
  assert.equal(afterPay.balance, 6300);
  // after setBillingDiscount with the plan's total
  // the form was opened on the open cycle: balance 41,300, nothing paid yet
  const plan = core.paidWithDiscountPlan('35000', 41300, { month: '2026-07', discount: 0 }, 'סוכם');
  const afterDisc = CB.cycleState({ stampedAmount: 41300, amountPaid: 35000, overrideAmount: null, agreedPrice: 41300, status: 'partial', discountAmount: plan.discountTotal });
  assert.equal(afterDisc.balance, 0);
  assert.equal(afterDisc.paid, 35000, 'only the money received is paid');
});
