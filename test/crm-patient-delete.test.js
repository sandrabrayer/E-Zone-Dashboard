'use strict';
/* CHANGELOG-crm-patient-delete.md — permanent patient delete inside the CRM, via the
 * dedicated `deletePatientRow` backend action (tombstone-then-remove). Finance +
 * deleter only. Source wiring here; the real page is a scenario in
 * test/crm-shell-browser.test.js. SYNTHETIC data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.css'), 'utf8');

test('delete is finance + deleter only, never the verifier', () => {
  const fn = SRC.slice(SRC.indexOf('function canDeletePatient'), SRC.indexOf('function patientDeleteBlock'));
  assert.match(fn, /state\.me\.deleter === true && state\.me\.view !== 'controller'/);
  // the block is empty without permission
  const blk = SRC.slice(SRC.indexOf('function patientDeleteBlock'), SRC.indexOf('function deletePatient(pid)'));
  assert.match(blk, /if \(!p \|\| !canDeletePatient\(\)\) return '';/);
  assert.match(blk, /data-del-patient="' \+ esc\(p\.id\)/);
  assert.match(blk, /מחיקה לצמיתות/);
});

test('the delete uses the dedicated deletePatientRow action, confirmed, optimistic with rollback', () => {
  const fn = SRC.slice(SRC.indexOf('function deletePatient(pid)'), SRC.indexOf('function renderPatientActions'));
  assert.match(fn, /win\.confirm\('למחוק לצמיתות את «' \+ s\(before\.name\)/);
  assert.match(fn, /action: 'deletePatientRow', patient: \{ id: s\(before\.id\), houseId: s\(before\.houseId\) \|\| loc\.hid, name: s\(before\.name\), date: s\(before\.date\) \}/);
  // R3 proven id (the classic requireSavedId contract)
  assert.match(fn, /const provenId = res\.id \|\| \(Number\(res\.deleted\) > 0 \? res\.key : ''\);/);
  assert.match(fn, /if \(!provenId\) return 'מחיקה לא אומתה/);
  // optimistic removal + rollback through postAction
  assert.match(fn, /function \(\) \{ loc\.arr\.splice\(loc\.idx, 1\); \},/);
  assert.match(fn, /function \(\) \{ loc\.arr\.splice\(loc\.idx, 0, before\); \},/);
  assert.ok(!/saveAll/.test(fn), 'not a saveAll omission — the dedicated action');
});

test('the block renders on both the in-house and the released patient card, and is wired', () => {
  assert.match(SRC, /patientDeleteBlock\(p\) \+ '<\/div>';/, 'in-house card');
  assert.match(SRC, /linkedLeadEdit\(p\) \+ patientDeleteBlock\(p\);/, 'released card');
  assert.match(SRC, /closest\('\[data-del-patient\]'\)/);
  assert.match(SRC, /deletePatient\(s\(t\.dataset\.delPatient\)\);/);
  assert.match(CSS, /details\.act\.danger > summary \{ color: var\(--bad\);/);
});
