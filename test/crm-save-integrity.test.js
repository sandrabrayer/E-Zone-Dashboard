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

test('SAVE-02: funder source state is unique by patient/day/value; an exposed conflicting submission ID is refused', () => {
  const key = 'sub-0123456789abcdef0123456789abcdef';
  const base = { patientId: 'P1', submissionId: key, funder: 'פרטי', effectiveFrom: '2026-11-02' };
  const proof = (row) => crm.funderSourceConfirmed({ ok: true, funders: [Object.assign({}, base, row)] }, 'P1', key, 'פרטי', '2026-11-02');
  assert.equal(proof({}), true);
  assert.equal(proof({ effectiveFrom: '2026-11-01T22:00:00.000Z' }), true, 'source date stored as UTC timestamp maps to Israel 02/11');
  assert.equal(proof({ submissionId: undefined }), true, 'the production projection omits the key');
  assert.equal(proof({ submissionId: 'sub-another' }), false);
  assert.equal(proof({ patientId: 'P2' }), false);
  assert.equal(proof({ funder: 'משרד הבריאות' }), false);
  assert.equal(proof({ effectiveFrom: '2026-11-01' }), false);
  assert.equal(crm.funderSourceConfirmed({ ok: true, funders: [base, base] }, 'P1', key, 'פרטי', '2026-11-02'), false, 'duplicate key is ambiguous');
  assert.equal(crm.funderSourceConfirmed({ ok: false, funders: [base] }, 'P1', key, 'פרטי', '2026-11-02'), false);
  assert.equal(crm.funderSourceConfirmed({ ok: true }, 'P1', key, 'פרטי', '2026-11-02'), false);
  assert.equal(crm.funderSourceConfirmed(null, 'P1', key, 'פרטי', '2026-11-02'), false);
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  const f = src.slice(src.indexOf('function saveFunderBestEffort('), src.indexOf('function admitLead('));
  assert.match(f, /return funderSourceConfirmed\(data, pid, submissionId, funder, effectiveFrom\)/);
  assert.match(f, /return posted\.then/);
  assert.equal((f.match(/action: 'appendFunder'/g) || []).length, 1, 'source reconciliation never sends a second finance write');
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
  assert.match(fn, /if \(needsOutpatient\) toast\('השחרור נשמר — מאמת/, 'outbound handoff is explicitly still pending');
  assert.match(fn, /const accepted = d && d.ok === true && \(d.sent \|\| d.alreadySent\);\s*state.saving = false;/, 'do not release the action lock until handoff response');
  assert.doesNotMatch(fn, /catch\(function \(\) \{ toast\('יצירת ליד טיפול חוץ נכשלה[^;]*; return true;/);
});

test('P0: lost funder reply uses exact source state, never a namesake, another date or conflicting rows', () => {
  const expected = { patientId: 'p-synthetic', funder: 'פרטי', effectiveFrom: TODAY };
  const confirm = (data, expected) => crm.funderSourceConfirmed(data, expected.patientId, 'sub-0123456789abcdef0123456789abcdef', expected.funder, expected.effectiveFrom);
  const read = (rows) => ({ ok: true, funders: rows });
  assert.equal(confirm(read([expected]), expected), true);
  for (const patch of [{ patientId: 'p-other' }, { effectiveFrom: '2026-11-01' }, { funder: 'מכבי' }]) {
    assert.equal(confirm(read([{ ...expected, ...patch }]), expected), false);
  }
  assert.equal(confirm(read([expected, { ...expected, funder: 'מכבי' }]), expected), false);
  assert.equal(confirm({ ok: false, funders: [expected] }, expected), false);
  assert.equal(confirm(read([]), expected), false);
  assert.equal(confirm(read([{ ...expected, effectiveFrom: '' }]), { ...expected, effectiveFrom: '' }), false);
  // This is the ACTUAL Apps Script projection, which strips the submission key.
  const gs = require('./helpers/gs-sandbox').loadGs();
  gs.sandbox.__funderInput = [{ ...expected, submissionId: 'sub-0123456789abcdef0123456789abcdef' }];
  const projected = JSON.parse(JSON.stringify(gs.run('fundersForClient_(__funderInput)')));
  assert.equal(projected[0].submissionId, undefined);
  assert.equal(confirm(read(projected), expected), true);
});

test('P0: funder clarification survives reload from source and clears only with admission-day coverage', () => {
  const c = { leads: [], discharges: [], patients: [{ id: 'p-synthetic', name: 'בדיקה בלבד', fromLead: 'L-synthetic', date: TODAY, status: 'active', houseId: 'ramot' }] };
  const payments = { ok: true, payments: [], receipts: [], funders: [] };
  assert.equal(crm.funderExceptions(c, payments, TODAY).length, 1);
  assert.equal(crm.funderExceptions(JSON.parse(JSON.stringify(c)), payments, TODAY)[0].open, 'account');
  payments.funders = [{ patientId: 'p-synthetic', effectiveFrom: '2026-11-03', funder: 'פרטי' }];
  assert.equal(crm.funderExceptions(c, payments, TODAY).length, 1, 'future funder does not cover the admission');
  payments.funders[0].effectiveFrom = TODAY;
  assert.equal(crm.funderExceptions(c, payments, TODAY).length, 0);
  assert.equal(crm.funderExceptions(c, { ok: false }, TODAY).length, 0, 'unavailable source is not proof of missing funder');
});
