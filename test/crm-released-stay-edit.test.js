'use strict';
/* CHANGELOG-crm-released-stay-edit.md — a released patient's stay date (entry date) and
 * monthly pay are editable in the CRM to fix overlaps. The patient STAYS released
 * (status is not changed here), so no discharge/credit reconciliation is triggered and
 * nothing is lost — the row, its discharge audit and its credits stay linked by the
 * stable patient id. Pure rules + wiring here; the page is in crm-shell-browser. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const REL = () => ({ id: 'px', name: 'נועה לוי', houseId: 'ramot', date: '2026-07-22', pay: 9000, status: 'released', exitDate: '2026-11-14', notes: 'x', fromLead: 'LX' });

test('editing a released patient\'s entry date / pay keeps status, exit date and every other field (nothing lost)', () => {
  const next = core.patientEditNext(REL(), { name: 'נועה לוי', date: '2026-07-20', pay: '8500', notes: 'x' });
  assert.equal(next.date, '2026-07-20');
  assert.equal(next.pay, 8500);
  assert.equal(next.status, 'released', 'still released — no re-activation here');
  assert.equal(next.exitDate, '2026-11-14', 'the discharge date is untouched');
  assert.equal(next.fromLead, 'LX');
  // a name/notes-only edit does not touch the dates or money
  const n2 = core.patientEditNext(REL(), { name: 'נועה לוי-כהן', notes: 'עודכן' });
  assert.deepEqual([n2.date, n2.pay, n2.status], ['2026-07-22', 9000, 'released']);
});

test('the same validation as the in-house edit (entry date in range, pay ≥ 0); status is never a field here', () => {
  assert.equal(core.patientEditErrors({ name: 'נ', date: '2026-07-20', pay: '8500' }).date, undefined);
  assert.equal(core.patientEditErrors({ name: 'נ', date: 'nope', pay: '1' }).date, 'תאריך כניסה חסר או מחוץ לטווח');
  assert.equal(core.patientEditErrors({ name: 'נ', date: '2026-07-20', pay: '-5' }).pay, 'סכום חודשי לא תקין');
});

test('the released card exposes entry date + pay (and name/notes), but NOT status; re-activation is a separate «החזרה לפעיל» action', () => {
  const blk = SRC.slice(SRC.indexOf('function releasedEditBlock'), SRC.indexOf('function linkedLeadEdit'));
  assert.match(blk, /name="date"/);
  assert.match(blk, /name="pay"/);
  assert.match(blk, /name="name"/);
  assert.match(blk, /name="notes"/);
  assert.ok(!/name="status"/.test(blk), 'the edit form never flips status directly');
  // re-activation: a sibling «החזרה לפעיל» button (NOT nested in the edit form) that opens the
  // SAME restore flow «משוחררים» uses, keyed by the discharge-audit id — never a status field
  assert.match(blk, /data-card-restore="' \+ esc\(d\.id\)/);
  assert.match(blk, /החזרה לפעיל/);
  assert.match(blk, /crm-card-restore/);
  // an auditless legacy release still points to the classic dashboard
  assert.match(blk, /אין רישום שחרור מקושר/);
  // controllers (verification-only) get no re-activate action
  assert.match(blk, /state\.me && state\.me\.view === 'controller'\) return '';/);
  // the comment records why it is safe (reuses the proven restore — nothing lost)
  assert.match(blk, /nothing is lost/);
});

test('«החזרה לפעיל» reuses the «משוחררים» restore flow (no duplicated ledger logic)', () => {
  // the card button and the discharged-list button both reach openRestoreChoice; the card
  // one targets its own container so the restore form is never nested in the edit form
  assert.match(SRC, /function openRestoreChoice\(id, sel\)/);
  assert.match(SRC, /\$\(sel \|\| '#crm-restore'\)/);
  assert.match(SRC, /if \(t\.dataset\.cardRestore\) return openRestoreChoice\(t\.dataset\.cardRestore, '#crm-card-restore'\);/);
  // cancel clears whichever container is open
  assert.match(SRC, /\['#crm-restore', '#crm-card-restore'\]\.forEach/);
  // submitRestore is unchanged in substance: it still flags EVERY open audit of the stay and
  // now closes the drawer on success (harmless on the list, clean from the card)
  assert.match(SRC, /const siblings = openAuditsOf\(r, c\.discharges\);/);
  assert.match(SRC, /toast\(msg\); closeDrawer\(\); return load\(\)/);
});
