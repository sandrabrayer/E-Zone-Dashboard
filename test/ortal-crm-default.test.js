'use strict';

/* Ortal lands on the CRM, on «גבייה» (CHANGELOG-ortal-crm-default.md).
 * Routing decides the PAGE only: her action allow-list is untouched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const flag = require('../lib/crm-shell-flag.js');
const scope = require('../lib/finance-scope.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const ON = { CRM_ENABLED: 'true', CRM_DEFAULT: 'true' };
const ORTAL = { auth: 'personal', id: 'ortal' };

test('routing: with CRM_DEFAULT the controller view gets the CRM on "/"; view=classic is still the classic page; flags off → classic', () => {
  assert.deepEqual(flag.CRM_DEFAULT_VIEWS, ['full', 'ops', 'controller']);
  assert.equal(flag.serveCrmShell(ON, {}, ORTAL, 'controller'), true);
  assert.equal(flag.serveCrmShell(ON, { view: 'classic' }, ORTAL, 'controller'), false);
  assert.equal(flag.serveCrmShell({ CRM_ENABLED: 'true' }, {}, ORTAL, 'controller'), false, 'CRM_DEFAULT off → classic');
  assert.equal(flag.serveCrmShell({ CRM_DEFAULT: 'true' }, {}, ORTAL, 'controller'), false, 'CRM_ENABLED off → classic');
  assert.equal(flag.serveCrmShell(ON, {}, { auth: 'shared' }, 'controller'), false, 'never a shared session');
  assert.equal(flag.serveCrmShell(ON, {}, null, 'controller'), false, 'never without a session');
  for (const v of ['restricted', 'none', '', undefined]) assert.equal(flag.serveCrmShell(ON, {}, ORTAL, v), false, 'view ' + v);
});

test('landingArea: the controller view opens on «גבייה»; everyone else keeps their area; a controller without the area stays put', () => {
  assert.equal(core.landingArea({ view: 'controller' }, 'today'), 'billing');
  assert.equal(core.landingArea({ view: 'full', finance: true }, 'today'), 'today');
  assert.equal(core.landingArea({ view: 'ops', ops: true }, 'today'), 'today');
  assert.equal(core.landingArea({ view: 'full', finance: true }, 'leads'), 'leads');
  assert.equal(core.landingArea(null, ''), 'today');
  assert.deepEqual(core.areasFor({ view: 'controller' }), ['today', 'billing', 'control'], 'her areas are unchanged');
});

test('the landing is applied once (first load only), and Ortal gets a top link to her classic «בקרת גבייה»', () => {
  assert.ok(SRC.includes("if (!state.landed) { state.landed = true; state.area = landingArea(me, state.area); }"));
  assert.ok(SRC.includes('id="crm-controller-classic"') && SRC.includes('<a href="/?view=classic">בקרת גבייה<small>אימות דיווחים — בדשבורד הרגיל</small></a>'));
});

test('no new power: the controller allow-list holds no finance write, and every action the «גבייה» area reads is on it', () => {
  for (const a of ['saveAll', 'savePayment', 'reportPayment', 'setBillingDiscount', 'saveCredit', 'deletePayment', 'updatePayment', 'appendFunder'])
    assert.ok(!scope.CONTROLLER_ACTIONS.includes(a), a + ' stays refused');
  for (const a of ['getData', 'getPayments', 'getCredits', 'debtAging']) assert.ok(scope.CONTROLLER_ACTIONS.includes(a), a);
});
