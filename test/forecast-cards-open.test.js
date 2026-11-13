'use strict';

/* «צפי תזרים»: a card of a kind narrows the ONE list under the cards; the refunds card
 * opens «זיכויים לתשלום»; a shortcut from «חובות פתוחים» to «ניקוי חובות היסטוריים»
 * (CHANGELOG-forecast-cards-open.md, reshaped by CHANGELOG-billing-sections.md).
 * Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const FC = { from: '2026-11-12', to: '2026-11-30', rows: [
  { patientId: 'p1', name: 'דנה', houseId: 'ramot', houseName: 'רמות השבים', funder: 'פרטי', kind: 'private', amount: 30000, expectedDate: '2026-11-20' },
  { patientId: 'p2', name: 'גל', houseId: 'asher', houseName: 'רעננה אשר', funder: 'ביטוח לאומי', kind: 'institutional', amount: 20000, expectedDate: '2026-11-25' },
  { patientId: 'p3', name: 'נוי', houseId: 'ramot', houseName: 'רמות השבים', funder: 'לא הוגדר', kind: 'unset', amount: 5000, expectedDate: '2026-11-20' }] };

test('a kind card narrows the listed rows to exactly what its number counts; the cards keep the whole slice', () => {
  const all = core.sliceForecast(FC, null, '');
  assert.deepEqual(all.rows.map((r) => r.name), ['דנה', 'גל', 'נוי']);
  assert.deepEqual([all.total, all.count, all.unset.total], [50000, 2, 5000], '«ללא גורם מממן» is listed but outside the total');
  for (const [kind, names, total] of [['private', ['דנה'], 30000], ['institutional', ['גל'], 20000], ['unset', ['נוי'], 5000]]) {
    const v = core.sliceForecast(FC, null, kind);
    assert.deepEqual(v.rows.map((r) => r.name), names, kind);
    assert.equal(v.rowsTotal, total);
    assert.equal(v[kind].total, total, 'the list sum equals the card');
    assert.equal(v.total, 50000, 'the other cards do not move');
  }
});

test('wiring: kind cards are buttons that narrow the one forecast list; a second click widens it back; rows open «חשבון»; all text escaped', () => {
  const fc = SRC.slice(SRC.indexOf('function renderCashForecast()'), SRC.indexOf('function renderDebts('));
  for (const k of ["'private')", "'institutional')", "'unset')"]) assert.ok(fc.includes(k), k);
  assert.ok(fc.includes('data-fc-open="'));
  assert.equal(fc.split('id="crm-fc-rows"').length - 1, 1, 'one list of expected receipts');
  assert.ok(!SRC.includes('crm-fc-open-rows') && !SRC.includes('crm-fc-detail'), 'the second and third copies are gone');
  assert.ok(SRC.includes("if (t.dataset.fcOpen !== undefined) { state.fcOpen = state.fcOpen === t.dataset.fcOpen ? '' : t.dataset.fcOpen; return renderMain(); }"));
  assert.ok(fc.includes('data-open-patient="\' + esc(r.patientId) + \'" data-open-tab="account"'));
  for (const cell of ['esc(r.name)', 'esc(r.houseName)', 'esc(r.funder)', 'esc(fmtMoney(r.amount))']) assert.ok(fc.includes(cell), cell);
  assert.ok(!/api\(/.test(fc), 'no request');
});

test('the refunds card opens the «זיכויים לתשלום» section instead of a second list', () => {
  const fc = SRC.slice(SRC.indexOf('function renderCashForecast()'), SRC.indexOf('function renderDebts('));
  assert.ok(fc.includes("id=\"crm-fc-refunds\" data-bill-go=\"' + esc(JSON.stringify({ tab: 'refunds' }))"));
  assert.ok(!fc.includes('crm-pending-credits'));
});

test('the cleanup shortcut: only for a non-controller session that may discount, only when released debtors are listed; it opens the cleanup section', () => {
  assert.ok(SRC.includes("if (state.me && state.me.canDiscount && state.me.view !== 'controller' && v.count > v.inHouse) html += '<p class=\"na\" id=\"crm-fc-cleanup-hint\">"));
  assert.ok(SRC.includes("if (t.dataset.cleanupJump !== undefined) { state.billTab = 'cleanup'; state.cleanupOpen = true; return billGo(); }"));
  assert.ok(!core.billingTabsFor({ view: 'controller', canDiscount: true }).includes('cleanup'), 'the tool itself stays out of the controller view');
});
