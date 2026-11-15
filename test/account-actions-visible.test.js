'use strict';
/* CHANGELOG-account-actions-visible.md — the open cycle's actions are pinned in view;
 * a paid-on-another-date debt is explained. Display only. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');

test('the action cell of «מחזורים פתוחים» is sticky, with stacked buttons', () => {
  assert.match(SRC, /'<td class="acts">' \+ \(me\.finance \? '<button type="button" class="btn small primary" data-report-open="/);
  assert.match(CSS, /#crm-account-open td\.acts, #crm-account-open th:last-child \{ position: sticky; inset-inline-end: 0;/);
  assert.match(CSS, /#crm-account-open td\.acts \.btn \{ display: block;/);
});

test('an unrecorded open cycle next to a paid payment is explained — finance only, never a new write', () => {
  const i = SRC.indexOf('id="crm-account-mismatch"');
  assert.ok(i > 0);
  const block = SRC.slice(SRC.lastIndexOf('if (me.finance &&', i), SRC.indexOf('const others = state.account', i));
  assert.match(block, /c\.kind === 'unrecorded'/); assert.match(block, /c\.status === 'paid'/);
  assert.match(block, /אל תדווחי שוב/); assert.match(block, /ניקוי חובות היסטוריים/);
  assert.match(block, /me\.canDiscount && state\.account && state\.account\.patient && !inHouse\(state\.account\.patient\)/, 'the cleanup tool is named only where it applies: a released patient, a user who may discount');
  assert.ok(!/fetch|api\(|action:/.test(block), 'text only');
});
