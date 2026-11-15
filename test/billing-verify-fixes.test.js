'use strict';

/* CHANGELOG-billing-verify-fixes.md — the pure rules behind five fixes in «גבייה»:
 *   1. verification in the CRM: only a confirmed receipt is green; «אמת» posts confirmPayment
 *   2. «סוג התשלום»: full / partial (the rest stays a debt) / discount (no debt stays)
 *   3. the «סקירה» search answers a typed name
 *   4. Ortal reads the patient's «חשבון» like Vered (no new write)
 *   5. speed: a save keeps the screen and re-reads only what it changed
 * Synthetic names only. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const scope = require('../lib/finance-scope');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');

const ORTAL = { user: 'אורטל', view: 'controller', canConfirm: true, billingRead: true, finance: false };
const VERED = { user: 'ורד', view: 'full', canConfirm: false, finance: true, canDiscount: true };

test('1. only a CONFIRMED receipt is green; reported / partial are amber, flagged is red', () => {
  assert.deepEqual(core.receiptVerifyChip('confirmed'), { cls: 'ok', label: 'אומת', verified: true });
  assert.deepEqual(core.receiptVerifyChip('reported'), { cls: 'today', label: 'ממתין לאימות', verified: false });
  assert.deepEqual(core.receiptVerifyChip(''), { cls: 'today', label: 'ממתין לאימות', verified: false }, 'no status = still waiting');
  assert.deepEqual(core.receiptVerifyChip('partial'), { cls: 'today', label: 'אומת חלקית', verified: false });
  assert.deepEqual(core.receiptVerifyChip('flagged'), { cls: 'late', label: 'סומן לבירור', verified: false });
  for (const st of ['reported', 'partial', 'flagged', '', 'something_new']) assert.notEqual(core.receiptVerifyChip(st).cls, 'ok', st + ' is never green');
});

test('1. «אמת» is offered only to a session that may confirm, on a live unverified receipt', () => {
  const r = { id: 'rcpt-1', confirmStatus: 'reported' };
  assert.equal(core.canVerifyReceipt(ORTAL, r), true);
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'rcpt-1', confirmStatus: 'flagged' }), true);
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'rcpt-1', confirmStatus: 'partial' }), true);
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'rcpt-1', confirmStatus: 'confirmed' }), false, 'already verified');
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'rcpt-1', confirmStatus: 'reported', isVoid: true }), false, 'a void receipt');
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'rcpt-1', confirmStatus: 'reported', status: 'void' }), false);
  assert.equal(core.canVerifyReceipt(ORTAL, { id: 'pay::x', confirmStatus: 'reported' }), false, 'a legacy cycle row is not a receipt');
  assert.equal(core.canVerifyReceipt(VERED, r), false, 'Vered reports, she does not verify');
  assert.equal(core.canVerifyReceipt(null, r), false);
  assert.equal(core.canVerifyReceipt({ canConfirm: 'yes' }, r), false, 'fail-closed: only a literal true');
});

test('1. the write is the classic confirmPayment contract; a bad id posts nothing', () => {
  assert.deepEqual(core.verifyBody('rcpt-abc'), { action: 'confirmPayment', confirm: { ids: ['rcpt-abc'], status: 'confirmed' } });
  assert.equal(core.verifyBody('pay::x'), null);
  assert.equal(core.verifyBody(''), null);
  assert.equal(core.verifyBody('rcpt-' + 'x'.repeat(400)), null, 'over the server limit');
  assert.equal(core.verifyBody('rcpt-a\nb'), null, 'control characters');
});

test('1. proof: the answer must name THIS receipt as confirmed', () => {
  assert.equal(core.verifyAccepted({ ok: true, changed: [{ id: 'rcpt-1', confirmStatus: 'confirmed' }] }, 'rcpt-1'), true);
  assert.equal(core.verifyAccepted({ ok: true, changed: [], unchangedRows: [{ id: 'rcpt-1', confirmStatus: 'confirmed' }] }, 'rcpt-1'), true, 'a retry of a decision that landed');
  assert.equal(core.verifyAccepted({ ok: true, changed: [{ id: 'rcpt-2', confirmStatus: 'confirmed' }] }, 'rcpt-1'), false, 'another receipt');
  assert.equal(core.verifyAccepted({ ok: true, changed: [{ id: 'rcpt-1', confirmStatus: 'reported' }] }, 'rcpt-1'), false, 'not confirmed');
  assert.equal(core.verifyAccepted({ ok: true }, 'rcpt-1'), false, 'ok without the row is not proof');
  assert.equal(core.verifyAccepted({ ok: false, error: 'forbidden_role' }, 'rcpt-1'), false);
  assert.equal(core.verifyAccepted(null, 'rcpt-1'), false);
  assert.equal(core.verifyRefusal({ ok: false, error: 'forbidden_role' }), 'אין הרשאה לאמת תשלומים');
  assert.equal(core.verifyRefusal({ ok: false, error: 'receipt_void' }), 'הקבלה בוטלה — אין מה לאמת');
  assert.match(core.verifyRefusal({ ok: false, error: 'weird_code' }), /weird_code/);
  assert.match(core.verifyRefusal(null), /לא נשמר/);
});

test('1. a verified receipt is patched in the answers on screen — new objects, the others untouched', () => {
  const list = [{ id: 'rcpt-1', confirmStatus: 'flagged', flagNote: 'x', amount: 5 }, { id: 'rcpt-2', confirmStatus: 'reported' }];
  const out = core.applyVerified(list, 'rcpt-1', 'אורטל', '2026-11-15 10:00:00');
  assert.deepEqual(out[0], { id: 'rcpt-1', confirmStatus: 'confirmed', flagNote: '', amount: 5, confirmedAmount: 5, confirmedBy: 'אורטל', confirmedAt: '2026-11-15 10:00:00' });
  assert.equal(out[1], list[1]);
  assert.equal(list[0].confirmStatus, 'flagged', 'the input is not mutated');
  assert.equal(core.applyVerified(null, 'rcpt-1'), null);
});

test('1. what waits for verification: void receipts are out, and the count agrees', () => {
  const pay = { ok: true, receipts: [
    { id: 'rcpt-1', patientName: 'דנה כהן', houseId: 'ramot', receivedDate: '2026-08-01', amount: 100, confirmStatus: 'reported' },
    { id: 'rcpt-2', patientName: 'דנה כהן', houseId: 'ramot', receivedDate: '2026-11-01', amount: 200, confirmStatus: 'confirmed' },
    { id: 'rcpt-3', patientName: 'גל רון', houseId: 'ramot', receivedDate: '2026-11-02', amount: 300, confirmStatus: 'reported', status: 'void' }], funders: [] };
  const v = core.receiptsView(pay, core.billSlice({}), { from: '', to: '', status: 'toVerify' }, '2026-11-15');
  assert.deepEqual(v.rows.map((r) => r.id), ['rcpt-1'], 'an old waiting receipt is listed whatever its date; the void and the confirmed are not');
  assert.equal(core.billingOverview({ ok: true, byPatient: [] }, pay, '2026-11-15').toVerify, 1);
  assert.match(SRC, /if \(g\.rcAll === true \|\| g\.rcStatus === 'toVerify'\) \{ state\.rcAll = true;/, 'the «דיווחים לאימות» card opens ALL dates');
});

test('2. «סוג התשלום»: an amount under the balance must be partial or discount — chosen on purpose', () => {
  assert.deepEqual(core.PAY_KINDS.map((k) => k.id), ['full', 'partial', 'discount']);
  assert.deepEqual(core.payKindCheck('full', '5000', 5000), { ok: true, kind: 'full', left: 0 });
  const under = core.payKindCheck('full', '4000', 5000);
  assert.equal(under.ok, false); assert.match(under.error, /תשלום חלקי/); assert.match(under.error, /תשלום בהנחה/);
  assert.deepEqual(core.payKindCheck('partial', '4000', 5000), { ok: true, kind: 'partial', left: 1000 }, 'the rest stays a debt');
  const notPartial = core.payKindCheck('partial', '5000', 5000);
  assert.equal(notPartial.ok, false); assert.match(notPartial.error, /תשלום מלא/);
  assert.equal(core.payKindCheck('full', '6000', 5000).ok, true, 'an overpayment is the report rules\' business');
  assert.equal(core.payKindCheck('full', 'abc', 5000).ok, true, 'a bad amount is the report rules\' business');
  assert.equal(core.payKindCheck('full', '100', 0).ok, true, 'no known balance → nothing to compare');
  assert.equal(core.payKindCheck('nonsense', '4000', 5000).kind, 'full', 'an unknown kind is treated as full (and refused under the balance)');
  assert.deepEqual(core.payKindCheck('partial', '4999.5', 5000), { ok: true, kind: 'partial', left: 0.5 }, 'agorot, no float dust');
});

test('2. the preview says what will remain: a debt (partial) or nothing (discount)', () => {
  assert.equal(core.payKindPreview('full', '4000', 5000), '');
  assert.equal(core.payKindPreview('partial', '4000', 5000), 'יירשם: תשלום ₪4,000 · יתרת חוב ₪1,000 נשארת פתוחה');
  assert.equal(core.payKindPreview('discount', '4000', 5000), 'יירשם: תשלום ₪4,000 + הנחה ₪1,000 = ₪5,000 · המחזור ייסגר');
  assert.equal(core.payKindPreview('partial', '5000', 5000), 'הזיני סכום נמוך מהיתרה (₪5,000)');
  assert.equal(core.payKindPreview('discount', '', 5000), '');
});

test('2. the discount still needs the discount right; the report body never carries the kind', () => {
  assert.match(SRC, /PAY_KINDS\.filter\(function \(k\) \{ return k\.id !== 'discount' \|\| canPwd; \}\)/);
  assert.match(SRC, /el\.type !== 'checkbox' && el\.type !== 'radio'/, 'payKind stays out of the values sent to reportPayment');
  assert.ok(!scope.CONTROLLER_ACTIONS.includes('setBillingDiscount') && !scope.CONTROLLER_ACTIONS.includes('reportPayment'), 'no new power for the controller view');
});

test('3. the «סקירה» search: one name across debts, receipts of any date, refunds and patients with nothing owed', () => {
  const debt = { ok: true, asOf: '2026-11-15', byPatient: [
    { patientId: 'p1', name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [{ balance: 3500, days: 70 }, { balance: 5000, days: 3 }] },
    { patientId: 'p9', name: 'גל רון', houseId: 'asher', status: 'released', cycles: [{ balance: 100, days: 5 }] }] };
  const pay = { ok: true, funders: [], receipts: Array.from({ length: 25 }, (_, i) => ({ id: 'rcpt-' + i, patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', receivedDate: '2025-' + String(1 + (i % 12)).padStart(2, '0') + '-10', amount: 100, confirmStatus: 'reported' }))
    .concat([{ id: 'rcpt-x', patientName: 'גל רון', houseId: 'asher', receivedDate: '2026-11-01', amount: 7, confirmStatus: 'confirmed' }]) };
  const b = core.billingOverview(debt, pay, '2026-11-15');
  const refunds = { rows: [{ name: 'דנה כהן', houseId: 'ramot', amount: 1200 }, { name: 'גל רון', houseId: 'asher', amount: 500 }] };
  const patients = [{ id: 'p1', name: 'דנה כהן', houseId: 'ramot', status: 'active' }, { id: 'p5', name: 'דנה לוי', houseId: 'rehab', status: 'released', exitDate: '2026-10-01' }];
  const f = core.billingFind('  דנה ', b, pay, refunds, patients, '2026-11-15');
  assert.equal(f.q, 'דנה');
  assert.deepEqual(f.debtors.map((d) => d.id), ['p1']); assert.equal(f.debtTotal, 8500);
  assert.equal(f.receiptCount, 25, 'every date — not the last 30 days, not the newest 25 only');
  assert.equal(f.receipts.length, core.FIND_RECEIPTS_CAP); assert.equal(f.receiptTotal, 2500);
  assert.deepEqual(f.refunds.map((r) => r.amount), [1200]); assert.equal(f.refundTotal, 1200);
  assert.deepEqual(f.people.map((p) => p.id), ['p5'], 'a released patient with nothing owed is still found');
  assert.equal(f.total, 1 + 25 + 1 + 1);
  assert.equal(core.billingFind('זזז', b, pay, refunds, patients, '2026-11-15').total, 0);
  assert.equal(core.billingFind('   ', b, pay, refunds, patients, '2026-11-15'), null, 'an empty search shows nothing extra');
  assert.equal(core.billingFind('דנה', core.billingOverview(null, null, '2026-11-15'), null, null, null, '2026-11-15').total, 0, 'missing answers never throw');
});

test('3. the section search box searches while typing; every found value is escaped', () => {
  assert.match(SRC, /if \(ev\.target && ev\.target\.id === 'crm-bill-q'\) return billQSoon\(\);/);
  const block = SRC.slice(SRC.indexOf('function renderBillFind('), SRC.indexOf('/* «חריגים לבדיקה»'));
  for (const id of ['crm-bill-find', 'crm-find-debtors', 'crm-find-receipts', 'crm-find-refunds', 'crm-find-people', 'crm-find-none']) assert.ok(block.includes(id), id);
  assert.ok(!/'<td>' \+ (r|p)\.(name|houseName|patientName|method)\b/.test(block), 'no unescaped text cell');
  assert.ok(block.includes("esc(f.q)"));
});

test('4. Ortal reads «חשבון» like Vered; Dana does not; the writes stay gated one by one', () => {
  assert.equal(core.accountReadable(ORTAL), true);
  assert.equal(core.accountReadable(VERED), true);
  assert.equal(core.accountReadable({ view: 'ops', ops: true, finance: false }), false);
  assert.equal(core.accountReadable({ view: 'full', finance: false }), false, 'a restricted view without billing read');
  assert.equal(core.accountReadable(null), false);
  assert.match(SRC, /\(me\.finance \? '<button type="button" class="btn small primary" data-report-open="/, '«דווח תשלום» is finance-only');
  assert.match(SRC, /if \(me\.finance\) html \+= otherCyclePickerHtml\(/);
  assert.match(SRC, /\(r\.isVoid \|\| !me\.finance \? '' : '<button type="button" class="btn small" data-receipt-edit="/, 'receipt edit / void are finance-only');
  // the reads the pane needs are already on her allow-list — no new server power
  for (const a of ['getData', 'getPayments', 'getCredits', 'debtAging', 'confirmPayment']) assert.ok(scope.CONTROLLER_ACTIONS.includes(a), a);
  for (const a of ['reportPayment', 'savePayment', 'editReceipt', 'saveCredit', 'setBillingDiscount', 'saveAll']) assert.ok(!scope.CONTROLLER_ACTIONS.includes(a), a + ' stays refused');
});

test('5. speed: a save keeps the screen, re-reads only what it changed, and never shows a pre-write answer', () => {
  const fn = SRC.slice(SRC.indexOf('function resetBilling(keys)'), SRC.indexOf('/* C18: link / not-a-patient forms'));
  assert.match(fn, /state\.billingGen = \(state\.billingGen \|\| 0\) \+ 1;/, 'every write advances the generation');
  assert.match(fn, /if \(\(state\.billingGen \|\| 0\) !== gen\) \{/, 'an answer that began before a later write is asked again, not shown');
  assert.match(fn, /return prev \|\| \{ debt: fail\(e\)/, 'a failed refresh keeps what was on screen');
  assert.match(fn, /if \(!Array\.isArray\(keys\) \|\| !keys\.length \|\| !healthy\) \{\s+state\.billing = null;/, 'a retry (no keys) still re-reads everything from empty');
  assert.ok(SRC.includes("resetBilling(['debt', 'payments']); if (pid) fillAccountPane(pid); return true; };"), 'a payment report re-reads the debt and the payments — not the credits, not the refund forecast');
  assert.ok(SRC.includes("resetBilling(['debt', 'credits', 'refunds']);"), 'a refund step re-reads the credits side');
  assert.equal((SRC.match(/resetBilling\(\)/g) || []).length, 1, 'the only whole-area reset left is «נסי שוב»');
  const verify = SRC.slice(SRC.indexOf('function verifyReceipt(btn)'), SRC.indexOf('function renderReceipts()'));
  assert.ok(!/resetBilling|api\('/.test(verify), 'a verification re-reads nothing: the rows on screen are patched from the server\'s proof');
  assert.equal(core.RECEIPT_ROWS_CAP, 200);
  assert.match(SRC, /state\.rcShowAll === true \? v\.rows : v\.rows\.slice\(0, RECEIPT_ROWS_CAP\)/);
});

test('the verify button and the refresh note have their styles; green is reserved for .chip.ok', () => {
  for (const sel of ['.btn.verify', '.btn.verify[aria-busy="true"]::before', '.crm-refresh', 'fieldset.paykind']) assert.ok(CSS.includes(sel), sel);
  assert.ok(!/\.btn\.verify\s*\{[^}]*var\(--ok\)/.test(CSS), 'the «אמת» button is not green');
});
