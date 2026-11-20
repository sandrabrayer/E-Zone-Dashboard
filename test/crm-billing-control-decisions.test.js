'use strict';
/* CHANGELOG-crm-billing-control-decisions.md — the controller's «בקרת גבייה» decisions
 * «לא שולם» / «כפילות» / «לא התקבל» move from the classic page into the CRM, on each
 * receipt, via the existing confirmPayment contract. Nothing is deleted: a void keeps
 * the row (marked «בוטלה»), and after a proven answer the CRM re-reads the balances.
 * Pure rules + source wiring here; the real page is a scenario in
 * test/crm-shell-browser.test.js. SYNTHETIC data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

test('the reason is required, 2–120 chars (same rule as the classic decision)', () => {
  assert.equal(core.decisionReasonError('a'), 'יש להזין סיבה (2–120 תווים)');
  assert.equal(core.decisionReasonError('  '), 'יש להזין סיבה (2–120 תווים)');
  assert.equal(core.decisionReasonError('x'.repeat(121)), 'יש להזין סיבה (2–120 תווים)');
  assert.equal(core.decisionReasonError('כפילות של 9/11'), '');
  assert.equal(core.decisionReasonError('ab'), '');
});

test('decisionBody uses the confirmPayment contract with a status + flagNote; it refuses bad input', () => {
  for (const st of ['flagged', 'duplicate', 'not_received'])
    assert.deepEqual(core.decisionBody('rcpt-9', st, ' כפול  ברור '), { action: 'confirmPayment', confirm: { ids: ['rcpt-9'], status: st, flagNote: 'כפול ברור' } });
  assert.equal(core.decisionBody('x-9', 'duplicate', 'סיבה'), null, 'not a receipt id');
  assert.equal(core.decisionBody('rcpt-9', 'confirmed', 'סיבה'), null, 'confirmed is not a reason-decision here');
  assert.equal(core.decisionBody('rcpt-9', 'duplicate', 'a'), null, 'reason too short → no body');
  assert.equal(core.decisionBody('rcpt-\u0001', 'duplicate', 'סיבה'), null, 'control chars rejected');
});

test('R3: the receipt must come back (changed / unchanged / voided) or the result is not accepted', () => {
  assert.equal(core.decisionAccepted({ ok: true, voided: [{ id: 'rcpt-1' }] }, 'rcpt-1'), true);
  assert.equal(core.decisionAccepted({ ok: true, changed: [{ id: 'rcpt-1' }] }, 'rcpt-1'), true);
  assert.equal(core.decisionAccepted({ ok: true, unchangedRows: [{ id: 'rcpt-1' }] }, 'rcpt-1'), true, 'a retry of a landed decision');
  assert.equal(core.decisionAccepted({ ok: true, changed: [{ id: 'rcpt-2' }] }, 'rcpt-1'), false);
  assert.equal(core.decisionAccepted({ ok: false, error: 'lock_busy' }, 'rcpt-1'), false);
  assert.equal(core.decisionVoided({ ok: true, voided: [{ id: 'rcpt-1' }] }, 'rcpt-1'), true);
  assert.equal(core.decisionVoided({ ok: true, changed: [{ id: 'rcpt-1' }] }, 'rcpt-1'), false);
});

test('nothing is dropped: a voided receipt is kept and marked «בוטלה», never removed; a flagged one keeps its reason', () => {
  const rows = [{ id: 'rcpt-1', confirmStatus: 'reported', amount: 9000 }, { id: 'rcpt-2', confirmStatus: 'reported', amount: 100 }];
  const dup = core.applyDecision(rows, 'rcpt-1', 'duplicate', true, 'כפולה  ל-9/11');
  assert.equal(dup.length, 2, 'the row count is unchanged — nothing removed');
  assert.deepEqual(dup[0], { id: 'rcpt-1', confirmStatus: 'duplicate', amount: 9000, isVoid: true, flagNote: 'כפולה ל-9/11' });
  assert.deepEqual(dup[1], rows[1], 'other rows untouched');
  const flag = core.applyDecision(rows, 'rcpt-1', 'flagged', false, 'חסר אסמכתא');
  assert.deepEqual(flag[0], { id: 'rcpt-1', confirmStatus: 'flagged', amount: 9000, flagNote: 'חסר אסמכתא' }, 'flagged: status + reason, not voided');
  assert.ok(!('isVoid' in flag[0]));
});

test('the UI: each receipt offers the three decisions for a confirmer; the classic controller link is gone; a void triggers a fresh read', () => {
  const cell = SRC.slice(SRC.indexOf('function verifyCell'), SRC.indexOf('function openPartialForm'));
  assert.match(cell, /data-decide="flagged"[\s\S]*>לא שולם</);
  assert.match(cell, /data-decide="duplicate"[\s\S]*>כפילות</);
  assert.match(cell, /data-decide="not_received"[\s\S]*>לא התקבל</);
  assert.match(cell, /canVerifyReceipt\(state\.me, r\)/, 'gated by the same confirm permission as «אמת»');
  // the save path: confirm, proven, re-read
  const save = SRC.slice(SRC.indexOf('function saveDecision'), SRC.indexOf('/* One click → spinner'));
  assert.match(save, /win\.confirm\(BC_DECISIONS\[status\]\.confirm\)/);
  assert.match(save, /if \(!decisionAccepted\(res, id\)\) return fail/);
  assert.match(save, /resetBilling\(\['debt', 'payments'\]\)/, 'a void / flag changes balances → re-read');
  assert.match(save, /applyDecision\(p\.receipts, id, status, voided, reason\)/);
  // the classic controller decisions link is removed; routing (?view=classic page) is not a CRM link here
  assert.ok(!SRC.includes('id="crm-controller-classic"'), 'the controller classic decisions link is gone');
  assert.ok(!/אימות חלקי \/ לא התקבל \/ כפילות — בדשבורד/.test(SRC));
  // dispatcher wiring
  assert.match(SRC, /t\.dataset\.decide\) return openDecisionForm\(t\)/);
  assert.match(SRC, /t\.dataset\.decSave !== undefined\) return saveDecision/);
});
