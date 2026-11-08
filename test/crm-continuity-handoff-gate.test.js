'use strict';
// CRM-E2E-01: sent/disposition is not proof of Outpatient treatment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../public/crm/crm.js');

const TODAY = '2026-11-01';
const row = (o) => Object.assign({
  id: 'dx-1', patientId: 'pat-1', name: 'אדם בדיקה',
  houseId: 'ramot', date: '2026-08-20', exitDate: '2026-10-20',
  disposition: 'completed', continuity: '', restored: '',
}, o || {});
const base = (d, sent) => ({
  leads: [], patients: [{id: 'pat-1', name: 'אדם בדיקה', houseId: 'ramot', date: '2026-08-20', status: 'released'}],
  discharges: [d],
  outpatientSent: sent ? { ['discharge:' + d.id]: true } : {},
});
const open = (d, sent) => core.houseExceptions(base(d, sent), TODAY).filter(x => x.kind === 'continuity');

test('P0: a referral that is SENT remains open; sent is not an actual treatment start', () => {
  const items = open(row({ disposition: 'released_outpatient' }), true);
  assert.equal(items.length, 1);
  assert.match(items[0].why, /לא התקבל אישור/);
  assert.equal(items[0].subjectId, 'pat-1');
  assert.equal(items[0].owner, 'ורד');
});

test('P0: release disposition alone (not sent) still requires proof of sending and treatment', () => {
  const items = open(row({ disposition: 'released_outpatient' }), false);
  assert.equal(items.length, 1);
  assert.match(items[0].why, /שליחת הפנייה והתחלת הטיפול לא אומתו/);
});

test('P0: open handoff does NOT expire at day 14 or even after 120 days', () => {
  const item = row({ exitDate: '2026-07-01' });
  assert.equal(open(item, true).length, 1);
  assert.equal(open(item, false).length, 1);
});

test('P0: explicit none/other documented outcome ends unresolved derived exception', () => {
  assert.equal(open(row({ continuity: 'none' }), true).length, 0);
  assert.equal(open(row({ continuity: 'continued_other' }), false).length, 0);
});

test('P0: restored/soft-deleted discharge does not produce ghost work', () => {
  assert.equal(open(row({ restored: 'TRUE' }), true).length, 0);
  assert.equal(open(row({ deletedAt: '2026-10-25T10:00:00Z' }), false).length, 0);
});

test('P0: only one derived follow-up per discharge and visible with same source id', () => {
  const xs = open(row({ id: 'dx-unique', continuity: 'unknown' }), true);
  assert.equal(xs.length, 1);
  assert.equal(xs[0].id, 'ex:cont:dx-unique');
  assert.equal(xs[0].dischargeId, 'dx-unique');
});

test('UI regression: a sent referral is never rendered as verified continued treatment by default', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.doesNotMatch(src, /r\.sentToOutpatient \? continuityLabel\('continued_outpatient'\)/);
  assert.match(src, /התחלת טיפול לא אומתה/);
});
