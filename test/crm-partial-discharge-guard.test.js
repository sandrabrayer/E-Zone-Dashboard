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
  rows(audits, patients).filter(x => x.kind === 'discharge_sync');

test('PW-04: exact audited discharge plus active Patients state remains a source-derived exception', () => {
  const r = mismatches([d()], [p('active')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'ex:discharge-sync:D1');
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
  assert.deepEqual(r.map(x => x.kind).sort(), ['continuity', 'discharge_sync']);
  assert.equal(new Set(r.map(x => x.id)).size, r.length);
});

test('PW-04/05: source guards freeze ambiguous discharge result instead of calling it fully failed', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.match(src, /const priorAudits = Array\.isArray\(state\.data\.dischargedPatients\)/);
  assert.match(src, /const priorAudit = priorAudits\.some/);
  assert.match(src, /if \(priorAudit && s\(before\.status\) !== 'released'\)/);
  assert.match(src, /let auditConfirmed = false/);
  assert.match(src, /auditConfirmed = true/);
  assert.match(src, /state\.error = message \+ ' ' \+ String/);
  assert.match(src, /אין לבצע ניסיון נוסף עד לרענון/);
  assert.doesNotMatch(src, /catch\(function \(e\) \{\s*loc\.arr\[loc\.idx\] = before; state\.saving = false; renderNav\(\); renderMain\(\)/);
});
