'use strict';
// CRM-SAVE-01: synthetic negative controls for multi-stage admissions/discharges.
// No real customer, financial or clinical records are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crm = require('../public/crm/crm.js');

const TODAY = '2026-11-02';
const discharge = (patch) => Object.assign({
  id: 'dx-synthetic', patientId: 'p-synthetic', name: 'מטופל בדיקה',
  houseId: 'ramot', date: '2026-10-01', exitDate: '2026-11-01',
  disposition: 'completed', continuity: 'none', restored: ''
}, patch || {});
const model = (audit, patient) => ({
  leads: [],
  discharges: [audit],
  patients: [patient || {
    id: 'p-synthetic', name: 'מטופל בדיקה', houseId: 'ramot',
    date: '2026-10-01', status: 'active'
  }],
  outpatientSent: {}
});

test('P0: a funder response must acknowledge the EXACT submission ID, not an arbitrary ok row', () => {
  const key = 'sub-0123456789abcdef0123456789abcdef';
  assert.equal(crm.funderWriteConfirmed({ ok: true, row: { submissionId: key } }, key), true);
  assert.equal(crm.funderWriteConfirmed({ ok: true, row: { submissionId: 'sub-someone-else' } }, key), false);
  assert.equal(crm.funderWriteConfirmed({ ok: true }, key), false);
  assert.equal(crm.funderWriteConfirmed({ ok: false, row: { submissionId: key } }, key), false);
  assert.equal(crm.funderWriteConfirmed(null, key), false);
});

test('P0: a committed discharge audit with an ACTIVE patient remains a SOURCE-DERIVED work exception', () => {
  const items = crm.houseExceptions(model(discharge()), TODAY);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'ex:discharge-state:dx-synthetic');
  assert.equal(items[0].kind, 'discharge_integrity');
  assert.equal(items[0].subjectId, 'p-synthetic');
  assert.equal(items[0].owner, 'ורד');
  assert.match(items[0].why, /שחרור.*סטטוס/);
});

test('P0: once the authoritative patient is RELEASED, no stale integrity exception remains', () => {
  const patient = { id: 'p-synthetic', name: 'מטופל בדיקה', houseId: 'ramot', date: '2026-10-01', status: 'released' };
  assert.equal(crm.houseExceptions(model(discharge(), patient), TODAY).length, 0);
});

test('P0: restored/removed audits and missing stable identity do not manufacture a status mismatch', () => {
  assert.equal(crm.houseExceptions(model(discharge({ restored: 'TRUE' })), TODAY).length, 0);
  assert.equal(crm.houseExceptions(model(discharge({ deletedAt: '2026-11-01T11:00:00Z' })), TODAY).length, 0);
  assert.equal(crm.houseExceptions(model(discharge({ patientId: '' })), TODAY).length, 0);
  assert.equal(crm.houseExceptions(model(discharge(), { id: 'different-patient', status: 'active', name: 'מטופל בדיקה' }), TODAY).length, 0);
});

test('P0: an existing exact-ID discharge audit blocks another fresh discharge action', () => {
  assert.equal(crm.pendingDischargeAudit([discharge()], 'p-synthetic'), true);
  assert.equal(crm.pendingDischargeAudit([discharge()], 'different-patient'), false);
  assert.equal(crm.pendingDischargeAudit([discharge({ patientId: '' })], 'p-synthetic'), false);
  assert.equal(crm.pendingDischargeAudit([discharge({ restored: 'TRUE' })], 'p-synthetic'), false);
  assert.equal(crm.pendingDischargeAudit([discharge({ deletedAt: '2026-11-01T11:00:00Z' })], 'p-synthetic'), false);
});

test('P0: admissions may not report both steps complete unconditionally after the secondary funder request', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.doesNotMatch(src, /saveFunderBestEffort\([^;]*\.then\(function \(\) \{ return true; \}\)/);
  assert.match(src, /function postAction\(body, okCheck, apply, undo, label, deferSuccess\)/);
});

test('P0: handoff failure cannot return a fully successful discharge+Outpatient result', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  const fn = src.slice(src.indexOf('function dischargePatient(pid, v, f)'), src.indexOf('function renderDischarged(c)'));
  assert.ok(fn.includes('השחרור נשמר, אך ההפניה לאמבולטורי לא אומתה'), 'partial failure must be visible');
  assert.doesNotMatch(fn, /catch\(function \(\) \{ toast\('יצירת ליד טיפול חוץ נכשלה[^;]*; return true;/);
});
