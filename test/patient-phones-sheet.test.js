'use strict';

/* PatientPhones — CHANGELOG-patient-phones-sheet.md.
 * A manual phone book for house patients with no phone via their lead; the admitted
 * feed lists who still lacks one (idempotent, fail-soft); typed phones feed both rosters. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'admitted-secret-TEST-0123456789abcd';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ patients = [], leads = [], phones = null } = {}) {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'proxy-secret-TEST-patient-phones-0000000', ADMITTED_ROSTER_SECRET: SECRET, ALUMNI_SOURCE_SECRET: SECRET } });
  g.sandbox.Utilities.formatDate = (d) => { const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
  const pc = Array.from(g.run('PATIENT_COLUMNS')), lc = Array.from(g.run('LEAD_COLUMNS')), hc = Array.from(g.run('PATIENT_PHONES_COLUMNS'));
  const ps = richSheet('Patients', pc), ls = richSheet('Leads', lc);
  patients.forEach((r) => ps.grid.push(pc.map((c) => r[c] ?? '')));
  leads.forEach((r) => ls.grid.push(lc.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = ps; g.sandbox.__sheets.Leads = ls;
  if (phones) { const hs = richSheet('PatientPhones', hc); phones.forEach((r) => hs.grid.push(hc.map((c) => r[c] ?? ''))); g.sandbox.__sheets.PatientPhones = hs; }
  const admitted = () => arr(g.post({ action: 'getAdmittedRoster', secret: SECRET }));
  const discharged = () => arr(g.post({ action: 'getDischargedRoster', secret: SECRET }));
  const book = () => { const s = g.sandbox.__sheets.PatientPhones; return s ? s.grid.slice(1).map((r) => Object.fromEntries(hc.map((c, i) => [c, r[i]]))) : []; };
  return { g, admitted, discharged, book };
}
const P = (name, over = {}) => Object.assign({ houseId: 'asher', name, fromLead: '', date: '2026-05-01', exitDate: '', status: 'active', id: 'pid-' + name }, over);

test('admitted feed appends a blank (name, house) row for each patient still lacking a phone — idempotent', () => {
  const { admitted, book } = boot({ patients: [P('אלף'), P('בית'), P('גמל', { fromLead: 'L1' })], leads: [{ id: 'L1', name: 'x', phone: '0501234567' }] });
  admitted();
  assert.deepStrictEqual(book().map((r) => [r.name, r.house, r.phone]), [['אלף', 'asher', ''], ['בית', 'asher', '']]);
  admitted();
  assert.strictEqual(book().length, 2, 'second call adds nothing');
});

test('a typed phone (by name, leading zero lost) feeds the admitted feed and removes the to-do', () => {
  const { admitted, book } = boot({ patients: [P('אלף')], phones: [{ name: 'אלף', house: 'asher', phone: '541112222' }] });
  assert.strictEqual(admitted().patients[0].phone, '0541112222');
  assert.strictEqual(book().length, 1, 'no extra row for a patient that now has a phone');
});

test('typed phone matched by patientId beats a name; the lead link phone still wins over the book', () => {
  const { admitted } = boot({
    patients: [P('דלת', { id: 'pid-7' }), P('הא', { fromLead: 'L1' })],
    leads: [{ id: 'L1', name: 'הא', phone: '0509999999' }],
    phones: [{ name: 'כלשהו', phone: '0521111111', patientId: 'pid-7' }, { name: 'הא', phone: '0522222222' }],
  });
  const r = admitted().patients;
  assert.strictEqual(r.find((p) => p.name === 'דלת').phone, '0521111111');
  assert.strictEqual(r.find((p) => p.name === 'הא').phone, '0509999999');
});

test('discharged feed also reads the book; ambiguous book names stay blank', () => {
  const { discharged } = boot({
    patients: [P('ואו', { exitDate: '2026-10-01', status: 'released' }), P('זין', { exitDate: '2026-10-02', status: 'released' })],
    phones: [{ name: 'ואו', phone: '0531111111' }, { name: 'זין', phone: '0532222222' }, { name: 'זין', phone: '0533333333' }],
  });
  const r = discharged().patients;
  assert.strictEqual(r.find((p) => p.name === 'ואו').phone, '0531111111');
  assert.strictEqual(r.find((p) => p.name === 'זין').phone, '');
});

test('fail-soft + gated: feeds keep working when the book cannot be written; wrong secret writes nothing', () => {
  const b = boot({ patients: [P('אלף')] });
  b.g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, waitLock: () => {}, releaseLock: () => {} }) };
  assert.strictEqual(b.admitted().ok, true);
  assert.strictEqual(b.book().length, 0, 'busy lock → skipped, feed unaffected');
  const c = boot({ patients: [P('אלף')] });
  assert.deepStrictEqual(arr(c.g.post({ action: 'getAdmittedRoster', secret: 'wrong' })), { ok: false, error: 'unauthorized' });
  assert.strictEqual(c.book().length, 0);
});

test('real saveAll: an EXISTING patient edited to link a new lead keeps its row and the rosters return the phone', () => {
  const { g, admitted } = boot({ patients: [P('אלף')] });
  const pc = Array.from(g.run('PATIENT_COLUMNS'));
  const edited = Object.assign(Object.fromEntries(pc.map((c) => [c, P('אלף')[c] ?? ''])), { fromLead: 'id-newlead' });
  const lead = { id: 'id-newlead', name: 'אלף', phone: '0541234567', house: 'אשר', source: 'direct_admin', stage: 'admitted', created: '2026-10-18' };
  const r = arr(g.post({ action: 'saveAll', proxySecret: 'proxy-secret-TEST-patient-phones-0000000', leads: JSON.stringify([lead]), patients: JSON.stringify({ asher: [edited] }) }));
  assert.strictEqual(r.ok, true);
  const rows = g.sandbox.__sheets.Patients.grid.slice(1);
  assert.strictEqual(rows.length, 1, 'same patient row — no duplicate');
  assert.strictEqual(admitted().patients[0].phone, '0541234567');
});
