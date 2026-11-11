'use strict';

/* The «צפי תזרים» cards open the list behind their number, right under the
 * cards; a shortcut from the debtors list to «ניקוי חובות היסטוריים»
 * (CHANGELOG-forecast-cards-open.md). Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const FC = { rows: [
  { patientId: 'p1', name: 'דנה', kind: 'private', amount: 30000 },
  { patientId: 'p2', name: 'גל', kind: 'institutional', amount: 20000 },
  { patientId: 'p3', name: 'נוי', kind: 'unset', amount: 5000 }] };
const RF = { ok: true, rows: [{ name: 'אבי', amount: 4000 }, { name: 'רון', amount: 1500 }] };

test('each card lists exactly what its number counts', () => {
  const all = core.forecastOpenList(FC, RF, 'all');
  assert.deepEqual(all.receipts.map((r) => r.name), ['דנה', 'גל'], '«סה"כ צפוי» leaves «ללא גורם מממן» out, like the number');
  assert.equal(all.receiptsTotal, 50000); assert.deepEqual(all.refunds, []);
  assert.deepEqual(core.forecastOpenList(FC, RF, 'private').receipts.map((r) => r.name), ['דנה']);
  assert.deepEqual(core.forecastOpenList(FC, RF, 'institutional').receipts.map((r) => r.name), ['גל']);
  assert.deepEqual(core.forecastOpenList(FC, RF, 'unset').receipts.map((r) => r.name), ['נוי']);
  const refunds = core.forecastOpenList(FC, RF, 'refunds');
  assert.deepEqual([refunds.receipts.length, refunds.refunds.length, refunds.refundsTotal], [0, 2, 5500]);
  const net = core.forecastOpenList(FC, RF, 'net');
  assert.deepEqual([net.receiptsTotal, net.refundsTotal, net.receiptsTotal - net.refundsTotal], [50000, 5500, 44500], 'net = both lists');
});

test('nothing open / an unknown key → null; refunds not loaded → an empty refund list, never a guess', () => {
  for (const k of ['', undefined, null, 'x', '<script>']) assert.equal(core.forecastOpenList(FC, RF, k), null);
  assert.deepEqual(core.forecastOpenList(FC, { ok: false, rows: [{ name: 'x', amount: 9 }] }, 'refunds').refunds, []);
  assert.deepEqual(core.forecastOpenList(null, null, 'all').receipts, []);
});

test('wiring: every forecast card is a button; the list renders right under the cards; a second click closes; rows open «חשבון»; all text escaped', () => {
  const fc = SRC.slice(SRC.indexOf('function renderCashForecast()'), SRC.indexOf('function renderForecastOpen('));
  for (const k of ["'all'", "'private'", "'institutional'", "'unset'", "'refunds', 'crm-fc-refunds'", "'net', 'crm-fc-net'"]) assert.ok(fc.includes(k + ')'), k);
  assert.ok(fc.includes('data-fc-open="'), 'cards carry data-fc-open');
  assert.ok(fc.indexOf('html += renderForecastOpen(fc, rf, fo);') < fc.indexOf('html += renderCollectionDebtors();'), 'above the debtors list');
  assert.ok(SRC.includes("state.fcOpen = state.fcOpen === t.dataset.fcOpen ? '' : t.dataset.fcOpen;"));
  const block = SRC.slice(SRC.indexOf('function renderForecastOpen('), SRC.indexOf('function renderCollectionDebtors()'));
  assert.ok(block.includes('data-open-patient="\' + esc(r.patientId) + \'" data-open-tab="account"'));
  for (const cell of ['esc(o.title)', 'esc(o.key)', 'esc(r.name)', 'esc(r.houseName)', 'esc(r.funder)', 'esc(fmtMoney(r.amount))']) assert.ok(block.includes(cell), cell);
  assert.ok(!/api\(/.test(block), 'no request');
});

test('the cleanup shortcut: only for a session that may discount, only when released debtors exist; it opens the existing tool', () => {
  assert.ok(SRC.includes("(state.me && state.me.canDiscount && cd.count > cd.inHouse ? '<p class=\"na\" id=\"crm-fc-cleanup-hint\">"));
  assert.ok(SRC.includes("if (t.dataset.cleanupJump !== undefined) {\n        state.cleanupOpen = true; renderMain();"));
  assert.ok(SRC.includes("if (!isController) html += renderCleanup();"), 'the tool itself stays hidden from the controller view');
});
