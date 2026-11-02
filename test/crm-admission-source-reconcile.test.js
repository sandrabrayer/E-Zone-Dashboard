'use strict';
/* CRM-SAVE-02 — read-after-write admission reconciliation, synthetic only.
 * A successful source write can lose its HTTP response. Never retry an
 * admission with a fresh ID unless source identity was independently checked.
 * No real patients, Sheets, upstream URLs or network traffic are involved. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../public/crm/crm.js');

const target = { patientId: 'patient-012', leadId: 'lead-012', houseId: 'ramot', date: '2026-11-02' };
const patient = (change) => Object.assign({
  id: 'patient-012', fromLead: 'lead-012', houseId: 'ramot', date: '2026-11-02',
  name: 'מטופל בדיוני בלבד', status: 'active'
}, change || {});
const lead = (change) => Object.assign({
  id: 'lead-012', name: 'מטופל בדיוני בלבד', stage: 'admitted', phone: '0500000000'
}, change || {});
const sheet = (change) => Object.assign({
  ok: true, patients: { ramot: [patient()] }, leads: [lead()]
}, change || {});
const proof = core.admissionSourceProof;

test('SAVE-02: a freshly read exact patient + admitted linked lead proves the original first write, not a second admission', () => {
  assert.equal(proof(sheet(), target), 'confirmed');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ date: '2026-11-01T22:00:00.000Z' })] } }), target), 'confirmed', 'UTC timestamp for Israel 02/11 must not create a false mismatch');
  assert.equal(proof(sheet({ patients: [patient()] }), target), 'confirmed', 'flat Patients feed also supported');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ houseId: '' })] } }), target), 'confirmed',
    'house key is the source when the row omits houseId');
});

test('SAVE-02: wrong or multiple source identities cannot be repaired by matching names or phone', () => {
  const lookalike = Object.assign({}, lead(), { id: 'lead-other' });
  assert.equal(proof(sheet({ leads: [lookalike] }), target), 'patient_only',
    'a same-name unrelated lead is not the original source lead');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ id: 'other-patient' })] } }), target), 'missing',
    'a same-name patient with a different ID proves nothing');
  assert.equal(proof(sheet({ patients: { ramot: [patient(), patient()] } }), target), 'ambiguous',
    'duplicated exact patient ID must not be treated as a unique confirmed record');
});

test('SAVE-02: partial client/lead commit remains unresolved even when the patient exists', () => {
  assert.equal(proof(sheet({ leads: [] }), target), 'patient_only');
  assert.equal(proof(sheet({ leads: [lead({ stage: 'paid' })] }), target), 'patient_only');
  assert.equal(proof(sheet({ leads: [lead(), lead()] }), target), 'patient_only');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ fromLead: 'lead-other' })] } }), target), 'mismatch');
});

test('SAVE-02: the stored house, entry date and status are mandatory parts of the exact stay proof', () => {
  assert.equal(proof(sheet({ patients: { rehab: [patient({ houseId: 'rehab' })] } }), target), 'mismatch');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ date: '2026-11-01' })] } }), target), 'mismatch');
  assert.equal(proof(sheet({ patients: { ramot: [patient({ status: 'released' })] } }), target), 'mismatch');
});

test('SAVE-02: unreadable or refused source remains unavailable, never claimed absent or saved', () => {
  for (const x of [null, undefined, {ok:false}, {}, {ok:true,patients:null,leads:[lead()]}]) {
    assert.equal(proof(x, target), 'unavailable');
  }
  assert.equal(proof(sheet(), Object.assign({}, target, { patientId:'' })), 'unavailable');
  assert.equal(proof(sheet(), Object.assign({}, target, { leadId:'' })), 'unavailable');
});

test('SAVE-02: no new admission is posted on first-stage ambiguity; exact source read gates funder continuation', () => {
  const source = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  const start = source.indexOf('function postAction(body, okCheck, apply, undo, label, deferSuccess)');
  const end = source.indexOf('function genericRefusal(res, idKey)', start);
  const flow = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(flow, /const identity = deferSuccess && typeof deferSuccess === 'object'/);
  assert.match(flow, /if \(!identity\) \{\s*undo\(\)/);
  assert.match(flow, /return api\('getData'\)/);
  assert.match(flow, /admissionSourceProof\(fresh, identity\)/);
  assert.match(flow, /proof !== 'confirmed'/);
  assert.match(flow, /state\.error = warning/);
  assert.doesNotMatch(flow, /api\('saveAll'\)/, 'never resubmit the original write inside recovery');
  assert.match(source, /patientId: patient\.id, leadId: leadNext\.id, houseId: patient\.houseId, date: patient\.date/);
  assert.match(source, /patientId: pair\.patient\.id, leadId: pair\.lead\.id, houseId: pair\.patient\.houseId, date: pair\.patient\.date/);
});
