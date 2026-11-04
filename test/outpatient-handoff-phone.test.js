'use strict';

/* «העבר לאמבולטורי» without a lead phone (CHANGELOG-outpatient-handoff-phone.md).
 * The discharge itself is never blocked; the Outpatient lead needs a phone (it is
 * Outpatient's matching key), so the phone is resolved like the rosters, or typed
 * in the «משוחררים» row — kept in PatientPhones — and the send goes through.
 * A. the REAL Code.gs; B. server.js with injected sends; C. the CRM pure helpers.
 * Names / phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const core = require('../public/crm/crm.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
const CRM_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

function world({ leads = [], phones = [], discharged = [] } = {}) {
  const g = loadGs();
  const s = g.sandbox;
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    const sh = richSheet(name, cols);
    rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    s.__sheets[name] = sh;
  };
  put('Leads', 'LEAD_COLUMNS', leads);
  if (phones.length) put(g.run('PATIENT_PHONES_SHEET'), 'PATIENT_PHONES_COLUMNS', phones);
  put(g.run('DISCHARGED_PATIENTS_SHEET'), 'DISCHARGED_PATIENT_COLUMNS', discharged);
  const verified = { verified: true, user: 'ורד', id: 'vered', auth: 'personal', roles: ['editor'], caps: [] };
  return {
    g, s,
    prep: (p) => plain(s.dischargeOutpatientPayload_(Object.assign({ __actor: verified }, p))),
    book: () => g.sheetRows(g.run('PATIENT_PHONES_SHEET'), 'PATIENT_PHONES_COLUMNS'),
    audit: () => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS'),
  };
}
const ROW = (o) => Object.assign({ id: 'aud-r', houseId: 'ramot', name: 'רוני לוי', date: '2026-10-04', status: 'released', exitDate: '2026-11-04',
  fromLead: '', patientId: 'p-roni', source: '', notes: '', disposition: 'released_outpatient', restored: '', deletedAt: '' }, o);

/* ================= A. Code.gs ================= */

test('A: no lead phone → PatientPhones by patientId, then by unique name; ambiguous → \'\' (never a guess)', () => {
  assert.equal(world({ discharged: [ROW()] }).prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '', 'nothing anywhere');
  const byId = world({ discharged: [ROW()], phones: [{ name: 'אחר', house: 'ramot', phone: '0527654321', patientId: 'p-roni' }] });
  assert.equal(byId.prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '0527654321');
  const byName = world({ discharged: [ROW({ patientId: '' })], phones: [{ name: 'רוני  לוי', house: 'ramot', phone: '527654321' }] });
  assert.equal(byName.prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '0527654321', 'lost leading zero restored');
  const twice = world({ discharged: [ROW({ patientId: '' })], phones: [{ name: 'רוני לוי', phone: '0521111111' }, { name: 'רוני לוי', phone: '0522222222' }] });
  assert.equal(twice.prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '');
  // the source lead still wins
  const lead = world({ discharged: [ROW({ fromLead: 'L1' })], leads: [{ id: 'L1', name: 'רוני לוי', phone: '050-1234567', stage: 'admitted' }], phones: [{ name: 'רוני לוי', phone: '0527654321', patientId: 'p-roni' }] });
  assert.equal(lead.prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '0501234567');
});

test('A: a typed phone is validated, kept in PatientPhones (update by patientId, else append) and used — the phone never reaches the audit', () => {
  const w = world({ discharged: [ROW()] });
  assert.deepEqual(w.prep({ dischargeId: 'aud-r', manual: true, phone: '12345' }), { ok: false, error: 'bad_phone' });
  assert.equal(w.s.__sheets[w.g.run('PATIENT_PHONES_SHEET')], undefined, 'a refused phone writes nothing');
  const r = w.prep({ dischargeId: 'aud-r', manual: true, phone: '052-765-4321' });
  assert.equal(r.ok, true); assert.equal(r.payload.phone, '0527654321');
  assert.deepEqual(w.book().map((b) => [b.name, b.house, String(b.phone), b.patientId]), [['רוני לוי', 'ramot', '0527654321', 'p-roni']]);
  w.prep({ dischargeId: 'aud-r', manual: true, phone: '0501112222' });
  assert.equal(w.book().length, 1, 'the same patient is updated, not duplicated');
  assert.equal(String(w.book()[0].phone), '0501112222');
  const a = w.audit().filter((x) => x.action === 'patient_phone_set');
  assert.equal(a.length, 2);
  assert.ok(!JSON.stringify(a).includes('0501112222') && !JSON.stringify(a).includes('0527654321'), 'no phone in the audit');
  // later sends find it without typing
  assert.equal(w.prep({ dischargeId: 'aud-r', manual: true }).payload.phone, '0501112222');
});

