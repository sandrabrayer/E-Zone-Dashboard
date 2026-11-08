'use strict';

/* Manual credits + credit edit in the CRM (CHANGELOG-crm-manual-credits.md). Pure core of
 * public/crm/crm.js. Code.gs upsertCredit_ / Express role gates stay the authority; this
 * pins the payload the CRM sends and its own refusals. Synthetic names. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const RAW = { id: 'cr-1', patientId: 'p1', patientKey: 'ramot::דנה כהן::2026-09-01', patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused',
  allocationMonth: '2026-10', calculatedAmount: 1200, amount: 1200, overrideReason: '', reason: 'מדיניות', status: 'pending', notes: '', updatedAt: '2026-10-20T10:00:00.000Z' };
const CREDITS = { ok: true, credits: [RAW, { id: 'cr-2', status: 'paid' }] };

test('creditRaw finds the getCredits row', () => {
  assert.equal(core.creditRaw(CREDITS, 'cr-1').amount, 1200);
  assert.equal(core.creditRaw(CREDITS, 'nope'), null);
  assert.equal(core.creditRaw({ ok: false }, 'cr-1'), null);
});

test('edit: the policy amount needs no reason; a different amount needs one; cancel needs a note; a paid credit is locked', () => {
  const v = { amount: '1200', overrideReason: '', decidedDate: '2026-10-20', status: 'pending', notes: '' };
  assert.deepEqual(core.creditEditErrors(RAW, v), {});
  assert.deepEqual(Object.keys(core.creditEditErrors(RAW, Object.assign({}, v, { amount: '900' }))), ['overrideReason']);
  assert.deepEqual(core.creditEditErrors(RAW, Object.assign({}, v, { amount: '900', overrideReason: 'הסכם' })), {});
  assert.deepEqual(Object.keys(core.creditEditErrors(RAW, Object.assign({}, v, { amount: 'abc' }))), ['amount']);
  assert.deepEqual(Object.keys(core.creditEditErrors(RAW, Object.assign({}, v, { status: 'paid' }))), ['status'], 'paid only via settleRefund');
  assert.deepEqual(Object.keys(core.creditEditErrors(RAW, Object.assign({}, v, { status: 'cancelled' }))), ['notes']);
  assert.deepEqual(Object.keys(core.creditEditErrors(RAW, Object.assign({}, v, { decidedDate: '2019-01-01' }))), ['decidedDate']);
  assert.ok(core.creditEditErrors(Object.assign({}, RAW, { status: 'paid' }), v)._form);
});

test('edit body: the saved row + the editable fields + the stale-save stamp; overrideReason only when the amount differs', () => {
  const b = core.creditEditBody(RAW, { amount: '900', overrideReason: 'הסכם', decidedDate: '2026-10-21', status: 'pending', notes: 'x' });
  assert.equal(b.action, 'saveCredit');
  assert.deepEqual([b.credit.id, b.credit.updatedAt, b.credit.amount, b.credit.overrideReason, b.credit.calculatedAmount, b.credit.decidedDate, b.credit.status, b.credit.notes],
    ['cr-1', '2026-10-20T10:00:00.000Z', 900, 'הסכם', 1200, '2026-10-21', 'pending', 'x']);
  assert.equal(core.creditEditBody(RAW, { amount: '1200', overrideReason: 'leftover', status: 'pending' }).credit.overrideReason, '');
});

test('manual credit: «אחר», month + amount > 0 + reason; the patient identity keys; amount and reason are the server\'s to approve', () => {
  assert.deepEqual(Object.keys(core.creditNewErrors({ allocationMonth: '2026-13', amount: '0', reason: '' })), ['allocationMonth', 'amount', 'reason']);
  assert.deepEqual(core.creditNewErrors({ allocationMonth: '2026-11', amount: '500', reason: 'מחווה' }), {});
  const b = core.creditNewBody({ id: 'p1', name: 'דנה כהן', houseId: 'ramot', date: '2026-09-01' }, { allocationMonth: '2026-11', amount: '500', reason: 'מחווה', notes: '' }, '2026-11-05');
  assert.deepEqual([b.credit.id, b.credit.creditType, b.credit.patientId, b.credit.patientKey, b.credit.amount, b.credit.calculatedAmount, b.credit.reason, b.credit.overrideReason, b.credit.status, b.credit.decidedDate],
    ['', 'other', 'p1', 'ramot::דנה כהן::2026-09-01', 500, 0, 'מחווה', 'מחווה', 'pending', '2026-11-05']);
});

test('creditSaveRefusal: the server answer must echo the credit; refusals in Hebrew', () => {
  assert.equal(core.creditSaveRefusal({ ok: true, credit: { id: 'cr-1' } }, 'cr-1'), '');
  assert.equal(core.creditSaveRefusal({ ok: true, credit: { id: 'new' } }, ''), '');
  assert.match(core.creditSaveRefusal({ ok: true }, ''), /לא אושר/);
  assert.match(core.creditSaveRefusal({ ok: true, credit: { id: 'other' } }, 'cr-1'), /לא אושר/);
  assert.match(core.creditSaveRefusal({ ok: false, error: 'conflict' }, 'cr-1'), /עודכן בינתיים/);
  assert.match(core.creditSaveRefusal({ ok: false, error: 'override_requires_approver' }, 'cr-1'), /סנדרה/);
  assert.match(core.creditSaveRefusal({ ok: false, error: 'use_settleRefund' }, 'cr-1'), /אורטל/);
});

test('UI: «+ זיכוי ידני» only for the approver, «עריכה» for finance on unpaid credits; no more classic link for credits', () => {
  assert.match(SRC, /me\.approver \? ' <button type="button" class="btn small" data-credit-new>\+ זיכוי ידני<\/button>'/);
  assert.match(SRC, /me\.finance && c\.status !== 'paid' \? ' <button type="button" class="btn small" data-credit-edit="/);
  assert.doesNotMatch(SRC, /זיכויים ידניים<small>/);
  assert.doesNotMatch(SRC, /עריכת קבלות, שיוך תשלומים וזיכויים ידניים בדשבורד/);
});
