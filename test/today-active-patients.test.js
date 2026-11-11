'use strict';

/* «מטופלים פעילים» on «היום שלי» (CHANGELOG-today-active-patients.md). Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const DATA = { ok: true, leads: [], patients: {
  ramot: [{ id: 'p1', name: 'דנה', date: '2026-10-01', status: 'active' }, { id: 'p2', name: 'גל', date: '2026-10-05', status: 'trial' }, { id: 'p3', name: 'יצא', date: '2026-08-01', status: 'released', exitDate: '2026-10-01' }],
  rehab: [{ id: 'p4', name: 'אבי', date: '2026-11-01', status: 'active' }] } };
const patients = (d) => core.normalise(d).patients;

test('the count = everyone in a house now (released never), and it equals the «תפוסה» count', () => {
  const a = core.activePatientsCard(patients(DATA), '');
  assert.equal(a.value, 3);
  assert.equal(a.value, core.occupancy(patients(DATA)).totalIn, 'same number as «תפוסה»');
  assert.match(a.hint, /^מתוך \d+ מיטות$/);
  assert.equal(a.capacity, core.occupancy(patients(DATA)).totalCap);
});

test('the house filter of the day narrows it (by id or Hebrew name); a house with nobody → 0', () => {
  assert.equal(core.activePatientsCard(patients(DATA), 'ramot').value, 2);
  assert.equal(core.activePatientsCard(patients(DATA), 'רמות השבים').value, 2);
  assert.match(core.activePatientsCard(patients(DATA), 'ramot').hint, /רמות השבים$/);
  assert.equal(core.activePatientsCard(patients(DATA), 'rehab').value, 1);
  assert.equal(core.activePatientsCard(patients(DATA), 'pardes').value, 0);
});

test('a patient whose house is not recognised is still counted, and the card says so; no data → 0', () => {
  const d = { ok: true, leads: [], patients: { ramot: DATA.patients.ramot, nowhere: [{ id: 'p9', name: 'אלמוני', date: '2026-10-01', status: 'active' }] } };
  const a = core.activePatientsCard(patients(d), '');
  assert.equal(a.value, 3); assert.equal(a.unknown, 1);
  assert.match(a.hint, /1 בבית לא מזוהה/);
  assert.equal(core.activePatientsCard([], '').value, 0);
  assert.equal(core.activePatientsCard(null, '').value, 0);
});

test('wiring: on both day screens (Vered / Dana and Ortal); opens «תפוסה» only for a session that has the area; text escaped; no request', () => {
  assert.equal(SRC.split("}).join('') + activePatientsHtml() + '</div>';").length - 1, 2, 'the general day and the controller day');
  const block = SRC.slice(SRC.indexOf('function activePatientsHtml()'), SRC.indexOf('function rowsBlock('));
  assert.ok(block.includes("areasFor(state.me).indexOf('occupancy') >= 0"));
  assert.ok(block.includes('esc(a.hint)') && !/api\(/.test(block));
  assert.ok(!core.areasFor({ view: 'controller' }).includes('occupancy'), 'Ortal gets a plain card, not a link to an area she lacks');
  assert.ok(core.areasFor({ view: 'ops', ops: true }).includes('occupancy'));
});
