'use strict';

/* The debtors calculator in «רשימת חייבים לגבייה» (CHANGELOG-debtors-select-sum.md):
 * tick debtors → their count and sum. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const ROWS = [{ id: 'a', name: 'דנה', houseId: 'ramot', balance: 35000 }, { id: 'b', name: 'גל', houseId: 'asher', balance: 70000 }, { id: '', name: 'נוי', houseId: 'ramot', balance: 1000.5 }];

test('the sum = the ticked rows\' debt figures, exactly as the list shows them; nothing ticked → zero', () => {
  const p = core.debtorsPicked(ROWS, { a: true, b: true });
  assert.deepEqual([p.count, p.total, p.of, p.listTotal, p.all, p.pct], [2, 105000, 3, 106000.5, false, 99.1]);
  const none = core.debtorsPicked(ROWS, {});
  assert.deepEqual([none.count, none.total, none.all, none.pct], [0, 0, false, 0]);
  assert.deepEqual(core.debtorsPicked([], { a: true }), { count: 0, total: 0, of: 0, listTotal: 0, all: false, pct: 0 });
  assert.equal(core.debtorsPicked(null, null).count, 0);
});

test('all ticked → `all`; a row without an id is keyed by house + name; a tick for someone not in the list now is not counted', () => {
  const all = core.debtorsPicked(ROWS, { a: true, b: true, 'ramot|נוי': true });
  assert.deepEqual([all.count, all.total, all.all, all.pct], [3, 106000.5, true, 100]);
  assert.equal(core.debtorPickKey(ROWS[2]), 'ramot|נוי'); assert.equal(core.debtorPickKey(ROWS[0]), 'a');
  const hidden = core.debtorsPicked([ROWS[0]], { a: true, b: true });   // the funder filter hid «גל»
  assert.deepEqual([hidden.count, hidden.total, hidden.all], [1, 35000, true]);
  assert.equal(core.debtorsPicked(ROWS, { a: 'yes', b: 1 }).count, 0, 'only an explicit true is a tick');
});

test('the bar text: count, sum, share of the listed debt; empty → the hint', () => {
  assert.equal(core.debtorsPickedText(core.debtorsPicked(ROWS, { a: true })), 'נבחרו 1 מתוך 3 · סה"כ ₪35,000 (33% מהחוב ברשימה)');
  assert.match(core.debtorsPickedText(core.debtorsPicked(ROWS, {})), /^מחשבון: /);
});

test('wiring: a tick cell per row + a header box; ticking updates in place (no re-render, no request) and never opens the patient; «ניקוי בחירה»', () => {
  const block = SRC.slice(SRC.indexOf('function renderCollectionDebtors()'), SRC.indexOf('function renderCleanup()'));
  assert.ok(block.includes('data-debtor-all') && block.includes('data-debtor-row="\' + i + \'"') && block.includes('data-debtor-cell'));
  assert.ok(block.includes('id="crm-debtor-sum">\' + esc(debtorsPickedText(pk))'));
  assert.ok(block.includes("aria-label=\"' + esc('בחירת ' + r.name) + '\""), 'labelled, escaped');
  assert.ok(SRC.includes("if (ev.target.closest && ev.target.closest('[data-debtor-cell]')) return;"), 'the tick cell is not a row click');
  const change = SRC.slice(SRC.indexOf('// the debtors calculator: ticking never re-renders'), SRC.indexOf("// a field inside a form (report, restore, …) is the form's business"));
  assert.ok(change.includes('paintDebtorCalc();') && !/renderMain\(|api\(/.test(change));
  const paint = SRC.slice(SRC.indexOf('function paintDebtorCalc()'), SRC.indexOf("root.addEventListener('toggle'"));
  assert.ok(paint.includes('sum.textContent = debtorsPickedText(pk)') && paint.includes('state.debtorSel = {};') && !/api\(/.test(paint));
});
