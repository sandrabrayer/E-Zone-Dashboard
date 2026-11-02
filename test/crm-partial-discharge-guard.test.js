'use strict';
// CRM-E2E PW-04/05/06: safe read-only detection of a committed discharge
// audit whose Patients row was not saved. Synthetic data, no live writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../public/crm/crm.js');

const TODAY = '2026-11-02';
const p = (status, id = 'P1') => ({
  id, houseId: 'ramot', name: 'בדיקת שחרור', date: '2026-08-01',
  status, exitDate: status === 'released' ? '2026-11-01' : ''
});
const d = (o = {}) => Object.assign({
  id: 'D1', patientId: 'P1', houseId: 'ramot', name: 'בדיקת שחרור',
  date: '2026-08-01', exitDate: '2026-11-01',
  continuity: 'none', disposition: 'completed', restored: ''
}, o);
const rows = (audits, patients) => core.houseExceptions({
  leads: [], discharges: audits, patients, outpatientSent: {}
}, TODAY);
const mismatches = (audits, patients) =>
  rows(audits, patients).filter(x => x.kind === 'discharge_integrity');

test('PW-04: exact audited discharge plus active Patients state remains a source-derived exception', () => {
  const r = mismatches([d()], [p('active')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'ex:discharge-state:D1');
  assert.equal(r[0].dischargeId, 'D1');
  assert.equal(r[0].subjectId, 'P1');
  assert.equal(r[0].subjectKind, 'patient');
  assert.equal(r[0].owner, 'ורד');
  assert.equal(r[0].priority, 'exception');
  assert.match(r[0].why, /אין לבצע שחרור נוסף/);
});

test('PW-06: exception closes only after Patients row is released, even if continuity is already none', () => {
  assert.equal(mismatches([d()], [p('active')]).length, 1);
  assert.equal(mismatches([d()], [p('trial')]).length, 1);
  assert.equal(mismatches([d()], [p('released')]).length, 0);
});

test('PW-05: no fuzzy person merge if source patientId is missing, wrong or ambiguous', () => {
  assert.equal(mismatches([d({patientId: ''})], [p('active')]).length, 0);
  assert.equal(mismatches([d({patientId: 'P2'})], [p('active')]).length, 0);
  assert.equal(mismatches([d()], [p('active'), p('active')]).length, 0);
  assert.equal(mismatches([d()], []).length, 0);
});

test('PW-07: restored/removed audit never creates a stale discrepancy, and unknown continuity is independently pending', () => {
  assert.equal(mismatches([d({restored: 'TRUE'})], [p('active')]).length, 0);
  assert.equal(mismatches([d({deletedAt: '2026-11-02T06:00:00Z'})], [p('active')]).length, 0);
  const r = rows([d({continuity: 'unknown'})], [p('active')]);
  assert.deepEqual(r.map(x => x.kind).sort(), ['discharge_integrity']);
  assert.equal(new Set(r.map(x => x.id)).size, r.length);
});

test('PW-04/05: integrated source guards block duplicate audit and never promote an unverified duplicate response', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  const begin = src.indexOf('function dischargePatient(pid, v, f)');
  const end = src.indexOf('function renderDischarged(c)', begin);
  const f = src.slice(begin, end);
  assert.match(f, /pendingDischargeAudit\(state\.data && state\.data\.dischargedPatients, pid\)/);
  assert.match(f, /let auditConfirmed = false/);
  assert.match(f, /auditConfirmed = true/);
  assert.match(f, /if \(res\.duplicate === true\) throw new Error/);
  assert.match(f, /state\.error = message \+ ' ' \+ String/);
  assert.match(f, /אין לבצע ניסיון נוסף עד לרענון/);
  assert.doesNotMatch(f, /if \(res\.duplicate === true\) \{[^}]*released\.exitDate/,
    'the legacy duplicate response cannot automatically mark a different patient released');
  const ex = src.slice(src.indexOf('function houseExceptions(c, today)'), src.indexOf('function passes(r, f)'));
  assert.equal((ex.match(/id: 'ex:discharge-state:'/g) || []).length, 1,
    'one source-derived mismatch row per exact audit, not two task engines');
  assert.doesNotMatch(ex, /ex:discharge-sync:/);
});