test('A: a typed phone never bypasses the gates: unverified, unknown row, already sent', () => {
  const w = world({ discharged: [ROW()] });
  assert.equal(plain(w.s.dischargeOutpatientPayload_({ dischargeId: 'aud-r', manual: true, phone: '0527654321' })).error, 'unauthorized');
  assert.equal(w.prep({ dischargeId: 'nope', manual: true, phone: '0527654321' }).error, 'not_found');
  assert.equal(w.s.__sheets[w.g.run('PATIENT_PHONES_SHEET')], undefined);
});

/* ================= B. server.js ================= */

const server = require('../server');
function srv(prep, sendResult) {
  const posts = []; const sends = [];
  return { posts, sends, deps: {
    sheetsPost: async (b) => { posts.push(b); return b.action === 'dischargeOutpatientPayload' ? (typeof prep === 'function' ? prep(b) : prep) : { ok: true }; },
    send: async (f) => { sends.push(f); return sendResult; },
  } };
}

test('B: dischargeTypedPhone — digits only, 9–10 starting with 0; +972 / lost zero / separators normalised; junk refused', () => {
  const p = server.dischargeTypedPhone;
  assert.equal(p(undefined), ''); assert.equal(p('  '), '');
  assert.equal(p('052-765 4321'), '0527654321'); assert.equal(p('+972 52 765 4321'), '0527654321'); assert.equal(p('527654321'), '0527654321');
  assert.equal(p('09-7654321'), '097654321');
  for (const bad of ['123', 'abc', '0527654321; DROP', '1'.repeat(40), '+1 555 123 4567']) assert.equal(p(bad), null, bad);
});

test('B: the typed phone travels to Code.gs and the send goes out; an invalid one is a 400 with a Hebrew message and nothing is called', async () => {
  const t = srv((b) => ({ ok: true, key: 'discharge:aud-r', payload: { name: 'רוני לוי', phone: b.phone || '', house: 'ramot', note: '' } }), { outcome: 'answered', data: { ok: true, id: 'op-1' } });
  const r = await server.dischargeOutpatientHandoff({ dischargeId: 'aud-r', manual: true, phone: '052-765-4321' }, 'ורד', null, t.deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, sent: true } });
  assert.equal(t.posts[0].phone, '0527654321');
  assert.equal(t.sends[0].phone, '0527654321');
  const bad = srv(null, null);
  const r2 = await server.dischargeOutpatientHandoff({ dischargeId: 'aud-r', manual: true, phone: 'x' }, '', null, bad.deps);
  assert.deepEqual(r2, { status: 400, body: { ok: false, error: 'bad_phone', message: server.DISCHARGE_OUTPATIENT_BAD_PHONE_HE } });
  assert.equal(bad.posts.length + bad.sends.length, 0);
  const gsBad = srv({ ok: false, error: 'bad_phone' }, null);
  assert.equal((await server.dischargeOutpatientHandoff({ dischargeId: 'aud-r', phone: '0527654321' }, '', null, gsBad.deps)).status, 400);
  // no phone typed → the body carries none
  const none = srv({ ok: true, alreadySent: true }, null);
  await server.dischargeOutpatientHandoff({ dischargeId: 'aud-r', manual: true }, '', null, none.deps);
  assert.ok(!('phone' in none.posts[0]));
  assert.match(server.DISCHARGE_OUTPATIENT_NO_PHONE_HE, /להזין טלפון בשורה/);
});

/* ================= C. CRM ================= */

test('C: the CRM asks for the phone in the «משוחררים» row instead of failing; the rule matches the server', () => {
  assert.equal(core.handoffPhone('052-765 4321'), '0527654321'); assert.equal(core.handoffPhone('+972527654321'), '0527654321'); assert.equal(core.handoffPhone('12'), '');
  assert.deepEqual(core.outpatientBody('aud-r'), { dischargeId: 'aud-r', manual: true }, 'no phone key unless typed');
  assert.deepEqual(core.outpatientBody('aud-r', '0527654321'), { dischargeId: 'aud-r', manual: true, phone: '0527654321' });
  for (const raw of ['052-765 4321', '+972 52-765-4321', '527654321', '12', 'abc', '09-7654321']) {
    assert.equal(core.handoffPhone(raw), server.dischargeTypedPhone(raw) || '', raw);
  }
  assert.match(CRM_SRC, /data-form="out-phone"/);
  assert.match(CRM_SRC, /d\.error === 'no_phone' \|\| d\.error === 'bad_phone'/);
  assert.match(CRM_SRC, /esc\(r\.name\) \+ ' \(או של איש הקשר\)/);
});
